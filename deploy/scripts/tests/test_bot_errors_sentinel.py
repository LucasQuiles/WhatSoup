"""Tests for the central Fleet Runtime Sentinel evaluator.

All fixtures are scratch files. Pull probes are injected; no SSH or host access
is performed.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-sentinel.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_sentinel", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _load_roster_lib():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_roster", Path(__file__).resolve().parents[1] / "lib" / "bot_errors_roster.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_roster_lib = _load_roster_lib()


def _write_json(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _heartbeat(path: Path, *, healthy: bool = True, klass: str = "healthy", mtime: float = 1000.0, checked_at: str | None = None) -> Path:
    payload = {
        "kind": "bot-errors-selfcheck-heartbeat",
        "host": path.stem,
        "healthy": healthy,
        "class": klass,
        "action": "noop" if healthy else "hysteresis_wait",
        "pin": {"headSha": "a" * 40, "f10Sha": "b" * 64},
    }
    if checked_at is not None:
        payload["checkedAt"] = checked_at
    _write_json(path, payload)
    os.utime(path, (mtime, mtime))
    return path


def _hosts_file(tmp_path: Path, hosts: list[dict]) -> Path:
    return _write_json(tmp_path / "hosts.json", {"schemaVersion": 1, "hosts": hosts})


def _config(tmp_path: Path, hosts_path: Path, **kwargs):
    return _mod.SentinelConfig(
        state_dir=tmp_path / "state",
        hosts_path=hosts_path,
        oracle_path=kwargs.get("oracle_path"),
        action_outbox_dir=kwargs.get("action_outbox_dir", tmp_path / "state" / "actions"),
        action_outbox_retention=kwargs.get("action_outbox_retention", 500),
        heartbeat_max_age_seconds=kwargs.get("heartbeat_max_age_seconds", 60),
        hysteresis_cycles=kwargs.get("hysteresis_cycles", 2),
        connectivity_hysteresis_cycles=kwargs.get("connectivity_hysteresis_cycles", 3),
        flap_window_seconds=kwargs.get("flap_window_seconds", 300),
        flap_threshold=kwargs.get("flap_threshold", 4),
        max_tier1_heal_candidates=kwargs.get("max_tier1_heal_candidates", 2),
        correlated_drift_freeze_threshold=kwargs.get("correlated_drift_freeze_threshold", 2),
        max_clock_skew_seconds=kwargs.get("max_clock_skew_seconds", 300),
        action_event_cooldown_seconds=kwargs.get("action_event_cooldown_seconds", 3600),
        max_critical_whatsapp_per_day=kwargs.get("max_critical_whatsapp_per_day", 8),
        tier2_token_ttl_seconds=kwargs.get("tier2_token_ttl_seconds", 1800),
        q_host=kwargs.get("q_host", "q-agent-host"),
    )


def _deps(now: float, probes: dict[str, dict], oracle: dict | None = None):
    return _mod.SentinelDeps(
        now_epoch=lambda: now,
        hostname=lambda: "central-test",
        pull_probe=lambda spec, *_: probes.get(spec.host, {}),
        reachability_oracle=lambda: oracle or {"configured": False, "reachable": True, "class": "not_configured"},
    )


def test_load_hosts_validates_schema_and_duplicates(tmp_path: Path):
    good = _hosts_file(
        tmp_path,
        [
            {"host": "host-a", "role": "runtime", "heartbeatPath": str(tmp_path / "host-a.json")},
            {
                "host": "host-z",
                "probePath": str(tmp_path / "probe.json"),
                "ackPath": str(tmp_path / "ack.json"),
                "sshHost": "host-z.example",
                "root": str(tmp_path / "runtime"),
                "python": "/opt/python/bin/python3",
            },
        ],
    )
    hosts = _mod.load_hosts(good)
    assert [host.host for host in hosts] == ["host-a", "host-z"]
    assert hosts[0].role == "runtime"
    assert hosts[1].ack_path == tmp_path / "ack.json"
    assert hosts[1].ssh_host == "host-z.example"
    assert hosts[1].root == tmp_path / "runtime"
    assert hosts[1].python == "/opt/python/bin/python3"

    bad_schema = _write_json(tmp_path / "bad-schema.json", {"schemaVersion": 2, "hosts": []})
    with pytest.raises(_mod.SentinelError, match="schemaVersion"):
        _mod.load_hosts(bad_schema)

    duplicate = _hosts_file(tmp_path / "dupe", [{"host": "host-a"}, {"host": "host-a"}])
    with pytest.raises(_mod.SentinelError, match="duplicate host"):
        _mod.load_hosts(duplicate)

    empty = _write_json(tmp_path / "empty.json", {"schemaVersion": 1, "hosts": []})
    with pytest.raises(_mod.SentinelError, match="non-empty hosts"):
        _mod.load_hosts(empty)

    non_object = _write_json(tmp_path / "non-object-host.json", {"schemaVersion": 1, "hosts": ["host-a"]})
    with pytest.raises(_mod.SentinelError, match=r"hosts\[0\] must be an object"):
        _mod.load_hosts(non_object)

    missing_host = _write_json(tmp_path / "missing-host.json", {"schemaVersion": 1, "hosts": [{"role": "runtime"}]})
    with pytest.raises(_mod.SentinelError, match=r"hosts\[0\] requires host"):
        _mod.load_hosts(missing_host)

    malformed_fields = [
        ("host", True),
        ("role", True),
        ("heartbeatPath", True),
        ("probePath", 123),
        ("ackPath", True),
        ("sshHost", True),
        ("root", True),
        ("python", True),
    ]
    for field, value in malformed_fields:
        payload = {"host": "host-a", field: value}
        if field == "host":
            payload = {field: value}
        bad = _write_json(tmp_path / f"bad-{field}.json", {"schemaVersion": 1, "hosts": [payload]})
        with pytest.raises(_mod.SentinelError, match=rf"hosts\[0\]\.{field} must be a string"):
            _mod.load_hosts(bad)


def test_expected_fleet_roster_derives_heartbeat_and_ack_paths(tmp_path: Path):
    roster = _write_json(
        tmp_path / "expected-fleet.json",
        {
            "schemaVersion": 1,
            "hosts": [
                {
                    "host": "host-a",
                    "role": "bot-host",
                    "profile": "host-a.json",
                    "collectorRemote": True,
                    "instances": [],
                },
                {
                    "host": "host-b",
                    "role": "central",
                    "profile": "host-b.json",
                    "heartbeatPath": str(tmp_path / "explicit-heartbeat.json"),
                    "ackPath": str(tmp_path / "explicit-ack.json"),
                    "instances": [],
                },
            ],
        },
    )
    state = tmp_path / "fleet-sentinel"

    hosts = _mod.load_hosts(roster, state)

    assert [host.host for host in hosts] == ["host-a", "host-b"]
    assert hosts[0].role == "bot-host"
    assert hosts[0].heartbeat_path == state / "heartbeats" / "host-a.json"
    assert hosts[0].ack_path == state / "acks" / "host-a.json"
    assert hosts[0].probe_path is None
    assert hosts[0].ssh_host is None
    assert hosts[0].root is None
    assert hosts[1].heartbeat_path == tmp_path / "explicit-heartbeat.json"
    assert hosts[1].ack_path == tmp_path / "explicit-ack.json"


def test_default_hosts_path_reuses_expected_fleet_manifest(monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", raising=False)

    path = _mod.default_hosts_path()

    assert path == _mod.REPO_ROOT / "deploy" / "bot-errors-expected-fleet.json"


def test_json_and_atomic_helpers_fail_closed(tmp_path: Path, monkeypatch):
    with pytest.raises(_mod.SentinelError, match="missing JSON file"):
        _mod.read_json_object(tmp_path / "missing.json")

    bad = tmp_path / "bad.json"
    bad.write_text("{bad", encoding="utf-8")
    with pytest.raises(_mod.SentinelError, match="JSONDecodeError"):
        _mod.read_json_object(bad)

    array = tmp_path / "array.json"
    array.write_text("[]", encoding="utf-8")
    with pytest.raises(_mod.SentinelError, match="must contain an object"):
        _mod.read_json_object(array)

    def chmod(path: Path, mode: int) -> None:
        raise OSError("chmod denied")

    monkeypatch.setattr(Path, "chmod", chmod)
    _mod.ensure_private_dir(tmp_path / "private")
    ok_target = tmp_path / "state" / "ok.json"
    _mod.atomic_write_json(ok_target, {"ok": True})
    assert json.loads(ok_target.read_text(encoding="utf-8")) == {"ok": True}

    def replace(_src, _dst):
        raise RuntimeError("replace failed")

    monkeypatch.setattr(_mod.os, "replace", replace)
    target = tmp_path / "state" / "payload.json"
    with pytest.raises(RuntimeError):
        _mod.atomic_write_json(target, {"ok": True})
    assert list(target.parent.glob(".payload.json.*.tmp")) == []

    original_unlink = Path.unlink

    def unlink(path: Path):
        if path.name.startswith(".unlink-fail.json."):
            raise OSError("unlink denied")
        original_unlink(path)

    monkeypatch.setattr(Path, "unlink", unlink)
    unlink_fail = tmp_path / "state" / "unlink-fail.json"
    with pytest.raises(RuntimeError):
        _mod.atomic_write_json(unlink_fail, {"ok": True})

    def open_error(*_args, **_kwargs):
        raise OSError("open denied")

    monkeypatch.setattr(_mod.os, "open", open_error)
    _mod.fsync_parent(tmp_path / "missing-parent" / "payload.json")


def test_healthy_host_writes_ack_and_resets_open_state(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=1000.0)
    ack = tmp_path / "acks" / "host-a.json"
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb), "ackPath": str(ack)}])
    config = _config(tmp_path, hosts)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {"schemaVersion": 1, "hosts": {"host-a": {"alertState": "open", "lastClass": "out_of_rotation", "consecutive": 2}}},
    )
    result = _mod.run_once(config, _deps(1010.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))
    host = result["hosts"][0]
    assert host["class"] == "healthy"
    assert host["action"] == "clear"
    assert host["alertState"] == "closed"
    assert json.loads(ack.read_text(encoding="utf-8"))["centralAction"] == "clear"
    assert len(result["actionEvents"]) == 1
    event = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    assert event["scope"] == "host"
    assert event["action"] == "clear"
    assert event["lane"] == "resolved_state_change"
    assert event["criticalWhatsAppEligible"] is False
    heartbeat = json.loads((_mod.heartbeat_path(config)).read_text(encoding="utf-8"))
    assert heartbeat == {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-heartbeat",
        "checkedAt": result["checkedAt"],
        "controllerHost": "central-test",
        "healthy": True,
        "fleetAction": "none",
        "hostCount": 1,
        "problemHostCount": 0,
        "rosterDigest": _roster_lib.roster_digest({"schemaVersion": 1, "hosts": [{"host": "host-a", "heartbeatPath": str(hb), "ackPath": str(ack)}]}),
        "rosterEpoch": int(hosts.stat().st_mtime),
        "expectedHostCount": 1,
        "observedHostCount": 1,
        "unknownHostCount": 0,
        "expectedInstanceCount": 0,
        "observedInstanceCount": 0,
        "problemInstanceCount": 0,
        "unknownInstanceCount": 0,
        "metrics": {
            "hostsEvaluated": 1,
            "healCandidates": 0,
            "escalations": 0,
            "flapEscalations": 0,
            "correlatedDriftFreezes": 0,
            "concurrencyDeferrals": 0,
            "massUnreachableDeferrals": 0,
            "connectivitySuppressions": 0,
            "qUnavailable": 0,
            "actionEventsEmitted": 1,
            "attentionEventsEmitted": 0,
            "byAction": {"clear": 1},
        },
    }
    assert host["ackPath"] == str(ack)
    assert result["heartbeatPath"] == str(_mod.heartbeat_path(config))
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["hosts"]["host-a"]["alertState"] == "closed"


def test_ack_write_failure_is_reported_without_aborting_run(tmp_path: Path, monkeypatch):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=1000.0)
    ack = tmp_path / "acks" / "host-a.json"
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb), "ackPath": str(ack)}])
    config = _config(tmp_path, hosts)
    original_atomic_write_json = _mod.atomic_write_json

    def atomic_write_json(path: Path, payload: dict) -> None:
        if path == ack:
            raise OSError("ack denied")
        original_atomic_write_json(path, payload)

    monkeypatch.setattr(_mod, "atomic_write_json", atomic_write_json)

    result = _mod.run_once(config, _deps(1010.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))

    host = result["hosts"][0]
    assert host["class"] == "healthy"
    assert host["action"] == "noop"
    assert host["ackError"] == "OSError: ack denied"
    assert "ackPath" not in host
    heartbeat = json.loads((_mod.heartbeat_path(config)).read_text(encoding="utf-8"))
    assert heartbeat["healthy"] is False
    assert heartbeat["problemHostCount"] == 1
    assert _mod.result_requires_attention(result) is True


def test_two_signal_unreachable_requires_hysteresis_then_escalates(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-h-hb.json", healthy=True, mtime=100.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-h", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1, connectivity_hysteresis_cycles=3)
    deps = _deps(1000.0, {"host-h": {"reachable": False, "healthy": False, "class": "unreachable"}})

    first = _mod.run_once(config, deps)["hosts"][0]
    assert first["class"] == "out_of_rotation"
    assert first["twoSignals"] is True
    assert first["action"] == "hysteresis_wait"

    second = _mod.run_once(config, deps)["hosts"][0]
    assert second["consecutive"] == 2
    assert second["action"] == "hysteresis_wait"

    third = _mod.run_once(config, deps)["hosts"][0]
    assert third["consecutive"] == 3
    assert third["action"] == "escalate"
    assert third["alertState"] == "open"


def test_invariant_failures_still_use_two_cycle_hysteresis(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-i-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-i", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=2, connectivity_hysteresis_cycles=3)
    deps = _deps(1000.0, {"host-i": {"reachable": True, "healthy": False, "class": "permission_denied"}})

    first = _mod.run_once(config, deps)["hosts"][0]
    assert first["action"] == "hysteresis_wait"

    second = _mod.run_once(config, deps)["hosts"][0]
    assert second["consecutive"] == 2
    assert second["action"] == "escalate"
    assert second["alertState"] == "open"


def test_single_signal_failures_monitor_only(tmp_path: Path):
    stale = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=100.0)
    fresh = _heartbeat(tmp_path / "host-b-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(
        tmp_path,
        [
            {"host": "host-a", "heartbeatPath": str(stale)},
            {"host": "host-b", "heartbeatPath": str(fresh)},
        ],
    )
    result = _mod.run_once(
        _config(tmp_path, hosts, hysteresis_cycles=1),
        _deps(
            1000.0,
            {
                "host-a": {"reachable": True, "healthy": True, "class": "healthy"},
                "host-b": {"reachable": False, "healthy": False, "class": "unreachable"},
            },
        ),
    )
    by_host = {item["host"]: item for item in result["hosts"]}
    assert by_host["host-a"]["class"] == "heartbeat_stale"
    assert by_host["host-a"]["action"] == "monitor_only"
    assert by_host["host-b"]["class"] == "probe_unreachable"
    assert by_host["host-b"]["action"] == "monitor_only"


def test_clock_skew_escalates_even_with_healthy_probe(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-skew-hb.json", healthy=True, mtime=1000.0, checked_at="1970-01-01T00:00:00Z")
    hosts = _hosts_file(tmp_path, [{"host": "host-skew", "heartbeatPath": str(hb)}])
    result = _mod.run_once(
        _config(tmp_path, hosts, hysteresis_cycles=2, max_clock_skew_seconds=60),
        _deps(1000.0, {"host-skew": {"reachable": True, "healthy": True, "class": "healthy"}}),
    )
    host = result["hosts"][0]
    assert host["class"] == "clock_skew"
    assert host["twoSignals"] is True
    assert host["action"] == "escalate"
    assert host["heartbeat"]["status"] == "clock_skew"
    assert host["heartbeat"]["clockSkewSeconds"] == -1000
    assert host["heartbeat"]["maxClockSkewSeconds"] == 60


def test_fresh_older_heartbeat_is_not_clock_skew(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-fresh-hb.json", healthy=True, mtime=600.0, checked_at="1970-01-01T00:10:00Z")
    hosts = _hosts_file(tmp_path, [{"host": "host-fresh", "heartbeatPath": str(hb)}])
    result = _mod.run_once(
        _config(tmp_path, hosts, heartbeat_max_age_seconds=600, max_clock_skew_seconds=60),
        _deps(1000.0, {"host-fresh": {"reachable": True, "healthy": True, "class": "healthy"}}),
    )
    host = result["hosts"][0]
    assert host["class"] == "healthy"
    assert host["action"] == "noop"
    assert host["heartbeat"]["status"] == "fresh"
    assert host["heartbeat"]["clockSkewSeconds"] == 0


def test_future_heartbeat_mtime_beyond_skew_budget_escalates(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-future-hb.json", healthy=True, mtime=1400.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-future", "heartbeatPath": str(hb)}])

    result = _mod.run_once(
        _config(tmp_path, hosts, max_clock_skew_seconds=300),
        _deps(1000.0, {"host-future": {"reachable": True, "healthy": True, "class": "healthy"}}),
    )

    host = result["hosts"][0]
    assert host["class"] == "clock_skew"
    assert host["twoSignals"] is True
    assert host["action"] == "escalate"
    assert host["heartbeat"]["status"] == "clock_skew"
    assert host["heartbeat"]["futureBySeconds"] == 400
    assert host["heartbeat"]["maxClockSkewSeconds"] == 300


def test_safe_runtime_drift_becomes_tier1_heal_candidate(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-d-hb.json", healthy=False, klass="drift", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-d", "heartbeatPath": str(hb)}])
    result = _mod.run_once(
        _config(tmp_path, hosts, hysteresis_cycles=1),
        _deps(1000.0, {"host-d": {"reachable": True, "healthy": False, "class": "drift"}}),
    )
    host = result["hosts"][0]
    assert host["class"] == "safe_runtime_drift"
    assert host["action"] == "tier1_heal_candidate"
    assert host["alertState"] == "open"


def test_tier1_action_outbox_emits_local_heal_request_once_per_cooldown(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-d-hb.json", healthy=False, klass="drift", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-d", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1, action_event_cooldown_seconds=3600)
    deps = _deps(1000.0, {"host-d": {"reachable": True, "healthy": False, "class": "drift", "output": "redacted"}})

    first = _mod.run_once(config, deps)
    assert len(first["actionEvents"]) == 1
    ref = first["actionEvents"][0]
    payload = json.loads(Path(ref["path"]).read_text(encoding="utf-8"))
    assert payload["kind"] == "bot-errors-sentinel-action"
    assert payload["scope"] == "host"
    assert payload["host"] == "host-d"
    assert payload["action"] == "tier1_heal_candidate"
    assert payload["tier"] == "tier1"
    assert payload["lane"] == "host_selfcheck_heal_request"
    assert payload["criticalWhatsAppEligible"] is False
    assert "output" not in payload["evidence"]["probe"]
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["hosts"]["host-d"]["lastActionEventRequestId"] == ref["requestId"]

    second = _mod.run_once(config, _deps(1001.0, {"host-d": {"reachable": True, "healthy": False, "class": "drift"}}))
    assert second["actionEvents"] == []
    assert len(list(_mod.action_outbox_dir(config).glob("*.json"))) == 1


def test_correlated_safe_drift_freezes_fleet_autoheal(tmp_path: Path):
    hosts_payload = []
    probes = {}
    acks = {}
    for name in ("host-a", "host-b", "host-c"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=False, klass="drift", mtime=995.0)
        acks[name] = tmp_path / "acks" / f"{name}.json"
        hosts_payload.append({"host": name, "heartbeatPath": str(hb), "ackPath": str(acks[name])})
        probes[name] = {"reachable": True, "healthy": False, "class": "drift"}
    hb = _heartbeat(tmp_path / "host-d-hb.json", healthy=False, klass="manifest_missing", mtime=995.0)
    acks["host-d"] = tmp_path / "acks" / "host-d.json"
    hosts_payload.append({"host": "host-d", "heartbeatPath": str(hb), "ackPath": str(acks["host-d"])})
    probes["host-d"] = {"reachable": True, "healthy": False, "class": "manifest_missing"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    result = _mod.run_once(_config(tmp_path, hosts, hysteresis_cycles=1), _deps(1000.0, probes))
    assert result["fleetAction"] == "correlated_runtime_drift_freeze"
    by_host = {host["host"]: host for host in result["hosts"]}
    assert {by_host[name]["action"] for name in ("host-a", "host-b", "host-c")} == {"freeze_correlated_drift"}
    assert by_host["host-d"]["action"] == "tier1_heal_candidate"
    assert {by_host[name]["correlatedDriftClass"] for name in ("host-a", "host-b", "host-c")} == {"drift"}
    assert json.loads(acks["host-a"].read_text(encoding="utf-8"))["centralAction"] == "freeze_correlated_drift"
    assert json.loads(acks["host-d"].read_text(encoding="utf-8"))["centralAction"] == "tier1_heal_candidate"
    assert by_host["host-a"]["ackPath"] == str(acks["host-a"])
    state = json.loads(_mod.state_path(_config(tmp_path, hosts, hysteresis_cycles=1)).read_text(encoding="utf-8"))
    assert {state["hosts"][name]["lastAction"] for name in ("host-a", "host-b", "host-c")} == {"freeze_correlated_drift"}
    assert state["hosts"]["host-d"]["lastAction"] == "tier1_heal_candidate"


def test_tier1_candidate_count_is_capped_without_correlated_freeze(tmp_path: Path):
    classes = {"host-a": "drift", "host-b": "manifest_missing", "host-c": "drift"}
    hosts_payload = []
    probes = {}
    acks = {}
    for name, klass in classes.items():
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=False, klass=klass, mtime=995.0)
        acks[name] = tmp_path / "acks" / f"{name}.json"
        hosts_payload.append({"host": name, "heartbeatPath": str(hb), "ackPath": str(acks[name])})
        probes[name] = {"reachable": True, "healthy": False, "class": klass}
    hosts = _hosts_file(tmp_path, hosts_payload)
    result = _mod.run_once(
        _config(tmp_path, hosts, hysteresis_cycles=1, max_tier1_heal_candidates=2, correlated_drift_freeze_threshold=10),
        _deps(1000.0, probes),
    )
    assert result["fleetAction"] == "tier1_concurrency_cap"
    by_host = {host["host"]: host for host in result["hosts"]}
    assert by_host["host-a"]["action"] == "tier1_heal_candidate"
    assert by_host["host-b"]["action"] == "tier1_heal_candidate"
    assert by_host["host-c"]["action"] == "defer_tier1_concurrency_cap"
    assert json.loads(acks["host-a"].read_text(encoding="utf-8"))["centralAction"] == "tier1_heal_candidate"
    assert json.loads(acks["host-c"].read_text(encoding="utf-8"))["centralAction"] == "defer_tier1_concurrency_cap"


def test_flapping_suppresses_auto_heal_candidate(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-d-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-d", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1, flap_threshold=2)
    _mod.run_once(config, _deps(1000.0, {"host-d": {"reachable": True, "healthy": True, "class": "healthy"}}))
    _heartbeat(hb, healthy=False, klass="drift", mtime=1001.0)
    result = _mod.run_once(config, _deps(1002.0, {"host-d": {"reachable": True, "healthy": False, "class": "drift"}}))
    host = result["hosts"][0]
    assert host["class"] == "safe_runtime_drift"
    assert host["flapCount"] >= 2
    assert host["action"] == "escalate_flapping"


def test_central_connectivity_suspect_requires_failed_oracle_to_suppress(tmp_path: Path):
    hosts_payload = []
    probes = {}
    acks = {}
    for name in ("host-a", "host-b", "host-c"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=True, mtime=100.0)
        acks[name] = tmp_path / "acks" / f"{name}.json"
        hosts_payload.append({"host": name, "heartbeatPath": str(hb), "ackPath": str(acks[name])})
        probes[name] = {"reachable": False, "healthy": False, "class": "unreachable"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    result = _mod.run_once(_config(tmp_path, hosts, hysteresis_cycles=1, connectivity_hysteresis_cycles=1), _deps(1000.0, probes))
    assert result["fleetAction"] == "mass_unreachable_confirmed"
    assert {host["action"] for host in result["hosts"]} == {"escalate"}

    oracle_down = {"configured": True, "reachable": False, "class": "gateway_unreachable"}
    result = _mod.run_once(_config(tmp_path / "oracle-down", hosts, hysteresis_cycles=1, connectivity_hysteresis_cycles=1), _deps(1000.0, probes, oracle_down))
    assert result["fleetAction"] == "central_connectivity_suspect"
    assert {host["action"] for host in result["hosts"]} == {"suppress_central_connectivity_suspect"}
    assert result["reachabilityOracle"] == oracle_down
    assert len(result["actionEvents"]) == 1
    fleet_event = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    assert fleet_event["scope"] == "fleet"
    assert fleet_event["fleetAction"] == "central_connectivity_suspect"
    assert fleet_event["tier"] == "tier3"
    assert fleet_event["criticalWhatsAppEligible"] is True
    assert fleet_event["criticalWhatsAppAllowed"] is True
    assert fleet_event["criticalWhatsAppDailyCap"] == 8
    assert fleet_event["problemHostCount"] == 3
    assert json.loads(acks["host-a"].read_text(encoding="utf-8"))["centralAction"] == "suppress_central_connectivity_suspect"

    waiting = _mod.run_once(_config(tmp_path / "waiting", hosts, hysteresis_cycles=1, connectivity_hysteresis_cycles=2), _deps(1000.0, probes, oracle_down))
    assert waiting["fleetAction"] == "central_connectivity_suspect"
    assert {host["action"] for host in waiting["hosts"]} == {"hysteresis_wait"}


def test_critical_whatsapp_daily_cap_suppresses_overflow_and_updates_digest(tmp_path: Path):
    hosts_payload = []
    probes = {}
    for name in ("host-a", "host-b", "host-c"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
        probes[name] = {"reachable": True, "healthy": False, "class": "permission_denied"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    result = _mod.run_once(
        _config(tmp_path, hosts, hysteresis_cycles=1, max_critical_whatsapp_per_day=2),
        _deps(1000.0, probes),
    )

    host_events = [json.loads(Path(ref["path"]).read_text(encoding="utf-8")) for ref in result["actionEvents"] if ref["scope"] == "host"]
    digest_refs = [ref for ref in result["actionEvents"] if ref["action"] == "critical_whatsapp_daily_cap_digest"]
    assert [event["criticalWhatsAppAllowed"] for event in host_events] == [True, True, False]
    assert host_events[2]["criticalWhatsAppSuppressedReason"] == "daily_cap"
    assert len(digest_refs) == 1
    digest = json.loads(Path(digest_refs[0]["path"]).read_text(encoding="utf-8"))
    assert digest["lane"] == "human_digest_overflow"
    assert digest["criticalWhatsAppAllowedCount"] == 2
    assert digest["criticalWhatsAppOverflowCount"] == 1
    state = json.loads(_mod.state_path(_config(tmp_path, hosts, hysteresis_cycles=1, max_critical_whatsapp_per_day=2)).read_text(encoding="utf-8"))
    assert state["criticalWhatsApp"]["day"] == "1970-01-01"
    assert state["criticalWhatsApp"]["allowedCount"] == 2
    assert state["criticalWhatsApp"]["overflowCount"] == 1


def test_malformed_critical_whatsapp_state_is_reinitialized(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {"schemaVersion": 1, "hosts": {}, "criticalWhatsApp": ["corrupt"]},
    )

    result = _mod.run_once(
        config,
        _deps(1000.0, {"host-a": {"reachable": True, "healthy": False, "class": "permission_denied"}}),
    )

    payload = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    assert payload["host"] == "host-a"
    assert payload["criticalWhatsAppAllowed"] is True
    assert payload["criticalWhatsAppAllowedCount"] == 1
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["criticalWhatsApp"]["day"] == "1970-01-01"
    assert state["criticalWhatsApp"]["allowedCount"] == 1
    assert state["criticalWhatsApp"]["overflowCount"] == 0


def test_non_finite_critical_whatsapp_allowed_count_is_reinitialized(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "criticalWhatsApp": {"day": "1970-01-01", "allowedCount": float("inf"), "overflowCount": 0},
        },
    )

    result = _mod.run_once(
        config,
        _deps(1000.0, {"host-a": {"reachable": True, "healthy": False, "class": "permission_denied"}}),
    )

    payload = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    assert payload["criticalWhatsAppAllowed"] is True
    assert payload["criticalWhatsAppAllowedCount"] == 1
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["criticalWhatsApp"]["allowedCount"] == 1


def test_non_finite_critical_whatsapp_overflow_count_is_reinitialized(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1, max_critical_whatsapp_per_day=1)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "criticalWhatsApp": {"day": "1970-01-01", "allowedCount": 1, "overflowCount": float("inf")},
        },
    )

    result = _mod.run_once(
        config,
        _deps(1000.0, {"host-a": {"reachable": True, "healthy": False, "class": "permission_denied"}}),
    )

    event_ref = next(ref for ref in result["actionEvents"] if ref["scope"] == "host")
    digest_ref = next(ref for ref in result["actionEvents"] if ref["action"] == "critical_whatsapp_daily_cap_digest")
    payload = json.loads(Path(event_ref["path"]).read_text(encoding="utf-8"))
    digest = json.loads(Path(digest_ref["path"]).read_text(encoding="utf-8"))
    assert payload["criticalWhatsAppAllowed"] is False
    assert payload["criticalWhatsAppOverflowCount"] == 1
    assert digest["criticalWhatsAppOverflowCount"] == 1
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["criticalWhatsApp"]["overflowCount"] == 1


def test_tier2_action_event_includes_q_remediation_token(tmp_path: Path, monkeypatch):
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    q_hb = _heartbeat(tmp_path / "q-agent-host-hb.json", healthy=True, klass="healthy", mtime=995.0)
    hosts = _hosts_file(
        tmp_path,
        [
            {"host": "host-q", "heartbeatPath": str(hb)},
            {"host": "q-agent-host", "heartbeatPath": str(q_hb)},
        ],
    )
    config = _config(tmp_path, hosts, hysteresis_cycles=1, tier2_token_ttl_seconds=900, q_host="q-agent-host")
    monkeypatch.setattr(_mod.secrets, "token_urlsafe", lambda _length: "fixed-token")
    result = _mod.run_once(
        config,
        _deps(
            1000.0,
            {
                "host-q": {"reachable": True, "healthy": False, "class": "permission_denied"},
                "q-agent-host": {"reachable": True, "healthy": True, "class": "healthy"},
            },
        ),
    )
    assert len(result["actionEvents"]) == 1
    payload = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    remediation = payload["remediation"]
    assert payload["tier"] == "tier2"
    assert remediation["kind"] == "q-remediation-request"
    assert remediation["qEligible"] is True
    assert remediation["qHost"] == "q-agent-host"
    assert remediation["targetHost"] == "host-q"
    assert remediation["token"] == "fixed-token"
    assert remediation["tokenTtlSeconds"] == 900
    assert remediation["tokenExpiresAt"] == "1970-01-01T00:31:40Z"
    assert remediation["actionHash"] == _mod.remediation_action_hash(payload)
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    q_state = state["qRemediation"]
    assert q_state["host"] == "host-q"
    assert q_state["requestId"] == remediation["requestId"]
    assert q_state["actionHash"] == remediation["actionHash"]
    assert q_state["tokenHash"] == _mod.remediation_token_hash(
        "fixed-token",
        "host-q",
        remediation["actionHash"],
        remediation["requestId"],
    )
    assert "fixed-token" not in json.dumps(q_state)


def test_missing_q_host_health_blocks_tier2_q_routing(tmp_path: Path, monkeypatch):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1, q_host="q-agent-host")
    monkeypatch.setattr(_mod.secrets, "token_urlsafe", lambda _length: "should-not-issue")

    result = _mod.run_once(
        config,
        _deps(1000.0, {"host-a": {"reachable": True, "healthy": False, "class": "permission_denied"}}),
    )

    payload = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    assert payload["remediation"] == {
        "qEligible": False,
        "reason": "q_host_unverified",
        "qHost": "q-agent-host",
        "handledBy": "central_direct",
    }
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state.get("qRemediation") in (None, {})
    assert "should-not-issue" not in json.dumps(payload)


def test_q_host_self_failure_is_not_routed_to_q(tmp_path: Path):
    hb = _heartbeat(tmp_path / "q-agent-host-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "q-agent-host", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1, q_host="q-agent-host")
    result = _mod.run_once(
        config,
        _deps(1000.0, {"q-agent-host": {"reachable": True, "healthy": False, "class": "permission_denied"}}),
    )
    payload = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    assert payload["tier"] == "tier2"
    assert payload["remediation"] == {
        "qEligible": False,
        "reason": "q_host_self_failure",
        "qHost": "q-agent-host",
        "handledBy": "central_direct",
    }
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state.get("qRemediation") in (None, {})


def test_degraded_q_host_blocks_tier2_q_routing(tmp_path: Path, monkeypatch):
    hosts_payload = []
    probes = {}
    for name in ("host-a", "q-agent-host"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
        probes[name] = {"reachable": True, "healthy": False, "class": "permission_denied"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    config = _config(tmp_path, hosts, hysteresis_cycles=1, q_host="q-agent-host")
    monkeypatch.setattr(_mod.secrets, "token_urlsafe", lambda _length: "should-not-issue")
    result = _mod.run_once(config, _deps(1000.0, probes))
    host_events = {}
    for ref in result["actionEvents"]:
        if ref["scope"] == "host":
            payload = json.loads(Path(ref["path"]).read_text(encoding="utf-8"))
            host_events[payload["host"]] = payload
    assert host_events["host-a"]["remediation"] == {
        "qEligible": False,
        "reason": "q_host_degraded",
        "qHost": "q-agent-host",
        "qHostClass": "runtime_invariant_failed",
        "qHostAction": "escalate",
        "handledBy": "central_direct",
    }
    assert host_events["q-agent-host"]["remediation"]["reason"] == "q_host_self_failure"
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state.get("qRemediation") in (None, {})
    assert "should-not-issue" not in json.dumps(host_events)


def test_q_remediation_is_one_host_at_a_time(tmp_path: Path, monkeypatch):
    hosts_payload = []
    probes = {}
    for name in ("host-a", "host-b"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
        probes[name] = {"reachable": True, "healthy": False, "class": "permission_denied"}
    q_hb = _heartbeat(tmp_path / "q-agent-host-hb.json", healthy=True, klass="healthy", mtime=995.0)
    hosts_payload.append({"host": "q-agent-host", "heartbeatPath": str(q_hb)})
    probes["q-agent-host"] = {"reachable": True, "healthy": True, "class": "healthy"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    config = _config(tmp_path, hosts, hysteresis_cycles=1, q_host="q-agent-host")
    monkeypatch.setattr(_mod.secrets, "token_urlsafe", lambda _length: "first-token")
    result = _mod.run_once(config, _deps(1000.0, probes))
    host_events = [
        json.loads(Path(ref["path"]).read_text(encoding="utf-8"))
        for ref in result["actionEvents"]
        if ref["scope"] == "host"
    ]
    assert host_events[0]["host"] == "host-a"
    assert host_events[0]["remediation"]["qEligible"] is True
    assert host_events[0]["remediation"]["token"] == "first-token"
    assert host_events[1]["host"] == "host-b"
    assert host_events[1]["remediation"]["qEligible"] is False
    assert host_events[1]["remediation"]["reason"] == "q_remediation_inflight"
    assert host_events[1]["remediation"]["activeHost"] == "host-a"


def test_malformed_q_remediation_state_does_not_crash_tier2(tmp_path: Path, monkeypatch):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    q_hb = _heartbeat(tmp_path / "q-agent-host-hb.json", healthy=True, klass="healthy", mtime=995.0)
    hosts = _hosts_file(
        tmp_path,
        [
            {"host": "host-a", "heartbeatPath": str(hb)},
            {"host": "q-agent-host", "heartbeatPath": str(q_hb)},
        ],
    )
    config = _config(tmp_path, hosts, hysteresis_cycles=1, q_host="q-agent-host")
    _mod.atomic_write_json(
        _mod.state_path(config),
        {"schemaVersion": 1, "hosts": {}, "qRemediation": ["corrupt"]},
    )
    monkeypatch.setattr(_mod.secrets, "token_urlsafe", lambda _length: "replacement-token")

    result = _mod.run_once(
        config,
        _deps(
            1000.0,
            {
                "host-a": {"reachable": True, "healthy": False, "class": "permission_denied"},
                "q-agent-host": {"reachable": True, "healthy": True, "class": "healthy"},
            },
        ),
    )

    payload = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    assert payload["host"] == "host-a"
    assert payload["remediation"]["qEligible"] is True
    assert payload["remediation"]["token"] == "replacement-token"
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert isinstance(state["qRemediation"], dict)
    assert state["qRemediation"]["host"] == "host-a"


def test_expired_q_remediation_emits_q_unavailable_tier3_event(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-q", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "qRemediation": {
                "tokenId": "tok-1",
                "tokenHash": "hash-1",
                "requestId": "request-1",
                "host": "host-q",
                "actionHash": "action-hash-1",
                "issuedAt": "1970-01-01T00:10:00Z",
                "expiresAt": "1970-01-01T00:15:00Z",
                "expiresAtEpoch": 900.0,
                "qHost": "q-agent-host",
            },
        },
    )
    result = _mod.run_once(config, _deps(1000.0, {"host-q": {"reachable": True, "healthy": True, "class": "healthy"}}))
    assert result["fleetAction"] == "none"
    assert result["hosts"][0]["healthy"] is True
    assert len(result["actionEvents"]) == 1
    ref = result["actionEvents"][0]
    assert ref["action"] == "q_unavailable"
    payload = json.loads(Path(ref["path"]).read_text(encoding="utf-8"))
    assert payload["class"] == "q_unavailable"
    assert payload["tier"] == "tier3"
    assert payload["lane"] == "human_critical_q_unavailable"
    assert payload["criticalWhatsAppEligible"] is True
    assert payload["criticalWhatsAppAllowed"] is True
    assert payload["reason"] == "q_remediation_ack_timeout"
    assert payload["remediation"] == {
        "qEligible": False,
        "reason": "ack_timeout",
        "qHost": "q-agent-host",
        "originalRequestId": "request-1",
        "actionHash": "action-hash-1",
        "tokenId": "tok-1",
        "issuedAt": "1970-01-01T00:10:00Z",
        "expiresAt": "1970-01-01T00:15:00Z",
    }
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert "qRemediation" not in state
    assert state["qUnavailableEvent"]["timedOutRequestId"] == "request-1"
    heartbeat = json.loads(_mod.heartbeat_path(config).read_text(encoding="utf-8"))
    assert heartbeat["healthy"] is False
    assert heartbeat["problemHostCount"] == 0
    assert _mod.result_requires_attention(result) is True


def test_recent_q_unavailable_timeout_is_deduped_and_clears_inflight(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-q", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, action_event_cooldown_seconds=3600)
    key = "q_unavailable:host-q:request-1:action-hash-1"
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "qRemediation": {
                "requestId": "request-1",
                "host": "host-q",
                "actionHash": "action-hash-1",
                "expiresAtEpoch": 900.0,
            },
            "qUnavailableEvent": {"lastActionEventKey": key, "lastActionEventAt": 999.0},
        },
    )
    result = _mod.run_once(config, _deps(1000.0, {"host-q": {"reachable": True, "healthy": True, "class": "healthy"}}))
    assert result["actionEvents"] == []
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert "qRemediation" not in state
    assert state["qUnavailableEvent"]["lastActionEventKey"] == key


def test_non_finite_q_unavailable_event_time_does_not_dedupe_timeout(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-q", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, action_event_cooldown_seconds=3600)
    key = "q_unavailable:host-q:request-1:action-hash-1"
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "qRemediation": {
                "requestId": "request-1",
                "host": "host-q",
                "actionHash": "action-hash-1",
                "expiresAtEpoch": 900.0,
            },
            "qUnavailableEvent": {"lastActionEventKey": key, "lastActionEventAt": float("inf")},
        },
    )

    result = _mod.run_once(config, _deps(1000.0, {"host-q": {"reachable": True, "healthy": True, "class": "healthy"}}))

    assert result["actionEvents"][0]["action"] == "q_unavailable"
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert "qRemediation" not in state
    assert state["qUnavailableEvent"]["lastActionEventAt"] == 1000.0


def test_boolean_q_unavailable_event_time_does_not_dedupe_timeout(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-q", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, action_event_cooldown_seconds=3600)
    key = "q_unavailable:host-q:request-1:action-hash-1"
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "qRemediation": {
                "requestId": "request-1",
                "host": "host-q",
                "actionHash": "action-hash-1",
                "expiresAtEpoch": 900.0,
            },
            "qUnavailableEvent": {"lastActionEventKey": key, "lastActionEventAt": True},
        },
    )

    result = _mod.run_once(config, _deps(1000.0, {"host-q": {"reachable": True, "healthy": True, "class": "healthy"}}))

    assert result["actionEvents"][0]["action"] == "q_unavailable"
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert "qRemediation" not in state
    assert state["qUnavailableEvent"]["lastActionEventAt"] == 1000.0


def test_malformed_q_unavailable_event_state_is_reinitialized(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-q", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "qUnavailableEvent": ["corrupt"],
            "qRemediation": {
                "requestId": "request-1",
                "host": "host-q",
                "actionHash": "action-hash-1",
                "expiresAtEpoch": 900.0,
            },
        },
    )

    result = _mod.run_once(config, _deps(1000.0, {"host-q": {"reachable": True, "healthy": True, "class": "healthy"}}))

    assert result["actionEvents"][0]["action"] == "q_unavailable"
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert isinstance(state["qUnavailableEvent"], dict)
    assert state["qUnavailableEvent"]["timedOutRequestId"] == "request-1"


def test_expired_q_remediation_helper_edges():
    assert _mod.expired_q_remediation({}, 1000.0) is None
    assert _mod.expired_q_remediation({"qRemediation": []}, 1000.0) is None
    assert _mod.expired_q_remediation({"qRemediation": {"redeemedAt": "1970-01-01T00:10:00Z"}}, 1000.0) is None
    malformed_redeemed = {"qRemediation": {"host": "host-q", "expiresAtEpoch": 900.0, "redeemedAt": "not-a-time"}}
    assert _mod.expired_q_remediation(malformed_redeemed, 1000.0) == malformed_redeemed["qRemediation"]
    future_redeemed = {"qRemediation": {"host": "host-q", "expiresAtEpoch": 900.0, "redeemedAt": "1970-01-01T00:20:00Z"}}
    assert _mod.expired_q_remediation(future_redeemed, 1000.0) == future_redeemed["qRemediation"]
    assert _mod.expired_q_remediation({"qRemediation": {"expiresAtEpoch": 1001.0}}, 1000.0) is None
    invalid = {"qRemediation": {"host": "host-q", "expiresAtEpoch": "bad"}}
    assert _mod.expired_q_remediation(invalid, 1000.0) == invalid["qRemediation"]
    non_finite = {"qRemediation": {"host": "host-q", "expiresAtEpoch": float("inf")}}
    assert _mod.expired_q_remediation(non_finite, 1000.0) == non_finite["qRemediation"]
    active_non_finite = {"qRemediation": {"host": "host-q", "expiresAtEpoch": float("inf")}}
    assert _mod.active_q_remediation(active_non_finite, 1000.0) is None
    assert active_non_finite["qRemediation"] == {}


def test_q_unavailable_timeout_respects_critical_whatsapp_cap(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-q", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, max_critical_whatsapp_per_day=1)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "criticalWhatsApp": {"day": "1970-01-01", "allowedCount": 1, "overflowCount": 0},
            "qRemediation": {
                "tokenId": "tok-1",
                "requestId": "request-1",
                "host": "host-q",
                "actionHash": "action-hash-1",
                "expiresAtEpoch": 900.0,
                "qHost": "q-agent-host",
            },
        },
    )
    result = _mod.run_once(config, _deps(1000.0, {"host-q": {"reachable": True, "healthy": True, "class": "healthy"}}))
    q_ref = next(ref for ref in result["actionEvents"] if ref["action"] == "q_unavailable")
    digest_ref = next(ref for ref in result["actionEvents"] if ref["action"] == "critical_whatsapp_daily_cap_digest")
    q_event = json.loads(Path(q_ref["path"]).read_text(encoding="utf-8"))
    digest = json.loads(Path(digest_ref["path"]).read_text(encoding="utf-8"))
    assert q_event["criticalWhatsAppAllowed"] is False
    assert q_event["criticalWhatsAppSuppressedReason"] == "daily_cap"
    assert digest["criticalWhatsAppAllowedCount"] == 1
    assert digest["criticalWhatsAppOverflowCount"] == 1


def test_malformed_fleet_action_event_state_is_reinitialized(tmp_path: Path):
    hosts_payload = []
    probes = {}
    for name in ("host-a", "host-b"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=True, mtime=100.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
        probes[name] = {"reachable": False, "healthy": False, "class": "unreachable"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    config = _config(tmp_path, hosts, connectivity_hysteresis_cycles=1)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {"schemaVersion": 1, "hosts": {}, "fleetActionEvent": ["corrupt"]},
    )

    result = _mod.run_once(config, _deps(1000.0, probes))

    assert result["fleetAction"] == "mass_unreachable_confirmed"
    assert any(ref["scope"] == "fleet" and ref["action"] == "mass_unreachable_confirmed" for ref in result["actionEvents"])
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert isinstance(state["fleetActionEvent"], dict)
    assert state["fleetActionEvent"]["lastActionEventKey"] == "fleet:mass_unreachable_confirmed"


def test_probe_path_default_and_bad_heartbeat_json(tmp_path: Path):
    probe = _write_json(tmp_path / "probe.json", {"reachable": True, "healthy": True, "class": "healthy"})
    spec = _mod.HostSpec(host="host-a", probe_path=probe)
    assert _mod.default_pull_probe(spec)["class"] == "healthy"

    bad_hb = tmp_path / "bad-heartbeat.json"
    bad_hb.write_text("{bad", encoding="utf-8")
    assert _mod.heartbeat_inventory(_mod.HostSpec(host="host-a", heartbeat_path=bad_hb), 1000.0, 60, 300)["status"] == "invalid_json"

    missing_probe = _mod.default_pull_probe(_mod.HostSpec(host="host-b", probe_path=tmp_path / "missing.json"))
    assert missing_probe == {"reachable": False, "healthy": False, "class": "invalid_probe"}


def test_symlinked_file_based_signals_are_not_trusted(tmp_path: Path):
    heartbeat_target = _heartbeat(tmp_path / "heartbeat-target.json", healthy=True, klass="healthy", mtime=1000.0)
    heartbeat_link = tmp_path / "heartbeat-link.json"
    os.symlink(heartbeat_target, heartbeat_link)

    heartbeat = _mod.heartbeat_inventory(_mod.HostSpec(host="host-a", heartbeat_path=heartbeat_link), 1000.0, 60, 300)

    assert heartbeat == {
        "configured": True,
        "signal": "stale",
        "status": "symlink",
        "path": str(heartbeat_link),
    }

    probe_target = _write_json(tmp_path / "probe-target.json", {"reachable": True, "healthy": True, "class": "healthy"})
    probe_link = tmp_path / "probe-link.json"
    os.symlink(probe_target, probe_link)

    probe = _mod.default_pull_probe(_mod.HostSpec(host="host-a", probe_path=probe_link))

    assert probe == {"reachable": False, "healthy": False, "class": "invalid_probe", "error": "symlinked_probe_path"}

    oracle_target = _write_json(tmp_path / "oracle-target.json", {"reachable": False, "class": "gateway_unreachable"})
    oracle_link = tmp_path / "oracle-link.json"
    os.symlink(oracle_target, oracle_link)

    assert _mod.oracle_inventory(oracle_link) == {
        "configured": True,
        "reachable": None,
        "class": "invalid_oracle",
        "status": "symlink",
        "path": str(oracle_link),
    }


def test_symlinked_oracle_does_not_suppress_mass_unreachable(tmp_path: Path):
    hosts_payload = []
    probes = {}
    for name in ("host-a", "host-b"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=True, mtime=100.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
        probes[name] = {"reachable": False, "healthy": False, "class": "ssh_failed"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    oracle_target = _write_json(tmp_path / "oracle-target.json", {"reachable": False, "class": "gateway_unreachable"})
    oracle_link = tmp_path / "oracle-link.json"
    os.symlink(oracle_target, oracle_link)
    deps = _mod.SentinelDeps(
        now_epoch=lambda: 1000.0,
        hostname=lambda: "controller",
        pull_probe=lambda spec, *_: probes[spec.host],
        reachability_oracle=lambda: _mod.oracle_inventory(oracle_link),
    )

    result = _mod.run_once(
        _config(tmp_path, hosts, hysteresis_cycles=1, connectivity_hysteresis_cycles=1),
        deps,
    )

    assert result["fleetAction"] == "mass_unreachable_confirmed"
    assert result["reachabilityOracle"]["status"] == "symlink"
    assert {host["action"] for host in result["hosts"]} == {"escalate"}


def test_ssh_runtime_probe_success_uses_batchmode_and_remote_script(tmp_path: Path, monkeypatch):
    seen = {}

    class Proc:
        returncode = 0
        stdout = '{"reachable": true, "healthy": false, "class": "drift", "verifyRc": 1}\n'
        stderr = ""

    def run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["input"] = kwargs["input"]
        seen["timeout"] = kwargs["timeout"]
        seen["check"] = kwargs["check"]
        return Proc()

    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND", "ssh -F none")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_EXEC_HOST_A_EXAMPLE", "env FOO=bar")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_SSH_CONNECT_TIMEOUT_SECONDS", "4")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_SSH_PROBE_TIMEOUT_SECONDS", "9")
    monkeypatch.setattr(_mod.subprocess, "run", run)
    spec = _mod.HostSpec(host="host-a", ssh_host="host-a.example", root=tmp_path / "runtime", python="/usr/bin/python3")
    result = _mod.default_pull_probe(spec)
    assert result["reachable"] is True
    assert result["healthy"] is False
    assert result["class"] == "drift"
    assert seen["cmd"] == [
        "ssh",
        "-F",
        "none",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=4",
        "host-a.example",
        "env",
        "FOO=bar",
        "/usr/bin/python3",
        "-",
        str(tmp_path / "runtime"),
    ]
    assert "whatsoup-bot-errors-deploy.sh" in seen["input"]
    assert seen["timeout"] == 9
    assert seen["check"] is False

    result = _mod.default_pull_probe(_mod.HostSpec(host="host-b", root=tmp_path / "runtime"))
    assert result["class"] == "drift"
    assert seen["cmd"][7] == "host-b"


def test_ssh_runtime_probe_failure_modes(tmp_path: Path, monkeypatch):
    assert _mod.default_pull_probe(_mod.HostSpec(host="host-a", ssh_host="host-a.example")) == {
        "reachable": True,
        "healthy": False,
        "class": "probe_config_error",
        "error": "sshHost requires root",
    }

    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND", "ssh 'unterminated")
    bad_command = _mod.default_pull_probe(_mod.HostSpec(host="host-a", ssh_host="host-a.example", root=tmp_path))
    assert bad_command["reachable"] is True
    assert bad_command["healthy"] is False
    assert bad_command["class"] == "probe_config_error"
    assert "BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND" in bad_command["error"]
    monkeypatch.delenv("BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND")

    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_EXEC_HOST_A_EXAMPLE", "env 'unterminated")
    bad_prefix = _mod.default_pull_probe(_mod.HostSpec(host="host-a", ssh_host="host-a.example", root=tmp_path))
    assert bad_prefix["reachable"] is True
    assert bad_prefix["healthy"] is False
    assert bad_prefix["class"] == "probe_config_error"
    assert "BOT_ERRORS_FLEET_SENTINEL_EXEC_HOST_A_EXAMPLE" in bad_prefix["error"]
    monkeypatch.delenv("BOT_ERRORS_FLEET_SENTINEL_EXEC_HOST_A_EXAMPLE")

    def timeout(_cmd, **_kwargs):
        raise _mod.subprocess.TimeoutExpired(cmd="ssh", timeout=9)

    monkeypatch.setattr(_mod.subprocess, "run", timeout)
    timeout_result = _mod.default_pull_probe(_mod.HostSpec(host="host-a", ssh_host="host-a.example", root=tmp_path))
    assert timeout_result["reachable"] is False
    assert timeout_result["class"] == "ssh_timeout"

    def exec_error(_cmd, **_kwargs):
        raise OSError("missing ssh")

    monkeypatch.setattr(_mod.subprocess, "run", exec_error)
    exec_result = _mod.default_pull_probe(_mod.HostSpec(host="host-a", ssh_host="host-a.example", root=tmp_path))
    assert exec_result["reachable"] is False
    assert exec_result["class"] == "ssh_exec_error"

    class FailedProc:
        returncode = 255
        stdout = ""
        stderr = "connection refused"

    monkeypatch.setattr(_mod.subprocess, "run", lambda *_args, **_kwargs: FailedProc())
    failed = _mod.default_pull_probe(_mod.HostSpec(host="host-a", ssh_host="host-a.example", root=tmp_path))
    assert failed == {"reachable": False, "healthy": False, "class": "ssh_failed", "error": "connection refused"}

    class BadJsonProc:
        returncode = 0
        stdout = "not json\n"
        stderr = ""

    monkeypatch.setattr(_mod.subprocess, "run", lambda *_args, **_kwargs: BadJsonProc())
    invalid = _mod.default_pull_probe(_mod.HostSpec(host="host-a", ssh_host="host-a.example", root=tmp_path))
    assert invalid == {
        "reachable": True,
        "healthy": False,
        "class": "invalid_probe_output",
        "error": "remote probe did not emit JSON",
    }


def test_signal_classification_and_inventory_edges(tmp_path: Path, monkeypatch):
    assert _mod.heartbeat_inventory(_mod.HostSpec(host="host-a"), 1000.0, 60, 300) == {
        "configured": False,
        "signal": "unknown",
        "status": "not_configured",
    }
    missing_hb = _mod.heartbeat_inventory(_mod.HostSpec(host="host-a", heartbeat_path=tmp_path / "missing.json"), 1000.0, 60, 300)
    assert missing_hb["status"] == "missing"
    assert missing_hb["signal"] == "stale"
    assert _mod.normalize_probe(["corrupt"]) == {
        "configured": True,
        "signal": "unhealthy",
        "class": "invalid_probe",
        "error": "probe payload must be a JSON object",
    }

    target = tmp_path / "heartbeat.json"
    target.write_text("{}", encoding="utf-8")
    original_stat = Path.stat

    def stat(path: Path, *args, **kwargs):
        if path == target:
            raise PermissionError("denied")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)
    stat_error = _mod.heartbeat_inventory(_mod.HostSpec(host="host-a", heartbeat_path=target), 1000.0, 60, 300)
    assert stat_error["status"] == "stat_error:PermissionError"

    assert _mod.normalize_probe({}) == {"configured": False, "signal": "unknown", "class": "not_configured"}
    assert _mod.normalize_probe({"reachable": True, "healthy": None, "headSha": "a" * 40})["signal"] == "unknown"
    assert _mod.oracle_inventory(None) == {"configured": False, "reachable": True, "class": "not_configured"}
    assert _mod.oracle_inventory(tmp_path / "missing-oracle.json")["reachable"] is None
    invalid_oracle = _write_json(tmp_path / "invalid-oracle.json", {"reachable": "maybe", "class": "ambiguous"})
    assert _mod.oracle_inventory(invalid_oracle)["reachable"] is None
    up_oracle = _write_json(tmp_path / "up-oracle.json", {"reachable": True})
    assert _mod.oracle_inventory(up_oracle)["class"] == "reachable"
    down_oracle = _write_json(tmp_path / "down-oracle.json", {"reachable": False, "error": "gateway timeout"})
    down_result = _mod.oracle_inventory(down_oracle)
    assert down_result["class"] == "unreachable"
    assert down_result["error"] == "gateway timeout"
    assert _mod.parse_iso_epoch(None) is None
    assert _mod.parse_iso_epoch("   ") is None
    assert _mod.parse_iso_epoch("not-a-date") is None
    assert _mod.parse_iso_epoch("1970-01-01T00:00:00") is None
    assert _mod.parse_iso_epoch("1970-01-01T00:00:00Z") == 0.0
    assert _mod.int_or_zero("-5") == 0
    assert _mod.parse_probe_stdout("\n[]\n{\"class\":\"healthy\"}\n") == {"class": "healthy"}
    assert _mod.parse_probe_stdout("\n") is None
    assert (
        _mod.safe_runtime_drift_key({"heartbeat": {"class": "manifest_missing"}, "probe": {"class": "permission_denied"}})
        == "manifest_missing"
    )
    assert _mod.safe_runtime_drift_key({"heartbeat": {"class": "permission_denied"}, "probe": {"class": "permission_denied"}}) == "safe_runtime_drift"

    cases = [
        ({"signal": "unhealthy", "class": "clock_skew"}, {"signal": "healthy", "class": "healthy"}, "clock_skew"),
        ({"signal": "unhealthy", "class": "permission_denied"}, {"signal": "unreachable", "class": "unreachable"}, "runtime_unverified"),
        ({"signal": "unhealthy", "class": "permission_denied"}, {"signal": "healthy", "class": "healthy"}, "heartbeat_unhealthy"),
        ({"signal": "healthy", "class": "healthy"}, {"signal": "unhealthy", "class": "permission_denied"}, "probe_unhealthy"),
        ({"signal": "unknown"}, {"signal": "unknown"}, "insufficient_data"),
    ]
    for heartbeat, probe, expected in cases:
        observed, _two_signals, _reason = _mod.classify_signals(heartbeat, probe)
        assert observed == expected
    assert _mod.result_requires_attention({"fleetAction": "central_connectivity_suspect", "hosts": []}) is True
    assert _mod.result_requires_attention({"fleetAction": "none", "hosts": [{"action": "freeze_correlated_drift"}]}) is True
    assert _mod.result_requires_attention({"fleetAction": "none", "hosts": [{"action": "monitor_only"}]}) is False


def test_malformed_pull_probe_payload_fails_closed_without_crashing(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])

    result = _mod.run_once(_config(tmp_path, hosts), _deps(1000.0, {"host-a": ["corrupt"]}))

    host = result["hosts"][0]
    assert host["class"] == "probe_unhealthy"
    assert host["action"] == "monitor_only"
    assert host["probe"]["class"] == "invalid_probe"
    assert host["probe"]["error"] == "probe payload must be a JSON object"


def test_pull_probe_exception_is_contained_per_host(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    deps = _mod.SentinelDeps(
        now_epoch=lambda: 1000.0,
        hostname=lambda: "central-test",
        pull_probe=lambda _spec, *_: (_ for _ in ()).throw(RuntimeError("probe exploded")),
        reachability_oracle=lambda: {"configured": False, "reachable": True, "class": "not_configured"},
    )

    result = _mod.run_once(_config(tmp_path, hosts), deps)

    host = result["hosts"][0]
    assert host["class"] == "probe_unhealthy"
    assert host["action"] == "monitor_only"
    assert host["probe"]["class"] == "probe_error"
    assert host["probe"]["error"] == "RuntimeError: probe exploded"


def test_transition_pruning_and_state_cleanup(tmp_path: Path):
    record = {"transitions": ["bad", 1.0, 995.0, 1005.0, float("inf")]}
    assert _mod.prune_transition_times(record, 1000.0, 10) == [995.0]

    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {"schemaVersion": 1, "hosts": ["bad"]},
    )
    assert _mod.load_state(config)["hosts"] == {}
    _mod.atomic_write_json(
        _mod.state_path(config),
        {"schemaVersion": 1, "hosts": {"host-a": {"alertState": "closed"}, "removed": {"alertState": "open"}}},
    )
    result = _mod.run_once(config, _deps(1000.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))
    assert _mod.mass_out_of_rotation([result["hosts"][0]]) is False
    assert _mod.central_connectivity_suspect([result["hosts"][0]], {"reachable": False}) is False
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert sorted(state["hosts"]) == ["host-a"]


def test_malformed_host_state_record_is_reinitialized(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {"schemaVersion": 1, "hosts": {"host-a": ["corrupt"]}},
    )

    result = _mod.run_once(config, _deps(1000.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))

    assert result["hosts"][0]["class"] == "healthy"
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert isinstance(state["hosts"]["host-a"], dict)
    assert state["hosts"]["host-a"]["lastClass"] == "healthy"


def test_malformed_host_state_fields_are_reinitialized(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {
                "host-a": {
                    "alertState": "open",
                    "lastClass": "healthy",
                    "consecutive": "bad",
                    "transitions": 3,
                }
            },
        },
    )

    result = _mod.run_once(config, _deps(1000.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))

    assert result["hosts"][0]["action"] == "clear"
    assert result["hosts"][0]["consecutive"] == 1
    assert result["hosts"][0]["flapCount"] == 0
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["hosts"]["host-a"]["transitions"] == []
    assert state["hosts"]["host-a"]["consecutive"] == 1


def test_boolean_host_consecutive_is_reinitialized(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {
                "host-a": {
                    "alertState": "open",
                    "lastClass": "healthy",
                    "consecutive": True,
                    "transitions": [],
                }
            },
        },
    )

    result = _mod.run_once(config, _deps(1000.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))

    assert result["hosts"][0]["action"] == "clear"
    assert result["hosts"][0]["consecutive"] == 1
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["hosts"]["host-a"]["consecutive"] == 1


def test_reachability_oracle_errors_fail_safe_without_suppression(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=100.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1)

    def raise_oracle():
        raise RuntimeError("oracle down")

    error_deps = _mod.SentinelDeps(
        now_epoch=lambda: 1000.0,
        hostname=lambda: "central-test",
        pull_probe=lambda _spec, *_: {"reachable": False, "healthy": False, "class": "unreachable"},
        reachability_oracle=raise_oracle,
    )
    result = _mod.run_once(config, error_deps)
    assert result["fleetAction"] == "none"
    assert result["reachabilityOracle"]["class"] == "oracle_error"

    invalid_deps = _mod.SentinelDeps(
        now_epoch=lambda: 1000.0,
        hostname=lambda: "central-test",
        pull_probe=lambda _spec, *_: {"reachable": False, "healthy": False, "class": "unreachable"},
        reachability_oracle=lambda: "bad",
    )
    result = _mod.run_once(_config(tmp_path / "invalid", hosts, hysteresis_cycles=1), invalid_deps)
    assert result["reachabilityOracle"] == {"configured": True, "reachable": None, "class": "invalid_oracle"}


def test_default_config_env_and_main_exit_codes(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS", "bad")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_ORACLE", str(tmp_path / "oracle.json"))
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR", str(tmp_path / "actions"))
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_Q_HOST", "q-custom")
    config = _mod.default_config(tmp_path / "hosts.json", tmp_path / "state")
    assert config.heartbeat_max_age_seconds == _mod.DEFAULT_HEARTBEAT_MAX_AGE_SECONDS
    assert config.hysteresis_cycles == 1
    assert config.connectivity_hysteresis_cycles == 1
    assert config.oracle_path == tmp_path / "oracle.json"
    assert config.action_outbox_dir == tmp_path / "actions"
    assert config.max_tier1_heal_candidates == 1
    assert config.correlated_drift_freeze_threshold == 1
    assert config.max_clock_skew_seconds == 1
    assert config.action_event_cooldown_seconds == 1
    assert config.max_critical_whatsapp_per_day == 1
    assert config.tier2_token_ttl_seconds == 60
    assert config.q_host == "q-custom"

    healthy_hb = _heartbeat(tmp_path / "healthy.json", healthy=True, mtime=1000.0)
    healthy_probe = _write_json(tmp_path / "healthy-probe.json", {"reachable": True, "healthy": True, "class": "healthy"})
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(healthy_hb), "probePath": str(healthy_probe)}])
    monkeypatch.setattr(_mod.time, "time", lambda: 1000.0)
    monkeypatch.setattr(_mod.socket, "gethostname", lambda: "central-main")
    # Keep the P0-2 instance lock inside tmp_path (not ~/.local/state).
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_LOCK", str(tmp_path / "sentinel-instance.lock"))
    assert _mod.main(["--hosts", str(hosts), "--state-dir", str(tmp_path / "state-main")]) == 0
    assert '"fleetAction": "none"' in capsys.readouterr().out

    bad_hb = _heartbeat(tmp_path / "bad.json", healthy=False, klass="permission_denied", mtime=1000.0)
    bad_probe = _write_json(tmp_path / "bad-probe.json", {"reachable": True, "healthy": False, "class": "permission_denied"})
    bad_hosts = _hosts_file(tmp_path / "bad-hosts", [{"host": "host-d", "heartbeatPath": str(bad_hb), "probePath": str(bad_probe)}])
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES", "1")
    assert _mod.main(["--hosts", str(bad_hosts), "--state-dir", str(tmp_path / "state-bad")]) == 1

    assert _mod.main(["--hosts", str(tmp_path / "missing.json"), "--state-dir", str(tmp_path / "state-error")]) == 2
    assert "fleet_sentinel_error" in capsys.readouterr().err


def test_parse_args_defaults_and_default_deps(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", "/tmp/fleet-state")
    monkeypatch.delenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", raising=False)
    default_args = _mod.parse_args([])
    assert default_args.hosts == str(_mod.REPO_ROOT / "deploy" / "bot-errors-expected-fleet.json")
    assert default_args.state_dir == "/tmp/fleet-state"

    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", "/tmp/fleet-hosts.json")
    args = _mod.parse_args([])
    assert args.hosts == "/tmp/fleet-hosts.json"
    assert args.state_dir == "/tmp/fleet-state"
    deps = _mod.default_deps()
    assert isinstance(deps.hostname(), str)


def test_save_state_runs_even_if_central_heartbeat_write_raises(tmp_path: Path, monkeypatch):
    """
    REGRESSION (P0-1): save_state must run in a finally block so that state
    mutations from emit_action_events are persisted even when save_central_heartbeat
    raises.  After the fix, run_once also stamps state["cycleSeq"] before calling
    emit_action_events; that field must appear in the persisted state file.

    Without the fix:
    - state["cycleSeq"] is never written, so the persisted state file lacks it.
    - The assertion below therefore fails before the fix.

    With the fix:
    - state["cycleSeq"] is incremented before emit, then persisted in the finally
      block even when save_central_heartbeat raises.
    - qRemediation is cleared (emit mutation) and cycleSeq >= 1 in the saved file.
    """
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=False, klass="out_of_rotation", mtime=995.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-q", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, action_event_cooldown_seconds=3600)
    _mod.atomic_write_json(
        _mod.state_path(config),
        {
            "schemaVersion": 1,
            "hosts": {},
            "qRemediation": {
                "requestId": "req-save-test",
                "host": "host-q",
                "actionHash": "ah-save-test",
                "expiresAtEpoch": 800.0,
            },
        },
    )

    monkeypatch.setattr(
        _mod,
        "save_central_heartbeat",
        lambda *a, **kw: (_ for _ in ()).throw(OSError("disk full")),
    )

    with pytest.raises(OSError, match="disk full"):
        _mod.run_once(config, _deps(1000.0, {"host-q": {"reachable": True, "healthy": False, "class": "out_of_rotation"}}))

    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))

    # P0-1 fix: cycleSeq must be present and >= 1 in the persisted state.
    # This assertion fails before the fix because cycleSeq is never set.
    assert isinstance(state.get("cycleSeq"), int) and state["cycleSeq"] >= 1, (
        "cycleSeq was not written to persisted state — save_state did not run in "
        "finally with the post-emit state (P0-1 fix missing)"
    )

    # qRemediation must be cleared (emit_action_events mutation persisted).
    assert "qRemediation" not in state or state.get("qRemediation") == {}, (
        "qRemediation was not cleared in persisted state after emit — "
        "save_state did not capture post-emit mutations (P0-1 fix missing)"
    )


def test_cycle_seq_increments_and_appears_in_state(tmp_path: Path):
    """cycleSeq must advance by 1 each call and be written to persistent state."""
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=999.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts)

    _mod.run_once(config, _deps(1000.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))
    state1 = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    seq1 = state1.get("cycleSeq")
    assert isinstance(seq1, int) and seq1 >= 1

    _mod.run_once(config, _deps(1001.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))
    state2 = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state2.get("cycleSeq") == seq1 + 1


# --- P0-9: probe staleness blind spot ---------------------------------------
# A file-based probe is read for its payload with no mtime gate, so a probe
# written hours ago that still says {"healthy": true} is trusted as a live
# signal. heartbeat_inventory already rejects stale heartbeats by st_mtime;
# the probe path must apply the same age gate or it can mask a stale heartbeat
# and suppress the two-signal escalation. These tests fail before the fix.


def test_probe_path_stale_mtime_rejected(tmp_path: Path):
    """A probe file older than the host's max-age window must be classified
    probe_stale, not passed through as healthy. Before fix: returns healthy."""
    probe_file = tmp_path / "probe.json"
    probe_file.write_text(
        '{"reachable": true, "healthy": true, "class": "healthy"}',
        encoding="utf-8",
    )
    now = 1_000_000.0
    stale_mtime = now - (13 * 60 * 60)  # 13h ago, far beyond the 45m window
    os.utime(probe_file, (stale_mtime, stale_mtime))

    spec = _mod.HostSpec(host="host-a", probe_path=probe_file)
    result = _mod.default_pull_probe(spec, now=now)
    assert result["class"] == "probe_stale", f"expected probe_stale, got {result}"
    assert result.get("healthy") is False
    assert result.get("reachable") is False
    assert result["ageSeconds"] > _mod.DEFAULT_HEARTBEAT_MAX_AGE_SECONDS


def test_probe_path_fresh_mtime_accepted(tmp_path: Path):
    """A probe file with recent mtime must still be returned as healthy."""
    probe_file = tmp_path / "probe.json"
    probe_file.write_text(
        '{"reachable": true, "healthy": true, "class": "healthy"}',
        encoding="utf-8",
    )
    now = 1_000_000.0
    fresh_mtime = now - 60  # 1 minute ago
    os.utime(probe_file, (fresh_mtime, fresh_mtime))

    spec = _mod.HostSpec(host="host-a", probe_path=probe_file)
    result = _mod.default_pull_probe(spec, now=now)
    assert result["class"] == "healthy"
    assert result.get("healthy") is True


def test_probe_path_no_now_preserves_legacy_passthrough(tmp_path: Path):
    """Calling default_pull_probe without `now` (legacy callers) keeps the old
    no-gate behavior so existing direct unit tests are unaffected."""
    probe_file = tmp_path / "probe.json"
    probe_file.write_text(
        '{"reachable": true, "healthy": true, "class": "healthy"}',
        encoding="utf-8",
    )
    os.utime(probe_file, (1.0, 1.0))  # ancient, but no `now` => no gate
    spec = _mod.HostSpec(host="host-a", probe_path=probe_file)
    assert _mod.default_pull_probe(spec)["class"] == "healthy"


def test_stale_probe_prevents_healthy_classification(tmp_path: Path):
    """End-to-end via run_once with the real default_pull_probe: a stale probe
    file plus a fresh healthy heartbeat must NOT classify the host as healthy.
    Before fix: stale probe reads healthy, two-signal fires -> class=healthy."""
    now = 1_000_000.0
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, klass="healthy", mtime=now - 30)
    probe_file = tmp_path / "host-a-probe.json"
    probe_file.write_text(
        '{"reachable": true, "healthy": true, "class": "healthy"}',
        encoding="utf-8",
    )
    os.utime(probe_file, (now - 13 * 3600, now - 13 * 3600))

    hosts = _hosts_file(
        tmp_path,
        [{"host": "host-a", "heartbeatPath": str(hb), "probePath": str(probe_file)}],
    )
    config = _config(tmp_path, hosts, heartbeat_max_age_seconds=60)
    deps = _mod.SentinelDeps(
        now_epoch=lambda: now,
        hostname=lambda: "central-test",
        pull_probe=_mod.default_pull_probe,
        reachability_oracle=lambda: {"configured": False, "reachable": True, "class": "not_configured"},
    )
    report = _mod.run_once(config, deps)
    host_result = report["hosts"][0]
    assert host_result["class"] != "healthy", (
        f"stale probe must not yield healthy, got {host_result['class']}"
    )
    assert host_result["probe"]["class"] == "probe_stale"


# --- P0-5: correlated-drift freeze off-by-one (`>` vs `>=`) ------------------
# correlated_drift_freeze_threshold means "freeze when this many or more hosts
# share a drift class." With `>`, a 2-host fleet at threshold 2 needs THREE
# hosts before the freeze fires, so two correlated drifters heal concurrently —
# exactly what the freeze exists to prevent.


def test_p05_correlated_drift_freeze_fires_at_threshold(tmp_path: Path):
    """Two tier1 heal candidates sharing a drift class, threshold==2.
    Before fix (>): 2 > 2 is False -> no freeze -> returns None. FAILS.
    After fix (>=): 2 >= 2 is True -> freeze fires. PASSES."""
    hosts = _hosts_file(tmp_path, [])
    config = _config(tmp_path, hosts)  # correlated_drift_freeze_threshold default 2
    host_state = {
        "host-a": _mod.default_host_record(),
        "host-b": _mod.default_host_record(),
    }
    results = [
        {"host": "host-a", "action": "tier1_heal_candidate", "probe": {"class": "drift"}, "heartbeat": {"class": "drift"}},
        {"host": "host-b", "action": "tier1_heal_candidate", "probe": {"class": "drift"}, "heartbeat": {"class": "drift"}},
    ]
    fleet_action = _mod.apply_tier1_bounds(results, host_state, config)
    assert fleet_action == "correlated_runtime_drift_freeze", (
        f"expected correlated_runtime_drift_freeze, got {fleet_action!r}"
    )
    for result in results:
        assert result["action"] == "freeze_correlated_drift", (
            f"host {result['host']!r} action={result['action']!r}, expected freeze_correlated_drift"
        )


def test_p05_below_threshold_does_not_freeze(tmp_path: Path):
    """A single drifter at threshold 2 must NOT freeze (guards the >= edge)."""
    hosts = _hosts_file(tmp_path, [])
    config = _config(tmp_path, hosts)
    host_state = {"host-a": _mod.default_host_record()}
    results = [
        {"host": "host-a", "action": "tier1_heal_candidate", "probe": {"class": "drift"}, "heartbeat": {"class": "drift"}},
    ]
    assert _mod.apply_tier1_bounds(results, host_state, config) is None
    assert results[0]["action"] == "tier1_heal_candidate"


# --- P0-6: mass_unreachable_confirmed must suppress tier1 heal candidates ----
# The mass_unreachable_confirmed branch set the fleet action but never mutated
# per-host actions, so a host that cleared hysteresis into tier1_heal_candidate
# would still fire a heal during a fleet-wide outage — the worst possible time.


def test_p06_mass_unreachable_suppresses_tier1_heal_candidate(tmp_path: Path):
    """3-host fleet: 2 out_of_rotation (stale hb + unreachable probe) trip
    mass_out_of_rotation; 1 fresh safe_runtime_drift host clears hysteresis to
    tier1_heal_candidate. Before fix: that host keeps tier1_heal_candidate during
    the outage. After fix: it is suppressed to defer_mass_unreachable."""
    hb_a = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=100.0)  # stale -> out_of_rotation
    hb_b = _heartbeat(tmp_path / "host-b-hb.json", healthy=True, mtime=100.0)  # stale -> out_of_rotation
    hb_c = _heartbeat(tmp_path / "host-c-hb.json", healthy=False, klass="drift", mtime=995.0)  # fresh drift
    hosts = _hosts_file(
        tmp_path,
        [
            {"host": "host-a", "heartbeatPath": str(hb_a)},
            {"host": "host-b", "heartbeatPath": str(hb_b)},
            {"host": "host-c", "heartbeatPath": str(hb_c)},
        ],
    )
    probes = {
        "host-a": {"reachable": False, "healthy": False, "class": "unreachable"},
        "host-b": {"reachable": False, "healthy": False, "class": "unreachable"},
        "host-c": {"reachable": True, "healthy": False, "class": "drift"},
    }
    config = _config(tmp_path, hosts, hysteresis_cycles=1, connectivity_hysteresis_cycles=1)
    result = _mod.run_once(config, _deps(1000.0, probes))

    assert result["fleetAction"] == "mass_unreachable_confirmed"
    actions = {host["host"]: host["action"] for host in result["hosts"]}
    # Precondition sanity: without the outage host-c would be a heal candidate.
    assert actions["host-c"] == "defer_mass_unreachable", (
        f"host-c must be suppressed during mass outage, got actions={actions}"
    )
    assert actions["host-a"] == "escalate", f"host-a unchanged, got {actions}"
    assert actions["host-b"] == "escalate", f"host-b unchanged, got {actions}"


# --- P0-2: sentinel instance lock prevents concurrent launchd copies ---------
# launchd KeepAlive(SuccessfulExit:false) + StartInterval can start a second
# copy while a slow cycle is still running; with no mutex both copies write
# state and emit duplicate action events. main() now takes an flock and a
# contended copy exits 0 (so KeepAlive does not restart it).


def test_instance_lock_prevents_concurrent_run(tmp_path: Path, monkeypatch):
    """A second main() while the lock is held exits 0 with skipped=already_running
    and never calls run_once."""
    import fcntl
    lock_path = tmp_path / "sentinel-instance.lock"
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_LOCK", str(lock_path))

    def _boom(*_a, **_k):
        raise AssertionError("run_once must not be called while another instance holds the lock")

    monkeypatch.setattr(_mod, "run_once", _boom)

    held = os.open(str(lock_path), os.O_CREAT | os.O_WRONLY, 0o600)
    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.write(held, f"{os.getpid()}\n".encode())
    try:
        rc = _mod.main(["--hosts", str(tmp_path / "hosts.json"), "--state-dir", str(tmp_path / "state")])
        assert rc == 0, "a contended instance must exit 0 so KeepAlive does not restart it"
    finally:
        fcntl.flock(held, fcntl.LOCK_UN)
        os.close(held)


def test_instance_lock_released_after_normal_run(tmp_path: Path, monkeypatch):
    """After main() finishes, the lock file persists (#2474: the pathname is not
    unlinked, only the flock is released) and is immediately re-acquirable."""
    import fcntl
    lock_path = tmp_path / "sentinel-instance.lock"
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_LOCK", str(lock_path))
    monkeypatch.setattr(
        _mod,
        "run_once",
        lambda config: {"schemaVersion": 1, "checkedAt": "2026-01-01T00:00:00Z", "fleetAction": "none", "hosts": [], "actionEvents": []},
    )
    rc = _mod.main(["--hosts", str(tmp_path / "hosts.json"), "--state-dir", str(tmp_path / "state")])
    assert rc == 0
    assert lock_path.exists(), "lock pathname must persist after a normal run (#2474)"
    # A fresh holder must be able to take the lock immediately.
    fd = os.open(str(lock_path), os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def test_instance_lock_preserves_inode_identity_across_handoff(tmp_path: Path, monkeypatch):
    """#2474 regression: main()'s finally must not unlink the instance-lock
    pathname after releasing the flock. Deleting it would let a fresh acquirer
    create a brand-new inode at the same path, and a contender that had already
    opened the OLD inode before the unlink could hold a live lock independent of
    a later contender's lock on the NEW inode -- the issue's deterministic
    canary reproduced exactly that split (``second_holder_live=True,
    third_holder_live=True, split_inode=True``). This proves the fixed finally
    block keeps a single, stable inode across the release/reacquire handoff and
    that a third contender racing in while the new holder is live is blocked on
    the SAME inode rather than free to create a second, independent lock."""
    import fcntl
    lock_path = tmp_path / "sentinel-instance.lock"
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_LOCK", str(lock_path))
    monkeypatch.setattr(
        _mod,
        "run_once",
        lambda config: {"schemaVersion": 1, "checkedAt": "2026-01-01T00:00:00Z", "fleetAction": "none", "hosts": [], "actionEvents": []},
    )
    rc = _mod.main(["--hosts", str(tmp_path / "hosts.json"), "--state-dir", str(tmp_path / "state")])
    assert rc == 0
    assert lock_path.exists(), "the pathname must survive a normal run (identity must not change hands)"
    inode_a = lock_path.stat().st_ino

    fd_b = os.open(str(lock_path), os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        fcntl.flock(fd_b, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert lock_path.stat().st_ino == inode_a, "handoff must reuse the original inode, never a fresh one"

        # A third contender racing in while B is live must be blocked on the
        # SAME inode -- not free to create and lock a brand-new inode at the
        # same path, which is exactly the split-inode condition #2474 describes.
        fd_c = os.open(str(lock_path), os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            with pytest.raises(OSError):
                fcntl.flock(fd_c, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd_c)
        assert lock_path.stat().st_ino == inode_a, "a blocked contender must not have replaced the inode"
    finally:
        fcntl.flock(fd_b, fcntl.LOCK_UN)
        os.close(fd_b)


def test_instance_lock_path_default_derives_from_state_root(monkeypatch):
    """#2436: with no explicit BOT_ERRORS_FLEET_SENTINEL_LOCK, the default must
    move with state_root() (i.e. with BOT_ERRORS_FLEET_SENTINEL_STATE_DIR), not
    a literal baked independently of it -- otherwise two sentinels pointed at
    different state roots would contend on the same lock file."""
    monkeypatch.delenv("BOT_ERRORS_FLEET_SENTINEL_LOCK", raising=False)
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", "/tmp/state-root-a/fleet-sentinel")
    assert _mod._instance_lock_path() == _mod.state_root() / "sentinel-instance.lock"
    assert str(_mod._instance_lock_path()) == "/tmp/state-root-a/fleet-sentinel/sentinel-instance.lock"

    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", "/tmp/state-root-b/fleet-sentinel")
    assert str(_mod._instance_lock_path()) == "/tmp/state-root-b/fleet-sentinel/sentinel-instance.lock", (
        "the lock default must move with state_root(), not stay pinned to the first-seen value"
    )


def test_instance_lock_path_explicit_override_still_wins(monkeypatch):
    """An explicit BOT_ERRORS_FLEET_SENTINEL_LOCK must take precedence over the
    state_root()-derived default."""
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", "/tmp/state-root-a/fleet-sentinel")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_LOCK", "/tmp/explicit-lock/sentinel-instance.lock")
    assert str(_mod._instance_lock_path()) == "/tmp/explicit-lock/sentinel-instance.lock"


# --- SENT-B2: unbounded action outbox ---------------------------------------
# The action outbox accumulates one file per emitted action with no consumer or
# pruner, so inode/disk usage grows without bound. A cycle-end retention sweep
# must keep only the newest N files by mtime and report the current depth.


def test_prune_action_outbox_keeps_newest_n_by_mtime(tmp_path: Path):
    hosts = _hosts_file(tmp_path, [{"host": "host-a"}])
    config = _config(tmp_path, hosts, action_outbox_retention=3)
    outbox = _mod.action_outbox_dir(config)
    outbox.mkdir(parents=True, exist_ok=True)
    # 10 action files, oldest -> newest by mtime.
    for index in range(10):
        path = outbox / f"{1000 + index}-host-host-a-escalate-{index:04d}.json"
        _mod.atomic_write_json(path, {"schemaVersion": 1, "seq": index})
        os.utime(path, (1000 + index, 1000 + index))

    depth = _mod.prune_action_outbox(config)

    remaining = sorted(p.name for p in outbox.glob("*.json"))
    assert len(remaining) == 3, remaining
    assert depth == 3
    # The three newest (highest mtime) survive.
    assert remaining == [
        "1007-host-host-a-escalate-0007.json",
        "1008-host-host-a-escalate-0008.json",
        "1009-host-host-a-escalate-0009.json",
    ]


def test_prune_action_outbox_missing_dir_returns_zero(tmp_path: Path):
    hosts = _hosts_file(tmp_path, [{"host": "host-a"}])
    config = _config(tmp_path, hosts)
    # Outbox directory never created -> depth 0, no error.
    assert not _mod.action_outbox_dir(config).exists()
    assert _mod.prune_action_outbox(config) == 0


def test_prune_action_outbox_survives_stat_and_unlink_errors(tmp_path: Path, monkeypatch):
    hosts = _hosts_file(tmp_path, [{"host": "host-a"}])
    config = _config(tmp_path, hosts, action_outbox_retention=1)
    outbox = _mod.action_outbox_dir(config)
    outbox.mkdir(parents=True, exist_ok=True)
    paths = []
    for index in range(3):
        path = outbox / f"{1000 + index}-host-host-a-escalate-{index:04d}.json"
        _mod.atomic_write_json(path, {"schemaVersion": 1, "seq": index})
        os.utime(path, (1000 + index, 1000 + index))
        paths.append(path)

    real_stat = Path.stat

    def flaky_stat(self, *args, **kwargs):
        # Break st_mtime lookup only inside the sort key (full filename),
        # exercising the mtime=0.0 fallback while leaving is_file() intact.
        if self.name == paths[0].name:
            raise OSError("stat blocked")
        return real_stat(self, *args, **kwargs)

    def blocked_unlink(self, *args, **kwargs):
        raise OSError("unlink blocked")

    monkeypatch.setattr(Path, "stat", flaky_stat)
    monkeypatch.setattr(Path, "unlink", blocked_unlink)

    # stat failure on one entry falls back to mtime 0.0; unlink failures are
    # swallowed. The call must not raise and reports the capped depth.
    depth = _mod.prune_action_outbox(config)
    assert depth == 1
    # All files remain because unlink was blocked, but the call did not raise.
    monkeypatch.undo()
    assert len(list(outbox.glob("*.json"))) == 3


def test_run_once_prunes_outbox_and_reports_depth(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=999.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, action_outbox_retention=2)
    outbox = _mod.action_outbox_dir(config)
    outbox.mkdir(parents=True, exist_ok=True)
    # Pre-seed the outbox above the retention cap with stale action files.
    for index in range(6):
        path = outbox / f"{500 + index}-host-host-a-escalate-{index:04d}.json"
        _mod.atomic_write_json(path, {"schemaVersion": 1, "seq": index})
        os.utime(path, (500 + index, 500 + index))

    result = _mod.run_once(
        config,
        _deps(1000.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}),
    )

    surviving = list(outbox.glob("*.json"))
    assert len(surviving) == 2, [p.name for p in surviving]
    assert result["actionOutboxDepth"] == 2


# --- F1/T1: Tier-2 remediation token single-use enforcement -------------------


def _issue_tier2_token(tmp_path: Path, monkeypatch, *, token: str = "fixed-token", ttl: int = 900):
    """Drive run_once to issue a real Tier-2 q-remediation token and return
    (config, remediation_payload, state_dict). The qRemediation record carries
    an authentic tokenHash bound to the raw token + host + actionHash + requestId."""
    hb = _heartbeat(tmp_path / "host-q-hb.json", healthy=False, klass="permission_denied", mtime=995.0)
    q_hb = _heartbeat(tmp_path / "q-agent-host-hb.json", healthy=True, klass="healthy", mtime=995.0)
    hosts = _hosts_file(
        tmp_path,
        [
            {"host": "host-q", "heartbeatPath": str(hb)},
            {"host": "q-agent-host", "heartbeatPath": str(q_hb)},
        ],
    )
    config = _config(tmp_path, hosts, hysteresis_cycles=1, tier2_token_ttl_seconds=ttl, q_host="q-agent-host")
    monkeypatch.setattr(_mod.secrets, "token_urlsafe", lambda _length: token)
    result = _mod.run_once(
        config,
        _deps(
            1000.0,
            {
                "host-q": {"reachable": True, "healthy": False, "class": "permission_denied"},
                "q-agent-host": {"reachable": True, "healthy": True, "class": "healthy"},
            },
        ),
    )
    payload = json.loads(Path(result["actionEvents"][0]["path"]).read_text(encoding="utf-8"))
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    return config, payload["remediation"], state


def test_fresh_token_redeems_once_and_stamps_redeemed_at(tmp_path: Path, monkeypatch):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch)
    state = _mod.load_state(config)
    outcome = _mod.redeem_q_remediation(state, 1500.0, remediation["requestId"], remediation["token"])
    assert outcome["redeemed"] is True
    assert outcome["reason"] == "redeemed"
    assert outcome["requestId"] == remediation["requestId"]
    assert outcome["host"] == "host-q"
    assert outcome["redeemedAt"] == _mod.now_iso(1500.0)
    # redeemedAt is stamped on the in-memory record.
    assert state["qRemediation"]["redeemedAt"] == _mod.now_iso(1500.0)
    # A redeemed record is honored by both consumption sites → no longer active.
    assert _mod.active_q_remediation(state, 1500.0) is None


def test_redeemed_token_replay_is_rejected(tmp_path: Path, monkeypatch):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch)
    state = _mod.load_state(config)
    first = _mod.redeem_q_remediation(state, 1500.0, remediation["requestId"], remediation["token"])
    assert first["redeemed"] is True
    # Replay the SAME token against the SAME record → denied (single-use).
    replay = _mod.redeem_q_remediation(state, 1501.0, remediation["requestId"], remediation["token"])
    assert replay["redeemed"] is False
    assert replay["reason"] == "already_redeemed"
    assert replay["redeemedAt"] == first["redeemedAt"]


def test_redeem_is_idempotent_does_not_advance_redeemed_at(tmp_path: Path, monkeypatch):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch)
    state = _mod.load_state(config)
    first = _mod.redeem_q_remediation(state, 1500.0, remediation["requestId"], remediation["token"])
    second = _mod.redeem_q_remediation(state, 9999.0, remediation["requestId"], remediation["token"])
    # The stamp is not overwritten by a later replay; first redemption wins.
    assert second["redeemed"] is False
    assert state["qRemediation"]["redeemedAt"] == first["redeemedAt"] == _mod.now_iso(1500.0)


def test_redeem_rejects_wrong_token_and_does_not_stamp(tmp_path: Path, monkeypatch):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch)
    state = _mod.load_state(config)
    outcome = _mod.redeem_q_remediation(state, 1500.0, remediation["requestId"], "not-the-token")
    assert outcome["redeemed"] is False
    assert outcome["reason"] == "token_mismatch"
    assert "redeemedAt" not in state["qRemediation"]
    # The genuine token still works afterward (a forged attempt must not consume it).
    good = _mod.redeem_q_remediation(state, 1500.0, remediation["requestId"], remediation["token"])
    assert good["redeemed"] is True


def test_redeem_rejects_request_id_mismatch(tmp_path: Path, monkeypatch):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch)
    state = _mod.load_state(config)
    outcome = _mod.redeem_q_remediation(state, 1500.0, "wrong-request-id", remediation["token"])
    assert outcome["redeemed"] is False
    assert outcome["reason"] == "request_id_mismatch"
    assert "redeemedAt" not in state["qRemediation"]


def test_redeem_fail_closed_on_missing_record():
    assert _mod.redeem_q_remediation({}, 1500.0, "rid", "tok") == {
        "redeemed": False,
        "reason": "no_active_remediation",
    }
    assert _mod.redeem_q_remediation({"qRemediation": {}}, 1500.0, "rid", "tok")["reason"] == "no_active_remediation"


def test_redeem_fail_closed_on_corrupt_record():
    state = {"qRemediation": ["corrupt"]}
    outcome = _mod.redeem_q_remediation(state, 1500.0, "rid", "tok")
    assert outcome == {"redeemed": False, "reason": "no_active_remediation"}
    # Structurally-corrupt slot is dropped (mirrors active_q_remediation).
    assert "qRemediation" not in state


def test_redeem_fail_closed_on_corrupt_token_hash():
    state = {
        "qRemediation": {
            "requestId": "rid",
            "host": "host-q",
            "actionHash": "ah",
            "expiresAtEpoch": 9000.0,
        }
    }
    outcome = _mod.redeem_q_remediation(state, 1500.0, "rid", "tok")
    assert outcome == {"redeemed": False, "reason": "corrupt_token_hash"}


def test_redeem_rejects_expired_token(tmp_path: Path, monkeypatch):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch, ttl=900)
    state = _mod.load_state(config)
    # now is past expiresAtEpoch (issued at 1000.0 + 900 = 1900.0).
    outcome = _mod.redeem_q_remediation(state, 5000.0, remediation["requestId"], remediation["token"])
    assert outcome["redeemed"] is False
    assert outcome["reason"] == "expired"
    assert "redeemedAt" not in state["qRemediation"]


def test_run_redeem_persists_only_on_success(tmp_path: Path, monkeypatch):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch)
    monkeypatch.setattr(_mod.time, "time", lambda: 1500.0)
    # Rejection path: state file is NOT mutated.
    before = _mod.state_path(config).read_text(encoding="utf-8")
    rej = _mod.run_redeem(config, remediation["requestId"], "wrong-token")
    assert rej["redeemed"] is False
    assert _mod.state_path(config).read_text(encoding="utf-8") == before
    # Success path: redeemedAt is durably persisted.
    ok = _mod.run_redeem(config, remediation["requestId"], remediation["token"])
    assert ok["redeemed"] is True
    assert ok["redeemedAt"] == _mod.now_iso(1500.0)
    persisted = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert persisted["qRemediation"]["redeemedAt"] == _mod.now_iso(1500.0)


def test_main_redeem_cli_accepts_then_rejects_replay(tmp_path: Path, monkeypatch, capsys):
    config, remediation, _ = _issue_tier2_token(tmp_path, monkeypatch)
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_LOCK", str(tmp_path / "sentinel-instance.lock"))
    # Redemption happens inside the token TTL (issued at 1000.0, ttl 900 → 1900.0).
    monkeypatch.setattr(_mod.time, "time", lambda: 1500.0)
    state_dir = str(config.state_dir)
    hosts = str(config.hosts_path)
    argv = [
        "--hosts", hosts,
        "--state-dir", state_dir,
        "--redeem-token", remediation["token"],
        "--redeem-request-id", remediation["requestId"],
    ]
    rc_first = _mod.main(argv)
    out_first = json.loads(capsys.readouterr().out)
    assert rc_first == 0
    assert out_first["redeemed"] is True
    assert out_first["kind"] == "bot-errors-sentinel-redeem"
    # Replay through the CLI is rejected with a non-zero exit.
    rc_second = _mod.main(argv)
    out_second = json.loads(capsys.readouterr().out)
    assert rc_second == 1
    assert out_second["redeemed"] is False
    assert out_second["reason"] == "already_redeemed"


def test_main_redeem_requires_both_token_and_request_id(tmp_path: Path, capsys):
    rc = _mod.main(["--state-dir", str(tmp_path / "state"), "--redeem-token", "tok"])
    err = json.loads(capsys.readouterr().err)
    assert rc == 2
    assert err["reason"] == "redeem_requires_token_and_request_id"
    assert err["redeemed"] is False


def test_parse_args_redeem_flags_default_none():
    args = _mod.parse_args([])
    assert args.redeem_token is None
    assert args.redeem_request_id is None
    parsed = _mod.parse_args(["--redeem-token", "t", "--redeem-request-id", "r"])
    assert parsed.redeem_token == "t"
    assert parsed.redeem_request_id == "r"


def _fleet_roster_file(tmp_path: Path, hosts: list[dict]) -> Path:
    return _write_json(tmp_path / "expected-fleet.json", {"schemaVersion": 1, "hosts": hosts})


def test_central_heartbeat_binds_roster_digest_epoch_and_counts(tmp_path: Path):
    """#1875: the heartbeat binds a roster digest+epoch and reports expected /
    observed / problem / unknown counts for hosts AND runtime-relevant instances."""
    hb_a = _heartbeat(tmp_path / "a-hb.json", healthy=True, mtime=1000.0)
    hb_b = _heartbeat(tmp_path / "b-hb.json", healthy=True, mtime=1000.0)
    roster = _fleet_roster_file(
        tmp_path,
        [
            {
                "host": "host-a",
                "role": "bot-host",
                "collectorRemote": True,
                "heartbeatPath": str(hb_a),
                "instances": [
                    {"name": "bot1", "expected": "always_on", "service": "s1"},
                    {"name": "bot2", "expected": "always_on", "service": "s2"},
                ],
            },
            {
                "host": "host-b",
                "role": "relay-only",
                "collectorRemote": True,
                "heartbeatPath": str(hb_b),
                "instances": [{"name": "agent", "expected": "none"}],
            },
        ],
    )
    config = _config(tmp_path, roster)
    probes = {
        "host-a": {"reachable": True, "healthy": True, "class": "healthy"},
        "host-b": {"reachable": True, "healthy": True, "class": "healthy"},
    }
    _mod.run_once(config, _deps(1010.0, probes))

    heartbeat = json.loads(_mod.heartbeat_path(config).read_text(encoding="utf-8"))
    roster_data = json.loads(roster.read_text(encoding="utf-8"))
    assert heartbeat["rosterDigest"] == _roster_lib.roster_digest(roster_data)
    assert len(heartbeat["rosterDigest"]) == 64
    assert heartbeat["rosterEpoch"] == int(roster.stat().st_mtime)
    assert heartbeat["expectedHostCount"] == 2
    assert heartbeat["observedHostCount"] == 2
    assert heartbeat["unknownHostCount"] == 0
    # Runtime-relevant instances exclude the expected==none relay row on host-b.
    assert heartbeat["expectedInstanceCount"] == 2
    assert heartbeat["observedInstanceCount"] == 2
    assert heartbeat["problemInstanceCount"] == 0
    assert heartbeat["unknownInstanceCount"] == 0
    assert heartbeat["healthy"] is True


def test_unknown_host_is_explicit_and_blocks_green(tmp_path: Path):
    """#1875: a host with no configured heartbeat and no probe is UNKNOWN
    (insufficient_data), not folded into healthy/absent, and it blocks green."""
    # Simple (non-fleet) host with no heartbeatPath -> heartbeat not_configured;
    # empty probe -> unknown; classify -> insufficient_data.
    hosts = _hosts_file(tmp_path, [{"host": "host-a"}])
    config = _config(tmp_path, hosts)
    result = _mod.run_once(config, _deps(1010.0, {}))

    assert result["hosts"][0]["class"] == "insufficient_data"
    heartbeat = json.loads(_mod.heartbeat_path(config).read_text(encoding="utf-8"))
    assert heartbeat["expectedHostCount"] == 1
    assert heartbeat["unknownHostCount"] == 1
    assert heartbeat["observedHostCount"] == 0
    assert heartbeat["expectedInstanceCount"] == 0
    assert heartbeat["healthy"] is False


def test_problem_host_instances_counted_as_problem(tmp_path: Path):
    """#1875: runtime-relevant instances on a problem host are counted as
    problem/observed (not healthy, not unknown)."""
    bad_hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=False, klass="runtime_verify_failed", mtime=1000.0)
    roster = _fleet_roster_file(
        tmp_path,
        [
            {
                "host": "host-a",
                "role": "bot-host",
                "collectorRemote": True,
                "heartbeatPath": str(bad_hb),
                "instances": [
                    {"name": "bot1", "expected": "always_on", "service": "s1"},
                    {"name": "bot2", "expected": "always_on", "service": "s2"},
                ],
            },
        ],
    )
    config = _config(tmp_path, roster)
    probes = {"host-a": {"reachable": True, "healthy": False, "class": "runtime_verify_failed"}}
    _mod.run_once(config, _deps(1010.0, probes))

    heartbeat = json.loads(_mod.heartbeat_path(config).read_text(encoding="utf-8"))
    assert heartbeat["expectedInstanceCount"] == 2
    assert heartbeat["problemInstanceCount"] == 2
    assert heartbeat["observedInstanceCount"] == 2
    assert heartbeat["unknownInstanceCount"] == 0
    assert heartbeat["healthy"] is False


def test_unreadable_roster_is_not_bound_and_blocks_green(tmp_path: Path, monkeypatch):
    """#1875: if the roster cannot be independently loaded the heartbeat is not
    roster-bound and must not be green (fail-closed)."""
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=1000.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts)

    def boom(_path):
        raise _mod.RosterError("cannot read roster")

    monkeypatch.setattr(_mod, "load_roster", boom)
    _mod.run_once(config, _deps(1010.0, {"host-a": {"reachable": True, "healthy": True, "class": "healthy"}}))

    heartbeat = json.loads(_mod.heartbeat_path(config).read_text(encoding="utf-8"))
    assert heartbeat["rosterDigest"] is None
    assert heartbeat["rosterEpoch"] is None
    assert heartbeat["healthy"] is False


# ---------------------------------------------------------------------------
# #1876 P1 — per-cycle operational counters (countable metrics)
# ---------------------------------------------------------------------------
def test_p1_compute_cycle_metrics_counts_actions():
    """The sentinel is evaluation-only, so per-cycle metrics count what it
    DECIDED (candidates/escalations/freezes/defers/q_unavailable), derived from
    the evaluated host results + emitted action events — not heal execution
    outcomes (which the selfcheck/deployer owns)."""
    results = [
        {"action": "tier1_heal_candidate", "class": "drift"},
        {"action": "escalate", "class": "unit_down"},
        {"action": "escalate_flapping", "class": "flapping"},
        {"action": "freeze_correlated_drift", "class": "drift"},
        {"action": "defer_mass_unreachable", "class": "out_of_rotation"},
        {"action": "defer_tier1_concurrency_cap", "class": "drift"},
        {"action": "none", "class": "healthy"},
    ]
    events = [
        {"scope": "host", "action": "tier1_heal_candidate"},
        {"scope": "host", "action": "escalate"},
        {"scope": "fleet", "action": "none"},
    ]
    m = _mod.compute_cycle_metrics(results, events)
    assert m["hostsEvaluated"] == 7
    assert m["healCandidates"] == 1
    assert m["escalations"] == 2  # escalate + escalate_flapping
    assert m["flapEscalations"] == 1
    assert m["correlatedDriftFreezes"] == 1
    assert m["massUnreachableDeferrals"] == 1
    assert m["concurrencyDeferrals"] == 1
    assert m["qUnavailable"] == 0
    assert m["actionEventsEmitted"] == 3
    # tier1_heal_candidate + escalate are in ATTENTION_ACTIONS; "none" is not.
    assert m["attentionEventsEmitted"] == 2
    assert m["byAction"]["none"] == 1
    assert m["byAction"]["tier1_heal_candidate"] == 1


def test_p1_run_once_result_and_heartbeat_carry_metrics(tmp_path: Path):
    hosts = _hosts_file(tmp_path, [{"host": "host-a"}])
    config = _config(tmp_path, hosts)
    result = _mod.run_once(config, _deps(1010.0, {}))
    assert "metrics" in result
    m = result["metrics"]
    assert m["hostsEvaluated"] == 1
    assert set(m).issuperset(
        {"healCandidates", "escalations", "qUnavailable", "byAction", "actionEventsEmitted"}
    )
    # Persisted to the central heartbeat so it is observable off-host.
    heartbeat = json.loads(_mod.heartbeat_path(config).read_text(encoding="utf-8"))
    assert heartbeat["metrics"]["hostsEvaluated"] == 1
