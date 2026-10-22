"""A target that accepts TCP but never answers must still be restarted.

The rendered watchdog runs the REAL pinned health reader under the REAL
run_with_timeout against real loopback sockets. The reader's own socket timeout
has to expire before the outer wall deadline kills it; otherwise a wedged bot
or fleet console becomes HEALTH-UNKNOWN every cycle and is never restarted
(main's `curl --max-time 8` restarted it). Such a read is SILENT, so the run
confirms it with re-reads for the confirm window before it restarts, in the
same run. Shell-level timeouts and the confirm window are rendered constants,
so the cases shrink them to keep the suite fast; one case runs the shipped
read timeouts.
"""
from __future__ import annotations

import hashlib
import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import pytest
from hypothesis import given, strategies as st

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

from bot_errors_property_support import private_case, properties  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("zsh") is None, reason="zsh not available")

_SCRIPTS = Path(__file__).resolve().parents[1]
_TEMPLATE = _SCRIPTS.parent / "templates" / "watchdog-script.sh"
_READER = _SCRIPTS / "lib" / "health_reader.py"
_spec = importlib.util.spec_from_file_location("health_reader_hung_target", _READER)
reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(reader)

_OK_BODY = json.dumps({"status": "healthy", "whatsapp": {"connected": True, "connection": {"state": "connected"}}})
_BOT_LABEL = "com.whatsoup.hang-agent"
_FLEET_LABEL = "com.whatsoup.whatsoup-fleet"


@contextmanager
def _silent_server():
    """Accept every connection and never send a byte."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    held: list[socket.socket] = []
    stop = threading.Event()

    def accept_forever():
        listener.settimeout(0.2)
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
            except (TimeoutError, OSError):
                continue
            held.append(connection)

    thread = threading.Thread(target=accept_forever, daemon=True)
    thread.start()
    try:
        yield listener.getsockname()[1]
    finally:
        stop.set()
        thread.join(timeout=2)
        for connection in held:
            connection.close()
        listener.close()


@contextmanager
def _silent_then_answering_server(body: str, silent_connections: int):
    """Hold the first connections open without a byte, then answer each request."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    held: list[socket.socket] = []
    stop = threading.Event()
    payload = body.encode("utf-8")
    response = (b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(payload)).encode("ascii")
                + b"\r\nConnection: close\r\n\r\n" + payload)

    def accept_forever():
        listener.settimeout(0.2)
        accepted = 0
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
            except (TimeoutError, OSError):
                continue
            accepted += 1
            if accepted <= silent_connections:
                held.append(connection)
                continue
            connection.settimeout(2)
            try:
                request = b""
                while b"\r\n\r\n" not in request:
                    chunk = connection.recv(4096)
                    if not chunk:
                        break
                    request += chunk
                connection.sendall(response)
            except OSError:
                pass
            finally:
                connection.close()

    thread = threading.Thread(target=accept_forever, daemon=True)
    thread.start()
    try:
        yield listener.getsockname()[1]
    finally:
        stop.set()
        thread.join(timeout=2)
        for connection in held:
            connection.close()
        listener.close()


