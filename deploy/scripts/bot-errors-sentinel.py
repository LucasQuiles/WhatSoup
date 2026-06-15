#!/usr/bin/env python3
"""Central Fleet Runtime Sentinel evaluator.

This is the central-side state-machine foundation. It consumes host selfcheck
heartbeats and independent probe snapshots, applies the two-signal and
hysteresis rules, runs optional SSH runtime probes, and records action
decisions. Later rollout slices can wire the action sink to heal/alert workers.
"""
from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time
from typing import Callable, Optional


DEFAULT_HEARTBEAT_MAX_AGE_SECONDS = 45 * 60
DEFAULT_HYSTERESIS_CYCLES = 2
DEFAULT_FLAP_WINDOW_SECONDS = 6 * 60 * 60
DEFAULT_FLAP_THRESHOLD = 4
DEFAULT_MAX_TIER1_HEAL_CANDIDATES = 2
DEFAULT_CORRELATED_DRIFT_FREEZE_THRESHOLD = 2
SAFE_HEAL_CLASSES = {"drift", "manifest_missing"}
REMOTE_RUNTIME_PROBE = r"""
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).expanduser()
deployer = root / "deploy" / "scripts" / "whatsoup-bot-errors-deploy.sh"

def emit(payload):
    print(json.dumps(payload, sort_keys=True))

if not deployer.is_file():
    emit({"reachable": True, "healthy": False, "class": "manifest_missing", "error": f"missing deployer: {deployer}"})
    raise SystemExit(0)

try:
    proc = subprocess.run(
        ["bash", str(deployer), "verify", str(root)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=120,
        check=False,
    )
except subprocess.TimeoutExpired as exc:
    emit({"reachable": True, "healthy": False, "class": "probe_timeout", "error": str(exc)})
    raise SystemExit(0)
except OSError as exc:
    emit({"reachable": True, "healthy": False, "class": "probe_exec_error", "error": f"{type(exc).__name__}: {exc}"})
    raise SystemExit(0)

output = (proc.stdout or "")[-4000:]
if proc.returncode == 0:
    klass = "healthy"
elif "SYMLINK" in output or "NOTDIR" in output or "unsafe" in output.lower():
    klass = "unsafe_runtime_path"
elif "MISSING" in output:
    klass = "manifest_missing"
elif "DRIFT" in output:
    klass = "drift"
elif "SMOKE" in output or "LEAK" in output or "redaction" in output.lower():
    klass = "redaction_smoke_failed"
else:
    klass = "runtime_verify_failed"
emit({"reachable": True, "healthy": proc.returncode == 0, "class": klass, "verifyRc": proc.returncode, "output": output[-1000:]})
"""


@dataclass(frozen=True)
class HostSpec:
    host: str
    role: str = "runtime"
    heartbeat_path: Optional[Path] = None
    probe_path: Optional[Path] = None
    ack_path: Optional[Path] = None
    ssh_host: Optional[str] = None
    root: Optional[Path] = None
    python: str = "python3"


@dataclass(frozen=True)
class SentinelConfig:
    state_dir: Path
    hosts_path: Path
    oracle_path: Optional[Path] = None
    heartbeat_max_age_seconds: int = DEFAULT_HEARTBEAT_MAX_AGE_SECONDS
    hysteresis_cycles: int = DEFAULT_HYSTERESIS_CYCLES
    flap_window_seconds: int = DEFAULT_FLAP_WINDOW_SECONDS
    flap_threshold: int = DEFAULT_FLAP_THRESHOLD
    max_tier1_heal_candidates: int = DEFAULT_MAX_TIER1_HEAL_CANDIDATES
    correlated_drift_freeze_threshold: int = DEFAULT_CORRELATED_DRIFT_FREEZE_THRESHOLD


@dataclass(frozen=True)
class SentinelDeps:
    now_epoch: Callable[[], float]
    hostname: Callable[[], str]
    pull_probe: Callable[[HostSpec], dict]
    reachability_oracle: Callable[[], dict] = lambda: {"configured": False, "reachable": True, "class": "not_configured"}


class SentinelError(RuntimeError):
    pass


