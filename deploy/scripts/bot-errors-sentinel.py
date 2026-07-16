#!/usr/bin/env python3
"""Central Fleet Runtime Sentinel evaluator.

This is the central-side state-machine foundation. It consumes host selfcheck
heartbeats and independent probe snapshots, applies the two-signal and
hysteresis rules, runs optional SSH runtime probes, and records action
decisions. Later rollout slices can wire the action sink to heal/alert workers.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import hmac
import json
import math
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
import shlex
import socket
import subprocess
import sys
import time
from typing import Callable, Optional


REPO_ROOT = Path(__file__).resolve().parents[2]

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from lib.bot_errors_roster import RosterError, load_roster, roster_epoch  # noqa: E402

DEFAULT_HEARTBEAT_MAX_AGE_SECONDS = 45 * 60
DEFAULT_HYSTERESIS_CYCLES = 2
DEFAULT_CONNECTIVITY_HYSTERESIS_CYCLES = 3
DEFAULT_FLAP_WINDOW_SECONDS = 6 * 60 * 60
DEFAULT_FLAP_THRESHOLD = 4
DEFAULT_MAX_TIER1_HEAL_CANDIDATES = 2
DEFAULT_CORRELATED_DRIFT_FREEZE_THRESHOLD = 2
DEFAULT_MAX_CLOCK_SKEW_SECONDS = 5 * 60
DEFAULT_ACTION_EVENT_COOLDOWN_SECONDS = 6 * 60 * 60
DEFAULT_MAX_CRITICAL_WHATSAPP_PER_DAY = 8
DEFAULT_TIER2_TOKEN_TTL_SECONDS = 30 * 60
DEFAULT_ACTION_OUTBOX_RETENTION = 500
DEFAULT_Q_HOST = "q-agent-host"
SAFE_HEAL_CLASSES = {"drift", "manifest_missing"}
ACTION_EVENT_ACTIONS = {
    "tier1_heal_candidate",
    "escalate",
    "escalate_flapping",
    "freeze_correlated_drift",
    "q_unavailable",
    "clear",
}
ATTENTION_ACTIONS = {"tier1_heal_candidate", "escalate", "escalate_flapping", "freeze_correlated_drift", "q_unavailable"}
ATTENTION_FLEET_ACTIONS = {
    "central_connectivity_suspect",
    "mass_unreachable_confirmed",
    "correlated_runtime_drift_freeze",
    "tier1_concurrency_cap",
}
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
    action_outbox_dir: Optional[Path] = None
    heartbeat_max_age_seconds: int = DEFAULT_HEARTBEAT_MAX_AGE_SECONDS
    hysteresis_cycles: int = DEFAULT_HYSTERESIS_CYCLES
    connectivity_hysteresis_cycles: int = DEFAULT_CONNECTIVITY_HYSTERESIS_CYCLES
    flap_window_seconds: int = DEFAULT_FLAP_WINDOW_SECONDS
    flap_threshold: int = DEFAULT_FLAP_THRESHOLD
    max_tier1_heal_candidates: int = DEFAULT_MAX_TIER1_HEAL_CANDIDATES
    correlated_drift_freeze_threshold: int = DEFAULT_CORRELATED_DRIFT_FREEZE_THRESHOLD
    max_clock_skew_seconds: int = DEFAULT_MAX_CLOCK_SKEW_SECONDS
    action_event_cooldown_seconds: int = DEFAULT_ACTION_EVENT_COOLDOWN_SECONDS
    max_critical_whatsapp_per_day: int = DEFAULT_MAX_CRITICAL_WHATSAPP_PER_DAY
    tier2_token_ttl_seconds: int = DEFAULT_TIER2_TOKEN_TTL_SECONDS
    action_outbox_retention: int = DEFAULT_ACTION_OUTBOX_RETENTION
    q_host: str = DEFAULT_Q_HOST


@dataclass(frozen=True)
class SentinelDeps:
    now_epoch: Callable[[], float]
    hostname: Callable[[], str]
    pull_probe: Callable[..., dict]
    reachability_oracle: Callable[[], dict] = lambda: {"configured": False, "reachable": True, "class": "not_configured"}


class SentinelError(RuntimeError):
    pass


def now_iso(epoch: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if epoch is None else epoch))


def parse_iso_epoch(value: object) -> Optional[float]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(f"{text[:-1]}+00:00" if text.endswith("Z") else text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc).timestamp()


def finite_float(value: object) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_FLEET_SENTINEL_STATE_DIR", Path.home() / ".local/state/bot-errors/fleet-sentinel"))


def default_hosts_path() -> Path:
    return Path(os.environ.get("BOT_ERRORS_FLEET_SENTINEL_HOSTS", REPO_ROOT / "deploy" / "bot-errors-expected-fleet.json"))


def positive_int_env(name: str, default: int, minimum: int = 0) -> int:
    raw = os.environ.get(name, str(default))
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


def default_config(hosts_path: Optional[Path] = None, state_dir: Optional[Path] = None) -> SentinelConfig:
    oracle_raw = os.environ.get("BOT_ERRORS_FLEET_SENTINEL_ORACLE", "").strip()
    action_outbox_raw = os.environ.get("BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_DIR", "").strip()
    resolved_state_dir = state_dir or state_root()
    return SentinelConfig(
        state_dir=resolved_state_dir,
        hosts_path=hosts_path or default_hosts_path(),
        oracle_path=Path(oracle_raw).expanduser() if oracle_raw else None,
        action_outbox_dir=Path(action_outbox_raw).expanduser() if action_outbox_raw else resolved_state_dir / "actions",
        heartbeat_max_age_seconds=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT_MAX_AGE_SECONDS", DEFAULT_HEARTBEAT_MAX_AGE_SECONDS),
        hysteresis_cycles=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_HYSTERESIS_CYCLES", DEFAULT_HYSTERESIS_CYCLES, 1),
        connectivity_hysteresis_cycles=positive_int_env(
            "BOT_ERRORS_FLEET_SENTINEL_CONNECTIVITY_HYSTERESIS_CYCLES",
            DEFAULT_CONNECTIVITY_HYSTERESIS_CYCLES,
            1,
        ),
        flap_window_seconds=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_FLAP_WINDOW_SECONDS", DEFAULT_FLAP_WINDOW_SECONDS),
        flap_threshold=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_FLAP_THRESHOLD", DEFAULT_FLAP_THRESHOLD, 1),
        max_tier1_heal_candidates=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_MAX_TIER1_HEAL_CANDIDATES", DEFAULT_MAX_TIER1_HEAL_CANDIDATES, 1),
        correlated_drift_freeze_threshold=positive_int_env(
            "BOT_ERRORS_FLEET_SENTINEL_CORRELATED_DRIFT_FREEZE_THRESHOLD",
            DEFAULT_CORRELATED_DRIFT_FREEZE_THRESHOLD,
            1,
        ),
        max_clock_skew_seconds=positive_int_env("BOT_ERRORS_FLEET_SENTINEL_MAX_CLOCK_SKEW_SECONDS", DEFAULT_MAX_CLOCK_SKEW_SECONDS, 1),
        action_event_cooldown_seconds=positive_int_env(
            "BOT_ERRORS_FLEET_SENTINEL_ACTION_EVENT_COOLDOWN_SECONDS",
            DEFAULT_ACTION_EVENT_COOLDOWN_SECONDS,
            1,
        ),
        max_critical_whatsapp_per_day=positive_int_env(
            "BOT_ERRORS_FLEET_SENTINEL_MAX_CRITICAL_WHATSAPP_PER_DAY",
            DEFAULT_MAX_CRITICAL_WHATSAPP_PER_DAY,
            1,
        ),
        tier2_token_ttl_seconds=positive_int_env(
            "BOT_ERRORS_FLEET_SENTINEL_TIER2_TOKEN_TTL_SECONDS",
            DEFAULT_TIER2_TOKEN_TTL_SECONDS,
            60,
        ),
        action_outbox_retention=positive_int_env(
            "BOT_ERRORS_FLEET_SENTINEL_ACTION_OUTBOX_RETENTION",
            DEFAULT_ACTION_OUTBOX_RETENTION,
            1,
        ),
        q_host=os.environ.get("BOT_ERRORS_FLEET_SENTINEL_Q_HOST", DEFAULT_Q_HOST).strip() or DEFAULT_Q_HOST,
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


def optional_text(value: object, field: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise SentinelError(f"{field} must be a string")
    text = value.strip()
    return text or None


def required_text(value: object, field: str, missing: str) -> str:
    text = optional_text(value, field)
    if text is None:
        raise SentinelError(missing)
    return text


def path_or_none(value: object, field: str) -> Optional[Path]:
    text = optional_text(value, field)
    return Path(text).expanduser() if text else None


def text_or_none(value: object, field: str) -> Optional[str]:
    return optional_text(value, field)


def default_heartbeat_path(state_dir: Optional[Path], host: str) -> Optional[Path]:
    return state_dir / "heartbeats" / f"{host}.json" if state_dir is not None else None


def default_ack_path(state_dir: Optional[Path], host: str) -> Optional[Path]:
    return state_dir / "acks" / f"{host}.json" if state_dir is not None else None


def is_expected_fleet_roster(data: dict) -> bool:
    hosts = data.get("hosts")
    if not isinstance(hosts, list):
        return False
    return any(isinstance(item, dict) and ("profile" in item or "instances" in item or "collectorRemote" in item) for item in hosts)


def load_hosts(path: Path, state_dir: Optional[Path] = None) -> list[HostSpec]:
    data = read_json_object(path)
    if data.get("schemaVersion") != 1:
        raise SentinelError("hosts file schemaVersion must be 1")
    hosts = data.get("hosts")
    if not isinstance(hosts, list) or not hosts:
        raise SentinelError("hosts file requires a non-empty hosts list")
    derive_default_paths = is_expected_fleet_roster(data)
    result = []
    seen = set()
    for index, item in enumerate(hosts):
        if not isinstance(item, dict):
            raise SentinelError(f"hosts[{index}] must be an object")
        host = required_text(item.get("host"), f"hosts[{index}].host", f"hosts[{index}] requires host")
        if host in seen:
            raise SentinelError(f"duplicate host: {host}")
        seen.add(host)
        result.append(
            HostSpec(
                host=host,
                role=text_or_none(item.get("role"), f"hosts[{index}].role") or "runtime",
                heartbeat_path=path_or_none(item.get("heartbeatPath"), f"hosts[{index}].heartbeatPath")
                or (default_heartbeat_path(state_dir, host) if derive_default_paths else None),
                probe_path=path_or_none(item.get("probePath"), f"hosts[{index}].probePath"),
                ack_path=path_or_none(item.get("ackPath"), f"hosts[{index}].ackPath")
                or (default_ack_path(state_dir, host) if derive_default_paths else None),
                ssh_host=text_or_none(item.get("sshHost"), f"hosts[{index}].sshHost"),
                root=path_or_none(item.get("root"), f"hosts[{index}].root"),
                python=text_or_none(item.get("python"), f"hosts[{index}].python") or "python3",
            )
        )
    return result


def state_path(config: SentinelConfig) -> Path:
    return config.state_dir / "fleet-sentinel-state.json"


def heartbeat_path(config: SentinelConfig) -> Path:
    return config.state_dir / "sentinel-heartbeat.json"


def action_outbox_dir(config: SentinelConfig) -> Path:
    return config.action_outbox_dir or config.state_dir / "actions"


def prune_action_outbox(config: SentinelConfig) -> int:
    """Bound the action outbox: keep the newest ``action_outbox_retention``
    files by mtime and delete the rest. The outbox has no consumer, so without
    this sweep it grows without bound (inode/disk exhaustion). Returns the
    outbox depth after pruning."""
    outbox = action_outbox_dir(config)
    retention = max(0, config.action_outbox_retention)
    try:
        with os.scandir(outbox) as scan:
            files = [Path(entry.path) for entry in scan if entry.is_file()]
    except FileNotFoundError:
        return 0
    except OSError:
        return 0
    # Sort newest-first so the kept slice is the freshest by mtime; the path
    # name breaks ties deterministically.
    def sort_key(entry: Path) -> tuple:
        try:
            mtime = entry.stat().st_mtime
        except OSError:
            mtime = 0.0
        return (mtime, entry.name)

    files.sort(key=sort_key, reverse=True)
    for stale in files[retention:]:
        try:
            stale.unlink()
        except OSError:
            pass
    return min(len(files), retention)


def load_state(config: SentinelConfig) -> dict:
    try:
        state = read_json_object(state_path(config))
    except SentinelError:
        return {"schemaVersion": 1, "hosts": {}}
    if not isinstance(state.get("hosts"), dict):
        state["hosts"] = {}
    return state


def default_host_record() -> dict:
    return {"alertState": "closed", "consecutive": 0, "transitions": []}


def state_record(state: dict, key: str) -> dict:
    record = state.get(key)
    if not isinstance(record, dict):
        record = {}
        state[key] = record
    return record


def save_state(config: SentinelConfig, state: dict) -> None:
    atomic_write_json(state_path(config), state)


def _host_observation_bucket(observed_class: str) -> str:
    """Map an evaluated host class to observed / unknown / problem.

    ``insufficient_data`` (no healthy or failed independent signal) and an
    unevaluated roster host are UNKNOWN — explicitly, never folded into healthy
    or absent (#1875). A definite non-healthy signal is a PROBLEM.
    """
    if observed_class == "healthy":
        return "healthy"
    if observed_class in ("", "insufficient_data"):
        return "unknown"
    return "problem"


def save_central_heartbeat(config: SentinelConfig, result: dict) -> str:
    hosts = result.get("hosts") if isinstance(result.get("hosts"), list) else []
    problem_hosts = [
        host
        for host in hosts
        if isinstance(host, dict) and (host.get("healthy") is not True or "ackError" in host)
    ]
    events = result.get("actionEvents") if isinstance(result.get("actionEvents"), list) else []
    attention_events = [event for event in events if isinstance(event, dict) and event.get("action") in ATTENTION_ACTIONS]

    # Roster binding: the heartbeat is bound to a privacy-safe roster digest and
    # inventory epoch so the watchdog can independently verify that the sentinel
    # supervised the intended roster (not a truncated/wrong-path one). #1875.
    inventory = result.get("rosterInventory") if isinstance(result.get("rosterInventory"), dict) else None
    roster_epoch_val = result.get("rosterEpoch")

    class_by_host: dict[str, str] = {}
    for host in hosts:
        if isinstance(host, dict) and host.get("host") is not None:
            class_by_host[str(host["host"])] = str(host.get("class") or "")

    if inventory is not None:
        expected_hosts = [str(name) for name in (inventory.get("expectedHosts") or [])]
        expected_host_count = int(inventory.get("expectedHostCount") or 0)
        runtime_by_host = inventory.get("runtimeInstancesByHost") or {}
        expected_instance_count = int(inventory.get("expectedInstanceCount") or 0)
        roster_digest_val = inventory.get("digest")
    else:
        expected_hosts = [str(host["host"]) for host in hosts if isinstance(host, dict) and host.get("host") is not None]
        expected_host_count = len(expected_hosts)
        runtime_by_host = {}
        expected_instance_count = 0
        roster_digest_val = None

    observed_host_count = 0
    unknown_host_count = 0
    for name in expected_hosts:
        if _host_observation_bucket(class_by_host.get(name, "")) == "unknown":
            unknown_host_count += 1
        else:
            observed_host_count += 1

    observed_instance_count = 0
    problem_instance_count = 0
    unknown_instance_count = 0
    for name, count in runtime_by_host.items():
        count = int_or_zero(count)
        bucket = _host_observation_bucket(class_by_host.get(str(name), ""))
        if bucket == "unknown":
            unknown_instance_count += count
        elif bucket == "problem":
            observed_instance_count += count
            problem_instance_count += count
        else:
            observed_instance_count += count

    # Green requires a bound, non-zero roster in addition to the base health
    # signals. We deliberately do NOT require unknown_host_count == 0 here: an
    # unprobed (heartbeat-only) host is already reflected in base_healthy via the
    # per-host problem accounting, and gating green on zero-unknown would make a
    # heartbeat-only fleet perpetually not-green. Unknown membership is instead
    # reported explicitly below for the watchdog and operators.
    roster_bound = bool(roster_digest_val) and expected_host_count > 0
    base_healthy = result.get("fleetAction") == "none" and not problem_hosts and not attention_events
    healthy = bool(base_healthy and roster_bound)

    payload = {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-heartbeat",
        "checkedAt": result.get("checkedAt"),
        "controllerHost": result.get("controllerHost"),
        "healthy": healthy,
        "fleetAction": result.get("fleetAction"),
        "hostCount": len(hosts),
        "problemHostCount": len(problem_hosts),
        "rosterDigest": roster_digest_val if roster_digest_val else None,
        "rosterEpoch": roster_epoch_val if isinstance(roster_epoch_val, int) and not isinstance(roster_epoch_val, bool) else None,
        "expectedHostCount": expected_host_count,
        "observedHostCount": observed_host_count,
        "unknownHostCount": unknown_host_count,
        "expectedInstanceCount": expected_instance_count,
        "observedInstanceCount": observed_instance_count,
        "problemInstanceCount": problem_instance_count,
        "unknownInstanceCount": unknown_instance_count,
    }
    atomic_write_json(heartbeat_path(config), payload)
    return str(heartbeat_path(config))


def heartbeat_inventory(spec: HostSpec, now: float, max_age_seconds: int, max_clock_skew_seconds: int) -> dict:
    if spec.heartbeat_path is None:
        return {"configured": False, "signal": "unknown", "status": "not_configured"}
    path = spec.heartbeat_path
    if os.path.islink(path):
        return {
            "configured": True,
            "signal": "stale",
            "status": "symlink",
            "path": str(path),
        }
    try:
        stat = path.stat()
    except FileNotFoundError:
        return {"configured": True, "signal": "stale", "status": "missing", "path": str(path)}
    except OSError as exc:
        return {"configured": True, "signal": "stale", "status": f"stat_error:{type(exc).__name__}", "path": str(path)}
    payload = optional_json_object(path)
    if payload is None:
        return {"configured": True, "signal": "stale", "status": "invalid_json", "path": str(path)}
    raw_age = int(now - stat.st_mtime)
    future_by_seconds = abs(raw_age) if raw_age < 0 else 0
    age = max(0, raw_age)
    fresh = age <= max_age_seconds
    healthy = payload.get("healthy") is True
    status = "fresh" if fresh else "stale"
    heartbeat_class = str(payload.get("class") or "unknown")
    checked_at_epoch = parse_iso_epoch(payload.get("checkedAt"))
    clock_skew_seconds = int(checked_at_epoch - stat.st_mtime) if checked_at_epoch is not None else None
    if future_by_seconds > max_clock_skew_seconds:
        status = "clock_skew"
        signal = "unhealthy"
        healthy = False
        heartbeat_class = "clock_skew"
    elif clock_skew_seconds is not None and abs(clock_skew_seconds) > max_clock_skew_seconds:
        status = "clock_skew"
        signal = "unhealthy"
        healthy = False
        heartbeat_class = "clock_skew"
    elif not fresh:
        signal = "stale"
    elif healthy:
        signal = "healthy"
    else:
        signal = "unhealthy"
    result = {
        "configured": True,
        "signal": signal,
        "status": status,
        "path": str(path),
        "ageSeconds": age,
        "maxAgeSeconds": max_age_seconds,
        "healthy": healthy,
        "class": heartbeat_class,
        "action": str(payload.get("action") or "unknown"),
        "pin": payload.get("pin"),
    }
    if clock_skew_seconds is not None:
        result["clockSkewSeconds"] = clock_skew_seconds
        result["maxClockSkewSeconds"] = max_clock_skew_seconds
    if future_by_seconds:
        result["futureBySeconds"] = future_by_seconds
        result["maxClockSkewSeconds"] = max_clock_skew_seconds
    return result


def normalize_probe(payload: object) -> dict:
    if payload == {}:
        return {"configured": False, "signal": "unknown", "class": "not_configured"}
    if not isinstance(payload, dict):
        return {
            "configured": True,
            "signal": "unhealthy",
            "class": "invalid_probe",
            "error": "probe payload must be a JSON object",
        }
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


def default_pull_probe(
    spec: HostSpec,
    now: Optional[float] = None,
    max_age_seconds: int = DEFAULT_HEARTBEAT_MAX_AGE_SECONDS,
) -> dict:
    if spec.probe_path is not None:
        if os.path.islink(spec.probe_path):
            return {
                "reachable": False,
                "healthy": False,
                "class": "invalid_probe",
                "error": "symlinked_probe_path",
            }
        # Mtime staleness gate: reject probe files older than the freshness
        # window, mirroring heartbeat_inventory. Without this a probe written
        # hours ago that still says {"healthy": true} is trusted as a live
        # signal and can mask a stale heartbeat, suppressing escalation.
        # `now` is None only for legacy direct callers (no gate) so existing
        # non-staleness tests are unaffected; the sentinel loop always passes now.
        if now is not None:
            try:
                probe_age = int(now - spec.probe_path.stat().st_mtime)
            except FileNotFoundError:
                return {"reachable": False, "healthy": False, "class": "invalid_probe"}
            except OSError as exc:
                return {
                    "reachable": False,
                    "healthy": False,
                    "class": "probe_stat_error",
                    "error": f"stat_error:{type(exc).__name__}",
                }
            if probe_age > max_age_seconds:
                return {
                    "reachable": False,
                    "healthy": False,
                    "class": "probe_stale",
                    "ageSeconds": probe_age,
                    "maxAgeSeconds": max_age_seconds,
                }
        return optional_json_object(spec.probe_path) or {"reachable": False, "healthy": False, "class": "invalid_probe"}
    if spec.ssh_host or spec.root is not None:
        return ssh_runtime_probe(spec)
    return {}


def oracle_inventory(path: Optional[Path]) -> dict:
    if path is None:
        return {"configured": False, "reachable": True, "class": "not_configured"}
    if os.path.islink(path):
        return {
            "configured": True,
            "reachable": None,
            "class": "invalid_oracle",
            "status": "symlink",
            "path": str(path),
        }
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


def shlex_env_words(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name, "")
    if not raw:
        return default
    try:
        return shlex.split(raw)
    except ValueError as exc:
        raise SentinelError(f"invalid {name}: {exc}") from exc


def ssh_command() -> list[str]:
    return shlex_env_words("BOT_ERRORS_FLEET_SENTINEL_SSH_COMMAND", ["ssh"])


def remote_exec_prefix(host: str) -> list[str]:
    return shlex_env_words(f"BOT_ERRORS_FLEET_SENTINEL_EXEC_{env_key_segment(host)}", [])


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
        command = ssh_probe_command(spec)
    except SentinelError as exc:
        return {"reachable": True, "healthy": False, "class": "probe_config_error", "error": str(exc)[:300]}
    try:
        proc = subprocess.run(
            command,
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

    if hb_class == "clock_skew" or probe_class == "clock_skew":
        return "clock_skew", True, "host and central clocks differ beyond bound"
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
    transitions = record.get("transitions", [])
    if not isinstance(transitions, list):
        transitions = []
    for item in transitions:
        stamp = finite_float(item)
        if stamp is None:
            continue
        if floor <= stamp <= now:
            kept.append(stamp)
    record["transitions"] = kept
    return kept


def update_record(record: dict, observed_class: str, now: float, config: SentinelConfig) -> tuple[int, int]:
    if record.get("lastClass") == observed_class:
        consecutive = int_or_zero(record.get("consecutive")) + 1
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
    if observed_class == "clock_skew":
        return "escalate"
    if not two_signals:
        return "monitor_only"
    required_cycles = config.connectivity_hysteresis_cycles if observed_class == "out_of_rotation" else config.hysteresis_cycles
    if consecutive < required_cycles:
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
        if len(grouped) >= config.correlated_drift_freeze_threshold
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


def safe_slug(value: object) -> str:
    text = str(value or "unknown")
    slug = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in text).strip("-")
    return (slug or "unknown")[:80]


def compact_signal(payload: dict) -> dict:
    keep = (
        "signal",
        "status",
        "class",
        "action",
        "reachable",
        "healthy",
        "ageSeconds",
        "maxAgeSeconds",
        "clockSkewSeconds",
        "futureBySeconds",
        "maxClockSkewSeconds",
        "verifyRc",
        "headSha",
        "f10Sha",
        "pin",
    )
    result = {key: payload[key] for key in keep if key in payload}
    if "error" in payload:
        result["error"] = str(payload["error"])[:300]
    return result


def action_event_route(action: str) -> tuple[str, str, str, bool]:
    if action == "tier1_heal_candidate":
        return "tier1", "host_selfcheck_heal_request", "warning", False
    if action == "clear":
        return "clear", "resolved_state_change", "info", False
    if action == "q_unavailable":
        return "tier3", "human_critical_q_unavailable", "critical", True
    if action == "freeze_correlated_drift":
        return "tier3", "human_critical_correlated_freeze", "critical", True
    return "tier2", "agentic_or_human_remediation", "critical", True


def fleet_event_route(fleet_action: str) -> tuple[str, str, str, bool]:
    if fleet_action == "tier1_concurrency_cap":
        return "tier1", "fleet_heal_concurrency_cap", "warning", False
    return "tier3", "fleet_critical_escalation", "critical", True


def event_recently_emitted(record: dict, key: str, now: float, cooldown_seconds: int) -> bool:
    if record.get("lastActionEventKey") != key:
        return False
    last_at = finite_float(record.get("lastActionEventAt"))
    if last_at is None or last_at > now:
        return False
    return now - last_at < cooldown_seconds


def action_event_path(config: SentinelConfig, now: float, scope: str, subject: str, action: str, request_id: str) -> Path:
    filename = f"{int(now)}-{safe_slug(scope)}-{safe_slug(subject)}-{safe_slug(action)}-{request_id}.json"
    return action_outbox_dir(config) / filename


def request_id_for(now: float, scope: str, subject: str, action: str, klass: str) -> str:
    material = f"{int(now)}\0{scope}\0{subject}\0{action}\0{klass}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:16]


def stable_request_id(*parts: object) -> str:
    material = "\0".join(str(part) for part in parts).encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:16]


def remediation_action_hash(payload: dict) -> str:
    material = json.dumps(
        {
            "scope": payload.get("scope"),
            "host": payload.get("host"),
            "class": payload.get("class"),
            "action": payload.get("action"),
            "reason": payload.get("reason"),
            "evidence": payload.get("evidence"),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def remediation_token_hash(token: str, host: str, action_hash: str, request_id: str) -> str:
    material = f"{token}\0{host}\0{action_hash}\0{request_id}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def q_remediation_redeemed(record: dict, now: float) -> bool:
    redeemed_at = parse_iso_epoch(record.get("redeemedAt"))
    return redeemed_at is not None and redeemed_at <= now


def active_q_remediation(state: dict, now: float) -> Optional[dict]:
    record = state.get("qRemediation")
    if record is None:
        record = state.setdefault("qRemediation", {})
    if not isinstance(record, dict):
        state.pop("qRemediation", None)
        return None
    expires_at = finite_float(record.get("expiresAtEpoch")) or 0.0
    if expires_at > now and not q_remediation_redeemed(record, now):
        return record
    record.clear()
    return None


def expired_q_remediation(state: dict, now: float) -> Optional[dict]:
    record = state.get("qRemediation")
    if not isinstance(record, dict) or not record:
        return None
    if q_remediation_redeemed(record, now):
        return None
    expires_at = finite_float(record.get("expiresAtEpoch")) or 0.0
    if expires_at > now:
        return None
    return dict(record)


def redeem_q_remediation(state: dict, now: float, request_id: str, token: str) -> dict:
    """Single-use redemption of the in-flight Tier-2 remediation token.

    The Q worker that received the raw ``token`` (plus ``requestId``) in the
    action-event payload presents them here to mark the token consumed. We
    recompute the bound ``tokenHash`` from the *secret* raw token plus the
    record's own ``host``/``actionHash`` and the presented ``requestId``, and
    constant-time compare it against the stored hash. On the first valid match
    we stamp ``redeemedAt`` so ``q_remediation_redeemed`` (already honored at
    every consumption site: ``active_q_remediation`` and
    ``expired_q_remediation``) rejects every subsequent presentation within the
    TTL — closing the replay window.

    Fail-closed: a missing/corrupt/empty record, a request-id mismatch, an
    expired token, a non-matching hash, or an already-redeemed record all
    return ``redeemed: False`` and mutate nothing on the rejection paths
    (other than re-initializing a structurally-corrupt slot, mirroring
    ``active_q_remediation``). Only a verified, fresh token is stamped."""
    record = state.get("qRemediation")
    if not isinstance(record, dict) or not record:
        # Missing or structurally-corrupt record → nothing to redeem.
        if record is not None and not isinstance(record, dict):
            state.pop("qRemediation", None)
        return {"redeemed": False, "reason": "no_active_remediation"}
    if q_remediation_redeemed(record, now):
        # Replay: token already consumed within (or before) its TTL.
        return {
            "redeemed": False,
            "reason": "already_redeemed",
            "requestId": record.get("requestId"),
            "host": record.get("host"),
            "redeemedAt": record.get("redeemedAt"),
        }
    expires_at = finite_float(record.get("expiresAtEpoch")) or 0.0
    if expires_at <= now:
        return {"redeemed": False, "reason": "expired", "requestId": record.get("requestId")}
    stored_hash = record.get("tokenHash")
    record_request_id = str(record.get("requestId") or "")
    if not isinstance(stored_hash, str) or not stored_hash:
        return {"redeemed": False, "reason": "corrupt_token_hash"}
    if not hmac.compare_digest(record_request_id, str(request_id)):
        return {"redeemed": False, "reason": "request_id_mismatch"}
    presented_hash = remediation_token_hash(
        str(token),
        str(record.get("host") or ""),
        str(record.get("actionHash") or ""),
        record_request_id,
    )
    if not hmac.compare_digest(stored_hash, presented_hash):
        return {"redeemed": False, "reason": "token_mismatch", "requestId": record_request_id}
    redeemed_at = now_iso(now)
    record["redeemedAt"] = redeemed_at
    return {
        "redeemed": True,
        "reason": "redeemed",
        "requestId": record_request_id,
        "host": record.get("host"),
        "tokenId": record.get("tokenId"),
        "redeemedAt": redeemed_at,
    }


def add_tier2_remediation(payload: dict, state: dict, config: SentinelConfig, now: float, q_host_result: Optional[dict] = None) -> None:
    if payload.get("tier") != "tier2":
        return
    host = str(payload.get("host") or "unknown")
    if host == config.q_host:
        payload["remediation"] = {
            "qEligible": False,
            "reason": "q_host_self_failure",
            "qHost": config.q_host,
            "handledBy": "central_direct",
        }
        return
    if q_host_result is None:
        payload["remediation"] = {
            "qEligible": False,
            "reason": "q_host_unverified",
            "qHost": config.q_host,
            "handledBy": "central_direct",
        }
        return
    if q_host_result is not None and q_host_result.get("healthy") is not True:
        payload["remediation"] = {
            "qEligible": False,
            "reason": "q_host_degraded",
            "qHost": config.q_host,
            "qHostClass": q_host_result.get("class"),
            "qHostAction": q_host_result.get("action"),
            "handledBy": "central_direct",
        }
        return
    inflight = active_q_remediation(state, now)
    if inflight:
        payload["remediation"] = {
            "qEligible": False,
            "reason": "q_remediation_inflight",
            "qHost": config.q_host,
            "activeRequestId": inflight.get("requestId"),
            "activeHost": inflight.get("host"),
            "expiresAt": inflight.get("expiresAt"),
        }
        return

    action_hash = remediation_action_hash(payload)
    request_id = str(payload.get("requestId") or "")
    token = secrets.token_urlsafe(24)
    token_id = stable_request_id("tier2-token", host, request_id, action_hash)
    expires_at_epoch = now + config.tier2_token_ttl_seconds
    expires_at = now_iso(expires_at_epoch)
    token_hash = remediation_token_hash(token, host, action_hash, request_id)
    state["qRemediation"] = {
        "tokenId": token_id,
        "tokenHash": token_hash,
        "requestId": request_id,
        "host": host,
        "actionHash": action_hash,
        "issuedAt": now_iso(now),
        "expiresAt": expires_at,
        "expiresAtEpoch": expires_at_epoch,
        "qHost": config.q_host,
    }
    payload["remediation"] = {
        "kind": "q-remediation-request",
        "qEligible": True,
        "qHost": config.q_host,
        "singleHost": True,
        "requestId": request_id,
        "targetHost": host,
        "actionHash": action_hash,
        "tokenId": token_id,
        "token": token,
        "tokenTtlSeconds": config.tier2_token_ttl_seconds,
        "tokenExpiresAt": expires_at,
    }


def q_unavailable_key(record: dict) -> str:
    return f"q_unavailable:{record.get('host')}:{record.get('requestId')}:{record.get('actionHash')}"


def q_unavailable_event_path(config: SentinelConfig, now: float, host: str, request_id: str) -> Path:
    return action_event_path(config, now, "host", host, "q_unavailable", request_id)


def int_or_zero(value: object) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def critical_whatsapp_day(now: float) -> str:
    return now_iso(now)[:10]


def critical_whatsapp_record(state: dict, now: float) -> dict:
    day = critical_whatsapp_day(now)
    record = state.get("criticalWhatsApp")
    if not isinstance(record, dict):
        record = {}
        state["criticalWhatsApp"] = record
    if record.get("day") != day:
        record.clear()
        record["day"] = day
        record["allowedCount"] = 0
        record["overflowCount"] = 0
    return record


def critical_whatsapp_digest_path(config: SentinelConfig, day: str) -> Path:
    return action_outbox_dir(config) / f"{safe_slug(day)}-fleet-critical-whatsapp-daily-cap.json"


def write_critical_whatsapp_digest(
    config: SentinelConfig,
    now: float,
    controller_host: str,
    record: dict,
    daily_cap: int,
) -> dict:
    day = str(record.get("day") or critical_whatsapp_day(now))
    request_id = stable_request_id("critical_whatsapp_daily_cap_digest", day)
    path = critical_whatsapp_digest_path(config, day)
    payload = {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-action",
        "scope": "fleet",
        "requestId": request_id,
        "createdAt": now_iso(now),
        "controllerHost": controller_host,
        "action": "critical_whatsapp_daily_cap_digest",
        "tier": "tier3",
        "lane": "human_digest_overflow",
        "severity": "warning",
        "criticalWhatsAppEligible": False,
        "criticalWhatsAppAllowed": False,
        "criticalWhatsAppDay": day,
        "criticalWhatsAppDailyCap": daily_cap,
        "criticalWhatsAppAllowedCount": int_or_zero(record.get("allowedCount")),
        "criticalWhatsAppOverflowCount": int_or_zero(record.get("overflowCount")),
    }
    atomic_write_json(path, payload)
    record["overflowDigestPath"] = str(path)
    record["overflowDigestRequestId"] = request_id
    record["overflowDigestUpdatedAt"] = now_iso(now)
    return {"scope": "fleet", "action": "critical_whatsapp_daily_cap_digest", "requestId": request_id, "path": str(path)}


def apply_critical_whatsapp_budget(
    payload: dict,
    state: dict,
    config: SentinelConfig,
    now: float,
    controller_host: str,
) -> Optional[dict]:
    if payload.get("criticalWhatsAppEligible") is not True:
        payload["criticalWhatsAppAllowed"] = False
        return None
    record = critical_whatsapp_record(state, now)
    daily_cap = config.max_critical_whatsapp_per_day
    allowed_count = int_or_zero(record.get("allowedCount"))
    day = str(record.get("day") or critical_whatsapp_day(now))
    payload["criticalWhatsAppDay"] = day
    payload["criticalWhatsAppDailyCap"] = daily_cap
    if allowed_count < daily_cap:
        allowed_count += 1
        record["allowedCount"] = allowed_count
        payload["criticalWhatsAppAllowed"] = True
        payload["criticalWhatsAppAllowedCount"] = allowed_count
        return None
    overflow_count = int_or_zero(record.get("overflowCount")) + 1
    record["overflowCount"] = overflow_count
    payload["criticalWhatsAppAllowed"] = False
    payload["criticalWhatsAppSuppressedReason"] = "daily_cap"
    payload["criticalWhatsAppAllowedCount"] = allowed_count
    payload["criticalWhatsAppOverflowCount"] = overflow_count
    return write_critical_whatsapp_digest(config, now, controller_host, record, daily_cap)


def build_host_action_event(result: dict, now: float, controller_host: str, fleet_action: str, request_id: str) -> dict:
    action = str(result.get("action") or "unknown")
    tier, lane, severity, critical = action_event_route(action)
    return {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-action",
        "scope": "host",
        "requestId": request_id,
        "createdAt": now_iso(now),
        "controllerHost": controller_host,
        "fleetAction": fleet_action,
        "host": result.get("host"),
        "role": result.get("role"),
        "class": result.get("class"),
        "action": action,
        "tier": tier,
        "lane": lane,
        "severity": severity,
        "criticalWhatsAppEligible": critical,
        "reason": result.get("reason"),
        "consecutive": result.get("consecutive"),
        "flapCount": result.get("flapCount"),
        "evidence": {
            "heartbeat": compact_signal(result.get("heartbeat", {})),
            "probe": compact_signal(result.get("probe", {})),
        },
    }


def build_fleet_action_event(
    fleet_action: str,
    results: list[dict],
    now: float,
    controller_host: str,
    oracle: dict,
    request_id: str,
) -> dict:
    tier, lane, severity, critical = fleet_event_route(fleet_action)
    problem_hosts = [result for result in results if result.get("healthy") is not True]
    return {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-action",
        "scope": "fleet",
        "requestId": request_id,
        "createdAt": now_iso(now),
        "controllerHost": controller_host,
        "fleetAction": fleet_action,
        "tier": tier,
        "lane": lane,
        "severity": severity,
        "criticalWhatsAppEligible": critical,
        "hostCount": len(results),
        "problemHostCount": len(problem_hosts),
        "problemHosts": [
            {"host": item.get("host"), "class": item.get("class"), "action": item.get("action")}
            for item in problem_hosts
        ],
        "reachabilityOracle": compact_signal(oracle),
    }


def build_q_unavailable_event(record: dict, now: float, controller_host: str, request_id: str) -> dict:
    tier, lane, severity, critical = action_event_route("q_unavailable")
    host = str(record.get("host") or "unknown")
    return {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-action",
        "scope": "host",
        "requestId": request_id,
        "createdAt": now_iso(now),
        "controllerHost": controller_host,
        "host": host,
        "class": "q_unavailable",
        "action": "q_unavailable",
        "tier": tier,
        "lane": lane,
        "severity": severity,
        "criticalWhatsAppEligible": critical,
        "reason": "q_remediation_ack_timeout",
        "remediation": {
            "qEligible": False,
            "reason": "ack_timeout",
            "qHost": record.get("qHost"),
            "originalRequestId": record.get("requestId"),
            "actionHash": record.get("actionHash"),
            "tokenId": record.get("tokenId"),
            "issuedAt": record.get("issuedAt"),
            "expiresAt": record.get("expiresAt"),
        },
    }


def emit_q_unavailable_event(state: dict, config: SentinelConfig, now: float, controller_host: str) -> list[dict]:
    record = expired_q_remediation(state, now)
    if record is None:
        return []
    key = q_unavailable_key(record)
    timeout_record = state_record(state, "qUnavailableEvent")
    if event_recently_emitted(timeout_record, key, now, config.action_event_cooldown_seconds):
        state.pop("qRemediation", None)
        return []
    host = str(record.get("host") or "unknown")
    request_id = stable_request_id("q_unavailable", host, record.get("requestId"), record.get("actionHash"))
    path = q_unavailable_event_path(config, now, host, request_id)
    payload = build_q_unavailable_event(record, now, controller_host, request_id)
    digest_ref = apply_critical_whatsapp_budget(payload, state, config, now, controller_host)
    atomic_write_json(path, payload)
    ref = {"scope": "host", "host": host, "action": "q_unavailable", "requestId": request_id, "path": str(path)}
    emitted = [ref]
    if digest_ref is not None:
        emitted.append(digest_ref)
    timeout_record["lastActionEventKey"] = key
    timeout_record["lastActionEventAt"] = now
    timeout_record["lastActionEventPath"] = str(path)
    timeout_record["lastActionEventRequestId"] = request_id
    timeout_record["timedOutRequestId"] = record.get("requestId")
    timeout_record["timedOutHost"] = host
    timeout_record["timedOutAt"] = now_iso(now)
    state.pop("qRemediation", None)
    return emitted


def emit_action_events(
    results: list[dict],
    state: dict,
    config: SentinelConfig,
    now: float,
    controller_host: str,
    fleet_action: str,
    oracle: dict,
) -> list[dict]:
    emitted = emit_q_unavailable_event(state, config, now, controller_host)
    host_state = state.setdefault("hosts", {})
    q_host_result = next((result for result in results if str(result.get("host") or "") == config.q_host), None)
    for result in results:
        action = str(result.get("action") or "")
        if action not in ACTION_EVENT_ACTIONS:
            continue
        subject = str(result.get("host") or "unknown")
        key = f"host:{subject}:{result.get('class')}:{action}"
        record = host_state.setdefault(subject, {})
        if event_recently_emitted(record, key, now, config.action_event_cooldown_seconds):
            continue
        request_id = request_id_for(now, "host", subject, action, str(result.get("class") or "unknown"))
        path = action_event_path(config, now, "host", subject, action, request_id)
        payload = build_host_action_event(result, now, controller_host, fleet_action, request_id)
        add_tier2_remediation(payload, state, config, now, q_host_result)
        digest_ref = apply_critical_whatsapp_budget(payload, state, config, now, controller_host)
        atomic_write_json(path, payload)
        ref = {"scope": "host", "host": subject, "action": action, "requestId": request_id, "path": str(path)}
        result["actionEvent"] = ref
        emitted.append(ref)
        if digest_ref is not None and digest_ref not in emitted:
            emitted.append(digest_ref)
        record["lastActionEventKey"] = key
        record["lastActionEventAt"] = now
        record["lastActionEventPath"] = str(path)
        record["lastActionEventRequestId"] = request_id

    if fleet_action != "none":
        fleet_record = state_record(state, "fleetActionEvent")
        key = f"fleet:{fleet_action}"
        if not event_recently_emitted(fleet_record, key, now, config.action_event_cooldown_seconds):
            request_id = request_id_for(now, "fleet", "all", fleet_action, fleet_action)
            path = action_event_path(config, now, "fleet", "all", fleet_action, request_id)
            payload = build_fleet_action_event(fleet_action, results, now, controller_host, oracle, request_id)
            digest_ref = apply_critical_whatsapp_budget(payload, state, config, now, controller_host)
            atomic_write_json(path, payload)
            ref = {"scope": "fleet", "action": fleet_action, "requestId": request_id, "path": str(path)}
            emitted.append(ref)
            if digest_ref is not None and digest_ref not in emitted:
                emitted.append(digest_ref)
            fleet_record["lastActionEventKey"] = key
            fleet_record["lastActionEventAt"] = now
            fleet_record["lastActionEventPath"] = str(path)
            fleet_record["lastActionEventRequestId"] = request_id
    return emitted


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
    controller_host = deps.hostname()
    hosts = load_hosts(config.hosts_path, config.state_dir)
    # Independently derive the roster inventory (digest + expected counts) from
    # the same manifest the sentinel supervised, and bind it to the heartbeat so
    # the watchdog can reject a truncated / wrong-path / roster-blind snapshot.
    try:
        _roster_data, roster_inventory_data = load_roster(config.hosts_path)
        roster_epoch_value = roster_epoch(config.hosts_path)
    except RosterError:
        roster_inventory_data = None
        roster_epoch_value = None
    state = load_state(config)
    state["schemaVersion"] = 1
    state["updatedAt"] = now_iso(now)
    state["controllerHost"] = controller_host
    host_state = state.setdefault("hosts", {})
    configured_hosts = {spec.host for spec in hosts}
    for host in list(host_state):
        if host not in configured_hosts:
            del host_state[host]

    results = []
    for spec in hosts:
        record = host_state.get(spec.host)
        if not isinstance(record, dict):
            record = default_host_record()
            host_state[spec.host] = record
        heartbeat = heartbeat_inventory(spec, now, config.heartbeat_max_age_seconds, config.max_clock_skew_seconds)
        try:
            raw_probe = deps.pull_probe(spec, now, config.heartbeat_max_age_seconds)
        except Exception as exc:
            raw_probe = {
                "reachable": True,
                "healthy": False,
                "class": "probe_error",
                "error": f"{type(exc).__name__}: {exc}"[:300],
            }
        probe = normalize_probe(raw_probe)
        result = evaluate_host(spec, heartbeat, probe, record, now, config)
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
        # Suppress any active tier-1 heal candidate during a fleet-wide outage —
        # firing a heal here is the worst possible time. Mirror the per-host
        # mutation that central_connectivity_suspect already performs. Only
        # active candidates are deferred; hysteresis_wait/escalate/etc. are
        # untouched. defer_mass_unreachable is not an attention/event action,
        # so it raises no alert (the fleet event already conveys the outage).
        for result in results:
            if result.get("action") == "tier1_heal_candidate":
                result["action"] = "defer_mass_unreachable"
                host_state[result["host"]]["lastAction"] = result["action"]
    else:
        tier1_action = apply_tier1_bounds(results, host_state, config)
        if tier1_action is not None:
            fleet_action = tier1_action

    for spec, result in zip(hosts, results):
        try:
            ack_path = write_ack(spec, result, now)
        except Exception as exc:
            result["ackError"] = f"{type(exc).__name__}: {exc}"[:300]
        else:
            if ack_path is not None:
                result["ackPath"] = ack_path

    state["lastFleetAction"] = fleet_action
    state["lastReachabilityOracle"] = oracle
    # Advance a generation counter so workers can detect stale events.
    state["cycleSeq"] = int_or_zero(state.get("cycleSeq")) + 1
    action_events = emit_action_events(results, state, config, now, controller_host, fleet_action, oracle)
    # Bound the outbox at cycle end: it has no consumer, so prune to the newest
    # N files and surface the resulting depth for observability.
    action_outbox_depth = prune_action_outbox(config)
    try:
        result = {
            "schemaVersion": 1,
            "checkedAt": now_iso(now),
            "controllerHost": controller_host,
            "fleetAction": fleet_action,
            "reachabilityOracle": oracle,
            "hosts": results,
            "actionEvents": action_events,
            "actionOutboxDepth": action_outbox_depth,
            "statePath": str(state_path(config)),
            "cycleSeq": state["cycleSeq"],
            "rosterInventory": roster_inventory_data,
            "rosterEpoch": roster_epoch_value,
        }
        result["heartbeatPath"] = save_central_heartbeat(config, result)
        return result
    finally:
        # Guarantee state is persisted even if save_central_heartbeat raises.
        save_state(config, state)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate BOT ERRORS Fleet Runtime Sentinel state")
    parser.add_argument("--hosts", default=str(default_hosts_path()))
    parser.add_argument("--state-dir", default=str(state_root()))
    parser.add_argument(
        "--redeem-token",
        default=None,
        help="Raw Tier-2 remediation token to redeem (single-use). Requires --redeem-request-id. "
        "Stamps redeemedAt under the instance lock so the token cannot be replayed within its TTL.",
    )
    parser.add_argument(
        "--redeem-request-id",
        default=None,
        help="requestId bound to the token being redeemed (from the q-remediation-request payload).",
    )
    return parser.parse_args(argv)


def result_requires_attention(result: dict) -> bool:
    if result.get("fleetAction") in ATTENTION_FLEET_ACTIONS:
        return True
    if any(event.get("action") in ATTENTION_ACTIONS for event in result.get("actionEvents", [])):
        return True
    if any(host.get("ackError") for host in result.get("hosts", [])):
        return True
    return any(host.get("action") in ATTENTION_ACTIONS for host in result.get("hosts", []))


def _instance_lock_path() -> Path:
    return Path(
        os.environ.get(
            "BOT_ERRORS_FLEET_SENTINEL_LOCK",
            str(Path.home() / ".local/state/bot-errors/fleet-sentinel/sentinel-instance.lock"),
        )
    )


def acquire_instance_lock(lock_path: Path) -> Optional[int]:
    """Take a non-blocking exclusive advisory lock so two launchd-started copies
    cannot run concurrently (KeepAlive + StartInterval can overlap a slow cycle).
    Returns the held fd, or None if another live instance holds the lock.
    flock releases automatically on process exit, so no stale lock is possible."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()}\n".encode())
    return fd


