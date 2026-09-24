"""Single-attempt loopback failures must retain their source and restart policy."""
import errno
import hashlib
import importlib.util
import json
import os
import signal
import sys
from pathlib import Path
import subprocess

import pytest
from hypothesis import example, given, strategies as st

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

from bot_errors_property_support import private_case, properties  # noqa: E402

SCRIPTS = Path(__file__).resolve().parents[1]
TEMPLATE = SCRIPTS.parent / "templates/watchdog-script.sh"
spec = importlib.util.spec_from_file_location("health_reader_transport", SCRIPTS / "lib/health_reader.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


@pytest.mark.parametrize("stage", ["connect", "request", "response", "read"])
@pytest.mark.parametrize("number", [errno.EADDRNOTAVAIL, errno.ECONNREFUSED, errno.ETIMEDOUT])
@properties
@given(generated_errno=st.integers(min_value=1, max_value=255))
def test_transport_retains_exact_stage_and_errno(stage, number, generated_errno):
    with private_case() as (tmp_path, monkeypatch):
        for number in (number, generated_errno):
            calls = []

            class Connection:
                def __init__(self, host, port, timeout):
                    assert host == "127.0.0.1" and port == 9999

                def step(self, name):
                    calls.append(name)
                    if name == stage:
                        raise OSError(number, "synthetic private exception text")

                def connect(self): self.step("connect")
                def request(self, *args, **kwargs): self.step("request")
                def getresponse(self): self.step("response"); return self
                def read(self, limit): self.step("read"); return b"{}"
                def close(self): calls.append("close")
                status = 200

            monkeypatch.setattr("http.client.HTTPConnection", Connection)
            with pytest.raises(reader.HealthTransportError) as caught:
                reader.fetch_loopback_health(9999, "/health", {})
            assert caught.value.stage == stage
            assert caught.value.errno == number
            assert "private" not in str(caught.value)
            assert calls.count("connect") == 1 and calls[-1] == "close"


def _run(tmp_path, bot, fleet, *, helper_mode="valid", marker=False, unloaded=False,
         track_sleep=False):
    home = tmp_path / "home"
    bindir = home / ".local/bin"
    bindir.mkdir(parents=True)
    calls = home / "launchctl.calls"
    sleep_pids = home / "sleep.pids"
    if track_sleep:
        sleeper = bindir / "sleep"
        sleeper.write_text("#!/usr/bin/env python3\nimport os,time\n"
                           + "with open(" + repr(str(sleep_pids)) + ", 'a') as f: f.write(str(os.getpid())+'\\n')\n"
                           + "time.sleep(30)\n")
        sleeper.chmod(0o755)
    for name, text in {
        "launchctl": '#!/bin/sh\nprintf "%s\\n" "$*" >> "'+str(calls)+'"\n'
                     + ('[ "$1" = print ] && exit 1\n' if unloaded else '') + 'exit 0\n',
        "curl": '#!/bin/sh\nexit 7\n',
    }.items():
        p = bindir / name; p.write_text(text); p.chmod(0o755)
    token = home / ".config/whatsoup/instances/test-agent/tokens.env"
    token.parent.mkdir(parents=True)
    token.write_text("WHATSOUP_HEALTH_TOKEN=" + "a" * 64 + "\n"); token.chmod(0o600)
    helper = home / "health_reader.py"
    helper.write_text('''import json, os
class HealthTransportError(Exception):
    def __init__(self, stage, number): self.stage=stage; self.errno=number
def fetch_loopback_health(port, path, headers, **kwargs):
    item=json.loads(os.environ["FAKE_RESPONSES"])[str(port)]
    if "errno" in item: raise HealthTransportError(item["stage"],item["errno"])
    if "exception" in item: raise ValueError("synthetic private value")
    return item["status"], item["body"]
''')
    digest = hashlib.sha256(helper.read_bytes()).hexdigest()
    text = TEMPLATE.read_text().replace("__HOME__", str(home)).replace("BOT_NAME", "test-agent").replace("USERNAME", "tester").replace("FLEET_PORT", "9998").replace("BOT_PORT", "9999")
    # No paging happens here; an absent emitter keeps any page off live outboxes.
    text = text.replace("__BOT_ERRORS_EMIT__", str(home / "absent-bot-errors-emit.py"))
    text = text.replace("__HEALTH_READER_PATH__", str(helper)).replace("__HEALTH_READER_SHA256__", digest)
    script = home / "watchdog"; script.write_text(text)
    if helper_mode == "missing": helper.unlink()
    if helper_mode == "mismatch": helper.write_text("raise RuntimeError('must never execute')\n")
    logdir = home / "Library/Logs/whatsoup"
    logdir.mkdir(parents=True)
    mark = logdir / "test-agent-credential-dead.marker"
    if marker: mark.write_text(""); mark.chmod(0o600)
    proc = subprocess.run(["zsh", str(script)], capture_output=True, text=True, timeout=20,
        env=dict(os.environ, HOME=str(home), FAKE_RESPONSES=json.dumps({"9999":bot,"9998":fleet})))
    survivors = []
    if track_sleep and sleep_pids.exists():
        for row in sleep_pids.read_text().splitlines():
            pid = int(row)
            try:
                os.kill(pid, 0)
                survivors.append(pid)
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    assert not survivors, f"watchdog left owned timer children alive: {survivors}"
    return proc, calls.read_text() if calls.exists() else "", (logdir / "test-agent-watchdog.log").read_text(), mark.exists()


OK = {"status":200,"body":'{"status":"healthy","whatsapp":{"connected":true,"connection":{"state":"connected"}}}'}
FLEET_OK = {"status":200,"body":"ok"}
EXHAUSTED = {"stage":"connect","errno":errno.EADDRNOTAVAIL}
REFUSED = {"stage":"connect","errno":errno.ECONNREFUSED}


def test_fast_cycle_leaves_no_external_timer_children(tmp_path):
    proc, calls, log, _ = _run(tmp_path, OK, FLEET_OK, track_sleep=True)
    assert proc.returncode == 0
    assert "kickstart" not in calls and log.splitlines()[-1].endswith("ok")


@pytest.mark.parametrize("target", ["bot", "fleet", "both"])
@properties
@given(initial_marker=st.booleans(), unloaded=st.booleans())
def test_address_unavailable_is_unknown_without_restart(target, initial_marker, unloaded):
    with private_case() as (tmp_path, monkeypatch):
        proc, calls, log, marker = _run(tmp_path, EXHAUSTED if target != "fleet" else OK,
                                        EXHAUSTED if target != "bot" else FLEET_OK, marker=initial_marker, unloaded=unloaded)
        assert proc.returncode == 2, proc.stderr
        assert "kickstart" not in calls
        assert "HEALTH-UNKNOWN" in log and "EADDRNOTAVAIL" in log
        assert marker == initial_marker
        assert "bootstrap" not in calls


@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_refusal_retains_recovery(tmp_path, target):
    proc, calls, log, _ = _run(tmp_path, REFUSED if target == "bot" else OK,
                               REFUSED if target == "fleet" else FLEET_OK)
    assert proc.returncode == 0, proc.stderr
    label = "com.whatsoup.test-agent" if target == "bot" else "com.whatsoup.whatsoup-fleet"
    assert sum("kickstart -k" in row and row.endswith(label) for row in calls.splitlines()) == 1


@pytest.mark.parametrize("mode", ["missing", "mismatch"])
def test_unavailable_helper_cannot_authorize_restart(tmp_path, mode):
    proc, calls, log, _ = _run(tmp_path, REFUSED, REFUSED, helper_mode=mode)
    assert proc.returncode == 2
    assert "kickstart" not in calls and "HEALTH-UNKNOWN" in log
    assert "private" not in proc.stderr + log


def test_mixed_cycle_only_restarts_refused_target(tmp_path):
    proc, calls, log, _ = _run(tmp_path, REFUSED, EXHAUSTED)
    assert proc.returncode == 2
    assert sum("kickstart -k" in x for x in calls.splitlines()) == 1
    assert any("kickstart -k" in x and x.endswith("com.whatsoup.test-agent") for x in calls.splitlines())
    assert log.splitlines()[-1].endswith("HEALTH-UNKNOWN")


def test_wrong_stage_does_not_claim_address_exhaustion(tmp_path):
    proc, calls, log, _ = _run(tmp_path, {"stage":"read","errno":errno.EADDRNOTAVAIL}, FLEET_OK)
    assert proc.returncode == 0
    assert "kickstart -k" in calls and "EADDRNOTAVAIL" not in log


@pytest.mark.parametrize("mode", ["missing", "mismatch"])
def test_invalid_binding_cannot_bootstrap_unloaded_jobs(tmp_path, mode):
    proc, calls, log, _ = _run(tmp_path, REFUSED, REFUSED, helper_mode=mode, unloaded=True)
    assert proc.returncode == 2
    assert "bootstrap" not in calls
    assert "kickstart" not in calls


def test_exhaustion_cannot_bootstrap_unloaded_jobs(tmp_path):
    proc, calls, log, _ = _run(tmp_path, EXHAUSTED, EXHAUSTED, unloaded=True)
    assert proc.returncode == 2
    assert "bootstrap" not in calls and "kickstart" not in calls


@pytest.mark.parametrize("target", ["bot", "fleet"])
def test_unloaded_refused_target_bootstraps_once_without_kickstart(tmp_path, target):
    proc, calls, log, _ = _run(tmp_path, REFUSED if target == "bot" else EXHAUSTED,
                               REFUSED if target == "fleet" else EXHAUSTED, unloaded=True)
    assert proc.returncode == 2
    label = "com.whatsoup.test-agent" if target == "bot" else "com.whatsoup.whatsoup-fleet"
    bootstrap = [line for line in calls.splitlines() if line.startswith("bootstrap ")]
    assert len(bootstrap) == 1 and bootstrap[0].endswith(label + ".plist")
    assert "kickstart" not in calls


@pytest.mark.parametrize("status", [200, 301, 401, 503])
@properties
@given(generated_status=st.integers(min_value=100, max_value=599), payload=st.text(max_size=80))
@example(generated_status=200, payload='{"status":"unhealthy"}')
def test_single_response_preserves_status_body_and_avoids_redirect(status, generated_status, payload):
    with private_case() as (tmp_path, monkeypatch):
        for status in (status, generated_status):
            calls = []
            class Connection:
                def __init__(self, host, port, timeout): calls.append((host, port))
                def connect(self): calls.append("connect")
                def request(self, method, path, headers):
                    assert method == "GET" and path == "/health"
                    assert headers == {"Authorization": "Bearer synthetic"}
                def getresponse(self): return self
                def read(self, limit): assert limit == 65537; return payload.encode('utf-8')
                def close(self): calls.append("closed")
            Connection.status = status
            monkeypatch.setattr("http.client.HTTPConnection", Connection)
            monkeypatch.setenv("http_proxy", "http://invalid.example")
            assert reader.fetch_loopback_health(9999, "/health", {"Authorization":"Bearer synthetic"}) == (status, payload)
            assert calls == [("127.0.0.1", 9999), "connect", "closed"]


@pytest.mark.parametrize("body", [b"x" * 65537, b"\xff"])
def test_untrusted_response_is_not_truncated_into_valid_health(monkeypatch, body):
    class Connection:
        def __init__(self, *args, **kwargs): pass
        def connect(self): pass
        def request(self, *args, **kwargs): pass
        def getresponse(self): return self
        def read(self, limit): return body
        def close(self): pass
        status = 200
    monkeypatch.setattr("http.client.HTTPConnection", Connection)
    with pytest.raises(ValueError): reader.fetch_loopback_health(9999, "/health", {})


@pytest.mark.parametrize("item", [
    {"status": True, "body": "ok"}, {"status": "200", "body": "ok"},
    {"status": 200, "body": []}, {"status": 200, "body": "x" * 65537},
    {"stage": "connect", "errno": "49"}, {"stage": "connect", "errno": True},
    {"stage": "unknown", "errno": errno.EADDRNOTAVAIL}, {"exception": "EADDRNOTAVAIL 49"},
])
def test_invalid_helper_result_never_authorizes_action(tmp_path, item):
    proc, calls, log, _ = _run(tmp_path, item, FLEET_OK)
    assert proc.returncode == 2
    assert "kickstart" not in calls
    assert "private" not in log + proc.stderr


@pytest.mark.parametrize("number", [errno.ETIMEDOUT, None])
def test_generic_transport_failure_is_not_address_exhaustion(tmp_path, number):
    proc, calls, log, _ = _run(tmp_path, {"stage":"connect", "errno":number}, FLEET_OK)
    assert proc.returncode == 0
    assert "kickstart" in calls
    assert "EADDRNOTAVAIL" not in log
