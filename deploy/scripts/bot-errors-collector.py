#!/usr/bin/env python3
"""Pull BOT ERRORS events from remote machine outboxes into the nucles outbox."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import time
from typing import Any


REMOTE_CLAIM_SCRIPT = r"""
import json, os, sys, time
from pathlib import Path

root = Path(sys.argv[1]).expanduser()
limit = int(sys.argv[2])
lease_seconds = int(sys.argv[3])
outbox = root / "outbox"
processing = root / "relay-processing"
processing.mkdir(parents=True, exist_ok=True, mode=0o700)
try:
    processing.chmod(0o700)
except OSError:
    pass
now = time.time()
for claim in sorted(processing.glob("*.relay")):
    try:
        if now - claim.stat().st_mtime <= lease_seconds:
            continue
        target = outbox / (claim.name.split(".json.", 1)[0] + ".json" if ".json." in claim.name else claim.name)
        if target.exists():
            target = outbox / f"{int(now)}.{target.name}"
        os.replace(claim, target)
    except FileNotFoundError:
        pass
count = 0
for path in sorted(outbox.glob("*.json")):
    if count >= limit:
        break
    claim = processing / f"{path.name}.{os.getpid()}.relay"
    try:
        os.replace(path, claim)
        payload = claim.read_text(encoding="utf-8")
    except FileNotFoundError:
        continue
    print(json.dumps({"name": path.name, "claim": str(claim), "payload": payload}, sort_keys=True))
    count += 1
"""


REMOTE_ACK_SCRIPT = r"""
import os, sys, time
from pathlib import Path

claim = Path(sys.argv[1])
root = Path(sys.argv[2]).expanduser()
action = sys.argv[3]
if action == "ack":
    target_dir = root / "relayed"
    suffix = f".{int(time.time())}.relayed"
else:
    target_dir = root / "outbox"
    suffix = ""
target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
try:
    target_dir.chmod(0o700)
except OSError:
    pass
target = target_dir / (claim.name.split(".json.", 1)[0] + ".json" + suffix if ".json." in claim.name else claim.name + suffix)
if target.exists():
    target = target_dir / f"{int(time.time())}.{claim.name}{suffix}"
os.replace(claim, target)
print(target)
"""


REMOTE_WRITEFAIL_CLAIM_SCRIPT = r"""
import json, os, re, sys, time
from pathlib import Path

root = Path(sys.argv[1]).expanduser()
limit = int(sys.argv[2])
lease_seconds = int(sys.argv[3])

def unique(paths):
    result = []
    seen = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result.append(path)
    return result

def safe(value):
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value).strip("_")
    return (cleaned or "unknown")[:80]

def private_dir(candidates):
    for path in candidates:
        try:
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                path.chmod(0o700)
            except OSError:
                pass
            return path
        except OSError:
            continue
    raise RuntimeError("no writable writefail processing dir")

override = os.environ.get("BOT_ERRORS_WRITEFAIL_DIR")
sources = []
if override:
    sources.append(Path(override).expanduser())
sources.append(root / "writefail")
tmpdir = Path(os.environ.get("TMPDIR", "/tmp")).expanduser()
sources.append(tmpdir / "bot-errors-writefail")
sources.append(Path("/tmp") / "bot-errors-writefail")
sources.append(Path.home() / ".bot-errors-writefail")
sources = unique(sources)

processing = private_dir([
    root / "relay-writefail-processing",
    Path.home() / ".bot-errors-writefail-relay-processing",
    Path("/tmp") / f"bot-errors-writefail-relay-processing-{os.getuid()}",
])

now = time.time()
count = 0
for claim in sorted(processing.glob("*.relay-writefail")):
    try:
        if now - claim.stat().st_mtime <= lease_seconds:
            continue
        payload = claim.read_text(encoding="utf-8")
    except FileNotFoundError:
        continue
    print(json.dumps({
        "kind": "writefail",
        "name": claim.name,
        "claim": str(claim),
        "sourceDir": str(processing),
        "payload": payload,
    }, sort_keys=True))
    count += 1
    if count >= limit:
        raise SystemExit(0)

for source in sources:
    if count >= limit:
        break
    if not source.exists():
        continue
    for path in sorted(source.glob("*.writefail")):
        if count >= limit:
            break
        claim = processing / f"{safe(source.name)}.{safe(path.name)}.{os.getpid()}.relay-writefail"
        try:
            os.replace(path, claim)
            payload = claim.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        print(json.dumps({
            "kind": "writefail",
            "name": path.name,
            "claim": str(claim),
            "sourceDir": str(source),
            "payload": payload,
        }, sort_keys=True))
        count += 1
