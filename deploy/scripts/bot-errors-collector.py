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

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value
from lib.bot_errors_envelope import new_event_fields
from lib.controller_log import (
    ControllerLogContext,
    controller_cycle,
    metadata_only_controller_details,
    write_controller_log,
)
from lib.durable_json import (
    JsonVersion,
    durable_json_target,
    observe_json,
    operation_id,
    publish_event_json,
    publish_state_json,
    require_advance,
)


TAILSCALE_STATUS_CACHE: dict[str, Any] | None = None
TAILSCALE_STATUS_ERROR: str | None = None
REMOTE_HOST_TARGETS_CACHE: dict[str, list[str]] = {}
CONTROLLER_LOG_CONTEXT = ControllerLogContext("collector")


def reset_tailscale_cache() -> None:
    """Clear the module-level Tailscale status memo.

    Called at the start of each collection cycle so that load_tailscale_status()
    re-fetches a fresh snapshot.  Within a single cycle the memo still avoids
    redundant subprocess calls (N hosts → 1 call per cycle).
    """
    global TAILSCALE_STATUS_CACHE, TAILSCALE_STATUS_ERROR
    TAILSCALE_STATUS_CACHE = None
    TAILSCALE_STATUS_ERROR = None

RELAY_BACKOFF_FAILURE_THRESHOLD: int = 3
RELAY_BACKOFF_SCHEDULE_S: list[int] = [300, 900, 3600]


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

def unique_target_path(target_dir, base, suffix):
    candidates = [target_dir / f"{base}{suffix}"]
    prefix = f"{int(time.time())}.{os.getpid()}"
    candidates.extend(target_dir / f"{prefix}.{index}.{base}{suffix}" for index in range(1000))
    for candidate in candidates:
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"no unique remote ack path in {target_dir}")

base = claim.name.split(".json.", 1)[0] + ".json" if ".json." in claim.name else claim.name
target = unique_target_path(target_dir, base, suffix)
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

def is_under(path, root):
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False

