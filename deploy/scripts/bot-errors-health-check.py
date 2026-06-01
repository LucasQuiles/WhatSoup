#!/usr/bin/env python3
"""BOT ERRORS deadman and daily capability/config health checks."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen


BOT_ERRORS_JID = os.environ.get("BOT_ERRORS_JID", "").strip()
SOCKET_PATH = os.environ.get("BOT_ERRORS_SOCKET_PATH", "").strip()
EMAIL_FALLBACK = os.environ.get(
    "BOT_ERRORS_EMAIL_FALLBACK",
    str(Path.home() / ".claude/scripts/email-alert-fallback.sh"),
)
REQUIRED_TOOLS = sorted(set(
    os.environ.get(
        "BOT_ERRORS_REQUIRED_TOOLS",
        "send_message,list_chats,search_messages,get_chat,get_group_metadata",
    ).split(",")
))
HOST_PLATFORM = os.environ.get("BOT_ERRORS_DRY_PLATFORM", sys.platform)
DEFAULT_DISPATCHER_SERVICE = "com.bot-errors.dispatcher" if HOST_PLATFORM == "darwin" else "bot-errors-dispatcher.service"
DEFAULT_Q_LOOP_SERVICE = "com.bot-errors.q-loop" if HOST_PLATFORM == "darwin" else "bot-errors-q-loop.service"
DISPATCHER_SERVICE = os.environ.get("BOT_ERRORS_DISPATCHER_SERVICE", DEFAULT_DISPATCHER_SERVICE)
Q_LOOP_SERVICE = os.environ.get("BOT_ERRORS_Q_LOOP_SERVICE", DEFAULT_Q_LOOP_SERVICE)
DEFAULT_HEALTH_PROFILE = {
    "role": "central",
    "expectDispatcher": True,
    "expectQLoop": True,
    "expectPersonalSocket": True,
    "expectPersonalTools": True,
    "expectConfigInventory": True,
}
ROOT_CREDENTIAL_FILES = {"fleet-token", "fleet.env", "fleet-tokens.json", "secrets.env"}
SECRETISH_ASSIGNMENT = re.compile(
    r"\b(api[_-]?key|token|secret|password|authorization|cookie|credential)\b(\s*[:=]\s*)([\"']?)[^\s\"',}]+",
    re.IGNORECASE,
)
BEARER_VALUE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+")
PHONE_LIKE = re.compile(r"(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])")


def kernel_release() -> str:
    override = os.environ.get("BOT_ERRORS_DRY_PLATFORM_RELEASE")
    if override is not None:
        return override
    try:
        return Path("/proc/sys/kernel/osrelease").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def is_wsl() -> bool:
    release = kernel_release().lower()
    return HOST_PLATFORM == "linux" and (
        "microsoft" in release
        or "wsl" in release
        or bool(os.environ.get("WSL_DISTRO_NAME"))
    )


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def load_health_profile() -> dict[str, Any]:
    raw = os.environ.get("BOT_ERRORS_HEALTH_PROFILE_JSON")
    path = os.environ.get("BOT_ERRORS_HEALTH_PROFILE")
    profile: dict[str, Any] = dict(DEFAULT_HEALTH_PROFILE)
    if raw:
        try:
            loaded = json.loads(raw)
        except json.JSONDecodeError as exc:
            return profile | {"profileLoadError": f"invalid BOT_ERRORS_HEALTH_PROFILE_JSON: {exc}"}
        if isinstance(loaded, dict):
            profile.update(loaded)
        else:
            profile["profileLoadError"] = "BOT_ERRORS_HEALTH_PROFILE_JSON must be an object"
    elif path:
        try:
            loaded = json.loads(Path(path).read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - daily health should report profile failure.
            return profile | {"profileLoadError": f"cannot read profile {path}: {exc}"}
        if isinstance(loaded, dict):
            profile.update(loaded)
        else:
            profile["profileLoadError"] = f"profile {path} must be an object"
    return profile


def profile_bool(profile: dict[str, Any], key: str, default: bool) -> bool:
    value = profile.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "on"}
    return bool(value)


def profile_instances(profile: dict[str, Any]) -> list[dict[str, Any]]:
    raw = profile.get("instances", [])
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def profile_string_list(container: dict[str, Any], key: str) -> list[str]:
    raw = container.get(key, [])
    if not isinstance(raw, list):
        return []
    return [item.strip() for item in raw if isinstance(item, str) and item.strip()]


def profile_mode(value: Any, default: int | None = None) -> int | None:
    if value is None:
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        try:
            return int(text, 8 if text.startswith("0") else 10)
        except ValueError:
            return default
    return default


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def writefail_dirs() -> list[Path]:
    candidates: list[Path] = []
    override = os.environ.get("BOT_ERRORS_WRITEFAIL_DIR")
    if override:
        candidates.append(Path(override))
    candidates.append(state_root() / "writefail")
    candidates.append(Path.home() / ".bot-errors-writefail")
    candidates.append(Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail")
    deduped: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            deduped.append(path)
    return deduped


def redact(value: Any) -> str:
    text = str(value)
    text = SECRETISH_ASSIGNMENT.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}[REDACTED]", text)
    text = BEARER_VALUE.sub("Bearer [REDACTED]", text)
    return PHONE_LIKE.sub(
        lambda m: f"{m.group(1)}[REDACTED PHONE]"
        if 10 <= len(re.sub(r"\D", "", m.group(2))) <= 15
        else m.group(0),
        text,
    )


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def safe_child_path(directory: Path, name: str) -> Path:
    ensure_private_dir(directory)
    first = directory / name
    stem = name[:140].rstrip("._:-") or "unknown"
    prefix = f"{int(time.time())}.{os.getpid()}"
    candidates = [first, *[directory / f"{prefix}.{index}.{stem}" for index in range(1000)]]
    for target in candidates:
        try:
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            continue
        else:
            os.close(fd)
            try:
                target.unlink()
            except OSError:
                pass
            return target
    raise FileExistsError(f"no available child path in {directory}: {name}")


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
        try:
            dir_fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
        except OSError:
            dir_fd = None
        if dir_fd is not None:
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def record_writefail(event: dict[str, Any], exc: BaseException, target: Path) -> Path | None:
    reason = f"{type(exc).__name__}: {exc}"
    event_id = event.get("id")
    instance = event.get("instance")
    try:
        sys.stderr.write(
            f"[bot-errors-health] CRITICAL outbox write FAILED for {target}: {redact(reason)}; "
            f"id={event_id} instance={instance} source={event.get('source')} "
            f"severity={event.get('severity')} - recording breadcrumb\n"
        )
        sys.stderr.flush()
    except Exception:
        pass

    breadcrumb = {
        "schemaVersion": 1,
        "kind": "outbox_write_failure",
        "recordedAt": now_iso(),
        "failedTarget": str(target),
        "reason": redact(reason),
        "emitPid": os.getpid(),
        "event": event,
    }
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.{safe_segment(str(instance))}.{safe_segment(str(event_id))}.writefail"
    for base in writefail_dirs():
        try:
            path = safe_child_path(base, name)
            atomic_write_json(path, breadcrumb)
            try:
                sys.stderr.write(f"[bot-errors-health] lost-alert breadcrumb written: {path}\n")
                sys.stderr.flush()
            except Exception:
                pass
            return path
        except Exception:
            continue
    try:
        sys.stderr.write(
            "[bot-errors-health] breadcrumb write failed in ALL fallback dirs; "
            f"lost-event payload follows:\n{json.dumps(event, sort_keys=True)}\n"
        )
        sys.stderr.flush()
    except Exception:
        pass
    return None


def append_deadman_log(payload: dict[str, Any]) -> None:
    logs = state_root() / "logs"
    ensure_private_dir(logs)
    path = logs / "deadman.jsonl"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"time": now_iso(), "pid": os.getpid(), **payload}, sort_keys=True) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def outbox_event(summary: str, evidence: str, severity: str = "critical", source: str = "daily-health") -> Path:
    root = state_root()
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))
    event_id = f"health-{int(time.time())}-{os.getpid()}"
    event = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": severity,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": HOST_PLATFORM,
        "instance": "bot-errors-health",
        "source": source,
        "summary": summary,
        "evidence": evidence,
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": {
            "logHints": [
                health_log_hint(),
                dispatcher_log_hint(),
            ],
            "queue": str(outbox),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = outbox / f"{event['createdAt'].replace(':', '').replace('-', '')}.{event_id}.json"
    try:
        ensure_private_dir(root)
        ensure_private_dir(outbox)
        atomic_write_json(path, event)
    except Exception as exc:
        record_writefail(event, exc, outbox)
        raise
    return path


def health_log_hint() -> str:
    if HOST_PLATFORM == "darwin" or is_wsl():
        return str(state_root() / "logs/health.out.log")
    return "journalctl --user -u bot-errors-health-check.service --since '30 minutes ago'"


def dispatcher_log_hint() -> str:
    if HOST_PLATFORM == "darwin" or is_wsl():
        return str(state_root() / "logs/dispatcher.out.log")
    return "journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'"


def wait_for_response(reader: Any, expected_id: int, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = reader.readline()
        if not line:
            raise RuntimeError("socket closed before response")
        msg = json.loads(line)
        if msg.get("id") != expected_id:
            continue
        if "error" in msg:
            raise RuntimeError(f"rpc error: {msg['error']}")
        result = msg.get("result", {})
        return result if isinstance(result, dict) else {"result": result}
    raise RuntimeError("timeout waiting for JSON-RPC response")


def json_rpc(socket_path: str, method: str, params: dict[str, Any] | None = None, timeout: float = 12.0) -> dict[str, Any]:
    if not os.path.exists(socket_path):
        raise RuntimeError(f"socket missing: {socket_path}")
    init_id = int(time.time() * 1000)
    call_id = init_id + 1
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(socket_path)
        reader = sock.makefile("r", encoding="utf-8", newline="\n")
        writer = sock.makefile("w", encoding="utf-8", newline="\n")
        writer.write(json.dumps({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "bot-errors-health-check", "version": "1.0.0"},
            },
        }) + "\n")
        writer.flush()
        wait_for_response(reader, init_id, timeout)
        writer.write(json.dumps({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params or {}}) + "\n")
        writer.flush()
        return wait_for_response(reader, call_id, timeout)


def send_direct(text: str) -> None:
    if not BOT_ERRORS_JID:
        raise RuntimeError("BOT_ERRORS_JID is required for direct WhatsApp health notification")
    if not SOCKET_PATH:
        raise RuntimeError("BOT_ERRORS_SOCKET_PATH is required for direct WhatsApp health notification")
    result = json_rpc(SOCKET_PATH, "tools/call", {
        "name": "send_message",
        "arguments": {"chatJid": BOT_ERRORS_JID, "text": text},
    })
    if result.get("isError") is True:
        raise RuntimeError(f"send_message returned error: {result}")


def email_fallback(subject: str, body: str) -> bool:
    fallback = Path(EMAIL_FALLBACK)
    if not fallback.exists() or not os.access(fallback, os.X_OK):
        return False
    proc = subprocess.run(
        [str(fallback), "--subject", subject, "--body", body],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=20,
        check=False,
    )
    return proc.returncode == 0


def systemctl_is_active(unit: str) -> str:
    dry_status = os.environ.get("BOT_ERRORS_DRY_SERVICE_STATUS")
    if dry_status is not None:
        return dry_status
    try:
        proc = subprocess.run(
            ["systemctl", "--user", "is-active", unit],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return "unavailable:systemctl"
    return proc.stdout.strip() or f"rc={proc.returncode}"


def launchctl_print(label: str) -> str:
    try:
        proc = subprocess.run(
            ["launchctl", "print", f"gui/{os.getuid()}/{label}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return ""
    return proc.stdout if proc.returncode == 0 else ""


def launchctl_status(label: str) -> str:
    output = launchctl_print(label)
    if not output:
        return "inactive"
    if "state = running" in output or "\tpid = " in output or "\n\tpid = " in output:
        return "active"
    return "loaded"


def launchctl_pid(label: str) -> int | None:
    output = launchctl_print(label)
    if not output:
        return None
    import re

    match = re.search(r"\bpid = (\d+)", output)
    if not match:
        return None
    return int(match.group(1))


def process_uptime_seconds(pid: int) -> int | None:
    try:
        proc = subprocess.run(
            ["ps", "-o", "etimes=", "-p", str(pid)],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    try:
        return int(proc.stdout.strip())
    except ValueError:
        return None


def service_is_active(unit: str) -> str:
    if HOST_PLATFORM == "darwin" or not unit.endswith(".service"):
        dry_status = os.environ.get("BOT_ERRORS_DRY_SERVICE_STATUS")
        if dry_status is not None:
            return dry_status
        return launchctl_status(unit)
    return systemctl_is_active(unit)


def systemctl_show_properties(unit: str, properties: list[str]) -> dict[str, str]:
    try:
        proc = subprocess.run(
            ["systemctl", "--user", "show", *[f"--property={prop}" for prop in properties], unit],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return {}
    values: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        key, _, value = line.partition("=")
        if key:
            values[key] = value
    return values


def monotonic_usec_age_seconds(value: str | None) -> int | None:
    if not value:
        return None
    try:
        timestamp = int(value)
    except ValueError:
        return None
    if timestamp <= 0:
        return None
    age = time.monotonic() - (timestamp / 1_000_000)
    return max(0, int(age))


def service_restart_ages(unit: str) -> tuple[int | None, int | None]:
    dry_uptime = os.environ.get("BOT_ERRORS_DRY_SERVICE_UPTIME_SECONDS")
    dry_change_age = os.environ.get("BOT_ERRORS_DRY_SERVICE_STATE_CHANGE_AGE_SECONDS")
    if dry_uptime is not None or dry_change_age is not None:
        uptime = int(dry_uptime) if dry_uptime is not None else None
        change_age = int(dry_change_age) if dry_change_age is not None else None
        return uptime, change_age
    if HOST_PLATFORM == "darwin" or not unit.endswith(".service"):
        pid = launchctl_pid(unit)
        return (process_uptime_seconds(pid) if pid is not None else None), None
    props = systemctl_show_properties(unit, [
        "ActiveEnterTimestampMonotonic",
        "StateChangeTimestampMonotonic",
    ])
    return (
        monotonic_usec_age_seconds(props.get("ActiveEnterTimestampMonotonic")),
        monotonic_usec_age_seconds(props.get("StateChangeTimestampMonotonic")),
    )


def service_enabled(unit: str) -> str:
    if HOST_PLATFORM == "darwin" or not unit.endswith(".service"):
        plist = Path.home() / "Library/LaunchAgents" / f"{unit}.plist"
        return f"launchd_plist_exists={plist.exists()} path={plist}"
    try:
        proc = subprocess.run(
            ["systemctl", "--user", "is-enabled", unit],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except FileNotFoundError:
        return "unavailable:systemctl"
    except subprocess.TimeoutExpired:
        return "timeout:systemctl is-enabled"
    return proc.stdout.strip() or f"rc={proc.returncode}"


def dry_disk_usage() -> tuple[int, int] | None:
    free = os.environ.get("BOT_ERRORS_DRY_DISK_FREE_BYTES")
    total = os.environ.get("BOT_ERRORS_DRY_DISK_TOTAL_BYTES")
    if free is None and total is None:
        return None
    free_bytes = int(free or "0")
    total_bytes = int(total or str(max(free_bytes, 1)))
    return free_bytes, total_bytes


def disk_inventory() -> list[str]:
    root = state_root()
    paths = [
        root,
        Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox")),
        root / "processing",
        root / "relay-processing",
        root / "logs",
        Path(os.environ.get("TMPDIR", "/tmp")),
    ]
    critical_free = int(os.environ.get("BOT_ERRORS_DISK_CRITICAL_FREE_MB", "512")) * 1024 * 1024
    warning_free = int(os.environ.get("BOT_ERRORS_DISK_WARNING_FREE_MB", "2048")) * 1024 * 1024
    critical_pct = float(os.environ.get("BOT_ERRORS_DISK_CRITICAL_FREE_PCT", "2"))
    warning_pct = float(os.environ.get("BOT_ERRORS_DISK_WARNING_FREE_PCT", "5"))
    dry = dry_disk_usage()
    lines: list[str] = []
    seen: set[str] = set()
    for original in paths:
        key = str(original)
        if key in seen:
            continue
        seen.add(key)
        probe = original
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        try:
            if dry is None:
                usage = shutil.disk_usage(probe)
                free_bytes = usage.free
                total_bytes = usage.total
            else:
                free_bytes, total_bytes = dry
        except Exception as exc:  # noqa: BLE001 - report but keep the daily check alive.
            lines.append(f"WARN disk {original}: probe_failed {exc}")
            continue
        pct_free = (free_bytes / total_bytes * 100) if total_bytes > 0 else 0.0
        prefix = ""
        if free_bytes < critical_free or pct_free < critical_pct:
            prefix = "FAIL "
        elif free_bytes < warning_free or pct_free < warning_pct:
            prefix = "WARN "
        lines.append(
            f"{prefix}disk {original}: probe_path={probe} free_bytes={free_bytes} "
            f"total_bytes={total_bytes} pct_free={pct_free:.2f} "
            f"critical_free_bytes={critical_free} warning_free_bytes={warning_free}"
        )
    return lines


def parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def clock_inventory() -> list[str]:
    dry_status = os.environ.get("BOT_ERRORS_DRY_CLOCK_STATUS")
    dry_offset_ms = parse_float(os.environ.get("BOT_ERRORS_DRY_CLOCK_OFFSET_MS"))
    critical_offset_ms = float(os.environ.get("BOT_ERRORS_CLOCK_CRITICAL_OFFSET_MS", "300000"))
    warning_offset_ms = float(os.environ.get("BOT_ERRORS_CLOCK_WARNING_OFFSET_MS", "60000"))
    if dry_status is not None:
        prefix = ""
        if dry_status.lower() in {"skewed", "unsynced", "false", "off"}:
            prefix = "WARN "
        if dry_offset_ms is not None and abs(dry_offset_ms) >= critical_offset_ms:
            prefix = "FAIL "
        elif dry_offset_ms is not None and abs(dry_offset_ms) >= warning_offset_ms and not prefix:
            prefix = "WARN "
        return [f"{prefix}clock: status={dry_status} offset_ms={dry_offset_ms if dry_offset_ms is not None else 'unknown'}"]

    if HOST_PLATFORM == "darwin":
        lines: list[str] = []
        try:
            proc = subprocess.run(
                ["systemsetup", "-getusingnetworktime"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=3,
                check=False,
            )
            status = proc.stdout.strip() or f"rc={proc.returncode}"
            prefix = "WARN " if "Off" in status else ""
            lines.append(f"{prefix}clock_network_time: {status}")
        except Exception as exc:  # noqa: BLE001
            lines.append(f"WARN clock_network_time: unavailable {exc}")
        try:
            proc = subprocess.run(
                ["sntp", "-sS", "time.apple.com"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=5,
                check=False,
            )
            output = " ".join((proc.stdout + " " + proc.stderr).split())
            match = re.search(r"([+-]?\d+(?:\.\d+)?)\s*(?:\+/-|seconds|sec|s)", output)
            offset_ms = float(match.group(1)) * 1000 if match else None
            prefix = ""
            if offset_ms is not None and abs(offset_ms) >= critical_offset_ms:
                prefix = "FAIL "
            elif offset_ms is not None and abs(offset_ms) >= warning_offset_ms:
                prefix = "WARN "
            lines.append(f"{prefix}clock_sntp: rc={proc.returncode} offset_ms={offset_ms if offset_ms is not None else 'unknown'} sample={output[:240]}")
        except Exception as exc:  # noqa: BLE001
            lines.append(f"WARN clock_sntp: unavailable {exc}")
        return lines

    try:
        proc = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "-p", "TimeUSec", "-p", "RTCTimeUSec"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except FileNotFoundError:
        return ["WARN clock: unavailable timedatectl"]
    except subprocess.TimeoutExpired:
        return ["WARN clock: timedatectl timeout"]
    values: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        key, _, value = line.partition("=")
        values[key] = value
    synced = values.get("NTPSynchronized", "unknown")
    prefix = "" if synced.lower() == "yes" else "WARN "
    return [f"{prefix}clock: NTPSynchronized={synced} TimeUSec={values.get('TimeUSec', 'unknown')} RTCTimeUSec={values.get('RTCTimeUSec', 'unknown')}"]


def boot_inventory() -> list[str]:
    dry_uptime = os.environ.get("BOT_ERRORS_DRY_UPTIME_SECONDS")
    if dry_uptime is not None:
        return [f"boot: uptime_seconds={int(dry_uptime)}"]
    if HOST_PLATFORM == "darwin":
        try:
            proc = subprocess.run(
                ["sysctl", "-n", "kern.boottime"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=3,
                check=False,
            )
            match = re.search(r"sec = (\d+)", proc.stdout)
            if match:
                boot_epoch = int(match.group(1))
                return [f"boot: boot_epoch={boot_epoch} uptime_seconds={int(time.time() - boot_epoch)}"]
            return [f"WARN boot: cannot_parse {proc.stdout.strip()[:160]}"]
        except Exception as exc:  # noqa: BLE001
            return [f"WARN boot: unavailable {exc}"]
    try:
        uptime = float(Path("/proc/uptime").read_text(encoding="utf-8").split()[0])
        return [f"boot: uptime_seconds={int(uptime)}"]
    except Exception as exc:  # noqa: BLE001
        return [f"WARN boot: unavailable {exc}"]


def probe_health(port: int) -> str:
    url = f"http://127.0.0.1:{port}/health"
    req = Request(url, method="GET")
    try:
        with urlopen(req, timeout=3) as response:
            return f"{response.status} {url}"
    except URLError as exc:
        return f"FAIL {url} {exc.reason}"
    except Exception as exc:
        return f"FAIL {url} {exc}"


def read_instance_config(cfg: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        return json.loads(cfg.read_text(encoding="utf-8")), None
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)


def file_readable(path: Path, mode: int) -> bool:
    return os.access(path, os.R_OK) and bool(mode & 0o444)


def required_file_path(base: Path, requirement: str) -> Path:
    expanded = Path(os.path.expandvars(os.path.expanduser(requirement)))
    if expanded.is_absolute():
        return expanded
    return base / expanded


def credential_requirement_paths(root: Path, requirement: str) -> tuple[list[Path], str]:
    if requirement in ROOT_CREDENTIAL_FILES:
        path = root / requirement
        return ([path] if path.exists() else []), str(path)
    if "/" in requirement or requirement.startswith("~"):
        path = required_file_path(root, requirement)
        return ([path] if path.exists() else []), str(path)
    if not root.exists():
        return [], str(root / requirement)
    matches = sorted(path for path in root.rglob(requirement) if path.is_file())
    return matches, str(root / "**" / requirement)


def required_credential_inventory(profile: dict[str, Any]) -> list[str]:
    requirements = profile_string_list(profile, "requiredCredentialFiles")
    if not requirements:
        return ["required_credentials: none declared"]
    root = Path.home() / ".config/whatsoup"
    lines: list[str] = []
    for requirement in requirements:
        paths, expected = credential_requirement_paths(root, requirement)
        if not paths:
            lines.append(f"FAIL credential {requirement}: missing required {requirement} expected_path={expected}")
            continue
        for path in paths:
            try:
                st = path.stat()
            except OSError as exc:
                lines.append(f"FAIL credential {requirement}: stat_failed path={path} error={exc}")
                continue
            mode = stat.S_IMODE(st.st_mode)
            age_days = int((time.time() - st.st_mtime) / 86400)
            if not file_readable(path, mode):
                lines.append(f"FAIL credential {requirement}: unreadable path={path} mode={mode:o} age_days={age_days}")
            elif mode & 0o022:
                lines.append(f"FAIL credential {requirement}: world_writable path={path} mode={mode:o} age_days={age_days}")
            elif mode > 0o600:
                lines.append(f"WARN credential {requirement}: mode>{0o600:o} path={path} mode={mode:o} age_days={age_days}")
            else:
                lines.append(f"OK credential {requirement}: path={path} mode={mode:o} age_days={age_days}")
    return lines


def required_credential_existing_paths(profile: dict[str, Any]) -> set[Path]:
    root = Path.home() / ".config/whatsoup"
    paths: set[Path] = set()
    for requirement in profile_string_list(profile, "requiredCredentialFiles"):
        matches, _ = credential_requirement_paths(root, requirement)
        paths.update(path.resolve() for path in matches)
    return paths


def config_mode_line(name: str, requirement: str, path: Path, mode: int, strict_max: int | None) -> str | None:
    if strict_max is not None and mode > strict_max:
        return f"FAIL config {name}: mode>{strict_max:o} required {requirement} path={path} mode={mode:o}"
    if mode & 0o004:
        return f"WARN config {name}: world_readable required {requirement} path={path} mode={mode:o}"
    return None


def required_config_files(profile: dict[str, Any], item: dict[str, Any]) -> list[str]:
    instance_reqs = profile_string_list(item, "requiredConfigFiles")
    if instance_reqs:
        return instance_reqs
    profile_reqs = profile_string_list(profile, "requiredConfigFiles")
    return profile_reqs if profile_reqs else ["config.json"]


def config_inventory(profile: dict[str, Any]) -> list[str]:
    if not profile_bool(profile, "expectConfigInventory", True):
        return ["configs: skipped by health profile"]
    root = Path.home() / ".config/whatsoup/instances"
    lines: list[str] = []
    if not root.exists():
        return [f"configs: missing {root}"]
    expected_instances = profile_instances(profile)
    if expected_instances:
        for item in expected_instances:
            name = str(item.get("name") or "").strip()
            if not name:
                lines.append("WARN config profile: instance without name")
                continue
            expectation = str(item.get("expected") or "always_on")
            reason = str(item.get("reason") or "")
            cfg = root / name / "config.json"
            if expectation in {"none", "no_bot"}:
                lines.append(f"config {name}: expected={expectation} reason={reason or 'profile'}")
                continue
            if expectation == "blocked":
                exists = cfg.exists()
                service = item.get("service")
                service_name = str(service) if service else ""
                status = service_is_active(service_name) if service_name else "not_configured"
                line = (
                    f"config {name}: expected=blocked exists={exists} "
                    f"service_status={status} reason={reason or 'operator approval required'}"
                )
                if service_name:
                    line += f" service={service_name}"
                if status == "active":
                    line = f"WARN {line} actual=active"
                lines.append(line)
                continue
            strict_max = profile_mode(item.get("requiredConfigMaxMode"), profile_mode(profile.get("requiredConfigMaxMode")))
            required_configs = required_config_files(profile, item)
            for requirement in required_configs:
                required_path = required_file_path(root / name, requirement)
                if not required_path.exists():
                    lines.append(f"FAIL config {name}: missing required {requirement} expected_path={required_path}")
                    continue
                required_mode = stat.S_IMODE(required_path.stat().st_mode)
                mode_line = config_mode_line(name, requirement, required_path, required_mode, strict_max)
                if mode_line:
                    lines.append(mode_line)
                if required_path != cfg and required_path.suffix == ".json":
                    _, required_error = read_instance_config(required_path)
                    if required_error:
                        lines.append(f"config {name}: invalid JSON required {requirement}: {required_error}")
            if not cfg.exists():
                if "config.json" not in required_configs:
                    lines.append(f"FAIL config {name}: missing {cfg} expected={expectation}")
                continue
            mode = stat.S_IMODE(cfg.stat().st_mode)
            data, error = read_instance_config(cfg)
            if error or data is None:
                lines.append(f"config {cfg}: invalid JSON: {error}")
                continue
            kind = data.get("type", "unknown")
            enabled = data.get("enabled", True)
            port = item.get("healthPort", data.get("healthPort"))
            socket_path = item.get("socketPath", data.get("socketPath"))
            service = item.get("service")
            lines.append(
                f"config {name}: expected={expectation} type={kind} enabled={enabled} "
                f"mode={mode:o} healthPort={port}"
            )
            if service:
                service_name = str(service)
                lines.append(f"service {name}: {service_is_active(service_name)} ({service_name})")
                lines.append(f"service_enabled {name}: {service_enabled(service_name)}")
            if isinstance(port, int):
                probe = probe_health(port)
                if expectation == "on_demand":
                    lines.append(f"health {name}: on_demand_ok {probe.replace('FAIL ', 'down ')}")
                else:
                    lines.append(f"health {name}: {probe}")
            if isinstance(socket_path, str) and socket_path:
                exists = Path(socket_path).exists()
                prefix = "FAIL " if expectation == "always_on" and not exists else ""
                lines.append(f"{prefix}socket {name}: {socket_path} exists={exists}")
        return lines
    ports: dict[int, str] = {}
    strict_max = profile_mode(profile.get("requiredConfigMaxMode"))
    for cfg in sorted(root.glob("*/config.json")):
        mode = stat.S_IMODE(cfg.stat().st_mode)
        data, error = read_instance_config(cfg)
        if error or data is None:
            lines.append(f"config {cfg}: invalid JSON: {error}")
            continue
        name = cfg.parent.name
        enabled = data.get("enabled", True)
        kind = data.get("type", "unknown")
        port = data.get("healthPort")
        socket_path = data.get("socketPath")
        lines.append(f"config {name}: type={kind} enabled={enabled} mode={mode:o} healthPort={port}")
        mode_line = config_mode_line(name, "config.json", cfg, mode, strict_max)
        if mode_line:
            lines.append(mode_line)
        if isinstance(port, int):
            if port in ports:
                lines.append(f"duplicate healthPort {port}: {ports[port]} and {name}")
            ports[port] = name
            lines.append(f"health {name}: {probe_health(port)}")
        if isinstance(socket_path, str) and socket_path:
            exists = Path(socket_path).exists()
            lines.append(f"socket {name}: {socket_path} exists={exists}")
    return lines


def credential_metadata(profile: dict[str, Any]) -> list[str]:
    root = Path.home() / ".config/whatsoup"
    lines: list[str] = []
    if not root.exists():
        return [f"credentials: missing {root}"]
    required_paths = required_credential_existing_paths(profile)
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.name not in {"tokens.env", "fleet-token", "fleet.env", "fleet-tokens.json", "secrets.env"}:
            continue
        if path.resolve() in required_paths:
            continue
        st = path.stat()
        mode = stat.S_IMODE(st.st_mode)
        age_days = int((time.time() - st.st_mtime) / 86400)
        status = "FAIL" if mode & 0o022 else "OK" if mode <= 0o600 else "WARN"
        lines.append(f"{status} credential_meta {path}: mode={mode:o} age_days={age_days}")
    return lines


def read_json_record(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, str(exc)
    if not isinstance(loaded, dict):
        return None, "JSON root is not an object"
    return loaded, None


def bool_map(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items() if isinstance(item, bool)}


def plugin_inventory(profile: dict[str, Any]) -> list[str]:
    if not profile_bool(profile, "expectPluginInventory", profile_bool(profile, "expectConfigInventory", True)):
        return ["plugins: skipped by health profile"]
    root = Path.home() / ".config/whatsoup/instances"
    settings_path = Path.home() / ".claude/settings.json"
    lines: list[str] = []
    if not root.exists():
        return [f"FAIL plugins: missing instance root {root}"]
    user_scope: dict[str, bool] = {}
    if settings_path.exists():
        settings, error = read_json_record(settings_path)
        if error:
            lines.append(f"FAIL plugins settings: invalid JSON {settings_path}: {error}")
        else:
            user_scope = bool_map(settings.get("enabledPlugins") if settings else {})
            lines.append(f"plugins settings: {settings_path} user_scope_keys={len(user_scope)}")
    else:
        lines.append(f"plugins settings: missing {settings_path} user_scope_keys=0")

    config_paths: list[Path] = []
    expected_instances = profile_instances(profile)
    if expected_instances:
        for item in expected_instances:
            name = item.get("name")
            if not isinstance(name, str) or not name:
                continue
            expectation = str(item.get("expected") or "always_on")
            if expectation in {"blocked", "none", "no_bot"}:
                lines.append(f"plugins {name}: skipped expected={expectation}")
                continue
            config_paths.append(root / name / "config.json")
    else:
        config_paths = sorted(root.glob("*/config.json"))

    if not config_paths:
        lines.append("plugins: no instance configs to audit")
        return lines

    user_keys = sorted(user_scope)
    for cfg in config_paths:
        name = cfg.parent.name
        if not cfg.exists():
            lines.append(f"FAIL plugins {name}: missing config {cfg}")
            continue
        data, error = read_json_record(cfg)
        if error or data is None:
            lines.append(f"FAIL plugins {name}: invalid config {cfg}: {error}")
            continue
        kind = str(data.get("type") or "unknown")
        if kind != "agent":
            lines.append(f"plugins {name}: skipped type={kind}")
            continue
        agent_options = data.get("agentOptions") if isinstance(data.get("agentOptions"), dict) else {}
        raw_enabled_plugins = agent_options.get("enabledPlugins") if isinstance(agent_options, dict) else None
        if raw_enabled_plugins is not None and not isinstance(raw_enabled_plugins, dict):
            lines.append(f"FAIL plugin_coverage {name}: enabledPlugins must be an object or null")
            instance_plugins = {}
            inherits_all = False
        else:
            instance_plugins = bool_map(raw_enabled_plugins)
            inherits_all = raw_enabled_plugins is None or len(instance_plugins) == 0
        missing_enabled = [key for key in user_keys if key not in instance_plugins and user_scope[key]]
        missing_disabled = [key for key in user_keys if key not in instance_plugins and not user_scope[key]]
        plugin_dirs = agent_options.get("pluginDirs") if isinstance(agent_options, dict) else None
        if isinstance(plugin_dirs, list):
            for index, entry in enumerate(plugin_dirs):
                if not isinstance(entry, str) or not entry.strip():
                    lines.append(f"FAIL plugin_dir {name}[{index}]: invalid entry")
                    continue
                expanded = Path(os.path.expandvars(os.path.expanduser(entry)))
                status = "OK" if expanded.is_dir() else "FAIL"
                lines.append(f"{status} plugin_dir {name}[{index}]: {expanded} exists={expanded.is_dir()}")
        elif plugin_dirs is not None:
            lines.append(f"FAIL plugin_dir {name}: pluginDirs must be a list")

        if inherits_all:
            lines.append(f"plugin_coverage {name}: inherits global user_scope_keys={len(user_keys)}")
        else:
            missing = len(missing_enabled) + len(missing_disabled)
        if not inherits_all and missing:
            lines.append(
                f"FAIL plugin_coverage {name}: missing={missing}/{len(user_keys)} "
                f"inherited_enabled={','.join(missing_enabled) if missing_enabled else 'none'} "
                f"inherited_disabled={','.join(missing_disabled) if missing_disabled else 'none'}"
            )
        elif not inherits_all:
            lines.append(f"plugin_coverage {name}: ok instance_keys={len(instance_plugins)} user_scope_keys={len(user_keys)}")
    return lines


def tool_inventory(profile: dict[str, Any]) -> tuple[list[str], list[str]]:
    if not profile_bool(profile, "expectPersonalTools", True):
        return ["tools personal: skipped by health profile"], []
    try:
        dry_names = os.environ.get("BOT_ERRORS_DRY_TOOL_NAMES")
        if dry_names is None:
            if not SOCKET_PATH:
                raise RuntimeError("BOT_ERRORS_SOCKET_PATH is not configured")
            result = json_rpc(SOCKET_PATH, "tools/list", {})
            tools = result.get("tools", [])
            names = sorted(t.get("name") for t in tools if isinstance(t, dict) and isinstance(t.get("name"), str))
        else:
            names = sorted(name.strip() for name in dry_names.split(",") if name.strip())
        missing = [name for name in REQUIRED_TOOLS if name and name not in names]
        prefix = "FAIL " if missing else ""
        return [
            f"{prefix}tools personal: count={len(names)} required_missing={','.join(missing) if missing else 'none'}",
            f"tools personal required_present={','.join(name for name in REQUIRED_TOOLS if name in names)}",
        ], missing
    except Exception as exc:
        return [f"tools personal: FAIL {exc}"], REQUIRED_TOOLS


def queue_inventory() -> list[str]:
    root = state_root()
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))
    state = root / "dispatcher-state.json"
    lines: list[str] = []
    if state.exists():
        age = int(time.time() - state.stat().st_mtime)
        lines.append(f"dispatcher_state: {state} age_seconds={age}")
    else:
        lines.append(f"dispatcher_state: missing {state}")
    if outbox.exists():
        files = list(outbox.glob("*.json"))
        oldest = int(time.time() - min((p.stat().st_mtime for p in files), default=time.time()))
        lines.append(f"outbox: count={len(files)} oldest_seconds={oldest}")
    else:
        lines.append(f"outbox: missing {outbox}")
    return lines


def daily() -> int:
    profile = load_health_profile()
    tool_lines, missing_required_tools = tool_inventory(profile)
    dispatcher_line = (
        f"dispatcher_service: {service_is_active(DISPATCHER_SERVICE)} ({DISPATCHER_SERVICE})"
        if profile_bool(profile, "expectDispatcher", True)
        else f"dispatcher_service: skipped by health profile ({DISPATCHER_SERVICE})"
    )
    q_loop_line = (
        f"q_loop_service: {service_is_active(Q_LOOP_SERVICE)} ({Q_LOOP_SERVICE})"
        if profile_bool(profile, "expectQLoop", True)
        else f"q_loop_service: skipped by health profile ({Q_LOOP_SERVICE})"
    )
    socket_label = SOCKET_PATH or "<unset>"
    socket_exists = bool(SOCKET_PATH) and Path(SOCKET_PATH).exists()
    if profile_bool(profile, "expectPersonalSocket", True):
        personal_socket_line = f"{'FAIL ' if not socket_exists else ''}personal_socket: {socket_label} exists={socket_exists}"
    else:
        personal_socket_line = f"personal_socket: skipped by health profile {socket_label} exists={socket_exists}"
    lines = [
        f"machine: {socket.gethostname()}",
        f"profile: role={profile.get('role', 'unknown')} path={os.environ.get('BOT_ERRORS_HEALTH_PROFILE', 'default')}",
        *([f"FAIL profile: {profile['profileLoadError']}"] if profile.get("profileLoadError") else []),
        dispatcher_line,
        f"dispatcher_enabled: {service_enabled(DISPATCHER_SERVICE)}",
        q_loop_line,
        f"q_loop_enabled: {service_enabled(Q_LOOP_SERVICE)}",
        personal_socket_line,
        *boot_inventory(),
        *queue_inventory(),
        *config_inventory(profile),
        *plugin_inventory(profile),
        *required_credential_inventory(profile),
        *credential_metadata(profile),
        *disk_inventory(),
        *clock_inventory(),
        *tool_lines,
    ]
    if missing_required_tools:
        lines.insert(0, f"FAIL required_tools: required_missing={','.join(missing_required_tools)}")
    failures = [
        line for line in lines
        if line.startswith("FAIL ") or " FAIL " in line or line.startswith("config ") and "invalid JSON" in line
    ]
    if missing_required_tools:
        failures.append(f"required tools missing: {','.join(missing_required_tools)}")
    warnings = [line for line in lines if line.startswith("WARN ")]
    severity = "critical" if failures else "warning" if warnings else "info"
    if missing_required_tools:
        summary = f"BOT ERRORS daily health found issues: missing required tools {','.join(missing_required_tools)}"
    else:
        summary = "BOT ERRORS daily health found issues" if severity != "info" else "BOT ERRORS daily health passed"
    path = outbox_event(summary, "\n".join(lines), severity=severity, source="daily-health")
    print(path)
    return 0


def deadman(max_state_age: int, restart_grace: int) -> int:
    root = state_root()
    state = root / "dispatcher-state.json"
    problems: list[str] = []
    state_age = None
    if state.exists():
        state_age = int(time.time() - state.stat().st_mtime)
    service_status = service_is_active(DISPATCHER_SERVICE)
    service_uptime, service_state_change_age = service_restart_ages(DISPATCHER_SERVICE)
    grace_reason = None
    if service_status != "active":
        if service_state_change_age is not None and service_state_change_age <= restart_grace:
            grace_reason = f"service_state_change_age_seconds={service_state_change_age}"
        else:
            problems.append(f"{DISPATCHER_SERVICE} is not active (status={service_status})")
    elif service_uptime is not None and service_uptime <= restart_grace:
        grace_reason = f"service_uptime_seconds={service_uptime}"
    if not state.exists():
        if not grace_reason:
            problems.append(f"dispatcher state missing: {state}")
    elif state_age is not None and state_age > max_state_age:
        if not grace_reason:
            problems.append(f"dispatcher state stale: age_seconds={state_age}")
    if not SOCKET_PATH or not Path(SOCKET_PATH).exists():
        problems.append(f"personal socket missing: {SOCKET_PATH or '<unset>'}")

    if not problems:
        if grace_reason:
            state_detail = state_age if state_age is not None else "missing"
            print(f"deadman grace ok: service={service_status} {grace_reason} dispatcher_state_age_seconds={state_detail}")
        else:
            print("deadman ok")
        return 0

    text = "\n".join([
        "BOT ERRORS DEADMAN - dispatcher supervision failed",
        f"  > machine: {socket.gethostname()}",
        f"  > created: {now_iso()}",
        *[f"  > problem: {problem}" for problem in problems],
        f"  > logs: {dispatcher_log_hint()}",
        f"  > deadman_log: {state_root() / 'logs/deadman.jsonl'}",
        "  > notifier: direct_whatsapp primary; email_fallback=resend when direct WhatsApp/socket fails",
        "  > requested_action: Q investigate dispatcher, queue, personal line, and email fallback.",
    ])
    outcome = {
        "type": "deadman",
        "problems": problems,
        "direct_whatsapp": "not_attempted",
        "email_fallback": "not_attempted",
        "email_channel": "resend",
    }
    try:
        send_direct(text)
        outcome["direct_whatsapp"] = "sent"
        print("notifier direct_whatsapp=sent")
    except Exception as exc:
        outcome["direct_whatsapp"] = "failed"
        outcome["direct_error"] = str(exc)
        print(f"notifier direct_whatsapp=failed error={exc}")
        ok = email_fallback("BOT ERRORS deadman failed", text)
        outcome["email_fallback"] = "sent" if ok else "failed"
        print(f"notifier email_fallback={'sent' if ok else 'failed'} channel=resend")
    append_deadman_log(outcome)
    print(text)
    return 2


def main() -> int:
    parser = argparse.ArgumentParser(description="BOT ERRORS health and deadman checks")
    parser.add_argument("--daily", action="store_true")
    parser.add_argument("--deadman", action="store_true")
    parser.add_argument("--max-state-age", type=int, default=180)
    parser.add_argument("--restart-grace", type=int, default=30)
    args = parser.parse_args()

    if args.daily:
        return daily()
    if args.deadman:
        return deadman(args.max_state_age, args.restart_grace)
    return daily()


if __name__ == "__main__":
    sys.exit(main())
