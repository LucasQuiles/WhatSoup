#!/usr/bin/env python3
"""Host-local BOT ERRORS runtime selfcheck.

This is the host-side writer for the Fleet Runtime Sentinel. It verifies the
runtime root against the pinned manifest and may ask the local deployer to heal
safe drift from the already-distributed immutable bundle.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
import socket
import subprocess
import sys
import time
from typing import Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import sentinel_pin as sp  # noqa: E402


SAFE_HEAL_CLASSES = {"drift", "manifest_missing"}
HEAL_WINDOW_SECONDS = 6 * 60 * 60
MAX_HEALS_PER_WINDOW = 2
DEFAULT_CENTRAL_DOWN_ALERT_SECONDS = 2 * 60 * 60
DEFAULT_HEAL_MIN_FREE_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class SelfcheckConfig:
    root: Path
    state_dir: Path
    manifest_path: Path
    ledger_path: Path
    current_link: Path
    deployer_path: Path
    autoheal_off_path: Path
    disabled_path: Path
    lock_path: Path
    status_path: Path
    memory_path: Path
    heartbeat_path: Path
    central_ack_path: Optional[Path]
    central_down_alert_path: Path


@dataclass(frozen=True)
class SelfcheckDeps:
    commit_exists: Callable[[str], bool]
    deploy: Callable[[Path, Path, Path], tuple[int, str]]
    runtime_verify: Callable[[Path, Path], tuple[int, str]]
    push_heartbeat: Callable[[dict], dict]
    now_epoch: Callable[[], float]
    hostname: Callable[[], str]
    service_status: Callable[[str], str] = lambda _unit: "unknown"
    before_heal: Callable[[], None] = lambda: None


class SelfcheckError(RuntimeError):
    pass


def now_iso(epoch: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if epoch is None else epoch))


def default_state_dir() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors")) / "sentinel"


def default_config(root: Path, state_dir: Optional[Path] = None) -> SelfcheckConfig:
    scripts = root / "deploy" / "scripts"
    sentinel_state = state_dir or default_state_dir()
    central_ack = os.environ.get("BOT_ERRORS_SELFCHECK_CENTRAL_ACK")
    central_down_alert = os.environ.get("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT")
    return SelfcheckConfig(
        root=root,
        state_dir=sentinel_state,
        manifest_path=Path(os.environ.get("BOT_ERRORS_RUNTIME_MANIFEST", root / "deploy/bot-errors-runtime-manifest.json")),
        ledger_path=scripts / "lib" / "sentinel_pin_ledger.json",
        current_link=sentinel_state / "current",
        deployer_path=scripts / "whatsoup-bot-errors-deploy.sh",
        autoheal_off_path=sentinel_state.parent / "fleet-sentinel" / "AUTOHEAL_OFF",
        disabled_path=sentinel_state / "DISABLED",
        lock_path=sentinel_state / "selfcheck.lock",
        status_path=sentinel_state / "status.json",
        memory_path=sentinel_state / "selfcheck-state.json",
        heartbeat_path=Path(os.environ.get("BOT_ERRORS_SELFCHECK_HEARTBEAT", sentinel_state / "heartbeat.json")).expanduser(),
        central_ack_path=Path(central_ack).expanduser() if central_ack else None,
        central_down_alert_path=Path(central_down_alert or sentinel_state / "actions" / "central-down-alert.json").expanduser(),
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
        path.chmod(0o600)
        fsync_parent(path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def read_json_object(path: Path, default: dict) -> dict:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(default)
    except (OSError, json.JSONDecodeError) as exc:
        raise SelfcheckError(f"cannot read {path.name}: {type(exc).__name__}") from exc
    if not isinstance(loaded, dict):
        raise SelfcheckError(f"{path.name} must be a JSON object")
    return loaded


def lever_engaged(path: Path) -> tuple[bool, str]:
    try:
        path.stat()
    except FileNotFoundError:
        return False, "absent"
    except OSError as exc:
        return True, f"stat_error:{type(exc).__name__}"
    return True, "present"


def load_memory(path: Path) -> dict:
    memory = read_json_object(path, {"lastClass": None, "consecutive": 0, "healHistory": []})
    history = memory.get("healHistory")
    if not isinstance(history, list):
        raise SelfcheckError("healHistory must be a list")
    return memory


def int_or_zero(value: object) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def finite_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def update_consecutive(memory: dict, observed_class: str) -> int:
    if memory.get("lastClass") == observed_class:
        consecutive = int_or_zero(memory.get("consecutive")) + 1
    else:
        consecutive = 1
    memory["lastClass"] = observed_class
    memory["consecutive"] = consecutive
    return consecutive


def heal_allowed(memory: dict, now: float) -> tuple[bool, str]:
    floor = now - HEAL_WINDOW_SECONDS
    kept = []
    for item in memory.get("healHistory", []):
        stamp = finite_float(item)
        if stamp is None or stamp > now:
            return False, "invalid_heal_history"
        if stamp >= floor:
            kept.append(stamp)
    memory["healHistory"] = kept
    if len(kept) >= MAX_HEALS_PER_WINDOW:
        return False, "rate_limited"
    return True, "ok"


def heal_min_free_bytes() -> int:
    raw = os.environ.get("BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES", str(DEFAULT_HEAL_MIN_FREE_BYTES))
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_HEAL_MIN_FREE_BYTES


def heal_disk_preflight(root: Path, bundle: Path, pin: sp.Pin) -> dict:
    bundle_bytes = 0
    backup_bytes = 0
    for rel in pin.files:
        bundle_file = bundle / rel
        root_file = root / rel
        try:
            bundle_bytes += bundle_file.stat().st_size
        except OSError as exc:
            return {"ok": False, "status": f"bundle_stat_error:{type(exc).__name__}", "path": str(bundle_file)}
        try:
            backup_bytes += root_file.stat().st_size
        except FileNotFoundError:
            pass
        except OSError as exc:
            return {"ok": False, "status": f"root_stat_error:{type(exc).__name__}", "path": str(root_file)}

    reserve_bytes = heal_min_free_bytes()
    required_bytes = bundle_bytes + backup_bytes + reserve_bytes
    probe_path = root.parent
    try:
        statvfs = os.statvfs(probe_path)
    except OSError as exc:
        return {"ok": False, "status": f"statvfs_error:{type(exc).__name__}", "probePath": str(probe_path)}
    available_bytes = int(statvfs.f_bavail) * int(statvfs.f_frsize)
    return {
        "ok": available_bytes >= required_bytes,
        "status": "ok" if available_bytes >= required_bytes else "low_disk_space",
        "probePath": str(probe_path),
        "availableBytes": available_bytes,
        "requiredBytes": required_bytes,
        "bundleBytes": bundle_bytes,
        "backupBytes": backup_bytes,
        "reserveBytes": reserve_bytes,
    }


def record_heal(memory: dict, now: float) -> None:
    history = list(memory.get("healHistory", []))
    history.append(now)
    memory["healHistory"] = history


def dry_service_states() -> dict[str, str]:
    raw = os.environ.get("BOT_ERRORS_DRY_SERVICE_STATES", "").strip()
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        loaded = None
    if isinstance(loaded, dict):
        return {str(key): str(value) for key, value in loaded.items()}
    states = {}
    for item in raw.split(","):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        if key.strip():
            states[key.strip()] = value.strip()
    return states


def service_check_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_SERVICE_CHECK_TIMEOUT_SECONDS", "5")
    value = finite_float(raw)
    if value is None:
        return 5.0
    return max(0.1, value)


def launchd_service_status(unit: str) -> str:
    proc = subprocess.run(
        ["launchctl", "print", f"gui/{os.getuid()}/{unit}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=service_check_timeout(),
        check=False,
    )
    if proc.returncode != 0:
        return "inactive"
    output = proc.stdout
    if "state = running" in output or "\tpid = " in output or "\n\tpid = " in output:
        return "active"
    return "loaded"


def systemd_service_status(unit: str) -> str:
    proc = subprocess.run(
        ["systemctl", "--user", "is-active", unit],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=service_check_timeout(),
        check=False,
    )
    return proc.stdout.strip() or f"rc={proc.returncode}"


def default_service_status(unit: str) -> str:
    dry = dry_service_states()
    if unit in dry:
        return dry[unit]
    try:
        if sys.platform == "darwin" or not unit.endswith(".service"):
            return launchd_service_status(unit)
        return systemd_service_status(unit)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"check_failed:{type(exc).__name__}"


def parse_unit_expectations(raw: str) -> list[tuple[str, str]]:
    expectations = []
    for item in raw.split(","):
        part = item.strip()
        if not part:
            continue
        if "=" in part:
            unit, expected = part.split("=", 1)
        else:
            unit, expected = part, "active"
        unit = unit.strip()
        expected = expected.strip().lower() or "active"
        if unit:
            expectations.append((unit, expected))
    return expectations


def unit_status_ok(status: str, expected: str) -> bool:
    normalized = status.strip().lower()
    expected = expected.strip().lower()
    if expected == "loaded":
        return normalized == "loaded" or normalized == "active" or normalized.startswith("active")
    if expected == "active":
        return normalized == "active" or normalized.startswith("active")
    return normalized == expected


def unit_state_inventory(deps: SelfcheckDeps) -> tuple[list[dict[str, str]], list[str]]:
    raw = os.environ.get("BOT_ERRORS_SELFCHECK_UNITS", "")
    statuses = []
    problems = []
    for unit, expected in parse_unit_expectations(raw):
        status = deps.service_status(unit)
        ok = unit_status_ok(status, expected)
        statuses.append({"unit": unit, "expected": expected, "status": status, "ok": str(ok).lower()})
        if not ok:
            problems.append(f"unit {unit} status={status} expected={expected}")
    return statuses, problems


def freshness_expectations() -> list[dict]:
    raw = os.environ.get("BOT_ERRORS_SELFCHECK_FRESHNESS_JSON", "").strip()
    if not raw:
        return []
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SelfcheckError(f"invalid freshness JSON: {exc}") from exc
    if not isinstance(loaded, list):
        raise SelfcheckError("freshness expectations must be a list")
    expectations = []
    for index, item in enumerate(loaded):
        if not isinstance(item, dict):
            raise SelfcheckError(f"freshness[{index}] must be an object")
        name = str(item.get("name") or "").strip()
        path = str(item.get("path") or "").strip()
        max_age = item.get("maxAgeSeconds")
        if not name or not path or type(max_age) is not int or max_age < 0:
            raise SelfcheckError(f"freshness[{index}] requires name, path, maxAgeSeconds")
        expectations.append({"name": name, "path": path, "maxAgeSeconds": max_age})
    return expectations


def freshness_inventory(now: float) -> tuple[list[dict], list[str]]:
    statuses = []
    problems = []
    for item in freshness_expectations():
        path = Path(str(item["path"])).expanduser()
        max_age = int(item["maxAgeSeconds"])
        try:
            raw_age = int(now - path.stat().st_mtime)
        except FileNotFoundError:
            statuses.append({"name": item["name"], "path": str(path), "status": "missing", "maxAgeSeconds": max_age})
            problems.append(f"freshness {item['name']} missing path={path}")
            continue
        except OSError as exc:
            statuses.append({"name": item["name"], "path": str(path), "status": f"stat_error:{type(exc).__name__}", "maxAgeSeconds": max_age})
            problems.append(f"freshness {item['name']} stat_error={type(exc).__name__} path={path}")
            continue
        if raw_age < 0:
            future_by_seconds = abs(raw_age)
            statuses.append(
                {
                    "name": item["name"],
                    "path": str(path),
                    "status": "future_mtime",
                    "futureBySeconds": future_by_seconds,
                    "maxAgeSeconds": max_age,
                }
            )
            problems.append(f"freshness {item['name']} future_mtime seconds={future_by_seconds} path={path}")
            continue
        age = raw_age
        fresh = age <= max_age
        statuses.append({"name": item["name"], "path": str(path), "ageSeconds": age, "maxAgeSeconds": max_age, "ok": str(fresh).lower()})
        if not fresh:
            problems.append(f"freshness {item['name']} age_seconds={age} max={max_age} path={path}")
    return statuses, problems


def acquire_lock(path: Path) -> Optional[int]:
    """Acquire the heal lock as an ``flock`` advisory lock keyed on ``path``.

    Unlike the previous O_EXCL lockfile, an ``flock`` is released automatically
    by the kernel when the holder exits (including SIGKILL). A crashed holder
    therefore cannot leave a stale lock file that freezes all future heals (the
    P0-3 bug): a leftover file with no live holder is simply re-acquired here,
    while a live holder still blocks (returns None) so an in-progress heal is
    never interrupted. The PID is written for observability only. Returns an open
    fd the caller must pass to ``release_lock``, or None if the lock is held."""
    ensure_private_dir(path.parent)
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()}\n".encode())
    return fd


def release_lock(path: Path, fd: int) -> None:
    """Release the flock held by ``fd``. The lock pathname is intentionally left
    in place: flock ownership is descriptor-scoped, so a leftover file with no
    live holder is not a stale lock (see ``acquire_lock``). Unlinking here would
    let a fresh acquirer create a new inode at the same path while an earlier
    contender may still hold an fd opened against the prior inode, splitting the
    lock identity across two inodes and allowing concurrent holders (#2474)."""
    os.close(fd)  # closing the fd releases the flock


def current_bundle_path(current_link: Path) -> Path:
    try:
        target = os.readlink(current_link)
    except OSError as exc:
        raise SelfcheckError(f"current bundle unavailable: {type(exc).__name__}") from exc
    target_path = Path(target)
    if not target_path.is_absolute():
        target_path = current_link.parent / target_path
    resolved = target_path.resolve()
    cache_dir = (current_link.parent / "bundle").resolve()
    try:
        resolved.relative_to(cache_dir)
    except ValueError as exc:
        raise SelfcheckError(f"current bundle outside bundle cache: {resolved}") from exc
    return resolved


def classify_runtime_mismatches(mismatches: list[tuple[str, str]]) -> str:
    kinds = {kind for _path, kind in mismatches}
    if "symlink" in kinds or "unsafe_path" in kinds:
        return "unsafe_runtime_path"
    if "missing" in kinds:
        return "manifest_missing"
    if "sha" in kinds:
        return "drift"
    return "drift"


def default_commit_exists(repo_root: Path) -> Callable[[str], bool]:
    def _exists(sha: str) -> bool:
        cat = subprocess.run(
            ["git", "-C", str(repo_root), "cat-file", "-e", f"{sha}^{{commit}}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        if cat.returncode != 0:
            return False
        ancestor = subprocess.run(
            ["git", "-C", str(repo_root), "merge-base", "--is-ancestor", sha, "origin/main"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
        return ancestor.returncode == 0

    return _exists


def default_deploy(deployer_path: Path) -> Callable[[Path, Path, Path], tuple[int, str]]:
    def _deploy(root: Path, bundle: Path, _deployer: Path = deployer_path) -> tuple[int, str]:
        try:
            proc = subprocess.run(
                ["bash", str(_deployer), "deploy", str(root), str(bundle)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=120,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return 124, tail_text(f"DEPLOY_TIMEOUT: {exc}\n{tail_text(exc.stdout, 3600)}")
        except OSError as exc:
            return 127, tail_text(f"DEPLOY_EXEC_ERROR: {type(exc).__name__}: {exc}")
        return proc.returncode, tail_text(proc.stdout)

    return _deploy


def tail_text(value: object, limit: int = 4000) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        text = value.decode("utf-8", "replace")
    else:
        text = str(value)
    return text[-limit:]


def default_runtime_verify(deployer_path: Path) -> Callable[[Path, Path], tuple[int, str]]:
    def _verify(root: Path, _deployer: Path = deployer_path) -> tuple[int, str]:
        try:
            proc = subprocess.run(
                ["bash", str(_deployer), "verify", str(root)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=120,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return 124, tail_text(f"VERIFY_TIMEOUT: {exc}\n{tail_text(exc.stdout, 3600)}")
        except OSError as exc:
            return 127, tail_text(f"VERIFY_EXEC_ERROR: {type(exc).__name__}: {exc}")
        return proc.returncode, tail_text(proc.stdout)

    return _verify


def heartbeat_push_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_SELFCHECK_HEARTBEAT_TIMEOUT_SECONDS", "5")
    value = finite_float(raw)
    if value is None:
        return 5.0
    return max(0.1, value)


def central_ack_max_age_seconds() -> int:
    raw = os.environ.get("BOT_ERRORS_SELFCHECK_CENTRAL_ACK_MAX_AGE_SECONDS", str(3 * 30 * 60))
    try:
        return max(0, int(raw))
    except ValueError:
        return 3 * 30 * 60


def central_down_max_age_seconds() -> int:
    raw = os.environ.get("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", str(DEFAULT_CENTRAL_DOWN_ALERT_SECONDS))
    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_CENTRAL_DOWN_ALERT_SECONDS


def central_ack_inventory(path: Optional[Path], now: float) -> dict:
    if path is None:
        return {"configured": False, "mode": "local_only", "status": "not_configured"}
    max_age = central_ack_max_age_seconds()
    try:
        if path.is_symlink():
            return {
                "configured": True,
                "mode": "local_only",
                "status": "symlink",
                "path": str(path),
                "maxAgeSeconds": max_age,
            }
        stat = path.stat()
    except FileNotFoundError:
        return {"configured": True, "mode": "local_only", "status": "missing", "path": str(path), "maxAgeSeconds": max_age}
    except OSError as exc:
        return {
            "configured": True,
            "mode": "local_only",
            "status": f"stat_error:{type(exc).__name__}",
            "path": str(path),
            "maxAgeSeconds": max_age,
        }
    raw_age = int(now - stat.st_mtime)
    if raw_age < 0:
        return {
            "configured": True,
            "mode": "local_only",
            "status": "future_mtime",
            "path": str(path),
            "futureBySeconds": abs(raw_age),
            "maxAgeSeconds": max_age,
        }
    age = raw_age
    status = "fresh" if age <= max_age else "stale"
    mode = "central_acked" if status == "fresh" else "local_only"
    return {"configured": True, "mode": mode, "status": status, "path": str(path), "ageSeconds": age, "maxAgeSeconds": max_age}


def update_central_ack_watch(memory: dict, central_ack: dict, now: float) -> None:
    if central_ack.get("configured") is not True:
        memory.pop("centralAckLocalOnlySince", None)
        return
    threshold = central_down_max_age_seconds()
    central_ack["centralDownMaxAgeSeconds"] = threshold
    if central_ack.get("mode") == "central_acked":
        memory.pop("centralAckLocalOnlySince", None)
        central_ack["centralDownSuspected"] = False
        return

    since = finite_float(memory.get("centralAckLocalOnlySince"))
    if since is None or since > now:
        since = now
    memory["centralAckLocalOnlySince"] = since
    local_only_seconds = max(0, int(now - since))
    age_seconds = central_ack.get("ageSeconds")
    age_long_stale = isinstance(age_seconds, int) and age_seconds >= threshold
    central_ack["localOnlySince"] = now_iso(since)
    central_ack["localOnlySeconds"] = local_only_seconds
    central_ack["centralDownSuspected"] = age_long_stale or local_only_seconds >= threshold


def heartbeat_payload(status: dict) -> dict:
    """Full local forensic payload — retains all detail for the local file.

    Issue #2470: this is the PRIVATE local artifact. It is NOT safe for
    central transport. Use ``central_telemetry_payload()`` for the push.
    """
    keys = (
        "schemaVersion",
        "host",
        "checkedAt",
        "root",
        "healthy",
        "class",
        "action",
        "problems",
        "consecutive",
        "pin",
        "bundle",
        "runtimeMismatches",
        "unitStatuses",
        "freshness",
        "runtimeVerify",
        "centralAck",
        "centralDownAlert",
    )
    payload = {"kind": "bot-errors-selfcheck-heartbeat"}
    payload.update({key: status[key] for key in keys if key in status})
    return payload


# ─────────────────────────────────────────────────────────────────────────
# Issue #2470: central telemetry boundary.
#
# The central push must carry only bounded operational metadata. Raw host
# identity, absolute paths, free-form problem text, file-level mismatch
# tuples, unit labels, freshness file names/paths, raw verifier output, and
# configured ack paths are stripped. Domain-separated SHA-256 digests
# replace identity/path fields where stable correlation is needed.
# ─────────────────────────────────────────────────────────────────────────

_TELEMETRY_SCHEMA_VERSION = 2


def _telemetry_digest(domain: str, value: str) -> str:
    """Domain-separated 16-char hex digest — deterministic, non-reversible."""
    return hashlib.sha256(f"bot-errors-telemetry:{domain}:{value}".encode()).hexdigest()[:16]


def _mismatch_kind_counts(mismatches: list) -> dict[str, int]:
    """Collapse (path, kind) tuples into kind-only counts."""
    counts: dict[str, int] = {}
    for item in mismatches:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            kind = str(item[1])
            counts[kind] = counts.get(kind, 0) + 1
        else:
            counts["unknown"] = counts.get("unknown", 0) + 1
    return counts


def _aggregate_ok_bad(items: list) -> dict[str, int]:
    """Aggregate a unit/freshness status list into ok/bad/total counts."""
    total = len(items)
    ok = 0
    bad = 0
    for item in items:
        if isinstance(item, dict):
            val = item.get("ok")
            if val == "true":
                ok += 1
            else:
                bad += 1
        else:
            bad += 1
    return {"total": total, "ok": ok, "bad": bad}


def central_telemetry_payload(status: dict) -> dict:
    """Project local status into a bounded, metadata-only telemetry payload.

    This is the ONLY shape safe for the central HTTP push. It contains:
    - bounded enums: class, action, healthy
    - counts: consecutive, problemCount, mismatch counts, unit/freshness aggregates
    - digests: hostDigest, rootDigest (non-reversible, domain-separated)
    - already-digested values: pin SHAs, bundle name
    - bounded ack metadata: configured, mode, status, age, verdicts

    It does NOT contain: raw hostname, absolute paths, filenames, unit labels,
    free-form problem text, raw verifier output, or configured ack paths.
    """
    payload: dict = {
        "kind": "bot-errors-selfcheck-heartbeat",
        "schemaVersion": _TELEMETRY_SCHEMA_VERSION,
        "checkedAt": status.get("checkedAt"),
        "healthy": status.get("healthy"),
        "class": status.get("class"),
        "action": status.get("action"),
        "consecutive": status.get("consecutive"),
    }

    host = status.get("host")
    if host is not None:
        payload["hostDigest"] = _telemetry_digest("host", str(host))

    root = status.get("root")
    if root is not None:
        payload["rootDigest"] = _telemetry_digest("root", str(root))

    problems = status.get("problems")
    if isinstance(problems, list):
        payload["problemCount"] = len(problems)

    pin = status.get("pin")
    if isinstance(pin, dict):
        payload["pin"] = {
            "headSha": pin.get("headSha"),
            "f10Sha": pin.get("f10Sha"),
            "trust": pin.get("trust"),
            "headApproved": pin.get("headApproved"),
        }

    bundle = status.get("bundle")
    if bundle is not None:
        payload["bundle"] = str(bundle)

    runtime_mismatches = status.get("runtimeMismatches")
    if isinstance(runtime_mismatches, list):
        payload["runtimeMismatchCount"] = len(runtime_mismatches)
        payload["runtimeMismatchKinds"] = _mismatch_kind_counts(runtime_mismatches)

    bundle_mismatches = status.get("bundleMismatches")
    if isinstance(bundle_mismatches, list):
        payload["bundleMismatchCount"] = len(bundle_mismatches)
        payload["bundleMismatchKinds"] = _mismatch_kind_counts(bundle_mismatches)

    unit_statuses = status.get("unitStatuses")
    if isinstance(unit_statuses, list):
        payload["unitAggregate"] = _aggregate_ok_bad(unit_statuses)

    freshness = status.get("freshness")
    if isinstance(freshness, list):
        payload["freshnessAggregate"] = _aggregate_ok_bad(freshness)

    runtime_verify = status.get("runtimeVerify")
    if isinstance(runtime_verify, dict):
        payload["runtimeVerifyRc"] = runtime_verify.get("rc")

    central_ack = status.get("centralAck")
    if isinstance(central_ack, dict):
        payload["centralAck"] = {
            "configured": central_ack.get("configured"),
            "mode": central_ack.get("mode"),
            "status": central_ack.get("status"),
            "ageSeconds": central_ack.get("ageSeconds"),
            "maxAgeSeconds": central_ack.get("maxAgeSeconds"),
            "centralDownSuspected": central_ack.get("centralDownSuspected"),
        }

    return payload


def default_push_heartbeat(payload: dict) -> dict:
    url = os.environ.get("BOT_ERRORS_SELFCHECK_HEARTBEAT_URL", "").strip()
    if not url:
        return {"attempted": False, "mode": "disabled"}
    data = (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8")
    req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(req, timeout=heartbeat_push_timeout()) as response:
            body = response.read(1024)
            return {"attempted": True, "ok": True, "status": getattr(response, "status", None), "body": tail_text(body, 200)}
    except HTTPError as exc:
        return {"attempted": True, "ok": False, "status": exc.code, "error": tail_text(exc.read(512), 200)}
    except (OSError, URLError) as exc:
        return {"attempted": True, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}


def publish_heartbeat(config: SelfcheckConfig, deps: SelfcheckDeps, status: dict) -> None:
    # Issue #2470: local file keeps full forensic detail; central push gets
    # only the bounded metadata-only telemetry projection.
    local_payload = heartbeat_payload(status)
    push_payload = central_telemetry_payload(status)
    result = {"path": str(config.heartbeat_path), "local": "pending", "push": {"attempted": False, "mode": "not_run"}}
    try:
        atomic_write_json(config.heartbeat_path, local_payload)
        result["local"] = "ok"
    except Exception as exc:  # noqa: BLE001 - heartbeat failure must not mask runtime status.
        result["local"] = f"write_failed:{type(exc).__name__}"
    try:
        result["push"] = deps.push_heartbeat(push_payload)
    except Exception as exc:  # noqa: BLE001 - best-effort central push.
        result["push"] = {"attempted": True, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
    status["heartbeat"] = result


def publish_central_down_alert(config: SelfcheckConfig, status: dict) -> None:
    central_ack = status.get("centralAck", {})
    if central_ack.get("centralDownSuspected") is not True:
        return
    # Issue #2470: central-down alert artifact must also use bounded fields.
    # Raw host identity and root paths are replaced with domain-separated
    # digests; centralAck carries only verdict/age/mode metadata, no path.
    host = status.get("host")
    root = status.get("root")
    payload = {
        "schemaVersion": _TELEMETRY_SCHEMA_VERSION,
        "kind": "bot-errors-selfcheck-central-down-alert",
        "scope": "host",
        "createdAt": status.get("checkedAt"),
        "hostDigest": _telemetry_digest("host", str(host)) if host is not None else None,
        "rootDigest": _telemetry_digest("root", str(root)) if root is not None else None,
        "class": status.get("class"),
        "action": "central_down_suspected",
        "tier": "tier3",
        "lane": "human",
        "severity": "critical",
        "criticalWhatsAppEligible": True,
        "centralAck": {
            "configured": central_ack.get("configured"),
            "mode": central_ack.get("mode"),
            "status": central_ack.get("status"),
            "ageSeconds": central_ack.get("ageSeconds"),
            "maxAgeSeconds": central_ack.get("maxAgeSeconds"),
            "centralDownSuspected": central_ack.get("centralDownSuspected"),
        },
    }
    result = {"active": True, "path": str(config.central_down_alert_path), "ok": False}
    try:
        atomic_write_json(config.central_down_alert_path, payload)
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001 - alert artifact failure must be visible without masking runtime status.
        result["error"] = f"{type(exc).__name__}: {exc}"[:300]
    status["centralDownAlert"] = result


def finalize_status(config: SelfcheckConfig, deps: SelfcheckDeps, memory: dict, status: dict) -> dict:
    publish_central_down_alert(config, status)
    publish_heartbeat(config, deps, status)
    atomic_write_json(config.memory_path, memory)
    atomic_write_json(config.status_path, status)
    return status


def default_deps(config: SelfcheckConfig) -> SelfcheckDeps:
    return SelfcheckDeps(
        commit_exists=default_commit_exists(config.root),
        deploy=default_deploy(config.deployer_path),
        runtime_verify=default_runtime_verify(config.deployer_path),
        push_heartbeat=default_push_heartbeat,
        now_epoch=time.time,
        hostname=socket.gethostname,
        service_status=default_service_status,
    )


def base_status(config: SelfcheckConfig, deps: SelfcheckDeps, now: float) -> dict:
    return {
        "schemaVersion": 1,
        "host": deps.hostname(),
        "checkedAt": now_iso(now),
        "root": str(config.root),
        "healthy": False,
        "class": "unknown",
        "action": "none",
        "problems": [],
        "consecutive": 0,
    }


def run_selfcheck(config: SelfcheckConfig, deps: Optional[SelfcheckDeps] = None, heal_enabled: bool = True) -> dict:
    deps = deps or default_deps(config)
    now = deps.now_epoch()
    status = base_status(config, deps, now)
    memory = load_memory(config.memory_path)

    disabled, disabled_reason = lever_engaged(config.disabled_path)
    autoheal_off, autoheal_reason = lever_engaged(config.autoheal_off_path)
    status["levers"] = {
        "disabled": disabled_reason,
        "autohealOff": autoheal_reason,
    }
    lever_stat_errors = [
        r for r in (disabled_reason, autoheal_reason) if r.startswith("stat_error:")
    ]
    if lever_stat_errors:
        status["class"] = "lever_stat_error"
        status["action"] = "escalate"
        status["problems"] = [f"lever stat failed: {r}" for r in lever_stat_errors]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)
    status["centralAck"] = central_ack_inventory(config.central_ack_path, now)
    update_central_ack_watch(memory, status["centralAck"], now)

    try:
        pin = sp.load_pin(config.manifest_path)
        approved = sp.load_approved_f10(config.ledger_path)
        approved_heads = sp.load_approved_heads(config.ledger_path)
        trusted, trust_reason = sp.verify_pin_trust(
            pin,
            approved,
            deps.commit_exists,
            approved_heads=approved_heads,
        )
    except sp.PinLoadError as exc:
        status["class"] = "pin_untrusted"
        status["problems"] = [str(exc)]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)

    status["pin"] = {
        "headSha": pin.head_sha,
        "f10Sha": pin.f10_sha,
        "trust": trust_reason,
        "headApproved": str(pin.head_sha in approved_heads).lower(),
    }
    if not trusted:
        status["class"] = "pin_untrusted"
        status["problems"] = [trust_reason]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)

    try:
        bundle = current_bundle_path(config.current_link)
    except SelfcheckError as exc:
        status["class"] = "bundle_missing"
        status["problems"] = [str(exc)]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)
    status["bundle"] = str(bundle)
    if pin.head_sha and bundle.name != pin.head_sha:
        status["class"] = "bundle_mismatch"
        status["problems"] = [f"current bundle {bundle.name} != pin {pin.head_sha}"]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)

    bundle_ok, bundle_mismatches = sp.verify_bundle(bundle, pin)
    status["bundleMismatches"] = bundle_mismatches
    if not bundle_ok:
        status["class"] = "bundle_bad"
        status["problems"] = [f"{path}:{kind}" for path, kind in bundle_mismatches]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)

    root_ok, root_mismatches = sp.verify_bundle(config.root, pin)
    status["runtimeMismatches"] = root_mismatches
    unit_statuses, unit_problems = unit_state_inventory(deps)
    freshness_statuses, freshness_problems = freshness_inventory(now)
    status["unitStatuses"] = unit_statuses
    status["freshness"] = freshness_statuses
    if unit_problems:
        status["class"] = "unit_bad"
        status["action"] = "escalate"
        status["problems"] = unit_problems + [f"{path}:{kind}" for path, kind in root_mismatches]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)
    if freshness_problems:
        status["class"] = "stale_run"
        status["action"] = "escalate"
        status["problems"] = freshness_problems + [f"{path}:{kind}" for path, kind in root_mismatches]
        status["consecutive"] = update_consecutive(memory, status["class"])
        return finalize_status(config, deps, memory, status)
    if root_ok:
        verify_rc, verify_output = deps.runtime_verify(config.root, config.deployer_path)
        status["runtimeVerify"] = {"rc": verify_rc, "output": verify_output[-1000:]}
        if verify_rc != 0:
            status["class"] = "runtime_verify_failed"
            status["action"] = "escalate"
            status["problems"] = [f"runtime_verify_rc={verify_rc}"]
            if verify_output:
                status["problems"].append(verify_output[-1000:])
            status["consecutive"] = update_consecutive(memory, status["class"])
            return finalize_status(config, deps, memory, status)
        status["healthy"] = True
        status["class"] = "healthy"
        status["consecutive"] = update_consecutive(memory, status["class"])
        status["action"] = "noop"
        return finalize_status(config, deps, memory, status)

    observed_class = classify_runtime_mismatches(root_mismatches)
    status["class"] = observed_class
    status["problems"] = [f"{path}:{kind}" for path, kind in root_mismatches]
    consecutive = update_consecutive(memory, observed_class)
    status["consecutive"] = consecutive

    if observed_class not in SAFE_HEAL_CLASSES:
        status["action"] = "escalate"
    elif disabled:
        status["action"] = "mutation_disabled"
    elif autoheal_off or not heal_enabled:
        status["action"] = "monitor_only"
    elif consecutive < 2:
        status["action"] = "hysteresis_wait"
    else:
        allowed, reason = heal_allowed(memory, now)
        if not allowed:
            status["action"] = reason
        else:
            fd = acquire_lock(config.lock_path)
            if fd is None:
                status["action"] = "lock_busy"
            else:
                try:
                    deps.before_heal()
                    try:
                        fresh_bundle = current_bundle_path(config.current_link)
                    except SelfcheckError as exc:
                        status["action"] = "current_changed"
                        status["problems"].append(str(exc))
                    else:
                        if fresh_bundle != bundle:
                            status["action"] = "current_changed"
                        else:
                            # Re-read and re-verify the pin INSIDE the lock. The
                            # top-of-cycle pin was loaded many steps earlier; a
                            # concurrent `pin` update between then and now would
                            # otherwise let us deploy the stale bundle and still
                            # report "healed". Abort as current_changed on any
                            # drift or load failure.
                            try:
                                fresh_pin = sp.load_pin(config.manifest_path)
                                fresh_approved = sp.load_approved_f10(config.ledger_path)
                                fresh_trusted, _fresh_reason = sp.verify_pin_trust(
                                    fresh_pin, fresh_approved, deps.commit_exists
                                )
                            except sp.PinLoadError as exc:
                                status["action"] = "current_changed"
                                status["problems"].append(f"pin_recheck_failed: {exc}")
                                fresh_pin = None
                            if fresh_pin is None:
                                pass  # already marked current_changed above
                            elif fresh_pin.head_sha != pin.head_sha or fresh_pin.f10_sha != pin.f10_sha or not fresh_trusted:
                                status["action"] = "current_changed"
                                status["problems"].append(
                                    f"pin_changed_during_heal: was={pin.head_sha[:12]} "
                                    f"now={(fresh_pin.head_sha or 'none')[:12]}"
                                )
                            else:
                                status["healDiskPreflight"] = heal_disk_preflight(config.root, bundle, fresh_pin)
                                if status["healDiskPreflight"]["ok"] is not True:
                                    status["action"] = "heal_preflight_failed"
                                    status["problems"].append(status["healDiskPreflight"]["status"])
                                else:
                                    rc, output = deps.deploy(config.root, bundle, config.deployer_path)
                                    status["deployerOutput"] = output[-1000:]
                                    if rc == 0:
                                        record_heal(memory, now)
                                        status["action"] = "healed"
                                    else:
                                        status["action"] = "heal_failed"
                                        status["problems"].append(f"deployer_rc={rc}")
                finally:
                    release_lock(config.lock_path, fd)

    return finalize_status(config, deps, memory, status)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a host-local BOT ERRORS runtime selfcheck")
    parser.add_argument("--root", default=os.environ.get("BOT_ERRORS_REPO_ROOT", str(Path.cwd())))
    parser.add_argument("--state-dir", default=os.environ.get("BOT_ERRORS_SENTINEL_STATE_DIR"))
    parser.add_argument("--no-heal", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    state_dir = Path(args.state_dir).expanduser() if args.state_dir else None
    config = default_config(Path(args.root).expanduser().resolve(), state_dir)
    try:
        status = run_selfcheck(config, heal_enabled=not args.no_heal)
    except Exception as exc:
        status = {"schemaVersion": 1, "checkedAt": now_iso(), "healthy": False, "class": "selfcheck_error", "problems": [str(exc)]}
        try:
            atomic_write_json(config.status_path, status)
        except Exception:
            pass
        print(json.dumps(status, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(status, sort_keys=True))
    return 0 if status.get("healthy") or status.get("action") in {"healed", "hysteresis_wait", "monitor_only"} else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
