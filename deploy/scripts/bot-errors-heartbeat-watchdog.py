#!/usr/bin/env python3
"""Independent heartbeat watchdog for BOT ERRORS monitoring components."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
from typing import Any


DEFAULT_CHECKS = "q_loop,dispatcher,collector,daily_health"


def now_epoch() -> int:
    override = os.environ.get("BOT_ERRORS_DRY_NOW")
    return int(override) if override is not None else int(time.time())


def now_iso(ts: int | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or now_epoch()))


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def q_loop_state_path() -> Path:
    return Path(os.environ.get("BOT_ERRORS_Q_LOOP_STATE", Path.home() / ".local/state/bot-errors-q-loop/state.json"))


def watchdog_state_path() -> Path:
    return state_root() / "heartbeat-watchdog-state.json"


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def append_log(kind: str, payload: dict[str, Any]) -> None:
    logs = state_root() / "logs"
    ensure_private_dir(logs)
    path = logs / "heartbeat-watchdog.jsonl"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"time": now_iso(), "kind": kind, **payload}, sort_keys=True) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def load_state() -> dict[str, Any]:
    path = watchdog_state_path()
    data = load_json(path)
    if data is None:
        return {"version": 1, "open": {}}
    if not isinstance(data.get("open"), dict):
        data["open"] = {}
    return data


def save_state(state: dict[str, Any]) -> None:
    state["updatedAt"] = now_iso()
    atomic_write_json(watchdog_state_path(), state)


def outbox_event(summary: str, evidence: str, severity: str, source_key: str, event_type: str = "alert") -> Path:
    root = state_root()
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))
    ensure_private_dir(root)
    ensure_private_dir(outbox)
    current = now_epoch()
    event_id = f"heartbeat-watchdog-{re.sub(r'[^A-Za-z0-9_.:-]+', '_', source_key).replace(':', '-')}-{current}"
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
        "summary": summary,
        "evidence": evidence,
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
    path = outbox / f"{event['createdAt'].replace(':', '').replace('-', '')}.{event_id}.json"
    atomic_write_json(path, event)
    return path


def json_updated_age(path: Path, key: str = "updated_at") -> tuple[int | None, str]:
    current = now_epoch()
    if not path.exists():
        return None, f"missing {path}"
    data = load_json(path)
    if data and isinstance(data.get(key), (int, float)):
        updated = int(data[key])
        return max(0, current - updated), f"{path} {key}={updated}"
    return max(0, current - int(path.stat().st_mtime)), f"{path} mtime={int(path.stat().st_mtime)}"


def file_age(path: Path) -> tuple[int | None, str]:
    if not path.exists():
        return None, f"missing {path}"
    return max(0, now_epoch() - int(path.stat().st_mtime)), f"{path} mtime={int(path.stat().st_mtime)}"


def daily_health_hosts() -> list[str]:
    raw = os.environ.get("BOT_ERRORS_DAILY_HEALTH_HOSTS", "")
    if raw:
        return [part.strip() for part in raw.split(",") if part.strip()]
    collector_hosts = collector_configured_hosts()
    if not collector_hosts:
        return []
    return unique_hosts([*local_daily_health_hosts(), *collector_hosts])


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


def parse_remote_host(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    remote = value.strip()
    if not remote:
        return None
    return remote.split(":", 1)[0]


def collector_configured_hosts() -> list[str]:
    data = load_json(state_root() / "collector-state.json")
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
    for dirname in ("outbox", "processing", "sent", "relayed"):
        directory = root / dirname
        if not directory.exists():
            continue
        for path in directory.glob("*.json*"):
            data: dict[str, Any] | None = None
            if "daily-health" not in path.name:
                data = load_json(path)
                if not data or data.get("source") != "daily-health":
                    continue
            events.append((path, int(path.stat().st_mtime), data))
    return events


def daily_health_age(host: str | None = None) -> tuple[int | None, str]:
    dry_age = os.environ.get("BOT_ERRORS_DRY_DAILY_HEALTH_AGE_SECONDS")
    if dry_age is not None and host is None:
        return int(dry_age), "dry daily-health age"
    newest: int | None = None
    newest_path = ""
    for path, mtime, data in daily_health_events():
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


def collect_problems(args: argparse.Namespace) -> dict[str, str]:
    checks = configured_checks()
    problems: dict[str, str] = {}
    if "q_loop" in checks:
        age, detail = json_updated_age(q_loop_state_path())
        if age is None or age > args.max_q_loop_age:
            problems["q_loop"] = f"q-loop heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_q_loop_age} detail={detail}"
    if "dispatcher" in checks:
        age, detail = file_age(state_root() / "dispatcher-state.json")
        if age is None or age > args.max_dispatcher_age:
            problems["dispatcher"] = f"dispatcher heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_dispatcher_age} detail={detail}"
    if "collector" in checks:
        age, detail = file_age(state_root() / "collector-state.json")
        if age is None or age > args.max_collector_age:
            problems["collector"] = f"collector heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_collector_age} detail={detail}"
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
    return problems


def reconcile(problems: dict[str, str]) -> list[Path]:
    state = load_state()
    open_incidents: dict[str, Any] = state["open"]
    written: list[Path] = []
    current = now_epoch()
    for key, evidence in sorted(problems.items()):
        if key in open_incidents:
            incident = open_incidents[key]
            incident["suppressed"] = int(incident.get("suppressed", 0)) + 1
            incident["lastSeenAt"] = now_iso(current)
            incident["lastEvidence"] = evidence
            append_log("suppressed_open", {"source": key, "suppressed": incident["suppressed"], "evidence": evidence})
            continue
        open_incidents[key] = {
            "firstSeenAt": now_iso(current),
            "lastSeenAt": now_iso(current),
            "lastEvidence": evidence,
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
        incident = open_incidents.pop(key)
        written.append(outbox_event(
            f"BOT ERRORS heartbeat watchdog recovered: {key}",
            "\n".join([
                f"source={key}",
                f"first_seen={incident.get('firstSeenAt')}",
                f"suppressed_duplicates={incident.get('suppressed', 0)}",
                f"last_evidence={incident.get('lastEvidence')}",
                f"watchdog_state={watchdog_state_path()}",
            ]),
            "info",
            f"{key}-recovered",
            event_type="clear",
        ))
    save_state(state)
    return written


def run_once(args: argparse.Namespace) -> int:
    problems = collect_problems(args)
    written = reconcile(problems)
    print(json.dumps({
        "time": now_iso(),
        "problems": sorted(problems),
        "eventsWritten": [str(path) for path in written],
    }, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BOT ERRORS independent heartbeat watchdog")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-q-loop-age", type=int, default=int(os.environ.get("BOT_ERRORS_MAX_Q_LOOP_AGE", "600")))
    parser.add_argument("--max-dispatcher-age", type=int, default=int(os.environ.get("BOT_ERRORS_MAX_DISPATCHER_AGE", "300")))
    parser.add_argument("--max-collector-age", type=int, default=int(os.environ.get("BOT_ERRORS_MAX_COLLECTOR_AGE", "180")))
    parser.add_argument("--max-daily-health-age", type=int, default=int(os.environ.get("BOT_ERRORS_MAX_DAILY_HEALTH_AGE", str(25 * 60 * 60))))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return run_once(args)


if __name__ == "__main__":
    sys.exit(main())
