#!/usr/bin/env python3
"""Metadata-only inventory for Codex .rules command policy files.

The .rules files can contain account names, local paths, URLs, environment-variable
names, and full shell snippets. This probe parses prefix_rule(...) calls but emits only
decisions, counts, hashes, token families, and risk flags. It never prints raw patterns.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import sha256_16


SCHEMA = "agent-runtime-codex-rules-inventory"
SCHEMA_VERSION = "0.1"
HOME = Path.home()
DEFAULT_RULES_DIR = HOME / ".codex/rules"

URL_RE = re.compile(r"https?://", re.I)
ENV_RE = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}")
ACCOUNT_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\b")
SECRET_WORD_RE = re.compile(r"token|secret|key|credential|password|auth", re.I)


def parse_prefix_rule(line: str) -> tuple[list[str] | None, str | None, str | None]:
    try:
        parsed = ast.parse(line, mode="eval")
    except SyntaxError as exc:
        return None, None, f"SyntaxError:{exc.lineno}:{exc.offset}"
    call = parsed.body
    if not isinstance(call, ast.Call):
        return None, None, "not_call"
    if not isinstance(call.func, ast.Name) or call.func.id != "prefix_rule":
        return None, None, "not_prefix_rule"

    pattern: list[str] | None = None
    decision: str | None = None
    for keyword in call.keywords:
        if keyword.arg == "pattern":
            try:
                candidate = ast.literal_eval(keyword.value)
            except (ValueError, SyntaxError):
                return None, None, "pattern_literal_eval_failed"
            if not isinstance(candidate, list) or not all(isinstance(item, str) for item in candidate):
                return None, None, "pattern_not_string_list"
            pattern = candidate
        elif keyword.arg == "decision":
            try:
                candidate = ast.literal_eval(keyword.value)
            except (ValueError, SyntaxError):
                return None, None, "decision_literal_eval_failed"
            if not isinstance(candidate, str):
                return None, None, "decision_not_string"
            decision = candidate
    if pattern is None:
        return None, decision, "missing_pattern"
    if decision is None:
        return pattern, None, "missing_decision"
    return pattern, decision, None


def token_family(token: str, index: int) -> str:
    if token.startswith("/Users/") or token.startswith("~/"):
        return "home_path"
    if token.startswith("/tmp/") or token == "/tmp":
        return "tmp_path"
    if token in {"/dev/null", "</dev/null"}:
        return "device_path"
    if token.startswith("/"):
        return "absolute_path"
    if URL_RE.search(token):
        return "url"
    if ACCOUNT_RE.search(token):
        return "account_like"
    if ENV_RE.search(token):
        return "env_expansion"
    if "\n" in token or ";" in token or "|" in token or "&&" in token or "$(" in token:
        return "shell_snippet"
    if index == 0:
        basename = Path(token).name
        safe_commands = {
            "bash", "cat", "codex", "curl", "find", "gh", "git", "grep", "launchctl",
            "log", "mkdir", "npm", "npx", "ps", "pytest", "python", "python3", "ssh",
            "tsx", "zsh",
        }
        return f"cmd:{basename}" if basename in safe_commands else "cmd:other"
    if token.startswith("-"):
        return "flag"
    if SECRET_WORD_RE.search(token):
        return "sensitive_word"
    return "literal"


def pattern_flags(pattern: list[str]) -> dict[str, bool]:
    joined = "\n".join(pattern)
    first = pattern[0] if pattern else ""
    return {
        "has_absolute_path": any(item.startswith("/") for item in pattern) or "/Users/" in joined or "/tmp/" in joined,
        "has_home_path": any(item.startswith("/Users/") or item.startswith("~/") for item in pattern) or "/Users/" in joined or "~/" in joined,
        "has_tmp_path": any(item.startswith("/tmp/") for item in pattern) or "/tmp/" in joined,
        "has_url": bool(URL_RE.search(joined)),
        "has_env_expansion": bool(ENV_RE.search(joined)),
        "has_account_like": bool(ACCOUNT_RE.search(joined)),
        "has_secret_word": bool(SECRET_WORD_RE.search(joined)),
        "has_shell_snippet": any(token_family(item, idx) == "shell_snippet" for idx, item in enumerate(pattern)),
        "has_ssh": Path(first).name == "ssh" or " ssh " in f" {joined} ",
        "has_git_commit": "git" in pattern[:3] and "commit" in pattern[:5],
        "has_launchctl": Path(first).name == "launchctl" or "launchctl " in joined,
        "has_network_command": Path(first).name in {"curl", "ssh", "gh"} or any(URL_RE.search(item) for item in pattern),
    }


def rule_row(path: Path, line_no: int, line: str, pattern: list[str], decision: str) -> dict[str, Any]:
    families = [token_family(token, idx) for idx, token in enumerate(pattern)]
    flags = pattern_flags(pattern)
    return {
        "source_basename": path.name,
        "line": line_no,
        "line_sha256_16": sha256_16(line),
        "pattern_sha256_16": sha256_16(json.dumps(pattern, sort_keys=True)),
        "decision": decision,
        "pattern_len": len(pattern),
        "first_token_family": families[0] if families else "empty",
        "token_family_counts": dict(sorted(Counter(families).items())),
        "flags": flags,
    }


def file_summary(path: Path) -> dict[str, Any]:
    row: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "source_basename": path.name,
        "rules": [],
        "parse_errors": [],
    }
    if not path.exists():
        return row
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError as exc:
        row["read_error"] = type(exc).__name__
        return row

    for line_no, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        pattern, decision, error = parse_prefix_rule(stripped)
        if error:
            row["parse_errors"].append({
                "line": line_no,
                "line_sha256_16": sha256_16(stripped),
                "error_class": error,
            })
            continue
        assert pattern is not None and decision is not None
        row["rules"].append(rule_row(path, line_no, stripped, pattern, decision))
    row["rule_count"] = len(row["rules"])
    row["parse_error_count"] = len(row["parse_errors"])
    return row


def aggregate(files: list[dict[str, Any]]) -> dict[str, Any]:
    decisions: Counter[str] = Counter()
    first_families: Counter[str] = Counter()
    flags: Counter[str] = Counter()
    token_families: Counter[str] = Counter()
    total_rules = 0
    total_parse_errors = 0
    for file in files:
        total_parse_errors += int(file.get("parse_error_count") or 0)
        for rule in file.get("rules", []):
            total_rules += 1
            decisions[str(rule.get("decision"))] += 1
            first_families[str(rule.get("first_token_family"))] += 1
            for family, count in rule.get("token_family_counts", {}).items():
                token_families[str(family)] += int(count)
            for flag, enabled in rule.get("flags", {}).items():
                if enabled:
                    flags[str(flag)] += 1
    return {
        "file_count": len(files),
        "rule_count": total_rules,
        "parse_error_count": total_parse_errors,
        "decision_counts": dict(sorted(decisions.items())),
        "first_token_family_counts": dict(sorted(first_families.items())),
        "token_family_counts": dict(sorted(token_families.items())),
        "flag_counts": dict(sorted(flags.items())),
    }


def find_rule_files(rules_dir: Path, explicit_files: list[str]) -> list[Path]:
    if explicit_files:
        return [Path(item).expanduser() for item in explicit_files]
    if not rules_dir.exists():
        return []
    return sorted(rules_dir.glob("*.rules"))


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    rules_dir = Path(args.rules_dir).expanduser()
    paths = find_rule_files(rules_dir, args.rules_file)
    files = [file_summary(path) for path in paths]
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits rule counts, decisions, line hashes, token families, and risk flags; never raw .rules patterns",
        "proof_class": "static_local_policy_file_inventory",
        "rules_dir": str(rules_dir),
        "aggregate": aggregate(files),
        "files": files,
        "limitations": [
            "does not execute codex execpolicy check",
            "does not prove runtime rule merge order or current command allowance",
            "does not emit raw command patterns, URLs, account names, env vars, or local paths from rules",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rules-dir", default=str(DEFAULT_RULES_DIR))
    parser.add_argument("--rules-file", action="append", default=[])
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    report = build_report(args)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
