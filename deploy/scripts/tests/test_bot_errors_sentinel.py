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


def _write_json(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _heartbeat(path: Path, *, healthy: bool = True, klass: str = "healthy", mtime: float = 1000.0) -> Path:
    _write_json(
        path,
        {
            "kind": "bot-errors-selfcheck-heartbeat",
            "host": path.stem,
            "healthy": healthy,
            "class": klass,
            "action": "noop" if healthy else "hysteresis_wait",
            "pin": {"headSha": "a" * 40, "f10Sha": "b" * 64},
        },
    )
    os.utime(path, (mtime, mtime))
    return path


def _hosts_file(tmp_path: Path, hosts: list[dict]) -> Path:
    return _write_json(tmp_path / "hosts.json", {"schemaVersion": 1, "hosts": hosts})


def _config(tmp_path: Path, hosts_path: Path, **kwargs):
    return _mod.SentinelConfig(
        state_dir=tmp_path / "state",
        hosts_path=hosts_path,
        oracle_path=kwargs.get("oracle_path"),
        heartbeat_max_age_seconds=kwargs.get("heartbeat_max_age_seconds", 60),
        hysteresis_cycles=kwargs.get("hysteresis_cycles", 2),
        flap_window_seconds=kwargs.get("flap_window_seconds", 300),
        flap_threshold=kwargs.get("flap_threshold", 4),
        max_tier1_heal_candidates=kwargs.get("max_tier1_heal_candidates", 2),
        correlated_drift_freeze_threshold=kwargs.get("correlated_drift_freeze_threshold", 2),
    )


def _deps(now: float, probes: dict[str, dict], oracle: dict | None = None):
    return _mod.SentinelDeps(
        now_epoch=lambda: now,
        hostname=lambda: "central-test",
        pull_probe=lambda spec: probes.get(spec.host, {}),
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
    }
    assert host["ackPath"] == str(ack)
    assert result["heartbeatPath"] == str(_mod.heartbeat_path(config))
    state = json.loads(_mod.state_path(config).read_text(encoding="utf-8"))
    assert state["hosts"]["host-a"]["alertState"] == "closed"


def test_two_signal_unreachable_requires_hysteresis_then_escalates(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-h-hb.json", healthy=True, mtime=100.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-h", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=2)
    deps = _deps(1000.0, {"host-h": {"reachable": False, "healthy": False, "class": "unreachable"}})

    first = _mod.run_once(config, deps)["hosts"][0]
    assert first["class"] == "out_of_rotation"
    assert first["twoSignals"] is True
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


def test_correlated_safe_drift_freezes_fleet_autoheal(tmp_path: Path):
    hosts_payload = []
    probes = {}
    for name in ("host-a", "host-b", "host-c"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=False, klass="drift", mtime=995.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
        probes[name] = {"reachable": True, "healthy": False, "class": "drift"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    result = _mod.run_once(_config(tmp_path, hosts, hysteresis_cycles=1), _deps(1000.0, probes))
    assert result["fleetAction"] == "correlated_runtime_drift_freeze"
    assert {host["action"] for host in result["hosts"]} == {"freeze_correlated_drift"}
    assert {host["correlatedDriftClass"] for host in result["hosts"]} == {"drift"}
    state = json.loads(_mod.state_path(_config(tmp_path, hosts, hysteresis_cycles=1)).read_text(encoding="utf-8"))
    assert {record["lastAction"] for record in state["hosts"].values()} == {"freeze_correlated_drift"}


def test_tier1_candidate_count_is_capped_without_correlated_freeze(tmp_path: Path):
    classes = {"host-a": "drift", "host-b": "manifest_missing", "host-c": "drift"}
    hosts_payload = []
    probes = {}
    for name, klass in classes.items():
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=False, klass=klass, mtime=995.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
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
    for name in ("host-a", "host-b", "host-c"):
        hb = _heartbeat(tmp_path / f"{name}-hb.json", healthy=True, mtime=100.0)
        hosts_payload.append({"host": name, "heartbeatPath": str(hb)})
        probes[name] = {"reachable": False, "healthy": False, "class": "unreachable"}
    hosts = _hosts_file(tmp_path, hosts_payload)
    result = _mod.run_once(_config(tmp_path, hosts, hysteresis_cycles=1), _deps(1000.0, probes))
    assert result["fleetAction"] == "mass_unreachable_confirmed"
    assert {host["action"] for host in result["hosts"]} == {"escalate"}

    oracle_down = {"configured": True, "reachable": False, "class": "gateway_unreachable"}
    result = _mod.run_once(_config(tmp_path / "oracle-down", hosts, hysteresis_cycles=1), _deps(1000.0, probes, oracle_down))
    assert result["fleetAction"] == "central_connectivity_suspect"
    assert {host["action"] for host in result["hosts"]} == {"suppress_central_connectivity_suspect"}
    assert result["reachabilityOracle"] == oracle_down

    waiting = _mod.run_once(_config(tmp_path / "waiting", hosts, hysteresis_cycles=2), _deps(1000.0, probes, oracle_down))
    assert waiting["fleetAction"] == "central_connectivity_suspect"
    assert {host["action"] for host in waiting["hosts"]} == {"hysteresis_wait"}


def test_probe_path_default_and_bad_heartbeat_json(tmp_path: Path):
    probe = _write_json(tmp_path / "probe.json", {"reachable": True, "healthy": True, "class": "healthy"})
    spec = _mod.HostSpec(host="host-a", probe_path=probe)
    assert _mod.default_pull_probe(spec)["class"] == "healthy"

    bad_hb = tmp_path / "bad-heartbeat.json"
    bad_hb.write_text("{bad", encoding="utf-8")
    assert _mod.heartbeat_inventory(_mod.HostSpec(host="host-a", heartbeat_path=bad_hb), 1000.0, 60)["status"] == "invalid_json"

    missing_probe = _mod.default_pull_probe(_mod.HostSpec(host="host-b", probe_path=tmp_path / "missing.json"))
    assert missing_probe == {"reachable": False, "healthy": False, "class": "invalid_probe"}


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
    assert _mod.heartbeat_inventory(_mod.HostSpec(host="host-a"), 1000.0, 60) == {
        "configured": False,
        "signal": "unknown",
        "status": "not_configured",
    }
    missing_hb = _mod.heartbeat_inventory(_mod.HostSpec(host="host-a", heartbeat_path=tmp_path / "missing.json"), 1000.0, 60)
    assert missing_hb["status"] == "missing"
    assert missing_hb["signal"] == "stale"

    target = tmp_path / "heartbeat.json"
    target.write_text("{}", encoding="utf-8")
    original_stat = Path.stat

    def stat(path: Path):
        if path == target:
            raise PermissionError("denied")
        return original_stat(path)

    monkeypatch.setattr(Path, "stat", stat)
    stat_error = _mod.heartbeat_inventory(_mod.HostSpec(host="host-a", heartbeat_path=target), 1000.0, 60)
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
    assert _mod.parse_probe_stdout("\n[]\n{\"class\":\"healthy\"}\n") == {"class": "healthy"}
    assert _mod.parse_probe_stdout("\n") is None

    cases = [
        ({"signal": "unhealthy", "class": "permission_denied"}, {"signal": "unreachable", "class": "unreachable"}, "runtime_unverified"),
        ({"signal": "unhealthy", "class": "permission_denied"}, {"signal": "healthy", "class": "healthy"}, "heartbeat_unhealthy"),
        ({"signal": "healthy", "class": "healthy"}, {"signal": "unhealthy", "class": "permission_denied"}, "probe_unhealthy"),
        ({"signal": "unknown"}, {"signal": "unknown"}, "insufficient_data"),
    ]
    for heartbeat, probe, expected in cases:
        observed, _two_signals, _reason = _mod.classify_signals(heartbeat, probe)
        assert observed == expected


def test_transition_pruning_and_state_cleanup(tmp_path: Path):
    record = {"transitions": ["bad", 1.0, 995.0]}
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


def test_reachability_oracle_errors_fail_safe_without_suppression(tmp_path: Path):
    hb = _heartbeat(tmp_path / "host-a-hb.json", healthy=True, mtime=100.0)
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(hb)}])
    config = _config(tmp_path, hosts, hysteresis_cycles=1)

    def raise_oracle():
        raise RuntimeError("oracle down")

    error_deps = _mod.SentinelDeps(
        now_epoch=lambda: 1000.0,
        hostname=lambda: "central-test",
        pull_probe=lambda _spec: {"reachable": False, "healthy": False, "class": "unreachable"},
        reachability_oracle=raise_oracle,
    )
    result = _mod.run_once(config, error_deps)
    assert result["fleetAction"] == "none"
    assert result["reachabilityOracle"]["class"] == "oracle_error"

    invalid_deps = _mod.SentinelDeps(
        now_epoch=lambda: 1000.0,
        hostname=lambda: "central-test",
        pull_probe=lambda _spec: {"reachable": False, "healthy": False, "class": "unreachable"},
        reachability_oracle=lambda: "bad",
    )
    result = _mod.run_once(_config(tmp_path / "invalid", hosts, hysteresis_cycles=1), invalid_deps)
    assert result["reachabilityOracle"] == {"configured": True, "reachable": None, "class": "invalid_oracle"}