"""


REMOTE_WRITEFAIL_ACK_SCRIPT = r"""
import os, re, sys, time
from pathlib import Path

claim = Path(sys.argv[1])
root = Path(sys.argv[2]).expanduser()
action = sys.argv[3]

def safe(value):
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value).strip("_")
    return (cleaned or "unknown")[:80]

if action == "ack":
    try:
        target_dir = root / "writefail-relayed"
        target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = target_dir / f"{safe(claim.name)}.{int(time.time())}.relayed"
        os.replace(claim, target)
        print(target)
    except OSError:
        claim.unlink(missing_ok=True)
        print("deleted")
else:
    target_dir = root / "writefail"
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    base = claim.name.split(".writefail.", 1)[0] + ".writefail" if ".writefail." in claim.name else claim.name
    target = target_dir / safe(base)
    if target.exists():
        target = target_dir / f"{int(time.time())}.{safe(base)}"
    os.replace(claim, target)
    print(target)
"""


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:180]


def env_key_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").upper()


def remote_exec_prefix(host: str) -> list[str]:
    raw = os.environ.get(f"BOT_ERRORS_RELAY_EXEC_{env_key_segment(host)}", "")
    return shlex.split(raw) if raw else []


def ssh_command() -> list[str]:
    raw = os.environ.get("BOT_ERRORS_RELAY_SSH_COMMAND", "")
    return shlex.split(raw) if raw else ["ssh"]


def remote_python_command(host: str, args: list[str]) -> list[str]:
    return [
        *ssh_command(),
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        host,
        *remote_exec_prefix(host),
        "python3",
        "-",
        *args,
    ]


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
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
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def append_log(payload: dict[str, Any]) -> None:
    logs = state_root() / "logs"
    ensure_private_dir(logs)
    path = logs / "collector.jsonl"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"time": now_iso(), "pid": os.getpid(), **payload}, sort_keys=True) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def state_path() -> Path:
    return state_root() / "collector-state.json"


def load_state() -> dict[str, Any]:
    path = state_path()
    if not path.exists():
        return {"remotes": {}}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"remotes": {}}
    return loaded if isinstance(loaded, dict) else {"remotes": {}}


def save_state(state: dict[str, Any]) -> None:
    path = state_path()
    ensure_private_dir(path.parent)
    atomic_write_json(path, state)


def alert_key(remote: str, source: str) -> str:
    return f"{remote}:{source}"


def legacy_open_record(state: dict[str, Any], key: str, remote: str, source: str) -> dict[str, Any] | None:
    last = int(state.setdefault("alerts", {}).get(key) or 0)
    if not last:
        return None
    record = {
        "status": "open",
        "eventId": f"legacy-{safe_segment(remote)}-{safe_segment(source)}-{last}",
        "openedAt": last,
        "openedIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last)),
        "lastSeenAt": last,
        "lastSeenIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last)),
        "lastEvidence": "migrated from pre-open-incident collector state",
        "suppressedCount": 0,
    }
    state.setdefault("openAlerts", {})[key] = record
    return record


def enqueue_meta_alert(remote: str, source: str, summary: str, evidence: str, state: dict[str, Any], cooldown: int) -> None:
    current = int(time.time())
    alerts = state.setdefault("alerts", {})
    open_alerts = state.setdefault("openAlerts", {})
    key = alert_key(remote, source)
    open_record = open_alerts.get(key)
    if not isinstance(open_record, dict):
        open_record = legacy_open_record(state, key, remote, source)
    if isinstance(open_record, dict) and open_record.get("status") == "open":
        open_record["lastSeenAt"] = current
        open_record["lastSeenIso"] = now_iso()
        open_record["lastEvidence"] = evidence[-1000:]
        open_record["suppressedCount"] = int(open_record.get("suppressedCount") or 0) + 1
        append_log({
            "type": "meta_alert_suppressed_open",
            "remote": remote,
            "source": source,
            "eventId": open_record.get("eventId"),
            "suppressedCount": open_record["suppressedCount"],
        })
        return
    last = int(alerts.get(key) or 0)
    if current - last < cooldown:
        return
    event_id = f"collector-{safe_segment(remote)}-{safe_segment(source)}-{current}"
    event = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": "critical",
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": summary,
        "evidence": evidence,
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": {
            "queue": str(state_root() / "outbox"),
            "collectorLog": str(state_root() / "logs/collector.jsonl"),
            "remote": remote,
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    atomic_write_json(local_outbox_path(event, "collector"), event)
    alerts[key] = current
    open_alerts[key] = {
        "status": "open",
        "eventId": event_id,
        "openedAt": current,
        "openedIso": event["createdAt"],
        "lastSeenAt": current,
        "lastSeenIso": event["createdAt"],
        "lastEvidence": evidence[-1000:],
        "suppressedCount": 0,
    }


def enqueue_meta_recovery(remote: str, source: str, summary: str, evidence: str, state: dict[str, Any]) -> None:
    open_alerts = state.setdefault("openAlerts", {})
    key = alert_key(remote, source)
    open_record = open_alerts.get(key)
    if not isinstance(open_record, dict):
        open_record = legacy_open_record(state, key, remote, source)
    if not isinstance(open_record, dict) or open_record.get("status") != "open":
        return
    current = int(time.time())
    event_id = f"collector-{safe_segment(remote)}-{safe_segment(source)}-recovered-{current}"
    opened = open_record.get("openedIso") or open_record.get("openedAt")
    prior_event = open_record.get("eventId")
    suppressed = int(open_record.get("suppressedCount") or 0)
    event = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "clear",
        "severity": "info",
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": summary,
        "evidence": (
            f"{evidence}\n"
            f"opened={opened}\n"
            f"prior_event={prior_event}\n"
            f"suppressed_duplicates={suppressed}\n"
            f"collector_log={state_root() / 'logs/collector.jsonl'}"
        ),
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": {
            "queue": str(state_root() / "outbox"),
            "collectorLog": str(state_root() / "logs/collector.jsonl"),
            "remote": remote,
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    atomic_write_json(local_outbox_path(event, "collector"), event)
    open_alerts.pop(key, None)
    state.setdefault("alerts", {}).pop(key, None)
    append_log({
        "type": "meta_alert_recovered",
        "remote": remote,
        "source": source,
        "eventId": event_id,
        "priorEventId": prior_event,
        "suppressedCount": suppressed,
    })


def parse_remote(value: str) -> tuple[str, str]:
    if ":" in value:
        host, remote_root = value.split(":", 1)
        return host, remote_root
    return value, "~/.local/state/bot-errors"


def configured_remote_hosts(remotes: list[str]) -> list[str]:
    hosts: list[str] = []
    seen: set[str] = set()
    for remote in remotes:
        host, _remote_root = parse_remote(remote)
        if host in seen:
            continue
        seen.add(host)
        hosts.append(host)
    return hosts


def alert_remote_from_key(key: str) -> str | None:
    for source in ("remote-claim-failed", "remote-drain-stale"):
        suffix = f":{source}"
        if key.endswith(suffix):
            return key[: -len(suffix)]
    return None


def prune_state_to_configured_remotes(state: dict[str, Any], remotes: list[str]) -> None:
    configured = set(remotes)
    remote_state = state.get("remotes")
    if isinstance(remote_state, dict):
        for remote in list(remote_state):
            if remote not in configured:
                remote_state.pop(remote, None)
    else:
        state["remotes"] = {}
    for bucket_name in ("alerts", "openAlerts"):
        bucket = state.get(bucket_name)
        if not isinstance(bucket, dict):
            if bucket is not None:
                state[bucket_name] = {}
            continue
        for key in list(bucket):
            remote = alert_remote_from_key(str(key))
            if remote is not None and remote not in configured:
                bucket.pop(key, None)


def ssh_json_lines(host: str, script: str, args: list[str], timeout: int) -> list[dict[str, Any]]:
    proc = subprocess.run(
        remote_python_command(host, args),
        input=script,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh {host} failed rc={proc.returncode}: {proc.stderr.strip()[:500]}")
    rows = []
    for line in proc.stdout.splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def remote_ack(host: str, claim: str, remote_root: str, action: str, timeout: int) -> str:
    proc = subprocess.run(
        remote_python_command(host, [claim, remote_root, action]),
        input=REMOTE_ACK_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh ack {host} failed rc={proc.returncode}: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()


def remote_writefail_ack(host: str, claim: str, remote_root: str, action: str, timeout: int) -> str:
    proc = subprocess.run(
        remote_python_command(host, [claim, remote_root, action]),
        input=REMOTE_WRITEFAIL_ACK_SCRIPT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ssh writefail ack {host} failed rc={proc.returncode}: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()


def local_outbox_path(event: dict[str, Any], remote_host: str) -> Path:
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", state_root() / "outbox"))
    ensure_private_dir(outbox)
    created = str(event.get("createdAt") or now_iso()).replace("-", "").replace(":", "")
    filename = ".".join([
        created,
        f"relay-{safe_segment(remote_host)}",
        safe_segment(str(event.get("instance") or "unknown")),
        safe_segment(str(event.get("source") or "unknown")),
        safe_segment(str(event.get("id") or f'event-{int(time.time())}')),
        "json",
    ])
    return outbox / filename


def local_record_event_id(path: Path) -> str | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(loaded, dict):
        return None
    if isinstance(loaded.get("id"), str):
        return loaded["id"]
    event = loaded.get("event")
    if isinstance(event, dict) and isinstance(event.get("id"), str):
        return event["id"]
    return None


def local_event_exists(event_id: str) -> bool:
    if not event_id:
        return False
    root = state_root()
    for child in ("outbox", "processing", "sent", "suppressed", "writefail", "writefail-recovered"):
        directory = root / child
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if path.is_file() and local_record_event_id(path) == event_id:
                return True
    return False


def safe_child_path(directory: Path, name: str) -> Path:
    ensure_private_dir(directory)
    target = directory / safe_filename(name)
    if target.resolve().parent != directory.resolve():
        raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
    if target.exists():
        stem = safe_segment(name)
        target = directory / f"{int(time.time())}.{os.getpid()}.{stem}"
    return target


def local_writefail_path(remote_host: str, event_id: str) -> Path:
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.harvest-{safe_segment(remote_host)}.{safe_segment(event_id)}.writefail"
    return safe_child_path(state_root() / "writefail", name)


def local_writefail_quarantine_path(remote_host: str, record: dict[str, Any]) -> Path:
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.harvest-{safe_segment(remote_host)}.{safe_segment(str(record.get('name') or 'poison'))}.poison"
    return safe_child_path(state_root() / "writefail-harvest-quarantine", name)


def write_harvest_quarantine(remote_host: str, remote_root: str, record: dict[str, Any], reason: str) -> Path:
    path = local_writefail_quarantine_path(remote_host, record)
    payload = {
        "schemaVersion": 1,
        "kind": "writefail_harvest_poison",
        "remoteHost": remote_host,
        "remoteRoot": remote_root,
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "sourceDir": record.get("sourceDir"),
        "reason": reason,
        "payload": str(record.get("payload") or "")[:20000],
        "quarantinedAt": now_iso(),
    }
    atomic_write_json(path, payload)
    return path


def relay_writefail(remote_host: str, remote_root: str, record: dict[str, Any]) -> tuple[Path, str]:
    try:
        crumb = json.loads(record["payload"])
    except Exception as exc:
        path = write_harvest_quarantine(remote_host, remote_root, record, f"invalid JSON: {exc}")
        append_log({"type": "harvest_poison", "remote": remote_host, "path": str(path), "reason": str(exc)})
        return path, "poison"
    if not isinstance(crumb, dict):
        path = write_harvest_quarantine(remote_host, remote_root, record, "breadcrumb root is not an object")
        append_log({"type": "harvest_poison", "remote": remote_host, "path": str(path), "reason": "root"})
        return path, "poison"
    event = crumb.get("event")
    if crumb.get("kind") != "outbox_write_failure" or not isinstance(event, dict) or not isinstance(event.get("id"), str):
        path = write_harvest_quarantine(remote_host, remote_root, record, "missing outbox_write_failure event.id")
        append_log({"type": "harvest_poison", "remote": remote_host, "path": str(path), "reason": "schema"})
        return path, "poison"
    event_id = str(event["id"])
    if local_event_exists(event_id):
        append_log({
            "type": "writefail_duplicate_already_local",
            "remote": remote_host,
            "eventId": event_id,
            "remoteClaim": record.get("claim"),
        })
        return state_root() / "writefail-recovered" / f"existing-{safe_segment(event_id)}", "duplicate"
    crumb["harvest"] = {
        "fromHost": remote_host,
        "fromRoot": remote_root,
        "fromDir": record.get("sourceDir"),
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "collectorHost": socket.gethostname(),
        "harvestedAt": now_iso(),
    }
    path = local_writefail_path(remote_host, event_id)
    atomic_write_json(path, crumb)
    append_log({
        "type": "writefail_harvested",
        "remote": remote_host,
        "eventId": event_id,
        "remoteClaim": record.get("claim"),
        "localPath": str(path),
    })
    return path, "harvested"


def relay_event(remote_host: str, remote_root: str, record: dict[str, Any]) -> Path:
    event = json.loads(record["payload"])
    if not isinstance(event, dict):
        raise ValueError("remote event root must be an object")
    event_id = str(event.get("id") or "")
    if local_event_exists(event_id):
        append_log({"type": "duplicate_already_local", "remote": remote_host, "eventId": event_id, "remoteClaim": record["claim"]})
        return state_root() / "sent" / f"existing-{safe_segment(event_id)}"
    diagnostics = event.setdefault("diagnostics", {})
    if not isinstance(diagnostics, dict):
        diagnostics = {}
        event["diagnostics"] = diagnostics
    diagnostics["relay"] = {
        "remoteHost": remote_host,
        "remoteRoot": remote_root,
        "remoteClaim": record["claim"],
        "remoteName": record["name"],
        "collectorHost": socket.gethostname(),
        "collectedAt": now_iso(),
    }
    diagnostics["relayLog"] = str(state_root() / "logs/collector.jsonl")
    diagnostics["remoteQueue"] = str(Path(remote_root) / "outbox")
    event["delivery"] = {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None}
    path = local_outbox_path(event, remote_host)
    atomic_write_json(path, event)
    return path


def run_once(remotes: list[str], max_events: int, timeout: int, lease_seconds: int, remote_sla: int, alert_cooldown: int) -> dict[str, Any]:
    state = load_state()
    state["configuredRemotes"] = list(remotes)
    state["configuredRemoteHosts"] = configured_remote_hosts(remotes)
    state["updatedAt"] = now_iso()
    prune_state_to_configured_remotes(state, remotes)
    remote_state = state.setdefault("remotes", {})
    processed = 0
    writefail_harvested = 0
    writefail_duplicates = 0
    writefail_poison = 0
    failed = 0
    for remote in remotes:
        host, remote_root = parse_remote(remote)
        outbox_claim_failed = False
        try:
            records = ssh_json_lines(host, REMOTE_CLAIM_SCRIPT, [remote_root, str(max_events), str(lease_seconds)], timeout)
            remote_state.setdefault(remote, {})["lastSuccessAt"] = int(time.time())
            remote_state[remote]["lastSuccessIso"] = now_iso()
            remote_state[remote]["lastError"] = None
            enqueue_meta_recovery(
                remote,
                "remote-claim-failed",
                f"BOT ERRORS collector remote recovered: {remote}",
                f"remote={remote}\nremote_root={remote_root}\nclaim_status=success",
                state,
            )
            enqueue_meta_recovery(
                remote,
                "remote-drain-stale",
                f"BOT ERRORS collector remote drain recovered: {remote}",
                f"remote={remote}\nremote_root={remote_root}\nclaim_status=success",
                state,
            )
        except Exception as exc:  # noqa: BLE001 - collector must keep other remotes alive.
            failed += 1
            error = str(exc)
            outbox_claim_failed = True
            remote_state.setdefault(remote, {})["lastError"] = error
            append_log({"type": "remote_claim_failed", "remote": remote, "error": error})
            enqueue_meta_alert(
                remote,
                "remote-claim-failed",
                f"BOT ERRORS collector cannot claim remote outbox: {remote}",
                f"remote={remote}\nerror={error}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                state,
                alert_cooldown,
            )
            records = []
        try:
            writefail_records = ssh_json_lines(
                host,
                REMOTE_WRITEFAIL_CLAIM_SCRIPT,
                [remote_root, str(max_events), str(lease_seconds)],
                timeout,
            )
            enqueue_meta_recovery(
                remote,
                "remote-writefail-harvest-failed",
                f"BOT ERRORS collector remote writefail harvest recovered: {remote}",
                f"remote={remote}\nremote_root={remote_root}\nharvest_status=success",
                state,
            )
        except Exception as exc:  # noqa: BLE001 - outbox relay must not be blocked by B6 harvest.
            failed += 1
            writefail_records = []
            error = str(exc)
            append_log({"type": "remote_writefail_claim_failed", "remote": remote, "error": error})
            if not outbox_claim_failed:
                enqueue_meta_alert(
                    remote,
                    "remote-writefail-harvest-failed",
                    f"BOT ERRORS collector cannot claim remote writefail crumbs: {remote}",
                    f"remote={remote}\nremote_root={remote_root}\nerror={error}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                    state,
                    alert_cooldown,
                )
        for record in records:
            try:
                local_path = relay_event(host, remote_root, record)
                ack_path = remote_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                append_log({
                    "type": "relayed",
                    "remote": remote,
                    "remoteClaim": record["claim"],
                    "remoteAckPath": ack_path,
                    "localPath": str(local_path),
                })
                processed += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                try:
                    remote_ack(host, str(record["claim"]), remote_root, "requeue", timeout)
                except Exception as ack_exc:  # noqa: BLE001
                    append_log({"type": "remote_requeue_failed", "remote": remote, "claim": record.get("claim"), "error": str(ack_exc)})
                append_log({"type": "relay_failed", "remote": remote, "claim": record.get("claim"), "error": str(exc)})
        for record in writefail_records:
            try:
                local_path, status = relay_writefail(host, remote_root, record)
                if status == "poison":
                    writefail_poison += 1
                    remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                    append_log({
                        "type": "writefail_harvest_poison_acked",
                        "remote": remote,
                        "remoteClaim": record["claim"],
                        "localPath": str(local_path),
                    })
                elif status == "duplicate":
                    writefail_duplicates += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_duplicate_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "localPath": str(local_path),
                        })
                    except Exception as ack_exc:  # noqa: BLE001 - duplicate is already safe locally.
                        append_log({
                            "type": "writefail_harvest_duplicate_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "error": str(ack_exc),
                        })
                else:
                    writefail_harvested += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "localPath": str(local_path),
                        })
                    except Exception as ack_exc:  # noqa: BLE001 - exact-id dedup makes retry safe.
                        append_log({
                            "type": "writefail_harvest_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "localPath": str(local_path),
                            "error": str(ack_exc),
                        })
            except Exception as exc:  # noqa: BLE001
                failed += 1
                append_log({"type": "writefail_harvest_failed", "remote": remote, "claim": record.get("claim"), "error": str(exc)})
                enqueue_meta_alert(
                    remote,
                    "remote-writefail-harvest-failed",
                    f"BOT ERRORS collector cannot harvest remote writefail: {remote}",
                    f"remote={remote}\nremote_root={remote_root}\nerror={exc}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                    state,
                    alert_cooldown,
                )
        if outbox_claim_failed:
            continue
        last_success = int(remote_state.get(remote, {}).get("lastSuccessAt") or 0)
        age = int(time.time()) - last_success if last_success else remote_sla + 1
        if age > remote_sla:
            enqueue_meta_alert(
                remote,
                "remote-drain-stale",
                f"BOT ERRORS collector has not drained remote within SLA: {remote}",
                f"remote={remote}\nage_seconds={age}\nremote_sla_seconds={remote_sla}\nlast_success={remote_state.get(remote, {}).get('lastSuccessIso')}\nlast_error={remote_state.get(remote, {}).get('lastError')}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                state,
                alert_cooldown,
            )
    save_state(state)
    return {
        "processed": processed,
        "writefailHarvested": writefail_harvested,
        "writefailDuplicates": writefail_duplicates,
        "writefailPoison": writefail_poison,
        "failed": failed,
    }


def run_daemon(remotes: list[str], max_events: int, interval: int, timeout: int, lease_seconds: int, remote_sla: int, alert_cooldown: int) -> None:
    while True:
        result = run_once(remotes, max_events, timeout, lease_seconds, remote_sla, alert_cooldown)
        print(json.dumps({"time": now_iso(), **result}), flush=True)
        time.sleep(interval)


def main() -> int:
    parser = argparse.ArgumentParser(description="Relay remote BOT ERRORS outboxes into the local outbox")
    parser.add_argument("--remote", action="append", default=[])
    parser.add_argument("--max-events", type=int, default=25)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--remote-sla", type=int, default=300)
    parser.add_argument("--alert-cooldown", type=int, default=900)
    parser.add_argument("--daemon", action="store_true")
    args = parser.parse_args()

    remotes = args.remote or [r for r in os.environ.get("BOT_ERRORS_RELAY_REMOTES", "").split(",") if r]
    if not remotes:
        print("no remotes configured", file=sys.stderr)
        return 64
    if args.daemon:
        run_daemon(remotes, args.max_events, args.interval, args.timeout, args.lease_seconds, args.remote_sla, args.alert_cooldown)
        return 0
    result = run_once(remotes, args.max_events, args.timeout, args.lease_seconds, args.remote_sla, args.alert_cooldown)
    print(json.dumps(result, sort_keys=True))
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
