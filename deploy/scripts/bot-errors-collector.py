#!/usr/bin/env python3
"""Pull BOT ERRORS events from remote machine outboxes into the nucles outbox."""

from __future__ import annotations

import argparse
import hashlib
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
sources.append(Path.home() / ".bot-errors-writefail")
sources.append(tmpdir / "bot-errors-writefail")
sources.append(Path("/tmp") / "bot-errors-writefail")
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
import errno, hashlib, json, os, re, shutil, sys, time
from pathlib import Path

claim = Path(sys.argv[1])
root = Path(sys.argv[2]).expanduser()
action = sys.argv[3]

def safe(value):
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value).strip("_")
    return (cleaned or "unknown")[:80]

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

def fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def payload_sha256():
    digest = hashlib.sha256()
    with open(claim, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def target_path(target_dir, suffix):
    stem = f"{safe(claim.name)}.{int(time.time())}"
    candidates = [target_dir / f"{stem}{suffix}", target_dir / f"{stem}.{os.getpid()}{suffix}"]
    candidates.extend(target_dir / f"{stem}.{os.getpid()}.{index}{suffix}" for index in range(1, 100))
    for candidate in candidates:
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"no unique terminal writefail ack path in {target_dir}")

def temp_path(target_dir, target):
    candidates = [target_dir / f".{target.name}.{os.getpid()}.tmp"]
    candidates.extend(target_dir / f".{target.name}.{os.getpid()}.{index}.tmp" for index in range(1, 100))
    for candidate in candidates:
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"no unique temporary writefail ack path in {target_dir}")

def journal_path(target_dir, digest):
    return target_dir / f".{safe(claim.name)}.{digest[:24]}.ack.json"

def write_ack_journal(target, digest):
    journal = journal_path(target.parent, digest)
    tmp = journal.with_name(f".{journal.name}.{os.getpid()}.tmp")
    payload = {
        "claim": str(claim),
        "payloadSha256": digest,
        "target": str(target),
        "createdAt": int(time.time()),
    }
    try:
        with open(tmp, "x", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, journal)
        fsync_dir(target.parent)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    return journal

