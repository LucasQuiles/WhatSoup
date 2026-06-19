#!/usr/bin/env python3
"""Synthetic secret-access guard coverage canary.

This probe does not read real secrets and does not execute the shell commands it
tests. It feeds synthetic PreToolUse JSON into the local claude-guards Bash/Read
hook scripts, records metadata-only decisions, and compares those decisions with
the visible active Claude settings.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import load_json, redact, sha256_16 as sha16

SCHEMA = "agent-runtime-secret-guard-canary"
SCHEMA_VERSION = "0.3"
HOME = Path.home()
SETTINGS_PATH = HOME / ".claude/settings.json"
LOCAL_SETTINGS_PATH = HOME / ".claude/settings.local.json"
GUARDS_ROOT = HOME / "LAB/claude-guards"
HOOKS_ROOT = GUARDS_ROOT / "hooks"
PLUGIN_MANIFEST = GUARDS_ROOT / ".claude-plugin/plugin.json"
GUARD_HOOKS_JSON = HOOKS_ROOT / "hooks.json"
OBSERVABILITY_ROOT = HOME / ".claude/observability/sessions"


def settings_summary(path: Path) -> dict[str, Any]:
    data = load_json(path) or {}
    perms = data.get("permissions") if isinstance(data, dict) else {}
    if not isinstance(perms, dict):
        perms = {}
    allow = perms.get("allow") if isinstance(perms.get("allow"), list) else []
    deny = perms.get("deny") if isinstance(perms.get("deny"), list) else []
    hooks = data.get("hooks") if isinstance(data, dict) else {}
    direct_pretool_matchers: list[str | None] = []
    if isinstance(hooks, dict):
        pre = hooks.get("PreToolUse")
        if isinstance(pre, list):
            for item in pre:
                if isinstance(item, dict):
                    direct_pretool_matchers.append(item.get("matcher"))
    enabled_plugins = data.get("enabledPlugins") if isinstance(data, dict) else []
    if not isinstance(enabled_plugins, list):
        enabled_plugins = []
    return {
        "path": str(path),
        "exists": path.exists(),
        "allow_count": len(allow),
        "deny_count": len(deny),
        "broad_allow": {
            "Bash": "Bash" in allow,
            "Read": "Read" in allow,
            "Glob": "Glob" in allow,
            "Grep": "Grep" in allow,
        },
        "has_secret_file_deny_glob": any(".env" in str(v) or ".config/secrets" in str(v) for v in deny),
        "direct_pretool_matchers": direct_pretool_matchers,
        "direct_pretool_covers_bash": any(m == "Bash" for m in direct_pretool_matchers),
        "direct_pretool_covers_read": any(m == "Read" for m in direct_pretool_matchers),
        "enabled_plugins_count": len(enabled_plugins),
        "claude_guards_in_enabled_plugins": "claude-guards" in enabled_plugins,
    }


def guard_bundle_summary() -> dict[str, Any]:
    hooks = load_json(GUARD_HOOKS_JSON) or {}
    pre = hooks.get("hooks", {}).get("PreToolUse") if isinstance(hooks, dict) else None
    rows = []
    if isinstance(pre, list):
        for item in pre:
            if not isinstance(item, dict):
                continue
            commands = []
            for hook in item.get("hooks", []):
                if isinstance(hook, dict) and isinstance(hook.get("command"), str):
                    command = hook["command"].replace("${CLAUDE_PLUGIN_ROOT}", str(GUARDS_ROOT))
                    commands.append({
                        "type": hook.get("type"),
                        "timeout": hook.get("timeout"),
                        "command_sha256_16": sha16(command),
                        "command_basename": Path(command.split()[-1].strip('"')).name if command.split() else None,
                    })
            rows.append({"matcher": item.get("matcher"), "hook_count": len(commands), "commands": commands})
    return {
        "plugin_manifest_path": str(PLUGIN_MANIFEST),
        "hooks_json_path": str(GUARD_HOOKS_JSON),
        "exists": GUARD_HOOKS_JSON.exists(),
        "pretool_matchers": rows,
        "present_covers_bash": any(row.get("matcher") == "Bash" for row in rows),
        "present_covers_read": any(row.get("matcher") == "Read" for row in rows),
    }


def guard_command_basenames(bundle: dict[str, Any]) -> dict[str, Any]:
    all_basenames: set[str] = set()
    target_guard_basenames: set[str] = set()
    matcher_map: dict[str, set[str]] = {}
    for row in bundle.get("pretool_matchers", []):
        if not isinstance(row, dict):
            continue
        matcher = str(row.get("matcher") or "")
        for command in row.get("commands", []):
            if not isinstance(command, dict):
                continue
            basename = command.get("command_basename")
            if not isinstance(basename, str) or not basename:
                continue
            all_basenames.add(basename)
            matcher_map.setdefault(matcher, set()).add(basename)
            if basename in {"bash-secret-guard.py", "validate-secret-reads.py"}:
                target_guard_basenames.add(basename)
    return {
        "all_command_basenames": sorted(all_basenames),
        "target_guard_command_basenames": sorted(target_guard_basenames),
        "basenames_by_matcher": {key: sorted(values) for key, values in sorted(matcher_map.items())},
    }


def counter_rows(counter: Counter[str], limit: int | None = None) -> list[dict[str, Any]]:
    rows = [{"basename": key, "count": value} for key, value in counter.most_common(limit)]
    return rows


def safe_hook_basename(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    basename = Path(value).name if "/" in value else value
    redacted = redact(basename)
    return str(redacted) if isinstance(redacted, str) else None


def safe_tool_label(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if "/" in value or len(value) > 80:
        return f"tool_hash:{sha16(value)}"
    redacted = redact(value)
    return str(redacted) if isinstance(redacted, str) else None


def iter_observability_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.glob("*/**/metadata/hook_events.jsonl"))


def observability_guard_correlation(
    root: Path,
    bundle: dict[str, Any],
    max_files: int | None = None,
) -> dict[str, Any]:
    command_meta = guard_command_basenames(bundle)
    target_basenames = set(command_meta["target_guard_command_basenames"])
    all_basenames = set(command_meta["all_command_basenames"])
    files = iter_observability_files(root)
    selected = files[:max_files] if max_files is not None else files
    hook_basename_counts: Counter[str] = Counter()
    origin_counts: Counter[str] = Counter()
    event_counts: Counter[str] = Counter()
    pretool_tool_counts: Counter[str] = Counter()
    guard_basename_match_counts: Counter[str] = Counter()
    target_guard_basename_match_counts: Counter[str] = Counter()
    json_line_count = 0
    invalid_json_lines = 0
    read_error_count = 0
    read_error_types: Counter[str] = Counter()

    for path in selected:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as exc:
            read_error_count += 1
            read_error_types[type(exc).__name__] += 1
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                invalid_json_lines += 1
                continue
            if not isinstance(obj, dict):
                invalid_json_lines += 1
                continue
            json_line_count += 1
            hook_basename = safe_hook_basename(obj.get("hook"))
            if hook_basename:
                hook_basename_counts[hook_basename] += 1
                if hook_basename in all_basenames:
                    guard_basename_match_counts[hook_basename] += 1
                if hook_basename in target_basenames:
                    target_guard_basename_match_counts[hook_basename] += 1
            origin = obj.get("origin_type")
            if isinstance(origin, str):
                origin_counts[origin] += 1
            event = obj.get("event")
            if isinstance(event, str):
                event_counts[event] += 1
            data = obj.get("data") if isinstance(obj.get("data"), dict) else {}
            if origin == "pretool_hook":
                tool = safe_tool_label(data.get("tool_name") or data.get("tool"))
                if tool:
                    pretool_tool_counts[tool] += 1

    target_match_count = sum(target_guard_basename_match_counts.values())
    all_guard_match_count = sum(guard_basename_match_counts.values())
    if not root.exists():
        verdict = "observability-root-missing"
    elif not files:
        verdict = "no-observability-hook-files"
    elif target_match_count:
        verdict = "historical-events-observed-target-guard-identity"
    elif all_guard_match_count:
        verdict = "historical-events-observed-other-guard-bundle-identity"
    else:
        verdict = "historical-events-did-not-observe-guard-command-identities"

    return {
        "root_exists": root.exists(),
        "root_sha256_16": sha16(str(root)),
        "hook_event_file_count": len(files),
        "scanned_file_count": len(selected),
        "max_files": max_files,
        "json_line_count": json_line_count,
        "invalid_json_lines": invalid_json_lines,
        "read_error_count": read_error_count,
        "read_error_types": dict(sorted(read_error_types.items())),
        "degraded": read_error_count > 0,
        "guard_command_basenames": command_meta,
        "observed_hook_basename_rows": counter_rows(hook_basename_counts, 30),
        "origin_type_counts": dict(origin_counts),
        "event_counts": dict(event_counts),
        "pretool_tool_counts": dict(pretool_tool_counts),
        "guard_basename_match_rows": counter_rows(guard_basename_match_counts),
        "target_guard_basename_match_rows": counter_rows(target_guard_basename_match_counts),
        "target_guard_identity_match_count": target_match_count,
        "any_guard_identity_match_count": all_guard_match_count,
        "pretool_bash_event_count": pretool_tool_counts.get("Bash", 0),
        "pretool_read_event_count": pretool_tool_counts.get("Read", 0),
        "current_turn_proof": False,
        "verdict": verdict,
        "limitation": "historical observability events may record wrapper/observability hooks rather than every configured hook; non-observation is not proof that a guard never executed",
    }


def run_hook(script: Path, tool_name: str, tool_input: dict[str, Any], timeout: float) -> dict[str, Any]:
    event = {"tool_name": tool_name, "tool_input": tool_input}
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{HOOKS_ROOT}{os.pathsep}{env.get('PYTHONPATH', '')}"
    try:
        proc = subprocess.run(
            [sys.executable, str(script)],
            input=json.dumps(event),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "decision": "unknown", "stdout_bytes": 0, "stderr_bytes": 0}
    stdout = proc.stdout.strip()
    decision = "allow"
    reason_hash = None
    reason_bytes = 0
    parse_status = "empty_stdout" if not stdout else "unparsed_stdout"
    if stdout:
        try:
            data = json.loads(stdout)
            parse_status = "json"
            hs = data.get("hookSpecificOutput") if isinstance(data, dict) else {}
            if isinstance(hs, dict):
                decision = str(hs.get("permissionDecision") or decision)
                reason = str(hs.get("permissionDecisionReason") or "")
                reason_hash = sha16(reason) if reason else None
                reason_bytes = len(reason.encode("utf-8"))
        except json.JSONDecodeError:
            decision = "unknown"
    return {
        "status": "ok",
        "returncode": proc.returncode,
        "decision": decision,
        "parse_status": parse_status,
        "stdout_bytes": len(proc.stdout.encode("utf-8")),
        "stderr_bytes": len(proc.stderr.encode("utf-8")),
        "reason_sha256_16": reason_hash,
        "reason_bytes": reason_bytes,
        "stdout_sha256_16": sha16(proc.stdout) if proc.stdout else None,
        "stderr_sha256_16": sha16(proc.stderr) if proc.stderr else None,
    }


CANARIES = [
    {
        "id": "read_config_secrets_path",
        "hook": "read",
        "tool": "Read",
        "input": {"file_path": str(HOME / ".config/secrets/synthetic-canary.env")},
        "expected_decision": "deny",
        "surface": "active-secret-file-glob",
    },
    {
        "id": "read_project_env_path",
        "hook": "read",
        "tool": "Read",
        "input": {"file_path": str(HOME / "LAB/synthetic-project/.env")},
        "expected_decision": "allow",
        "surface": "generic-project-env-gap",
        "policy_signal": "project_env_allowed",
    },
    {
        "id": "read_project_env_local_path",
        "hook": "read",
        "tool": "Read",
        "input": {"file_path": str(HOME / "LAB/synthetic-project/.env.local")},
        "expected_decision": "allow",
        "surface": "generic-project-env-gap",
        "policy_signal": "project_env_allowed",
    },
    {
        "id": "read_project_env_production_path",
        "hook": "read",
        "tool": "Read",
        "input": {"file_path": str(HOME / "LAB/synthetic-project/packages/api/.env.production")},
        "expected_decision": "allow",
        "surface": "generic-project-env-gap",
        "policy_signal": "project_env_allowed",
    },
    {
        "id": "read_ssh_private_key_path",
        "hook": "read",
        "tool": "Read",
        "input": {"file_path": str(HOME / ".ssh/id_ed25519")},
        "expected_decision": "deny",
        "surface": "ssh-private-key-glob",
    },
    {
        "id": "bash_cat_config_secrets_tilde_path",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "cat ~/.config/secrets/synthetic-canary.env"},
        "expected_decision": "deny",
        "surface": "active-secret-file-glob-tilde",
    },
    {
        "id": "bash_cat_config_secrets_absolute_path",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": f"cat {HOME}/.config/secrets/synthetic-canary.env"},
        "expected_decision": "deny",
        "surface": "active-secret-file-glob-absolute",
    },
    {
        "id": "bash_cat_ssh_private_key_path",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": f"cat {HOME}/.ssh/id_ed25519"},
        "expected_decision": "deny",
        "surface": "ssh-private-key-glob",
    },
    {
        "id": "bash_cat_project_env_path",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "cat ~/LAB/synthetic-project/.env"},
        "expected_decision": "allow",
        "surface": "generic-project-env-gap",
        "policy_signal": "project_env_allowed",
    },
    {
        "id": "bash_cat_project_env_local_path",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "cat ~/LAB/synthetic-project/.env.local"},
        "expected_decision": "allow",
        "surface": "generic-project-env-gap",
        "policy_signal": "project_env_allowed",
    },
    {
        "id": "bash_source_project_env_path",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "source ~/LAB/synthetic-project/.env"},
        "expected_decision": "allow",
        "surface": "generic-project-env-gap",
        "policy_signal": "project_env_allowed",
    },
    {
        "id": "bash_print_sensitive_env_var",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "printenv PINECONE_API_KEY"},
        "expected_decision": "deny",
        "surface": "sensitive-env-var",
    },
    {
        "id": "bash_bare_env",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "env"},
        "expected_decision": "deny",
        "surface": "all-env-dump",
    },
    {
        "id": "bash_keychain_lookup",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "security find-generic-password -s pinecone -w"},
        "expected_decision": "deny",
        "surface": "keychain-lookup",
    },
    {
        "id": "bash_echo_fake_token",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "echo sk-proj-0000000000000000000000000000000000000000"},
        "expected_decision": "deny",
        "surface": "token-shaped-stdout",
    },
    {
        "id": "bash_wrapper_printenv_child",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "with-pinecone-env printenv"},
        "expected_decision": "deny",
        "surface": "wrapper-child-env-dump",
    },
    {
        "id": "bash_allowed_auth_status",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "gh auth status"},
        "expected_decision": "allow",
        "surface": "explicit-benign-command",
    },
]


def canary_public_row(canary: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    decision = result.get("decision")
    expected = canary["expected_decision"]
    return {
        "id": canary["id"],
        "hook": canary["hook"],
        "tool": canary["tool"],
        "surface": canary["surface"],
        "policy_signal": canary.get("policy_signal", "expected_enforcement"),
        "input_sha256_16": sha16(json.dumps(canary["input"], sort_keys=True)),
        "expected_decision": expected,
        "observed_decision": decision,
        "pass": decision == expected,
        "result": result,
    }


def run_canaries(timeout: float) -> list[dict[str, Any]]:
    scripts = {
        "read": HOOKS_ROOT / "validate-secret-reads.py",
        "bash": HOOKS_ROOT / "bash-secret-guard.py",
    }
    rows = []
    for canary in CANARIES:
        script = scripts[canary["hook"]]
        result = run_hook(script, canary["tool"], canary["input"], timeout)
        rows.append(canary_public_row(canary, result))
    return rows


def policy_signal_summary(canaries: list[dict[str, Any]]) -> dict[str, Any]:
    project_env_rows = [row for row in canaries if row.get("policy_signal") == "project_env_allowed"]
    allowed_project_env = [row["id"] for row in project_env_rows if row.get("observed_decision") == "allow"]
    denied_project_env = [row["id"] for row in project_env_rows if row.get("observed_decision") == "deny"]
    return {
        "project_env_variant_count": len(project_env_rows),
        "project_env_allowed_count": len(allowed_project_env),
        "project_env_denied_count": len(denied_project_env),
        "project_env_allowed_ids": allowed_project_env,
        "project_env_denied_ids": denied_project_env,
        "project_env_policy_status": (
            "allowed_by_current_policy_decision_needed" if allowed_project_env else
            "not_observed_allowed" if project_env_rows else
            "not_tested"
        ),
    }


def canary_scope_status(canaries: list[dict[str, Any]], hook: str) -> dict[str, Any]:
    rows = [row for row in canaries if row.get("hook") == hook]
    failing = [row["id"] for row in rows if not row.get("pass")]
    return {
        "executed": bool(rows),
        "count": len(rows),
        "pass_count": len(rows) - len(failing),
        "fail_count": len(failing),
        "failing_ids": failing,
        "all_passed": bool(rows) and not failing,
    }


def guard_path_classification(
    active: dict[str, Any],
    bundle: dict[str, Any],
    observability: dict[str, Any],
    canaries: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    bash_canaries = canary_scope_status(canaries, "bash")
    read_canaries = canary_scope_status(canaries, "read")
    return [
        {
            "id": "visible_settings_bash_pretool",
            "surface": "Claude active settings",
            "access_path": "Bash",
            "proof_class": "Active" if active.get("direct_pretool_covers_bash") else "Absent",
            "runtime_hook_proof": bool(active.get("direct_pretool_covers_bash")),
            "decision": "direct Bash PreToolUse hook wired" if active.get("direct_pretool_covers_bash") else "accepted_gap_pending_runtime_hook_event_or_direct_wiring",
        },
        {
            "id": "visible_settings_read_pretool",
            "surface": "Claude active settings",
            "access_path": "Read",
            "proof_class": "Active" if active.get("direct_pretool_covers_read") else "Absent",
            "runtime_hook_proof": bool(active.get("direct_pretool_covers_read")),
            "decision": "direct Read PreToolUse hook wired" if active.get("direct_pretool_covers_read") else "accepted_gap_pending_runtime_hook_event_or_direct_wiring",
        },
        {
            "id": "present_bundle_bash_guard",
            "surface": "claude-guards hook bundle",
            "access_path": "Bash",
            "proof_class": "Present" if bundle.get("present_covers_bash") else "Absent",
            "runtime_hook_proof": False,
            "decision": "present-only until settings wiring or hook event proof exists",
        },
        {
            "id": "present_bundle_read_guard",
            "surface": "claude-guards hook bundle",
            "access_path": "Read",
            "proof_class": "Present" if bundle.get("present_covers_read") else "Absent",
            "runtime_hook_proof": False,
            "decision": "present-only until settings wiring or hook event proof exists",
        },
        {
            "id": "synthetic_bash_guard_execution",
            "surface": "direct local guard script",
            "access_path": "Bash",
            "proof_class": "Executed" if bash_canaries["executed"] else "NotRun",
            "runtime_hook_proof": False,
            "decision": "offline guard-script canary passed" if bash_canaries["all_passed"] else "offline guard-script canary not clean",
            "canary_status": bash_canaries,
        },
        {
            "id": "synthetic_read_guard_execution",
            "surface": "direct local guard script",
            "access_path": "Read",
            "proof_class": "Executed" if read_canaries["executed"] else "NotRun",
            "runtime_hook_proof": False,
            "decision": "offline guard-script canary passed" if read_canaries["all_passed"] else "offline guard-script canary not clean",
            "canary_status": read_canaries,
        },
        {
            "id": "historical_bash_pretool_events",
            "surface": "historical observability",
            "access_path": "Bash",
            "proof_class": "Executed" if observability.get("pretool_bash_event_count", 0) else "Absent",
            "runtime_hook_proof": False,
            "decision": "historical event only; not current-turn guard proof",
            "event_count": observability.get("pretool_bash_event_count", 0),
        },
        {
            "id": "historical_read_pretool_events",
            "surface": "historical observability",
            "access_path": "Read",
            "proof_class": "Executed" if observability.get("pretool_read_event_count", 0) else "Absent",
            "runtime_hook_proof": False,
            "decision": "historical event only; not current-turn guard proof",
            "event_count": observability.get("pretool_read_event_count", 0),
        },
    ]


def coverage_decision(classifications: list[dict[str, Any]], canaries: list[dict[str, Any]], policy_signals: dict[str, Any]) -> dict[str, Any]:
    active_runtime_paths = {
        row["access_path"]
        for row in classifications
        if row.get("runtime_hook_proof") and row.get("access_path") in {"Bash", "Read"}
    }
    offline_rows = [
        row for row in classifications
        if row.get("id") in {"synthetic_bash_guard_execution", "synthetic_read_guard_execution"}
    ]
    offline_clean = bool(offline_rows) and all(row.get("canary_status", {}).get("all_passed") for row in offline_rows)
    if not canaries:
        offline_status = "not_run"
    elif offline_clean:
        offline_status = "passed"
    else:
        offline_status = "failed_or_incomplete"
    runtime_gap = {"Bash", "Read"} - active_runtime_paths
    return {
        "runtime_boundary_claim_allowed": not runtime_gap,
        "runtime_gap_access_paths": sorted(runtime_gap),
        "bash_read_runtime_gap_status": (
            "covered_by_visible_settings" if not runtime_gap
            else "accepted_gap_pending_runtime_hook_event_or_direct_wiring"
        ),
        "offline_guard_script_claim_allowed": offline_status == "passed",
        "offline_guard_script_status": offline_status,
        "project_env_policy_status": policy_signals.get("project_env_policy_status"),
        "accepted_policy_gaps": (
            sorted(runtime_gap)
            + (["generic_project_env_allowed"] if policy_signals.get("project_env_allowed_count", 0) else [])
        ),
    }


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    active = settings_summary(SETTINGS_PATH)
    local = settings_summary(LOCAL_SETTINGS_PATH)
    bundle = guard_bundle_summary()
    observability = observability_guard_correlation(
        Path(getattr(args, "observability_root", OBSERVABILITY_ROOT)),
        bundle,
        getattr(args, "max_observability_files", None),
    )
    canaries = run_canaries(args.timeout) if args.run else []
    failing = [row["id"] for row in canaries if not row.get("pass")]
    policy_signals = policy_signal_summary(canaries)
    classifications = guard_path_classification(active, bundle, observability, canaries)
    decision = coverage_decision(classifications, canaries, policy_signals)
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; synthetic inputs are hashed; no real secret files are read; hook deny reasons are hash/size only",
        "proof_class": "static_config" if not args.run else "static_config_plus_direct_script_synthetic_execution",
        "active_settings": active,
        "local_settings": local,
        "present_guard_bundle": bundle,
        "historical_observability_correlation": observability,
        "canary_run": {
            "executed": bool(args.run),
            "invocation_surface": "direct_subprocess_not_claude_pretooluse" if args.run else "not_run",
            "runtime_hook_proof": False,
            "proves": "direct guard script decision logic only; not Claude PreToolUse runtime dispatch",
            "count": len(canaries),
            "pass_count": sum(1 for row in canaries if row.get("pass")),
            "fail_count": len(failing),
            "failing_ids": failing,
            "synthetic_only": True,
        },
        "canaries": canaries,
        "policy_signals": policy_signals,
        "guard_path_classification": classifications,
        "coverage_decision": decision,
        "interpretation": {
            "visible_active_bash_read_pretool_hooks": active.get("direct_pretool_covers_bash") or active.get("direct_pretool_covers_read"),
            "present_bundle_bash_read_hooks": bundle.get("present_covers_bash") and bundle.get("present_covers_read"),
            "generic_project_env_is_gap_in_policy": (
                policy_signals.get("project_env_allowed_count", 0) > 0
            ),
            "r4_status": "synthetic-canary-landed" if args.run else "static-inventory-only",
            "historical_target_guard_identity_observed": observability.get("target_guard_identity_match_count", 0) > 0,
            "historical_pretool_bash_or_read_observed": (
                observability.get("pretool_bash_event_count", 0) > 0
                or observability.get("pretool_read_event_count", 0) > 0
            ),
            "canary_pass_implies_runtime_hook_active": False,
            "runtime_proof_status": "not_established_without_current_turn_hook_event",
        },
        "limitations": [
            "This does not invoke Claude Code tools or prove current-turn hook execution.",
            "This runs local guard scripts directly with synthetic hook JSON and hashed inputs.",
            "Allow results for generic project .env are expected gap signals, not permission to read real .env files.",
            "Visible settings proof can miss plugin-runtime hook merge behavior without a separate hook event trace.",
            "Historical observability correlation is not current-turn proof and non-observation is not proof of non-execution.",
        ],
    }
    return redact(report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Run synthetic hook canaries.")
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--observability-root", default=str(OBSERVABILITY_ROOT))
    parser.add_argument("--max-observability-files", type=int, default=None)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    report = build_report(args)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