def test_default_config_env_and_main_exit_codes(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS", "bad")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_ORACLE", str(tmp_path / "oracle.json"))
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES", "0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD", "0")
    config = _mod.default_config(tmp_path / "hosts.json", tmp_path / "state")
    assert config.heartbeat_max_age_seconds == _mod.DEFAULT_HEARTBEAT_MAX_AGE_SECONDS
    assert config.hysteresis_cycles == 1
    assert config.oracle_path == tmp_path / "oracle.json"
    assert config.max_tier1_heal_candidates == 1
    assert config.correlated_drift_freeze_threshold == 1

    healthy_hb = _heartbeat(tmp_path / "healthy.json", healthy=True, mtime=1000.0)
    healthy_probe = _write_json(tmp_path / "healthy-probe.json", {"reachable": True, "healthy": True, "class": "healthy"})
    hosts = _hosts_file(tmp_path, [{"host": "host-a", "heartbeatPath": str(healthy_hb), "probePath": str(healthy_probe)}])
    monkeypatch.setattr(_mod.time, "time", lambda: 1000.0)
    monkeypatch.setattr(_mod.socket, "gethostname", lambda: "central-main")
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
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", "/tmp/fleet-hosts.json")
    args = _mod.parse_args([])
    assert args.hosts == "/tmp/fleet-hosts.json"
    assert args.state_dir == "/tmp/fleet-state"
    deps = _mod.default_deps()
    assert isinstance(deps.hostname(), str)
    assert deps.pull_probe(_mod.HostSpec(host="host-a")) == {}