@contextmanager
def _answering_server(body: str):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            payload = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def _run(tmp_path: Path, bot_port: int, fleet_port: int, *, timeouts: tuple[int, int] | None):
    home = tmp_path / "home"
    bindir = home / ".local" / "bin"
    bindir.mkdir(parents=True)
    calls = home / "launchctl.calls"
    launchctl = bindir / "launchctl"
    launchctl.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{calls}"\nexit 0\n')
    launchctl.chmod(0o755)
    token = home / ".config/whatsoup/instances/hang-agent/tokens.env"
    token.parent.mkdir(parents=True)
    token.write_text("WHATSOUP_HEALTH_TOKEN=" + "a" * 64 + "\n")
    token.chmod(0o600)
    text = (_TEMPLATE.read_text(encoding="utf-8")
            .replace("__HOME__", str(home)).replace("BOT_NAME", "hang-agent")
            .replace("USERNAME", "tester").replace("FLEET_PORT", str(fleet_port))
            .replace("BOT_PORT", str(bot_port))
            # No paging happens here; an absent emitter keeps pages off live outboxes.
            .replace("__BOT_ERRORS_EMIT__", str(home / "absent-bot-errors-emit.py"))
            .replace("__HEALTH_READER_PATH__", str(_READER))
            .replace("__HEALTH_READER_SHA256__", hashlib.sha256(_READER.read_bytes()).hexdigest()))
    if timeouts is not None:
        read_timeout, deadline = timeouts
        text = re.sub(r"(?m)^HEALTH_READ_TIMEOUT_SECONDS=\d+$", f"HEALTH_READ_TIMEOUT_SECONDS={read_timeout}", text)
        text = re.sub(r"(?m)^HEALTH_READ_DEADLINE_SECONDS=\d+$", f"HEALTH_READ_DEADLINE_SECONDS={deadline}", text)
    # A silent read confirms before it restarts. A two-second window (one or
    # two confirm reads) keeps these real-socket cases short; the shipped
    # window is exercised with a stubbed sleep in test_watchdog_two_strike.py.
    text = re.sub(r"(?m)^CONFIRM_WINDOW_SECONDS=\d+$", "CONFIRM_WINDOW_SECONDS=2", text)
    text = re.sub(r"(?m)^CONFIRM_STEP_SECONDS=\d+$", "CONFIRM_STEP_SECONDS=1", text)
    script = home / "watchdog"
    script.write_text(text)
    started = time.monotonic()
    proc = subprocess.run(["zsh", str(script)], capture_output=True, text=True, timeout=60,
                          env=dict(os.environ, HOME=str(home)))
    elapsed = time.monotonic() - started
    log = (home / "Library/Logs/whatsoup/hang-agent-watchdog.log").read_text()
    return proc, calls.read_text() if calls.exists() else "", log, elapsed


def _kickstarts(calls: str, label: str) -> int:
    return sum("kickstart -k" in row and row.endswith(label) for row in calls.splitlines())


def _confirm_reads(log: str, label: str) -> list[str]:
    return [line for line in log.splitlines() if f"{label} confirm read " in line]


def _assert_confirmed_then_restarted(log: str, label: str, reader_exit: int):
    """At least one confirm read, numbered in order, each with `reader_exit`,
    between the window's opening line and the restart that follows it."""
    lines = log.splitlines()

    def first(fragment: str) -> int:
        return next(i for i, line in enumerate(lines) if fragment in line)

    confirms = [i for i, line in enumerate(lines) if f"{label} confirm read " in line]
    assert confirms, log
    for number, i in enumerate(confirms, start=1):
        assert f"{label} confirm read {number}: " in lines[i], log
        assert lines[i].endswith(f"(reader exit {reader_exit})"), log
    opened = first(f"{label} silent read; confirming before restarting")
    due = first(f"{label} no trusted answer in ")
    acted = first(f"restarting {label}: ")
    assert opened < confirms[0] and confirms[-1] < due < acted, log


@properties
@given(bot_hangs=st.booleans(), fleet_hangs=st.booleans())
def test_hung_target_is_restarted_not_unknown(bot_hangs, fleet_hangs):
    with private_case() as (tmp_path, monkeypatch), _silent_server() as silent, \
            _answering_server(_OK_BODY) as bot_ok, _answering_server("ok") as fleet_ok:
        proc, calls, log, _ = _run(tmp_path, silent if bot_hangs else bot_ok,
                                   silent if fleet_hangs else fleet_ok, timeouts=(1, 3))
    assert proc.returncode == 0, (proc.stderr, log)
    assert "HEALTH-UNKNOWN" not in log
    assert _kickstarts(calls, _BOT_LABEL) == int(bot_hangs)
    assert _kickstarts(calls, _FLEET_LABEL) == int(fleet_hangs)
    assert bool(_confirm_reads(log, _BOT_LABEL)) == bot_hangs
    assert bool(_confirm_reads(log, _FLEET_LABEL)) == fleet_hangs
    expected_final = "RESTARTED" if bot_hangs or fleet_hangs else "ok"
    assert log.splitlines()[-1].endswith(expected_final)


