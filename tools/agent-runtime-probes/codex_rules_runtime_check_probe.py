#!/usr/bin/env python3
"""Metadata-only runtime check for Codex execpolicy .rules files.

This runs `codex execpolicy check --rules ... -- <command tokens>` for explicit
probe cases and suppresses raw command tokens, matched prefixes, stderr/stdout
content, rule paths, and shell snippets. The checked command is not executed by
Codex; only the local policy matcher is invoked.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from codex_rules_inventory_probe import DEFAULT_RULES_DIR, find_rule_files, pattern_flags, token_family
from probelib import redact, sha256_16


SCHEMA = "agent-runtime-codex-rules-runtime-check"
SCHEMA_VERSION = "0.1"
DEFAULT_CASES = [
    {
        "case_id": "git_commit_prefix_allow",
        "tokens": ["git", "commit"],
        "expected_decision": "allow",
        "expected_match": "match",
    },
    {
        "case_id": "git_status_short_no_match",
        "tokens": ["git", "status", "--short"],
        "expected_decision": None,
        "expected_match": "no_match",
    },
]


def token_summary(tokens: list[str]) -> dict[str, Any]:
    families = [token_family(token, idx) for idx, token in enumerate(tokens)]
    return {
        "token_count": len(tokens),
        "tokens_sha256_16": sha256_16(json.dumps(tokens, sort_keys=True)),
        "first_token_family": families[0] if families else "empty",
        "token_family_counts": dict(sorted(Counter(families).items())),
        "flags": pattern_flags(tokens),
    }


def rule_file_meta(path: Path) -> dict[str, Any]:
    text = ""
    if path.exists():
        try:
            text = path.read_text(errors="replace")
        except OSError:
            text = ""
    return {
        "source_basename": path.name,
        "path_sha256_16": sha256_16(str(path.expanduser())),
        "exists": path.exists(),
        "line_count": len(text.splitlines()) if text else 0,
        "sha256_16": sha256_16(text) if text else None,
    }


def load_cases(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        return [dict(item) for item in DEFAULT_CASES]
    data = json.loads(path.read_text(errors="replace"))
    if not isinstance(data, list):
        raise ValueError("case JSON must be a list")
    cases: list[dict[str, Any]] = []
    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            raise ValueError(f"case {idx} is not an object")
        tokens = item.get("tokens")
        if not isinstance(tokens, list) or not all(isinstance(token, str) for token in tokens):
            raise ValueError(f"case {idx} tokens must be a string list")
        case_id = item.get("case_id")
        if not isinstance(case_id, str) or not case_id:
            case_id = f"case_{idx}"
        expected_match = item.get("expected_match", "any")
        if expected_match not in {"any", "match", "no_match"}:
            raise ValueError(f"case {idx} expected_match invalid")
        expected_decision = item.get("expected_decision")
        if expected_decision is not None and not isinstance(expected_decision, str):
            raise ValueError(f"case {idx} expected_decision must be string or null")
        cases.append({
            "case_id": case_id,
            "tokens": tokens,
            "expected_decision": expected_decision,
            "expected_match": expected_match,
        })
    return cases


def run_check(codex_bin: str, rules: list[Path], tokens: list[str], timeout: int) -> dict[str, Any]:
    argv = [codex_bin, "execpolicy", "check"]
    for path in rules:
        argv.extend(["--rules", str(path)])
    argv.extend(["--pretty", "--", *tokens])
    try:
        proc = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
        return {
            "rc": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except FileNotFoundError:
        return {"rc": 127, "stdout": "", "stderr": "codex executable not found"}
    except subprocess.TimeoutExpired:
        return {"rc": 124, "stdout": "", "stderr": "timeout"}


def reduce_match(match: dict[str, Any]) -> dict[str, Any]:
    prefix = []
    decision = None
    if isinstance(match.get("prefixRuleMatch"), dict):
        raw_prefix = match["prefixRuleMatch"].get("matchedPrefix")
        if isinstance(raw_prefix, list) and all(isinstance(token, str) for token in raw_prefix):
            prefix = raw_prefix
        raw_decision = match["prefixRuleMatch"].get("decision")
        if isinstance(raw_decision, str):
            decision = raw_decision
    return {
        "kind": "prefixRuleMatch" if prefix else "unknown",
        "decision": decision,
        "matched_prefix": token_summary(prefix) if prefix else None,
    }


def reduce_check_result(raw: dict[str, Any], expected_decision: str | None, expected_match: str) -> dict[str, Any]:
    stdout = str(raw.get("stdout") or "")
    stderr = str(raw.get("stderr") or "")
    result: dict[str, Any] = {
        "rc": raw.get("rc"),
        "stdout_bytes": len(stdout.encode("utf-8")),
        "stdout_sha256_16": sha256_16(stdout),
        "stderr_bytes": len(stderr.encode("utf-8")),
        "stderr_sha256_16": sha256_16(stderr),
    }
    try:
        parsed = json.loads(stdout) if stdout.strip() else {}
    except json.JSONDecodeError as exc:
        result.update({
            "parse_status": "json_error",
            "parse_error_class": f"JSONDecodeError:{exc.lineno}:{exc.colno}",
            "matched_rule_count": None,
            "decision": None,
            "case_verdict": "fail",
        })
        return result
    if not isinstance(parsed, dict):
        result.update({
            "parse_status": "unexpected_json_type",
            "matched_rule_count": None,
            "decision": None,
            "case_verdict": "fail",
        })
        return result
    matches = parsed.get("matchedRules")
    if not isinstance(matches, list):
        matches = []
    reduced_matches = [reduce_match(item) for item in matches if isinstance(item, dict)]
    decision = parsed.get("decision") if isinstance(parsed.get("decision"), str) else None
    match_count = len(reduced_matches)
    decision_counts = Counter(item.get("decision") or "<none>" for item in reduced_matches)
    result.update({
        "parse_status": "ok",
        "matched_rule_count": match_count,
        "decision": decision,
        "matched_decision_counts": dict(sorted(decision_counts.items())),
        "matched_rules": reduced_matches,
    })
    expected_ok = True
    if expected_match == "match":
        expected_ok = expected_ok and match_count > 0
    elif expected_match == "no_match":
        expected_ok = expected_ok and match_count == 0
    if expected_decision is not None:
        expected_ok = expected_ok and decision == expected_decision
    elif expected_match == "no_match":
        expected_ok = expected_ok and decision is None
    result["case_verdict"] = "pass" if raw.get("rc") == 0 and expected_ok else "fail"
    return result


def case_report(codex_bin: str, rules: list[Path], case: dict[str, Any], timeout: int, run_checks: bool) -> dict[str, Any]:
    tokens = list(case["tokens"])
    expected_decision = case.get("expected_decision")
    expected_match = str(case.get("expected_match") or "any")
    row: dict[str, Any] = {
        "case_id": case["case_id"],
        "command": token_summary(tokens),
        "expected_decision": expected_decision,
        "expected_match": expected_match,
        "uses_separator_before_command": True,
    }
    if not run_checks:
        row["check_status"] = "not_run"
        return row
    raw = run_check(codex_bin, rules, tokens, timeout)
    row["check_status"] = "ran"
    row["result"] = reduce_check_result(raw, expected_decision, expected_match)
    return row


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    rules_dir = Path(args.rules_dir).expanduser()
    rules = find_rule_files(rules_dir, args.rules_file)
    cases = load_cases(Path(args.case_json).expanduser() if args.case_json else None)
    codex_bin = args.codex_bin
    codex_present = shutil.which(codex_bin) is not None or Path(codex_bin).exists()
    rows = [
        case_report(codex_bin, rules, case, args.timeout, not args.no_run)
        for case in cases
    ]
    verdicts = Counter(row.get("result", {}).get("case_verdict", row.get("check_status")) for row in rows)
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; suppresses raw command tokens, matched prefixes, stdout/stderr content, rule paths, shell snippets, URLs, accounts, env vars, and provider payloads",
        "proof_class": "local_cli_runtime_policy_check" if not args.no_run else "static_case_shape_only",
        "codex": {
            "present": codex_present,
            "bin_label": Path(codex_bin).name,
        },
        "rules": {
            "rules_dir_sha256_16": sha256_16(str(rules_dir)),
            "file_count": len(rules),
            "files": [rule_file_meta(path) for path in rules],
        },
        "cases": rows,
        "aggregate": {
            "case_count": len(rows),
            "case_verdict_counts": dict(sorted(verdicts.items())),
            "matched_case_count": len([
                row for row in rows
                if row.get("result", {}).get("matched_rule_count", 0)
            ]),
            "failed_case_count": verdicts.get("fail", 0),
        },
        "limitations": [
            "uses explicit --rules files and does not prove hidden/default rule merge order",
            "does not execute checked commands",
            "does not prove final approval/sandbox/hook decision for a model-generated shell command",
            "does not call providers, tools, MCP servers, SSH, or external services",
        ],
    }
    return redact(report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rules-dir", default=str(DEFAULT_RULES_DIR))
    parser.add_argument("--rules-file", action="append", default=[])
    parser.add_argument("--case-json")
    parser.add_argument("--codex-bin", default="codex")
    parser.add_argument("--timeout", type=int, default=10)
    parser.add_argument("--no-run", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    report = build_report(args)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
