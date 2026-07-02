#!/usr/bin/env python3
"""Tests for the no-send wa-fleet local/remote parity probe."""

from __future__ import annotations

import io
import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import wa_fleet_parity_probe as probe  # noqa: E402


def _result(rc: int, stdout: str = "", stderr: str = "") -> probe.CommandResult:
    return probe.CommandResult(rc=rc, stdout=stdout, stderr=stderr)


class FakeRunner:
    def __init__(self, results: dict[tuple[str, str], probe.CommandResult]):
        self.results = results
        self.calls: list[tuple[str, str, tuple[str, ...], str | None]] = []

    def __call__(self, argv: list[str], *, host: str | None, timeout: int) -> probe.CommandResult:
        op = argv[1]
        mode = "remote" if host else "local"
        self.calls.append((mode, op, tuple(argv), host))
        return self.results[(mode, op)]


def test_build_report_classifies_remote_usable_local_schema_gap_without_leaking_identifiers():
    group_id = "123456" + "789012"
    phone_id = "12345" + "67890"
    group_jid = group_id + "@" + "g.us"
    phone_jid = phone_id + "@" + "s.whatsapp.net"
    private_path = "/" + "home" + "/private/path"
    token_status = "token" + "=present"
    send_confirm = "--" + "confirm"
    chat_jid_flag = "--" + "chat" + "jid"
    runner = FakeRunner({
        ("local", "doctor"): _result(12, stdout="CHECK name=config-roots status=ok\n", stderr="ERROR code=missing-config op=doctor inst=personal\n"),
        ("local", "plan-send"): _result(15, stderr='ERROR code=read-failed op=plan-send detail="no such table: lid_mappings"\n'),
        ("remote", "doctor"): _result(0, stdout=f"CHECK name=config-roots status=ok detail={private_path} {token_status}\n"),
        ("remote", "plan-send"): _result(
            0,
            stdout=(
                f"STATUS op=plan-send inst=personal result=ok source=mcp target={group_jid} context=ok\n"
                f"TARGET source=mcp kind=group jid={group_jid} label=WHATSOUP confidence=med\n"
                f'MSG source=mcp ts="2026-06-30T21:00:00-0400" from="{phone_jid}" me=0 body="do not leak"\n'
                'MSG source=mcp ts="2026-06-30T21:01:00-0400" from="me" me=1 body="do not leak either"\n'
                f"NEXT cmd=\"wa-fleet send personal {chat_jid_flag} {group_jid} --text secret {send_confirm}\"\n"
            ),
        ),
        ("remote", "resolve"): _result(11, stderr="ERROR code=no-context op=resolve query=Q\n"),
    })

    report = probe.build_report(
        instance="personal",
        query="WHATSOUP",
        direct_query="Q",
        remote_host="nucles",
        runner=runner,
    )

    assert report["schema"] == "whatsoup-wa-fleet-parity-probe", report
    assert report["summary"]["parity_status"] == "remote_usable_local_failed", report
    assert report["summary"]["local_problem_class"] == "missing_config_or_schema", report
    assert report["summary"]["remote_route_status"] == "usable", report
    assert report["summary"]["direct_query_status"] == "no_context", report
    assert report["summary"]["remote_message_marker_count"] == 2, report
    assert report["summary"]["remote_me_true_count"] == 1, report
    assert report["summary"]["remote_me_false_count"] == 1, report
    assert report["surfaces"]["remote"]["plan_send"]["safe_fields"] == {
        "source": "mcp",
        "context": "ok",
        "kind": "group",
        "confidence": "med",
    }

    rendered = json.dumps(report, sort_keys=True)
    assert group_id not in rendered
    assert phone_id not in rendered
    assert "@g.us" not in rendered
    assert "@s.whatsapp.net" not in rendered
    assert "do not leak" not in rendered
    assert private_path not in rendered
    assert token_status not in rendered


def test_main_emits_json_report_with_no_send_commands():
    send_confirm = "--" + "confirm"
    runner = FakeRunner({
        ("local", "doctor"): _result(0, stdout="CHECK name=config-roots status=ok\n"),
        ("local", "plan-send"): _result(0, stdout="STATUS op=plan-send source=mcp kind=group context=ok confidence=med\n"),
        ("remote", "doctor"): _result(0, stdout="CHECK name=config-roots status=ok\n"),
        ("remote", "plan-send"): _result(0, stdout="STATUS op=plan-send source=mcp kind=group context=ok confidence=med\n"),
        ("remote", "resolve"): _result(11, stderr="ERROR code=no-context op=resolve query=Q\n"),
    })
    orig_argv = sys.argv
    orig_runner = probe.RUNNER
    sys.argv = ["wa_fleet_parity_probe.py", "--remote-host", "nucles", "--pretty"]
    probe.RUNNER = runner
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
        probe.RUNNER = orig_runner

    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["summary"]["parity_status"] == "parity_ok", report
    assert all(send_confirm not in call[2] for call in runner.calls)
    assert [call[1] for call in runner.calls] == ["doctor", "plan-send", "doctor", "plan-send", "resolve"]


if __name__ == "__main__":
    tests = [
        test_build_report_classifies_remote_usable_local_schema_gap_without_leaking_identifiers,
        test_main_emits_json_report_with_no_send_commands,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"\nall {len(tests)} wa_fleet_parity_probe tests passed")
