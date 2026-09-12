"""Owned subprocess output must retain bounded failure evidence independently of source tags."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from hypothesis import example, given, settings, strategies as st
import pytest


RUNNER = Path(__file__).resolve().parents[1] / "bot-errors-runner.py"
CAPTURE_FIELDS = {
    "capture_scope", "capture_limit_chars", "stdout_redacted_chars",
    "stderr_redacted_chars", "stdout_truncated", "stderr_truncated",
}


def invoke(tmp_path, code=None, *, name="child", limit=80, timeout=3, command=None):
    state = tmp_path / "state"
    outbox = state / "outbox"
    previous = set(outbox.glob("*.json"))
    if command is None:
        child = tmp_path / f"{name}.py"
        child.write_text(code, encoding="utf-8")
        command = [sys.executable, str(child)]
    env = os.environ.copy()
    env.update({
        "BOT_ERRORS_STATE_DIR": str(state),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox),
        "BOT_ERRORS_WRITEFAIL_DIR": str(state / "writefail"),
        "BOT_ERRORS_TEST_ISOLATED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--instance", "runner-fixture", "--source", "service-exit",
         "--summary", "Synthetic child failure", "--capture-limit", str(limit),
         "--timeout", str(timeout), "--", *command],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=10,
    )
    events = [json.loads(path.read_text()) for path in set(outbox.glob("*.json")) - previous]
    return proc, events


def measurements(event):
    values = {}
    for line in event["evidence"].splitlines():
        key, separator, value = line.partition("=")
        if separator and key in CAPTURE_FIELDS:
            values[key] = value
    assert set(values) == CAPTURE_FIELDS
    assert values["capture_scope"] == "owned_invocation"
    return values


def test_source_unmatched_traceback_and_errno_reach_event(tmp_path):
    stdout = "CHILD_START\n"
    stderr = "Traceback (most recent call last):\nPermissionError: [Errno 13] denied\n"
    proc, events = invoke(tmp_path, f"import sys\nsys.stdout.write({stdout!r})\nsys.stderr.write({stderr!r})\nsys.exit(7)\n", limit=200)
    assert proc.returncode == 7
    assert len(events) == 1
    event = events[0]
    assert "CHILD_START" in event["evidence"]
    assert "PermissionError: [Errno 13] denied" in event["evidence"]
    assert "Traceback (most recent call last):" in event["evidence"]
    assert "PermissionError" not in " ".join(event["process"]["argv"])
    assert "exit_code=7" in event["evidence"]
    assert "duration_ms=" in event["evidence"]
    fields = measurements(event)
    assert fields["stdout_redacted_chars"] == str(len(stdout))
    assert fields["stderr_redacted_chars"] == str(len(stderr))
    assert fields["stdout_truncated"] == fields["stderr_truncated"] == "false"
    assert not list((tmp_path / "state" / "writefail").glob("*"))


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_redacts_complete_owned_stream_before_truncation(tmp_path, stream):
    secret = "BOUNDARYSECRET" * 12
    text = "HEAD_SAFE token=" + secret + " TAIL_SAFE\n"
    redacted = text.replace(secret, "[REDACTED]")
    proc, events = invoke(tmp_path, f"import sys\nsys.{stream}.write({text!r})\nsys.exit(4)\n")
    assert proc.returncode == 4
    event = events[0]
    assert redacted.strip() in event["evidence"]
    serialized = json.dumps(event)
    assert "BOUNDARYSECRET" not in serialized
    assert "BOUNDARYSECRET" not in proc.stdout + proc.stderr
    assert "...[truncated]..." not in event["evidence"]
    fields = measurements(event)
    assert fields[f"{stream}_redacted_chars"] == str(len(redacted))
    assert fields[f"{stream}_truncated"] == "false"


@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_owned_stream_retains_bounded_head_tail_and_measurement(tmp_path, stream):
    text = "HEAD_CONTEXT " + "x" * 300 + " TAIL_CONTEXT\n"
    proc, events = invoke(tmp_path, f"import sys\nsys.{stream}.write({text!r})\nsys.exit(5)\n")
    assert proc.returncode == 5
    evidence = events[0]["evidence"]
    assert "HEAD_CONTEXT" in evidence and "TAIL_CONTEXT" in evidence
    assert "...[truncated]..." in evidence
    tail = evidence.split(f"{stream}_tail:\n", 1)[1]
    assert len(tail) <= 80 + len("\n...[truncated]...\n")
    fields = measurements(events[0])
    assert fields["capture_limit_chars"] == "80"
    assert fields[f"{stream}_redacted_chars"] == str(len(text))
    assert fields[f"{stream}_truncated"] == "true"


def test_timeout_keeps_partial_child_output(tmp_path):
    proc, events = invoke(tmp_path, "import sys,time\nprint('BEFORE_TIMEOUT', file=sys.stderr, flush=True)\ntime.sleep(5)\n", timeout=0.4)
    assert proc.returncode == 124
    assert "failure=timeout" in events[0]["evidence"]
    assert "BEFORE_TIMEOUT" in events[0]["evidence"]
    assert measurements(events[0])["stderr_redacted_chars"] == str(len("BEFORE_TIMEOUT\n"))


def test_missing_executable_keeps_launch_error(tmp_path):
    proc, events = invoke(tmp_path, command=[str(tmp_path / "missing-executable")], limit=400)
    assert proc.returncode == 127
    assert "failure=exec_not_found" in events[0]["evidence"]
    assert "No such file or directory" in events[0]["evidence"]
    assert int(measurements(events[0])["stderr_redacted_chars"]) > 0


def test_success_does_not_emit_failure_event(tmp_path):
    proc, events = invoke(tmp_path, "print('successful child')\n")
    assert proc.returncode == 0
    assert "successful child" in proc.stdout
    assert events == []


@settings(deadline=None)
@example(limit=-1)
@example(limit=0)
@example(limit=1)
@given(limit=st.integers(max_value=1))
def test_capture_limit_rejects_unbounded_small_slices(limit):
    with TemporaryDirectory() as directory:
        proc, events = invoke(Path(directory), "print('CHILD_MUST_NOT_START')\n", limit=limit)
        assert proc.returncode == 2
        assert "--capture-limit must be at least 2" in proc.stderr
        assert "CHILD_MUST_NOT_START" not in proc.stdout
        assert events == []


def test_minimum_capture_limit_bounds_each_stream(tmp_path):
    proc, events = invoke(tmp_path, "import sys\nprint('HEAD to TAIL')\nsys.exit(1)\n", limit=2)
    assert proc.returncode == 1
    tail = events[0]["evidence"].split("stdout_tail:\n", 1)[1]
    assert tail.startswith("H")
    assert len(tail) <= 2 + len("\n...[truncated]...\n")
    assert measurements(events[0])["stdout_truncated"] == "true"


def test_consecutive_invocations_do_not_share_capture(tmp_path):
    for name, marker in [("first", "FIRST_UNTAGGED_FAILURE"), ("second", "SECOND_UNTAGGED_FAILURE")]:
        proc, events = invoke(tmp_path, f"import sys\nprint({marker!r}, file=sys.stderr)\nsys.exit(8)\n", name=name)
        assert proc.returncode == 8
        assert len(events) == 1
        assert marker in events[0]["evidence"]
        other = "SECOND_UNTAGGED_FAILURE" if name == "first" else "FIRST_UNTAGGED_FAILURE"
        assert other not in json.dumps(events[0])
        measurements(events[0])