def source_durability(source):
    if source == root / "writefail" or source == Path.home() / ".bot-errors-writefail":
        return "durable", "state_or_home_path"
    if is_under(source, tmpdir) or is_under(source, Path("/tmp")):
        return "non_durable", "tmpdir_or_tmp_path"
    return "unknown", "configured_or_unclassified_path"

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
        "sourceDurability": "unknown",
        "sourceDurabilityReason": "relay_processing_claim",
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
        durability, durability_reason = source_durability(source)
        print(json.dumps({
            "kind": "writefail",
            "name": path.name,
            "claim": str(claim),
            "sourceDir": str(source),
            "sourceDurability": durability,
            "sourceDurabilityReason": durability_reason,
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

def unique_child_path(target_dir, name):
    stem = safe(name)
    candidates = [target_dir / stem]
    prefix = f"{int(time.time())}.{os.getpid()}"
    candidates.extend(target_dir / f"{prefix}.{index}.{stem}" for index in range(1000))
    for candidate in candidates:
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"no unique writefail requeue path in {target_dir}")

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
    target = unique_child_path(target_dir, base)
    os.replace(claim, target)
    print(target)
"""


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


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


def tailscale_status_command() -> list[str] | None:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_STATUS_COMMAND")
    if raw is not None and not raw.strip():
        return None
    return shlex.split(raw) if raw else ["tailscale", "status", "--json"]


def tailscale_lookup_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_STATUS_TIMEOUT_SECONDS", "2")
    try:
        timeout = float(raw)
    except ValueError:
        timeout = 2
    return max(timeout, 0.1)


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


def _durable_target(path: Path):
    ensure_private_dir(path.parent)
    return durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )


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
    try:
        dir_fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    except OSError:
        dir_fd = None
    if dir_fd is not None:
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def redact_collector_text(value: Any) -> str:
    return redact_bot_errors_text(
        value,
        credential_path_marker="[REDACTED_CREDENTIAL_PATH]",
        github_marker="[REDACTED_GITHUB_TOKEN]",
    )


def redacted_collector_payload(value: Any) -> Any:
    return redact_shared_json_value(value, redact_collector_text)


def persist_controller_log_health(record: dict[str, Any]) -> None:
    target = _durable_target(
        state_root() / "controller-log-health" / "collector.json"
    )
    observation = observe_json(target)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        record,
        component="collector.controller_log_health",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        record,
        component="collector.controller_log_health",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    if not publication.advance_allowed:
        require_advance(publication)


def controller_log_fallback(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def append_log(
    payload: dict[str, Any],
    *,
    level: str = "info",
    outcome: str = "observed",
) -> str:
    path = state_root() / "logs" / "collector.jsonl"
    redacted = redacted_collector_payload(payload)
    record_kind = redacted.get("type") if isinstance(redacted, dict) else None
    if not isinstance(record_kind, str):
        raise ValueError("collector controller log requires a bounded type")
    details = {key: value for key, value in redacted.items() if key != "type"}
    return write_controller_log(
        context=CONTROLLER_LOG_CONTEXT,
        record_kind=record_kind,
        level=level,
        outcome=outcome,
        durability_class="diagnostic_best_effort",
        details=metadata_only_controller_details(details),
        append_record=lambda record: append_private_jsonl(path, record),
        persist_health=persist_controller_log_health,
        emit_fallback=controller_log_fallback,
    )


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
    target = _durable_target(path)
    observation = observe_json(target)
    payload = redacted_collector_payload(state)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        payload,
        component="collector.state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        payload,
        component="collector.state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    require_advance(publication)


def alert_key(remote: str, source: str) -> str:
    return f"{remote}:{source}"


def normalize_match_token(value: Any) -> str:
    return re.sub(r"\s+", "-", str(value or "").strip().rstrip(".").lower())


def parse_remote_host_targets_env() -> dict[str, list[str]]:
    raw = os.environ.get("BOT_ERRORS_REMOTE_HOST_TARGETS", "").strip()
    if not raw:
        return {}
    parsed: dict[str, list[str]] = {}
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            for key, value in loaded.items():
                values = value if isinstance(value, list) else [value]
                parsed[str(key)] = [str(item).strip() for item in values if str(item).strip()]
            return parsed
    except json.JSONDecodeError:
        pass
    for item in raw.split(","):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        targets = [target.strip() for target in re.split(r"[|;]", value) if target.strip()]
        if key.strip() and targets:
            parsed[key.strip()] = targets
    return parsed


def unique_values(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = normalize_match_token(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(value)
    return result


def resolve_ssh_host_targets(host: str) -> list[str]:
    if host in REMOTE_HOST_TARGETS_CACHE:
        return REMOTE_HOST_TARGETS_CACHE[host]
    targets = [host]
    for value in parse_remote_host_targets_env().get(host, []):
        targets.append(value)
    try:
        proc = subprocess.run(
            [*ssh_command(), "-G", host],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=tailscale_lookup_timeout(),
            check=False,
        )
        if proc.returncode == 0:
            for line in proc.stdout.splitlines():
                if not line.strip() or " " not in line:
                    continue
                key, value = line.split(None, 1)
                if key.lower() in {"hostname", "hostkeyalias"} and value.strip():
                    targets.append(value.strip())
    except Exception as exc:  # noqa: BLE001 - enrichment must not block collection.
        append_log({"type": "ssh_config_lookup_failed", "host": host, "error": str(exc)[:300]})
    REMOTE_HOST_TARGETS_CACHE[host] = unique_values(targets)
    return REMOTE_HOST_TARGETS_CACHE[host]


def load_tailscale_status() -> tuple[dict[str, Any] | None, str | None]:
    global TAILSCALE_STATUS_CACHE, TAILSCALE_STATUS_ERROR
    if TAILSCALE_STATUS_CACHE is not None or TAILSCALE_STATUS_ERROR is not None:
        return TAILSCALE_STATUS_CACHE, TAILSCALE_STATUS_ERROR
    command = tailscale_status_command()
    if command is None:
        TAILSCALE_STATUS_ERROR = "disabled"
        return None, TAILSCALE_STATUS_ERROR
    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=tailscale_lookup_timeout(),
            check=False,
        )
    except Exception as exc:  # noqa: BLE001 - optional enrichment.
        TAILSCALE_STATUS_ERROR = str(exc)[:500]
        return None, TAILSCALE_STATUS_ERROR
    if proc.returncode != 0:
        TAILSCALE_STATUS_ERROR = f"rc={proc.returncode}: {proc.stderr.strip()[:300]}"
        return None, TAILSCALE_STATUS_ERROR
    try:
        loaded = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        TAILSCALE_STATUS_ERROR = f"invalid_json: {exc}"
        return None, TAILSCALE_STATUS_ERROR
    if not isinstance(loaded, dict):
        TAILSCALE_STATUS_ERROR = "json_root_not_object"
        return None, TAILSCALE_STATUS_ERROR
    TAILSCALE_STATUS_CACHE = loaded
    return TAILSCALE_STATUS_CACHE, None


def tailscale_peers(status: dict[str, Any]) -> list[dict[str, Any]]:
    peers: list[dict[str, Any]] = []
    self_peer = status.get("Self")
    if isinstance(self_peer, dict):
        peers.append(self_peer)
    raw_peers = status.get("Peer")
    if isinstance(raw_peers, dict):
        for peer in raw_peers.values():
            if isinstance(peer, dict):
                peers.append(peer)
    return peers


def peer_tokens(peer: dict[str, Any]) -> set[str]:
    tokens: set[str] = set()
    for key in ("HostName", "DNSName", "Name"):
        value = str(peer.get(key) or "").strip()
        if not value:
            continue
        normalized = normalize_match_token(value)
        tokens.add(normalized)
        if "." in normalized:
            tokens.add(normalized.split(".", 1)[0])
    ips = peer.get("TailscaleIPs")
    if isinstance(ips, list):
        for ip in ips:
            if isinstance(ip, str):
                tokens.add(normalize_match_token(ip))
    return {token for token in tokens if token}


def tailscale_peer_summary(host: str) -> dict[str, Any]:
    targets = resolve_ssh_host_targets(host)
    target_tokens = {normalize_match_token(target) for target in targets if normalize_match_token(target)}
    status, error = load_tailscale_status()
    if status is None:
        return {
            "status": "unavailable" if error != "disabled" else "disabled",
            "error": error,
            "targets": targets,
        }
    for peer in tailscale_peers(status):
        overlap = sorted(target_tokens.intersection(peer_tokens(peer)))
        if not overlap:
            continue
        summary = {
            "status": "found",
            "matched": overlap[0],
            "targets": targets,
            "hostName": peer.get("HostName"),
            "dnsName": peer.get("DNSName"),
            "tailscaleIPs": peer.get("TailscaleIPs") if isinstance(peer.get("TailscaleIPs"), list) else [],
            "online": peer.get("Online"),
            "active": peer.get("Active"),
            "lastSeen": peer.get("LastSeen"),
            "lastHandshake": peer.get("LastHandshake"),
            "os": peer.get("OS"),
        }
        return {key: value for key, value in summary.items() if value is not None}
    return {"status": "not_found", "targets": targets}


def evidence_value(value: Any) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, list):
        return ",".join(str(item) for item in value)
    return str(value)


def tailscale_evidence_lines(summary: dict[str, Any]) -> list[str]:
    if not summary or summary.get("status") == "disabled":
        return []
    ordered_keys = [
        "status",
        "matched",
        "hostName",
        "dnsName",
        "tailscaleIPs",
        "online",
        "active",
        "lastSeen",
        "lastHandshake",
        "os",
        "targets",
        "error",
    ]
    lines: list[str] = []
    for key in ordered_keys:
        value = summary.get(key)
        if value in (None, "", []):
            continue
        lines.append(f"tailscale_{key}={evidence_value(value)[:240]}")
    return lines


def _is_ssh_transport_failure(normalized_error: str) -> bool:
    """Return True when the error string indicates a transport-level SSH failure.

    Transport failures mean the TCP/TLS handshake never completed or SSH's own
    authentication (key / host-key) was rejected — the remote host is unreachable
    or the SSH layer itself cannot establish a session.  These are distinct from
    remote-command failures (nonzero exit, missing script, file permission errors)
    where the SSH tunnel was established successfully.

    Transport patterns (any of):
    - connection refused / reset
    - no route to host / network is unreachable
    - ssh: connect to host …  (generic SSH connect error prefix)
    - permission denied (publickey) / (password) / (gssapi…)  — SSH auth failure
    - host key verification failed / known_hosts mismatch
    - timed out / operation timed out / connection timed out (handled separately
      as tailscale_online_ssh_timeout; listed here so the caller need not repeat
      the check, but this helper is not called for timeouts — see ssh_failure_diagnosis)
    """
    return (
        "connection refused" in normalized_error
        or "connection reset by peer" in normalized_error
        or "no route to host" in normalized_error
        or "network is unreachable" in normalized_error
        or normalized_error.startswith("ssh: connect to host")
        or "permission denied (publickey" in normalized_error
        or "permission denied (password" in normalized_error
        or "permission denied (gssapi" in normalized_error
        or "host key verification failed" in normalized_error
        or "known_hosts" in normalized_error
    )


def ssh_failure_diagnosis(error: str, tailscale: dict[str, Any]) -> str | None:
    """Classify an SSH failure into one of three reachability diagnoses.

    Classification table:
    | Condition                               | Diagnosis                          |
    |-----------------------------------------|------------------------------------|
    | peer online + timeout variant           | tailscale_online_ssh_timeout       |
    | peer online + transport-level failure   | tailscale_online_ssh_failed        |
    | peer online + remote-command failure    | tailscale_online_ssh_remote_error  |
    | peer offline                            | tailscale_offline                  |
    | peer status unknown / not found         | None                               |

    Only tailscale_offline, tailscale_online_ssh_timeout, and
    tailscale_online_ssh_failed are genuine unreachability signals — callers must
    NOT skip secondary probes for tailscale_online_ssh_remote_error.
    """
    if not tailscale or tailscale.get("status") != "found":
        return None
    normalized_error = error.lower()
    if tailscale.get("online") is True and (
        "timed out" in normalized_error
        or "operation timed out" in normalized_error
        or "connection timed out" in normalized_error
    ):
        return "tailscale_online_ssh_timeout"
    if tailscale.get("online") is True:
        if _is_ssh_transport_failure(normalized_error):
            return "tailscale_online_ssh_failed"
        return "tailscale_online_ssh_remote_error"
    if tailscale.get("online") is False:
        return "tailscale_offline"
    return None


def remote_failure_context(host: str, error: str = "") -> tuple[list[str], dict[str, Any]]:
    tailscale = tailscale_peer_summary(host)
    if not tailscale or tailscale.get("status") == "disabled":
        return [], {}
    diagnostics: dict[str, Any] = {"tailscale": tailscale}
    lines = tailscale_evidence_lines(tailscale)
    diagnosis = ssh_failure_diagnosis(error, tailscale)
    if diagnosis:
        diagnostics["reachabilityDiagnosis"] = diagnosis
        lines.append(f"reachability_diagnosis={diagnosis}")
    return lines, diagnostics


def tailscale_ping_command(host: str) -> list[str] | None:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_PING_COMMAND")
    if raw is not None and not raw.strip():
        return None  # explicitly disabled
    if raw:
        return [*shlex.split(raw), host]
    return ["tailscale", "ping", "--c", "1", "--timeout", "3s", host]


def tailscale_ping_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_TAILSCALE_PING_TIMEOUT_SECONDS", "4")
    try:
        timeout = float(raw)
    except ValueError:
        timeout = 4
    return max(timeout, 0.5)


def liveness_probe_enabled() -> bool:
    raw = os.environ.get("BOT_ERRORS_PREFLIGHT_LIVENESS_PROBE", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def best_effort_info_tier_enabled() -> bool:
    """Pattern I — best-effort remotes are operator-declared expected-flaky hosts.

    A ``--best-effort-remote`` (e.g. a laptop that sleeps) going offline is a
    planned/expected condition, not a crash. When this gate is on (default), its
    per-remote failure events (``relay_host_down``, pre-threshold
    ``remote-claim-failed``) emit at ``info`` instead of ``warning``/``critical``
    so they surface in the digest without paging. Gate off restores prior
    behavior (fail-open).
    """
    raw = os.environ.get("BOT_ERRORS_BEST_EFFORT_INFO_TIER", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def probe_target_for(host: str, tailscale: dict[str, Any] | None = None) -> str:
    """Pick the address ``tailscale ping`` can actually resolve.

    ``tailscale ping`` resolves only Tailscale IPs and MagicDNS names — NOT
    arbitrary ssh host aliases. The collector keys remotes by their ssh alias,
    which ``tailscale ping`` cannot look up (``error looking up IP of
    "<alias>"``), so probing the bare alias always
    errored → fail-closed → the liveness probe could never clear a stale
    ``Online: false`` and the false-positive storm it was meant to suppress
    fired anyway.

    Prefer the peer's Tailscale IPv4, then any Tailscale IP, then the matched
    token, then the alias itself as a last resort.
    """
    summary = tailscale if tailscale is not None else tailscale_peer_summary(host)
    ips = summary.get("tailscaleIPs") if isinstance(summary, dict) else None
    if isinstance(ips, list):
        for ip in ips:
            if isinstance(ip, str) and "." in ip and ":" not in ip:
                return ip  # IPv4 — most universally pingable
        for ip in ips:
            if isinstance(ip, str) and ip:
                return ip  # IPv6 fallback
    matched = summary.get("matched") if isinstance(summary, dict) else None
    if isinstance(matched, str) and matched:
        return matched
    return host


def remote_liveness_probe_ok(host: str, probe_target: str | None = None) -> bool:
    """Confirm a peer is actually reachable via a direct probe.

    The Tailscale control-plane ``Online`` flag goes stale for idle peers that
    hold a direct (LAN) path — they stop refreshing the coordination-server
    heartbeat while remaining fully reachable over WireGuard. Trusting that flag
    alone produced correlated false-positive ``relay_host_down`` storms (the
    whole relay fleet flagged offline while every node answered ssh in <10ms).

    ``probe_target`` is the address actually handed to ``tailscale ping`` — it
    MUST be a Tailscale-resolvable IP/MagicDNS name, not the ssh host alias.
    Callers pass the peer's Tailscale IP via :func:`probe_target_for`. When
    omitted (unit tests) it falls back to ``host``.

    Returns True only on a positive pong. Fail-closed: a disabled, timed-out, or
    erroring probe returns False so the caller preserves the conservative
    skip-on-offline behaviour rather than hanging on a genuinely dead host.
    """
    if not liveness_probe_enabled():
        return False
    cmd = tailscale_ping_command(probe_target or host)
    if cmd is None:
        return False
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=tailscale_ping_timeout(),
            check=False,
        )
    except (subprocess.SubprocessError, OSError):
        return False
    return proc.returncode == 0 and "pong" in proc.stdout.lower()


def preflight_remote_unreachable(host: str) -> dict[str, Any] | None:
    tailscale = tailscale_peer_summary(host)
    if tailscale.get("status") == "found" and tailscale.get("online") is False:
        # The Online flag is a stale-prone control-plane heartbeat; confirm with
        # a real liveness probe before skipping ssh. A node that answers a direct
        # ping is reachable regardless of the flag — do not suppress its claim.
        # Probe the peer's Tailscale IP, never the bare ssh alias (which
        # ``tailscale ping`` cannot resolve).
        if remote_liveness_probe_ok(host, probe_target_for(host, tailscale)):
            return None
        return tailscale
    return None


def reachability_diagnosis(diagnostics: dict[str, Any]) -> str | None:
    value = diagnostics.get("reachabilityDiagnosis")
    return value if isinstance(value, str) and value else None


def skip_writefail_after_outbox_failure(diagnostics: dict[str, Any]) -> bool:
    return reachability_diagnosis(diagnostics) in {
        "tailscale_offline",
        "tailscale_online_ssh_timeout",
        "tailscale_online_ssh_failed",
    }


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


def clear_meta_recovery_progress(state: dict[str, Any], remote: str, source: str) -> None:
    open_record = state.setdefault("openAlerts", {}).get(alert_key(remote, source))
    if not isinstance(open_record, dict):
        return
    for field in (
        "recoveryPendingAt",
        "recoveryPendingIso",
        "recoveryConsecutiveSuccesses",
        "recoverySuccessesRequired",
        "recoveryEvidence",
    ):
        open_record.pop(field, None)


def enqueue_meta_alert(
    remote: str,
    source: str,
    summary: str,
    evidence: str,
    state: dict[str, Any],
    cooldown: int,
    extra_diagnostics: dict[str, Any] | None = None,
    best_effort: bool = False,
) -> None:
    current = int(time.time())
    effective_severity = "info" if (best_effort and best_effort_info_tier_enabled()) else "critical"
    alerts = state.setdefault("alerts", {})
    open_alerts = state.setdefault("openAlerts", {})
    key = alert_key(remote, source)
    safe_summary = redact_collector_text(summary)
    safe_evidence = redact_collector_text(evidence)
    safe_extra_diagnostics = redacted_collector_payload(extra_diagnostics) if extra_diagnostics else None
    open_record = open_alerts.get(key)
    if not isinstance(open_record, dict):
        open_record = legacy_open_record(state, key, remote, source)
    if isinstance(open_record, dict) and open_record.get("status") == "open":
        clear_meta_recovery_progress(state, remote, source)
        created_at = now_iso()
        open_record["lastSeenAt"] = current
        open_record["lastSeenIso"] = created_at
        open_record["lastEvidence"] = safe_evidence[-1000:]
        if safe_extra_diagnostics:
            open_record["lastDiagnostics"] = safe_extra_diagnostics
        open_record["suppressedCount"] = int(open_record.get("suppressedCount") or 0) + 1
        last_notify = int(open_record.get("lastRenotifyAt") or open_record.get("openedAt") or alerts.get(key) or current)
        if current - last_notify >= cooldown:
            renotify_count = int(open_record.get("renotifyCount") or 0) + 1
            event_id = f"collector-{safe_segment(remote)}-{safe_segment(source)}-still-open-{current}"
            opened = open_record.get("openedIso") or open_record.get("openedAt")
            prior_event = open_record.get("eventId")
            diagnostics = {
                "queue": str(state_root() / "outbox"),
                "logHints": [str(state_root() / "logs/collector.jsonl")],
                "collectorLog": str(state_root() / "logs/collector.jsonl"),
                "remote": remote,
                "openIncident": {
                    "opened": opened,
                    "priorEventId": prior_event,
                    "suppressedCount": open_record["suppressedCount"],
                    "renotifyCount": renotify_count,
                },
            }
            if safe_extra_diagnostics:
                diagnostics.update(safe_extra_diagnostics)
            event = {
                **new_event_fields("observation" if effective_severity == "info" else "alert", effective_severity),
                "id": event_id,
                "createdAt": created_at,
                "machine": socket.gethostname(),
                "platform": sys.platform,
                "instance": "bot-errors-collector",
                "source": source,
                "summary": f"{safe_summary} (still open)",
                "evidence": (
                    f"{safe_evidence}\n"
                    f"incident_status=still_open\n"
                    f"opened={opened}\n"
                    f"prior_event={prior_event}\n"
                    f"suppressed_duplicates={open_record['suppressedCount']}\n"
                    f"renotify_count={renotify_count}\n"
                    f"collector_log={state_root() / 'logs/collector.jsonl'}"
                ),
                "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
                "diagnostics": diagnostics,
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
            }
            path = local_outbox_path(event, "collector")
            target = _durable_target(path)
            absent = JsonVersion(False, None, None, None)
            publication_operation = operation_id(
                target,
                event,
                component="collector.meta_alert_existing_claim",
                predecessor=absent,
            )
            publication = publish_event_json(
                target,
                event,
                component="collector.meta_alert_existing_claim",
                operation_id=publication_operation,
            )
            require_advance(publication)
            alerts[key] = current
            open_record["lastRenotifyAt"] = current
            open_record["lastRenotifyIso"] = created_at
            open_record["lastRenotifyEventId"] = event_id
            open_record["renotifyCount"] = renotify_count
            append_log({
                "type": "meta_alert_renotified_open",
                "remote": remote,
                "source": source,
                "eventId": event_id,
                "priorEventId": prior_event,
                "suppressedCount": open_record["suppressedCount"],
                "renotifyCount": renotify_count,
            })
            return
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
    diagnostics = {
        "queue": str(state_root() / "outbox"),
        "logHints": [str(state_root() / "logs/collector.jsonl")],
        "collectorLog": str(state_root() / "logs/collector.jsonl"),
        "remote": remote,
    }
    if safe_extra_diagnostics:
        diagnostics.update(safe_extra_diagnostics)
    event = {
        **new_event_fields("observation" if effective_severity == "info" else "alert", effective_severity),
        "id": event_id,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": safe_summary,
        "evidence": safe_evidence,
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": diagnostics,
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = local_outbox_path(event, "collector")
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.meta_alert_new_claim",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.meta_alert_new_claim",
        operation_id=publication_operation,
    )
    require_advance(publication)
    alerts[key] = current
    open_alerts[key] = {
        "status": "open",
        "eventId": event_id,
        "openedAt": current,
        "openedIso": event["createdAt"],
        "lastSeenAt": current,
        "lastSeenIso": event["createdAt"],
        "lastEvidence": safe_evidence[-1000:],
        "suppressedCount": 0,
    }
    if safe_extra_diagnostics:
        open_alerts[key]["lastDiagnostics"] = safe_extra_diagnostics


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
    safe_summary = redact_collector_text(summary)
    safe_evidence = redact_collector_text(evidence)
    opened = open_record.get("openedIso") or open_record.get("openedAt")
    prior_event = open_record.get("eventId")
    suppressed = int(open_record.get("suppressedCount") or 0)
    event = {
        **new_event_fields("clear", "info"),
        "id": event_id,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": safe_summary,
        "evidence": (
            f"{safe_evidence}\n"
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
    path = local_outbox_path(event, "collector")
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.meta_recovery",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.meta_recovery",
        operation_id=publication_operation,
    )
    require_advance(publication)
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


def defer_meta_recovery(
    remote: str,
    source: str,
    state: dict[str, Any],
    consecutive_successes: int,
    required_successes: int,
    evidence: str,
) -> None:
    open_alerts = state.setdefault("openAlerts", {})
    key = alert_key(remote, source)
    open_record = open_alerts.get(key)
    if not isinstance(open_record, dict):
        open_record = legacy_open_record(state, key, remote, source)
    if not isinstance(open_record, dict) or open_record.get("status") != "open":
        return
    current = int(time.time())
    open_record["recoveryPendingAt"] = current
    open_record["recoveryPendingIso"] = now_iso()
    open_record["recoveryConsecutiveSuccesses"] = consecutive_successes
    open_record["recoverySuccessesRequired"] = required_successes
    open_record["recoveryEvidence"] = redact_collector_text(evidence)[-1000:]
    append_log({
        "type": "meta_alert_recovery_deferred",
        "remote": remote,
        "source": source,
        "consecutiveSuccesses": consecutive_successes,
        "requiredSuccesses": required_successes,
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


def default_recovery_successes() -> int:
    raw = os.environ.get("BOT_ERRORS_COLLECTOR_RECOVERY_SUCCESSES", "2")
    try:
        return max(1, int(raw))
    except ValueError:
        return 2


# HD-11b — collector capture-failure escalation (DEFECT-REGISTER collection-
# blindness class / NOTES.md wishlist 10, 13): a persistently uncollectable
# remote must not silently stall collection. Distinct from and independently
# tunable from RELAY_BACKOFF_FAILURE_THRESHOLD (backoff entry) -- both key off
# the same consecutiveFailures counter but serve different purposes: this is
# the earlier, lower-confidence escalation signal that opens a real dispatcher
# incident with a typed clear; relay_host_down is backoff-schedule entry.
COLLECTOR_CAPTURE_ESCALATION_SOURCE: str = "collector_remote_unreachable"


def collector_failure_escalate_threshold() -> int:
    raw = os.environ.get("BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD", "2")
    try:
        return max(1, int(raw))
    except ValueError:
        return 2


FAILURE_RETENTION_DETAIL_MAX_CHARS: int = 1000


def classify_collector_failure(exc: BaseException) -> str:
    """Classify a per-remote collection failure for retained diagnostics.

    Distinguishes malformed remote output (the SSH session completed and a
    claimed line failed to parse as JSON — a protocol/encoding problem on the
    remote side) from a genuine SSH/transport failure (nonzero exit,
    connection refused, timeout, preflight skip — anything that kept the
    remote command from running at all).
    """
    if isinstance(exc, json.JSONDecodeError):
        return "malformed_remote_output"
    return "ssh_failure"


def update_failure_retention(remote_record: dict[str, Any], exc: BaseException, error_text: str) -> None:
    """Persist bounded, redacted failure diagnostics that survive recovery.

    ``remote_record["lastError"]`` is cleared to ``None`` on the next success
    (see the success branch in :func:`run_once`), so the reason a remote was
    previously down is lost the moment it recovers. This retains a single,
    bounded record per remote — never an unbounded list — so an operator can
    still see what the last failure was, when it started, and when the remote
    recovered. Redaction runs before truncation (matching the
    ``safe_evidence`` pattern used elsewhere in this module) so a secret is
    never left half-exposed by the length cap.
    """
    current = int(time.time())
    retention = remote_record.get("failureRetention")
    if not isinstance(retention, dict):
        retention = {}
    failure_class = classify_collector_failure(exc)
    detail = redact_collector_text(error_text)[:FAILURE_RETENTION_DETAIL_MAX_CHARS]
    same_episode = retention.get("status") == "failing" and retention.get("failureClass") == failure_class
    if not same_episode:
        retention["firstObservedAt"] = current
        retention["firstObservedIso"] = now_iso()
    retention["status"] = "failing"
    retention["failureClass"] = failure_class
    retention["lastFailureDetail"] = detail
    retention["lastObservedAt"] = current
    retention["lastObservedIso"] = now_iso()
    remote_record["failureRetention"] = retention


def record_recovery_retention(remote_record: dict[str, Any]) -> None:
    """Mark recovery on the retained failure record, if one exists.

    Intentionally does not delete ``failureRetention`` — the prior failure
    detail must remain visible after recovery (DUR-03 acceptance: a
    fail -> success transition retains prior failure + recovery state). A
    remote that has never failed has no retention record and none is created
    here; retention only tracks remotes that have actually failed at least
    once.
    """
    retention = remote_record.get("failureRetention")
    if not isinstance(retention, dict):
        return
    current = int(time.time())
    retention["status"] = "recovered"
    retention["lastSuccessAt"] = current
    retention["lastSuccessIso"] = now_iso()


def ssh_json_lines(host: str, script: str, args: list[str], timeout: int) -> list[dict[str, Any]]:
    unreachable = preflight_remote_unreachable(host)
    if unreachable is not None:
        raise RuntimeError(f"preflight skipped ssh {host}: tailscale_offline")
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
        "lastError": redact_collector_text(error),
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
        evidence = redact_collector_text("\n".join([
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
        ]))
        event = {
            **new_event_fields("alert", "critical"),
            "id": event_id,
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
        path = local_outbox_path(event, "collector")
        target = _durable_target(path)
        absent = JsonVersion(False, None, None, None)
        publication_operation = operation_id(
            target,
            event,
            component="collector.writefail_ack_failure",
            predecessor=absent,
        )
        publication = publish_event_json(
            target,
            event,
            component="collector.writefail_ack_failure",
            operation_id=publication_operation,
        )
        require_advance(publication)
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
    event_id = str(event.get("id") or idless_event_filename_token(event, remote_host))
    filename = ".".join([
        created,
        f"relay-{safe_segment(remote_host)}",
        safe_segment(str(event.get("instance") or "unknown")),
        safe_segment(str(event.get("source") or "unknown")),
        safe_segment(event_id),
        "json",
    ])
    return safe_child_path(outbox, filename)


def idless_event_filename_token(event: dict[str, Any], remote_host: str) -> str:
    try:
        payload = json.dumps(event, sort_keys=True, separators=(",", ":"), default=str)
    except Exception:
        payload = str(event)
    digest = hashlib.sha256(f"{remote_host}\0{payload}".encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"idless-{digest}-{time.time_ns()}"


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
        root / "dead-letter",
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
    payload_text = redact_collector_text(record.get("payload") or "")
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
        "reason": redact_collector_text(reason),
        "payloadSha256": payload_sha256,
        "payload": payload_text[:20000],
        "quarantinedAt": now_iso(),
    }
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        payload,
        component="collector.harvest_quarantine",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        payload,
        component="collector.harvest_quarantine",
        operation_id=publication_operation,
    )
    require_advance(publication)
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
    crumb = redacted_collector_payload(crumb)
    crumb["harvest"] = {
        "fromHost": remote_host,
        "fromRoot": remote_root,
        "fromDir": record.get("sourceDir"),
        "sourceDurability": record.get("sourceDurability") or "unknown",
        "sourceDurabilityReason": record.get("sourceDurabilityReason") or "missing",
        "remoteClaim": record.get("claim"),
        "remoteName": record.get("name"),
        "collectorHost": socket.gethostname(),
        "harvestedAt": now_iso(),
    }
    path = local_writefail_path(remote_host, event_id)
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        crumb,
        component="collector.relay_writefail",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        crumb,
        component="collector.relay_writefail",
        operation_id=publication_operation,
    )
    require_advance(publication)
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
    event = redacted_collector_payload(event)
    path = local_outbox_path(event, remote_host)
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.relay_event",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.relay_event",
        operation_id=publication_operation,
    )
    require_advance(publication)
    return path


def _emit_collector_outbox_event(
    remote: str,
    source: str,
    event_type: str,
    severity: str,
    summary: str,
    evidence: str,
    log_type: str,
    extra_diagnostics: dict[str, Any] | None = None,
) -> str:
    """Shared low-level constructor for collector-minted outbox events (ENTRY/EXIT
    only). Used by both emit_relay_host_state_event (relay_host_down/recovered)
    and emit_collector_capture_escalation_event (collector_remote_unreachable) --
    extracted during HD-11b review to close a DRY gap AND fix an id-truncation
    collision (below) in both emitters at once, rather than fixing it in one and
    leaving the other's copy stale. Writes via atomic_write_json directly, NOT
    through enqueue_meta_alert, so these unconditional state transitions emit
    with no cooldown gate and contribute no open-alert tracking.

    instance="bot-errors-collector" + diagnostics.remote are load-bearing:
    dispatcher.py's incident_source() qualifies collector-minted events by
    diagnostics.remote precisely when instance == "bot-errors-collector" --
    that is what keeps per-remote incidents (e.g. two different unreachable
    remotes, or a remote's down-state vs a DIFFERENT remote's) on separate
    incident keys instead of colliding. Both fields are set unconditionally
    here so no caller can accidentally omit them.

    id ordering (time_ns/pid first, event_type + remote last) is deliberate,
    not cosmetic (found + RED-proven during HD-11b): local_outbox_path()
    truncates this id via safe_segment() at 80 chars and sorts outbox
    filenames lexicographically on the resulting name. A long remote
    ("host:/long/path") embedded before the numeric suffix can truncate away
    the very fields that make two events distinguishable -- two genuinely
    different events for the same remote would then collide on an identical
    filename and the second atomic_write_json silently overwrites the first
    (event loss). A text field (event_type: "alert"/"clear") sorting before
    the numeric time_ns also breaks filename-order-as-emission-order for two
    events sharing source/instance/created (same real-world second). Putting
    time_ns/pid first and the remote last means truncation can only ever
    clip the least-important trailing text.

    Returns the event id.
    """
    host, _remote_root = parse_remote(remote)
    diagnostics: dict[str, Any] = {
        "remote": remote,
        "host": host,
        "queue": str(state_root() / "outbox"),
        "logHints": [str(state_root() / "logs/collector.jsonl")],
        "collectorLog": str(state_root() / "logs/collector.jsonl"),
    }
    if extra_diagnostics:
        diagnostics.update(extra_diagnostics)
    event_id = f"collector-{time.time_ns()}-{os.getpid()}-{event_type}-{safe_segment(remote)}"
    envelope_event_type = "observation" if event_type == "alert" and severity == "info" else event_type
    event = {
        **new_event_fields(envelope_event_type, severity),
        "id": event_id,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-collector",
        "source": source,
        "summary": summary,
        "evidence": redact_collector_text(evidence),
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": diagnostics,
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = local_outbox_path(event, "collector")
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="collector.local_outbox_event",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="collector.local_outbox_event",
        operation_id=publication_operation,
    )
    require_advance(publication)
    append_log({
        "type": log_type,
        "remote": remote,
        "eventId": event_id,
        "evidence": redact_collector_text(evidence),
    })
    return event_id


def emit_relay_host_state_event(remote: str, kind: str, evidence: str, state: dict[str, Any], best_effort: bool = False) -> None:
    """Write a relay_host_down or relay_host_recovered outbox event (ENTRY/EXIT only).

    Delegates envelope construction to _emit_collector_outbox_event (shared
    with emit_collector_capture_escalation_event).
    """
    # Pattern I: a best-effort host going down is expected, not a crash — info, not a page.
    if kind == "relay_host_down" and not (best_effort and best_effort_info_tier_enabled()):
        severity = "warning"
    else:
        severity = "info"
    _emit_collector_outbox_event(
        remote,
        source=kind,
        event_type="alert",
        severity=severity,
        summary=f"BOT ERRORS collector relay host {kind.replace('_', ' ')}: {remote}",
        evidence=evidence,
        log_type=kind,
    )


def emit_collector_capture_escalation_event(
    remote: str,
    event_type: str,
    *,
    consecutive_failures: int | None = None,
    threshold: int | None = None,
    error_class: str | None = None,
    last_error: str | None = None,
    last_success_age_seconds: int | None = None,
    reachability_diagnosis_value: str | None = None,
) -> None:
    """Write a collector_remote_unreachable alert/clear outbox event (ENTRY/EXIT only).

    Delegates envelope construction to _emit_collector_outbox_event (shared
    with emit_relay_host_state_event), but is a genuinely distinct,
    independently-tunable signal: default threshold=2
    (BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD) fires earlier than
    RELAY_BACKOFF_FAILURE_THRESHOLD=3's relay_host_down, and — unlike
    relay_host_down/relay_host_recovered, which both use eventType="alert" —
    emits a real eventType="clear" on recovery so the dispatcher's standard
    clear-pop path (mark_incident_sent) closes the incident directly.
    """
    _, remote_root = parse_remote(remote)
    severity = "warning" if event_type == "alert" else "info"
    redacted_last_error = (
        redact_collector_text(last_error)[:FAILURE_RETENTION_DETAIL_MAX_CHARS] if last_error else None
    )
    evidence_parts = [f"remote={remote}"]
    if consecutive_failures is not None:
        evidence_parts.append(f"consecutive_failures={consecutive_failures}")
    if threshold is not None:
        evidence_parts.append(f"threshold={threshold}")
    if error_class:
        evidence_parts.append(f"error_class={error_class}")
    evidence_parts.append(
        f"last_success_age_seconds={last_success_age_seconds if last_success_age_seconds is not None else 'never'}"
    )
    if redacted_last_error:
        evidence_parts.append(f"last_error={redacted_last_error}")
    if reachability_diagnosis_value:
        evidence_parts.append(f"reachability_diagnosis={reachability_diagnosis_value}")
    evidence_parts.append(f"collector_log={state_root() / 'logs/collector.jsonl'}")
    evidence = "\n".join(evidence_parts)
    extra_diagnostics: dict[str, Any] = {
        "remoteRoot": remote_root,
        # Always present (possibly null) so a reader never has to distinguish
        # "never succeeded" from "field omitted".
        "consecutiveFailures": consecutive_failures,
        "thresholdConfigured": threshold,
        "errorClass": error_class,
        "lastSuccessAgeSeconds": last_success_age_seconds,
    }
    if reachability_diagnosis_value:
        extra_diagnostics["reachabilityDiagnosis"] = reachability_diagnosis_value
    _emit_collector_outbox_event(
        remote,
        source=COLLECTOR_CAPTURE_ESCALATION_SOURCE,
        event_type=event_type,
        severity=severity,
        summary=(
            f"BOT ERRORS collector cannot capture remote outbox: {remote}"
            if event_type == "alert"
            else f"BOT ERRORS collector remote capture recovered: {remote}"
        ),
        evidence=evidence,
        log_type=f"{COLLECTOR_CAPTURE_ESCALATION_SOURCE}_{event_type}",
        extra_diagnostics=extra_diagnostics,
    )


@controller_cycle(
    CONTROLLER_LOG_CONTEXT,
    lambda kind, details, level, outcome: append_log(
        {"type": kind, **details},
        level=level,
        outcome=outcome,
    ),
)
def run_once(
    remotes: list[str],
    best_effort_remotes: set[str],
    max_events: int,
    timeout: int,
    lease_seconds: int,
    remote_sla: int,
    alert_cooldown: int,
    recovery_successes: int,
) -> dict[str, Any]:
    reset_tailscale_cache()
    state = load_state()
    state["configuredRemotes"] = list(remotes)
    state["configuredRemoteHosts"] = configured_remote_hosts(remotes)
    state["configuredBestEffortRemotes"] = sorted(best_effort_remotes)
    state["configuredBestEffortRemoteHosts"] = configured_remote_hosts(sorted(best_effort_remotes))
    state["updatedAt"] = now_iso()
    prune_state_to_configured_remotes(state, remotes)
    remote_state = state.setdefault("remotes", {})
    processed = 0
    writefail_harvested = 0
    writefail_duplicates = 0
    writefail_poison = 0
    writefail_nondurable = 0
    remotes_succeeded = 0
    isolated_failures = 0
    best_effort_failures = 0
    best_effort_isolated_failures = 0
    hard_remotes_succeeded = 0
    failed = 0
    remotes_skipped_backoff = 0
    for remote in remotes:
        host, remote_root = parse_remote(remote)
        is_best_effort = remote in best_effort_remotes or host in best_effort_remotes
        outbox_claim_failed = False
        outbox_claim_succeeded = False
        outbox_relay_failed = False
        writefail_claim_failed = False
        skip_writefail_claim = False

        # --- Dead-host backoff guard ---
        # Read persisted backoff fields (all default-zero on first cycle).
        remote_record_pre = remote_state.setdefault(remote, {})
        consecutive_failures_pre = int(remote_record_pre.get("consecutiveFailures") or 0)
        next_attempt_at = int(remote_record_pre.get("nextAttemptAt") or 0)
        is_host_down = consecutive_failures_pre >= RELAY_BACKOFF_FAILURE_THRESHOLD
        now_epoch = int(time.time())
        if is_host_down and now_epoch < next_attempt_at:
            # Inside backoff window: skip SSH entirely, do not count as failure.
            remotes_skipped_backoff += 1
            append_log({
                "type": "remote_skipped_backoff",
                "remote": remote,
                "consecutiveFailures": consecutive_failures_pre,
                "nextAttemptAt": next_attempt_at,
                "secondsRemaining": next_attempt_at - now_epoch,
            })
            continue
        # Window has expired (or host not yet down): attempt SSH.

        try:
            records = ssh_json_lines(host, REMOTE_CLAIM_SCRIPT, [remote_root, str(max_events), str(lease_seconds)], timeout)
            outbox_claim_succeeded = True
        except Exception as exc:  # noqa: BLE001 - collector must keep other remotes alive.
            failed += 1
            isolated_failures += 1
            if is_best_effort:
                best_effort_failures += 1
                best_effort_isolated_failures += 1
            error = str(exc)
            outbox_claim_failed = True
            reachability_lines, reachability_diagnostics = remote_failure_context(host, error)
            remote_record = remote_state.setdefault(remote, {})
            remote_record["consecutiveSuccesses"] = 0
            remote_record["outboxRecoveryConsecutiveSuccesses"] = 0
            remote_record["lastError"] = error
            remote_record["lastFailureAt"] = int(time.time())
            remote_record["lastFailureIso"] = now_iso()
            update_failure_retention(remote_record, exc, error)
            if reachability_diagnostics:
                remote_record["lastReachability"] = reachability_diagnostics
                skip_writefail_claim = skip_writefail_after_outbox_failure(reachability_diagnostics)
            # Update consecutive-failure counter and backoff schedule.
            new_consecutive_failures = consecutive_failures_pre + 1
            remote_record["consecutiveFailures"] = new_consecutive_failures
            # --- HD-11b capture-failure escalation ladder ---
            # Three tiers, each SUPERSEDING the prior (boterr-lead ruling,
            # HD-11b battery 4, extending relay_host_down's own
            # "replaces per-attempt alerts" precedent one level down):
            #   tier 1: remote-claim-failed (cooldown-gated generic meta-alert)
            #   tier 2: collector_remote_unreachable (this packet)
            #   tier 3: relay_host_down (backoff schedule entry)
            # Exactly one open incident per remote at a time: crossing a
            # tier's threshold ACTIVELY CLOSES the previous tier's open
            # incident (enqueue_meta_recovery / a typed clear) before opening
            # the new one -- not just suppressing future re-emission of the
            # old tier, which would leave it open at the dispatcher.
            #
            # This MUST be a single mutually-exclusive ladder keyed on which
            # zone new_consecutive_failures falls in (tier 3 checked FIRST,
            # unconditionally) -- not two independent "if threshold crossed"
            # checks. A remote already at/past RELAY_BACKOFF_FAILURE_THRESHOLD
            # that fails again on a LATER cycle (after the backoff window
            # expires) still has new_consecutive_failures >= escalate_threshold
            # every time; an independent tier-2 check would reopen tier 2 on
            # that later cycle (captureFailureEscalated was already reset when
            # tier 3 first opened) without ever reclosing it, since tier 3's
            # own close-tier-2 step only runs on `not is_host_down` (first
            # entry). Caught + RED-proven during HD-11b battery 4 review.
            escalate_threshold = collector_failure_escalate_threshold()
            if new_consecutive_failures >= RELAY_BACKOFF_FAILURE_THRESHOLD:
                # Advance backoff schedule index (cap at last entry).
                schedule_index_old = int(remote_record.get("backoffScheduleIndex") or 0)
                if is_host_down:
                    # Already down: move to next schedule step.
                    schedule_index_new = min(schedule_index_old + 1, len(RELAY_BACKOFF_SCHEDULE_S) - 1)
                else:
                    # First crossing of threshold: start at index 0.
                    schedule_index_new = 0
                remote_record["backoffScheduleIndex"] = schedule_index_new
                remote_record["nextAttemptAt"] = int(time.time()) + RELAY_BACKOFF_SCHEDULE_S[schedule_index_new]
                if not is_host_down:
                    # First entry into down state: close tier 2 if open --
                    # tier 3 now covers this remote's failure with the
                    # strongest signal. No-op if escalate_threshold >=
                    # RELAY_BACKOFF_FAILURE_THRESHOLD (tier 2 never opened).
                    if remote_record.get("captureFailureEscalated"):
                        remote_record["captureFailureEscalated"] = False
                        prior_error_class = str((remote_record.get("failureRetention") or {}).get("failureClass") or "")
                        emit_collector_capture_escalation_event(
                            remote,
                            "clear",
                            consecutive_failures=new_consecutive_failures,
                            threshold=escalate_threshold,
                            error_class=prior_error_class or None,
                            last_success_age_seconds=None,
                        )
                    # Then record downSince and emit event.
                    remote_record["downSince"] = int(time.time())
                    remote_record["downEventEmitted"] = True
                    emit_relay_host_state_event(
                        remote,
                        "relay_host_down",
                        (
                            f"remote={remote}\n"
                            f"consecutive_failures={new_consecutive_failures}\n"
                            f"threshold={RELAY_BACKOFF_FAILURE_THRESHOLD}\n"
                            f"error={error}\n"
                            f"next_attempt_delay_s={RELAY_BACKOFF_SCHEDULE_S[schedule_index_new]}\n"
                            f"collector_log={state_root() / 'logs/collector.jsonl'}"
                        ),
                        state,
                        best_effort=is_best_effort,
                    )
                # While host is in down state (including subsequent cycles
                # after the backoff window expires and re-fails), do NOT fire
                # per-attempt meta-alerts OR reopen tier 2. The relay_host_down
                # event replaces them for the whole down episode.
            elif new_consecutive_failures >= escalate_threshold:
                if not remote_record.get("captureFailureEscalated"):
                    remote_record["captureFailureEscalated"] = True
                    # Close tier 1 if open -- tier 2 now covers this remote's
                    # failure with a stronger, more specific signal. No-op
                    # (enqueue_meta_recovery returns immediately) if tier 1
                    # never opened, e.g. escalate_threshold=1.
                    enqueue_meta_recovery(
                        remote,
                        "remote-claim-failed",
                        f"BOT ERRORS collector remote-claim alert superseded by escalation: {remote}",
                        f"remote={remote}\nsuperseded_by=collector_remote_unreachable\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                        state,
                    )
                    last_success_at = remote_record.get("lastSuccessAt")
                    last_success_age = int(time.time()) - int(last_success_at) if last_success_at else None
                    failure_class = str((remote_record.get("failureRetention") or {}).get("failureClass") or "")
                    emit_collector_capture_escalation_event(
                        remote,
                        "alert",
                        consecutive_failures=new_consecutive_failures,
                        threshold=escalate_threshold,
                        error_class=failure_class or None,
                        last_error=error,
                        last_success_age_seconds=last_success_age,
                        reachability_diagnosis_value=(reachability_diagnostics or {}).get("reachabilityDiagnosis"),
                    )
                else:
                    # Escalated (tier 2 open) but not yet backed off: the
                    # escalation event already covers this failure -- do not
                    # ALSO fire the generic per-attempt alert (tier 1). This
                    # is what keeps exactly one open incident per remote at a
                    # time; enqueue_meta_alert's own cooldown/open-incident
                    # tracking is bypassed entirely rather than relied on,
                    # since it has no notion of the escalation tier.
                    append_log({
                        "type": "remote_claim_failed_suppressed_escalated",
                        "remote": remote,
                        "error": error,
                        "reachability": reachability_diagnostics,
                    })
            else:
                # Below both thresholds: normal per-attempt alert.
                append_log({
                    "type": "remote_claim_failed",
                    "remote": remote,
                    "error": error,
                    "reachability": reachability_diagnostics,
                })
                enqueue_meta_alert(
                    remote,
                    "remote-claim-failed",
                    f"BOT ERRORS collector cannot claim remote outbox: {remote}",
                    "\n".join([
                        f"remote={remote}",
                        f"remote_root={remote_root}",
                        f"error={error}",
                        *reachability_lines,
                        f"collector_log={state_root() / 'logs/collector.jsonl'}",
                    ]),
                    state,
                    alert_cooldown,
                    reachability_diagnostics,
                    best_effort=is_best_effort,
                )
            records = []

        # --- Backoff recovery keyed on OUTBOX-CLAIM reachability ---
        # The outbox claim is the authoritative host-reachability signal; the
        # writefail harvest below is a secondary best-effort op whose failure must
        # NOT veto recovery (otherwise a half-up host — outbox OK, writefail broken —
        # would stay pinned in down state forever and re-storm via the writefail
        # surface). So clear the backoff/down state here, before the writefail try.
        if outbox_claim_succeeded:
            remote_record = remote_state.setdefault(remote, {})
            # --- HD-11b capture-failure escalation clear ---
            # Independent of the down/backoff recovery gate below (was_down /
            # recovered_from_down / recovery_successes): the escalate threshold
            # (default 2) is lower than RELAY_BACKOFF_FAILURE_THRESHOLD (3), so
            # a remote can be escalated without ever having entered backoff/down
            # state. Clears on the literal next successful claim per contract
            # (not gated by consecutive-success count) -- this is a distinct,
            # earlier-firing signal, so its clear condition is correspondingly
            # simpler than the backoff recovery's N-successes requirement.
            if remote_record.get("captureFailureEscalated"):
                prior_error_class = str((remote_record.get("failureRetention") or {}).get("failureClass") or "")
                emit_collector_capture_escalation_event(
                    remote,
                    "clear",
                    consecutive_failures=0,
                    threshold=collector_failure_escalate_threshold(),
                    error_class=prior_error_class or None,
                    last_success_age_seconds=0,
                )
                remote_record["captureFailureEscalated"] = False
            was_down = bool(remote_record.get("downEventEmitted"))
            outbox_recovery_successes = int(remote_record.get("outboxRecoveryConsecutiveSuccesses") or 0) + 1
            remote_record["outboxRecoveryConsecutiveSuccesses"] = outbox_recovery_successes
            remote_record["outboxRecoverySuccessesRequired"] = recovery_successes
            recovered_from_down = (not was_down) or outbox_recovery_successes >= recovery_successes
            if was_down and not recovered_from_down:
                append_log({
                    "type": "relay_host_recovery_deferred",
                    "remote": remote,
                    "consecutiveSuccesses": outbox_recovery_successes,
                    "requiredSuccesses": recovery_successes,
                })
            if was_down and recovered_from_down:
                emit_relay_host_state_event(
                    remote,
                    "relay_host_recovered",
                    (
                        f"remote={remote}\n"
                        f"down_since={remote_record.get('downSince')}\n"
                        f"prior_consecutive_failures={remote_record.get('consecutiveFailures')}\n"
                        f"outbox_recovery_consecutive_successes={outbox_recovery_successes}\n"
                        f"recovery_successes_required={recovery_successes}\n"
                        f"collector_log={state_root() / 'logs/collector.jsonl'}"
                    ),
                    state,
                )
            if recovered_from_down:
                remote_record["consecutiveFailures"] = 0
                remote_record["backoffScheduleIndex"] = 0
                remote_record["nextAttemptAt"] = None
                remote_record["downSince"] = None
                remote_record["downEventEmitted"] = False
                remote_record["outboxRecoveryConsecutiveSuccesses"] = 0
                remote_record["outboxRecoverySuccessesRequired"] = recovery_successes

        if skip_writefail_claim:
            writefail_records = []
            append_log({
                "type": "remote_writefail_claim_skipped_unreachable",
                "remote": remote,
                "reason": reachability_diagnosis(remote_state.setdefault(remote, {}).get("lastReachability", {})) or "outbox_claim_unreachable",
            })
        else:
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
                if is_best_effort:
                    best_effort_failures += 1
                writefail_claim_failed = True
                if outbox_claim_failed:
                    isolated_failures += 1
                    if is_best_effort:
                        best_effort_isolated_failures += 1
                writefail_records = []
                error = str(exc)
                reachability_lines, reachability_diagnostics = remote_failure_context(host, error)
                remote_record = remote_state.setdefault(remote, {})
                remote_record["consecutiveSuccesses"] = 0
                remote_record["lastError"] = error
                remote_record["lastFailureAt"] = int(time.time())
                remote_record["lastFailureIso"] = now_iso()
                update_failure_retention(remote_record, exc, error)
                if reachability_diagnostics:
                    remote_record["lastReachability"] = reachability_diagnostics
                clear_meta_recovery_progress(state, remote, "remote-claim-failed")
                clear_meta_recovery_progress(state, remote, "remote-drain-stale")
                # Check current down state (may have been updated by outbox claim failure above).
                cur_consecutive_failures = int(remote_record.get("consecutiveFailures") or 0)
                is_now_host_down = cur_consecutive_failures >= RELAY_BACKOFF_FAILURE_THRESHOLD
                append_log({
                    "type": "remote_writefail_claim_failed",
                    "remote": remote,
                    "error": error,
                    "reachability": reachability_diagnostics,
                })
                if not outbox_claim_failed and not is_now_host_down:
                    enqueue_meta_alert(
                        remote,
                        "remote-writefail-harvest-failed",
                        f"BOT ERRORS collector cannot claim remote writefail crumbs: {remote}",
                        "\n".join([
                            f"remote={remote}",
                            f"remote_root={remote_root}",
                            f"error={error}",
                            *reachability_lines,
                            f"collector_log={state_root() / 'logs/collector.jsonl'}",
                        ]),
                        state,
                        alert_cooldown,
                        reachability_diagnostics,
                    )
        if outbox_claim_succeeded and not writefail_claim_failed:
            remotes_succeeded += 1
            if not is_best_effort:
                hard_remotes_succeeded += 1
            remote_record = remote_state.setdefault(remote, {})
            consecutive_successes = int(remote_record.get("consecutiveSuccesses") or 0) + 1
            remote_record["consecutiveSuccesses"] = consecutive_successes
            remote_record["lastSuccessAt"] = int(time.time())
            remote_record["lastSuccessIso"] = now_iso()
            remote_record["lastError"] = None
            record_recovery_retention(remote_record)
            # NOTE: relay_host_recovered emission + backoff-field reset already
            # happened above, keyed on outbox-claim reachability (intentionally
            # decoupled from the writefail harvest). Here we only handle the
            # full-success meta-recovery path.
            recovery_evidence = (
                f"remote={remote}\n"
                f"remote_root={remote_root}\n"
                f"claim_status=success\n"
                f"writefail_claim_status=success\n"
                f"consecutive_successes={consecutive_successes}\n"
                f"recovery_successes_required={recovery_successes}"
            )
            if consecutive_successes >= recovery_successes:
                enqueue_meta_recovery(
                    remote,
                    "remote-claim-failed",
                    f"BOT ERRORS collector remote recovered: {remote}",
                    recovery_evidence,
                    state,
                )
            else:
                defer_meta_recovery(
                    remote,
                    "remote-claim-failed",
                    state,
                    consecutive_successes,
                    recovery_successes,
                    recovery_evidence,
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
                if is_best_effort:
                    best_effort_failures += 1
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
            remote_record = remote_state.setdefault(remote, {})
            remote_record["lastDrainAt"] = int(time.time())
            remote_record["lastDrainIso"] = now_iso()
            remote_record["lastDrainError"] = None
            drain_recovery_evidence = f"remote={remote}\nremote_root={remote_root}\noutbox_drain_status=success"
            enqueue_meta_recovery(
                remote,
                "remote-drain-stale",
                f"BOT ERRORS collector remote drain recovered: {remote}",
                drain_recovery_evidence,
                state,
            )
            enqueue_meta_recovery(
                remote,
                "remote-relay-failed",
                f"BOT ERRORS collector remote relay recovered: {remote}",
                f"remote={remote}\nremote_root={remote_root}\nrelay_status=success",
                state,
            )
        for record in writefail_records:
            if str(record.get("sourceDurability") or "") == "non_durable":
                writefail_nondurable += 1
                append_log({
                    "type": "remote_writefail_nondurable_source",
                    "remote": remote,
                    "remoteClaim": record.get("claim"),
                    "sourceDir": record.get("sourceDir"),
                    "sourceDurabilityReason": record.get("sourceDurabilityReason"),
                })
                enqueue_meta_alert(
                    remote,
                    "remote-writefail-nondurable",
                    f"BOT ERRORS collector harvested volatile remote writefail: {remote}",
                    (
                        f"remote={remote}\n"
                        f"remote_root={remote_root}\n"
                        f"source_dir={record.get('sourceDir')}\n"
                        f"source_durability={record.get('sourceDurability')}\n"
                        f"source_durability_reason={record.get('sourceDurabilityReason')}\n"
                        f"remote_name={record.get('name')}\n"
                        f"collector_log={state_root() / 'logs/collector.jsonl'}"
                    ),
                    state,
                    alert_cooldown,
                )
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
                        if is_best_effort:
                            best_effort_failures += 1
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
                        if is_best_effort:
                            best_effort_failures += 1
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
                        if is_best_effort:
                            best_effort_failures += 1
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
                if is_best_effort:
                    best_effort_failures += 1
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
        drain_record = remote_state.get(remote, {})
        last_drain = int(drain_record.get("lastDrainAt") or drain_record.get("lastSuccessAt") or 0)
        last_drain_iso = drain_record.get("lastDrainIso") or drain_record.get("lastSuccessIso")
        last_drain_error = drain_record.get("lastDrainError") or drain_record.get("lastError")
        age = int(time.time()) - last_drain if last_drain else remote_sla + 1
        if age > remote_sla:
            enqueue_meta_alert(
                remote,
                "remote-drain-stale",
                f"BOT ERRORS collector has not drained remote within SLA: {remote}",
                f"remote={remote}\nage_seconds={age}\nremote_sla_seconds={remote_sla}\nlast_drain={last_drain_iso}\nlast_error={last_drain_error}\ncollector_log={state_root() / 'logs/collector.jsonl'}",
                state,
                alert_cooldown,
            )
    save_state(state)
    return {
        "processed": processed,
        "writefailHarvested": writefail_harvested,
        "writefailDuplicates": writefail_duplicates,
        "writefailPoison": writefail_poison,
        "writefailNondurable": writefail_nondurable,
        "remotesSucceeded": remotes_succeeded,
        "isolatedFailures": isolated_failures,
        "bestEffortFailures": best_effort_failures,
        "bestEffortIsolatedFailures": best_effort_isolated_failures,
        "hardRemotesSucceeded": hard_remotes_succeeded,
        "failed": failed,
        "remotesSkippedBackoff": remotes_skipped_backoff,
    }


def run_daemon(
    remotes: list[str],
    best_effort_remotes: set[str],
    max_events: int,
    interval: int,
    timeout: int,
    lease_seconds: int,
    remote_sla: int,
    alert_cooldown: int,
    recovery_successes: int,
) -> None:
    while True:
        result = run_once(
            remotes,
            best_effort_remotes,
            max_events,
            timeout,
            lease_seconds,
            remote_sla,
            alert_cooldown,
            recovery_successes,
        )
        print(json.dumps({"time": now_iso(), **result}), flush=True)
        time.sleep(interval)


def exit_code_for_result(result: dict[str, Any]) -> int:
    hard_failed = int(result.get("failed") or 0) - int(result.get("bestEffortFailures") or 0)
    if hard_failed <= 0:
        return 0
    hard_isolated = int(result.get("isolatedFailures") or 0) - int(result.get("bestEffortIsolatedFailures") or 0)
    hard_remotes_succeeded = int(result.get("hardRemotesSucceeded") or 0)
    return 1 if not hard_remotes_succeeded or hard_failed > hard_isolated else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Relay remote BOT ERRORS outboxes into the local outbox")
    parser.add_argument("--remote", action="append", default=[])
    parser.add_argument("--best-effort-remote", action="append", default=[])
    parser.add_argument("--max-events", type=int, default=25)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--remote-sla", type=int, default=300)
    parser.add_argument("--alert-cooldown", type=int, default=900)
    parser.add_argument("--recovery-successes", type=int, default=default_recovery_successes())
    parser.add_argument("--daemon", action="store_true")
    args = parser.parse_args()

    remotes = args.remote or [r for r in os.environ.get("BOT_ERRORS_RELAY_REMOTES", "").split(",") if r]
    if not remotes:
        print("no remotes configured", file=sys.stderr)
        return 64
    best_effort_remotes = set(args.best_effort_remote or [])
    recovery_successes = max(1, int(args.recovery_successes))
    if args.daemon:
        run_daemon(
            remotes,
            best_effort_remotes,
            args.max_events,
            args.interval,
            args.timeout,
            args.lease_seconds,
            args.remote_sla,
            args.alert_cooldown,
            recovery_successes,
        )
        return 0
    result = run_once(
        remotes,
        best_effort_remotes,
        args.max_events,
        args.timeout,
        args.lease_seconds,
        args.remote_sla,
        args.alert_cooldown,
        recovery_successes,
    )
    print(json.dumps(result, sort_keys=True))
    return exit_code_for_result(result)


if __name__ == "__main__":
    raise SystemExit(main())
