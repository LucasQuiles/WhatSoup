#!/usr/bin/env python3
"""Codex `debug prompt-input` shape probe.

`codex debug prompt-input` renders model-visible context, so raw stdout is sensitive.
Default mode runs under fake HOME/CODEX_HOME and a temporary project. Optional
`--real-local` mode uses the real Codex home/environment and a caller-selected cwd, but
still uses a synthetic prompt and emits only message/content structure, byte sizes,
hashes, and canary booleans. It never prints raw prompt text.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import redact, sha256_16


SCHEMA = "codex-prompt-input-shape"
SCHEMA_VERSION = "0.2"
PROMPT_CANARY = "SYNTHETIC_CODEX_PROMPT_INPUT_USER_CANARY_V1"
PROJECT_DOC_CANARY = "SYNTHETIC_CODEX_PROMPT_INPUT_PROJECT_DOC_CANARY_V1"


def safe_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    if "/" in value or len(value) > 120:
        return f"label_hash:{sha256_16(value)}"
    redacted = redact(value)
    return str(redacted) if isinstance(redacted, str) else None


def text_summary(text: str) -> dict[str, Any]:
    return {
        "text_bytes": len(text.encode("utf-8", errors="replace")),
        "text_sha256_16": sha256_16(text),
        "contains_prompt_canary": PROMPT_CANARY in text,
        "contains_project_doc_canary": PROJECT_DOC_CANARY in text,
    }


def summarize_content(content: Any) -> dict[str, Any]:
    if isinstance(content, str):
        return {"kind": "string", **text_summary(content)}
    if isinstance(content, list):
        parts: list[dict[str, Any]] = []
        for idx, part in enumerate(content):
            row: dict[str, Any] = {"index": idx, "kind": type(part).__name__}
            if isinstance(part, dict):
                row["keys"] = sorted(str(redact(str(key))) for key in part.keys())
                if isinstance(part.get("type"), str):
                    row["part_type"] = safe_label(part["type"])
                if isinstance(part.get("text"), str):
                    row.update(text_summary(part["text"]))
                else:
                    row["text_bytes"] = None
            else:
                row["repr_type"] = type(part).__name__
            parts.append(row)
        return {"kind": "list", "part_count": len(content), "parts": parts}
    return {"kind": type(content).__name__}


def summarize_prompt_input(data: Any) -> dict[str, Any]:
    if not isinstance(data, list):
        return {"json_type": type(data).__name__, "message_count": None, "messages": []}

    messages: list[dict[str, Any]] = []
    roles: Counter[str] = Counter()
    item_types: Counter[str] = Counter()
    total_text_bytes = 0
    prompt_canary_hits = 0
    project_doc_canary_hits = 0

    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            messages.append({"index": idx, "kind": type(item).__name__})
            continue
        role = item.get("role")
        msg_type = item.get("type")
        if isinstance(role, str):
            roles[role] += 1
        if isinstance(msg_type, str):
            item_types[msg_type] += 1
        content_summary = summarize_content(item.get("content"))
        for part in content_summary.get("parts", []):
            total_text_bytes += int(part.get("text_bytes") or 0)
            prompt_canary_hits += 1 if part.get("contains_prompt_canary") else 0
            project_doc_canary_hits += 1 if part.get("contains_project_doc_canary") else 0
        if content_summary.get("kind") == "string":
            total_text_bytes += int(content_summary.get("text_bytes") or 0)
            prompt_canary_hits += 1 if content_summary.get("contains_prompt_canary") else 0
            project_doc_canary_hits += 1 if content_summary.get("contains_project_doc_canary") else 0
        messages.append({
            "index": idx,
            "keys": sorted(str(redact(str(key))) for key in item.keys()),
            "role": safe_label(role),
            "type": safe_label(msg_type),
            "content": content_summary,
        })

    return {
        "json_type": "list",
        "message_count": len(data),
        "roles": {str(redact(key)): value for key, value in sorted(roles.items())},
        "item_types": {str(redact(key)): value for key, value in sorted(item_types.items())},
        "total_text_bytes": total_text_bytes,
        "prompt_canary_hit_count": prompt_canary_hits,
        "project_doc_canary_hit_count": project_doc_canary_hits,
        "messages": messages,
    }


def run_prompt_input_command(
    *,
    cmd: list[str],
    cwd: Path,
    env: dict[str, str],
    timeout: int,
    host_home: Path,
    temp_root: Path | None,
    command_mode: str,
    synthetic_project_doc_written: bool,
) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return {"status": "error", "error_type": "FileNotFoundError", "command": ["codex", "debug", "prompt-input", "<synthetic-prompt>"]}
    except subprocess.TimeoutExpired:
        return {"status": "error", "error_type": "TimeoutExpired", "command": ["codex", "debug", "prompt-input", "<synthetic-prompt>"]}

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    result: dict[str, Any] = {
        "status": "captured",
        "command": ["codex", "debug", "prompt-input", "<synthetic-prompt>"],
        "command_mode": command_mode,
        "cwd_sha256_16": sha256_16(str(cwd)),
        "cwd_is_home_relative": str(cwd).startswith(str(host_home)),
        "rc": proc.returncode,
        "stdout_bytes": len(stdout.encode("utf-8", errors="replace")),
        "stderr_bytes": len(stderr.encode("utf-8", errors="replace")),
        "stdout_sha256_16": sha256_16(stdout),
        "stderr_sha256_16": sha256_16(stderr) if stderr else None,
        "host_home_hit_count": stdout.count(str(host_home)) + stderr.count(str(host_home)),
        "temp_root_hit_count": (
            stdout.count(str(temp_root)) + stderr.count(str(temp_root))
            if temp_root is not None else None
        ),
        "synthetic_project_doc_written": synthetic_project_doc_written,
    }
    if proc.returncode != 0:
        result["parse_status"] = "not_parsed_nonzero_exit"
        return result
    try:
        data = json.loads(stdout)
    except Exception as exc:  # noqa: BLE001 - never echo raw stdout/stderr
        result["parse_status"] = "error"
        result["parse_error_type"] = type(exc).__name__
        return result
    result["parse_status"] = "parsed"
    result["shape"] = summarize_prompt_input(data)
    return result


def run_synthetic_prompt_input(timeout: int, include_project_doc: bool) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="codex-prompt-input-shape-") as tmp:
        root = Path(tmp)
        fake_home = root / "home"
        codex_home = root / "codex-home"
        project = root / "project"
        fake_home.mkdir()
        codex_home.mkdir()
        project.mkdir()
        (codex_home / "config.toml").write_text(
            'model = "gpt-5.5"\nproject_doc_max_bytes = 4096\n',
            encoding="utf-8",
        )
        if include_project_doc:
            (project / "AGENTS.md").write_text(
                f"# Synthetic Project Instructions\n\n{PROJECT_DOC_CANARY}\n",
                encoding="utf-8",
            )

        env = os.environ.copy()
        env["HOME"] = str(fake_home)
        env["CODEX_HOME"] = str(codex_home)
        env["XDG_CONFIG_HOME"] = str(root / "xdg-config")
        env["XDG_DATA_HOME"] = str(root / "xdg-data")
        prompt = f"{PROMPT_CANARY}: inspect shape only"
        cmd = ["codex", "debug", "prompt-input", prompt]
        return run_prompt_input_command(
            cmd=cmd,
            cwd=project,
            env=env,
            timeout=timeout,
            host_home=Path.home(),
            temp_root=root,
            command_mode="synthetic_fake_roots",
            synthetic_project_doc_written=include_project_doc,
        )


def run_real_local_prompt_input(timeout: int, cwd: Path) -> dict[str, Any]:
    prompt = f"{PROMPT_CANARY}: inspect real-local shape only"
    return run_prompt_input_command(
        cmd=["codex", "debug", "prompt-input", prompt],
        cwd=cwd,
        env=os.environ.copy(),
        timeout=timeout,
        host_home=Path.home(),
        temp_root=None,
        command_mode="real_local_env_synthetic_prompt",
        synthetic_project_doc_written=False,
    )


def build_report(
    timeout: int = 20,
    include_project_doc: bool = True,
    mode: str = "synthetic",
    cwd: str | None = None,
) -> dict[str, Any]:
    cwd_path = Path(cwd).expanduser().resolve() if cwd else Path.cwd()
    if mode == "real-local":
        run = run_real_local_prompt_input(timeout=timeout, cwd=cwd_path)
        proof_class = "real_local_provider_free_prompt_shape"
        fixture = {
            "fake_home": False,
            "fake_codex_home": False,
            "fake_xdg_roots": False,
            "real_local_env": True,
            "real_cwd_sha256_16": sha256_16(str(cwd_path)),
            "real_cwd_is_home_relative": str(cwd_path).startswith(str(Path.home())),
            "synthetic_project_doc": False,
            "prompt_canary_sha256_16": sha256_16(PROMPT_CANARY),
            "project_doc_canary_sha256_16": sha256_16(PROJECT_DOC_CANARY),
        }
    else:
        run = run_synthetic_prompt_input(timeout=timeout, include_project_doc=include_project_doc)
        proof_class = "synthetic_provider_free_prompt_shape"
        fixture = {
            "fake_home": True,
            "fake_codex_home": True,
            "fake_xdg_roots": True,
            "real_local_env": False,
            "synthetic_project_doc": include_project_doc,
            "prompt_canary_sha256_16": sha256_16(PROMPT_CANARY),
            "project_doc_canary_sha256_16": sha256_16(PROJECT_DOC_CANARY),
        }
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": proof_class,
        "redaction": "metadata-only; raw prompt-input stdout/stderr is never emitted; text is represented by byte counts, hashes, roles, labels, and synthetic canary booleans",
        "fixture": fixture,
        "run": run,
        "limitations": [
            "This does not call a provider and does not prove selected provider/model.",
            "Synthetic mode does not use the real Codex home or real project instructions.",
            "Real-local mode uses a synthetic prompt and captures only metadata; it still does not prove current API-harness hidden context or provider route.",
            "Prompt assembly can differ by cwd, profiles, CLI overrides, skills, plugins, and harness context.",
            "Raw model-visible context must not be persisted; use bytes, hashes, roles, and canary booleans only.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit synthetic Codex prompt-input shape metadata.")
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--no-project-doc", action="store_true")
    parser.add_argument("--real-local", action="store_true", help="Use real env/CODEX_HOME/cwd with a synthetic prompt; emits metadata only.")
    parser.add_argument("--cwd", default=str(Path.cwd()), help="cwd for --real-local; emitted only as a hash/class")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    report = build_report(
        timeout=args.timeout,
        include_project_doc=not args.no_project_doc,
        mode="real-local" if args.real_local else "synthetic",
        cwd=args.cwd,
    )
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if report["run"].get("status") == "captured" and report["run"].get("rc") == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