def now_iso(epoch: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if epoch is None else epoch))


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", Path.home() / ".local/state/bot-errors/fleet-sentinel"))


def default_hosts_path() -> Path:
    return Path(os.environ.get("BOT_ERRORS_FLEET_SENTINEL_HOSTS", state_root() / "hosts.json"))


def positive_int_env(name: str, default: int, minimum: int = 0) -> int:
    raw = os.environ.get(name, str(default))
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


def default_config(hosts_path: Optional[Path] = None, state_dir: Optional[Path] = None) -> SentinelConfig:
    oracle_raw = os.environ.get("BOT_ERRORS_FLEET_SENTINEL_ORACLE", "").strip()
    return SentinelConfig(
        state_dir=state_dir or state_root(),
        hosts_path=hosts_path or default_hosts_path(),
        oracle_path=Path(oracle_raw).expanduser() if oracle_raw else None,
        heartbeat_max_age_seconds=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS", DEFAULT_HEARTBEAT_MAX_AGE_SECONDS),
        hysteresis_cycles=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES", DEFAULT_HYSTERESIS_CYCLES, 1),
        flap_window_seconds=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS", DEFAULT_FLAP_WINDOW_SECONDS),
        flap_threshold=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD", DEFAULT_FLAP_THRESHOLD, 1),
        max_tier1_heal_candidates=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES", DEFAULT_MAX_TIER1_HEAL_CANDIDATES, 1),
        correlated_drift_freeze_threshold=positive_int_env(
            "BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD",
            DEFAULT_CORRELATED_DRIFT_FREEZE_THRESHOLD,
            1,
        ),
    )


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def fsync_parent(path: Path) -> None:
    try:
        fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_json(path: Path, payload: dict) -> None:
    ensure_private_dir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        fsync_parent(path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def read_json_object(path: Path) -> dict:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SentinelError(f"missing JSON file: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise SentinelError(f"cannot read JSON file {path}: {type(exc).__name__}") from exc
    if not isinstance(loaded, dict):
        raise SentinelError(f"JSON file must contain an object: {path}")
    return loaded


def optional_json_object(path: Path) -> Optional[dict]:
    try:
        return read_json_object(path)
    except SentinelError:
        return None


def path_or_none(value: object) -> Optional[Path]:
    text = str(value or "").strip()
    return Path(text).expanduser() if text else None


def text_or_none(value: object) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def load_hosts(path: Path) -> list[HostSpec]:
    data = read_json_object(path)
    if data.get("schemaVersion") != 1:
        raise SentinelError("hosts file schemaVersion must be 1")
    hosts = data.get("hosts")
    if not isinstance(hosts, list) or not hosts:
        raise SentinelError("hosts file requires a non-empty hosts list")
    result = []
    seen = set()
    for index, item in enumerate(hosts):
        if not isinstance(item, dict):
            raise SentinelError(f"hosts[{index}] must be an object")
        host = str(item.get("host") or "").strip()
        if not host:
            raise SentinelError(f"hosts[{index}] requires host")
        if host in seen:
            raise SentinelError(f"duplicate host: {host}")
        seen.add(host)
        result.append(
            HostSpec(
                host=host,
                role=str(item.get("role") or "runtime"),
                heartbeat_path=path_or_none(item.get("heartbeatPath")),
                probe_path=path_or_none(item.get("probePath")),
                ack_path=path_or_none(item.get("ackPath")),
                ssh_host=text_or_none(item.get("sshHost")),
                root=path_or_none(item.get("root")),
                python=str(item.get("python") or "python3").strip() or "python3",
            )
        )
    return result


def state_path(config: SentinelConfig) -> Path:
    return config.state_dir / "fleet-sentinel-state.json"


def heartbeat_path(config: SentinelConfig) -> Path:
    return config.state_dir / "sentinel-heartbeat.json"


def load_state(config: SentinelConfig) -> dict:
    try:
        state = read_json_object(state_path(config))
    except SentinelError:
        return {"schemaVersion": 1, "hosts": {}}
    if not isinstance(state.get("hosts"), dict):
        state["hosts"] = {}
    return state


def save_state(config: SentinelConfig, state: dict) -> None:
    atomic_write_json(state_path(config), state)


def save_central_heartbeat(config: SentinelConfig, result: dict) -> str:
    hosts = result.get("hosts") if isinstance(result.get("hosts"), list) else []
    problem_hosts = [host for host in hosts if isinstance(host, dict) and host.get("healthy") is not True]
    payload = {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-heartbeat",
        "checkedAt": result.get("checkedAt"),
        "controllerHost": result.get("controllerHost"),
        "healthy": result.get("fleetAction") == "none" and not problem_hosts,
        "fleetAction": result.get("fleetAction"),
        "hostCount": len(hosts),
        "problemHostCount": len(problem_hosts),
    }
    atomic_write_json(heartbeat_path(config), payload)
    return str(heartbeat_path(config))


def heartbeat_inventory(spec: HostSpec, now: float, max_age_seconds: int) -> dict:
    if spec.heartbeat_path is None:
        return {"configured": False, "signal": "unknown", "status": "not_configured"}
    path = spec.heartbeat_path
    try:
        stat = path.stat()
    except FileNotFoundError:
        return {"configured": True, "signal": "stale", "status": "missing", "path": str(path)}
    except OSError as exc:
        return {"configured": True, "signal": "stale", "status": f"stat_error:{type(exc).__name__}", "path": str(path)}
    payload = optional_json_object(path)
    if payload is None:
        return {"configured": True, "signal": "stale", "status": "invalid_json", "path": str(path)}
    age = max(0, int(now - stat.st_mtime))
    fresh = age <= max_age_seconds
    healthy = payload.get("healthy") is True
    status = "fresh" if fresh else "stale"
    if not fresh:
        signal = "stale"
    elif healthy:
        signal = "healthy"
    else:
        signal = "unhealthy"
    return {
        "configured": True,
        "signal": signal,
        "status": status,
        "path": str(path),
        "ageSeconds": age,
        "maxAgeSeconds": max_age_seconds,
        "healthy": healthy,
        "class": str(payload.get("class") or "unknown"),
        "action": str(payload.get("action") or "unknown"),
        "pin": payload.get("pin"),
    }


def normalize_probe(payload: dict) -> dict:
    if not payload:
        return {"configured": False, "signal": "unknown", "class": "not_configured"}
    reachable = payload.get("reachable")
    healthy = payload.get("healthy")
    probe_class = str(payload.get("class") or "unknown")
    if reachable is False:
        signal = "unreachable"
    elif healthy is False:
        signal = "unhealthy"
    elif reachable is True and healthy is True:
        signal = "healthy"
    else:
        signal = "unknown"
    result = {"configured": True, "signal": signal, "class": probe_class}
    for key in ("reachable", "healthy", "error", "headSha", "f10Sha"):
        if key in payload:
            result[key] = payload[key]
    return result


def default_pull_probe(spec: HostSpec) -> dict:
    if spec.probe_path is not None:
        return optional_json_object(spec.probe_path) or {"reachable": False, "healthy": False, "class": "invalid_probe"}
    if spec.ssh_host or spec.root is not None:
        return ssh_runtime_probe(spec)
    return {}


def oracle_inventory(path: Optional[Path]) -> dict:
    if path is None:
        return {"configured": False, "reachable": True, "class": "not_configured"}
    payload = optional_json_object(path)
    if payload is None:
        return {"configured": True, "reachable": None, "class": "invalid_oracle", "path": str(path)}
    reachable = payload.get("reachable")
    if reachable is not True and reachable is not False:
        reachable = None
    klass = str(payload.get("class") or ("reachable" if reachable is True else "unreachable" if reachable is False else "unknown"))
    result = {"configured": True, "reachable": reachable, "class": klass, "path": str(path)}
    if "error" in payload:
        result["error"] = payload["error"]
    return result


def env_key_segment(value: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in value).strip("_").upper()


def ssh_command() -> list[str]:
    raw = os.environ.get("BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND", "")
    return shlex.split(raw) if raw else ["ssh"]


def remote_exec_prefix(host: str) -> list[str]:
    raw = os.environ.get(f"BOT_ERRORS_FLEET_SENTINEL_EXEC_{env_key_segment(host)}", "")
    return shlex.split(raw) if raw else []


def ssh_probe_connect_timeout_seconds() -> int:
    return positive_int_env("BOT_ERRORS_FLEET_SENTINEL_SSH_CONNECT_TIMEOUT_SECONDS", 8, 1)


def ssh_probe_timeout_seconds() -> int:
    return positive_int_env("BOT_ERRORS_FLEET_SENTINEL_SSH_PROBE_TIMEOUT_SECONDS", 30, 1)


def ssh_probe_command(spec: HostSpec) -> list[str]:
    host = spec.ssh_host or spec.host
    return [
        *ssh_command(),
        "-o",
        "BatchMode=yes",
        "-o",
        f"ConnectTimeout={ssh_probe_connect_timeout_seconds()}",
        host,
        *remote_exec_prefix(host),
        spec.python,
        "-",
        str(spec.root),
    ]


def parse_probe_stdout(stdout: str) -> Optional[dict]:
    for line in stdout.splitlines():
        text = line.strip()
        if not text:
            continue
        try:
            loaded = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(loaded, dict):
            return loaded
    return None


def ssh_runtime_probe(spec: HostSpec) -> dict:
    if spec.root is None:
        return {"reachable": True, "healthy": False, "class": "probe_config_error", "error": "sshHost requires root"}
    try:
        proc = subprocess.run(
            ssh_probe_command(spec),
            input=REMOTE_RUNTIME_PROBE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=ssh_probe_timeout_seconds(),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return {"reachable": False, "healthy": False, "class": "ssh_timeout", "error": str(exc)[:300]}
    except OSError as exc:
        return {"reachable": False, "healthy": False, "class": "ssh_exec_error", "error": f"{type(exc).__name__}: {exc}"[:300]}
    if proc.returncode != 0:
        error = (proc.stderr or proc.stdout or "")[-500:]
        return {"reachable": False, "healthy": False, "class": "ssh_failed", "error": error}
    payload = parse_probe_stdout(proc.stdout or "")
    if payload is None:
        return {"reachable": True, "healthy": False, "class": "invalid_probe_output", "error": "remote probe did not emit JSON"}
    payload.setdefault("reachable", True)
    payload.setdefault("healthy", False)
    payload.setdefault("class", "unknown")
    return payload


def classify_signals(heartbeat: dict, probe: dict) -> tuple[str, bool, str]:
    hb_signal = str(heartbeat.get("signal") or "unknown")
    probe_signal = str(probe.get("signal") or "unknown")
    hb_class = str(heartbeat.get("class") or "unknown")
    probe_class = str(probe.get("class") or "unknown")

    if hb_signal == "healthy" and probe_signal == "healthy":
        return "healthy", False, "heartbeat and probe healthy"
    if hb_signal == "stale" and probe_signal == "unreachable":
        return "out_of_rotation", True, "heartbeat stale and probe unreachable"
    if hb_signal == "unhealthy" and probe_signal == "unhealthy":
        if hb_class in SAFE_HEAL_CLASSES or probe_class in SAFE_HEAL_CLASSES:
            return "safe_runtime_drift", True, "heartbeat and probe agree on safe runtime drift"
        return "runtime_invariant_failed", True, "heartbeat and probe agree on runtime failure"
    if hb_signal == "unhealthy" and probe_signal == "unreachable":
        return "runtime_unverified", True, "heartbeat unhealthy and probe unreachable"
    if hb_signal == "stale":
        return "heartbeat_stale", False, "heartbeat stale without failed independent probe"
    if hb_signal == "unhealthy":
        return "heartbeat_unhealthy", False, "heartbeat unhealthy without failed independent probe"
    if probe_signal == "unreachable":
        return "probe_unreachable", False, "probe unreachable without stale heartbeat"
    if probe_signal == "unhealthy":
        return "probe_unhealthy", False, "probe unhealthy without matching heartbeat failure"
    return "insufficient_data", False, "missing a healthy or failed independent signal"


def prune_transition_times(record: dict, now: float, window_seconds: int) -> list[float]:
    floor = now - window_seconds
    kept = []
    for item in record.get("transitions", []):
        try:
            stamp = float(item)
        except (TypeError, ValueError):
            continue
        if stamp >= floor:
            kept.append(stamp)
    record["transitions"] = kept
    return kept


def update_record(record: dict, observed_class: str, now: float, config: SentinelConfig) -> tuple[int, int]:
    if record.get("lastClass") == observed_class:
        consecutive = int(record.get("consecutive") or 0) + 1
    else:
        consecutive = 1
        transitions = prune_transition_times(record, now, config.flap_window_seconds)
        transitions.append(now)
        record["transitions"] = transitions
    record["lastClass"] = observed_class
    record["consecutive"] = consecutive
    flaps = len(prune_transition_times(record, now, config.flap_window_seconds))
    record["flapCount"] = flaps
    return consecutive, flaps


def decide_action(observed_class: str, two_signals: bool, consecutive: int, flaps: int, config: SentinelConfig) -> str:
    if observed_class == "healthy":
        return "noop"
    if not two_signals:
        return "monitor_only"
    if consecutive < config.hysteresis_cycles:
        return "hysteresis_wait"
    if flaps >= config.flap_threshold:
        return "escalate_flapping"
    if observed_class == "safe_runtime_drift":
        return "tier1_heal_candidate"
    return "escalate"


def evaluate_host(spec: HostSpec, heartbeat: dict, probe: dict, record: dict, now: float, config: SentinelConfig) -> dict:
    observed_class, two_signals, reason = classify_signals(heartbeat, probe)
    previous_alert = record.get("alertState") == "open"
    consecutive, flaps = update_record(record, observed_class, now, config)
    action = decide_action(observed_class, two_signals, consecutive, flaps, config)
    if observed_class == "healthy":
        record["alertState"] = "closed"
        action = "clear" if previous_alert else "noop"
    elif action in {"tier1_heal_candidate", "escalate", "escalate_flapping"}:
        record["alertState"] = "open"
        record["lastBadAt"] = now
    record["lastAction"] = action
    record["updatedAt"] = now_iso(now)
    return {
        "host": spec.host,
        "role": spec.role,
        "healthy": observed_class == "healthy",
        "class": observed_class,
        "reason": reason,
        "twoSignals": two_signals,
        "consecutive": consecutive,
        "flapCount": flaps,
        "action": action,
        "alertState": record.get("alertState", "closed"),
        "heartbeat": heartbeat,
        "probe": probe,
    }


def mass_out_of_rotation(results: list[dict]) -> bool:
    if len(results) < 2:
        return False
    unreachable = [result for result in results if result.get("class") == "out_of_rotation" and result.get("twoSignals") is True]
    return len(unreachable) >= max(2, (len(results) + 1) // 2)


def central_connectivity_suspect(results: list[dict], oracle: dict) -> bool:
    return mass_out_of_rotation(results) and oracle.get("reachable") is False


def safe_runtime_drift_key(result: dict) -> str:
    heartbeat_class = str(result.get("heartbeat", {}).get("class") or "")
    probe_class = str(result.get("probe", {}).get("class") or "")
    if probe_class in SAFE_HEAL_CLASSES:
        return probe_class
    if heartbeat_class in SAFE_HEAL_CLASSES:
        return heartbeat_class
    return "safe_runtime_drift"


def apply_tier1_bounds(results: list[dict], host_state: dict, config: SentinelConfig) -> Optional[str]:
    candidates = [result for result in results if result.get("action") == "tier1_heal_candidate"]
    if not candidates:
        return None
    by_drift_class: dict[str, list[dict]] = {}
    for result in candidates:
        by_drift_class.setdefault(safe_runtime_drift_key(result), []).append(result)
    frozen_classes = {
        drift_class
        for drift_class, grouped in by_drift_class.items()
        if len(grouped) > config.correlated_drift_freeze_threshold
    }
    if frozen_classes:
        for result in candidates:
            drift_class = safe_runtime_drift_key(result)
            if drift_class in frozen_classes:
                result["action"] = "freeze_correlated_drift"
                result["correlatedDriftClass"] = drift_class
                host_state[result["host"]]["lastAction"] = result["action"]
        return "correlated_runtime_drift_freeze"

    if len(candidates) > config.max_tier1_heal_candidates:
        for result in candidates[config.max_tier1_heal_candidates:]:
            result["action"] = "defer_tier1_concurrency_cap"
            host_state[result["host"]]["lastAction"] = result["action"]
        return "tier1_concurrency_cap"
    return None


def write_ack(spec: HostSpec, result: dict, now: float) -> Optional[str]:
    if spec.ack_path is None:
        return None
    payload = {
        "schemaVersion": 1,
        "host": spec.host,
        "ackedAt": now_iso(now),
        "centralClass": result.get("class"),
        "centralAction": result.get("action"),
    }
    atomic_write_json(spec.ack_path, payload)
    return str(spec.ack_path)


def default_deps(config: Optional[SentinelConfig] = None) -> SentinelDeps:
    oracle_path = config.oracle_path if config is not None else None
    return SentinelDeps(
        now_epoch=time.time,
        hostname=socket.gethostname,
        pull_probe=default_pull_probe,
        reachability_oracle=lambda: oracle_inventory(oracle_path),
    )


def run_once(config: SentinelConfig, deps: Optional[SentinelDeps] = None) -> dict:
    deps = deps or default_deps(config)
    now = deps.now_epoch()
    hosts = load_hosts(config.hosts_path)
    state = load_state(config)
    state["schemaVersion"] = 1
    state["updatedAt"] = now_iso(now)
    state["controllerHost"] = deps.hostname()
    host_state = state.setdefault("hosts", {})
    configured_hosts = {spec.host for spec in hosts}
    for host in list(host_state):
        if host not in configured_hosts:
            del host_state[host]

    results = []
    for spec in hosts:
        record = host_state.setdefault(spec.host, {"alertState": "closed", "consecutive": 0, "transitions": []})
        heartbeat = heartbeat_inventory(spec, now, config.heartbeat_max_age_seconds)
        probe = normalize_probe(deps.pull_probe(spec))
        result = evaluate_host(spec, heartbeat, probe, record, now, config)
        ack_path = write_ack(spec, result, now)
        if ack_path is not None:
            result["ackPath"] = ack_path
        results.append(result)

    fleet_action = "none"
    try:
        oracle = deps.reachability_oracle()
    except Exception as exc:
        oracle = {"configured": True, "reachable": None, "class": "oracle_error", "error": f"{type(exc).__name__}: {exc}"[:300]}
    if not isinstance(oracle, dict):
        oracle = {"configured": True, "reachable": None, "class": "invalid_oracle"}
    if central_connectivity_suspect(results, oracle):
        fleet_action = "central_connectivity_suspect"
        for result in results:
            if result["class"] == "out_of_rotation" and result["action"] != "hysteresis_wait":
                result["action"] = "suppress_central_connectivity_suspect"
                host_state[result["host"]]["lastAction"] = result["action"]
    elif mass_out_of_rotation(results):
        fleet_action = "mass_unreachable_confirmed"
    else:
        tier1_action = apply_tier1_bounds(results, host_state, config)
        if tier1_action is not None:
            fleet_action = tier1_action

    state["lastFleetAction"] = fleet_action
    state["lastReachabilityOracle"] = oracle
    save_state(config, state)
    result = {
        "schemaVersion": 1,
        "checkedAt": now_iso(now),
        "controllerHost": deps.hostname(),
        "fleetAction": fleet_action,
        "reachabilityOracle": oracle,
        "hosts": results,
        "statePath": str(state_path(config)),
    }
    result["heartbeatPath"] = save_central_heartbeat(config, result)
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate BOT ERRORS Fleet Runtime Sentinel state")
    parser.add_argument("--hosts", default=str(default_hosts_path()))
    parser.add_argument("--state-dir", default=str(state_root()))
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    config = default_config(Path(args.hosts).expanduser(), Path(args.state_dir).expanduser())
    try:
        result = run_once(config)
    except Exception as exc:
        print(json.dumps({"schemaVersion": 1, "healthy": False, "class": "fleet_sentinel_error", "problems": [str(exc)]}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    if any(host.get("action") in {"tier1_heal_candidate", "escalate", "escalate_flapping"} for host in result["hosts"]):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
