#!/usr/bin/env python3
"""Tests for tools/runp stdout-preserving ledger wrapper."""
import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOL_DIR))

import run_ledger  # noqa: E402
import runp  # noqa: E402


def run_main(argv: list[str]) -> tuple[int, str, str]:
    old_argv = sys.argv[:]
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        sys.argv = ["runp.py", *argv]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            rc = runp.main()
    finally:
        sys.argv = old_argv
    return rc, stdout.getvalue(), stderr.getvalue()


def test_runp_records_without_mutating_probe_stdout():
    with tempfile.TemporaryDirectory(prefix="runp-test-") as tmp_dir:
        tmp = Path(tmp_dir)
        ledger = tmp / "ledger.jsonl"
        probe = tmp / "fixture_probe.py"
        probe.write_text(
            "import json\n"
            "print(json.dumps({'schema':'fixture','schema_version':'9.9','ok':True}))\n",
            encoding="utf-8",
        )

        rc, stdout, stderr = run_main(["--ledger", str(ledger), str(probe)])

        parsed = run_ledger.parse_lines(ledger)
        assert rc == 0, rc
        assert stdout == '{"schema": "fixture", "schema_version": "9.9", "ok": true}\n', stdout
        assert stderr == "", stderr
        assert parsed["status"] == "ok", parsed
        event = parsed["events"][0]
        assert event["kind"] == "probe", event
        assert event["name"] == "fixture_probe.py", event
        assert event["schema_version"] == "9.9", event
        assert event["exit"] == 0, event
        assert event["stdout_bytes"] == len(stdout.encode()), event


def test_runp_ledger_failure_is_stderr_degraded_and_preserves_exit():
    with tempfile.TemporaryDirectory(prefix="runp-degraded-") as tmp_dir:
        tmp = Path(tmp_dir)
        blocker = tmp / "not-a-dir"
        blocker.write_text("x", encoding="utf-8")
        probe = tmp / "fixture_probe.py"
        probe.write_text("print('stdout must survive')\n", encoding="utf-8")

        rc, stdout, stderr = run_main(["--ledger", str(blocker / "ledger.jsonl"), str(probe)])

        assert rc == 0, rc
        assert stdout == "stdout must survive\n", stdout
        assert "RUN_LEDGER_DEGRADED" in stderr, stderr
        assert "stdout must survive" not in stderr, stderr


def test_runp_extracts_coverage_pct_and_secret_leak_count():
    output = "hello sk-secretshape123456\nOVERALL: 98/100 = 98.00%\n"

    assert runp.extract_json_schema('{"schema_version":"1.2"}') == "1.2"
    assert runp.extract_json_schema_info("")["schema_parse_status"] == "empty"
    assert runp.extract_json_schema_info("[1, 2]")["schema_parse_status"] == "wrong_shape"
    assert runp.extract_coverage_pct(output) == 98.0
    assert run_ledger.count_secret_hits(output) == 1


def test_runp_resolves_tool_script_and_plain_command():
    argv, kind, name = runp.resolve_command(["coverage_check.py", "runp"])
    plain_argv, plain_kind, plain_name = runp.resolve_command(["printf", "ok"])

    assert Path(argv[1]).name == "coverage_check.py", argv
    assert kind == "coverage", kind
    assert name == "coverage_check.py", name
    assert plain_argv == ["printf", "ok"], plain_argv
    assert plain_kind == "command", plain_kind
    assert plain_name == "printf", plain_name


def test_runp_missing_command_fails_closed():
    rc, stdout, stderr = run_main([])

    assert rc == 2, rc
    assert stdout == "", stdout
    assert "missing command" in stderr, stderr


def test_runp_missing_binary_records_127_and_stderr_error():
    with tempfile.TemporaryDirectory(prefix="runp-missing-binary-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"

        rc, stdout, stderr = run_main(["--ledger", str(ledger), "definitely-missing-agent-runtime-command"])

        parsed = run_ledger.parse_lines(ledger)
        assert rc == 127, rc
        assert stdout == "", stdout
        assert "FileNotFoundError" in stderr, stderr
        assert parsed["events"][0]["exit"] == 127, parsed
        assert parsed["events"][0]["schema_parse_status"] == "empty", parsed


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} runp tests passed")
