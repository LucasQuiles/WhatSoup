#!/usr/bin/env python3
"""Independent heartbeat watchdog for BOT ERRORS monitoring components."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value


DEFAULT_CHECKS = "q_loop,dispatcher,collector,daily_health,queue_backlog,local_services,local_instance_health"
REPO_ROOT = Path(__file__).resolve().parents[2]
TERMINAL_AUTH_FAILURE_CLASSES = {"pairing_required", "serverside_logout_irreversible"}


class QueueDirectoryError(RuntimeError):
    pass


class DailyHealthEventError(RuntimeError):
    pass


def positive_env_int(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be > 0")
    return value


def positive_env_int_or_default(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def watchdog_renotify_seconds() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS", 6 * 60 * 60)


def watchdog_escalate_seconds() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_ESCALATE_SECONDS", 24 * 60 * 60)


def watchdog_escalate_suppressed() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_ESCALATE_SUPPRESSED", 72)


def watchdog_recovery_confirmations() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS", 2)


def validate_thresholds() -> None:
    watchdog_renotify_seconds()
    watchdog_escalate_seconds()
    watchdog_escalate_suppressed()
    watchdog_recovery_confirmations()


def now_epoch() -> int:
    override = os.environ.get("BOT_ERRORS_DRY_NOW")
    return int(override) if override is not None else int(time.time())


def now_iso(ts: int | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or now_epoch()))


def parse_iso_epoch(value: Any) -> int | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def q_loop_state_path() -> Path:
    explicit = os.environ.get("BOT_ERRORS_Q_LOOP_STATE")
    if explicit:
        return Path(explicit)
    root = Path(os.environ.get("BOT_ERRORS_Q_LOOP_STATE_DIR", Path.home() / ".local/state/bot-errors-q-loop"))
    return root / "state.json"


def watchdog_state_path() -> Path:
    return state_root() / "heartbeat-watchdog-state.json"


def fleet_sentinel_heartbeat_path() -> Path:
    raw = os.environ.get("BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT", "").strip()
    if raw:
        return Path(raw).expanduser()
    return state_root() / "fleet-sentinel" / "sentinel-heartbeat.json"


def ensure_private_dir(path: Path) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.is_symlink():
            raise RuntimeError(f"refusing to use private directory through symlink: {path}")
        if not os.path.isdir(path):
            raise RuntimeError(f"refusing to use private directory over non-directory path: {path}")
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


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
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


def assert_regular_or_missing(path: Path) -> None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return
    if os.path.islink(path):
        raise RuntimeError(f"refusing to append through symlink: {path}")
    if not os.path.isfile(path):
        raise RuntimeError(f"refusing to append non-regular file: {path}")


def append_private_jsonl(path: Path, record: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    assert_regular_or_missing(path)
    data = (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(
        path,
        os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(fd, "ab") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        path.chmod(0o600)
    except OSError:
        pass
    fsync_parent(path)


def redact_watchdog_text(value: Any) -> str:
    return redact_bot_errors_text(value, credential_path_marker="[REDACTED_CREDENTIAL_PATH]")


def redacted_watchdog_payload(value: Any) -> Any:
    return redact_shared_json_value(value, redact_watchdog_text)


def append_log(kind: str, payload: dict[str, Any]) -> None:
    path = state_root() / "logs" / "heartbeat-watchdog.jsonl"
    append_private_jsonl(path, {"time": now_iso(), "kind": kind, **redacted_watchdog_payload(payload)})


def critical_file_problem(path: Path) -> str | None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return f"missing {path}"
    except OSError as exc:
        return f"failed to inspect critical file {path}: {type(exc).__name__}: {exc}"
    if path.is_symlink():
        return f"refusing to trust symlinked critical file {path}"
    if not os.path.isfile(path):
        return f"refusing to trust non-regular critical file {path}"
    mode = st.st_mode & 0o777
    if mode & 0o077:
        return f"refusing to trust non-private critical file {path} mode={mode:o}"
    try:
        parent_stat = path.parent.lstat()
    except FileNotFoundError:
        return f"missing critical file parent {path.parent}"
    except OSError as exc:
        return f"failed to inspect critical file parent {path.parent}: {type(exc).__name__}: {exc}"
    if path.parent.is_symlink():
        return f"refusing to trust critical file under symlinked directory {path.parent}"
    if not os.path.isdir(path.parent):
        return f"refusing to trust critical file under non-directory parent {path.parent}"
    parent_mode = parent_stat.st_mode & 0o777
    if parent_mode & 0o077:
        return f"refusing to trust critical file in non-private directory {path.parent} mode={parent_mode:o}"
    return None


def load_json(path: Path, *, require_private: bool = False) -> dict[str, Any] | None:
    if require_private and critical_file_problem(path) is not None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def load_state() -> dict[str, Any]:
    path = watchdog_state_path()
    data = load_json(path, require_private=True)
    if data is None:
        return {"version": 1, "open": {}}
    if not isinstance(data.get("open"), dict):
        data["open"] = {}
    return data


def save_state(state: dict[str, Any]) -> None:
    redacted_state = redacted_watchdog_payload(state)
    redacted_state["updatedAt"] = now_iso()
    atomic_write_json(watchdog_state_path(), redacted_state)


def outbox_event(
    summary: str,
    evidence: str,
    severity: str,
    source_key: str,
    event_type: str = "alert",
    force_notify: bool = False,
) -> Path:
    root = state_root()
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))
    ensure_private_dir(root)
    ensure_private_dir(outbox)
    current = now_epoch()
    safe_summary = redact_watchdog_text(summary)
    safe_evidence = redact_watchdog_text(evidence)
    event_id = f"heartbeat-watchdog-{re.sub(r'[^A-Za-z0-9_.:-]+', '_', source_key).replace(':', '-')}-{event_type}-{current}"
    event = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": event_type,
        "severity": severity,
        "createdAt": now_iso(current),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-heartbeat-watchdog",
        "source": "heartbeat-watchdog",
        "alertSource": source_key,
        "summary": safe_summary,
        "evidence": safe_evidence,
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": {
            "logHints": [
                str(state_root() / "logs/heartbeat-watchdog.jsonl"),
                str(watchdog_state_path()),
            ],
            "queue": str(outbox),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    if force_notify:
        event["diagnostics"]["forceNotify"] = True
        event["diagnostics"]["forceNotifyLevel"] = "escalated" if "escalated=true" in safe_evidence else "still_open"
    path = outbox / f"{event['createdAt'].replace(':', '').replace('-', '')}.{event_id}.json"
    atomic_write_json(path, event)
    return path


def json_updated_age(path: Path, key: str = "updated_at") -> tuple[int | None, str]:
    current = now_epoch()
    problem = critical_file_problem(path)
    if problem is not None:
        return None, problem
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        return None, f"failed to read {path}: {type(exc).__name__}: {exc}"
    try:
        data = json.loads(text)
    except Exception as exc:
        return None, f"invalid JSON in {path}: {type(exc).__name__}: {exc}"
    if not isinstance(data, dict):
        return None, f"invalid JSON object in {path}: {type(data).__name__}"
    value = data.get(key)
    if not isinstance(value, (int, float)):
        return None, f"missing numeric {key} in {path}"
    updated = int(value)
    return max(0, current - updated), f"{path} {key}={updated}"


def file_age(path: Path) -> tuple[int | None, str]:
    problem = critical_file_problem(path)
    if problem is not None:
        return None, problem
    try:
        mtime = int(path.stat().st_mtime)
    except OSError as exc:
        return None, f"failed to stat {path}: {type(exc).__name__}: {exc}"
    return max(0, now_epoch() - mtime), f"{path} mtime={mtime}"


def fleet_sentinel_age(path: Path) -> tuple[int | None, str]:
    problem = critical_file_problem(path)
    if problem is not None:
        return None, problem
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        return None, f"failed to read {path}: {type(exc).__name__}: {exc}"
    try:
        data = json.loads(text)
    except Exception as exc:
        return None, f"invalid JSON in {path}: {type(exc).__name__}: {exc}"
    if not isinstance(data, dict):
        return None, f"invalid JSON object in {path}: {type(data).__name__}"
    if data.get("kind") != "bot-errors-sentinel-heartbeat":
        return None, f"unexpected fleet sentinel heartbeat kind={data.get('kind')!r} in {path}"
    checked_at = parse_iso_epoch(data.get("checkedAt"))
    if checked_at is None:
        return None, f"missing parseable checkedAt in {path}"
    return max(0, now_epoch() - checked_at), (
        f"{path} checkedAt={data.get('checkedAt')} healthy={data.get('healthy')} "
        f"fleetAction={data.get('fleetAction')} hostCount={data.get('hostCount')}"
    )


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


def directory_stats(path: Path, pattern: str) -> tuple[int, int]:
    try:
        if not path.exists():
            return 0, 0
        files = [item for item in path.glob(pattern) if item.is_file()]
        if not files:
            return 0, 0
        oldest = max(0, now_epoch() - min(int(item.stat().st_mtime) for item in files))
    except OSError as exc:
        raise QueueDirectoryError(f"path={path} pattern={pattern} error={type(exc).__name__}: {exc}") from exc
    return len(files), oldest


def queue_backlog_problem(
    label: str,
    paths: list[Path],
    pattern: str,
    max_count: int,
    max_oldest_seconds: int,
) -> str | None:
    total_count = 0
    oldest_seconds = 0
    for path in paths:
        try:
            count, oldest = directory_stats(path, pattern)
        except QueueDirectoryError as exc:
            return f"{label} backlog scan failed: {exc}"
        total_count += count
        oldest_seconds = max(oldest_seconds, oldest)
    over_count = max_count > 0 and total_count >= max_count
    over_age = max_oldest_seconds > 0 and oldest_seconds >= max_oldest_seconds
    if not over_count and not over_age:
        return None
    return (
        f"{label} backlog critical: count={total_count} max_count={max_count} "
        f"oldest_seconds={oldest_seconds} max_oldest_seconds={max_oldest_seconds} "
        f"paths={','.join(str(path) for path in paths)}"
    )


def queue_backlog_problems() -> dict[str, str]:
    root = state_root()
    checks = [
        (
            "queue:outbox",
            "outbox",
            [Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))],
            "*.json",
            env_int("BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_COUNT", env_int("BOT_ERRORS_OUTBOX_CRITICAL_COUNT", 100)),
            env_int(
                "BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_OLDEST_SECONDS",
                env_int("BOT_ERRORS_OUTBOX_CRITICAL_OLDEST_SECONDS", 3600),
            ),
        ),
        (
            "queue:processing",
            "processing",
            [root / "processing"],
            "*",
            env_int(
                "BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_COUNT",
                env_int("BOT_ERRORS_PROCESSING_CRITICAL_COUNT", 10),
            ),
            env_int(
                "BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_OLDEST_SECONDS",
                env_int("BOT_ERRORS_PROCESSING_CRITICAL_OLDEST_SECONDS", 300),
            ),
        ),
        (
            "queue:writefail",
            "writefail",
            [
                root / "writefail",
                Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail",
                Path.home() / ".bot-errors-writefail",
            ],
            "*.writefail",
            env_int(
                "BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_COUNT",
                env_int("BOT_ERRORS_WRITEFAIL_CRITICAL_COUNT", 10),
            ),
            env_int(
                "BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_OLDEST_SECONDS",
                env_int("BOT_ERRORS_WRITEFAIL_CRITICAL_OLDEST_SECONDS", 600),
            ),
        ),
    ]
    problems: dict[str, str] = {}
    for key, label, paths, pattern, max_count, max_oldest_seconds in checks:
        problem = queue_backlog_problem(label, paths, pattern, max_count, max_oldest_seconds)
        if problem:
            problems[key] = problem
    return problems


def env_host_list(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    return [part.strip() for part in raw.split(",") if part.strip()]


def daily_health_hosts() -> list[str]:
    raw = os.environ.get("BOT_ERRORS_DAILY_HEALTH_HOSTS", "")
    if raw:
        required = env_host_list("BOT_ERRORS_DAILY_HEALTH_HOSTS")
    else:
        collector_hosts = collector_configured_hosts()
        if not collector_hosts:
            return []
        required = unique_hosts([*local_daily_health_hosts(), *collector_hosts])
    optional = set(optional_daily_health_hosts())
    return [host for host in required if host not in optional]


def unique_hosts(hosts: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for host in hosts:
        cleaned = host.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        result.append(cleaned)
    return result


def canonical_local_host() -> str:
    host = socket.gethostname().split(".", 1)[0].lower()
    if host.startswith("nucles"):
        return "nucles"
    return host


def local_daily_health_hosts() -> list[str]:
    if "BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS" in os.environ:
        return [part.strip() for part in os.environ["BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS"].split(",") if part.strip()]
    return [canonical_local_host()]


def health_profile_path() -> Path:
    raw = os.environ.get("BOT_ERRORS_HEALTH_PROFILE", "").strip()
    if raw:
        return Path(raw).expanduser()
    return REPO_ROOT / "deploy" / "health-profiles" / f"{canonical_local_host()}.json"


def load_health_profile() -> dict[str, Any] | None:
    path = health_profile_path()
    data = load_json(path)
    return data if isinstance(data, dict) else None


def expected_local_instances() -> list[dict[str, Any]]:
    profile = load_health_profile()
    if not profile:
        return []
    result: list[dict[str, Any]] = []
    instances = profile.get("instances")
    if not isinstance(instances, list):
        return result
    for instance in instances:
        if not isinstance(instance, dict):
            continue
        expected = str(instance.get("expected") or "").strip()
        service = str(instance.get("service") or "").strip()
        name = str(instance.get("name") or service).strip()
        if expected != "always_on" or not service:
            continue
        item: dict[str, Any] = {"name": name, "service": service}
        health_port = instance.get("healthPort")
        if isinstance(health_port, int):
            item["healthPort"] = health_port
        elif isinstance(health_port, str) and health_port.strip().isdigit():
            item["healthPort"] = int(health_port.strip())
        result.append(item)
    return result


def expected_local_services() -> list[dict[str, str]]:
    return [
        {"name": str(instance["name"]), "service": str(instance["service"])}
        for instance in expected_local_instances()
    ]


def dry_service_states() -> dict[str, str]:
    raw = os.environ.get("BOT_ERRORS_DRY_SERVICE_STATES", "").strip()
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            return {str(key): str(value) for key, value in loaded.items()}
    except json.JSONDecodeError:
        pass
    states: dict[str, str] = {}
    for item in raw.split(","):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        if key.strip():
            states[key.strip()] = value.strip()
    return states


def service_check_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_SERVICE_CHECK_TIMEOUT_SECONDS", "5")
    try:
        return max(0.1, float(raw))
    except ValueError:
        return 5


def systemd_service_status(service: str) -> str:
    proc = subprocess.run(
        ["systemctl", "--user", "is-active", service],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=service_check_timeout(),
        check=False,
    )
    status = proc.stdout.strip() or proc.stderr.strip() or f"rc={proc.returncode}"
    return status[:200]


def launchd_service_status(service: str) -> str:
    proc = subprocess.run(
        ["launchctl", "list", service],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=service_check_timeout(),
        check=False,
    )
    if proc.returncode != 0:
        return f"inactive rc={proc.returncode}: {(proc.stderr.strip() or proc.stdout.strip())[:160]}"
    first = next((line for line in proc.stdout.splitlines() if line.strip()), "")
    if first.startswith("-"):
        return f"inactive {first[:160]}"
    return "active"


def local_service_status(service: str) -> str:
    dry = dry_service_states()
    if service in dry:
        return dry[service]
    try:
        if sys.platform == "darwin":
            return launchd_service_status(service)
        return systemd_service_status(service)
    except Exception as exc:  # noqa: BLE001 - watchdog should report check failures.
        return f"check_failed: {str(exc)[:180]}"


def service_is_active(status: str) -> bool:
    normalized = status.strip().lower()
    return normalized == "active" or normalized.startswith("active ")


def local_service_problems() -> dict[str, str]:
    profile = health_profile_path()
    problems: dict[str, str] = {}
    for item in expected_local_services():
        service = item["service"]
        status = local_service_status(service)
        if service_is_active(status):
            continue
        key = f"local_service:{service}"
        problems[key] = (
            f"local service inactive: service={service} instance={item['name']} "
            f"status={status} expected=always_on profile={profile}"
        )
    return problems


def local_health_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_LOCAL_HEALTH_TIMEOUT_SECONDS", "3")
    try:
        return max(0.1, float(raw))
    except ValueError:
        return 3


def dry_local_health_responses() -> dict[str, Any]:
    raw = os.environ.get("BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES", "").strip()
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def local_health_http_response(name: str, port: int) -> tuple[int, str, str]:
    url = f"http://127.0.0.1:{port}/health"
    dry = dry_local_health_responses()
    entry = dry.get(name)
    if entry is None:
        entry = dry.get(str(port))
    if entry is not None:
        if isinstance(entry, dict):
            status = int(entry.get("status", 200))
            body = entry.get("body", entry.get("json", ""))
            if not isinstance(body, str):
                body = json.dumps(body)
            return status, body, url
        if isinstance(entry, str):
            return int(os.environ.get("BOT_ERRORS_DRY_LOCAL_HEALTH_STATUS", "200")), entry, url
    req = Request(url, method="GET")
    try:
        with urlopen(req, timeout=local_health_timeout()) as response:
            body = response.read(64 * 1024).decode("utf-8", errors="replace")
            return int(response.status), body, url
    except HTTPError as exc:
        body = exc.read(64 * 1024).decode("utf-8", errors="replace")
        return int(exc.code), body, url
    except URLError as exc:
        return 0, str(exc.reason), url
    except Exception as exc:  # noqa: BLE001 - watchdog should report probe failures.
        return 0, str(exc), url


def compact_health_field(value: Any) -> str:
    if value is None:
        return "none"
    return str(value).replace("\n", " ")[:200]


def is_terminal_auth_failure_class(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() in TERMINAL_AUTH_FAILURE_CLASSES


def local_instance_health_problems() -> dict[str, str]:
    profile = health_profile_path()
    problems: dict[str, str] = {}
    for item in expected_local_instances():
        port = item.get("healthPort")
        if not isinstance(port, int):
            continue
        name = str(item["name"])
        status, body, url = local_health_http_response(name, port)
        key = f"local_health:{name}"
        if status != 200:
            problems[key] = (
                f"local health probe failed: instance={name} port={port} url={url} "
                f"http_status={status} body={compact_health_field(body)} profile={profile}"
            )
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            problems[key] = (
                f"local health probe invalid JSON: instance={name} port={port} url={url} "
                f"http_status={status} body={compact_health_field(body)} profile={profile}"
            )
            continue
        if not isinstance(payload, dict):
            problems[key] = (
                f"local health probe invalid payload: instance={name} port={port} url={url} "
                f"http_status={status} payload_type={type(payload).__name__} profile={profile}"
            )
            continue
        instance = payload.get("instance") if isinstance(payload.get("instance"), dict) else {}
        actual_name = instance.get("name") if isinstance(instance, dict) else None
        whatsapp = payload.get("whatsapp") if isinstance(payload.get("whatsapp"), dict) else {}
        connection = whatsapp.get("connection") if isinstance(whatsapp.get("connection"), dict) else {}
        auth_bond = whatsapp.get("auth_bond") if isinstance(whatsapp.get("auth_bond"), dict) else {}
        connected = whatsapp.get("connected") if isinstance(whatsapp, dict) else None
        health_status = payload.get("status")
        auth_failure = connection.get("auth_failure_class") if isinstance(connection, dict) else None
        bond_status = auth_bond.get("status") if isinstance(auth_bond, dict) else None
        bond_issues = auth_bond.get("issues") if isinstance(auth_bond, dict) else None
        reasons: list[str] = []
        if isinstance(actual_name, str) and actual_name != name:
            reasons.append(f"health_identity_mismatch actual={actual_name}")
        if health_status == "unhealthy":
            reasons.append("health_status=unhealthy")
        if connected is not True:
            reasons.append(f"connected={str(connected).lower()}")
        if auth_failure not in (None, "", "none"):
            reasons.append(f"auth_failure_class={auth_failure}")
            if is_terminal_auth_failure_class(auth_failure):
                reasons.append("physical_intervention_required=terminal_auth_failure_class")
        if bond_status not in (None, "", "present"):
            reasons.append(f"auth_bond_status={bond_status}")
        if isinstance(bond_issues, list) and bond_issues:
            reasons.append(f"auth_bond_issues={','.join(str(issue) for issue in bond_issues[:5])}")
        if not reasons:
            continue
        problems[key] = (
            f"local instance health failure: instance={name} port={port} url={url} "
            f"http_status={status} {' '.join(reasons)} "
            f"connection_state={compact_health_field(connection.get('state') if isinstance(connection, dict) else None)} "
            f"last_status_code={compact_health_field(connection.get('last_status_code') if isinstance(connection, dict) else None)} "
            f"last_disconnect_reason={compact_health_field(connection.get('last_disconnect_reason') if isinstance(connection, dict) else None)} "
            f"auth_bond_status={compact_health_field(bond_status)} profile={profile}"
        )
    return problems


def parse_remote_host(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    remote = value.strip()
    if not remote:
        return None
    return remote.split(":", 1)[0]


def collector_configured_hosts() -> list[str]:
    data = load_json(state_root() / "collector-state.json", require_private=True)
    if not data:
        return []
    raw_hosts = data.get("configuredRemoteHosts")
    if isinstance(raw_hosts, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_hosts) if host])
    raw_remotes = data.get("configuredRemotes")
    if isinstance(raw_remotes, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_remotes) if host])
    remotes = data.get("remotes")
    if isinstance(remotes, dict):
        return unique_hosts([host for host in (parse_remote_host(value) for value in remotes.keys()) if host])
    return []


def collector_best_effort_hosts() -> list[str]:
    data = load_json(state_root() / "collector-state.json", require_private=True)
    if not data:
        return []
    raw_hosts = data.get("configuredBestEffortRemoteHosts")
    if isinstance(raw_hosts, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_hosts) if host])
    raw_remotes = data.get("configuredBestEffortRemotes")
    if isinstance(raw_remotes, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_remotes) if host])
    return []


def optional_daily_health_hosts() -> list[str]:
    return unique_hosts([*env_host_list("BOT_ERRORS_DAILY_HEALTH_OPTIONAL_HOSTS"), *collector_best_effort_hosts()])


def daily_health_event_host(path: Path, data: dict[str, Any] | None) -> str | None:
    match = re.search(r"\.relay-([A-Za-z0-9_.:-]+)\.bot-errors-health\.daily-health\.", path.name)
    if match:
        return match.group(1)
    if data:
        diagnostics = data.get("diagnostics")
        if isinstance(diagnostics, dict):
            relay = diagnostics.get("relay")
            if isinstance(relay, dict) and isinstance(relay.get("remoteHost"), str):
                return relay["remoteHost"]
        machine = str(data.get("machine") or "").lower()
        if machine.startswith("nucles"):
            return "nucles"
    return None


def daily_health_events() -> list[tuple[Path, int, dict[str, Any] | None]]:
    root = state_root()
    events: list[tuple[Path, int, dict[str, Any] | None]] = []
    for dirname in ("outbox", "processing", "sent", "suppressed", "relayed", "storm-collapsed"):
        directory = root / dirname
        if not directory.exists():
            continue
        try:
            paths = list(directory.glob("*.json*"))
        except OSError as exc:
            raise DailyHealthEventError(
                f"directory={directory} pattern=*.json* error={type(exc).__name__}: {exc}"
            ) from exc
        for path in paths:
            data = load_json(path)
            if "daily-health" not in path.name and (not data or data.get("source") != "daily-health"):
                continue
            created = parse_iso_epoch(data.get("createdAt")) if data else None
            if created is None:
                try:
                    created = int(path.stat().st_mtime)
                except OSError as exc:
                    raise DailyHealthEventError(f"path={path} error={type(exc).__name__}: {exc}") from exc
            events.append((path, created, data))
    return events


def daily_health_age(host: str | None = None) -> tuple[int | None, str]:
    dry_age = os.environ.get("BOT_ERRORS_DRY_DAILY_HEALTH_AGE_SECONDS")
    if dry_age is not None and host is None:
        return int(dry_age), "dry daily-health age"
    newest: int | None = None
    newest_path = ""
    try:
        events = daily_health_events()
    except DailyHealthEventError as exc:
        return None, f"failed to scan daily-health events under {state_root()}: {exc}"
    for path, mtime, data in events:
        if host is not None:
            event_host = daily_health_event_host(path, data)
            if event_host != host:
                continue
        if newest is None or mtime > newest:
            newest = mtime
            newest_path = str(path)
    if newest is None:
        scope = f" for {host}" if host else ""
        return None, f"no daily-health event{scope} under {state_root()}"
    return max(0, now_epoch() - newest), f"{newest_path} mtime={newest}"


def configured_checks() -> set[str]:
    raw = os.environ.get("BOT_ERRORS_WATCHDOG_CHECKS", DEFAULT_CHECKS)
    return {part.strip() for part in raw.split(",") if part.strip()}


def active_reconcile_prefixes(checks: set[str]) -> list[str]:
    prefixes: list[str] = []
    if "q_loop" in checks:
        prefixes.append("q_loop")
    if "dispatcher" in checks:
        prefixes.append("dispatcher")
    if "collector" in checks:
        prefixes.append("collector")
    if "daily_health" in checks:
        prefixes.append("daily_health")
    if "queue_backlog" in checks:
        prefixes.append("queue:")
    if "local_services" in checks:
        prefixes.append("local_service:")
    if "local_instance_health" in checks:
        prefixes.append("local_health:")
    if "fleet_sentinel" in checks:
        prefixes.append("fleet_sentinel")
    return prefixes


def key_in_active_scope(key: str, prefixes: list[str]) -> bool:
    return any(key == prefix or key.startswith(prefix) for prefix in prefixes)


def collect_problems(args: argparse.Namespace, checks: set[str] | None = None) -> dict[str, str]:
    checks = checks if checks is not None else configured_checks()
    problems: dict[str, str] = {}
    if "q_loop" in checks:
        q_loop_path = q_loop_state_path()
        age, detail = json_updated_age(q_loop_path)
        if age is None or age > args.max_q_loop_age:
            problems["q_loop"] = f"q-loop heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_q_loop_age} detail={detail}"
        state = load_json(q_loop_path, require_private=True)
        if state is not None:
            phase = str(state.get("phase") or "")
            if phase.startswith("q_unavailable_"):
                last_unavailable = state.get("last_q_unavailable_at")
                unavailable_at = int(last_unavailable) if isinstance(last_unavailable, (int, float)) else None
                unavailable_age = max(0, now_epoch() - unavailable_at) if unavailable_at is not None else "unknown"
                reason = str(state.get("last_q_unavailable_reason") or phase.removeprefix("q_unavailable_") or "unknown")
                problems["q_loop:supervisor"] = (
                    f"q-loop supervisor unavailable: phase={phase} reason={reason} "
                    f"age_seconds={unavailable_age} last_q_unavailable_at={unavailable_at if unavailable_at is not None else 'unknown'} "
                    f"detail={detail}"
                )
    if "dispatcher" in checks:
        age, detail = file_age(state_root() / "dispatcher-state.json")
        if age is None or age > args.max_dispatcher_age:
            problems["dispatcher"] = f"dispatcher heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_dispatcher_age} detail={detail}"
    if "collector" in checks:
        age, detail = file_age(state_root() / "collector-state.json")
        if age is None or age > args.max_collector_age:
            problems["collector"] = f"collector heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_collector_age} detail={detail}"
    if "fleet_sentinel" in checks:
        age, detail = fleet_sentinel_age(fleet_sentinel_heartbeat_path())
        if age is None or age > args.max_fleet_sentinel_age:
            problems["fleet_sentinel"] = (
                f"fleet sentinel heartbeat stale: age_seconds={age if age is not None else 'missing'} "
                f"max={args.max_fleet_sentinel_age} detail={detail}"
            )
    if "daily_health" in checks:
        hosts = daily_health_hosts()
        if hosts:
            for host in hosts:
                age, detail = daily_health_age(host)
                key = f"daily_health:{host}"
                if age is None or age > args.max_daily_health_age:
                    problems[key] = f"daily-health cadence stale for {host}: age_seconds={age if age is not None else 'missing'} max={args.max_daily_health_age} detail={detail}"
        else:
            age, detail = daily_health_age()
            if age is None or age > args.max_daily_health_age:
                problems["daily_health"] = f"daily-health cadence stale: age_seconds={age if age is not None else 'missing'} max={args.max_daily_health_age} detail={detail}"
    if "queue_backlog" in checks:
        problems.update(queue_backlog_problems())
    if "local_services" in checks:
        problems.update(local_service_problems())
    if "local_instance_health" in checks:
        problems.update(local_instance_health_problems())
    return problems


def incident_epoch(incident: dict[str, Any], key: str, fallback: int) -> int:
    parsed = parse_iso_epoch(incident.get(key))
    return parsed if parsed is not None else fallback


def int_or_zero(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def incident_age_seconds(incident: dict[str, Any], current: int) -> int:
    first_seen = incident_epoch(incident, "firstSeenAt", current)
    wall_age = max(0, current - first_seen)
    previous_age = int_or_zero(incident.get("ageSeconds"))
    return max(previous_age, wall_age)


def replacement_incident(current: int) -> dict[str, Any]:
    return {
        "firstSeenAt": now_iso(current),
        "lastSeenAt": now_iso(current),
        "lastNotifiedAt": now_iso(current),
        "lastEvidence": "malformed incident record",
        "suppressed": 0,
    }


def reconcile(problems: dict[str, str], active_prefixes: list[str]) -> list[Path]:
    state = load_state()
    open_incidents: dict[str, Any] = state["open"]
    written: list[Path] = []
    current = now_epoch()
    for key, evidence in sorted(problems.items()):
        redacted_evidence = redact_watchdog_text(evidence)
        if key in open_incidents and not isinstance(open_incidents[key], dict):
            open_incidents.pop(key, None)
        if key in open_incidents:
            incident = open_incidents[key]
            incident["suppressed"] = int_or_zero(incident.get("suppressed")) + 1
            incident["lastSeenAt"] = now_iso(current)
            incident["lastEvidence"] = redacted_evidence
            incident.pop("recoveryObservations", None)
            incident.pop("lastRecoveryObservedAt", None)
            suppressed = int_or_zero(incident.get("suppressed"))
            first_seen = incident_epoch(incident, "firstSeenAt", current)
            last_notified = incident_epoch(incident, "lastNotifiedAt", first_seen)
            age_seconds = incident_age_seconds(incident, current)
            incident["ageSeconds"] = age_seconds
            since_notify = max(0, current - last_notified)
            escalated = age_seconds >= watchdog_escalate_seconds() or suppressed >= watchdog_escalate_suppressed()
            should_renotify = since_notify >= watchdog_renotify_seconds()
            if should_renotify:
                incident["lastNotifiedAt"] = now_iso(current)
                incident["lastNotificationSuppressed"] = suppressed
                severity = "critical" if escalated else "warning"
                label = "escalated" if escalated else "still open"
                append_log(
                    "renotify_open",
                    {
                        "source": key,
                        "suppressed": suppressed,
                        "ageSeconds": age_seconds,
                        "sinceLastNotifySeconds": since_notify,
                        "escalated": escalated,
                        "evidence": evidence,
                    },
                )
                written.append(outbox_event(
                    f"BOT ERRORS heartbeat watchdog {label}: {key}",
                    "\n".join([
                        f"source={key}",
                        f"incident_still_open=true",
                        f"escalated={str(escalated).lower()}",
                        f"age_seconds={age_seconds}",
                        f"suppressed_duplicates={suppressed}",
                        f"last_notified={now_iso(last_notified)}",
                        evidence,
                        f"watchdog_state={watchdog_state_path()}",
                        f"watchdog_log={state_root() / 'logs/heartbeat-watchdog.jsonl'}",
                        "requested_action=Q investigate persistent monitor failure; this alert bypasses duplicate suppression by design.",
                    ]),
                    severity,
                    key,
                    force_notify=True,
                ))
                continue
            append_log("suppressed_open", {"source": key, "suppressed": suppressed, "evidence": evidence})
            continue
        open_incidents[key] = {
            "firstSeenAt": now_iso(current),
            "lastSeenAt": now_iso(current),
            "lastNotifiedAt": now_iso(current),
            "lastEvidence": redacted_evidence,
            "suppressed": 0,
        }
        written.append(outbox_event(
            f"BOT ERRORS heartbeat watchdog stale: {key}",
            "\n".join([
                f"source={key}",
                evidence,
                f"watchdog_state={watchdog_state_path()}",
                f"watchdog_log={state_root() / 'logs/heartbeat-watchdog.jsonl'}",
                "requested_action=Q investigate the silent monitor and restore cadence.",
            ]),
            "critical",
            key,
        ))
    for key in sorted(set(open_incidents) - set(problems)):
        if not key_in_active_scope(key, active_prefixes):
            continue
        incident = open_incidents[key]
        if not isinstance(incident, dict):
            incident = replacement_incident(current)
            open_incidents[key] = incident
        recovery_observations = int_or_zero(incident.get("recoveryObservations")) + 1
        incident["recoveryObservations"] = recovery_observations
        incident["lastRecoveryObservedAt"] = now_iso(current)
        required_observations = watchdog_recovery_confirmations()
        if recovery_observations < required_observations:
            append_log(
                "recovery_pending",
                {
                    "source": key,
                    "recoveryObservations": recovery_observations,
                    "requiredRecoveryObservations": required_observations,
                    "lastEvidence": incident.get("lastEvidence"),
                },
            )
            continue
        incident = open_incidents.pop(key)
        written.append(outbox_event(
            f"BOT ERRORS heartbeat watchdog recovered: {key}",
            "\n".join([
                f"source={key}",
                f"first_seen={incident.get('firstSeenAt')}",
                f"suppressed_duplicates={incident.get('suppressed', 0)}",
                f"recovery_observations={recovery_observations}",
                f"last_evidence={incident.get('lastEvidence')}",
                f"watchdog_state={watchdog_state_path()}",
            ]),
            "info",
            key,
            event_type="clear",
        ))
    save_state(state)
    return written


def run_once(args: argparse.Namespace) -> int:
    validate_thresholds()
    checks = configured_checks()
    problems = collect_problems(args, checks)
    written = reconcile(problems, active_reconcile_prefixes(checks))
    print(json.dumps({
        "time": now_iso(),
        "problems": sorted(problems),
        "eventsWritten": [str(path) for path in written],
    }, sort_keys=True))
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BOT ERRORS independent heartbeat watchdog")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-q-loop-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_Q_LOOP_AGE", 600))
    parser.add_argument("--max-dispatcher-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_DISPATCHER_AGE", 300))
    parser.add_argument("--max-collector-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_COLLECTOR_AGE", 180))
    parser.add_argument("--max-fleet-sentinel-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_FLEET_SENTINEL_AGE", 2700))
    parser.add_argument("--max-daily-health-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_DAILY_HEALTH_AGE", 25 * 60 * 60))
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    return run_once(args)


if __name__ == "__main__":
    sys.exit(main())
