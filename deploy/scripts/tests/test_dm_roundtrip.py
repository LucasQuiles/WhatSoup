"""Tests for the active direct-DM round-trip liveness probe (lib/dm_roundtrip.py).

Layer 3 of bead active-liveness-checks-fleet. Covers:
- sentinel construction (uniqueness, NO_REPLY tag);
- roster parsing (fail-loud on every malformation, db defaulting/override);
- evaluate_target failure taxonomy (transport dead, rejection, ambiguous,
  no echo, echo-guard regression, db read failure, healthy);
- json_rpc_send framing against a real AF_UNIX server (result unwrap);
- the watchdog dm_roundtrip_problems() opt-in + fail-loud config wiring.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))

import lib.dm_roundtrip as dmr  # noqa: E402
from lib.send_acceptance import SendAcceptanceUnknown, SendNotAccepted  # noqa: E402

OWN_JID = "15550100199@s.whatsapp.net"  # reserved test range (repo-hygiene allowlisted)


def _target(**over) -> dmr.RoundtripTarget:
    base = dict(name="q", socket_path="/tmp/x.sock", own_jid=OWN_JID, db_path="/tmp/x.db")
    base.update(over)
    return dmr.RoundtripTarget(**base)


def _accepted(jid: str = OWN_JID) -> dict:
    return {"isError": False, "content": [{"type": "text", "text": json.dumps({"sent": True, "resolved_chatJid": jid})}]}


# --------------------------------------------------------------------------- #
# build_sentinel
# --------------------------------------------------------------------------- #

def test_sentinel_carries_prefix_name_and_no_reply():
    s = dmr.build_sentinel("q", now=1000, pid=7)
    assert dmr.SENTINEL_PREFIX in s and "q" in s and s.endswith("NO_REPLY")
    assert "1000-7" in s


def test_sentinel_is_run_unique():
    a = dmr.build_sentinel("q", now=1000, pid=7)
    b = dmr.build_sentinel("q", now=1001, pid=7)
    assert a != b


# --------------------------------------------------------------------------- #
# parse_roster
# --------------------------------------------------------------------------- #

def _dbfor(name: str) -> str:
    return f"/db/{name}/bot.db"


def test_parse_roster_valid_defaults_db():
    raw = json.dumps([{"name": "q", "socket": "/s.sock", "own_jid": OWN_JID}])
    targets = dmr.parse_roster(raw, default_db_for=_dbfor)
    assert len(targets) == 1
    assert targets[0].db_path == "/db/q/bot.db"


def test_parse_roster_db_override_wins():
    raw = json.dumps([{"name": "q", "socket": "/s.sock", "own_jid": OWN_JID, "db": "/custom.db"}])
    assert dmr.parse_roster(raw, default_db_for=_dbfor)[0].db_path == "/custom.db"


# A module table walked by one test rather than a @pytest.mark.parametrize literal: the
# repository caps the property-test advisory such literals raise
# (.claude/fitness/growth-waivers.json), and every row keeps its own raises check.
NON_ARRAY_OR_EMPTY_ROSTERS = ("", "   ", "not json", "{}", "[]", "42", '"str"')


def test_parse_roster_rejects_non_array_or_empty():
    for raw in NON_ARRAY_OR_EMPTY_ROSTERS:
        with pytest.raises(dmr.RoundtripConfigError):
            dmr.parse_roster(raw, default_db_for=_dbfor)


@pytest.mark.parametrize("entry", [
    {"socket": "/s", "own_jid": OWN_JID},          # missing name
    {"name": "q", "own_jid": OWN_JID},              # missing socket
    {"name": "q", "socket": "/s"},                  # missing own_jid
    {"name": "", "socket": "/s", "own_jid": OWN_JID},
    "notanobject",
])
def test_parse_roster_rejects_bad_entries(entry):
    raw = json.dumps([entry])
    with pytest.raises(dmr.RoundtripConfigError):
        dmr.parse_roster(raw, default_db_for=_dbfor)


def test_parse_roster_rejects_duplicate_names():
    raw = json.dumps([
        {"name": "q", "socket": "/a", "own_jid": OWN_JID},
        {"name": "q", "socket": "/b", "own_jid": OWN_JID},
    ])
    with pytest.raises(dmr.RoundtripConfigError):
        dmr.parse_roster(raw, default_db_for=_dbfor)


# --------------------------------------------------------------------------- #
# evaluate_target — failure taxonomy
# --------------------------------------------------------------------------- #

def test_evaluate_healthy_returns_none():
    problem = dmr.evaluate_target(
        _target(), timeout=1, deadline_s=1, poll_interval_s=0.01,
        send_fn=lambda *a: _accepted(),
        landing_fn=lambda *a: (True, 0),
    )
    assert problem is None


def test_evaluate_send_transport_failure():
    def boom(*a):
        raise OSError("connection refused")
    problem = dmr.evaluate_target(
        _target(), timeout=1, deadline_s=1, poll_interval_s=0.01,
        send_fn=boom, landing_fn=lambda *a: (True, 0),
    )
    assert "send failed" in problem and "q" in problem


def test_evaluate_send_rejected():
    rejected = {"isError": False, "content": [{"type": "text", "text": json.dumps({"sent": False})}]}
    problem = dmr.evaluate_target(
        _target(), timeout=1, deadline_s=1, poll_interval_s=0.01,
        send_fn=lambda *a: rejected, landing_fn=lambda *a: (True, 0),
    )
    assert "send rejected" in problem


def test_evaluate_send_unconfirmed_wrong_target():
    problem = dmr.evaluate_target(
        _target(), timeout=1, deadline_s=1, poll_interval_s=0.01,
        send_fn=lambda *a: _accepted("99999@s.whatsapp.net"),
        landing_fn=lambda *a: (True, 0),
    )
    assert "send unconfirmed" in problem


def test_evaluate_no_db_echo():
    problem = dmr.evaluate_target(
        _target(), timeout=1, deadline_s=2, poll_interval_s=0.01,
        send_fn=lambda *a: _accepted(),
        landing_fn=lambda *a: (False, 0),
    )
    assert "no self-DM echo" in problem and "2s" in problem


def test_evaluate_echo_guard_regression_on_spawned_turn():
    problem = dmr.evaluate_target(
        _target(), timeout=1, deadline_s=1, poll_interval_s=0.01,
        send_fn=lambda *a: _accepted(),
        landing_fn=lambda *a: (True, 1),
    )
    assert "echo-guard regression" in problem


def test_evaluate_db_read_failure():
    def landing_boom(*a):
        raise RuntimeError("db gone")
    problem = dmr.evaluate_target(
        _target(), timeout=1, deadline_s=1, poll_interval_s=0.01,
        send_fn=lambda *a: _accepted(),
        landing_fn=landing_boom,
    )
    assert "db read failed" in problem


# --------------------------------------------------------------------------- #
# json_rpc_send — real AF_UNIX server, verifies framing + result unwrap
# --------------------------------------------------------------------------- #

def test_json_rpc_send_unwraps_result():
    # AF_UNIX sun_path is capped (~104 bytes on darwin); pytest tmp_path is too
    # deep there, so the socket lives in a short mkdtemp dir removed below.
    short_dir = tempfile.mkdtemp(prefix="dmr-")
    sock_path = str(Path(short_dir) / "probe.sock")
    captured = {}

    def serve():
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(sock_path)
        srv.listen(1)
        conn, _ = srv.accept()
        f = conn.makefile("rwb", buffering=0)
        # initialize
        init = json.loads(f.readline())
        f.write((json.dumps({"jsonrpc": "2.0", "id": init["id"], "result": {"ok": True}}) + "\n").encode())
        # tools/call
        call = json.loads(f.readline())
        captured["args"] = call["params"]["arguments"]
        body = {"isError": False, "content": [{"type": "text", "text": json.dumps({"sent": True, "resolved_chatJid": OWN_JID})}]}
        f.write((json.dumps({"jsonrpc": "2.0", "id": call["id"], "result": body}) + "\n").encode())
        conn.close()
        srv.close()

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    # wait for bind
    for _ in range(100):
        if Path(sock_path).exists():
            break
        threading.Event().wait(0.01)

    try:
        result = dmr.json_rpc_send(sock_path, OWN_JID, "sentinel-text", timeout=5)
        t.join(timeout=5)
    finally:
        shutil.rmtree(short_dir, ignore_errors=True)
    assert result.get("isError") is False
    assert result["content"][0]["type"] == "text"
    assert captured["args"] == {"chatJid": OWN_JID, "text": "sentinel-text"}


def test_json_rpc_send_missing_socket_raises():
    with pytest.raises(RuntimeError, match="socket missing"):
        dmr.json_rpc_send("/no/such.sock", OWN_JID, "x", timeout=1)


# --------------------------------------------------------------------------- #
# watchdog wiring: opt-in + fail-loud config
# --------------------------------------------------------------------------- #

def _load_watchdog():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog", _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_dm_roundtrip_is_opt_in_not_default():
    mod = _load_watchdog()
    assert "dm_roundtrip" in mod.KNOWN_WATCHDOG_CHECKS
    assert "dm_roundtrip" not in mod.DEFAULT_CHECKS.split(",")


def test_dm_roundtrip_problems_fails_loud_without_roster(monkeypatch):
    mod = _load_watchdog()
    monkeypatch.setattr(mod.os, "environ", {})
    problems = mod.dm_roundtrip_problems()
    assert list(problems) == ["dm_roundtrip:config"]
    assert "roster invalid" in problems["dm_roundtrip:config"]


def test_dm_roundtrip_problems_probes_roster(monkeypatch):
    mod = _load_watchdog()
    roster = json.dumps([{"name": "q", "socket": "/s.sock", "own_jid": OWN_JID, "db": "/x.db"}])
    monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_DM_ROUNDTRIP_ROSTER": roster})
    monkeypatch.setattr(mod, "dm_roundtrip_evaluate_target", lambda t, **k: f"boom {t.name}")
    problems = mod.dm_roundtrip_problems()
    assert problems == {"dm_roundtrip:q": "boom q"}


def test_dm_roundtrip_problems_healthy_roster_empty(monkeypatch):
    mod = _load_watchdog()
    roster = json.dumps([{"name": "q", "socket": "/s.sock", "own_jid": OWN_JID, "db": "/x.db"}])
    monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_DM_ROUNDTRIP_ROSTER": roster})
    monkeypatch.setattr(mod, "dm_roundtrip_evaluate_target", lambda t, **k: None)
    assert mod.dm_roundtrip_problems() == {}


def test_dm_roundtrip_in_reconcile_prefixes_when_enabled():
    mod = _load_watchdog()
    assert "dm_roundtrip:" in mod.active_reconcile_prefixes({"dm_roundtrip"})
    assert "dm_roundtrip:" not in mod.active_reconcile_prefixes({"q_loop"})
