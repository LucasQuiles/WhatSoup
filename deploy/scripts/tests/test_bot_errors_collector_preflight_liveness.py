"""Tests for preflight liveness-probe gating in bot-errors-collector.

Root cause of a correlated false-positive ``relay_host_down`` storm: the
preflight skipped ssh whenever the Tailscale control-plane ``Online`` flag read
False. That flag goes stale for idle peers holding a direct (LAN) path — the
whole relay fleet was flagged offline while every node answered ssh in <10ms.

Fix: a stale ``Online: false`` only skips ssh if a real liveness probe ALSO
fails. A node that answers a direct ping is reachable regardless of the flag.

Covered:
- offline flag + probe pong -> NOT unreachable (ssh proceeds).
- offline flag + probe miss -> unreachable (genuine down host).
- probe disabled (gate off OR empty ping command) -> conservative skip (old behaviour).
- probe subprocess error/timeout -> fail-closed (unreachable, no hang).
- Online: true -> reachable without probing.
- remote_liveness_probe_ok parses pong / rc correctly.
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"

_ENV_KEYS = [
    "BOT_ERRORS_PREFLIGHT_LIVENESS_PROBE",
    "BOT_ERRORS_TAILSCALE_PING_COMMAND",
    "BOT_ERRORS_TAILSCALE_PING_TIMEOUT_SECONDS",
]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_collector_preflight", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_OFFLINE = {"status": "found", "online": False, "hostName": "host-a"}
_ONLINE = {"status": "found", "online": True, "hostName": "host-a"}
# A peer summary as it appears in production: keyed by ssh alias, carrying the
# Tailscale IPs that ``tailscale ping`` can actually resolve.
_OFFLINE_WITH_IPS = {
    "status": "found",
    "online": False,
    "matched": "100.64.0.1",
    "hostName": "relay-host",
    "tailscaleIPs": ["100.64.0.1", "fd7a:115c:a1e0::1"],
}


def _pong(rc=0, out="pong from host-a (100.64.0.1) via 192.168.1.5:41641 in 1ms"):
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=out, stderr="")


# ---------------------------------------------------------------------------
# preflight_remote_unreachable
# ---------------------------------------------------------------------------

def test_offline_flag_but_probe_pongs_is_reachable():
    mod = _load()
    with patch.object(mod, "tailscale_peer_summary", return_value=dict(_OFFLINE)), \
         patch.object(mod.subprocess, "run", return_value=_pong()) as run:
        assert mod.preflight_remote_unreachable("host-a") is None
    run.assert_called_once()  # probe was actually attempted


def test_probe_pings_tailscale_ip_not_ssh_alias():
    """Regression: the probe must target the Tailscale IP, never the ssh alias.

    ``tailscale ping <alias>`` errors with ``looking up IP of "<alias>"``
    because the ssh alias is not Tailscale-resolvable — that fail-closed every
    probe and let the false-positive ``relay_host_down`` storm fire for days.
    The probe must hand ``tailscale ping`` the peer's Tailscale IPv4.
    """
    mod = _load()
    with patch.object(mod, "tailscale_peer_summary", return_value=dict(_OFFLINE_WITH_IPS)), \
         patch.object(mod.subprocess, "run", return_value=_pong()) as run:
        assert mod.preflight_remote_unreachable("relay-alias") is None
    cmd = run.call_args.args[0]
    assert "100.64.0.1" in cmd       # pinged the Tailscale IPv4
    assert "relay-alias" not in cmd  # never the unresolvable ssh alias


def test_probe_target_prefers_ipv4():
    mod = _load()
    assert mod.probe_target_for("relay-alias", _OFFLINE_WITH_IPS) == "100.64.0.1"
    # No IPs -> falls back to matched token, then host.
    assert mod.probe_target_for("host-a", {"matched": "host-a"}) == "host-a"
    assert mod.probe_target_for("host-a", {}) == "host-a"


def test_offline_flag_and_probe_miss_is_unreachable():
    mod = _load()
    with patch.object(mod, "tailscale_peer_summary", return_value=dict(_OFFLINE)), \
         patch.object(mod.subprocess, "run", return_value=_pong(rc=1, out="no pong")):
        result = mod.preflight_remote_unreachable("host-a")
    assert result is not None and result.get("online") is False


def test_gate_off_preserves_skip_on_offline():
    mod = _load()
    os.environ["BOT_ERRORS_PREFLIGHT_LIVENESS_PROBE"] = "0"
    with patch.object(mod, "tailscale_peer_summary", return_value=dict(_OFFLINE)), \
         patch.object(mod.subprocess, "run", return_value=_pong()) as run:
        result = mod.preflight_remote_unreachable("host-a")
    assert result is not None  # conservative skip
    run.assert_not_called()    # no probe when gate disabled


def test_empty_ping_command_disables_probe():
    mod = _load()
    os.environ["BOT_ERRORS_TAILSCALE_PING_COMMAND"] = ""
    with patch.object(mod, "tailscale_peer_summary", return_value=dict(_OFFLINE)), \
         patch.object(mod.subprocess, "run", return_value=_pong()) as run:
        result = mod.preflight_remote_unreachable("host-a")
    assert result is not None
    run.assert_not_called()


def test_probe_timeout_fails_closed():
    mod = _load()
    with patch.object(mod, "tailscale_peer_summary", return_value=dict(_OFFLINE)), \
         patch.object(mod.subprocess, "run", side_effect=subprocess.TimeoutExpired(cmd="tailscale", timeout=4)):
        result = mod.preflight_remote_unreachable("host-a")
    assert result is not None and result.get("online") is False


def test_online_peer_skips_probe_and_is_reachable():
    mod = _load()
    with patch.object(mod, "tailscale_peer_summary", return_value=dict(_ONLINE)), \
         patch.object(mod.subprocess, "run", return_value=_pong()) as run:
        assert mod.preflight_remote_unreachable("host-a") is None
    run.assert_not_called()  # Online: true needs no probe


# ---------------------------------------------------------------------------
# remote_liveness_probe_ok
# ---------------------------------------------------------------------------

def test_probe_ok_on_pong():
    mod = _load()
    with patch.object(mod.subprocess, "run", return_value=_pong()):
        assert mod.remote_liveness_probe_ok("host-a") is True


def test_probe_not_ok_without_pong():
    mod = _load()
    with patch.object(mod.subprocess, "run", return_value=_pong(rc=0, out="timed out")):
        assert mod.remote_liveness_probe_ok("host-a") is False


def test_probe_not_ok_on_oserror():
    mod = _load()
    with patch.object(mod.subprocess, "run", side_effect=OSError("no tailscale binary")):
        assert mod.remote_liveness_probe_ok("host-a") is False
