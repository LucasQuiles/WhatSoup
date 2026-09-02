#!/usr/bin/env python3
"""Central Fleet Runtime Sentinel evaluator.

This is the central-side state-machine foundation. It consumes host selfcheck
heartbeats and independent probe snapshots, applies the two-signal and
hysteresis rules, runs optional SSH runtime probes, and records action
decisions. Later rollout slices can wire the action sink to heal/alert workers.
"""
from __future__ import annotations

import argparse
import copy
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
from lib.durable_json import (  # noqa: E402
    JsonVersion,
    durable_json_target,
    observe_json,
    operation_id,
    publish_event_json,
    publish_state_json,
    require_advance,
    require_all_advance,
)
from lib.state_files import FLEET_SENTINEL_STATE, SENTINEL_HEARTBEAT  # noqa: E402
from lib.state_root import sentinel_state_root  # noqa: E402
from lib import sentinel_pin  # noqa: E402

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
# #2429 sentinel roster-removal extension. Retirement is deliberately NOT a
# member of ACTION_EVENT_ACTIONS (emit_action_events must never mint it),
# NOT a member of EXTERNAL_REMEDIATION_ACTIONS (consume_action_outbox must
# never execute it), and NOT the "clear" action (whose lane is
# resolved_state_change, i.e. health evidence). Roster absence is
# configuration evidence, not health evidence.
CONFIGURATION_RETIRED_ACTION = "configuration_retired"
CONFIGURATION_RETIRED_DISPOSITION = "configuration_retired"
CONFIGURATION_RETIRED_REASON = "host_not_in_roster"
CONFIGURATION_RETIRED_TIER = "configuration"
CONFIGURATION_RETIRED_LANE = "configuration_retirement"
# Bounded tombstone: long enough to dedupe a delayed acknowledgement or action
# for a retired member and to correlate a re-addition, short enough that the
# state file cannot grow without bound.
RETIRED_HOST_TOMBSTONE_MAX = 64
RETIRED_HOST_TOMBSTONE_TTL_SECONDS = 30 * 24 * 3600
# What a retirement did to the fleet-wide Tier-2 remediation slot, as bounded
# enum tokens. Never free text and never a reason string: the tombstone is an
# audit record a consumer parses, and prose here would smuggle unbounded
# content into a ledger whose whole point is that it carries none.
QREMEDIATION_RETIREMENT_CANCELLED = "cancelled_host_retired"
QREMEDIATION_RETIREMENT_NONE = "none"
# Pending-retirement intents: the durable record that pins a retirement's FIRST
# attempt clock so a retry republishes byte-identical bytes instead of a second
# timestamped artifact. Bounded the same way the tombstone ledger is.
RETIREMENT_INTENT_LEDGER = "sentinel-retirement-intents.json"
RETIREMENT_INTENT_MAX = 64
RETIREMENT_INTENT_TTL_SECONDS = 7 * 24 * 3600

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
    # The tree this process actually evaluates (its own script location by
    # default). Source-provenance detection hashes this tree against the
    # runtime-manifest owner's file table (#1876).
    runtime_root: Path = REPO_ROOT


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
    resolved_state_dir = state_dir or sentinel_state_root()
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
    try:
        path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.is_symlink():
            raise SentinelError(
                f"refusing to use sentinel state directory through symlink: {path}"
            )
        if not os.path.isdir(path):
            raise SentinelError(
                f"refusing to use sentinel state directory over non-directory path: {path}"
            )
    try:
        path.chmod(0o700)
    except OSError:
        pass


def _durable_target(path: Path):
    ensure_private_dir(path.parent)
    return durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )


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


_OBSERVATION_DIGEST_DOMAIN = b"bot-errors-heartbeat-observation:"