def test_hung_bot_is_restarted_with_the_shipped_timeouts(tmp_path):
    with _silent_server() as silent, _answering_server("ok") as fleet_ok:
        proc, calls, log, elapsed = _run(tmp_path, silent, fleet_ok, timeouts=None)
    assert proc.returncode == 0, (proc.stderr, log)
    assert _kickstarts(calls, _BOT_LABEL) == 1
    assert "health endpoint unreachable: connection accepted" in log
    # Every read, confirm reads included, ended by the reader's own timeout.
    confirms = _confirm_reads(log, _BOT_LABEL)
    assert confirms and all(line.endswith("(reader exit 8)") for line in confirms), confirms
    assert "health read exceeded" not in log and "HEALTH-UNKNOWN" not in log
    assert elapsed < 7.5 * (1 + len(confirms)) + 2, "the reader's own timeout must answer before the wall deadline"


def test_reader_killed_at_the_wall_deadline_is_restarted(tmp_path):
    # A reader that has not finished by the wall deadline yields no evidence of
    # its own; like main's `curl --max-time`, an incomplete read is restart
    # evidence for that target, confirmed like any silent read.
    with _silent_server() as silent, _answering_server("ok") as fleet_ok:
        proc, calls, log, _ = _run(tmp_path, silent, fleet_ok, timeouts=(4, 1))
    assert proc.returncode == 0, (proc.stderr, log)
    assert _kickstarts(calls, _BOT_LABEL) == 1
    assert "HEALTH-UNKNOWN" not in log
    assert "health read exceeded" in log
    _assert_confirmed_then_restarted(log, _BOT_LABEL, 124)
    assert log.splitlines()[-1].endswith("RESTARTED")


def test_fleet_reader_killed_at_the_wall_deadline_is_restarted(tmp_path):
    # The fleet's wall-deadline (exit 124) branch: a silent read of the fleet
    # label, confirmed and then restarted, never the bot.
    with _silent_server() as silent, _answering_server(_OK_BODY) as bot_ok:
        proc, calls, log, _ = _run(tmp_path, bot_ok, silent, timeouts=(4, 1))
    assert proc.returncode == 0, (proc.stderr, log)
    assert _kickstarts(calls, _FLEET_LABEL) == 1
    assert _kickstarts(calls, _BOT_LABEL) == 0
    assert "fleet console health read exceeded" in log
    _assert_confirmed_then_restarted(log, _FLEET_LABEL, 124)
    assert "HEALTH-UNKNOWN" not in log
    assert log.splitlines()[-1].endswith("RESTARTED")


@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_target_answering_within_the_confirm_window_is_not_restarted(tmp_path, target):
    # Red on base: base restarts on the first silent read. Real sockets: the
    # first connection is held silent, the next one answers.
    body = _OK_BODY if target == "bot" else "ok"
    with _silent_then_answering_server(body, silent_connections=1) as flaky, \
            _answering_server(_OK_BODY) as bot_ok, _answering_server("ok") as fleet_ok:
        proc, calls, log, _ = _run(tmp_path, flaky if target == "bot" else bot_ok,
                                   flaky if target == "fleet" else fleet_ok, timeouts=(1, 3))
    label = _BOT_LABEL if target == "bot" else _FLEET_LABEL
    assert proc.returncode == 0, (proc.stderr, log)
    assert "kickstart" not in calls and "bootstrap" not in calls
    assert f"{label} answered on confirm read 1; restart avoided" in log
    assert log.splitlines()[-1].endswith("RESTART-AVOIDED")


def test_shipped_reader_timeout_is_strictly_below_the_wall_deadline():
    text = _TEMPLATE.read_text(encoding="utf-8")
    read_timeout = int(re.search(r"(?m)^HEALTH_READ_TIMEOUT_SECONDS=(\d+)$", text).group(1))
    deadline = int(re.search(r"(?m)^HEALTH_READ_DEADLINE_SECONDS=(\d+)$", text).group(1))
    assert read_timeout + 2 <= deadline
    assert 'run_with_timeout "$HEALTH_READ_DEADLINE_SECONDS" python3' in text
    assert '"$HEALTH_READ_TIMEOUT_SECONDS" 3<&0' in text


def test_reader_raises_transport_error_for_a_silent_server_within_its_timeout():
    with _silent_server() as silent:
        started = time.monotonic()
        with pytest.raises(reader.HealthTransportError) as caught:
            reader.fetch_loopback_health(silent, "/health", {}, timeout=0.5)
        elapsed = time.monotonic() - started
    assert caught.value.stage in ("response", "read")
    assert elapsed < 1.5