def find_terminal_journal(digest):
    for target_dir in terminal_dirs():
        journal = journal_path(target_dir, digest)
        try:
            loaded = json.loads(journal.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except Exception:
            continue
        if loaded.get("claim") != str(claim) or loaded.get("payloadSha256") != digest:
            continue
        target = Path(str(loaded.get("target") or ""))
        if target.exists():
            return target
    return None

def terminal_dirs():
    tmpdir = Path(os.environ.get("TMPDIR", "/tmp")).expanduser()
    # The local harvest/quarantine copy is authoritative; these terminal archives are forensic breadcrumbs.
    return unique([
        root / "writefail-relayed",
        Path.home() / ".bot-errors-writefail-relayed",
        tmpdir / "bot-errors-writefail-relayed",
        Path("/tmp") / f"bot-errors-writefail-relayed-{os.getuid()}",
    ])

def copy_claim_atomic(target_dir, target):
    digest = payload_sha256()
    tmp = temp_path(target_dir, target)
    try:
        with open(claim, "rb") as source, open(tmp, "xb") as dest:
            shutil.copyfileobj(source, dest)
            dest.flush()
            os.fsync(dest.fileno())
        if target.exists():
            raise FileExistsError(f"terminal writefail ack target already exists: {target}")
        os.replace(tmp, target)
        fsync_dir(target_dir)
        # If this journal write fails, a later retry may create a duplicate forensic archive; local harvest stays authoritative.
        write_ack_journal(target, digest)
        claim.unlink()
        fsync_dir(claim.parent)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise

def move_claim_terminal(target_dir, suffix):
    target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        target_dir.chmod(0o700)
    except OSError:
        pass
    target = target_path(target_dir, suffix)
    try:
        os.replace(claim, target)
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise
        copy_claim_atomic(target_dir, target)
        return target
    fsync_dir(target_dir)
    fsync_dir(claim.parent)
    return target

if action == "ack":
    digest = payload_sha256()
    already_terminal = find_terminal_journal(digest)
    if already_terminal is not None:
        try:
            claim.unlink()
            fsync_dir(claim.parent)
            print(already_terminal)
            raise SystemExit(0)
        except OSError as exc:
            raise RuntimeError(f"terminal writefail ack already archived but claim unlink failed: target={already_terminal} error={exc}") from exc
    last_error = None
    for target_dir in terminal_dirs():
        try:
            target = move_claim_terminal(target_dir, ".relayed")
            print(target)
            raise SystemExit(0)
        except OSError as exc:
            last_error = exc
            continue
    raise RuntimeError(f"no writable writefail ack terminal dir: {last_error}")
else:
    # Requeue intentionally returns only to root/writefail; if that write fails, the processing lease preserves retry state.
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


def safe_filename(value: str, max_length: int = 180) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    cleaned = cleaned or "unknown"
    if len(cleaned) <= max_length:
        return cleaned
    for suffix in (".writefail", ".poison", ".json"):
        if cleaned.endswith(suffix) and len(suffix) < max_length:
            stem = cleaned[: max_length - len(suffix)].rstrip("._-:")
            return f"{stem or 'unknown'}{suffix}"
    return cleaned[:max_length]


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
            dir_fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
        except OSError:
            dir_fd = None
        if dir_fd is not None:
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
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
            "logHints": [str(state_root() / "logs/collector.jsonl")],
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
            "logHints": [str(state_root() / "logs/collector.jsonl")],
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
    for source in ("remote-claim-failed", "remote-drain-stale", "remote-relay-failed"):
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
    ack_failures = state.get("writefailAckFailures")
    if isinstance(ack_failures, dict):
        for key, record in list(ack_failures.items()):
            if not isinstance(record, dict) or record.get("remote") not in configured:
                ack_failures.pop(key, None)
    elif ack_failures is not None:
        state["writefailAckFailures"] = {}


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


def remote_writefail_ack_degraded(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return "/bot-errors-writefail-relayed/" in normalized or "/bot-errors-writefail-relayed-" in normalized


def writefail_ack_identity(remote: str, record: dict[str, Any]) -> tuple[str, str]:
    payload_sha256 = writefail_poison_hash(record)
    key = hashlib.sha256(f"{remote}\0{payload_sha256}".encode("utf-8")).hexdigest()
    return key, payload_sha256


def writefail_ack_failure_bucket(state: dict[str, Any]) -> dict[str, Any]:
    bucket = state.setdefault("writefailAckFailures", {})
    if not isinstance(bucket, dict):
        bucket = {}
        state["writefailAckFailures"] = bucket
    return bucket


def clear_writefail_ack_failure(remote: str, record: dict[str, Any], state: dict[str, Any]) -> None:
    key, payload_sha256 = writefail_ack_identity(remote, record)
    removed = writefail_ack_failure_bucket(state).pop(key, None)
    if removed is not None:
        append_log({
            "type": "writefail_ack_failure_cleared",
            "remote": remote,
            "payloadSha256": payload_sha256,
            "remoteClaim": record.get("claim"),
        })


def enqueue_writefail_ack_failure(
    remote: str,
    remote_root: str,
    record: dict[str, Any],
    status: str,
    local_path: Path,
    error: Exception,
    state: dict[str, Any],
    cooldown: int,
) -> None:
    current = int(time.time())
    key, payload_sha256 = writefail_ack_identity(remote, record)
    bucket = writefail_ack_failure_bucket(state)
    existing = bucket.get(key)
    entry = existing if isinstance(existing, dict) else {}
    first_failure = not entry
    last_alert = int(entry.get("lastAlertAt") or 0)
    should_alert = first_failure or not last_alert or current - last_alert >= cooldown
    entry.update({
        "remote": remote,
        "remoteRoot": remote_root,
        "payloadSha256": payload_sha256,
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "sourceDir": record.get("sourceDir"),
        "status": status,
        "localPath": str(local_path),
        "lastError": str(error),
        "lastSeenAt": current,
        "lastSeenIso": now_iso(),
        "seenCount": int(entry.get("seenCount") or 0) + 1,
    })
    if first_failure:
        entry["firstFailedAt"] = current
        entry["firstFailedIso"] = now_iso()
        entry["suppressedCount"] = 0
    if should_alert:
        event_id = f"collector-{safe_segment(remote)}-remote-writefail-ack-failed-{payload_sha256[:16]}-{current}"
        evidence = "\n".join([
            f"remote={remote}",
            f"remote_root={remote_root}",
            f"remote_claim={record.get('claim')}",
            f"remote_name={record.get('name')}",
            f"source_dir={record.get('sourceDir')}",
            f"writefail_status={status}",
            f"payload_sha256={payload_sha256}",
            f"local_path={local_path}",
            f"error={error}",
            f"alert_path=normal_outbox",
            f"terminal_ack_dirs_are_not_used_for_this_meta_alert=true",
            f"collector_log={state_root() / 'logs/collector.jsonl'}",
        ])
        event = {
            "schemaVersion": 1,
            "id": event_id,
            "eventType": "alert",
            "severity": "critical",
            "createdAt": now_iso(),
            "machine": socket.gethostname(),
            "platform": sys.platform,
            "instance": "bot-errors-collector",
            "source": "remote-writefail-ack-failed",
            "summary": f"BOT ERRORS collector cannot terminal-ack remote writefail: {remote}",
            "evidence": evidence,
            "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
            "diagnostics": {
                "queue": str(state_root() / "outbox"),
                "logHints": [str(state_root() / "logs/collector.jsonl")],
                "collectorLog": str(state_root() / "logs/collector.jsonl"),
                "remote": remote,
                "remoteClaim": record.get("claim"),
                "payloadSha256": payload_sha256,
            },
            "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
        }
        atomic_write_json(local_outbox_path(event, "collector"), event)
        entry["lastAlertAt"] = current
        entry["lastAlertIso"] = event["createdAt"]
        entry["suppressedCount"] = 0
        append_log({
            "type": "writefail_ack_failure_alerted",
            "remote": remote,
            "payloadSha256": payload_sha256,
            "remoteClaim": record.get("claim"),
            "eventId": event_id,
            "error": str(error),
        })
    else:
        entry["suppressedCount"] = int(entry.get("suppressedCount") or 0) + 1
        append_log({
            "type": "writefail_ack_failure_suppressed",
            "remote": remote,
            "payloadSha256": payload_sha256,
            "remoteClaim": record.get("claim"),
            "suppressedCount": entry["suppressedCount"],
            "error": str(error),
        })
    bucket[key] = entry


def local_outbox_path(event: dict[str, Any], remote_host: str) -> Path:
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", state_root() / "outbox"))
    created = str(event.get("createdAt") or now_iso()).replace("-", "").replace(":", "")
    filename = ".".join([
        created,
        f"relay-{safe_segment(remote_host)}",
        safe_segment(str(event.get("instance") or "unknown")),
        safe_segment(str(event.get("source") or "unknown")),
        safe_segment(str(event.get("id") or f'event-{int(time.time())}')),
        "json",
    ])
    return safe_child_path(outbox, filename)


def local_record_event_identity(path: Path) -> tuple[str | None, str]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None, ""
    if not isinstance(loaded, dict):
        return None, ""
    if isinstance(loaded.get("id"), str):
        return loaded["id"], str(loaded.get("createdAt") or "")
    event = loaded.get("event")
    if isinstance(event, dict) and isinstance(event.get("id"), str):
        return event["id"], str(event.get("createdAt") or "")
    return None, ""


def local_event_exists(event_id: str, created_at: str = "") -> bool:
    if not event_id:
        return False
    root = state_root()
    candidates = [
        Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox")),
        root / "processing",
        root / "sent",
        root / "storm-collapsed",
        root / "suppressed",
        root / "quarantine",
        root / "writefail",
        root / "writefail-recovered",
        root / "writefail-quarantine",
    ]
    seen: set[Path] = set()
    for directory in candidates:
        try:
            key = directory.resolve()
        except OSError:
            key = directory
        if key in seen:
            continue
        seen.add(key)
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            existing_id, existing_created_at = local_record_event_identity(path)
            if existing_id == event_id and (not created_at or not existing_created_at or existing_created_at == created_at):
                return True
    return False


def safe_child_path(directory: Path, name: str) -> Path:
    ensure_private_dir(directory)
    target = directory / safe_filename(name)
    if target.resolve().parent != directory.resolve():
        raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
    if target.exists():
        stem = safe_filename(name, 140)
        prefix = f"{int(time.time())}.{os.getpid()}"
        for counter in range(1000):
            target = directory / f"{prefix}.{counter}.{stem}"
            if target.resolve().parent != directory.resolve():
                raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
            if not target.exists():
                return target
        raise RuntimeError(f"no available child path in {directory}: {name}")
    return target


def local_writefail_path(remote_host: str, event_id: str) -> Path:
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.harvest-{safe_segment(remote_host)}.{safe_segment(event_id)}.writefail"
    return safe_child_path(state_root() / "writefail", name)


def writefail_poison_hash(record: dict[str, Any]) -> str:
    payload = str(record.get("payload") or "")
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()


def existing_harvest_quarantine(remote_host: str, remote_root: str, record: dict[str, Any], payload_sha256: str) -> Path | None:
    directory = state_root() / "writefail-harvest-quarantine"
    if not directory.exists():
        return None
    remote_claim = str(record.get("claim") or "")
    for path in sorted(directory.glob("*.poison")):
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(loaded, dict):
            continue
        if loaded.get("remoteHost") != remote_host or loaded.get("remoteRoot") != remote_root:
            continue
        if loaded.get("payloadSha256") == payload_sha256:
            return path
        if remote_claim and "payloadSha256" not in loaded and loaded.get("remoteClaim") == remote_claim:
            return path
    return None


def local_writefail_quarantine_path(remote_host: str, record: dict[str, Any], payload_sha256: str) -> Path:
    directory = state_root() / "writefail-harvest-quarantine"
    name = (
        f"harvest-{safe_segment(remote_host)}."
        f"{payload_sha256[:24]}."
        f"{safe_segment(str(record.get('name') or 'poison'))}.poison"
    )
    return safe_child_path(directory, name)


def write_harvest_quarantine(remote_host: str, remote_root: str, record: dict[str, Any], reason: str) -> Path:
    payload_text = str(record.get("payload") or "")
    payload_sha256 = writefail_poison_hash(record)
    existing = existing_harvest_quarantine(remote_host, remote_root, record, payload_sha256)
    if existing is not None:
        return existing
    path = local_writefail_quarantine_path(remote_host, record, payload_sha256)
    payload = {
        "schemaVersion": 1,
        "kind": "writefail_harvest_poison",
        "remoteHost": remote_host,
        "remoteRoot": remote_root,
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "sourceDir": record.get("sourceDir"),
        "reason": reason,
        "payloadSha256": payload_sha256,
        "payload": payload_text[:20000],
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
    if local_event_exists(event_id, str(event.get("createdAt") or "")):
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
    if local_event_exists(event_id, str(event.get("createdAt") or "")):
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
    diagnostics["queue"] = str(state_root() / "outbox")
    log_hints = diagnostics.get("logHints")
    if isinstance(log_hints, list):
        log_hints.append(str(state_root() / "logs/collector.jsonl"))
    else:
        diagnostics["logHints"] = [str(state_root() / "logs/collector.jsonl")]
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
    remotes_succeeded = 0
    isolated_failures = 0
    failed = 0
    for remote in remotes:
        host, remote_root = parse_remote(remote)
        outbox_claim_failed = False
        outbox_relay_failed = False
        try:
            records = ssh_json_lines(host, REMOTE_CLAIM_SCRIPT, [remote_root, str(max_events), str(lease_seconds)], timeout)
            remotes_succeeded += 1
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
            isolated_failures += 1
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
            if outbox_claim_failed:
                isolated_failures += 1
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
                outbox_relay_failed = True
                failed += 1
                try:
                    remote_ack(host, str(record["claim"]), remote_root, "requeue", timeout)
                except Exception as ack_exc:  # noqa: BLE001
                    append_log({"type": "remote_requeue_failed", "remote": remote, "claim": record.get("claim"), "error": str(ack_exc)})
                append_log({"type": "relay_failed", "remote": remote, "claim": record.get("claim"), "error": str(exc)})
                enqueue_meta_alert(
                    remote,
                    "remote-relay-failed",
                    f"BOT ERRORS collector cannot relay remote event: {remote}",
                    f"remote={remote}\nremote_root={remote_root}\nremote_name={record.get('name')}\nremote_claim={record.get('claim')}\nerror={exc}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                    state,
                    alert_cooldown,
                )
        if not outbox_claim_failed and not outbox_relay_failed:
            enqueue_meta_recovery(
                remote,
                "remote-relay-failed",
                f"BOT ERRORS collector remote relay recovered: {remote}",
                f"remote={remote}\nremote_root={remote_root}\nrelay_status=success",
                state,
            )
        for record in writefail_records:
            try:
                local_path, status = relay_writefail(host, remote_root, record)
                if status == "poison":
                    writefail_poison += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_poison_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "remoteAckDegraded": remote_writefail_ack_degraded(ack_path),
                            "localPath": str(local_path),
                        })
                        clear_writefail_ack_failure(remote, record, state)
                    except Exception as ack_exc:  # noqa: BLE001 - poison is already quarantined locally.
                        failed += 1
                        append_log({
                            "type": "writefail_harvest_poison_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "localPath": str(local_path),
                            "error": str(ack_exc),
                        })
                        enqueue_writefail_ack_failure(remote, remote_root, record, status, local_path, ack_exc, state, alert_cooldown)
                elif status == "duplicate":
                    writefail_duplicates += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_duplicate_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "remoteAckDegraded": remote_writefail_ack_degraded(ack_path),
                            "localPath": str(local_path),
                        })
                        clear_writefail_ack_failure(remote, record, state)
                    except Exception as ack_exc:  # noqa: BLE001 - duplicate is already safe locally.
                        failed += 1
                        append_log({
                            "type": "writefail_harvest_duplicate_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "error": str(ack_exc),
                        })
                        enqueue_writefail_ack_failure(remote, remote_root, record, status, local_path, ack_exc, state, alert_cooldown)
                else:
                    writefail_harvested += 1
                    try:
                        ack_path = remote_writefail_ack(host, str(record["claim"]), remote_root, "ack", timeout)
                        append_log({
                            "type": "writefail_harvest_acked",
                            "remote": remote,
                            "remoteClaim": record["claim"],
                            "remoteAckPath": ack_path,
                            "remoteAckDegraded": remote_writefail_ack_degraded(ack_path),
                            "localPath": str(local_path),
                        })
                        clear_writefail_ack_failure(remote, record, state)
                    except Exception as ack_exc:  # noqa: BLE001 - exact-id dedup makes retry safe.
                        failed += 1
                        append_log({
                            "type": "writefail_harvest_ack_failed",
                            "remote": remote,
                            "remoteClaim": record.get("claim"),
                            "localPath": str(local_path),
                            "error": str(ack_exc),
                        })
                        enqueue_writefail_ack_failure(remote, remote_root, record, status, local_path, ack_exc, state, alert_cooldown)
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
        "remotesSucceeded": remotes_succeeded,
        "isolatedFailures": isolated_failures,
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
    return 1 if result["failed"] and (not result["remotesSucceeded"] or result["failed"] > result["isolatedFailures"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