def run_redeem(config: SentinelConfig, request_id: str, token: str) -> dict:
    """Load state, attempt single-use token redemption, persist on success.

    Runs under the caller's instance lock so the redeemedAt write is serialized
    against the per-cycle run_once writers (same flock, single JSON state file).
    The state file is only re-written when a token is actually stamped, so
    rejections never mutate persisted state."""
    now = time.time()
    state = load_state(config)
    outcome = redeem_q_remediation(state, now, request_id, token)
    if outcome.get("redeemed"):
        state["schemaVersion"] = 1
        state["updatedAt"] = now_iso(now)
        save_state(config, state)
    return {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-redeem",
        "checkedAt": now_iso(now),
        "statePath": str(state_path(config)),
        **outcome,
    }


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    config = default_config(Path(args.hosts).expanduser(), Path(args.state_dir).expanduser())
    redeem_requested = args.redeem_token is not None or args.redeem_request_id is not None
    if redeem_requested and (args.redeem_token is None or args.redeem_request_id is None):
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "kind": "bot-errors-sentinel-redeem",
                    "redeemed": False,
                    "reason": "redeem_requires_token_and_request_id",
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    lock_path = _instance_lock_path()
    lock_fd = acquire_instance_lock(lock_path)
    if lock_fd is None:
        # Another instance is mid-cycle. Exit 0 so the SuccessfulExit:false
        # KeepAlive does NOT restart us; the predecessor finishes uninterrupted.
        print(json.dumps({"schemaVersion": 1, "checkedAt": now_iso(), "skipped": "already_running"}, sort_keys=True))
        return 0
    try:
        if redeem_requested:
            redeem_result = run_redeem(config, args.redeem_request_id, args.redeem_token)
            print(json.dumps(redeem_result, sort_keys=True))
            return 0 if redeem_result.get("redeemed") else 1
        result = run_once(config)
    except Exception as exc:
        print(json.dumps({"schemaVersion": 1, "healthy": False, "class": "fleet_sentinel_error", "problems": [str(exc)]}, sort_keys=True), file=sys.stderr)
        return 2
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
            lock_path.unlink()
        except (OSError, FileNotFoundError):
            pass
    print(json.dumps(result, sort_keys=True))
    if result_requires_attention(result):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
