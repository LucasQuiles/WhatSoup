"""Tests for the shared fleet-roster identity/inventory helper.

The producer (sentinel heartbeat) and the independent watchdog both derive the
roster digest, epoch, and expected counts from this module, so the watchdog's
expectation is computed independently of the value the sentinel declares.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest


_LIB = Path(__file__).resolve().parents[1] / "lib" / "bot_errors_roster.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_roster", _LIB)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _roster(hosts: list[dict]) -> dict:
    return {"schemaVersion": 1, "description": "test", "hosts": hosts}


_SAMPLE = _roster(
    [
        {
            "host": "host-a",
            "role": "bot-host",
            "collectorRemote": True,
            "instances": [
                {"name": "bot1", "expected": "always_on", "service": "svc-bot1"},
                {"name": "bot2", "expected": "always_on", "service": "svc-bot2"},
            ],
        },
        {
            "host": "host-b",
            "role": "relay-only",
            "collectorRemote": True,
            "instances": [{"name": "agent", "expected": "none"}],
        },
        {
            "host": "host-c",
            "role": "central",
            "collectorRemote": False,
            "instances": [{"name": "svc-x", "expected": "always_on", "service": "svc-central"}],
        },
    ]
)


def test_roster_inventory_counts_hosts_and_runtime_instances():
    inv = _mod.roster_inventory(_SAMPLE)
    assert inv["expectedHostCount"] == 3
    assert inv["expectedHosts"] == ["host-a", "host-b", "host-c"]
    # runtime-relevant instances exclude expected == "none" (host-b agent).
    assert inv["expectedInstanceCount"] == 3
    assert inv["runtimeInstancesByHost"] == {"host-a": 2, "host-c": 1}
    assert inv["collectorRemoteHosts"] == ["host-a", "host-b"]
    assert inv["collectorRemoteHostCount"] == 2
    assert len(inv["digest"]) == 64
    int(inv["digest"], 16)  # hex


def test_roster_digest_is_order_independent_but_membership_sensitive():
    reordered = _roster(list(reversed(_SAMPLE["hosts"])))
    assert _mod.roster_digest(reordered) == _mod.roster_digest(_SAMPLE)
    # Dropping a host (truncation) changes the digest.
    truncated = _roster(_SAMPLE["hosts"][:1])
    assert _mod.roster_digest(truncated) != _mod.roster_digest(_SAMPLE)
    # Cosmetic-only edits (description) do NOT change the digest.
    cosmetic = dict(_SAMPLE)
    cosmetic["description"] = "totally different prose"
    assert _mod.roster_digest(cosmetic) == _mod.roster_digest(_SAMPLE)


def test_roster_digest_privacy_safe_is_opaque_hash():
    digest = _mod.roster_digest(_SAMPLE)
    # No raw host identifier leaks into the digest string.
    for host in ("host-a", "host-b", "host-c"):
        assert host not in digest


def test_load_roster_reads_and_computes(tmp_path: Path):
    path = tmp_path / "roster.json"
    path.write_text(json.dumps(_SAMPLE), encoding="utf-8")
    data, inv = _mod.load_roster(path)
    assert data["schemaVersion"] == 1
    assert inv["expectedHostCount"] == 3
    assert _mod.roster_epoch(path) == int(path.stat().st_mtime)


def test_load_roster_fails_closed(tmp_path: Path):
    with pytest.raises(_mod.RosterError):
        _mod.load_roster(tmp_path / "missing.json")
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    with pytest.raises(_mod.RosterError):
        _mod.load_roster(bad)
    array = tmp_path / "array.json"
    array.write_text("[]", encoding="utf-8")
    with pytest.raises(_mod.RosterError):
        _mod.load_roster(array)


def test_default_roster_path_resolves_canonical_and_env(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))  # no private roster
    monkeypatch.delenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", raising=False)
    assert _mod.default_roster_path() == _mod._repo_root() / "deploy" / "bot-errors-expected-fleet.json"
    override = tmp_path / "private-roster.json"
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", str(override))
    assert _mod.default_roster_path() == override


# --------------------------------------------------------------------------
# Resolver order (lib/fleet_config.py): BOT_ERRORS_FLEET_SENTINEL_HOSTS ->
# ~/.config/whatsoup/bot-errors-expected-fleet.json -> tracked copy -> fail.
# --------------------------------------------------------------------------


@pytest.fixture
def isolated(monkeypatch, tmp_path: Path) -> dict:
    home = tmp_path / "home"
    repo = tmp_path / "repo"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", raising=False)
    monkeypatch.setattr(_mod, "_repo_root", lambda: repo)
    return {
        "private": home / ".config" / "whatsoup" / "bot-errors-expected-fleet.json",
        "tracked": repo / "deploy" / "bot-errors-expected-fleet.json",
    }


def _write_roster(path: Path, payload) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")
    return path


def _one_host(host: str) -> dict:
    return _roster([{"host": host, "role": "bot-host", "instances": []}])


def test_private_roster_present_is_used(isolated):
    _write_roster(isolated["private"], _one_host("host-a"))
    _write_roster(isolated["tracked"], _one_host("host-b"))

    assert _mod.default_roster_path() == isolated["private"]
    _data, inv = _mod.load_roster()
    assert inv["expectedHosts"] == ["host-a"]
    assert _mod.roster_epoch() == int(isolated["private"].stat().st_mtime)


def test_private_roster_missing_uses_tracked(isolated):
    _write_roster(isolated["tracked"], _one_host("host-b"))

    _data, inv = _mod.load_roster()
    assert inv["expectedHosts"] == ["host-b"]


def test_no_roster_anywhere_fails_naming_paths_and_order(isolated):
    with pytest.raises(_mod.RosterError) as info:
        _mod.load_roster()

    message = str(info.value)
    assert "fleet roster missing" in message
    assert str(isolated["private"]) in message
    assert str(isolated["tracked"]) in message
    assert "resolver order: 1) env BOT_ERRORS_FLEET_SENTINEL_HOSTS 2) private" in message
    with pytest.raises(_mod.RosterError, match="resolver order"):
        _mod.default_roster_path()
    assert _mod.roster_epoch() is None


def test_env_roster_missing_does_not_fall_through(isolated, monkeypatch, tmp_path: Path):
    _write_roster(isolated["private"], _one_host("host-a"))
    _write_roster(isolated["tracked"], _one_host("host-b"))
    missing = tmp_path / "gone-roster.json"
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", str(missing))

    with pytest.raises(_mod.RosterError) as info:
        _mod.load_roster()

    message = str(info.value)
    assert f"fleet roster missing: {missing}" in message
    assert "BOT_ERRORS_FLEET_SENTINEL_HOSTS is set, so later sources were not tried" in message


def test_invalid_private_roster_does_not_fall_through(isolated):
    _write_roster(isolated["private"], "{not json")
    _write_roster(isolated["tracked"], _one_host("host-b"))

    with pytest.raises(_mod.RosterError, match="fleet roster is not valid JSON"):
        _mod.load_roster()


def test_non_object_roster_fails(isolated):
    _write_roster(isolated["tracked"], "[]")

    with pytest.raises(_mod.RosterError, match="is not a JSON object"):
        _mod.load_roster()


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads mode-000 files")
def test_unreadable_private_roster_does_not_fall_through(isolated):
    private = _write_roster(isolated["private"], _one_host("host-a"))
    _write_roster(isolated["tracked"], _one_host("host-b"))
    private.chmod(0)
    try:
        with pytest.raises(_mod.RosterError, match=r"unreadable \(PermissionError\)"):
            _mod.load_roster()
    finally:
        private.chmod(0o600)


def test_structurally_invalid_resolved_roster_fails(isolated):
    _write_roster(isolated["private"], {"schemaVersion": 1, "hosts": [{"role": "bot-host"}]})

    with pytest.raises(_mod.RosterError, match="missing host"):
        _mod.load_roster()


def test_real_canonical_roster_is_loadable_and_nonzero():
    path = _mod.default_roster_path()
    data, inv = _mod.load_roster(path)
    assert inv["expectedHostCount"] > 0
    assert inv["expectedInstanceCount"] > 0
    assert inv["collectorRemoteHostCount"] > 0
