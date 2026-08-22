"""Health-port authority-drift classification (#2342).

Daily health (bot-errors-health-check.py ``config_inventory``) selects
``item.get("healthPort", data.get("healthPort"))`` — a health-profile value
OVERRIDES the port read from the live instance config, and that stale port is
then probed. When the two authorities disagree, the probe pages against the
wrong address (false endpoint-outage). These tests pin the fix: drift is
classified as a typed FAIL discriminator and the probe is inhibited; the
watchdog's identical predicate (``local_instance_health_problems``) gets the
same classification.

Loads the scripts via importlib (hyphen in filenames prevents normal import),
mirroring test_bot_errors_health_check_auth_bond.py.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def health_check():
    return _load(
        "bot_errors_health_check_port_authority",
        _SCRIPTS / "bot-errors-health-check.py",
    )


@pytest.fixture()
def watchdog():
    return _load(
        "bot_errors_watchdog_port_authority",
        _SCRIPTS / "bot-errors-heartbeat-watchdog.py",
    )


# ---------------------------------------------------------------------------
# Fixtures: synthetic instance tree + health profile
# ---------------------------------------------------------------------------

PROFILE_PORT = 4501
LIVE_PORT = 4567


def _make_instance_tree(tmp_path: Path, name: str, config: dict | None) -> Path:
    """Create <tmp>/.config/whatsoup/instances/<name>/config.json (when config
    is not None) — the path config_inventory derives from Path.home()."""
    root = tmp_path / ".config" / "whatsoup" / "instances"
    if config is not None:
        d = root / name
        d.mkdir(parents=True)
        (d / "config.json").write_text(json.dumps(config), encoding="utf-8")
    return root


def _profile(name: str, health_port: int | None) -> dict:
    item: dict = {"name": name, "expected": "always_on"}
    if health_port is not None:
        item["healthPort"] = health_port
    return {"instances": [item]}


class _ProbeRecorder:
    """Stand-in for probe_health: records (port, name) and returns a pass."""

    def __init__(self):
        self.calls: list[tuple[int, str | None]] = []

    def __call__(self, port: int, expected_name: str | None = None) -> str:
        self.calls.append((port, expected_name))
        return "health ok"


# ---------------------------------------------------------------------------
# Marker unit cases
# ---------------------------------------------------------------------------


def test_marker_none_when_either_side_missing(health_check):
    marker = health_check.health_port_authority_drift_marker
    assert marker(PROFILE_PORT, None) is None
    assert marker(None, LIVE_PORT) is None
    assert marker(None, None) is None


def test_marker_none_when_ports_agree(health_check):
    assert (
        health_check.health_port_authority_drift_marker(PROFILE_PORT, PROFILE_PORT)
        is None
    )


def test_marker_typed_discriminator_when_drift(health_check):
    got = health_check.health_port_authority_drift_marker(PROFILE_PORT, LIVE_PORT)
    assert got is not None
    assert got.startswith("health_port_authority_drift ")
    assert f"profile={PROFILE_PORT}" in got
    assert f"live={LIVE_PORT}" in got
    assert "authority=runtime_config" in got


# ---------------------------------------------------------------------------
# config_inventory behavior (monkeypatched home + recorded probe)
# ---------------------------------------------------------------------------


def _run_inventory(
    health_check, monkeypatch, tmp_path, config: dict | None, item: dict
):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    recorder = _ProbeRecorder()
    monkeypatch.setattr(health_check, "probe_health", recorder)
    lines = health_check.config_inventory({"instances": [item]})
    return lines, recorder.calls


def test_drift_emits_one_typed_fail_and_inhibits_probe(
    health_check, monkeypatch, tmp_path
):
    _make_instance_tree(tmp_path, "drifty", {"type": "chat", "healthPort": LIVE_PORT})
    lines, calls = _run_inventory(
        health_check,
        monkeypatch,
        tmp_path,
        {"type": "chat", "healthPort": LIVE_PORT},
        {"name": "drifty", "expected": "always_on", "healthPort": PROFILE_PORT},
    )
    drift = [ln for ln in lines if "health_port_authority_drift" in ln]
    assert len(drift) == 1, lines
    assert drift[0].startswith("FAIL config drifty:")
    assert f"profile={PROFILE_PORT}" in drift[0]
    assert f"live={LIVE_PORT}" in drift[0]
    assert "authority=runtime_config" in drift[0]
    # The misaddressed outage predicate is inhibited: no probe at all.
    assert calls == []
    assert not [ln for ln in lines if ln.startswith("health drifty:")]


def test_live_only_probes_live_port_without_drift(health_check, monkeypatch, tmp_path):
    _make_instance_tree(tmp_path, "liveonly", {"type": "chat", "healthPort": LIVE_PORT})
    lines, calls = _run_inventory(
        health_check,
        monkeypatch,
        tmp_path,
        {"type": "chat", "healthPort": LIVE_PORT},
        {"name": "liveonly", "expected": "always_on"},  # no profile port
    )
    assert not [ln for ln in lines if "health_port_authority_drift" in ln]
    assert calls == [(LIVE_PORT, "liveonly")]


def test_profile_only_probes_profile_port_tagged(health_check, monkeypatch, tmp_path):
    # No healthPort in live config: remote/profile-only asset policy.
    _make_instance_tree(tmp_path, "profileonly", {"type": "chat"})
    lines, calls = _run_inventory(
        health_check,
        monkeypatch,
        tmp_path,
        {"type": "chat"},
        {"name": "profileonly", "expected": "always_on", "healthPort": PROFILE_PORT},
    )
    assert not [ln for ln in lines if "health_port_authority_drift" in ln]
    assert calls == [(PROFILE_PORT, "profileonly")]
    assert "config profileonly: health_port authority=profile" in lines


def test_agreeing_authorities_probe_normally(health_check, monkeypatch, tmp_path):
    _make_instance_tree(tmp_path, "agreeing", {"type": "chat", "healthPort": LIVE_PORT})
    lines, calls = _run_inventory(
        health_check,
        monkeypatch,
        tmp_path,
        {"type": "chat", "healthPort": LIVE_PORT},
        {"name": "agreeing", "expected": "always_on", "healthPort": LIVE_PORT},
    )
    assert not [ln for ln in lines if "health_port_authority_drift" in ln]
    assert calls == [(LIVE_PORT, "agreeing")]


# ---------------------------------------------------------------------------
# Watchdog parity (same predicate, second probe surface)
# ---------------------------------------------------------------------------


def _run_watchdog_local(
    watchdog, monkeypatch, tmp_path, item: dict, config: dict | None
):
    root = _make_instance_tree(tmp_path, item["name"], config)
    monkeypatch.setattr(watchdog, "INSTANCE_CONFIG_ROOT", root)
    monkeypatch.setattr(watchdog, "expected_local_instances", lambda: [item])
    probed: list[tuple[str, int]] = []

    def fake_response(name: str, port: int):
        probed.append((name, port))
        return 200, '{"status":"healthy","instance":{"name":"%s"}}' % name, "url"

    monkeypatch.setattr(watchdog, "local_health_http_response", fake_response)
    return watchdog.local_instance_health_problems(), probed


def test_watchdog_drift_records_typed_problem_without_probing(
    watchdog, monkeypatch, tmp_path
):
    problems, probed = _run_watchdog_local(
        watchdog,
        monkeypatch,
        tmp_path,
        {"name": "drifty", "service": "whatsoup@drifty", "healthPort": PROFILE_PORT},
        {"type": "chat", "healthPort": LIVE_PORT},
    )
    assert probed == [], "stale profile port must not be probed"
    got = problems.get("local_health:drifty")
    assert got is not None
    assert "health_port_authority_drift" in got
    assert f"profile={PROFILE_PORT}" in got
    assert f"live={LIVE_PORT}" in got
    assert "authority=runtime_config" in got


def test_watchdog_agreement_probes_normally(watchdog, monkeypatch, tmp_path):
    problems, probed = _run_watchdog_local(
        watchdog,
        monkeypatch,
        tmp_path,
        {"name": "agreeing", "service": "whatsoup@agreeing", "healthPort": LIVE_PORT},
        {"type": "chat", "healthPort": LIVE_PORT},
    )
    assert probed == [("agreeing", LIVE_PORT)]
    # Orthogonal classification of the minimal synthetic body is out of scope
    # here; the #2342 contract is: agreement → probe runs, no drift problem.
    assert all("health_port_authority_drift" not in v for v in problems.values())
