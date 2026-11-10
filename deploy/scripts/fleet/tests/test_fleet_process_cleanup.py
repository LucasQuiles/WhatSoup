import json
import contextlib
import io
import os
import runpy
import select
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "mcp_probe_remote.py"
SERVER = """
import json, os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
child = subprocess.Popen([sys.executable, '-c', '''
import os, pathlib, signal, sys
root = pathlib.Path(sys.argv[1])
if sys.argv[2] == 'ignores-term':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
os.close(1)
receipt = os.open(root / 'lifetime', os.O_WRONLY)
stop = os.open(root / 'keep-running', os.O_RDONLY)
os.write(receipt, b'R')
(root / 'child-ready').write_text(str(os.getpid()))
os.read(stop, 1)
''', str(root), sys.argv[3]], start_new_session=sys.argv[3] == 'escaped')
deadline = time.monotonic() + 3
while not (root / 'child-ready').exists() and time.monotonic() < deadline:
    time.sleep(0.01)
def stop(signum, frame):
    child.terminate()
    child.wait(timeout=1)
    (root / 'graceful-stop').write_text('completed')
    raise SystemExit(0)
if sys.argv[2] == 'on-termination':
    signal.signal(signal.SIGTERM, stop)
if sys.argv[2] == 'ignore-termination':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if sys.argv[2] == 'before-reply':
    os._exit(0)
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    result = {'tools': []} if request['method'] == 'tools/list' else {}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
    if request['method'] == 'tools/list' and sys.argv[2] not in ('on-termination', 'ignore-termination'):
        os._exit(0)
"""
DRIVER = """
import pathlib, runpy, sys
from unittest.mock import patch
with patch.object(pathlib.Path, 'home', return_value=pathlib.Path(sys.argv[1])):
    runpy.run_path(sys.argv[2])
"""


def test_mcp_cleanup_closes_remaining_pipes_after_close_error(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    with contextlib.redirect_stdout(io.StringIO()):
        helper = runpy.run_path(str(SCRIPT))["finish_process"]
    closed = []
    reader, writer = os.pipe()
    os.write(writer, b"diagnostic")
    os.close(writer)

    class Stream:
        def __init__(self, name):
            self.name = name

        def fileno(self):
            return reader

        def close(self):
            closed.append(self.name)
            if self.name == "stdin":
                raise BrokenPipeError("synthetic closed input")

    process = SimpleNamespace(pid=123, wait=lambda **_: 0,
                              **{name: Stream(name) for name in ("stdin", "stdout", "stderr")})
    monkeypatch.setattr(os, "killpg", lambda *_: None)
    try:
        assert helper(process) == ("diagnostic", "BrokenPipeError")
        assert closed == ["stdin", "stdout", "stderr"]
    finally:
        os.close(reader)


@pytest.mark.parametrize("exit_at,group", [
    (exit_at, group)
    for exit_at in ("before-reply", "after-reply", "on-termination")
    for group in ("inherited", "escaped")
] + [("before-reply", "ignores-term"), ("after-reply", "ignores-term"),
     ("ignore-termination", "inherited")])
def test_mcp_parent_exit_does_not_wait_for_descendant_stderr(tmp_path, exit_at, group):
    server = tmp_path / "server.py"
    server.write_text(SERVER)
    keep = tmp_path / "keep-running"
    lifetime = tmp_path / "lifetime"
    os.mkfifo(keep)
    os.mkfifo(lifetime)
    stop = os.open(keep, os.O_RDWR | os.O_NONBLOCK)
    receipt = os.open(lifetime, os.O_RDONLY | os.O_NONBLOCK)
    instance = tmp_path / ".config/whatsoup/instances/synthetic"
    instance.mkdir(parents=True)
    (instance / "config.json").write_text(json.dumps({"agentOptions": {}}))
    (instance / "agent365.mcp.json").write_text(json.dumps({"mcpServers": {
        "microsoft_365": {"command": sys.executable, "args": [str(server), str(tmp_path), exit_at, group]}
    }}))
    process = subprocess.Popen(
        [sys.executable, "-c", DRIVER, str(tmp_path), str(SCRIPT)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    child = None
    child_ended = False
    completed = False
    completion_timeout = 6 if exit_at == "ignore-termination" or group in ("ignores-term", "escaped") else 3
    started = time.monotonic()
    try:
        try:
            stdout, stderr = process.communicate(timeout=completion_timeout)
            completed = True
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate(timeout=3)
        ready = tmp_path / "child-ready"
        assert ready.exists(), stderr.decode(errors="replace")
        child = int(ready.read_text())
        assert os.read(receipt, 1) == b'R'
        assert completed, "MCP probe blocked after its direct child exited"
        assert process.returncode == 0, stderr.decode(errors="replace")
        row = json.loads(stdout)["probes"][0]
        assert row.get("process_exit") == (-9 if exit_at == "ignore-termination" else 0), row
        assert time.monotonic() - started < completion_timeout
        if group == "ignores-term":
            assert row["error"] == "mcp_cleanup_unverified"
            assert row["cleanup_error"] == "stderr_incomplete"
        elif group == "escaped" and sys.platform == "darwin" and exit_at != "on-termination":
            assert row["error"] == "mcp_cleanup_unverified"
            assert row["cleanup_error"] == "PermissionError"
        elif exit_at == "before-reply":
            assert row["error"] == "mcp_closed"
        else:
            assert row["tool_count"] == 0
        if exit_at == "on-termination":
            assert (tmp_path / "graceful-stop").read_text() == 'completed'
        if group == "inherited" or exit_at == "on-termination":
            assert select.select([receipt], [], [], 1)[0], "owned process-group member survived cleanup"
            assert os.read(receipt, 1) == b''
            child_ended = True
        else:
            # An escaped group is outside the helper's signal authority.
            assert not select.select([receipt], [], [], 0)[0]
    finally:
        os.close(stop)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        process.stdout.close()
        process.stderr.close()
        ready = tmp_path / "child-ready"
        if child is None and ready.exists():
            child = int(ready.read_text())
        try:
            deadline = time.monotonic() + 3
            while child is not None and not child_ended:
                assert select.select([receipt], [], [], max(0, deadline - time.monotonic()))[0], "synthetic descendant did not exit after fixture cleanup"
                child_ended = os.read(receipt, 2) == b''
        finally:
            os.close(receipt)