def heartbeat_observation_digest(payload: dict) -> str:
    """Domain-separated digest of a heartbeat's canonical content (#2468).

    Content-canonical (sorted keys, compact separators) rather than raw
    bytes, so a transport that re-serializes the same content still matches
    the digest the writer recorded. Must stay byte-identical to the helper
    of the same name in bot-errors-selfcheck.py (cross-pinned by test).
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(_OBSERVATION_DIGEST_DOMAIN + canonical).hexdigest()


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
    return config.state_dir / FLEET_SENTINEL_STATE


def heartbeat_path(config: SentinelConfig) -> Path:
    return config.state_dir / SENTINEL_HEARTBEAT


def action_outbox_dir(config: SentinelConfig) -> Path:
    return config.action_outbox_dir or config.state_dir / "actions"


def retirement_intent_path(config: SentinelConfig) -> Path:
    return config.state_dir / RETIREMENT_INTENT_LEDGER


def execute_action(action: dict[str, Any]) -> None:
    """Execute a sentinel remediation action.

    Supported action types:
    - ``restart_host`` (host: str) — systemctl restart the host.
    - ``escalate`` (reason: str) — log the escalation; actual alerting is
      handled separately.
    """
    action_type = action.get("action") if isinstance(action, dict) else None
    if action_type == "restart_host":
        host = str(action.get("host", ""))
        if not host:
            raise ValueError("restart_host action missing 'host'")
        if host.startswith("-") or "/" in host or any(c.isspace() for c in host):
            raise ValueError(f"restart_host: invalid host {host!r}")
        if sys.platform != "linux":
            raise RuntimeError("restart_host requires linux/systemd")
        proc = subprocess.run(
            ["systemctl", "restart", "--", host],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            timeout=60, check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"restart_host {host} failed rc={proc.returncode}: {proc.stdout[-200:]}")
    elif action_type == "escalate":
        reason = str(action.get("reason", "no reason given"))
        print(f"[bot-errors-sentinel] escalation: {reason}", file=sys.stderr)
    else:
        print(f"[bot-errors-sentinel] unknown action type {action_type!r}", file=sys.stderr)


EXTERNAL_REMEDIATION_ACTIONS = ("restart_host",)


def consume_action_outbox(config: SentinelConfig, retired_hosts: Optional[dict] = None) -> int:
    """Consume pending external remediation actions from the action outbox.

    Dispatches only the action types this consumer actually executes
    (``EXTERNAL_REMEDIATION_ACTIONS``), renaming each file to ``.done`` on
    success or ``.failed`` on error.

    ``retired_hosts`` is the live tombstone ledger (``state["retiredHosts"]``).
    An action whose subject carries a live tombstone is NOT executed: the member
    was deliberately removed from the roster, so a remediation queued before the
    retirement is stale by construction and restarting a decommissioned host is
    exactly the wrong outcome. It is renamed ``.retired``, a terminal
    disposition in the same vocabulary as ``.done``/``.failed``, so it is neither
    retried each cycle nor silently resurrected when the tombstone ages out.
    This is the dedupe half of #2429's tombstone bullet.

    Every other file is left untouched:
    escalate / q-remediation records carry tokens whose consumer is the
    redeem CLI (prune is their terminal disposition), clear/ack event records
    have their own readers, and internal actions have their own consumers —
    a broader match here once consumed clear-event and token files those
    flows depended on. Returns the count of consumed actions.
    """
    outbox = action_outbox_dir(config)
    consumed = 0
    try:
        for entry in sorted(outbox.iterdir()):
            if entry.suffix != ".json" or entry.name.startswith("."):
                continue
            try:
                action = json.loads(entry.read_text(encoding="utf-8"))
                action_type = action.get("action") if isinstance(action, dict) else None
                if action_type not in EXTERNAL_REMEDIATION_ACTIONS:
                    continue
                subject = str(action.get("host") or "")
                if retired_hosts and subject and subject in retired_hosts:
                    print(
                        f"[bot-errors-sentinel] action skipped for retired subject: {entry.name}",
                        file=sys.stderr,
                    )
                    # Its own handler, deliberately NOT the outer one. A raced
                    # rename, an EPERM on the directory or ENOSPC at the
                    # directory inode would otherwise fall through to the
                    # ``.failed`` rename below, and ``.failed`` reads
                    # downstream as a remediation failure rather than "subject
                    # retired, do nothing" -- a fabricated failure against a
                    # member that was deliberately decommissioned. Leaving the
                    # file untouched is correct: the next cycle consults the
                    # tombstone again and reaches the same disposition.
                    try:
                        entry.rename(entry.with_suffix(".retired"))
                    except Exception as exc:
                        print(
                            f"[bot-errors-sentinel] retired-subject disposition deferred "
                            f"{entry.name}: {exc}",
                            file=sys.stderr,
                        )
                    continue
                execute_action(action)
                entry.rename(entry.with_suffix(".done"))
                consumed += 1
            except Exception as exc:
                print(f"[bot-errors-sentinel] action consume failed {entry.name}: {exc}", file=sys.stderr)
                entry.rename(entry.with_suffix(".failed"))
    except FileNotFoundError:
        pass
    return consumed


def prune_action_outbox(config: SentinelConfig) -> int:
    """Bound the action outbox: keep the newest ``action_outbox_retention``
    files by mtime and delete the rest. ``consume_action_outbox`` renames
    processed actions to ``.done``/``.failed`` rather than deleting them, and
    internal action types are skipped entirely, so without this sweep the
    directory still grows without bound (inode/disk exhaustion). Returns the
    outbox depth after pruning."""
    outbox = action_outbox_dir(config)
    retention = max(0, config.action_outbox_retention)
    try:
        with os.scandir(outbox) as scan:
            files = [
                Path(entry.path)
                for entry in scan
                if entry.is_file() and entry.name != ".durable-json.lock"
            ]
    except FileNotFoundError:
        print(f"[bot-errors-sentinel] action outbox {outbox} does not exist", file=sys.stderr)
        return 0
    except OSError as exc:
        print(f"[bot-errors-sentinel] action outbox scan failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 0
    # Sort newest-first so the kept slice is the freshest by mtime; the path
    # name breaks ties deterministically.
    def sort_key(entry: Path) -> tuple:
        try:
            mtime = entry.stat().st_mtime
        except OSError as exc:
            print(f"[bot-errors-sentinel] action outbox file stat failed for {entry}: {type(exc).__name__}: {exc}", file=sys.stderr)
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
    target = _durable_target(state_path(config))
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        state,
        component="sentinel.state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        state,
        component="sentinel.state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)


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


SOURCE_PROVENANCE_STATUSES = ("verified", "unavailable", "malformed", "unstamped", "mismatch")


def is_source_commit_id(value: object) -> bool:
    """True for the repository's accepted immutable source-commit object id:
    a lowercase 40-char hex SHA-1 git object id — exactly the shape the
    runtime-manifest owner (``sentinel_pin.load_pin``, the deployer's ``pin``
    mode, and the approved-heads ledger) stamps and validates as
    ``expected_head_sha``."""
    return sentinel_pin._is_lower_hex(value, 40)


def resolve_runtime_manifest_path(runtime_root: Path) -> Path:
    """Resolve the source-provenance SSOT: the same host-local runtime-manifest
    contract ``bot-errors-health-check.py`` reads (``BOT_ERRORS_RUNTIME_MANIFEST``
    env override; default: the evaluating tree's own
    ``deploy/bot-errors-runtime-manifest.json``). The deployer stamps that
    manifest's ``expected_head_sha`` at deploy time — with the checkout's HEAD
    on Git-backed hosts and with the shipped source SHA on non-Git release
    snapshots — so it is the one owner that works for both tree kinds."""
    raw = os.environ.get("BOT_ERRORS_RUNTIME_MANIFEST", "").strip()
    return Path(raw).expanduser() if raw else runtime_root / "deploy" / "bot-errors-runtime-manifest.json"


def evaluate_source_provenance(runtime_root: Path, manifest_path: Optional[Path] = None) -> dict:
    """DETECTION ONLY (no decision, no state writes) for #1876.

    Binds the heartbeat's ``sourceCommit`` to the evaluating generation's bytes:

    1. resolve the runtime-manifest owner (see resolve_runtime_manifest_path);
    2. load it with the owner's loader (``sentinel_pin.load_pin``), which
       strictly validates ``expected_head_sha`` as a lowercase 40-char object
       id — malformed/unsupported ids never reach the heartbeat;
    3. re-hash the pinned runtime surface under ``runtime_root``
       (``sentinel_pin.verify_bundle``: confined, symlink-refusing opens), so a
       claimed commit whose attested bytes differ from the tree the sentinel is
       actually evaluating is a mismatch, not an attestation.

    Returns a bounded, privacy-safe record (statuses in
    SOURCE_PROVENANCE_STATUSES; fixed reason tokens — no repository paths, host
    identities, or dirty-file names). ``sourceCommit`` is set ONLY when every
    step verifies. Git is never invoked: a non-Git release snapshot carries the
    same owner manifest, so provenance follows the owner, not a checkout."""
    resolved = manifest_path or resolve_runtime_manifest_path(runtime_root)
    record: dict = {
        "status": "unavailable",
        "sourceCommit": None,
        "reason": "manifest_missing",
        "manifestDigest": None,
        "mismatchCount": None,
    }
    if os.path.islink(resolved):
        record["reason"] = "manifest_symlink"
        return record
    if not resolved.is_file():
        return record
    try:
        pin = sentinel_pin.load_pin(resolved)
    except sentinel_pin.PinLoadError:
        record["status"] = "malformed"
        record["reason"] = "runtime_manifest_malformed"
        return record
    except Exception:
        record["reason"] = "evaluation_error"
        return record
    record["manifestDigest"] = pin.manifest_digest
    if not pin.head_sha:
        record["status"] = "unstamped"
        record["reason"] = "expected_head_sha_absent"
        return record
    bytes_ok, mismatches = sentinel_pin.verify_bundle(runtime_root, pin)
    if not bytes_ok:
        record["status"] = "mismatch"
        record["reason"] = "evaluating_bytes_mismatch"
        record["mismatchCount"] = len(mismatches)
        return record
    record["status"] = "verified"
    record["reason"] = "verified"
    record["sourceCommit"] = pin.head_sha
    record["mismatchCount"] = 0
    return record


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

    # #1876: aggregate source-commit provenance. Detection ran in run_once
    # (evaluate_source_provenance); this is the DECISION (green gate) plus
    # REPORTING (bounded heartbeat fields). The aggregate is authoritative
    # green only with present, verified, well-formed provenance:
    # unavailable / malformed / unstamped / byte-mismatched provenance is
    # explicit non-green — the field is never omitted while claiming health.
    provenance = result.get("sourceProvenance")
    provenance = provenance if isinstance(provenance, dict) else {}
    provenance_status = provenance.get("status")
    provenance_status = (
        provenance_status
        if isinstance(provenance_status, str) and provenance_status in SOURCE_PROVENANCE_STATUSES
        else "unavailable"
    )
    claimed_commit = provenance.get("sourceCommit")
    provenance_ok = provenance_status == "verified" and is_source_commit_id(claimed_commit)
    provenance_reason = provenance.get("reason")
    provenance_reason = provenance_reason if isinstance(provenance_reason, str) and provenance_reason else "unspecified"
    provenance_digest = provenance.get("manifestDigest")
    provenance_digest = provenance_digest if sentinel_pin._is_lower_hex(provenance_digest, 64) else None
    mismatch_count = provenance.get("mismatchCount")
    mismatch_count = (
        mismatch_count
        if isinstance(mismatch_count, int) and not isinstance(mismatch_count, bool) and mismatch_count >= 0
        else None
    )

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
    healthy = bool(base_healthy and roster_bound and provenance_ok)

    payload = {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-heartbeat",
        "sweepStartedAt": result.get("sweepStartedAt"),
        "sweepDurationSeconds": result.get("sweepDurationSeconds"),
        "checkedAt": result.get("checkedAt"),
        "controllerHost": result.get("controllerHost"),
        "healthy": healthy,
        "fleetAction": result.get("fleetAction"),
        "hostCount": len(hosts),
        "problemHostCount": len(problem_hosts),
        "rosterDigest": roster_digest_val if roster_digest_val else None,
        "rosterEpoch": roster_epoch_val if isinstance(roster_epoch_val, int) and not isinstance(roster_epoch_val, bool) else None,
        "sourceCommit": claimed_commit if provenance_ok else None,
        "sourceProvenance": {
            "status": provenance_status,
            "reason": provenance_reason,
            "manifestDigest": provenance_digest,
            "mismatchCount": mismatch_count,
        },
        "expectedHostCount": expected_host_count,
        "observedHostCount": observed_host_count,
        "unknownHostCount": unknown_host_count,
        "expectedInstanceCount": expected_instance_count,
        "observedInstanceCount": observed_instance_count,
        "problemInstanceCount": problem_instance_count,
        "unknownInstanceCount": unknown_instance_count,
        "metrics": result.get("metrics") if isinstance(result.get("metrics"), dict) else None,
    }
    # #2432: signal non-green aggregate when fleetAction is "none" so the
    # watchdog can create a durable problem (otherwise aggregate health
    # false + fleetAction=none passes the watchdog silently).
    if not healthy and result.get("fleetAction") == "none":
        payload["nonGreenReason"] = (
            f"aggregate_health_false roster_bound={roster_bound} source_provenance={provenance_status}"
        )
    path = heartbeat_path(config)
    target = _durable_target(path)
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        payload,
        component="sentinel.central_heartbeat",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        payload,
        component="sentinel.central_heartbeat",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)
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
    raw_checked_at = payload.get("checkedAt")
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
        "checkedAt": raw_checked_at if isinstance(raw_checked_at, str) else None,
        "contentDigest": heartbeat_observation_digest(payload),
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
    target = _durable_target(path)
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        payload,
        component="sentinel.critical_whatsapp_digest",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        payload,
        component="sentinel.critical_whatsapp_digest",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)
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
    state_before_event = copy.deepcopy(state)
    timeout_record = state_record(state, "qUnavailableEvent")
    if event_recently_emitted(timeout_record, key, now, config.action_event_cooldown_seconds):
        state.pop("qRemediation", None)
        return []
    host = str(record.get("host") or "unknown")
    request_id = stable_request_id("q_unavailable", host, record.get("requestId"), record.get("actionHash"))
    path = q_unavailable_event_path(config, now, host, request_id)
    payload = build_q_unavailable_event(record, now, controller_host, request_id)
    digest_ref = apply_critical_whatsapp_budget(payload, state, config, now, controller_host)
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        payload,
        component="sentinel.q_unavailable_event",
        predecessor=absent,
    )
    try:
        publication = publish_event_json(
            target,
            payload,
            component="sentinel.q_unavailable_event",
            operation_id=publication_operation,
        )
        require_all_advance([publication])
    except Exception:
        state.clear()
        state.update(state_before_event)
        raise
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
        state_before_event = copy.deepcopy(state)
        record = host_state.setdefault(subject, {})
        if event_recently_emitted(record, key, now, config.action_event_cooldown_seconds):
            continue
        request_id = request_id_for(now, "host", subject, action, str(result.get("class") or "unknown"))
        path = action_event_path(config, now, "host", subject, action, request_id)
        payload = build_host_action_event(result, now, controller_host, fleet_action, request_id)
        add_tier2_remediation(payload, state, config, now, q_host_result)
        digest_ref = apply_critical_whatsapp_budget(payload, state, config, now, controller_host)
        target = _durable_target(path)
        absent = JsonVersion(False, None, None, None)
        publication_operation = operation_id(
            target,
            payload,
            component="sentinel.action_event_primary",
            predecessor=absent,
        )
        try:
            publication = publish_event_json(
                target,
                payload,
                component="sentinel.action_event_primary",
                operation_id=publication_operation,
            )
            require_all_advance([publication])
        except Exception:
            state.clear()
            state.update(state_before_event)
            raise
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
        state_before_event = copy.deepcopy(state)
        fleet_record = state_record(state, "fleetActionEvent")
        key = f"fleet:{fleet_action}"
        if not event_recently_emitted(fleet_record, key, now, config.action_event_cooldown_seconds):
            request_id = request_id_for(now, "fleet", "all", fleet_action, fleet_action)
            path = action_event_path(config, now, "fleet", "all", fleet_action, request_id)
            payload = build_fleet_action_event(fleet_action, results, now, controller_host, oracle, request_id)
            digest_ref = apply_critical_whatsapp_budget(payload, state, config, now, controller_host)
            target = _durable_target(path)
            absent = JsonVersion(False, None, None, None)
            publication_operation = operation_id(
                target,
                payload,
                component="sentinel.action_event_secondary",
                predecessor=absent,
            )
            try:
                publication = publish_event_json(
                    target,
                    payload,
                    component="sentinel.action_event_secondary",
                    operation_id=publication_operation,
                )
                require_all_advance([publication])
            except Exception:
                state.clear()
                state.update(state_before_event)
                raise
            ref = {"scope": "fleet", "action": fleet_action, "requestId": request_id, "path": str(path)}
            emitted.append(ref)
            if digest_ref is not None and digest_ref not in emitted:
                emitted.append(digest_ref)
            fleet_record["lastActionEventKey"] = key
            fleet_record["lastActionEventAt"] = now
            fleet_record["lastActionEventPath"] = str(path)
            fleet_record["lastActionEventRequestId"] = request_id
    return emitted


def write_ack(spec: HostSpec, result: dict, now: float, evaluation: Optional[dict] = None) -> Optional[str]:
    if spec.ack_path is None:
        return None
    heartbeat = result.get("heartbeat") if isinstance(result.get("heartbeat"), dict) else {}
    payload = {
        "schemaVersion": 2,
        "kind": "bot-errors-central-ack-receipt",
        "host": spec.host,
        "ackedAt": now_iso(now),
        "centralClass": result.get("class"),
        "centralAction": result.get("action"),
        # Observation binding (#2468): which heartbeat content this receipt
        # actually evaluated. contentDigest is None when the heartbeat was
        # missing or unparseable — a receipt must never bind to garbage.
        "observedHeartbeat": {
            "checkedAt": heartbeat.get("checkedAt"),
            "contentDigest": heartbeat.get("contentDigest"),
            "ageSeconds": heartbeat.get("ageSeconds"),
        },
        "evaluation": {"evaluatedAt": now_iso(now), **(evaluation or {})},
    }
    target = _durable_target(spec.ack_path)
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        payload,
        component="sentinel.ack",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        payload,
        component="sentinel.ack",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)
    return str(spec.ack_path)


def default_deps(config: Optional[SentinelConfig] = None) -> SentinelDeps:
    oracle_path = config.oracle_path if config is not None else None
    return SentinelDeps(
        now_epoch=time.time,
        hostname=socket.gethostname,
        pull_probe=default_pull_probe,
        reachability_oracle=lambda: oracle_inventory(oracle_path),
    )


def compute_cycle_metrics(results: list, action_events: list) -> dict:
    """Per-cycle countable operational metrics (#1876 P1).

    The sentinel is evaluation-only: it emits heal *candidates* and escalation /
    freeze / defer *decisions*, it does not execute heals (the selfcheck /
    deployer does). So these counts report what the sentinel DECIDED this cycle,
    derived from the evaluated host `results` and the emitted `action_events` —
    not heal execution success/failure, which the selfcheck heartbeat owns.
    Emitted into the central heartbeat so the counts are observable off-host.
    """
    by_action: dict[str, int] = {}
    for record in results:
        if isinstance(record, dict):
            action = str(record.get("action") or "none")
            by_action[action] = by_action.get(action, 0) + 1

    def count(action: str) -> int:
        return by_action.get(action, 0)

    events = [event for event in action_events if isinstance(event, dict)]
    return {
        "hostsEvaluated": sum(1 for record in results if isinstance(record, dict)),
        "healCandidates": count("tier1_heal_candidate"),
        "escalations": count("escalate") + count("escalate_flapping"),
        "flapEscalations": count("escalate_flapping"),
        "correlatedDriftFreezes": count("freeze_correlated_drift"),
        "concurrencyDeferrals": count("defer_tier1_concurrency_cap"),
        "massUnreachableDeferrals": count("defer_mass_unreachable"),
        "connectivitySuppressions": count("suppress_central_connectivity_suspect"),
        "qUnavailable": count("q_unavailable"),
        "actionEventsEmitted": len(events),
        "attentionEventsEmitted": sum(1 for event in events if event.get("action") in ATTENTION_ACTIONS),
        "byAction": by_action,
    }


def host_set_digest(hosts) -> str:
    """Opaque, order-independent digest over a host set.

    Used for both the previous and the current roster so the two are directly
    comparable, and for the retired member itself, so a consumer can bind a
    retirement to the roster revision that caused it without the event having
    to carry the membership list.
    """
    canonical = "\0".join(sorted(str(host) for host in hosts))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def retired_host_summary(record: dict) -> dict:
    """Bounded, content-free summary of the ownership a retirement destroys.

    Enums and counts only. The point is that a reader can see WHAT was owned
    (an open alert, a cooldown, flap history) without the event carrying probe
    output, error text, or heartbeat contents.
    """
    if not isinstance(record, dict):
        return {"recordPresent": False}
    transitions = record.get("transitions")
    return {
        "recordPresent": True,
        "alertState": str(record.get("alertState") or "unknown"),
        "consecutive": int_or_zero(record.get("consecutive")),
        "transitionCount": len(transitions) if isinstance(transitions, list) else 0,
        "lastClass": str(record.get("lastClass") or "") or None,
        "lastAction": str(record.get("lastAction") or "") or None,
        "hadActionCooldown": record.get("lastActionEventKey") is not None,
        "lastBadAtPresent": record.get("lastBadAt") is not None,
    }


def build_configuration_retired_event(
    host: str,
    record: dict,
    now: float,
    controller_host: str,
    request_id: str,
    roster: dict,
) -> dict:
    """One typed configuration-retirement disposition for one retired member.

    severity info and criticalWhatsAppEligible False: this is an audit record,
    not a page. recoveryClaimed False is explicit because the whole point of
    #2429 is that a retirement must never be mistaken for a recovery.

    CONSUMER CONTRACT -- duplicates are collapsed by ``requestId``, never by
    file path. The path is not an identity: ``action_event_path`` embeds a
    timestamp, and a cycle that publishes one member then fails on another
    persists nothing (the raise escapes above run_once's ``finally:
    save_state``), so the first member is republished next cycle. A consumer
    that dedupes on the filename will double-count; one that dedupes on
    ``requestId`` will not.

    ``reconcile_retirement_intents`` pins the first attempt's clock so that
    retry reproduces byte-identical bytes and reconciles into the SAME file,
    which removes the duplicate in the common case. It does not remove it in
    every case, and the two kinds of roster change are NOT equivalent:

    - A MEMBERSHIP change between a failed cycle and its retry -- a second
      member leaving, a member being added, a rename -- moves the digests,
      because ``host_set_digest`` hashes the member names. The ``requestId`` is
      derived from those digests, so it moves too and requestId-based dedupe
      has nothing to match. The digests cover the whole member set, not just
      the departing member, so this is far wider than a second departure. That
      case still leaves two audit records for one retirement.
    - A MANIFEST-ONLY change -- a new ``manifestDigest`` or ``manifestEpoch``,
      the latter being just the roster file's integer mtime -- does NOT move
      the digests and therefore does NOT move the ``requestId``. It rides in
      the ``roster`` block of the payload, so it moves the retirement-intent
      content binding and starts a fresh pinned episode, but dedupe by
      ``requestId`` still collapses the records correctly.

    The contract stated here is the only thing a consumer can rely on.
    """
    return {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-configuration-retired",
        "scope": "host",
        "requestId": request_id,
        "createdAt": now_iso(now),
        "controllerHost": controller_host,
        "host": host,
        "subjectDigest": host_set_digest([host]),
        "action": CONFIGURATION_RETIRED_ACTION,
        "disposition": CONFIGURATION_RETIRED_DISPOSITION,
        "dispositionReason": CONFIGURATION_RETIRED_REASON,
        "tier": CONFIGURATION_RETIRED_TIER,
        "lane": CONFIGURATION_RETIRED_LANE,
        "severity": "info",
        "criticalWhatsAppEligible": False,
        "recoveryClaimed": False,
        "healthEvidence": False,
        "retiredRecord": retired_host_summary(record),
        "roster": roster,
    }


def enforce_retired_host_tombstone_cap(state: dict) -> dict:
    """The ONLY count-cap enforcement site for the tombstone ledger.

    Kept separate from the age prune because the two run at different points:
    age is evaluated once per cycle against that cycle's clock, but the count
    has to be evaluated AFTER the retirement loop's insertions. Enforcing it
    only before the loop lets a ledger already at the cap reach save_state at
    cap+N and sit there on disk until the next cycle -- bounded by the members
    retired in one cycle, but past the documented bound and durable.

    Newest-first, so a cycle's own retirements are what survives the trim.
    """
    tombstones = state.get("retiredHosts")
    if not isinstance(tombstones, dict):
        tombstones = {}
        state["retiredHosts"] = tombstones
    if len(tombstones) > RETIRED_HOST_TOMBSTONE_MAX:
        ordered = sorted(
            tombstones.items(),
            key=lambda item: (
                finite_float(item[1].get("retiredAt")) or 0.0 if isinstance(item[1], dict) else 0.0
            ),
            reverse=True,
        )
        state["retiredHosts"] = dict(ordered[:RETIRED_HOST_TOMBSTONE_MAX])
    return state["retiredHosts"]


def prune_retired_host_tombstones(state: dict, now: float) -> dict:
    """Keep the tombstone ledger bounded by age and count."""
    tombstones = state.get("retiredHosts")
    if not isinstance(tombstones, dict):
        tombstones = {}
        state["retiredHosts"] = tombstones
    for host, entry in list(tombstones.items()):
        retired_at = finite_float(entry.get("retiredAt")) if isinstance(entry, dict) else None
        if retired_at is None or now - retired_at > RETIRED_HOST_TOMBSTONE_TTL_SECONDS:
            tombstones.pop(host, None)
    return enforce_retired_host_tombstone_cap(state)


def load_retirement_intents(config: SentinelConfig) -> dict:
    """Pending retirement intents, keyed by member.

    Deliberately NOT part of ``state``. retire_unconfigured_hosts rolls state
    back to a pre-publication deepcopy on failure, and the cycle's ``save_state``
    never runs on that path because the raise escapes above run_once's
    ``finally``. An intent held in state would therefore be erased by exactly
    the failure it exists to survive, and an in-memory-only one would die with
    the process -- which is the crash case. It needs its own durable file.

    Unreadable, malformed, or unusably-timestamped entries are dropped rather
    than raising, so READING the ledger never fails a cycle: a lost pin costs a
    duplicate audit record.

    That tolerance does NOT extend to writing it. ``save_retirement_intents``
    publishes through the durable-state path, which refuses to replace a file
    it cannot parse or whose mode/type is wrong: a corrupt ledger raises
    ``DurableWriteError serialization``, and a wrong-mode file or a directory at
    this path raises ``DurableWriteError permission``. Either wedges every cycle
    that has a retiring member, until an operator removes the file. That is the
    same failure the sentinel state file already has, and it is deliberately NOT
    softened here -- failing a write open would need its own design and test.
    """
    ledger = optional_json_object(retirement_intent_path(config)) or {}
    intents = ledger.get("intents")
    if not isinstance(intents, dict):
        return {}
    usable = {}
    for host, entry in intents.items():
        if not isinstance(entry, dict):
            continue
        if finite_float(entry.get("firstAttemptEpoch")) is None:
            continue
        usable[str(host)] = dict(entry)
    return usable


def save_retirement_intents(config: SentinelConfig, intents: dict) -> None:
    payload = {"schemaVersion": 1, "intents": intents}
    target = _durable_target(retirement_intent_path(config))
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        payload,
        component="sentinel.retirement_intent",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        payload,
        component="sentinel.retirement_intent",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)


def retirement_content_binding(payload: dict) -> str:
    """Digest of everything in a retirement disposition EXCEPT its clock.

    Two attempts may share a pinned timestamp only if they would otherwise
    publish identical bytes. Binding the pin to the content is what makes that
    decidable in advance, instead of discovering it as a CONFLICT at
    publication time.
    """
    material = {key: value for key, value in payload.items() if key != "createdAt"}
    return stable_request_id(
        "retirement_content", json.dumps(material, sort_keys=True, separators=(",", ":"))
    )


def reconcile_retirement_intents(
    config: SentinelConfig, bindings: dict, now: float, episode_seq: int
) -> dict:
    """Pin each retiring member's first-attempt clock, durably, before publishing.

    ``action_event_path`` puts ``int(now)`` in the filename and the payload
    carries ``createdAt``, so an unpinned retry writes a SECOND file for the
    same stable requestId. Reusing the recorded epoch for both makes the retry
    byte-identical, and byte-identical is the only input under which
    ``publish_event_json`` reconciles (RECONCILED_COMMITTED /
    INTENDED_AUTHORITATIVE) rather than answering CONFLICT.

    A pin may be reused only for the SAME RETIREMENT EPISODE, which takes two
    independent conditions -- content equality is not enough on its own:

    1. ``contentBinding`` unchanged. If the disposition's bytes would differ,
       reusing the clock would aim an identical filename at differing bytes,
       which ``publish_event_json`` answers with CONFLICT -- a permanent
       retirement wedge. This is why ``int(now)`` deliberately stays in the
       filename.
    2. ``episodeSeq`` unchanged, where the value is ``state["cycleSeq"]`` as
       read at this function's call site in ``retire_unconfigured_hosts``,
       after the per-member binding loop and before any publication. Content
       equality alone
       CANNOT separate a retry from a genuinely new retirement of the same
       member: ``retired_host_summary`` carries no timestamp, so a member
       retired, re-added and retired again under an unchanged roster rebuilds a
       byte-identical disposition. Reusing the pin there makes the second
       retirement reconcile silently onto the FIRST one's artifact -- the record
       is deleted and no event is written for it, which is precisely the #2429
       defect this module exists to end.

    ``cycleSeq`` separates the two cases exactly, because of where it moves:
    it is advanced and persisted only by a cycle that reaches ``save_state``.
    A retry sees the same value, because the failure path raises above
    run_once's ``try/finally`` so nothing was saved. A second episode cannot
    exist without at least one intervening saved cycle, because a member
    re-enters ``state["hosts"]`` only through run_once's evaluation loop.
    ``run_redeem`` also saves state, but touches neither ``cycleSeq`` nor
    ``hosts``, so it cannot forge or erase an episode boundary.

    A MEMBERSHIP change between a failed cycle and its retry moves the digests,
    so the requestId and the roster block move, the binding moves, and a fresh
    episode begins. That case still leaves a requestId-distinct duplicate audit
    record; this ledger does not close it. A manifest-only change (including
    ``manifestEpoch``, the roster file's integer mtime) moves the binding but
    NOT the requestId, so it starts a fresh episode while remaining dedupable.

    A cycle with no retiring members does not touch this file at all.
    Publishing it on an otherwise-clean cycle would add a new way for that
    cycle to raise above run_once's ``finally: save_state`` and lose
    everything. Stale entries therefore linger until the next retirement, which
    rewrites the ledger down to that cycle's retiring set; age and count bounds
    are the backstop.
    """
    stored = load_retirement_intents(config)
    kept: dict = {}
    for host in sorted(bindings)[:RETIREMENT_INTENT_MAX]:
        binding = bindings[host]
        entry = stored.get(host)
        first = finite_float(entry.get("firstAttemptEpoch")) if isinstance(entry, dict) else None
        reusable = (
            isinstance(entry, dict)
            and entry.get("contentBinding") == binding
            and entry.get("episodeSeq") == episode_seq
            and first is not None
            and first <= now
            and now - first <= RETIREMENT_INTENT_TTL_SECONDS
        )
        if not reusable:
            entry = {
                "episodeId": stable_request_id("retirement_intent", host, binding, now),
                "contentBinding": binding,
                "episodeSeq": episode_seq,
                "firstAttemptEpoch": now,
                "firstAttemptAtIso": now_iso(now),
            }
        kept[host] = entry
    if kept != stored:
        save_retirement_intents(config, kept)
    return kept


def retire_unconfigured_hosts(
    state: dict,
    config: SentinelConfig,
    now: float,
    controller_host: str,
    configured_hosts: set,
    roster_inventory_data: Optional[dict],
    roster_epoch_value: Optional[int],
) -> list[dict]:
    """Publish a terminal disposition for every member configuration dropped,
    then delete its record. #2429 sentinel roster-removal extension.

    Ordering is the contract. The disposition is durable (publish_event_json +
    require_all_advance) BEFORE ``del host_state[host]``, and the deletion is
    durable only at the end-of-cycle ``save_state``. If publication fails, the
    in-memory state is rolled back and the exception propagates, exactly as
    emit_action_events does; because this runs above run_once's try/finally,
    no ``save_state`` executes on that path, so the record survives on disk and
    the retirement is retried next cycle. A member is never deleted without a
    published disposition.
    """
    host_state = state.setdefault("hosts", {})
    previous_hosts = sorted(host_state)
    retiring = [host for host in previous_hosts if host not in configured_hosts]
    tombstones = prune_retired_host_tombstones(state, now)
    # Re-addition correlation: a member back in the roster clears its tombstone.
    for host in list(tombstones):
        if host in configured_hosts:
            tombstones.pop(host, None)
    if not retiring:
        return []
    roster = {
        "previousDigest": host_set_digest(previous_hosts),
        "previousCount": len(previous_hosts),
        "currentDigest": host_set_digest(configured_hosts),
        "currentCount": len(configured_hosts),
        "retiredCount": len(retiring),
        "manifestDigest": (roster_inventory_data or {}).get("digest"),
        "manifestEpoch": roster_epoch_value,
    }
    # Durable BEFORE any publication, so a retry can reproduce this cycle's
    # bytes exactly. Only the CLOCK is pinned -- never the requestId, and never
    # across changed content. Each member's disposition is built once with a
    # placeholder clock purely to bind the pin to what will be published.
    bindings = {}
    for host in retiring:
        record = host_state.get(host)
        bindings[host] = retirement_content_binding(
            build_configuration_retired_event(
                host,
                record if isinstance(record, dict) else {},
                0.0,
                controller_host,
                stable_request_id(
                    "configuration_retired", host, roster["previousDigest"], roster["currentDigest"]
                ),
                roster,
            )
        )
    # The episode discriminator is the cycle counter as it stands on disk RIGHT
    # NOW, before run_once advances it later in the same cycle. Same value
    # across a retry (nothing was saved), different across episodes (a saved
    # cycle sat between them). Without it, content equality alone lets a second
    # retirement reconcile onto the first one's artifact.
    intents = reconcile_retirement_intents(
        config, bindings, now, int_or_zero(state.get("cycleSeq"))
    )
    emitted = []
    for host in retiring:
        record = host_state.get(host)
        state_before_event = copy.deepcopy(state)
        intent = intents.get(host)
        pinned_at = finite_float(intent.get("firstAttemptEpoch")) if isinstance(intent, dict) else None
        if pinned_at is None:
            pinned_at = now
        request_id = stable_request_id(
            "configuration_retired", host, roster["previousDigest"], roster["currentDigest"]
        )
        path = action_event_path(
            config, pinned_at, "retirement", host, CONFIGURATION_RETIRED_ACTION, request_id
        )
        payload = build_configuration_retired_event(
            host, record if isinstance(record, dict) else {}, pinned_at, controller_host, request_id, roster
        )
        target = _durable_target(path)
        absent = JsonVersion(False, None, None, None)
        publication_operation = operation_id(
            target,
            payload,
            component="sentinel.configuration_retired_event",
            predecessor=absent,
        )
        try:
            publication = publish_event_json(
                target,
                payload,
                component="sentinel.configuration_retired_event",
                operation_id=publication_operation,
            )
            require_all_advance([publication])
        except Exception:
            state.clear()
            state.update(state_before_event)
            raise
        # Durably published: only now may the record go.
        #
        # The Tier-2 remediation token goes with it. state["qRemediation"] is a
        # SINGLE GLOBAL SLOT, not a per-host map, so a retired member's token
        # refuses every other member's Tier-2 request with
        # ``q_remediation_inflight`` until its TTL runs out, and on expiry
        # emit_q_unavailable_event pages critically -- against the critical
        # WhatsApp budget -- naming a member that no longer exists. Both the
        # live and the expired case are closed by disposing of the token here.
        #
        # ORDERING is the contract, the same contract the record deletion
        # obeys: the disposal sits BELOW the publication and inside the same
        # rollback boundary, so a failed publication leaves the token exactly
        # as it found it. Only the retiring member's own token may be taken --
        # popping the slot unconditionally would strand a live remediation for
        # a still-configured member.
        q_remediation = state.get("qRemediation")
        q_remediation_cancelled = (
            isinstance(q_remediation, dict)
            and bool(q_remediation)
            and str(q_remediation.get("host") or "") == host
        )
        if q_remediation_cancelled:
            state.pop("qRemediation", None)
        tombstones[host] = {
            "retiredAt": now,
            "retiredAtIso": now_iso(now),
            "subjectDigest": payload["subjectDigest"],
            "requestId": request_id,
            "eventPath": str(path),
            "priorAlertState": payload["retiredRecord"].get("alertState"),
            "rosterCurrentDigest": roster["currentDigest"],
            "qRemediationDisposition": (
                QREMEDIATION_RETIREMENT_CANCELLED
                if q_remediation_cancelled
                else QREMEDIATION_RETIREMENT_NONE
            ),
        }
        host_state.pop(host, None)
        emitted.append(
            {
                "scope": "host",
                "host": host,
                "action": CONFIGURATION_RETIRED_ACTION,
                "requestId": request_id,
                "path": str(path),
            }
        )
    # The insertions above are what can push the ledger past its bound, so the
    # count is enforced here rather than only before the loop.
    enforce_retired_host_tombstone_cap(state)
    return emitted


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
    # #1876: detect the evaluating generation's source provenance (bounded,
    # privacy-safe, owner-bound) here; the aggregate green decision and
    # heartbeat reporting consume it in save_central_heartbeat.
    source_provenance = evaluate_source_provenance(config.runtime_root)
    state = load_state(config)
    state["schemaVersion"] = 1
    state["updatedAt"] = now_iso(now)
    state["controllerHost"] = controller_host
    host_state = state.setdefault("hosts", {})
    configured_hosts = {spec.host for spec in hosts}
    # #2429: every member configuration drops gets a published terminal
    # disposition before its record is deleted. Raises rather than deleting if
    # publication fails.
    retirement_events = retire_unconfigured_hosts(
        state,
        config,
        now,
        controller_host,
        configured_hosts,
        roster_inventory_data,
        roster_epoch_value,
    )

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

    # The receipts written below must carry the sequence of the cycle that
    # evaluated them, so the counter is computed before the ack loop and
    # committed to state afterwards (#2468 ordering).
    next_cycle_seq = int_or_zero(state.get("cycleSeq")) + 1
    ack_evaluation = {
        "cycleSeq": next_cycle_seq,
        "rosterEpoch": roster_epoch_value,
        "rosterDigest": (roster_inventory_data or {}).get("digest"),
    }
    for spec, result in zip(hosts, results):
        try:
            ack_path = write_ack(spec, result, now, ack_evaluation)
        except Exception as exc:
            result["ackError"] = f"{type(exc).__name__}: {exc}"[:300]
        else:
            if ack_path is not None:
                result["ackPath"] = ack_path

    state["lastFleetAction"] = fleet_action
    state["lastReachabilityOracle"] = oracle
    # Advance a generation counter so workers can detect stale events.
    state["cycleSeq"] = next_cycle_seq
    action_events = emit_action_events(results, state, config, now, controller_host, fleet_action, oracle)
    # Consume pending actions from the outbox, then prune remaining .done/
    # .failed files.  The consumer reads .json, executes, and renames to .done
    # or .failed so the same action is not consumed twice.
    action_outbox_depth = consume_action_outbox(config, retired_hosts=state.get("retiredHosts"))
    action_outbox_depth = prune_action_outbox(config)
    sweep_started_at = now_iso(now)
    sweep_ended_epoch = deps.now_epoch()
    sweep_duration = max(0, int(sweep_ended_epoch - now))
    sweep_checked_at = now_iso(sweep_ended_epoch)
    try:
        result = {
            "schemaVersion": 1,
            "sweepStartedAt": sweep_started_at,
            "sweepDurationSeconds": sweep_duration,
            "checkedAt": sweep_checked_at,
            "controllerHost": controller_host,
            "fleetAction": fleet_action,
            "reachabilityOracle": oracle,
            "hosts": results,
            "actionEvents": action_events,
            "retirementEvents": retirement_events,
            "actionOutboxDepth": action_outbox_depth,
            "metrics": compute_cycle_metrics(results, action_events),
            "statePath": str(state_path(config)),
            "cycleSeq": state["cycleSeq"],
            "rosterInventory": roster_inventory_data,
            "rosterEpoch": roster_epoch_value,
            "sourceProvenance": source_provenance,
        }
        result["heartbeatPath"] = save_central_heartbeat(config, result)
        return result
    finally:
        # Guarantee state is persisted even if save_central_heartbeat raises.
        save_state(config, state)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate BOT ERRORS Fleet Runtime Sentinel state")
    parser.add_argument("--hosts", default=str(default_hosts_path()))
    parser.add_argument("--state-dir", default=str(sentinel_state_root()))
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
            str(sentinel_state_root() / "sentinel-instance.lock"),
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
        # The lock pathname is intentionally left in place: flock ownership is
        # descriptor-scoped, so a leftover file with no live holder is not a
        # stale lock. Unlinking here would let a fresh acquirer create a new
        # inode at the same path while an earlier contender may still hold an
        # fd opened against the prior inode, splitting the lock identity across
        # two inodes and allowing concurrent holders (#2474).
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
        except OSError:
            pass
    print(json.dumps(result, sort_keys=True))
    if result_requires_attention(result):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
