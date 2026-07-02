#!/usr/bin/env python3
"""No-send parity probe for local vs remote wa-fleet metadata reads."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Any

SCHEMA = "whatsoup-wa-fleet-parity-probe"
SCHEMA_VERSION = "0.1"
SAFE_FIELDS = ("source", "context", "kind", "confidence")
IDENTIFIER_VALUE_RE = re.compile(r"@|/[A-Za-z]|\b\d{6,}\b|token|sock|db", re.I)
JID_RE = re.compile(r"@[a-z0-9.-]+", re.I)
LONG_NUMBER_RE = re.compile(r"\b\d{10,}\b")
TOKEN_VALUE_RE = re.compile(r"\b(?:token|healthToken|bearer)\s*[:=]\s*[^\s]+", re.I)
MESSAGE_RE = re.compile(r"(?m)^MSG\b")
ME_TRUE_RE = re.compile(r"\bme=(?:1|true)\b", re.I)
ME_FALSE_RE = re.compile(r"\bme=(?:0|false)\b", re.I)


@dataclass(frozen=True)
class CommandResult:
    rc: int
    stdout: str = ""
    stderr: str = ""


Runner = Callable[..., CommandResult]


def default_runner(argv: list[str], *, host: str | None, timeout: int) -> CommandResult:
    env = os.environ.copy()
    if host:
        env["WHATSOUP_HOST"] = host
    else:
        env.pop("WHATSOUP_HOST", None)
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, check=False)
        return CommandResult(result.returncode, result.stdout, result.stderr)
    except subprocess.TimeoutExpired as exc:
        return CommandResult(124, exc.stdout or "", exc.stderr or "timeout")


RUNNER = default_runner


def _count(pattern: re.Pattern[str], text: str) -> int:
    return len(pattern.findall(text))


def safe_fields(raw: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for name in SAFE_FIELDS:
        match = re.search(rf"\b{name}=([^\s]+)", raw)
        if not match:
            continue
        value = match.group(1).strip('"')
        fields[name] = "<redacted>" if IDENTIFIER_VALUE_RE.search(value) else value
    return fields


def summarize_result(result: CommandResult) -> dict[str, Any]:
    raw = f"{result.stdout}\n{result.stderr}"
    return {
        "rc": result.rc,
        "stdout_bytes": len(result.stdout.encode()),
        "stderr_bytes": len(result.stderr.encode()),
        "line_count": len(raw.splitlines()),
        "jid_like_count": _count(JID_RE, raw),
        "long_number_count": _count(LONG_NUMBER_RE, raw),
        "token_value_shape_count": _count(TOKEN_VALUE_RE, raw),
        "message_marker_count": _count(MESSAGE_RE, raw),
        "me_true_count": _count(ME_TRUE_RE, raw),
        "me_false_count": _count(ME_FALSE_RE, raw),
        "safe_fields": safe_fields(raw),
        "error_class": classify_error(result),
    }


def classify_error(result: CommandResult) -> str | None:
    raw = f"{result.stdout}\n{result.stderr}".lower()
    if result.rc == 0:
        return None
    if "missing-config" in raw:
        return "missing_config"
    if "no such table" in raw:
        return "schema_error"
    if "no-context" in raw:
        return "no_context"
    if "timeout" in raw or result.rc == 124:
        return "timeout"
    return "command_failed"


def route_status(summary: dict[str, Any]) -> str:
    if summary["rc"] != 0:
        return "failed"
    fields = summary.get("safe_fields") or {}
    if fields.get("context") == "ok" and fields.get("kind") in {"group", "chat", "dm"}:
        return "usable"
    return "ok_unknown_context"


def local_problem_class(local: dict[str, dict[str, Any]]) -> str | None:
    classes = {item.get("error_class") for item in local.values()}
    if "missing_config" in classes or "schema_error" in classes:
        return "missing_config_or_schema"
    if "timeout" in classes:
        return "timeout"
    if "command_failed" in classes:
        return "command_failed"
    return None


def parity_status(local_plan: dict[str, Any], remote_plan: dict[str, Any]) -> str:
    local_ok = route_status(local_plan) == "usable"
    remote_ok = route_status(remote_plan) == "usable"
    if local_ok and remote_ok:
        return "parity_ok"
    if remote_ok and not local_ok:
        return "remote_usable_local_failed"
    if local_ok and not remote_ok:
        return "local_usable_remote_failed"
    return "both_failed_or_inconclusive"


def direct_query_status(resolve_summary: dict[str, Any] | None) -> str:
    if resolve_summary is None:
        return "skipped"
    if resolve_summary.get("rc") == 0:
        return "resolved"
    if resolve_summary.get("error_class") == "no_context":
        return "no_context"
    return "failed"


def run_surface(
    runner: Callable[[list[str]], CommandResult],
    *,
    wa_fleet_bin: str,
    instance: str,
    query: str,
    op: str,
    host: str | None,
    timeout: int,
) -> dict[str, Any]:
    if op == "doctor":
        argv = [wa_fleet_bin, "doctor", instance]
    elif op == "plan-send":
        argv = [wa_fleet_bin, "plan-send", instance, query, "--allow-group"]
    elif op == "resolve":
        argv = [wa_fleet_bin, "resolve", instance, query]
    else:
        raise ValueError(f"unknown op: {op}")
    result = runner(argv, host=host, timeout=timeout)
    return summarize_result(result)


def build_report(
    *,
    instance: str = "personal",
    query: str = "WHATSOUP",
    direct_query: str = "Q",
    remote_host: str = "nucles",
    wa_fleet_bin: str = "wa-fleet",
    timeout: int = 20,
    runner: Callable[..., CommandResult] = RUNNER,
) -> dict[str, Any]:
    local = {
        "doctor": run_surface(runner, wa_fleet_bin=wa_fleet_bin, instance=instance, query=query, op="doctor", host=None, timeout=timeout),
        "plan_send": run_surface(runner, wa_fleet_bin=wa_fleet_bin, instance=instance, query=query, op="plan-send", host=None, timeout=timeout),
    }
    remote = {
        "doctor": run_surface(runner, wa_fleet_bin=wa_fleet_bin, instance=instance, query=query, op="doctor", host=remote_host, timeout=timeout),
        "plan_send": run_surface(runner, wa_fleet_bin=wa_fleet_bin, instance=instance, query=query, op="plan-send", host=remote_host, timeout=timeout),
    }
    direct = None
    if direct_query:
        direct = run_surface(runner, wa_fleet_bin=wa_fleet_bin, instance=instance, query=direct_query, op="resolve", host=remote_host, timeout=timeout)
        remote["direct_resolve"] = direct

    remote_plan = remote["plan_send"]
    local_plan = local["plan_send"]
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "metadata_only_no_send_parity_probe",
        "redaction": (
            "Stores command exit codes, byte counts, structural counters, safe non-identifier fields, "
            "and error classes only; suppresses raw stdout/stderr, chat bodies, JIDs/LIDs, phone numbers, "
            "tokens, auth paths, socket paths, DB paths, and NEXT send commands."
        ),
        "scope": {
            "instance": instance,
            "query_label": query,
            "direct_query_label": direct_query or None,
            "remote_host_label": remote_host,
            "operations": ["doctor", "plan-send", "remote resolve direct query"],
            "send_executed": False,
        },
        "summary": {
            "parity_status": parity_status(local_plan, remote_plan),
            "local_problem_class": local_problem_class(local),
            "local_route_status": route_status(local_plan),
            "remote_route_status": route_status(remote_plan),
            "direct_query_status": direct_query_status(direct),
            "remote_message_marker_count": remote_plan["message_marker_count"],
            "remote_me_true_count": remote_plan["me_true_count"],
            "remote_me_false_count": remote_plan["me_false_count"],
        },
        "surfaces": {
            "local": local,
            "remote": remote,
        },
        "limitations": [
            "This probe does not prove group membership or message semantics.",
            "This probe does not send messages, mutate WhatsApp state, restart services, or inspect raw chat bodies.",
            "A remote-host success with local failure proves wrapper/config parity drift, not a WhatsApp transport failure.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="No-send wa-fleet local/remote parity probe")
    parser.add_argument("--instance", default="personal")
    parser.add_argument("--query", default="WHATSOUP")
    parser.add_argument("--direct-query", default="Q")
    parser.add_argument("--remote-host", default="nucles")
    parser.add_argument("--wa-fleet-bin", default="wa-fleet")
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    report = build_report(
        instance=args.instance,
        query=args.query,
        direct_query=args.direct_query,
        remote_host=args.remote_host,
        wa_fleet_bin=args.wa_fleet_bin,
        timeout=args.timeout,
        runner=RUNNER,
    )
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
