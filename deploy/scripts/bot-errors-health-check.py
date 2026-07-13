#!/usr/bin/env python3
"""BOT ERRORS deadman and daily capability/config health checks."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value


BOT_ERRORS_JID = os.environ.get("BOT_ERRORS_JID", "").strip()
BOT_ERRORS_EXPECTED_JID = os.environ.get("BOT_ERRORS_EXPECTED_JID", "").strip()
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
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HEALTH_PROFILE = {
    "role": "central",
    "expectDispatcher": True,
    "expectQLoop": True,
    "expectPersonalSocket": True,
    "expectPersonalTools": True,
    "expectConfigInventory": True,
    "expectRuntimeManifest": False,
}
ROOT_CREDENTIAL_FILES = {"bot-errors.env", "fleet-token", "fleet.env", "fleet-tokens.json", "secrets.env"}
# auth_bond_inventory TOCTOU-guard constants.
# The WhatsApp creds writer can produce a momentarily empty or invalid creds.json
# while mid-write. We re-inspect before declaring the auth bond broken.
AUTH_BOND_REINSPECT_ATTEMPTS: int = 3
AUTH_BOND_REINSPECT_DELAY_S: float = 1.0
AUTH_BOND_STUCK_MTIME_S: int = 60
GROUP_JID_RE = re.compile(r"^\d+@g\.us$")
PROVIDER_PROBE_FAILURE_RE = re.compile(
    r"(?m)^FAIL provider_probe\s+([^:\s]+):.*?\bfailure_class=([A-Za-z0-9_.:-]+)"
)
PRIMARY_PHONE_SIGNAL_RE = re.compile(
    r"(?m)^(?:FAIL|WARN|OK)\s+primary_phone(?:_state)?\s+([^:\s]+):"
)
RUNTIME_MANIFEST_FAILURE_RE = re.compile(r"^FAIL runtime_manifest(?:\s+([^:\s]+))?:")
SOURCE_UPDATE_ENFORCED_OK_RE = re.compile(
    r"(?m)^source_update:\s+git_remote reachable\b.*\bmode=enforce\b"
)
SERVICE_ENV_MAP = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "pinecone": "PINECONE_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
}
TERMINAL_AUTH_FAILURE_CLASSES = {"pairing_required", "serverside_logout_irreversible"}
LOGGED_OUT_STATUS_CODE = 401
LOGGED_OUT_REASON_KEY = "loggedout"


def normalized_signal_key(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not text:
        return None
    return re.sub(r"[^a-z0-9]", "", text)


def is_terminal_auth_failure_class(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() in TERMINAL_AUTH_FAILURE_CLASSES


def is_logged_out_status_code(value: Any) -> bool:
    if isinstance(value, int) and not isinstance(value, bool):
        return value == LOGGED_OUT_STATUS_CODE
    if isinstance(value, str) and re.fullmatch(r"\d+", value.strip()):
        return int(value.strip()) == LOGGED_OUT_STATUS_CODE
    return False


def is_logged_out_disconnect_reason(value: Any) -> bool:
    return normalized_signal_key(value) == LOGGED_OUT_REASON_KEY


def text_has_terminal_auth_failure_class(value: str) -> bool:
    lower = value.lower()
    return any(auth_class in lower for auth_class in TERMINAL_AUTH_FAILURE_CLASSES)


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


BOT_ERRORS_REQUIRE_EXPECTED = env_flag("BOT_ERRORS_REQUIRE_EXPECTED", True)


def positive_env_float(name: str, default: float) -> float:
    value = float(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be > 0")
    return value


def positive_env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = int(float(raw))
    if value <= 0:
        raise ValueError(f"{name} must be > 0")
    return value


HEALTH_PROBE_TIMEOUT_SECONDS = positive_env_float("BOT_ERRORS_HEALTH_PROBE_TIMEOUT_SECONDS", 10.0)
PRIMARY_PHONE_EXPIRY_DAYS = positive_env_int("BOT_ERRORS_PRIMARY_PHONE_EXPIRY_DAYS", 14)
PRIMARY_PHONE_WARN_DAYS = positive_env_int("BOT_ERRORS_PRIMARY_PHONE_WARN_DAYS", 10)
PRIMARY_PHONE_FAIL_DAYS = positive_env_int("BOT_ERRORS_PRIMARY_PHONE_FAIL_DAYS", 12)


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


def redact_event_text(value: str) -> str:
    return redact_bot_errors_text(
        value,
        credential_path_marker="[REDACTED_CREDENTIAL_PATH]",
        jid_marker="[REDACTED_JID]",
        phone_marker="[REDACTED_PHONE]",
        private_key_marker="[REDACTED_PRIVATE_KEY]",
        aws_marker="[REDACTED_AWS_ACCESS_KEY]",
        github_marker="[REDACTED_GITHUB_TOKEN]",
        jwt_marker="[REDACTED_JWT]",
    )


def redact_evidence_string(value: str, max_len: int = 160) -> str:
    redacted = redact_event_text(value.strip())
    redacted = re.sub(r"\s+", "_", redacted)
    return redacted[:max_len]


def redact_json_value(value: Any) -> Any:
    return redact_shared_json_value(value, redact_event_text)


def path_fingerprint(value: str | Path) -> str:
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


def credential_path_ref(path: str | Path, *, prefix: str = "credential_path") -> str:
    raw = str(path)
    name = Path(raw).name or "unknown"
    safe_name = redact_evidence_string(name, 80) or "unknown"
    return (
        f"{prefix}_redacted=true "
        f"{prefix}_basename={safe_name} "
        f"{prefix}_fingerprint={path_fingerprint(raw)}"
    )


def credential_requirement_ref(requirement: str) -> str:
    if "/" not in requirement and not requirement.startswith("~"):
        return f"credential_requirement={redact_evidence_string(requirement, 80)}"
    name = Path(requirement).name or "unknown"
    safe_name = redact_evidence_string(name, 80) or "unknown"
    return (
        "credential_requirement_redacted=true "
        f"credential_requirement_basename={safe_name} "
        f"credential_requirement_fingerprint={path_fingerprint(requirement)}"
    )


def append_evidence_field(details: list[str], key: str, value: Any, max_len: int = 160) -> None:
    if value is None:
        return
    if isinstance(value, bool):
        details.append(f"{key}={str(value).lower()}")
        return
    if isinstance(value, (int, float)):
        details.append(f"{key}={value}")
        return
    if isinstance(value, str):
        rendered = redact_evidence_string(value, max_len)
        if rendered:
            details.append(f"{key}={rendered}")


def current_epoch() -> int:
    raw = os.environ.get("BOT_ERRORS_DRY_NOW_EPOCH")
    if raw is not None:
        return int(float(raw))
    return int(time.time())


def service_env_var(service: str) -> str | None:
    return SERVICE_ENV_MAP.get(service.lower())


def state_root() -> Path:
    explicit = os.environ.get("BOT_ERRORS_STATE_DIR")
    if explicit and explicit.strip():
        return Path(explicit)
    test_state = test_state_root()
    return test_state or (Path.home() / ".local/state/bot-errors")


STRONG_TEST_SIGNAL_KEYS = ("VITEST", "VITEST_WORKER_ID", "JEST_WORKER_ID", "PYTEST_CURRENT_TEST")


def env_value(key: str) -> str | None:
    value = os.environ.get(key)
    return value.strip() if value and value.strip() else None


def strong_test_signals() -> list[str]:
    return [key for key in STRONG_TEST_SIGNAL_KEYS if env_value(key)]


def provenance_signals() -> list[str]:
    signals = strong_test_signals()
    if os.environ.get("NODE_ENV", "").strip().lower() == "test":
        signals.append("NODE_ENV")
    return sorted(set(signals))


def test_state_root() -> Path | None:
    if not strong_test_signals():
        return None
    cwd_hash = hashlib.sha256(os.getcwd().encode("utf-8")).hexdigest()[:12]
    worker = safe_segment(env_value("VITEST_WORKER_ID") or env_value("JEST_WORKER_ID") or f"pid-{os.getpid()}")
    return Path(os.environ.get("TMPDIR", "/tmp")) / "whatsoup-vitest-bot-errors" / f"{cwd_hash}.{worker}"


def canonical_path(path: Path) -> Path:
    try:
        return path.expanduser().resolve(strict=True)
    except OSError:
        try:
            return path.expanduser().parent.resolve(strict=True) / path.name
        except OSError:
            return path.expanduser().absolute()


def live_outbox_candidates() -> list[Path]:
    candidates = [Path.home() / ".local/state/bot-errors/outbox"]
    override = env_value("BOT_ERRORS_LIVE_OUTBOX_DIR")
    if override:
        candidates.append(Path(override))
    return [canonical_path(path) for path in candidates]


def test_live_outbox_allowed() -> bool:
    return os.environ.get("BOT_ERRORS_ALLOW_TEST_LIVE_OUTBOX", "").strip().lower() in {"1", "true", "yes", "on"}


def resolve_outbox_dir() -> tuple[Path, dict[str, Any]]:
    explicit_outbox = env_value("BOT_ERRORS_OUTBOX_DIR")
    explicit_state = env_value("BOT_ERRORS_STATE_DIR")
    test_state = test_state_root()
    policy = "default"
    outbox = Path.home() / ".local/state/bot-errors/outbox"
    if explicit_outbox:
        outbox = Path(explicit_outbox)
        policy = "explicit-outbox"
    elif explicit_state:
        outbox = Path(explicit_state) / "outbox"
        policy = "explicit-state"
    elif test_state:
        outbox = test_state / "outbox"
        policy = "test-default"
    original = outbox
    if strong_test_signals() and not test_live_outbox_allowed() and canonical_path(outbox) in live_outbox_candidates():
        outbox = (test_state or (Path(os.environ.get("TMPDIR", "/tmp")) / "whatsoup-vitest-bot-errors" / f"pid-{os.getpid()}")) / "outbox"
        policy = "test-redirect"
    provenance = {
        "producer": "python-health",
        "test": bool(strong_test_signals()),
        "signals": provenance_signals(),
        "strongSignals": strong_test_signals(),
        "outboxPolicy": policy,
        "liveOutboxRedirected": outbox != original,
        "resolvedOutbox": str(outbox),
    }
    return outbox, provenance


def runtime_provenance() -> dict[str, Any]:
    return resolve_outbox_dir()[1]


def socket_rpc_lock_path() -> Path:
    return Path(os.environ.get("BOT_ERRORS_SOCKET_RPC_LOCK", state_root() / "socket-rpc.lock")).expanduser()


@contextmanager
def socket_rpc_lock(timeout: float):
    path = socket_rpc_lock_path()
    ensure_private_dir(path.parent)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + timeout
    locked = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timeout waiting for socket RPC lock: {path}")
                time.sleep(0.05)
        yield
    finally:
        if locked:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def host_profile_name() -> str:
    """Host token used to name per-host profiles.

    Mirrors the install scripts (``hostname -s | tr '[:upper:]' '[:lower:]'``):
    first DNS label of the hostname, lowercased.
    """
    return socket.gethostname().split(".")[0].strip().lower()


def script_relative_profile_path() -> Path:
    """Canonical in-repo per-host profile path, resolved relative to this script.

    Matches deploy/scripts/install-bot-errors-health-launchd.sh and setup.sh
    (``REPO_ROOT/deploy/health-profiles/<host>.json``). Used as a self-healing
    fallback when the baked ``BOT_ERRORS_HEALTH_PROFILE`` env path is stale —
    e.g. a non-canonical checkout location — so a relay/leaf host never silently
    falls back to role=central and fails every central-only check.
    """
    return REPO_ROOT / "deploy" / "health-profiles" / f"{host_profile_name()}.json"


def read_profile_file(path: Path) -> dict[str, Any]:
    """Read and parse a profile JSON file.

    Returns the parsed dict; raises on read, parse, or non-object content so the
    caller can distinguish a usable profile from a failure.
    """
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError(f"profile {path} must be an object")
    return loaded


def load_health_profile() -> dict[str, Any]:
    raw = os.environ.get("BOT_ERRORS_HEALTH_PROFILE_JSON")
    path = os.environ.get("BOT_ERRORS_HEALTH_PROFILE")
    profile: dict[str, Any] = dict(DEFAULT_HEALTH_PROFILE)
    if raw:
        try:
            loaded = json.loads(raw)
        except json.JSONDecodeError as exc:
            return profile | {"profileLoadError": f"invalid BOT_ERRORS_HEALTH_PROFILE_JSON: {exc}", "_explicitProfile": True}
        if isinstance(loaded, dict):
            profile.update(loaded)
        else:
            profile["profileLoadError"] = "BOT_ERRORS_HEALTH_PROFILE_JSON must be an object"
        profile["_explicitProfile"] = True
        return profile

    fallback = script_relative_profile_path()
    if path:
        try:
            profile.update(read_profile_file(Path(path)))
            profile["_explicitProfile"] = True
            profile["_profilePath"] = path
            return profile
        except Exception as env_exc:  # noqa: BLE001 - self-heal before reporting failure.
            # Stale/unreadable baked env path (e.g. plist baked for a checkout
            # that no longer exists). Self-heal from the in-repo per-host profile
            # before defaulting to role=central, which would produce fleet-wide
            # false-criticals on relay/leaf hosts.
            try:
                profile.update(read_profile_file(fallback))
                profile["_explicitProfile"] = True
                profile["_profilePath"] = str(fallback)
                profile["profileFallback"] = f"env path unreadable ({path}: {env_exc}); recovered from {fallback}"
                return profile
            except Exception:  # noqa: BLE001 - daily health should report the original failure.
                return profile | {"profileLoadError": f"cannot read profile {path}: {env_exc}", "_explicitProfile": True}

    # No explicit env profile set — try the in-repo per-host profile before
    # defaulting to role=central.
    try:
        profile.update(read_profile_file(fallback))
        profile["_explicitProfile"] = True
        profile["_profilePath"] = str(fallback)
        profile["profileFallback"] = f"no BOT_ERRORS_HEALTH_PROFILE set; recovered from {fallback}"
        return profile
    except Exception:  # noqa: BLE001 - role=central default when no per-host profile exists.
        profile["_explicitProfile"] = False
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


def credential_requirements(profile: dict[str, Any]) -> list[str]:
    requirements = profile_string_list(profile, "requiredCredentialFiles")
    if profile.get("_explicitProfile") is True and (
        profile_bool(profile, "expectDispatcher", False)
        or profile_bool(profile, "expectQLoop", False)
    ):
        requirements.append("bot-errors.env")
    return list(dict.fromkeys(requirements))


def profile_string(container: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        raw = container.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def profile_dns_checks(profile: dict[str, Any]) -> list[dict[str, Any]]:
    raw = profile.get("dnsChecks", [])
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict)]


def dry_dns_map() -> dict[str, list[str]]:
    raw = os.environ.get("BOT_ERRORS_DRY_DNS_JSON", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    out: dict[str, list[str]] = {}
    for host, values in parsed.items():
        if not isinstance(host, str):
            continue
        if isinstance(values, str):
            out[host] = [values]
        elif isinstance(values, list):
            out[host] = [item for item in values if isinstance(item, str)]
    return out


def resolve_host_addresses(host: str) -> tuple[list[str], str | None]:
    dry = dry_dns_map()
    if host in dry:
        return sorted(set(dry[host])), None
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        return [], str(exc)
    addresses = sorted({str(info[4][0]) for info in infos if info[4]})
    return addresses, None


def dns_inventory(profile: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    for item in profile_dns_checks(profile):
        host = item.get("host")
        if not isinstance(host, str) or not host.strip():
            lines.append("FAIL dns: missing host")
            continue
        host = host.strip()
        label = item.get("name") if isinstance(item.get("name"), str) else host
        expected = profile_string_list(item, "expectedAddresses")
        forbidden = profile_string_list(item, "forbidAddresses")
        addresses, error = resolve_host_addresses(host)
        if error:
            lines.append(f"FAIL dns {label}: host={host} unresolved error={error[:160]}")
            continue
        missing = [address for address in expected if address not in addresses]
        forbidden_present = [address for address in forbidden if address in addresses]
        prefix = "FAIL " if missing or forbidden_present else ""
        details = [
            f"{prefix}dns {label}: host={host}",
            f"addresses={','.join(addresses) if addresses else 'none'}",
        ]
        if expected:
            details.append(f"expected={','.join(expected)}")
        if missing:
            details.append(f"missing_expected={','.join(missing)}")
        if forbidden:
            details.append(f"forbid={','.join(forbidden)}")
        if forbidden_present:
            details.append(f"forbidden_present={','.join(forbidden_present)}")
        lines.append(" ".join(details))
    return lines


def parse_tool_names(raw: str) -> list[str]:
    return sorted(name.strip() for name in raw.split(",") if name.strip())


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


def jid_fingerprint(jid: str) -> str:
    if not jid:
        return "missing"
    return hashlib.sha256(jid.encode("utf-8")).hexdigest()[:12]


def short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mode_string(mode: int) -> str:
    return format(mode & 0o777, "o")


def walk_auth_files(root: Path) -> list[Path]:
    out: list[Path] = []
    stack = [root]
    while stack:
        current = stack.pop()
        st = current.lstat()
        if stat.S_ISDIR(st.st_mode):
            entries = sorted((item for item in current.iterdir() if item.name != ".DS_Store"), reverse=True)
            stack.extend(entries)
            continue
        if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
            out.append(current)
    return sorted(out)


def hash_auth_tree(auth_dir: Path) -> str | None:
    if not auth_dir.exists():
        return None
    hasher = hashlib.sha256()
    for path in walk_auth_files(auth_dir):
        rel = path.relative_to(auth_dir).as_posix()
        st = path.lstat()
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(mode_string(st.st_mode).encode("utf-8"))
        hasher.update(b"\0")
        if stat.S_ISLNK(st.st_mode):
            hasher.update(b"symlink")
            hasher.update(b"\0")
            hasher.update(os.readlink(path).encode("utf-8"))
        else:
            hasher.update(b"file")
            hasher.update(b"\0")
            hasher.update(path.read_bytes())
        hasher.update(b"\0")
    return hasher.hexdigest()


def extract_me_hash(creds_path: Path) -> str | None:
    try:
        parsed = json.loads(creds_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    me = parsed.get("me")
    if not isinstance(me, dict):
        return None
    ident = me.get("id") if isinstance(me.get("id"), str) else me.get("lid")
    return short_hash(ident) if isinstance(ident, str) and ident else None


def hash_matches(observed: str | None, expected: str | None) -> bool:
    if not observed or not expected:
        return False
    return observed == expected or observed.startswith(expected) or expected.startswith(observed)


def auth_bond_restore_canary(auth_bond: dict[str, Any], instance_name: str | None) -> tuple[bool | None, str]:
    if os.environ.get("BOT_ERRORS_AUTH_BOND_RESTORE_CANARY", "1").strip().lower() in {"0", "false", "no", "off"}:
        return None, "auth_bond_restore_canary=disabled"

    backup = auth_bond.get("backup") if isinstance(auth_bond.get("backup"), dict) else {}
    latest_raw = backup.get("latest")
    if not isinstance(latest_raw, str) or not latest_raw:
        return None, "auth_bond_restore_canary=skipped_no_latest_backup"
    latest = Path(latest_raw)
    if not latest.exists():
        return None, "auth_bond_restore_canary=skipped_latest_path_unavailable"

    manifest_path = latest / "manifest.json"
    source_auth = latest / "auth"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest, dict):
            return False, "auth_bond_restore_canary=failed reason=manifest_not_object"
    except Exception as exc:  # noqa: BLE001 - health evidence should keep going.
        return False, f"auth_bond_restore_canary=failed reason=manifest_unreadable error={redact_evidence_string(str(exc), 160)}"

    manifest_instance = manifest.get("instanceName")
    if instance_name and isinstance(manifest_instance, str) and manifest_instance != instance_name:
        return False, f"auth_bond_restore_canary=failed reason=instance_mismatch manifest={manifest_instance} expected={instance_name}"
    if not source_auth.exists():
        return False, "auth_bond_restore_canary=failed reason=auth_tree_missing"

    try:
        with tempfile.TemporaryDirectory(prefix="bot-errors-auth-canary-") as tmp:
            copied_auth = Path(tmp) / "auth"
            shutil.copytree(source_auth, copied_auth, symlinks=True, copy_function=shutil.copy2)
            for auth_path in walk_auth_files(copied_auth):
                if auth_path.is_symlink():
                    return False, "auth_bond_restore_canary=failed reason=auth_tree_contains_symlink"
            copied_tree_hash = hash_auth_tree(copied_auth)
            manifest_tree_hash = manifest.get("treeHash") if isinstance(manifest.get("treeHash"), str) else None
            if not manifest_tree_hash:
                return False, "auth_bond_restore_canary=failed reason=tree_hash_missing"
            if copied_tree_hash != manifest_tree_hash:
                return False, "auth_bond_restore_canary=failed reason=copied_tree_hash_mismatch"

            creds_path = copied_auth / "creds.json"
            if not creds_path.exists():
                return False, "auth_bond_restore_canary=failed reason=creds_missing"
            manifest_creds_hash = manifest.get("credsHash") if isinstance(manifest.get("credsHash"), str) else None
            if not manifest_creds_hash:
                return False, "auth_bond_restore_canary=failed reason=creds_hash_missing"
            if hash_file(creds_path) != manifest_creds_hash:
                return False, "auth_bond_restore_canary=failed reason=creds_hash_mismatch"

            manifest_me_hash = manifest.get("meHash") if isinstance(manifest.get("meHash"), str) else None
            if not manifest_me_hash:
                return False, "auth_bond_restore_canary=failed reason=identity_manifest_missing"
            if extract_me_hash(creds_path) != manifest_me_hash:
                return False, "auth_bond_restore_canary=failed reason=identity_mismatch"
    except Exception as exc:  # noqa: BLE001 - report canary failure as health evidence.
        return False, f"auth_bond_restore_canary=failed reason=copy_or_validate_error error={redact_evidence_string(str(exc), 160)}"

    latest_tree_hash = backup.get("latest_tree_hash") if isinstance(backup.get("latest_tree_hash"), str) else None
    manifest_tree_hash = manifest.get("treeHash") if isinstance(manifest.get("treeHash"), str) else None
    if latest_tree_hash and manifest_tree_hash and not hash_matches(manifest_tree_hash, latest_tree_hash):
        return False, "auth_bond_restore_canary=failed reason=latest_pointer_manifest_mismatch"

    return True, "auth_bond_restore_canary=ok latest_present=true"


def alert_target_inventory(profile: dict[str, Any]) -> list[str]:
    if not profile_bool(profile, "expectAlertTarget", False):
        return ["alert_target: skipped by health profile"]

    lines: list[str] = []
    if not BOT_ERRORS_JID:
        lines.append("FAIL alert_target: BOT_ERRORS_JID missing")
    elif not GROUP_JID_RE.match(BOT_ERRORS_JID):
        lines.append(
            f"FAIL alert_target: BOT_ERRORS_JID must be WhatsApp group JID "
            f"target_fingerprint={jid_fingerprint(BOT_ERRORS_JID)}"
        )
    else:
        lines.append(f"alert_target: group_jid configured target_fingerprint={jid_fingerprint(BOT_ERRORS_JID)}")

    if not BOT_ERRORS_EXPECTED_JID:
        prefix = "FAIL" if BOT_ERRORS_REQUIRE_EXPECTED else "WARN"
        lines.append(f"{prefix} alert_target: BOT_ERRORS_EXPECTED_JID missing; target drift cannot be detected")
    elif BOT_ERRORS_JID != BOT_ERRORS_EXPECTED_JID:
        lines.append(
            f"FAIL alert_target: BOT_ERRORS_JID mismatch "
            f"actual_fingerprint={jid_fingerprint(BOT_ERRORS_JID)} "
            f"expected_fingerprint={jid_fingerprint(BOT_ERRORS_EXPECTED_JID)}"
        )
    else:
        lines.append(f"alert_target: expected_match target_fingerprint={jid_fingerprint(BOT_ERRORS_JID)}")

    return lines


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_runtime_manifest() -> tuple[dict[str, Any] | None, str | None]:
    raw = os.environ.get("BOT_ERRORS_RUNTIME_MANIFEST_JSON")
    if raw:
        try:
            loaded = json.loads(raw)
        except json.JSONDecodeError as exc:
            return None, f"invalid BOT_ERRORS_RUNTIME_MANIFEST_JSON: {exc}"
        if not isinstance(loaded, dict):
            return None, "BOT_ERRORS_RUNTIME_MANIFEST_JSON must be an object"
        return loaded, None

    path = Path(os.environ.get("BOT_ERRORS_RUNTIME_MANIFEST", REPO_ROOT / "deploy/bot-errors-runtime-manifest.json"))
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - daily health should report manifest failure.
        return None, f"cannot read runtime manifest {path}: {exc}"
    if not isinstance(loaded, dict):
        return None, f"runtime manifest {path} must be an object"
    return loaded, None


def _run_git_rev_parse(repo_root: Path) -> tuple[str, str, int]:
    """Run ``git --no-optional-locks -C <repo_root> rev-parse HEAD`` and return (stdout, stderr, returncode).

    Raises FileNotFoundError if git is not on PATH, subprocess.TimeoutExpired on timeout.
    Callers are responsible for catching those exceptions.
    """
    proc = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(repo_root), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return proc.stdout, proc.stderr, proc.returncode


def git_head_sha_line(manifest: dict[str, Any]) -> str:
    """Return a single observability/status line for the host git HEAD sha.

    Prefixed with ``WARN `` on transient git problems, ``FAIL `` on a confirmed
    expected/actual mismatch, and no prefix for normal observability output.
    All lines begin with ``git_head_sha`` so they sit under the
    runtime_manifest umbrella in health output.
    """
    raw_expected = manifest.get("expected_head_sha")

    # Validate expected_head_sha shape when present.
    expected_sha: str | None = None
    if raw_expected is not None:
        if not isinstance(raw_expected, str) or not re.fullmatch(r"[a-fA-F0-9]{7,64}", raw_expected):
            return "WARN git_head_sha: invalid expected_head_sha=<redacted>"
        expected_sha = raw_expected.lower()

    # Resolve the host HEAD sha.
    try:
        stdout, stderr, rc = _run_git_rev_parse(REPO_ROOT)
    except FileNotFoundError:
        return "WARN git_head_sha: git_unavailable"
    except subprocess.TimeoutExpired:
        return "WARN git_head_sha: git_rev_parse_timeout"

    if rc != 0:
        reason = stderr.strip().replace("\n", " ")[:120] or f"rc={rc}"
        if "not a git repository" in reason.lower():
            return "WARN git_head_sha: not_a_git_repository"
        return f"WARN git_head_sha: git_rev_parse_failed rc={rc}"

    actual_sha = stdout.strip()
    if not re.fullmatch(r"[a-fA-F0-9]{7,64}", actual_sha):
        return f"WARN git_head_sha: unexpected_output={actual_sha[:40]!r}"

    actual_sha = actual_sha.lower()

    if expected_sha is None:
        return f"git_head_sha: {actual_sha} expected=unset"

    # Prefix match: allow expected to be a short sha (>= 7 hex chars) that is a
    # prefix of the actual 40-char sha, as well as full equality.
    if actual_sha.startswith(expected_sha) or expected_sha.startswith(actual_sha):
        return f"git_head_sha: {actual_sha} expected={expected_sha} match"

    return f"FAIL git_head_sha: {actual_sha} expected={expected_sha} git_head_sha_mismatch"


def runtime_manifest_inventory(profile: dict[str, Any]) -> list[str]:
    if not profile_bool(profile, "expectRuntimeManifest", False):
        return ["runtime_manifest: skipped by health profile"]

    manifest, error = load_runtime_manifest()
    if error:
        return [f"FAIL runtime_manifest: {error}"]
    assert manifest is not None
    schema_version = manifest.get("schemaVersion")
    if schema_version != 1:
        return [f"FAIL runtime_manifest: unsupported schemaVersion={schema_version!r}"]

    files = manifest.get("files")
    if not isinstance(files, list):
        return ["FAIL runtime_manifest: files must be a list"]

    lines = [f"runtime_manifest: files={len(files)} root={REPO_ROOT}"]
    seen: set[str] = set()
    for index, item in enumerate(files):
        if not isinstance(item, dict):
            lines.append(f"FAIL runtime_manifest entry[{index}]: must be an object")
            continue
        raw_path = item.get("path")
        expected = item.get("sha256")
        required_text = item.get("mustContain", item.get("requiredText", []))
        if not isinstance(raw_path, str) or not raw_path.strip():
            lines.append(f"FAIL runtime_manifest entry[{index}]: missing path")
            continue
        if not isinstance(expected, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected):
            lines.append(f"FAIL runtime_manifest {raw_path}: invalid expected sha256")
            continue
        if isinstance(required_text, str):
            required_markers = [required_text]
        elif isinstance(required_text, list):
            required_markers = [marker for marker in required_text if isinstance(marker, str) and marker]
            invalid_markers = len(required_markers) != len(required_text)
            if invalid_markers:
                lines.append(f"FAIL runtime_manifest {raw_path}: mustContain entries must be strings")
                continue
        else:
            lines.append(f"FAIL runtime_manifest {raw_path}: mustContain must be a string or list")
            continue
        if raw_path in seen:
            lines.append(f"FAIL runtime_manifest {raw_path}: duplicate path")
            continue
        seen.add(raw_path)
        path = Path(raw_path)
        if not path.is_absolute():
            path = REPO_ROOT / path
        if not path.exists():
            lines.append(f"FAIL runtime_manifest {raw_path}: missing path={path}")
            continue
        try:
            actual = sha256_file(path)
        except OSError as exc:
            lines.append(f"FAIL runtime_manifest {raw_path}: cannot hash path={path} error={exc}")
            continue
        missing_markers: list[str] = []
        if required_markers:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                lines.append(f"FAIL runtime_manifest {raw_path}: cannot read markers path={path} error={exc}")
                continue
            for marker in required_markers:
                if marker not in text:
                    missing_markers.append(marker)
        prefix = "FAIL " if actual.lower() != expected.lower() else ""
        lines.append(
            f"{prefix}runtime_manifest {raw_path}: sha256={actual} expected={expected.lower()} "
            f"markers={len(required_markers)} missing_markers={len(missing_markers)} path={path}"
        )
        for marker in missing_markers[:10]:
            lines.append(
                f"FAIL runtime_manifest {raw_path}: missing_marker={redact_evidence_string(marker, 120)} path={path}"
            )
    lines.append(git_head_sha_line(manifest))
    return lines


def classify_source_update_failure(output: str, rc: int, timed_out: bool) -> str | None:
    if timed_out:
        return "git_remote_timeout"
    if rc == 0:
        return None
    lower = output.lower()
    if "permission denied" in lower or "publickey" in lower or "authentication failed" in lower:
        return "git_remote_auth_failed"
    if "could not resolve host" in lower or "temporary failure in name resolution" in lower:
        return "git_remote_dns_failed"
    if "network is unreachable" in lower or "connection timed out" in lower or "failed to connect" in lower:
        return "git_remote_network_failed"
    if "not a git repository" in lower:
        return "git_repository_missing"
    if "repository not found" in lower:
        return "git_remote_not_found"
    return "git_remote_unreachable"


def dry_source_update_probe() -> tuple[str, str, int, bool] | None:
    raw_rc = os.environ.get("BOT_ERRORS_DRY_SOURCE_UPDATE_RC")
    if raw_rc is None:
        return None
    try:
        rc = int(raw_rc)
    except ValueError:
        rc = 1
    return (
        os.environ.get("BOT_ERRORS_DRY_SOURCE_UPDATE_STDOUT", ""),
        os.environ.get("BOT_ERRORS_DRY_SOURCE_UPDATE_STDERR", ""),
        rc,
        env_flag("BOT_ERRORS_DRY_SOURCE_UPDATE_TIMEOUT", False),
    )


def source_update_access_mode(profile: dict[str, Any]) -> str:
    if "sourceUpdateAccessMode" in profile:
        raw_mode = profile.get("sourceUpdateAccessMode")
        if not isinstance(raw_mode, str):
            return "invalid"
        mode = raw_mode.strip().lower()
        if mode in {"off", "shadow", "enforce"}:
            return mode
        return "invalid"
    if profile_bool(profile, "expectSourceUpdateAccess", False):
        return "enforce"
    return "off"


def source_update_blocked_line(
    *,
    mode: str,
    failure_class: str,
    remote: str,
    ref: str,
    rc: int | None = None,
    output: str = "",
) -> str:
    prefix = "FAIL " if mode == "enforce" else ""
    status = "source_update: source_update_blocked"
    if mode == "shadow":
        status = "source_update: shadow source_update_blocked"
    line = (
        f"{prefix}{status} mode={mode} failure_class={failure_class} "
        f"remote={redact_evidence_string(remote, 80)} ref={redact_evidence_string(ref, 80)}"
    )
    if rc is not None:
        line += f" rc={rc}"
    excerpt = redact_evidence_string(output, 180)
    if excerpt:
        line += f" output={excerpt}"
    return line


def source_update_inventory(profile: dict[str, Any]) -> list[str]:
    mode = source_update_access_mode(profile)
    if mode == "invalid":
        raw_mode = profile_string(profile, "sourceUpdateAccessMode") or "<unset>"
        return [
            f"FAIL source_update: invalid sourceUpdateAccessMode={redact_evidence_string(raw_mode, 80)} "
            "expected=off,shadow,enforce"
        ]
    if mode == "off":
        return ["source_update: skipped by health profile"]

    remote = profile_string(profile, "sourceUpdateRemote") or "origin"
    ref = profile_string(profile, "sourceUpdateRef") or "HEAD"
    timeout_seconds = int_or_none(profile.get("sourceUpdateTimeoutSeconds")) or 10
    timeout_seconds = max(1, min(timeout_seconds, 60))

    dry_probe = dry_source_update_probe()
    timed_out = False
    if dry_probe is not None:
        stdout, stderr, rc, timed_out = dry_probe
    else:
        env = os.environ.copy()
        env.setdefault("GIT_TERMINAL_PROMPT", "0")
        env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=5")
        try:
            proc = subprocess.run(
                ["git", "-C", str(REPO_ROOT), "ls-remote", "--exit-code", remote, ref],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout_seconds,
                check=False,
                env=env,
            )
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            rc = proc.returncode
        except FileNotFoundError:
            return [
                source_update_blocked_line(
                    mode=mode,
                    failure_class="git_unavailable",
                    remote=remote,
                    ref=ref,
                )
            ]
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout if isinstance(exc.stdout, str) else ""
            stderr = exc.stderr if isinstance(exc.stderr, str) else ""
            rc = 124
            timed_out = True

    combined = "\n".join(part for part in [stdout, stderr] if part)
    failure_class = classify_source_update_failure(combined, rc, timed_out)
    safe_remote = redact_evidence_string(remote, 80)
    safe_ref = redact_evidence_string(ref, 80)
    if failure_class:
        return [
            source_update_blocked_line(
                mode=mode,
                failure_class=failure_class,
                remote=remote,
                ref=ref,
                rc=rc,
                output=combined,
            )
        ]

    return [f"source_update: git_remote reachable mode={mode} remote={safe_remote} ref={safe_ref} rc={rc}"]


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


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def safe_child_path(directory: Path, name: str) -> Path:
    if Path(name).name != name:
        raise ValueError(f"unsafe child filename: {name}")
    ensure_private_dir(directory)
    first = directory / name
    stem = name[:140].rstrip("._:-") or "unknown"
    prefix = f"{int(time.time())}.{os.getpid()}"
    candidates = [first, *[directory / f"{prefix}.{index}.{stem}" for index in range(1000)]]
    for target in candidates:
        try:
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
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
        if key in seen:
            continue
        seen.add(key)
        deduped.append(path)
    return deduped


def record_writefail(event: dict[str, Any], exc: BaseException, target: Path) -> Path | None:
    reason = f"{type(exc).__name__}: {exc}"
    event_id = event.get("id")
    instance = event.get("instance")
    try:
        sys.stderr.write(
            f"[bot-errors-health] CRITICAL outbox write FAILED for {redact_event_text(str(target))}: {redact_event_text(reason)}; "
            f"id={event_id} instance={instance} source={event.get('source')} "
            f"severity={event.get('severity')} - recording breadcrumb\n"
        )
        sys.stderr.flush()
    except Exception:
        pass

    breadcrumb = redact_json_value({
        "schemaVersion": 1,
        "kind": "outbox_write_failure",
        "recordedAt": now_iso(),
        "failedTarget": str(target),
        "reason": reason,
        "emitPid": os.getpid(),
        "event": event,
    })
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.{safe_segment(str(instance))}.{safe_segment(str(event_id))}.writefail"
    for base in writefail_dirs():
        try:
            path = safe_child_path(base, name)
            atomic_write_json(path, breadcrumb)
            try:
                sys.stderr.write(f"[bot-errors-health] lost-alert breadcrumb written: {redact_event_text(str(path))}\n")
                sys.stderr.flush()
            except Exception:
                pass
            return path
        except Exception:
            continue
    try:
        sys.stderr.write(
            "[bot-errors-health] breadcrumb write failed in ALL fallback dirs; "
            f"lost-event payload follows:\n{json.dumps(redact_json_value(event), sort_keys=True)}\n"
        )
        sys.stderr.flush()
    except Exception:
        pass
    return None


def assert_regular_or_missing(path: Path) -> None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(st.st_mode):
        raise RuntimeError(f"refusing to write through symlink: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise RuntimeError(f"refusing to write non-regular file: {path}")


def append_private_jsonl(path: Path, payload: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    assert_regular_or_missing(path)
    data = (json.dumps(redact_json_value({"time": now_iso(), "pid": os.getpid(), **payload}), sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(
        path,
        os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(fd, "ab") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            path.chmod(0o600)
        except OSError:
            pass
        fsync_parent(path)
    except BaseException:
        raise


def append_deadman_log(payload: dict[str, Any]) -> None:
    logs = state_root() / "logs"
    append_private_jsonl(logs / "deadman.jsonl", payload)


def deadman_state_path() -> Path:
    return state_root() / "deadman-state.json"


def load_deadman_state() -> dict[str, Any]:
    path = deadman_state_path()
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"schemaVersion": 1, "incidents": {}}
    except Exception as exc:  # noqa: BLE001 - a corrupt cooldown file must not hide a deadman alert.
        return {"schemaVersion": 1, "incidents": {}, "loadError": str(exc)[:240]}
    if not isinstance(loaded, dict):
        return {"schemaVersion": 1, "incidents": {}, "loadError": "deadman state root was not an object"}
    incidents = loaded.get("incidents")
    if not isinstance(incidents, dict):
        loaded["incidents"] = {}
    loaded["schemaVersion"] = 1
    return loaded


def save_deadman_state(state: dict[str, Any]) -> None:
    root = state_root()
    ensure_private_dir(root)
    atomic_write_json(deadman_state_path(), state)


def deadman_incident_key(problems: list[str]) -> str:
    payload = "\n".join(sorted(problems))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]


def epoch_to_iso(epoch: int | float | None) -> str | None:
    if epoch is None:
        return None
    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (OSError, OverflowError, ValueError):
        return None


def int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return None
    return None


def provider_fallback_active(
    configured_provider: Any,
    effective_provider: Any,
    fallback_active_until: Any,
) -> bool:
    if (
        isinstance(configured_provider, str)
        and configured_provider.strip()
        and isinstance(effective_provider, str)
        and effective_provider.strip()
        and configured_provider.strip() != effective_provider.strip()
    ):
        return True
    active_until = int_or_none(fallback_active_until)
    if active_until is None:
        return False
    now_ms = current_epoch() * 1000
    return active_until > now_ms


def auth_bond_instance_from_evidence(evidence: str) -> str:
    match = re.search(r"\bprimary_phone_state\s+([^:\s]+):", evidence)
    if match:
        return match.group(1)
    match = re.search(r"\bprimary_phone\s+([^:\s]+):", evidence)
    if match:
        return match.group(1)
    match = re.search(r"\bauth_bond\s+([^:\s]+):", evidence)
    if match:
        return match.group(1)
    match = re.search(r"\bhealth\s+([^:\s]+):", evidence)
    if match:
        return match.group(1)
    return "unknown"


def safe_alert_source_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def provider_probe_failure_matches(evidence: str) -> list[re.Match[str]]:
    return list(PROVIDER_PROBE_FAILURE_RE.finditer(evidence))


def alert_source_from_health_evidence(evidence: str) -> str | None:
    matches = provider_probe_failure_matches(evidence)
    if len(matches) == 1:
        match = matches[0]
        instance = safe_alert_source_segment(match.group(1))
        failure_class = safe_alert_source_segment(match.group(2))
        return f"provider_probe:{instance}:{failure_class}"
    if len(matches) > 1:
        return None
    problem_lines = [
        line.strip()
        for line in evidence.splitlines()
        if line.startswith("FAIL ") or line.startswith("WARN ") or " FAIL " in line or " WARN " in line
    ]
    fail_lines = [
        line for line in problem_lines
        if line.startswith("FAIL ") or " FAIL " in line
    ]
    warn_lines = [
        line for line in problem_lines
        if line.startswith("WARN ") or " WARN " in line
    ]
    runtime_manifest_failures = [
        match.group(1) or "manifest"
        for line in fail_lines
        for match in [RUNTIME_MANIFEST_FAILURE_RE.match(line)]
        if match is not None
    ]
    if runtime_manifest_failures and len(runtime_manifest_failures) == len(fail_lines):
        unique = {safe_alert_source_segment(item) for item in runtime_manifest_failures}
        if len(unique) == 1:
            return f"runtime_manifest:{next(iter(unique))}"
        return "runtime_manifest:multiple"
    source_update_problem_lines = [
        line for line in fail_lines
        if line.startswith("FAIL source_update:")
    ]
    if source_update_problem_lines and len(source_update_problem_lines) == len(fail_lines):
        return "source_update"
    primary_phone_source_lines = fail_lines if fail_lines else warn_lines
    primary_phone_evidence = "\n".join(primary_phone_source_lines) if primary_phone_source_lines else evidence
    primary_phone_instances = {
        safe_alert_source_segment(match.group(1))
        for match in PRIMARY_PHONE_SIGNAL_RE.finditer(primary_phone_evidence)
    }
    if len(primary_phone_instances) == 1:
        return f"primary_phone:{next(iter(primary_phone_instances))}"
    if len(primary_phone_instances) > 1:
        return "primary_phone:multiple"
    if not problem_lines and SOURCE_UPDATE_ENFORCED_OK_RE.search(evidence):
        return "source_update"
    return None


def enforced_source_update_signal(lines: list[str]) -> tuple[str, str, str, str] | None:
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("FAIL source_update:") and "mode=enforce" in line:
            return ("alert", "critical", "BOT ERRORS source update blocked", line)
    for raw_line in lines:
        line = raw_line.strip()
        if SOURCE_UPDATE_ENFORCED_OK_RE.search(line):
            return ("clear", "info", "BOT ERRORS source update reachable", line)
    return None


def has_shadow_source_update_blocked(lines: list[str]) -> bool:
    return any("source_update: shadow source_update_blocked" in line for line in lines)


def critical_asset_from_health_evidence(evidence: str) -> dict[str, Any] | None:
    lower = evidence.lower()
    instance = auth_bond_instance_from_evidence(evidence)
    code: str | None = None
    recoverability = "unknown"
    confidence = "probable"
    operator_action = "Q inspect health evidence and preserve auth material before making any destructive credential changes."
    clear_requirement = "matching healthy daily-health clear plus source-specific recovery proof"
    asset_kind = "whatsapp_auth_bond"
    domain = "credential_integrity"

    provider_match = next(iter(provider_probe_failure_matches(evidence)), None)
    if provider_match:
        instance = provider_match.group(1)
        failure_class = provider_match.group(2)
        asset_kind = "agent_provider"
        domain = "provider_access"
        confidence = "confirmed"
        recoverability = "operator_recoverable"
        clear_requirement = "daily-health clear after the provider probe succeeds or the instance is intentionally switched to a proven fallback provider"
        if failure_class == "provider_auth_required":
            code = "AGENT_PROVIDER_AUTH_REQUIRED"
            operator_action = "Restore provider authentication or switch to a proven fallback provider; do not mark the underlying auth failure resolved until the primary provider probe passes."
        elif failure_class == "provider_usage_limit":
            code = "AGENT_PROVIDER_USAGE_LIMIT"
            recoverability = "time_or_operator_recoverable"
            operator_action = "Use a proven fallback provider until the provider reset window passes; keep the original usage limit incident open until a probe succeeds."
        elif failure_class == "provider_rate_limit":
            code = "AGENT_PROVIDER_RATE_LIMIT"
            recoverability = "time_or_operator_recoverable"
            operator_action = "Back off or switch to a proven fallback provider; inspect provider quota and recent traffic before retry storms."
        elif failure_class == "provider_timeout":
            code = "AGENT_PROVIDER_TIMEOUT"
            operator_action = "Inspect provider process/network health and switch to a proven fallback only if the timeout repeats under controlled probes."
        elif failure_class == "provider_compatibility_degraded":
            code = "AGENT_PROVIDER_COMPATIBILITY_DEGRADED"
            recoverability = "operator_recoverable"
            operator_action = "Upgrade or migrate the OpenCode CLI to the modern run contract before depending on it for model-selected fallback; legacy one-shot mode is degraded and should be explicit."
            clear_requirement = "provider probe reports modern-run compatibility or the instance is intentionally documented as degraded legacy mode"
        elif failure_class == "provider_compatibility_unsupported":
            code = "AGENT_PROVIDER_COMPATIBILITY_UNSUPPORTED"
            recoverability = "operator_recoverable"
            operator_action = "Install/upgrade the provider CLI or correct agentOptions.providerConfig.opencodeCommandMode; do not treat the fallback provider as operational until the compatibility probe passes."
        elif failure_class == "provider_credential_missing":
            code = "AGENT_PROVIDER_CREDENTIAL_MISSING"
            recoverability = "operator_recoverable"
            operator_action = "Restore the provider credential in the service-visible environment or keyring before relying on the provider or fallback window."
            clear_requirement = "provider probe reports credential_status=present for the configured provider service without exposing the credential value"
        else:
            code = "AGENT_PROVIDER_PROBE_FAILED"
            operator_action = "Inspect provider probe output, provider credentials, network reachability, and model availability before clearing."
    elif text_has_terminal_auth_failure_class(lower) or "physical_intervention_required" in lower:
        code = "WA_AUTH_BOND_SERVER_REVOKED"
        recoverability = "manual_relink_required"
        confidence = "confirmed"
        domain = "account_linkage"
        asset_kind = "whatsapp_linked_device"
        operator_action = "Preserve auth material, inspect duplicate sessions/service overlap, and require verified relink proof before clearing."
        clear_requirement = "connected WhatsApp state, present non-empty auth bond, and successful outbound send after relink"
    elif "fail auth_bond_duplicate" in lower:
        code = "WA_AUTH_BOND_DUPLICATE_IDENTITY"
        recoverability = "manual_repair_required"
        confidence = "confirmed"
        operator_action = "Stop duplicate service/auth use, preserve both auth trees, and identify the owner instance before restart."
    elif "auth_bond_restore_canary=failed" in lower:
        code = "WA_AUTH_BOND_RESTORE_CANARY_FAILED"
        recoverability = "manual_repair_required"
        confidence = "confirmed"
        operator_action = "Treat backup restore as unproven; inspect latest manifest, tree hash, identity hash, and copy path before trusting backups."
    elif "mode_violation=" in lower:
        code = "WA_AUTH_BOND_PERMISSION_DRIFT"
        recoverability = "operator_recoverable"
        confidence = "confirmed"
        operator_action = "Repair auth directory and creds permissions to private mode and verify no unauthorized process can read or mutate them."
    elif "fail credential:" in lower or "fail credential_meta:" in lower:
        code = "CREDENTIAL_FILE_INTEGRITY_DRIFT"
        recoverability = "operator_recoverable"
        confidence = "confirmed"
        asset_kind = "credential_file"
        operator_action = "Repair credential files and parent directories to regular, non-symlinked, owner-only paths before trusting the host."
        clear_requirement = "daily-health clear after all required and discovered credential files are regular, non-symlinked, readable by owner, and mode 0600 with private parents"
    elif "auth_bond_backup_stale_for_live_creds" in lower or "auth_bond_backup_latest=none" in lower:
        code = "WA_AUTH_BOND_SNAPSHOT_STALE"
        recoverability = "operator_recoverable"
        confidence = "probable"
        operator_action = "Capture or repair protected auth-bond backups and verify restore canary before treating the machine as travel-ready."
    elif "fail primary_phone_state" in lower:
        code = "WA_AUTH_BOND_PRIMARY_PHONE_VERIFICATION_STATE_UNTRUSTED"
        recoverability = "operator_recoverable"
        confidence = "confirmed"
        domain = "account_linkage"
        asset_kind = "whatsapp_linked_device"
        operator_action = "Repair the primary-phone verification state file to a private regular JSON file before trusting linked-device verification evidence."
        clear_requirement = "daily-health clear after primary-phone verification state is private, parseable, and fresh enough for the affected instance"
    elif "verification_unknown" in lower and ("fail primary_phone" in lower or "warn primary_phone" in lower):
        if "warn primary_phone" in lower and "fail primary_phone" not in lower:
            return None
        code = "WA_AUTH_BOND_PRIMARY_PHONE_UNVERIFIED"
        recoverability = "operator_recoverable"
        confidence = "probable"
        domain = "account_linkage"
        asset_kind = "whatsapp_linked_device"
        operator_action = "Open WhatsApp on the primary phone for this line, confirm the linked device remains present, then run bot-errors-health-check.py --record-primary-phone-verification for the instance."
        clear_requirement = "daily-health clear after primary-phone verification state is refreshed within the configured warning window"
    elif "fail primary_phone" in lower or "warn primary_phone" in lower:
        code = "WA_AUTH_BOND_PRIMARY_PHONE_STALE"
        recoverability = "operator_recoverable"
        confidence = "confirmed"
        domain = "account_linkage"
        asset_kind = "whatsapp_linked_device"
        operator_action = "Open WhatsApp on the primary phone before the 14-day linked-device inactivity logout window, confirm linked devices, then refresh primary-phone verification state."
        clear_requirement = "daily-health clear after the primary phone has been verified recently enough to be below the warning threshold"
    elif "fail source_update:" in lower and "source_update_blocked" in lower:
        instance = "repository"
        code = "SOURCE_UPDATE_BLOCKED"
        recoverability = "operator_recoverable"
        confidence = "confirmed"
        domain = "source_distribution"
        asset_kind = "source_repository"
        operator_action = "Repair source update access or switch the host to an approved controlled distributor; do not rely on stale local code."
        clear_requirement = "daily-health clear after the enforced source_update probe reaches the configured remote/ref"

    if code is None:
        return None

    return {
        "asset": {
            "kind": asset_kind,
            "instance": instance,
            "owner": "whatsoup",
        },
        "failure": {
            "code": code,
            "domain": domain,
            "recoverability": recoverability,
            "confidence": confidence,
            "operatorAction": operator_action,
            "clearRequirement": clear_requirement,
        },
    }


def critical_asset_instance(critical_asset: dict[str, Any] | None) -> str | None:
    if not isinstance(critical_asset, dict):
        return None
    asset = critical_asset.get("asset")
    if not isinstance(asset, dict):
        return None
    instance = str(asset.get("instance") or "").strip()
    if not instance or instance == "unknown":
        return None
    return safe_alert_source_segment(instance)


def alert_source_from_critical_asset(critical_asset: dict[str, Any] | None) -> str | None:
    if not isinstance(critical_asset, dict):
        return None
    failure = critical_asset.get("failure")
    if not isinstance(failure, dict):
        return None
    code = str(failure.get("code") or "").strip()
    if code == "WA_AUTH_BOND_SERVER_REVOKED":
        return "whatsapp_device_bond_lost"
    return None


def daily_summary_from_critical_asset(critical_asset: dict[str, Any] | None) -> str | None:
    if not isinstance(critical_asset, dict):
        return None
    failure = critical_asset.get("failure")
    if not isinstance(failure, dict):
        return None
    code = str(failure.get("code") or "").strip()
    instance = critical_asset_instance(critical_asset) or "unknown"
    if code == "WA_AUTH_BOND_SERVER_REVOKED":
        return f"BOT ERRORS linked-device bond lost: {instance} requires verified relink"
    return None


def outbox_event(
    summary: str,
    evidence: str,
    severity: str = "critical",
    source: str = "daily-health",
    event_type: str = "alert",
    alert_source: str | None = None,
    force_notify: bool = False,
) -> Path:
    root = state_root()
    outbox, provenance = resolve_outbox_dir()
    ensure_private_dir(root)
    event_id = f"health-{time.time_ns()}-{os.getpid()}"
    event = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": event_type,
        "severity": severity,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": HOST_PLATFORM,
        "instance": "bot-errors-health",
        "source": source,
        "summary": redact_event_text(summary),
        "evidence": redact_event_text(evidence),
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": [redact_event_text(arg) for arg in sys.argv]},
        "runtime": {"provenance": provenance},
        "diagnostics": {
            "logHints": [
                health_log_hint(),
                dispatcher_log_hint(),
            ],
            "queue": str(outbox),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    event = redact_json_value(event)
    critical_asset = critical_asset_from_health_evidence(str(event["evidence"]))
    if critical_asset is not None:
        event["criticalAsset"] = redact_json_value(critical_asset)
        instance = critical_asset_instance(critical_asset)
        if source == "daily-health" and instance:
            event["instance"] = instance
    if alert_source is not None:
        event["alertSource"] = alert_source
    else:
        derived_alert_source = alert_source_from_health_evidence(str(event["evidence"]))
        if not derived_alert_source:
            derived_alert_source = alert_source_from_critical_asset(critical_asset)
        if derived_alert_source:
            event["alertSource"] = derived_alert_source
    if force_notify:
        event["diagnostics"]["forceNotify"] = True
        event["diagnostics"]["forceNotifyLevel"] = "critical"
    path = outbox / f"{event['createdAt'].replace(':', '').replace('-', '')}.{event_id}.json"
    try:
        atomic_write_json(path, event)
    except Exception as exc:  # noqa: BLE001 - health alerts must leave a recoverable breadcrumb if queue write fails.
        record_writefail(event, exc, outbox)
        raise
    return path


_INSTANCE_FAIL_PREFIXES = {
    "config",
    "health",
    "socket",
    "service",
    "service_enabled",
    "auth_bond",
    "provider_probe",
    "primary_phone_state",
    "profile_coverage",
    "profile_coverage_service",
    "tree_provenance",
}

# Infrastructure-class daily-health FAIL categories: host-environment problems
# that are NOT a bot/auth/credential outage. When EVERY failure is infra-class,
# the daily summary de-conflates from critical to warning. Per-instance critical
# salient events (emit_per_instance_health_failures) still fire regardless.
# Fail-safe: any category NOT in this set keeps the summary CRITICAL.
#
# Intentionally NARROW: only true host-environment categories belong here.
# queue_inventory() emits FAIL lines prefixed outbox/processing/quarantine/
# dispatcher_state/writefail — these are NOT listed, and stay CRITICAL on
# purpose: a backed-up outbox or a writefail on the alert host means alerts
# are not draining/writing, i.e. the alert pipeline itself is failing. (There
# is no "queue" prefix emitter — do not re-add one; it would match nothing.)
_DAILY_INFRA_FAIL_PREFIXES = frozenset({
    "disk", "dns", "rustdesk", "clock",
})


def _failure_is_infra_only(line: str) -> bool:
    """True iff this failure line is an infrastructure-class category (downgradeable).
    Parses the category token the same way _instance_from_fail_line does: strip a
    leading "FAIL " if present, take the first whitespace token, strip trailing ':'.
    A path-like token (contains '/') is NOT infra (fail-safe -> keep critical).
    Unknown categories return False (fail-safe -> keep critical)."""
    if not line:
        return False
    stripped = line.strip()
    if not stripped:
        return False
    if stripped.startswith("FAIL "):
        stripped = stripped[len("FAIL "):].strip()
    tokens = stripped.split()
    if not tokens:
        return False
    category = tokens[0].rstrip(":")
    if "/" in category or os.sep in category:
        return False
    return category in _DAILY_INFRA_FAIL_PREFIXES


def daily_summary_severity(failures: list[str], warnings: list[str]) -> str:
    """Pure severity decision for the daily-health summary event.

    Returns "critical" when any failure is not infrastructure-class (fail-safe),
    "warning" when there are only infra-class failures or only warnings, and
    "info" when there are neither failures nor warnings.
    """
    if failures:
        if all(_failure_is_infra_only(f) for f in failures):
            return "warning"   # infra-only daily failure -- de-conflated, not a page
        return "critical"
    if warnings:
        return "warning"
    return "info"


def _instance_from_fail_line(line: str) -> str | None:
    """Extract the per-instance identifier from a daily-health FAIL line.

    Strips a leading "FAIL " token if present, then inspects the first
    whitespace-delimited token: when it names a known per-instance condition
    prefix, the second token (with any trailing ":" stripped) is the instance.
    Returns None for empty/short lines or non-per-instance conditions.

    A token that contains a path separator is NOT an instance name — some
    inventories emit `config <full/path/config.json>: invalid JSON` where the
    second token is a filesystem path, not an instance id. Reject those so a
    salient event is never keyed on (or titled with) a leaked path.
    """
    if not line:
        return None
    stripped = line.strip()
    if not stripped:
        return None
    if stripped.startswith("FAIL "):
        stripped = stripped[len("FAIL "):].strip()
    tokens = stripped.split()
    if len(tokens) < 2:
        return None
    if tokens[0] in _INSTANCE_FAIL_PREFIXES:
        candidate = tokens[1].rstrip(":")
        if not candidate or "/" in candidate or os.sep in candidate:
            return None
        return candidate
    return None


def emit_per_instance_health_failures(failures: list[str]) -> list[Path]:
    """Emit one salient critical outbox event per failing instance.

    Groups failing daily-health lines by their per-instance identifier and
    emits a distinct critical, force-notify event for each instance so a real
    per-instance FAIL is not buried inside the generic daily-health summary.
    """
    grouped: dict[str, list[str]] = {}
    for line in failures:
        instance = _instance_from_fail_line(line)
        if instance is None:
            continue
        grouped.setdefault(instance, []).append(line)
    paths: list[Path] = []
    for instance in sorted(grouped):
        lines_for_instance = grouped[instance]
        evidence = "\n".join([f"instance: {instance}", *lines_for_instance])
        path = outbox_event(
            summary=f"BOT ERRORS daily-health FAIL: instance {instance}",
            evidence=evidence,
            severity="critical",
            source="daily-health-fail",
            event_type="alert",
            alert_source=instance,
            force_notify=True,
        )
        print(path)
        paths.append(path)
    return paths


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
    with socket_rpc_lock(timeout):
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


def validate_direct_alert_target() -> None:
    if not BOT_ERRORS_JID:
        raise RuntimeError("BOT_ERRORS_JID is required for direct WhatsApp health notification")
    if not GROUP_JID_RE.match(BOT_ERRORS_JID):
        raise RuntimeError("BOT_ERRORS_JID must be a WhatsApp group JID for direct WhatsApp health notification")
    if BOT_ERRORS_REQUIRE_EXPECTED and not BOT_ERRORS_EXPECTED_JID:
        raise RuntimeError("BOT_ERRORS_EXPECTED_JID is required for direct WhatsApp health notification")
    if BOT_ERRORS_EXPECTED_JID and BOT_ERRORS_JID != BOT_ERRORS_EXPECTED_JID:
        raise RuntimeError("BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID for direct WhatsApp health notification")


def send_direct(text: str) -> None:
    dry_log = os.environ.get("BOT_ERRORS_DRY_DIRECT_SEND_LOG", "").strip()
    if dry_log:
        path = Path(dry_log)
        append_private_jsonl(path, {"text": text})
        return
    validate_direct_alert_target()
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
    try:
        proc = subprocess.run(
            [str(fallback), "--subject", subject, "--body", body],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
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
            timeout=3,
            check=False,
        )
    except FileNotFoundError:
        return "unavailable:systemctl"
    except subprocess.TimeoutExpired:
        return "timeout:systemctl is-active"
    return proc.stdout.strip() or f"rc={proc.returncode}"


def launchctl_print(label: str) -> str:
    try:
        proc = subprocess.run(
            ["launchctl", "print", f"gui/{os.getuid()}/{label}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except FileNotFoundError:
        return ""
    except subprocess.TimeoutExpired:
        return ""
    return proc.stdout if proc.returncode == 0 else ""


def launchctl_status(label: str) -> str:
    output = launchctl_print(label)
    if not output:
        return "inactive"
    if "state = running" in output or "\tpid = " in output or "\n\tpid = " in output:
        return "active"
    return "loaded"


def whatsoup_instance_from_unit(unit: str) -> str | None:
    if unit.startswith("com.whatsoup."):
        return unit.removeprefix("com.whatsoup.")
    if unit.startswith("whatsoup@") and unit.endswith(".service"):
        return unit.removeprefix("whatsoup@").removesuffix(".service")
    return None


def dry_active_whatsoup_instances() -> set[str]:
    raw = os.environ.get("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES")
    if not raw:
        return set()
    names: set[str] = set()
    for item in raw.split(","):
        label = item.strip()
        if not label:
            continue
        if label.startswith("com.whatsoup."):
            names.add(label.removeprefix("com.whatsoup."))
        elif label.startswith("whatsoup@") and label.endswith(".service"):
            names.add(label.removeprefix("whatsoup@").removesuffix(".service"))
        else:
            names.add(label)
    return names


def whatsoup_bootstrap_pid(instance: str) -> int | None:
    dry = dry_active_whatsoup_instances()
    if instance in dry:
        return 1
    try:
        proc = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    needle = f"src/bootstrap.ts {instance}"
    for line in proc.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        pid_text, _, command = stripped.partition(" ")
        if needle not in command:
            continue
        try:
            return int(pid_text)
        except ValueError:
            return None
    return None


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
            timeout=3,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
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
        status = launchctl_status(unit)
        if status != "inactive":
            return status
        instance = whatsoup_instance_from_unit(unit)
        if instance and whatsoup_bootstrap_pid(instance) is not None:
            return "active_process_fallback"
        return status
    return systemctl_is_active(unit)


def systemctl_show_properties(unit: str, properties: list[str]) -> dict[str, str]:
    try:
        proc = subprocess.run(
            ["systemctl", "--user", "show", *[f"--property={prop}" for prop in properties], unit],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except FileNotFoundError:
        return {}
    except subprocess.TimeoutExpired:
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


def read_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return None
    return None


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


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
                stderr=subprocess.PIPE,
                text=True,
                timeout=3,
                check=False,
            )
            status = " ".join((proc.stdout + " " + proc.stderr).split()) or f"rc={proc.returncode}"
            status_lower = status.lower()
            if "administrator access" in status_lower or "operation not permitted" in status_lower:
                lines.append(f"clock_network_time: unavailable_without_admin rc={proc.returncode} sample={status[:240]}")
            else:
                prefix = "WARN " if proc.returncode != 0 or "Off" in status else ""
                lines.append(f"{prefix}clock_network_time: {status[:240]}")
        except Exception as exc:  # noqa: BLE001
            lines.append(f"WARN clock_network_time: unavailable {exc}")
        try:
            proc = subprocess.run(
                ["sntp", "time.apple.com"],
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
            elif proc.returncode != 0:
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


def tcp_connect_ok(host: str, port: int, timeout: float = 3.0) -> tuple[bool, str]:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True, "ok"
    except OSError as exc:
        return False, str(exc)[:160]


def rustdesk_inventory(profile: dict[str, Any]) -> list[str]:
    if not profile_bool(profile, "expectRustDesk", False):
        return []

    dry_id = os.environ.get("BOT_ERRORS_DRY_RUSTDESK_ID")
    dry_service_status = os.environ.get("BOT_ERRORS_DRY_RUSTDESK_SERVICE_STATUS")
    dry_port_status = os.environ.get("BOT_ERRORS_DRY_RUSTDESK_PORT_STATUS")
    dry_rendezvous_status = os.environ.get("BOT_ERRORS_DRY_RUSTDESK_RENDEZVOUS_STATUS")
    command = profile_string(profile, "rustDeskCommand") or shutil.which("rustdesk") or "/usr/bin/rustdesk"
    expected_id = profile_string(profile, "expectedRustDeskId")
    service = profile_string(profile, "rustDeskService")
    service_scope = (profile_string(profile, "rustDeskServiceScope") or "user").lower()
    direct_port = int_or_none(profile.get("rustDeskDirectPort"))
    rendezvous = profile_string(profile, "rustDeskRendezvous")
    lines: list[str] = []

    if dry_id is not None:
        rustdesk_id = dry_id.strip()
    elif not Path(command).exists() and shutil.which(command) is None:
        return [f"FAIL rustdesk: command_missing command={command}"]
    else:
        try:
            proc = subprocess.run(
                [command, "--get-id"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=5,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001 - daily health should report RustDesk failure.
            return [f"FAIL rustdesk: get_id_failed command={command} error={str(exc)[:160]}"]
        rustdesk_id = proc.stdout.strip().splitlines()[-1].strip() if proc.stdout.strip() else ""
        if proc.returncode != 0 or not rustdesk_id:
            return [
                f"FAIL rustdesk: get_id_failed command={command} rc={proc.returncode} "
                f"stderr={redact_evidence_string(proc.stderr, 160)}"
            ]

    id_prefix = "FAIL " if expected_id and rustdesk_id != expected_id else ""
    expected_label = expected_id or "not_pinned"
    lines.append(f"{id_prefix}rustdesk: id={rustdesk_id} expected_id={expected_label} command={command}")

    if service:
        if dry_service_status is not None:
            status = dry_service_status
        elif service_scope == "system":
            try:
                proc = subprocess.run(
                    ["systemctl", "is-active", service],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    timeout=3,
                    check=False,
                )
                status = proc.stdout.strip() or f"rc={proc.returncode}"
            except Exception as exc:  # noqa: BLE001 - daily health should report RustDesk failure.
                status = f"unavailable:{str(exc)[:120]}"
        else:
            status = service_is_active(service)
        prefix = "" if status == "active" else "FAIL "
        lines.append(f"{prefix}rustdesk_service: {status} ({service}) scope={service_scope}")

    if direct_port is not None:
        if dry_port_status is not None:
            ok = dry_port_status.strip().lower() in {"ok", "open", "active", "1", "true"}
            detail = dry_port_status
        else:
            ok, detail = tcp_connect_ok("127.0.0.1", direct_port)
        prefix = "" if ok else "FAIL "
        lines.append(f"{prefix}rustdesk_direct: host=127.0.0.1 port={direct_port} status={detail}")

    if rendezvous:
        host, _, raw_port = rendezvous.partition(":")
        port = int_or_none(raw_port)
        if not host or port is None:
            lines.append(f"FAIL rustdesk_rendezvous: invalid endpoint={rendezvous}")
        elif dry_rendezvous_status is not None:
            ok = dry_rendezvous_status.strip().lower() in {"ok", "open", "active", "1", "true"}
            detail = dry_rendezvous_status
            prefix = "" if ok else "FAIL "
            lines.append(f"{prefix}rustdesk_rendezvous: endpoint={rendezvous} status={detail}")
        else:
            ok, detail = tcp_connect_ok(host, port)
            prefix = "" if ok else "FAIL "
            lines.append(f"{prefix}rustdesk_rendezvous: endpoint={rendezvous} status={detail}")

    return lines


def health_probe_details(status: int, body: str, expected_name: str | None = None) -> str:
    try:
        data = json.loads(body)
    except Exception:
        return ""
    if not isinstance(data, dict):
        return ""
    whatsapp = data.get("whatsapp") if isinstance(data.get("whatsapp"), dict) else {}
    connection = whatsapp.get("connection") if isinstance(whatsapp.get("connection"), dict) else {}
    details: list[str] = []
    def add_marker(marker: str) -> None:
        if marker not in details:
            details.insert(0, marker)

    if status in {401, 403}:
        add_marker("health_probe_auth_failed")

    status_text = data.get("status")
    if isinstance(status_text, str) and status_text:
        append_evidence_field(details, "status", status_text)
        if status_text == "degraded":
            add_marker("health_degraded")
        elif status_text == "unhealthy":
            add_marker("health_unhealthy")
    connected = whatsapp.get("connected")
    if isinstance(connected, bool):
        details.append(f"wa_connected={str(connected).lower()}")
    auth_failure_class = connection.get("auth_failure_class")
    if isinstance(auth_failure_class, str) and auth_failure_class:
        append_evidence_field(details, "auth_failure_class", auth_failure_class)
        if is_terminal_auth_failure_class(auth_failure_class):
            add_marker("physical_intervention_required")
        elif auth_failure_class != "none":
            add_marker("auth_bond_at_risk")
    for key in [
        "state",
        "last_disconnect_reason",
        "last_status_code",
        "reconnect_phase",
        "reconnect_attempts",
        "first_failure_at",
    ]:
        value = connection.get(key)
        if value is not None:
            append_evidence_field(details, key, value)
    credential_lifecycle = whatsapp.get("credential_lifecycle") if isinstance(whatsapp.get("credential_lifecycle"), dict) else {}
    latest_baileys = credential_lifecycle.get("latestBaileysVersion")
    append_evidence_field(details, "baileys_version", latest_baileys)
    for source_key, label in [
        ("connectStartedAt", "lifecycle_connect_started_at"),
        ("lastOpenAt", "lifecycle_last_open_at"),
        ("lastCloseAt", "lifecycle_last_close_at"),
        ("lastQrAt", "lifecycle_last_qr_at"),
        ("lastCredsUpdateAt", "lifecycle_last_creds_update_at"),
        ("lastCredsUpdateFailedAt", "lifecycle_last_creds_update_failed_at"),
        ("lastAuthSnapshotAt", "lifecycle_last_auth_snapshot_at"),
        ("lastAuthSnapshotFailedAt", "lifecycle_last_auth_snapshot_failed_at"),
        ("credsUpdateCount", "lifecycle_creds_update_count"),
        ("authSnapshotCaptureCount", "lifecycle_auth_snapshot_count"),
        ("authSnapshotFailureCount", "lifecycle_auth_snapshot_failure_count"),
    ]:
        append_evidence_field(details, label, credential_lifecycle.get(source_key))
    lifecycle_env = credential_lifecycle.get("environment") if isinstance(credential_lifecycle.get("environment"), dict) else {}
    for source_key, label in [
        ("host", "lifecycle_host"),
        ("pid", "lifecycle_pid"),
        ("nodeVersion", "lifecycle_node_version"),
        ("platform", "lifecycle_platform"),
        ("arch", "lifecycle_arch"),
        ("processUptimeSeconds", "lifecycle_process_uptime_seconds"),
        ("osUptimeSeconds", "lifecycle_os_uptime_seconds"),
    ]:
        append_evidence_field(details, label, lifecycle_env.get(source_key))
    lifecycle_memory = lifecycle_env.get("memory") if isinstance(lifecycle_env.get("memory"), dict) else {}
    append_evidence_field(details, "lifecycle_memory_free_bytes", lifecycle_memory.get("freeBytes"))
    append_evidence_field(details, "lifecycle_memory_total_bytes", lifecycle_memory.get("totalBytes"))
    last_disconnect_diag = credential_lifecycle.get("lastDisconnectDiagnostic") if isinstance(credential_lifecycle.get("lastDisconnectDiagnostic"), dict) else {}
    append_evidence_field(details, "lifecycle_disconnect_status_code", last_disconnect_diag.get("statusCode"))
    append_evidence_field(details, "lifecycle_disconnect_reason", last_disconnect_diag.get("reason"))
    append_evidence_field(details, "lifecycle_disconnect_message", last_disconnect_diag.get("message"), 180)
    recent_events = credential_lifecycle.get("recentEvents")
    if isinstance(recent_events, list) and recent_events:
        names: list[str] = []
        events = [event for event in recent_events if isinstance(event, dict)]
        for event in events[-8:]:
            if isinstance(event, dict) and isinstance(event.get("event"), str):
                names.append(redact_evidence_string(event["event"], 64))
        append_evidence_field(details, "credential_lifecycle_event_count", len(recent_events))
        if names:
            details.append("credential_lifecycle_events=" + ",".join(names))
        if events:
            latest_event = events[-1]
            append_evidence_field(details, "credential_lifecycle_last_event", latest_event.get("event"))
            append_evidence_field(details, "credential_lifecycle_last_event_at", latest_event.get("at"))
            append_evidence_field(details, "credential_lifecycle_last_event_status_code", latest_event.get("statusCode"))
            append_evidence_field(details, "credential_lifecycle_last_event_reason", latest_event.get("reason"))
    if (
        is_logged_out_status_code(connection.get("last_status_code"))
        or is_logged_out_disconnect_reason(connection.get("last_disconnect_reason"))
    ):
        add_marker("physical_intervention_required")
    instance_meta = data.get("instance") if isinstance(data.get("instance"), dict) else {}
    instance_name = instance_meta.get("name") if isinstance(instance_meta.get("name"), str) else None
    if instance_name:
        append_evidence_field(details, "instance_name", instance_name)
    instance_provider = instance_meta.get("provider")
    instance_effective_provider = instance_meta.get("effectiveProvider")
    instance_fallback_active_until = instance_meta.get("fallbackActiveUntil")
    append_evidence_field(details, "instance_provider", instance_provider)
    append_evidence_field(details, "instance_effective_provider", instance_effective_provider)
    append_evidence_field(details, "instance_fallback_active_until", instance_fallback_active_until)
    append_evidence_field(details, "instance_fallback_reason", instance_meta.get("fallbackReason"))
    append_evidence_field(details, "instance_fallback_model", instance_meta.get("fallbackModel"))
    append_evidence_field(details, "instance_fallback_reset_at", instance_meta.get("fallbackResetAt"))
    append_evidence_field(details, "instance_fallback_recovery_probe_required", instance_meta.get("fallbackRecoveryProbeRequired"))
    if provider_fallback_active(instance_provider, instance_effective_provider, instance_fallback_active_until):
        add_marker("runtime_agent_fallback_active")
    if expected_name and instance_name and instance_name != expected_name:
        add_marker("health_identity_mismatch")
        append_evidence_field(details, "expected_instance", expected_name)
    auth_bond = whatsapp.get("auth_bond") if isinstance(whatsapp.get("auth_bond"), dict) else {}
    auth_status = auth_bond.get("status")
    issues = auth_bond.get("issues")
    creds = auth_bond.get("creds") if isinstance(auth_bond.get("creds"), dict) else {}
    fresh_credential_write_age: int | None = None
    if (
        auth_status == "invalid"
        and isinstance(issues, list)
        and any(str(issue) in {"creds_json_empty", "creds_json_invalid_json"} for issue in issues)
        and creds.get("exists") is True
    ):
        creds_epoch = parse_iso_epoch(creds.get("mtime"))
        if creds_epoch is not None:
            age = current_epoch() - creds_epoch
            grace = env_int("BOT_ERRORS_AUTH_BOND_WRITE_INFLIGHT_GRACE_SECONDS", 10)
            if 0 <= age < grace:
                fresh_credential_write_age = age
                details.append("auth_bond_credential_write_inflight=true")
                details.append(f"auth_bond_credential_write_inflight_age_seconds={age}")
    if isinstance(auth_status, str) and auth_status:
        if auth_status != "present" and fresh_credential_write_age is None:
            add_marker("auth_bond_at_risk")
        append_evidence_field(details, "auth_bond_status", auth_status)
    if isinstance(issues, list) and issues:
        if fresh_credential_write_age is None:
            add_marker("auth_bond_at_risk")
        rendered = [redact_evidence_string(str(item), 80) for item in issues[:8]]
        details.append("auth_bond_issues=" + ",".join(item for item in rendered if item))
    auth_dir = auth_bond.get("auth_dir") if isinstance(auth_bond.get("auth_dir"), dict) else {}
    append_evidence_field(details, "auth_bond_auth_dir_exists", auth_dir.get("exists"))
    append_evidence_field(details, "auth_bond_auth_dir_mode", auth_dir.get("mode"))
    append_evidence_field(details, "auth_bond_auth_dir_mtime", auth_dir.get("mtime"))
    append_evidence_field(details, "auth_bond_creds_exists", creds.get("exists"))
    append_evidence_field(details, "auth_bond_creds_mode", creds.get("mode"))
    append_evidence_field(details, "auth_bond_creds_size", creds.get("size"))
    append_evidence_field(details, "auth_bond_creds_mtime", creds.get("mtime"))
    append_evidence_field(details, "auth_bond_creds_hash", creds.get("hash"))
    append_evidence_field(details, "auth_bond_creds_empty_hash", creds.get("empty_hash"))
    append_evidence_field(details, "auth_bond_identity_hash", auth_bond.get("me_hash"))
    append_evidence_field(details, "auth_bond_tree_hash", auth_bond.get("tree_hash"))
    backup = auth_bond.get("backup") if isinstance(auth_bond.get("backup"), dict) else {}
    latest = backup.get("latest")
    if auth_status == "present" and not latest:
        add_marker("auth_bond_at_risk")
        details.append("auth_bond_backup_latest=none")
    elif isinstance(latest, str) and latest:
        details.append("auth_bond_backup_latest_present=true")
        latest_tree_hash = backup.get("latest_tree_hash")
        live_tree_hash = auth_bond.get("tree_hash")
        tree_mismatch = (
            isinstance(live_tree_hash, str)
            and isinstance(latest_tree_hash, str)
            and live_tree_hash
            and latest_tree_hash
            and live_tree_hash != latest_tree_hash
        )
        if tree_mismatch:
            details.append(f"auth_bond_backup_tree_mismatch live={live_tree_hash} latest={latest_tree_hash}")
        append_evidence_field(details, "auth_bond_backup_latest_at", backup.get("latest_at"))
        append_evidence_field(details, "auth_bond_backup_latest_reason", backup.get("latest_reason"))
        append_evidence_field(details, "auth_bond_backup_latest_tree_hash", latest_tree_hash)
        latest_epoch = parse_iso_epoch(backup.get("latest_at"))
        last_capture_epoch = parse_iso_epoch(backup.get("last_capture_at"))
        backup_epoch = max(
            [epoch for epoch in [latest_epoch, last_capture_epoch] if epoch is not None],
            default=None,
        )
        last_capture_at = backup.get("last_capture_at")
        append_evidence_field(details, "auth_bond_backup_last_capture_at", last_capture_at)
        append_evidence_field(details, "auth_bond_backup_last_capture_reason", backup.get("last_capture_reason"))
        creds_epoch = parse_iso_epoch(creds.get("mtime"))
        grace = env_int("BOT_ERRORS_AUTH_BOND_BACKUP_CAPTURE_GRACE_SECONDS", 300)
        if tree_mismatch and backup_epoch is not None and creds_epoch is not None and creds_epoch > backup_epoch + grace:
            add_marker("auth_bond_at_risk")
            details.append(
                f"auth_bond_backup_stale_for_live_creds creds_mtime={creds.get('mtime')} "
                f"latest_at={backup.get('latest_at')} last_capture_at={backup.get('last_capture_at')}"
            )
        warn_age = env_int("BOT_ERRORS_AUTH_BOND_BACKUP_WARN_AGE_SECONDS", 0)
        if warn_age > 0 and backup_epoch is not None:
            age = int(time.time()) - backup_epoch
            details.append(f"auth_bond_backup_age_seconds={age}")
            if age > warn_age:
                add_marker("auth_bond_backup_age_warning")
        canary_ok, canary_detail = auth_bond_restore_canary(auth_bond, instance_name)
        details.append(canary_detail)
        if canary_ok is False:
            add_marker("auth_bond_restore_canary_failed")
    append_evidence_field(details, "auth_bond_backup_last_capture_deferred_at", backup.get("last_capture_deferred_at"))
    append_evidence_field(details, "auth_bond_backup_last_capture_deferred_reason", backup.get("last_capture_deferred_reason"))
    append_evidence_field(details, "auth_bond_backup_last_capture_deferred_age_ms", backup.get("last_capture_deferred_age_ms"))
    last_capture_error = backup.get("last_capture_error")
    if isinstance(last_capture_error, str) and last_capture_error:
        add_marker("auth_bond_at_risk")
        append_evidence_field(details, "auth_bond_last_capture_error", last_capture_error, 180)
    append_evidence_field(details, "auth_bond_last_restore_at", backup.get("last_restore_at"))
    last_restore_source = backup.get("last_restore_source")
    if isinstance(last_restore_source, str) and last_restore_source:
        details.append("auth_bond_last_restore_source_present=true")
    last_restore_error = backup.get("last_restore_error")
    if isinstance(last_restore_error, str) and last_restore_error:
        append_evidence_field(details, "auth_bond_last_restore_error", last_restore_error, 180)
    outbound_sends = data.get("outbound_sends") if isinstance(data.get("outbound_sends"), dict) else {}
    outbound_success_at = outbound_sends.get("latest_successful_send_at")
    outbound_transport_id = outbound_sends.get("latest_successful_transport_id")
    append_evidence_field(details, "outbound_success_at", outbound_success_at)
    if isinstance(outbound_transport_id, str) and outbound_transport_id:
        transport_hash = hashlib.sha256(outbound_transport_id.encode("utf-8")).hexdigest()[:20]
        details.append("outbound_success_transport_present=true")
        details.append(f"outbound_success_transport_hash={transport_hash}")
    runtime = data.get("runtime") if isinstance(data.get("runtime"), dict) else {}
    agent = runtime.get("agent") if isinstance(runtime.get("agent"), dict) else {}
    if agent:
        runtime_primary_provider = agent.get("primaryProvider") or agent.get("agentProvider")
        runtime_effective_provider = agent.get("effectiveProvider")
        runtime_fallback_active_until = agent.get("fallbackActiveUntil")
        if provider_fallback_active(runtime_primary_provider, runtime_effective_provider, runtime_fallback_active_until):
            add_marker("runtime_agent_fallback_active")
        for key, label in [
            ("activeSessions", "runtime_agent_active_sessions"),
            ("sessionCount", "runtime_agent_session_count"),
            ("lastSessionStatus", "runtime_agent_last_session_status"),
            ("lastSessionStartedAt", "runtime_agent_last_session_started_at"),
            ("sessionScope", "runtime_agent_session_scope"),
            ("primaryProvider", "runtime_agent_primary_provider"),
            ("effectiveProvider", "runtime_agent_effective_provider"),
            ("fallbackActiveUntil", "runtime_agent_fallback_active_until"),
            ("fallbackReason", "runtime_agent_fallback_reason"),
            ("fallbackModel", "runtime_agent_fallback_model"),
            ("fallbackResetAt", "runtime_agent_fallback_reset_at"),
            ("fallbackRecoveryProbeRequired", "runtime_agent_fallback_recovery_probe_required"),
            ("agentProvider", "runtime_agent_agent_provider"),
            ("recentCrashes", "runtime_agent_recent_crashes"),
            ("recentResumeFailures", "runtime_agent_recent_resume_failures"),
            ("pollPersistenceErrors", "runtime_agent_poll_persistence_errors"),
            ("autoCompactIneffective", "runtime_agent_auto_compact_ineffective"),
            ("autoCompactConsecutiveRapidRearmsMax", "runtime_agent_auto_compact_rapid_rearms_max"),
            ("autoCompactNextTurnOverThreshold", "runtime_agent_auto_compact_next_turn_over_threshold"),
        ]:
            value = agent.get(key)
            if key in {
                "lastSessionStatus",
                "lastSessionStartedAt",
                "sessionScope",
                "primaryProvider",
                "effectiveProvider",
                "fallbackActiveUntil",
                "fallbackReason",
                "fallbackModel",
                "fallbackResetAt",
                "fallbackRecoveryProbeRequired",
                "agentProvider",
            }:
                append_evidence_field(details, label, value)
                continue
            number = read_int(value)
            if number is None:
                continue
            if number != 0 or key in {"activeSessions", "sessionCount"}:
                details.append(f"{label}={number}")
            if key not in {"activeSessions", "sessionCount"} and number > 0:
                add_marker("runtime_agent_at_risk")
        last_crash_at = agent.get("lastCrashAt")
        if isinstance(last_crash_at, str) and last_crash_at:
            details.append(f"runtime_agent_last_crash_at={last_crash_at}")
        last_resume_failed_at = agent.get("lastResumeFailedAt")
        if isinstance(last_resume_failed_at, str) and last_resume_failed_at:
            details.append(f"runtime_agent_last_resume_failed_at={last_resume_failed_at}")
    return " ".join(details)


def format_health_probe(url: str, status: int, body: str = "", expected_name: str | None = None) -> str:
    details = health_probe_details(status, body, expected_name)
    suffix = f" {details}" if details else ""
    if (
        status >= 500
        or "health_probe_auth_failed" in details
        or "health_identity_mismatch" in details
        or "auth_bond_at_risk" in details
        or "physical_intervention_required" in details
        or "health_unhealthy" in details
    ):
        prefix = "FAIL "
    elif (
        "health_degraded" in details
        or "runtime_agent_at_risk" in details
        or "runtime_agent_fallback_active" in details
        or "auth_bond_restore_canary_failed" in details
        or "auth_bond_backup_age_warning" in details
    ):
        prefix = "WARN "
    else:
        prefix = ""
    return f"{prefix}{status} {url}{suffix}"


def probe_health(port: int, expected_name: str | None = None) -> str:
    url = f"http://127.0.0.1:{port}/health"
    dry_body = os.environ.get("BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON")
    if dry_body is not None:
        dry_status = int(os.environ.get("BOT_ERRORS_DRY_HEALTH_STATUS", "503"))
        return format_health_probe(url, dry_status, dry_body, expected_name)
    req = Request(url, method="GET")
    try:
        with urlopen(req, timeout=HEALTH_PROBE_TIMEOUT_SECONDS) as response:
            body = response.read(64 * 1024).decode("utf-8", errors="replace")
            return format_health_probe(url, response.status, body, expected_name)
    except HTTPError as exc:
        body = exc.read(64 * 1024).decode("utf-8", errors="replace")
        return format_health_probe(url, exc.code, body, expected_name)
    except URLError as exc:
        return f"FAIL {url} {exc.reason}"
    except Exception as exc:
        return f"FAIL {url} {exc}"


def provider_probe_enabled(profile: dict[str, Any], item: dict[str, Any]) -> bool:
    return profile_bool(item, "expectProviderProbe", profile_bool(profile, "expectProviderProbe", False))


def agent_options_from_config(data: dict[str, Any]) -> dict[str, Any]:
    return data.get("agentOptions") if isinstance(data.get("agentOptions"), dict) else {}


def provider_from_config(data: dict[str, Any]) -> str:
    agent_options = agent_options_from_config(data)
    provider = agent_options.get("provider") if isinstance(agent_options.get("provider"), str) else data.get("provider")
    return provider.strip() if isinstance(provider, str) and provider.strip() else "claude-cli"


def fallback_provider_from_config(data: dict[str, Any]) -> str | None:
    agent_options = agent_options_from_config(data)
    provider = agent_options.get("fallbackProvider")
    return provider.strip() if isinstance(provider, str) and provider.strip() else None


def classify_provider_probe_failure(text: str, rc: int, timed_out: bool) -> str | None:
    lower = text.lower()
    if timed_out:
        return "provider_timeout"
    if (
        "not logged in" in lower
        or "please run /login" in lower
        or "keychain is locked" in lower
        or "user interaction is not allowed" in lower
    ):
        return "provider_auth_required"
    if (
        "out of extra usage" in lower
        or "usage limit reached" in lower
        or "usage cap reached" in lower
        or "session limit reached" in lower
        or "you've hit your session limit" in lower
        or "you have hit your session limit" in lower
        or "you've hit your weekly limit" in lower
        or "you have hit your weekly limit" in lower
        or "weekly limit" in lower
        or "monthly limit" in lower
        or ("session limit" in lower and "reset" in lower)
        or ("usage limit" in lower and "reset" in lower)
        or ("limit" in lower and "reset" in lower)
    ):
        return "provider_usage_limit"
    if "rate limit" in lower or "429" in lower:
        return "provider_rate_limit"
    if rc != 0:
        return "provider_probe_failed"
    return None


def opencode_command_mode_from_config(data: dict[str, Any], target: str = "primary") -> str:
    agent_options = agent_options_from_config(data)
    config_key = "fallbackProviderConfig" if target == "fallback" else "providerConfig"
    provider_config = agent_options.get(config_key) if isinstance(agent_options.get(config_key), dict) else {}
    mode = provider_config.get("opencodeCommandMode")
    return mode.strip() if isinstance(mode, str) and mode.strip() else "auto"


def provider_model_from_config(data: dict[str, Any], target: str = "primary") -> str | None:
    agent_options = agent_options_from_config(data)
    if target == "fallback":
        model = agent_options.get("fallbackModel")
        return model.strip() if isinstance(model, str) and model.strip() else None
    provider_config = agent_options.get("providerConfig") if isinstance(agent_options.get("providerConfig"), dict) else {}
    model = provider_config.get("model")
    if isinstance(model, str) and model.strip():
        return model.strip()
    model = data.get("model")
    return model.strip() if isinstance(model, str) and model.strip() else None


def opencode_key_service_for_model(model: str | None) -> str | None:
    if not model:
        return None
    prefix = model.split("/", 1)[0].strip().lower()
    return prefix or None


def secret_file_has_service_key(service: str, env_key: str | None) -> bool:
    if not env_key:
        return False
    path = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "secrets" / f"{service}.env"
    if not path.exists() or not path.is_file():
        return False
    try:
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            match = re.match(rf"^(?:export\s+)?{re.escape(env_key)}=([\s\S]*)$", line)
            if not match:
                continue
            value = (match.group(1) or "").strip()
            if (
                (value.startswith("'") and value.endswith("'"))
                or (value.startswith('"') and value.endswith('"'))
            ):
                value = value[1:-1]
            if value:
                return True
    except OSError:
        return False
    return False


def dry_credential_status(service: str) -> str | None:
    key = re.sub(r"[^A-Za-z0-9]+", "_", service).upper().strip("_")
    raw = os.environ.get(f"BOT_ERRORS_DRY_CREDENTIAL_STATUS_{key}")
    return raw.strip().lower() if isinstance(raw, str) and raw.strip() else None


# WhatSoup lookupCredential keychain migration fallbacks (mirror src/lib/keyring.ts
# SERVICE_MIGRATION_FALLBACKS): a service whose live key is stored under a divergent keyring
# service name. The health-check must try the same fallbacks the runtime does, or it reports a
# resolvable key as missing (e.g. glm whose key is stored under "zai-api-key").
SERVICE_KEYCHAIN_FALLBACKS: dict[str, list[str]] = {
    "glm": ["zai-api-key"],
    "google": ["gemini"],
    "whatsoup-health-token": ["whatsoup_health"],
}


def whatsoup_keyfile_present(service: str) -> bool:
    """True when ~/.config/whatsoup/credentials/<service>.key holds a non-empty value.

    This is the file store lookupCredential consults after a keyring miss (keyring.ts
    fileStoreRead — reached even on the macos-keychain backend). It is the store the live fleet is
    actually provisioned into, so the health-check MUST check it or it reports a runtime-resolvable
    key as missing (false negative). NOTE: lookupCredential's file store keys on the ORIGINAL
    service name only (no migration), so we do too.
    """
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    path = Path(base) / "whatsoup" / "credentials" / f"{service}.key"
    try:
        return path.is_file() and bool(path.read_text(encoding="utf-8").strip())
    except OSError:
        return False


def _keychain_secret_status(candidates: list[str], account: str, timeout_seconds: int) -> str:
    """darwin keychain read for the first resolvable candidate.
    Returns 'present' | 'missing' | 'timeout' | 'probe_error_<detail>'."""
    for candidate in candidates:
        try:
            proc = subprocess.run(
                ["security", "find-generic-password", "-s", candidate, "-a", account, "-w"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=min(timeout_seconds, 5),
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "timeout"
        except Exception as exc:  # noqa: BLE001 - credential check should be diagnostic-only.
            return f"probe_error_{redact_evidence_string(str(exc), 80)}"
        if proc.returncode == 0 and proc.stdout.strip():
            return "present"
    return "missing"


def _secret_tool_status(candidates: list[str], timeout_seconds: int) -> str:
    """linux secret-tool read for the first resolvable candidate.
    Returns 'present' | 'missing' | 'empty' | 'timeout' | 'probe_error_<detail>'."""
    saw_empty = False
    for candidate in candidates:
        try:
            proc = subprocess.run(
                ["secret-tool", "lookup", "service", candidate],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=min(timeout_seconds, 5),
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "timeout"
        except Exception as exc:  # noqa: BLE001 - credential check should be diagnostic-only.
            return f"probe_error_{redact_evidence_string(str(exc), 80)}"
        if proc.returncode == 0 and proc.stdout.strip():
            return "present"
        if proc.returncode == 0:
            saw_empty = True
    return "empty" if saw_empty else "missing"


def provider_credential_presence(service: str, timeout_seconds: int) -> tuple[bool, str, str]:
    # Mirror src/lib/keyring.ts lookupCredential resolution EXACTLY so a key the runtime can
    # resolve is never reported missing (and vice-versa):
    #   env var -> OS keyring (service + migration fallbacks) -> ~/.config/whatsoup/credentials/<svc>.key
    # NOTE: ~/.config/secrets/<svc>.env is the `ocw` worker store; the WhatSoup runtime does NOT
    # source it, so it is reported as a diagnostic negative only, never as provisioned. (2026-06-23:
    # the fleet is provisioned via the .key file store, not the keychain — checking only env/.env/
    # keychain produced false "missing fallback credentials" despite a healthy runtime.)
    env_key = service_env_var(service)
    dry_status = dry_credential_status(service)
    if dry_status is not None:
        present = dry_status in {"present", "ok", "true", "1"}
        return present, "dry", dry_status
    if env_key and os.environ.get(env_key):
        return True, "env", "present"

    candidates = [service, *SERVICE_KEYCHAIN_FALLBACKS.get(service, [])]
    if HOST_PLATFORM == "darwin":
        account = os.environ.get("USER") or Path.home().name or "unknown"
        keyring_source = "macos_keychain"
        keyring_status = _keychain_secret_status(candidates, account, timeout_seconds)
    elif shutil.which("secret-tool"):
        keyring_source = "secret_tool"
        keyring_status = _secret_tool_status(candidates, timeout_seconds)
    else:
        keyring_source = "none"
        keyring_status = "missing"

    if keyring_status == "present":
        return True, keyring_source, "present"

    # Keyring miss -> the runtime's next backend: the whatsoup .key file store (the de-facto fleet
    # provisioning store). Presence here means the runtime CAN resolve the key.
    if whatsoup_keyfile_present(service):
        return True, "whatsoup_keyfile", "present"

    # Not resolvable by the runtime. A populated ocw .env is a misplacement diagnostic only.
    if secret_file_has_service_key(service, env_key):
        return False, "secret_file", "present_in_ocw_env_only_not_runtime_store"

    if keyring_status == "timeout" or keyring_status.startswith("probe_error_"):
        return False, keyring_source, keyring_status
    if keyring_status == "empty":
        return False, keyring_source, "empty"
    return False, keyring_source, "missing"


def opencode_provider_credential_fragments(data: dict[str, Any], target: str, timeout_seconds: int) -> tuple[bool | None, list[str]]:
    model = provider_model_from_config(data, target)
    service = opencode_key_service_for_model(model)
    fragments = [
        f"credential_model={redact_evidence_string(model or 'default', 100)}",
        f"credential_required={str(service is not None).lower()}",
    ]
    if service is None:
        fragments.append("credential_status=not_applicable")
        return None, fragments
    env_key = service_env_var(service)
    present, source, status = provider_credential_presence(service, timeout_seconds)
    fragments.extend([
        f"credential_service={redact_evidence_string(service, 80)}",
        f"credential_env={redact_evidence_string(env_key or 'unknown', 80)}",
        f"credential_source={redact_evidence_string(source, 80)}",
        f"credential_status={redact_evidence_string(status, 80)}",
        f"credential_present={str(present).lower()}",
    ])
    return present, fragments


def detect_opencode_mode(help_text: str, run_help_text: str) -> str:
    combined = f"{help_text}\n{run_help_text}".lower()
    run_help = run_help_text.lower()
    if (
        "--format" in run_help
        and "--pure" in run_help
        and ("-m" in run_help or "--model" in run_help)
        and ("usage" in run_help or "opencode run" in run_help)
    ):
        return "modern-run"
    if (
        ("--prompt" in combined or "-p, --prompt" in combined or ' -p "' in combined)
        and ("--output-format" in combined or "-f, --output-format" in combined)
        and "json" in combined
    ):
        return "legacy-prompt-json"
    return "unsupported"


def executable_candidate(command_name: str) -> str | None:
    configured_dirs = [
        part.strip()
        for part in os.environ.get("BOT_ERRORS_PROVIDER_BIN_DIRS", "").split(os.pathsep)
        if part.strip()
    ]
    candidate_dirs = [
        *configured_dirs,
        str(Path.home() / ".local/share/whatsoup/npm-global/bin"),
    ]
    try:
        nvmrc_version = (REPO_ROOT / ".nvmrc").read_text(encoding="utf-8").strip()
    except OSError:
        nvmrc_version = ""
    if nvmrc_version:
        candidate_dirs.append(str(Path.home() / ".nvm/versions/node" / f"v{nvmrc_version}" / "bin"))
    candidate_dirs.append(str(Path.home() / ".local/bin"))

    for directory in candidate_dirs:
        candidate = Path(directory) / command_name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return shutil.which(command_name)


def opencode_provider_probe_command(profile: dict[str, Any], item: dict[str, Any]) -> str:
    explicit_command = (
        profile_string(item, "opencodeProviderProbeCommand")
        or profile_string(profile, "opencodeProviderProbeCommand")
    )
    if explicit_command:
        return explicit_command

    generic_command = (
        profile_string(item, "providerProbeCommand")
        or profile_string(profile, "providerProbeCommand")
    )
    if generic_command and "opencode" in Path(generic_command).name.lower():
        return generic_command

    return executable_candidate("opencode") or "opencode"


def opencode_provider_probe_inventory(
    profile: dict[str, Any],
    item: dict[str, Any],
    name: str,
    data: dict[str, Any],
    provider: str,
    target: str = "primary",
) -> list[str]:
    command = opencode_provider_probe_command(profile, item)
    timeout_seconds = int_or_none(item.get("providerProbeTimeoutSeconds"))
    if timeout_seconds is None:
        timeout_seconds = int_or_none(profile.get("providerProbeTimeoutSeconds")) or 15
    timeout_seconds = max(1, min(timeout_seconds, 60))
    safe_command = redact_evidence_string(command, 120)
    configured_mode = opencode_command_mode_from_config(data, target)

    try:
        version_stdout, version_stderr, version_rc, _ = provider_command_output(
            [command, "--version"],
            timeout_seconds,
            "BOT_ERRORS_DRY_OPENCODE_VERSION_STDOUT",
            "BOT_ERRORS_DRY_OPENCODE_VERSION_STDERR",
            "BOT_ERRORS_DRY_OPENCODE_VERSION_RC",
        )
        help_stdout, help_stderr, help_rc, _ = provider_command_output(
            [command, "--help"],
            timeout_seconds,
            "BOT_ERRORS_DRY_OPENCODE_HELP_STDOUT",
            "BOT_ERRORS_DRY_OPENCODE_HELP_STDERR",
            "BOT_ERRORS_DRY_OPENCODE_HELP_RC",
        )
        run_help_stdout, run_help_stderr, run_help_rc, _ = provider_command_output(
            [command, "run", "--help"],
            timeout_seconds,
            "BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDOUT",
            "BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDERR",
            "BOT_ERRORS_DRY_OPENCODE_RUN_HELP_RC",
        )
    except Exception as exc:  # noqa: BLE001 - daily health should report provider probe failure.
        return [(
            f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
            f"failure_class=provider_compatibility_unsupported error={redact_evidence_string(str(exc), 180)} "
            "remediation=install_or_upgrade_opencode_modern_run_cli"
        )]

    version_text = "\n".join(part for part in [version_stdout, version_stderr] if part)
    version = next((line.strip() for line in version_text.splitlines() if line.strip()), "unknown")
    help_text = "\n".join(part for part in [help_stdout, help_stderr] if part)
    run_help_text = "\n".join(part for part in [run_help_stdout, run_help_stderr] if part)
    detected_mode = detect_opencode_mode(help_text, run_help_text)
    base = (
        f"provider_probe {name}: provider={provider} command={safe_command} "
        f"target={target} "
        f"version={redact_evidence_string(version, 80)} detected_mode={detected_mode} "
        f"configured_mode={redact_evidence_string(configured_mode, 80)} "
        f"version_rc={version_rc} help_rc={help_rc} run_help_rc={run_help_rc}"
    )

    if configured_mode not in {"auto", "modern-run", "legacy-prompt-json"}:
        return [(
            f"FAIL {base} failure_class=provider_compatibility_unsupported "
            "reason=invalid_opencode_command_mode "
            "remediation=set_agentOptions_providerConfig_opencodeCommandMode_to_auto_modern-run_or_legacy-prompt-json"
        )]
    if detected_mode == "unsupported":
        return [(
            f"FAIL {base} failure_class=provider_compatibility_unsupported "
            "reason=unsupported_opencode_cli_contract "
            "remediation=install_or_upgrade_opencode_modern_run_cli"
        )]
    if configured_mode != "auto" and configured_mode != detected_mode:
        return [(
            f"FAIL {base} failure_class=provider_compatibility_unsupported "
            "reason=configured_mode_does_not_match_detected_cli_contract "
            "remediation=align_opencodeCommandMode_or_upgrade_opencode"
        )]
    if detected_mode == "legacy-prompt-json":
        return [(
            f"FAIL {base} failure_class=provider_compatibility_degraded "
            "model_override=false session_resume=false "
            "reason=legacy_opencode_one_shot_json_cli "
            "remediation=install_or_upgrade_opencode_modern_run_cli_or_accept_degraded_legacy_mode_explicitly"
        )]

    credential_present, credential_fragments = opencode_provider_credential_fragments(data, target, timeout_seconds)
    if credential_present is False:
        return [(
            f"FAIL {base} failure_class=provider_credential_missing "
            + " ".join(credential_fragments)
            + " remediation=store_provider_key_in_service_visible_env_or_keyring"
        )]

    credential_suffix = " " + " ".join(credential_fragments) if credential_fragments else ""
    return [f"{base} status=ok model_override=true session_resume=true{credential_suffix}"]


def provider_command_output(
    command: list[str],
    timeout_seconds: int,
    dry_stdout_env: str,
    dry_stderr_env: str,
    dry_rc_env: str,
) -> tuple[str, str, int, bool]:
    dry_stdout = os.environ.get(dry_stdout_env)
    dry_stderr = os.environ.get(dry_stderr_env, "")
    dry_rc = os.environ.get(dry_rc_env)
    if dry_stdout is not None or dry_rc is not None:
        return dry_stdout or "", dry_stderr, int(dry_rc or "0"), False
    proc = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    return proc.stdout or "", proc.stderr or "", proc.returncode, False


def provider_keychain_status(text: str, rc: int) -> str:
    lower = text.lower()
    if "user interaction is not allowed" in lower or rc == 36:
        return "user_interaction_required"
    if "could not be found" in lower or "item not found" in lower:
        return "missing"
    if rc == 0:
        return "ok"
    return f"rc_{rc}"


def provider_secret_status(text: str, rc: int, stdout: str) -> str:
    lower = text.lower()
    if "user interaction is not allowed" in lower or rc == 36:
        return "user_interaction_required"
    if "could not be found" in lower or "item not found" in lower:
        return "missing"
    if rc == 0:
        return "ok" if stdout else "empty"
    return f"rc_{rc}"


def provider_keychain_unlock_status(keychain_path: Path, timeout_seconds: int) -> str:
    try:
        stdout, stderr, rc, _ = provider_command_output(
            ["security", "unlock-keychain", "-p", "", str(keychain_path)],
            min(timeout_seconds, 8),
            "BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_UNLOCK_STDOUT",
            "BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_UNLOCK_STDERR",
            "BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_UNLOCK_RC",
        )
    except subprocess.TimeoutExpired:
        return "timeout"
    except Exception as exc:  # noqa: BLE001 - diagnostics must never hide the provider failure.
        return f"probe_error_{redact_evidence_string(str(exc), 80)}"
    return provider_keychain_status("\n".join(part for part in [stdout, stderr] if part), rc)


def provider_keychain_unlock_allowed(profile: dict[str, Any], item: dict[str, Any]) -> bool:
    if "providerCredentialUnlockKeychain" in item:
        return profile_bool(item, "providerCredentialUnlockKeychain", False)
    if "providerCredentialUnlockKeychain" in profile:
        return profile_bool(profile, "providerCredentialUnlockKeychain", False)
    return env_flag("BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK", False)


def provider_host_uptime_seconds() -> int | None:
    dry_uptime = os.environ.get("BOT_ERRORS_DRY_UPTIME_SECONDS")
    if dry_uptime is not None:
        try:
            return int(float(dry_uptime))
        except ValueError:
            return None
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
                return int(time.time() - int(match.group(1)))
        except Exception:  # noqa: BLE001 - best-effort diagnostic only.
            return None
        return None
    try:
        return int(float(Path("/proc/uptime").read_text(encoding="utf-8").split()[0]))
    except Exception:  # noqa: BLE001 - best-effort diagnostic only.
        return None


def provider_settings_fragments() -> list[str]:
    dry = os.environ.get("BOT_ERRORS_DRY_PROVIDER_SETTINGS_JSON")
    if dry:
        try:
            loaded = json.loads(dry)
        except json.JSONDecodeError as exc:
            return [f"claude_settings_stat_error={redact_evidence_string(str(exc), 120)}"]
        if not isinstance(loaded, dict):
            return ["claude_settings_stat_error=not_object"]
        exists = bool(loaded.get("exists", False))
        mode = str(loaded.get("mode") or "unknown")
        owner_uid = loaded.get("ownerUid")
        expected_uid = loaded.get("expectedUid")
        writable = bool(loaded.get("writable", False))
    else:
        settings_path = Path.home() / ".claude" / "settings.json"
        if not settings_path.exists():
            return ["claude_settings_exists=false"]
        try:
            st = settings_path.stat()
        except OSError as exc:
            return [f"claude_settings_stat_error={redact_evidence_string(str(exc), 120)}"]
        exists = True
        mode = f"{stat.S_IMODE(st.st_mode):o}"
        owner_uid = st.st_uid
        expected_uid = os.geteuid()
        writable = os.access(settings_path, os.W_OK)

    fragments = [
        f"claude_settings_exists={str(exists).lower()}",
        f"claude_settings_mode={redact_evidence_string(mode, 20)}",
        f"claude_settings_writable={str(writable).lower()}",
    ]
    if isinstance(owner_uid, int):
        fragments.append(f"claude_settings_owner_uid={owner_uid}")
    if isinstance(expected_uid, int):
        fragments.append(f"claude_settings_expected_uid={expected_uid}")
    if isinstance(owner_uid, int) and isinstance(expected_uid, int):
        fragments.append(f"claude_settings_owner_mismatch={str(owner_uid != expected_uid).lower()}")
    return fragments


def provider_claude_state_fragments() -> list[str]:
    dry = os.environ.get("BOT_ERRORS_DRY_PROVIDER_CLAUDE_STATE_JSON")
    if dry:
        try:
            loaded = json.loads(dry)
        except json.JSONDecodeError as exc:
            return [f"claude_state_error={redact_evidence_string(str(exc), 120)}"]
        if not isinstance(loaded, dict):
            return ["claude_state_error=not_object"]
        fragments = [f"claude_state_exists={str(bool(loaded.get('exists', False))).lower()}"]
        for key, label in [
            ("mode", "claude_state_mode"),
            ("sizeBytes", "claude_state_size_bytes"),
            ("mtime", "claude_state_mtime"),
            ("backupCount", "claude_state_backup_count"),
            ("latestBackupMtime", "claude_state_latest_backup_mtime"),
        ]:
            value = loaded.get(key)
            if value is not None:
                fragments.append(f"{label}={redact_evidence_string(str(value), 80)}")
        for key, label in [
            ("userIdPresent", "claude_state_user_id_present"),
            ("oauthAccountPresent", "claude_state_oauth_account_present"),
            ("lastSessionPresent", "claude_state_last_session_present"),
        ]:
            value = loaded.get(key)
            if isinstance(value, bool):
                fragments.append(f"{label}={str(value).lower()}")
        project_count = loaded.get("projectCount")
        if isinstance(project_count, int):
            fragments.append(f"claude_state_project_count={project_count}")
        owner_uid = loaded.get("ownerUid")
        expected_uid = loaded.get("expectedUid")
        if isinstance(owner_uid, int):
            fragments.append(f"claude_state_owner_uid={owner_uid}")
        if isinstance(expected_uid, int):
            fragments.append(f"claude_state_expected_uid={expected_uid}")
        if isinstance(owner_uid, int) and isinstance(expected_uid, int):
            fragments.append(f"claude_state_owner_mismatch={str(owner_uid != expected_uid).lower()}")
        return fragments

    state_path = Path.home() / ".claude.json"
    if not state_path.exists():
        return ["claude_state_exists=false"]

    try:
        st = state_path.stat()
    except OSError as exc:
        return [f"claude_state_error={redact_evidence_string(str(exc), 120)}"]

    fragments = [
        "claude_state_exists=true",
        f"claude_state_mode={stat.S_IMODE(st.st_mode):o}",
        f"claude_state_size_bytes={st.st_size}",
        f"claude_state_mtime={epoch_to_iso(st.st_mtime) or 'unknown'}",
        f"claude_state_owner_uid={st.st_uid}",
        f"claude_state_expected_uid={os.geteuid()}",
        f"claude_state_owner_mismatch={str(st.st_uid != os.geteuid()).lower()}",
    ]
    try:
        loaded = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - malformed state is diagnostic signal.
        fragments.append(f"claude_state_parse=failed error={redact_evidence_string(str(exc), 120)}")
    else:
        if isinstance(loaded, dict):
            fragments.append("claude_state_parse=ok")
            fragments.append(f"claude_state_user_id_present={str(bool(loaded.get('userID'))).lower()}")
            fragments.append(f"claude_state_oauth_account_present={str(bool(loaded.get('oauthAccount'))).lower()}")
            projects = loaded.get("projects")
            if isinstance(projects, dict):
                fragments.append(f"claude_state_project_count={len(projects)}")
                has_last_session = any(
                    isinstance(value, dict) and bool(value.get("lastSessionId"))
                    for value in projects.values()
                )
                fragments.append(f"claude_state_last_session_present={str(has_last_session).lower()}")
            else:
                fragments.append("claude_state_project_count=unknown")
        else:
            fragments.append("claude_state_parse=not_object")

    backups_dir = Path.home() / ".claude" / "backups"
    try:
        backups = sorted(
            backups_dir.glob(".claude.json.backup.*"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        ) if backups_dir.exists() else []
        fragments.append(f"claude_state_backup_count={len(backups)}")
        if backups:
            fragments.append(f"claude_state_latest_backup_mtime={epoch_to_iso(backups[0].stat().st_mtime) or 'unknown'}")
    except OSError as exc:
        fragments.append(f"claude_state_backup_error={redact_evidence_string(str(exc), 120)}")
    return fragments


def dry_bool_fragment(name: str) -> str | None:
    raw = os.environ.get(name)
    if raw is None:
        return None
    return str(raw.strip().lower() in {"1", "true", "yes", "on"}).lower()


def defaults_read_fragment(domain: str, key: str, label: str, timeout_seconds: int) -> str | None:
    dry = os.environ.get(f"BOT_ERRORS_DRY_PROVIDER_{label.upper()}")
    if dry is not None:
        return f"{label}={redact_evidence_string(dry.strip() or 'missing', 80)}"
    if HOST_PLATFORM != "darwin":
        return None
    try:
        stdout, stderr, rc, _ = provider_command_output(
            ["defaults", "read", domain, key],
            min(timeout_seconds, 4),
            f"BOT_ERRORS_DRY_PROVIDER_{label.upper()}_STDOUT",
            f"BOT_ERRORS_DRY_PROVIDER_{label.upper()}_STDERR",
            f"BOT_ERRORS_DRY_PROVIDER_{label.upper()}_RC",
        )
    except subprocess.TimeoutExpired:
        return f"{label}=timeout"
    except Exception as exc:  # noqa: BLE001
        return f"{label}=probe_error_{redact_evidence_string(str(exc), 80)}"
    if rc != 0:
        combined = "\n".join(part for part in [stdout, stderr] if part)
        if "does not exist" in combined.lower():
            return f"{label}=missing"
        return f"{label}=rc_{rc}"
    return f"{label}={redact_evidence_string((stdout or '').strip() or 'empty', 80)}"


def provider_macos_session_fragments(account: str, timeout_seconds: int) -> list[str]:
    dry_inputs = any(
        os.environ.get(name) is not None
        for name in [
            "BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER",
            "BOT_ERRORS_DRY_PROVIDER_AUTOLOGIN_USER",
            "BOT_ERRORS_DRY_PROVIDER_KCPASSWORD_EXISTS",
            "BOT_ERRORS_DRY_PROVIDER_SOFTWAREUPDATE_AUTOINSTALL",
            "BOT_ERRORS_DRY_PROVIDER_SOFTWAREUPDATE_AUTODOWNLOAD",
        ]
    )
    if HOST_PLATFORM != "darwin" and not dry_inputs:
        return []

    fragments: list[str] = []
    console_user = os.environ.get("BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER")
    if console_user is None:
        try:
            stdout, stderr, rc, _ = provider_command_output(
                ["stat", "-f", "%Su", "/dev/console"],
                min(timeout_seconds, 4),
                "BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER_STDOUT",
                "BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER_STDERR",
                "BOT_ERRORS_DRY_PROVIDER_CONSOLE_USER_RC",
            )
            console_user = (stdout or stderr).strip() if rc == 0 else f"rc_{rc}"
        except subprocess.TimeoutExpired:
            console_user = "timeout"
        except Exception as exc:  # noqa: BLE001
            console_user = f"probe_error_{redact_evidence_string(str(exc), 80)}"
    console_user = redact_evidence_string((console_user or "unknown").strip() or "unknown", 80)
    fragments.append(f"console_user={console_user}")
    if console_user in {"root", "unknown", "_mbsetupuser"}:
        fragments.append("gui_session_status=loginwindow_or_no_console_user")
    elif console_user == account:
        fragments.append("gui_session_status=active_for_credential_account")
    else:
        fragments.append("gui_session_status=active_for_different_user")

    autologin = defaults_read_fragment(
        "/Library/Preferences/com.apple.loginwindow",
        "autoLoginUser",
        "autologin_user",
        timeout_seconds,
    )
    if autologin:
        fragments.append(autologin)

    kcpassword = dry_bool_fragment("BOT_ERRORS_DRY_PROVIDER_KCPASSWORD_EXISTS")
    if kcpassword is None and HOST_PLATFORM == "darwin":
        kcpassword = str(Path("/etc/kcpassword").exists()).lower()
    if kcpassword is not None:
        fragments.append(f"autologin_kcpassword_present={kcpassword}")

    auto_install = defaults_read_fragment(
        "/Library/Preferences/com.apple.SoftwareUpdate",
        "AutomaticallyInstallMacOSUpdates",
        "softwareupdate_autoinstall",
        timeout_seconds,
    )
    if auto_install:
        fragments.append(auto_install)
    auto_download = defaults_read_fragment(
        "/Library/Preferences/com.apple.SoftwareUpdate",
        "AutomaticDownload",
        "softwareupdate_autodownload",
        timeout_seconds,
    )
    if auto_download:
        fragments.append(auto_download)
    if "softwareupdate_autoinstall=1" in fragments or "softwareupdate_autoinstall=true" in fragments:
        fragments.append("unattended_update_reboot_risk=enabled")
    elif "softwareupdate_autoinstall=0" in fragments or "softwareupdate_autoinstall=false" in fragments:
        fragments.append("unattended_update_reboot_risk=disabled")
    uptime = provider_host_uptime_seconds()
    if uptime is not None:
        fragments.append(f"provider_host_uptime_seconds={uptime}")
    return fragments


def append_provider_auth_context(fragments: list[str]) -> None:
    credential_interaction_blocked = (
        "keychain_access_status=user_interaction_required" in fragments
        or "credential_secret_status=user_interaction_required" in fragments
    )
    if credential_interaction_blocked and "gui_session_status=loginwindow_or_no_console_user" in fragments:
        fragments.append("provider_auth_context=headless_login_keychain_blocked")
        uptime = provider_host_uptime_seconds()
        if uptime is not None and uptime <= 24 * 60 * 60:
            fragments.append("provider_auth_context=recent_reboot_headless_keychain_risk")
    elif credential_interaction_blocked and "gui_session_status=active_for_credential_account" in fragments:
        fragments.append("provider_auth_context=noninteractive_probe_keychain_blocked")


def provider_credential_fragments(profile: dict[str, Any], item: dict[str, Any], provider: str, timeout_seconds: int) -> list[str]:
    if provider != "claude-cli":
        return []
    dry_find = os.environ.get("BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDOUT")
    dry_find_rc = os.environ.get("BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_RC")
    dry_info = os.environ.get("BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDOUT")
    dry_info_rc = os.environ.get("BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_RC")
    if HOST_PLATFORM != "darwin" and dry_find is None and dry_find_rc is None and dry_info is None and dry_info_rc is None:
        return []

    service = (
        profile_string(item, "providerCredentialService")
        or profile_string(profile, "providerCredentialService")
        or ("Claude" + " " + "Code-credentials")
    )
    account = (
        profile_string(item, "providerCredentialAccount")
        or profile_string(profile, "providerCredentialAccount")
        or os.environ.get("USER")
        or Path.home().name
        or "unknown"
    )
    fragments = [
        "credential_backend=macos_keychain",
        f"credential_service={redact_evidence_string(service, 80)}",
        f"credential_account={redact_evidence_string(account, 80)}",
    ]
    keychain_path = Path.home() / "Library" / "Keychains" / "login.keychain-db"
    if provider_keychain_unlock_allowed(profile, item):
        fragments.append("keychain_unlock_policy=enabled")
        fragments.append(f"keychain_unlock_status={provider_keychain_unlock_status(keychain_path, timeout_seconds)}")
    else:
        fragments.append("keychain_unlock_policy=observe_only")
        fragments.append("keychain_unlock_status=skipped")

    try:
        stdout, stderr, rc, _ = provider_command_output(
            ["security", "find-generic-password", "-s", service, "-a", account, str(keychain_path)],
            min(timeout_seconds, 8),
            "BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDOUT",
            "BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_STDERR",
            "BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_FIND_RC",
        )
        status = provider_keychain_status("\n".join(part for part in [stdout, stderr] if part), rc)
        fragments.append(f"credential_item_status={status}")
    except subprocess.TimeoutExpired:
        fragments.append("credential_item_status=timeout")
    except Exception as exc:  # noqa: BLE001 - diagnostics must never hide the provider failure.
        fragments.append(f"credential_item_status=probe_error_{redact_evidence_string(str(exc), 80)}")

    try:
        stdout, stderr, rc, _ = provider_command_output(
            ["security", "find-generic-password", "-s", service, "-a", account, "-w", str(keychain_path)],
            min(timeout_seconds, 8),
            "BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_STDOUT",
            "BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_STDERR",
            "BOT_ERRORS_DRY_PROVIDER_CREDENTIAL_SECRET_RC",
        )
        status = provider_secret_status("\n".join(part for part in [stdout, stderr] if part), rc, stdout)
        fragments.append(f"credential_secret_status={status}")
    except subprocess.TimeoutExpired:
        fragments.append("credential_secret_status=timeout")
    except Exception as exc:  # noqa: BLE001 - diagnostics must never hide the provider failure.
        fragments.append(f"credential_secret_status=probe_error_{redact_evidence_string(str(exc), 80)}")

    try:
        stdout, stderr, rc, _ = provider_command_output(
            ["security", "show-keychain-info", str(keychain_path)],
            min(timeout_seconds, 8),
            "BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDOUT",
            "BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_STDERR",
            "BOT_ERRORS_DRY_PROVIDER_KEYCHAIN_INFO_RC",
        )
        status = provider_keychain_status("\n".join(part for part in [stdout, stderr] if part), rc)
        fragments.append(f"keychain_access_status={status}")
    except subprocess.TimeoutExpired:
        fragments.append("keychain_access_status=timeout")
    except Exception as exc:  # noqa: BLE001
        fragments.append(f"keychain_access_status=probe_error_{redact_evidence_string(str(exc), 80)}")

    fragments.extend(provider_settings_fragments())
    fragments.extend(provider_claude_state_fragments())
    fragments.extend(provider_macos_session_fragments(account, timeout_seconds))
    append_provider_auth_context(fragments)
    return fragments


def evidence_field(text: str | None, key: str) -> str | None:
    if not text:
        return None
    match = re.search(rf"(?:^|\s){re.escape(key)}=([^\s]+)", text)
    return match.group(1) if match else None


def evidence_int(text: str | None, key: str) -> int | None:
    value = evidence_field(text, key)
    return read_int(value)


def provider_live_session_fresh_seconds(profile: dict[str, Any], item: dict[str, Any]) -> int:
    configured = (
        int_or_none(item.get("providerLiveSessionFreshSeconds"))
        or int_or_none(profile.get("providerLiveSessionFreshSeconds"))
        or env_int("BOT_ERRORS_PROVIDER_LIVE_SESSION_FRESH_SECONDS", 30 * 60)
    )
    return max(1, min(configured, 24 * 60 * 60))


def provider_live_session_from_dry(provider: str, freshness_seconds: int) -> dict[str, Any] | None:
    raw = os.environ.get("BOT_ERRORS_DRY_PROVIDER_LIVE_SESSION_JSON")
    if raw is None:
        return None
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError as exc:
        return {
            "fresh": False,
            "active": 0,
            "alive": 0,
            "fragments": [f"live_provider_dry_error={redact_evidence_string(str(exc), 120)}"],
        }
    if not isinstance(loaded, dict):
        return {
            "fresh": False,
            "active": 0,
            "alive": 0,
            "fragments": ["live_provider_dry_error=not_object"],
        }
    active = read_int(loaded.get("activeSessions")) or read_int(loaded.get("active")) or 0
    alive = read_int(loaded.get("alivePids")) or read_int(loaded.get("alive")) or 0
    age = read_int(loaded.get("latestAgeSeconds"))
    provider_value = loaded.get("provider")
    provider_match = (
        not isinstance(provider_value, str)
        or not provider_value.strip()
        or provider_value.strip() == provider
    )
    fresh = bool(loaded.get("fresh")) if isinstance(loaded.get("fresh"), bool) else (
        provider_match and active > 0 and age is not None and age <= freshness_seconds
    )
    fragments = [
        "live_provider_source=dry",
        f"live_provider_provider_match={str(provider_match).lower()}",
        f"live_provider_active_sessions={active}",
        f"live_provider_alive_pids={alive}",
        f"live_provider_fresh={str(fresh).lower()}",
        f"live_provider_fresh_seconds={freshness_seconds}",
    ]
    if isinstance(provider_value, str) and provider_value.strip():
        fragments.append(f"live_provider_provider={redact_evidence_string(provider_value.strip(), 80)}")
    if age is not None:
        fragments.append(f"live_provider_latest_age_seconds={age}")
    latest_started_at = loaded.get("latestStartedAt")
    if isinstance(latest_started_at, str) and latest_started_at.strip():
        fragments.append(f"live_provider_latest_started_at={redact_evidence_string(latest_started_at.strip(), 80)}")
    if isinstance(loaded.get("transcriptPathInvalidMacHome"), bool):
        fragments.append(f"live_provider_transcript_path_legacy_home_bug={str(loaded['transcriptPathInvalidMacHome']).lower()}")
    return {
        "fresh": fresh,
        "active": active,
        "alive": alive,
        "fragments": fragments,
    }


def provider_live_session_from_health(provider: str, health_probe_line: str | None, freshness_seconds: int) -> dict[str, Any]:
    fragments: list[str] = []
    active = evidence_int(health_probe_line, "runtime_agent_active_sessions") or 0
    latest_started_at = evidence_field(health_probe_line, "runtime_agent_last_session_started_at")
    status = evidence_field(health_probe_line, "runtime_agent_last_session_status")
    providers = [
        evidence_field(health_probe_line, "runtime_agent_effective_provider"),
        evidence_field(health_probe_line, "runtime_agent_primary_provider"),
        evidence_field(health_probe_line, "runtime_agent_agent_provider"),
        evidence_field(health_probe_line, "instance_effective_provider"),
        evidence_field(health_probe_line, "instance_provider"),
    ]
    rendered_providers = [value for value in providers if isinstance(value, str) and value]
    provider_match = not rendered_providers or provider in rendered_providers
    if active > 0:
        fragments.append("live_provider_source=health")
        fragments.append(f"health_provider_active_sessions={active}")
    if rendered_providers:
        fragments.append("health_provider_candidates=" + ",".join(
            redact_evidence_string(value, 80) for value in dict.fromkeys(rendered_providers)
        ))
        fragments.append(f"health_provider_match={str(provider_match).lower()}")
    age: int | None = None
    if latest_started_at:
        started_epoch = parse_iso_epoch(latest_started_at)
        if started_epoch is not None:
            age = max(0, current_epoch() - started_epoch)
            fragments.append(f"health_provider_latest_age_seconds={age}")
        fragments.append(f"health_provider_latest_started_at={redact_evidence_string(latest_started_at, 80)}")
    if status:
        fragments.append(f"health_provider_last_session_status={redact_evidence_string(status, 40)}")
    fresh = provider_match and active > 0 and status == "active" and age is not None and age <= freshness_seconds
    if active > 0:
        fragments.append(f"health_provider_fresh={str(fresh).lower()}")
    return {
        "fresh": fresh,
        "active": active if provider_match else 0,
        "alive": 0,
        "fragments": fragments,
    }


def provider_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def provider_process_command_matches(pid: int, provider: str, timeout_seconds: int) -> tuple[bool, str | None]:
    try:
        proc = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            capture_output=True,
            text=True,
            timeout=min(timeout_seconds, 4),
            check=False,
        )
    except Exception:  # noqa: BLE001 - process command is corroboration only.
        return False, None
    command = (proc.stdout or "").strip()
    if proc.returncode != 0 or not command:
        return False, None
    lower = command.lower()
    provider_lower = provider.lower()
    candidates = {provider_lower, provider_lower.replace("-cli", "")}
    return any(candidate and candidate in lower for candidate in candidates), hashlib.sha256(command.encode("utf-8")).hexdigest()[:16]


def provider_instance_db_path(name: str, data: dict[str, Any]) -> Path:
    paths = data.get("paths") if isinstance(data.get("paths"), dict) else {}
    raw = paths.get("dbPath") if isinstance(paths.get("dbPath"), str) else None
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".local/share/whatsoup/instances" / name / "bot.db"


def provider_live_session_from_db(
    name: str,
    data: dict[str, Any],
    provider: str,
    freshness_seconds: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    db_path = provider_instance_db_path(name, data)
    if not db_path.exists():
        return {
            "fresh": False,
            "active": 0,
            "alive": 0,
            "fragments": ["live_provider_db_present=false"],
        }
    fragments = ["live_provider_source=db", "live_provider_db_present=true"]
    try:
        conn = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=min(timeout_seconds, 4))
        conn.row_factory = sqlite3.Row
    except Exception as exc:  # noqa: BLE001 - daily health must keep going.
        return {
            "fresh": False,
            "active": 0,
            "alive": 0,
            "fragments": [f"live_provider_db_error={redact_evidence_string(str(exc), 120)}"],
        }
    try:
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'"
        ).fetchone()
        if table is None:
            return {
                "fresh": False,
                "active": 0,
                "alive": 0,
                "fragments": fragments + ["live_provider_db_agent_sessions=false"],
            }
        columns = {str(row["name"]) for row in conn.execute("PRAGMA table_info('agent_sessions')").fetchall()}
        provider_expr = "provider" if "provider" in columns else "NULL AS provider"
        transcript_expr = "transcript_path" if "transcript_path" in columns else "NULL AS transcript_path"
        last_message_expr = "last_message_at" if "last_message_at" in columns else "NULL AS last_message_at"
        rows = conn.execute(
            f"""
            SELECT id, claude_pid, {provider_expr}, status, started_at, {last_message_expr}, {transcript_expr}
            FROM agent_sessions
            WHERE status = 'active'
            ORDER BY id DESC
            LIMIT 8
            """
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        return {
            "fresh": False,
            "active": 0,
            "alive": 0,
            "fragments": [f"live_provider_db_query_error={redact_evidence_string(str(exc), 120)}"],
        }
    finally:
        conn.close()

    config_provider = provider_from_config(data)
    matched_rows = [
        row for row in rows
        if (isinstance(row["provider"], str) and row["provider"] == provider)
        or (row["provider"] is None and config_provider == provider)
    ]
    fragments.append(f"live_provider_db_active_rows={len(rows)}")
    fragments.append(f"live_provider_active_sessions={len(matched_rows)}")
    if rows and not matched_rows:
        fragments.append("live_provider_provider_match=false")
    alive = 0
    command_matches = 0
    command_hash: str | None = None
    latest_epoch: int | None = None
    latest_at: str | None = None
    legacy_home_bug = False
    for row in matched_rows:
        transcript_path = row["transcript_path"]
        if isinstance(transcript_path, str) and "/.claude/projects/-home-" in transcript_path:
            legacy_home_bug = True
        pid = read_int(row["claude_pid"])
        if pid is not None and provider_process_alive(pid):
            alive += 1
            command_match, hashed = provider_process_command_matches(pid, provider, timeout_seconds)
            if command_match:
                command_matches += 1
            if hashed and command_hash is None:
                command_hash = hashed
        for raw_at in [row["last_message_at"], row["started_at"]]:
            epoch = parse_iso_epoch(raw_at)
            if epoch is not None and (latest_epoch is None or epoch > latest_epoch):
                latest_epoch = epoch
                latest_at = raw_at
    fragments.append(f"live_provider_alive_pids={alive}")
    fragments.append(f"live_provider_pid_command_matches={command_matches}")
    if command_hash:
        fragments.append(f"live_provider_pid_command_hash={command_hash}")
    if latest_epoch is not None:
        age = max(0, current_epoch() - latest_epoch)
        fragments.append(f"live_provider_latest_age_seconds={age}")
        if latest_at:
            fragments.append(f"live_provider_latest_activity_at={redact_evidence_string(str(latest_at), 80)}")
    else:
        age = None
    fragments.append(f"live_provider_transcript_path_legacy_home_bug={str(legacy_home_bug).lower()}")
    fresh = len(matched_rows) > 0 and alive > 0 and age is not None and age <= freshness_seconds
    fragments.append(f"live_provider_fresh={str(fresh).lower()}")
    return {
        "fresh": fresh,
        "active": len(matched_rows),
        "alive": alive,
        "fragments": fragments,
    }


def provider_live_session_evidence(
    profile: dict[str, Any],
    item: dict[str, Any],
    name: str,
    data: dict[str, Any],
    provider: str,
    timeout_seconds: int,
    health_probe_line: str | None,
) -> dict[str, Any]:
    freshness_seconds = provider_live_session_fresh_seconds(profile, item)
    dry = provider_live_session_from_dry(provider, freshness_seconds)
    if dry is not None:
        return dry
    health = provider_live_session_from_health(provider, health_probe_line, freshness_seconds)
    db = provider_live_session_from_db(name, data, provider, freshness_seconds, timeout_seconds)
    fresh = bool(health["fresh"] or db["fresh"])
    fragments = [
        *health["fragments"],
        *db["fragments"],
        f"live_provider_corroboration_fresh_seconds={freshness_seconds}",
        f"live_provider_corroboration_fresh={str(fresh).lower()}",
    ]
    return {
        "fresh": fresh,
        "active": max(int(health["active"]), int(db["active"])),
        "alive": int(db["alive"]),
        "fragments": fragments,
    }


def provider_probe_contradicted_by_live_service(
    failure_class: str,
    credential_fragments: list[str],
    live_evidence: dict[str, Any],
) -> bool:
    probe_context_blocked = (
        "provider_auth_context=headless_login_keychain_blocked" in credential_fragments
        or "provider_auth_context=noninteractive_probe_keychain_blocked" in credential_fragments
    )
    return (
        failure_class == "provider_auth_required"
        and probe_context_blocked
        and bool(live_evidence.get("fresh"))
        and (int(live_evidence.get("active") or 0) > 0 or int(live_evidence.get("alive") or 0) > 0)
    )


def provider_probe_inconclusive_due_to_headless_auth(
    failure_class: str,
    credential_fragments: list[str],
) -> bool:
    if failure_class != "provider_auth_required":
        return False
    probe_context_blocked = (
        "provider_auth_context=headless_login_keychain_blocked" in credential_fragments
        or "provider_auth_context=noninteractive_probe_keychain_blocked" in credential_fragments
    )
    if not probe_context_blocked:
        return False
    required_clean_auth_markers = {
        "claude_settings_exists=true",
        "claude_settings_owner_mismatch=false",
        "claude_settings_writable=true",
        "claude_state_exists=true",
        "claude_state_user_id_present=true",
        "claude_state_oauth_account_present=true",
        "claude_state_owner_mismatch=false",
    }
    if not required_clean_auth_markers.issubset(set(credential_fragments)):
        return False
    credential_item_status_acceptable = (
        "credential_item_status=ok" in credential_fragments
        or (
            "credential_item_status=user_interaction_required" in credential_fragments
            and (
                "keychain_access_status=user_interaction_required" in credential_fragments
                or "credential_secret_status=user_interaction_required" in credential_fragments
            )
        )
    )
    if not credential_item_status_acceptable:
        return False
    hard_negative_markers = {
        "credential_item_status=missing",
        "credential_secret_status=missing",
        "credential_secret_status=empty",
        "keychain_access_status=missing",
        "claude_settings_owner_mismatch=true",
        "claude_settings_writable=false",
        "claude_state_exists=false",
        "claude_state_parse=failed",
        "claude_state_user_id_present=false",
        "claude_state_oauth_account_present=false",
        "claude_state_owner_mismatch=true",
    }
    return not any(
        fragment == marker or fragment.startswith(f"{marker} ")
        for marker in hard_negative_markers
        for fragment in credential_fragments
    )


def provider_probe_inventory(
    profile: dict[str, Any],
    item: dict[str, Any],
    name: str,
    data: dict[str, Any],
    expectation: str,
    health_probe_line: str | None = None,
) -> list[str]:
    if not provider_probe_enabled(profile, item):
        return []
    if expectation in {"blocked", "none", "no_bot", "on_demand"}:
        return [f"provider_probe {name}: skipped expected={expectation}"]
    kind = data.get("type", "unknown")
    if kind != "agent":
        return [f"provider_probe {name}: skipped type={redact_evidence_string(str(kind), 80)}"]
    explicit_provider = (
        profile_string(item, "providerProbeProvider")
        or profile_string(profile, "providerProbeProvider")
    )
    if explicit_provider:
        lines = provider_probe_target_inventory(
            profile,
            item,
            name,
            data,
            explicit_provider,
            "configured",
            health_probe_line,
        )
        fallback_provider = fallback_provider_from_config(data)
        if fallback_provider and fallback_provider != explicit_provider:
            lines.extend(provider_probe_target_inventory(
                profile,
                item,
                name,
                data,
                fallback_provider,
                "fallback",
                health_probe_line,
            ))
        return lines

    primary_provider = provider_from_config(data)
    lines = provider_probe_target_inventory(
        profile,
        item,
        name,
        data,
        primary_provider,
        "primary",
        health_probe_line,
    )
    fallback_provider = fallback_provider_from_config(data)
    if fallback_provider and fallback_provider != primary_provider:
        lines.extend(provider_probe_target_inventory(
            profile,
            item,
            name,
            data,
            fallback_provider,
            "fallback",
            health_probe_line,
        ))
    return lines


def provider_probe_target_inventory(
    profile: dict[str, Any],
    item: dict[str, Any],
    name: str,
    data: dict[str, Any],
    provider: str,
    target: str,
    health_probe_line: str | None = None,
) -> list[str]:
    if provider == "opencode-cli":
        return opencode_provider_probe_inventory(profile, item, name, data, provider, target)
    if provider != "claude-cli":
        return [f"provider_probe {name}: skipped provider={redact_evidence_string(provider, 80)} target={target}"]

    command = (
        profile_string(item, "providerProbeCommand")
        or profile_string(profile, "providerProbeCommand")
        or shutil.which("claude")
        or "claude"
    )
    timeout_seconds = int_or_none(item.get("providerProbeTimeoutSeconds"))
    if timeout_seconds is None:
        timeout_seconds = int_or_none(profile.get("providerProbeTimeoutSeconds")) or 15
    timeout_seconds = max(1, min(timeout_seconds, 60))

    timed_out = False
    try:
        stdout, stderr, rc, timed_out = provider_command_output(
            [command, "--print", "Return exactly OK."],
            timeout_seconds,
            "BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT",
            "BOT_ERRORS_DRY_PROVIDER_PROBE_STDERR",
            "BOT_ERRORS_DRY_PROVIDER_PROBE_RC",
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        rc = 124
        timed_out = True
    except Exception as exc:  # noqa: BLE001 - daily health should report provider probe failure.
        safe_command = redact_evidence_string(command, 120)
        return [f"FAIL provider_probe {name}: provider={provider} target={target} command={safe_command} failure_class=provider_probe_failed error={redact_evidence_string(str(exc), 180)}"]

    combined = "\n".join(part for part in [stdout, stderr] if part)
    failure_class = classify_provider_probe_failure(combined, rc, timed_out)
    safe_command = redact_evidence_string(command, 120)
    output_excerpt = redact_evidence_string(combined or stdout or stderr, 180)
    if failure_class:
        credential_fragments = provider_credential_fragments(profile, item, provider, timeout_seconds)
        live_evidence = provider_live_session_evidence(
            profile,
            item,
            name,
            data,
            provider,
            timeout_seconds,
            health_probe_line,
        )
        contradicted = provider_probe_contradicted_by_live_service(
            failure_class,
            credential_fragments,
            live_evidence,
        )
        headless_auth_inconclusive = provider_probe_inconclusive_due_to_headless_auth(
            failure_class,
            credential_fragments,
        )
        if contradicted:
            line = (
                f"provider_probe {name}: provider={provider} target={target} command={safe_command} "
                f"status=advisory_contradicted failure_class={failure_class} rc={rc} "
                "provider_probe_signal=contradicted_by_live_service "
                "trust_level=live_service_evidence_over_headless_probe"
            )
        elif headless_auth_inconclusive:
            line = (
                f"provider_probe {name}: provider={provider} target={target} command={safe_command} "
                f"status=advisory_inconclusive failure_class={failure_class} rc={rc} "
                "provider_probe_signal=headless_auth_probe_blocked "
                "trust_level=local_auth_state_over_headless_probe"
            )
        else:
            line = (
                f"FAIL provider_probe {name}: provider={provider} target={target} command={safe_command} "
                f"failure_class={failure_class} rc={rc}"
            )
        if output_excerpt:
            line += f" output={output_excerpt}"
        if credential_fragments:
            line += " " + " ".join(credential_fragments)
        live_fragments = live_evidence.get("fragments")
        if isinstance(live_fragments, list) and live_fragments:
            line += " " + " ".join(str(fragment) for fragment in live_fragments)
        return [line]
    line = f"provider_probe {name}: provider={provider} target={target} command={safe_command} status=ok rc={rc}"
    if output_excerpt:
        line += f" output={output_excerpt}"
    return [line]


def fleet_api_endpoint(raw_url: str) -> str:
    url = raw_url.rstrip("/")
    if url.endswith("/api/lines") or url.endswith("/api/instances"):
        return url
    return f"{url}/api/lines"


def fleet_api_profile_value(profile: dict[str, Any], key: str) -> str | None:
    value = profile.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    fleet_api = profile.get("fleetApi") if isinstance(profile.get("fleetApi"), dict) else {}
    nested = fleet_api.get(key)
    if isinstance(nested, str) and nested.strip():
        return nested.strip()
    return None


def fleet_api_profile_port(profile: dict[str, Any]) -> str | None:
    fleet_api = profile.get("fleetApi") if isinstance(profile.get("fleetApi"), dict) else {}
    for source in (profile, fleet_api):
        for key in ("fleetApiPort", "port"):
            value = source.get(key)
            if isinstance(value, int):
                return str(value)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def fleet_api_default_url(profile: dict[str, Any]) -> str:
    raw_bind = (
        os.environ.get("FLEET_BIND_ADDRESS")
        or fleet_api_profile_value(profile, "fleetBindAddress")
        or fleet_api_profile_value(profile, "bindAddress")
        or "127.0.0.1"
    )
    bind = raw_bind.strip()
    if bind in {"", "0.0.0.0", "::", "[::]"}:
        bind = "127.0.0.1"
    elif ":" in bind and not bind.startswith("["):
        bind = f"[{bind}]"
    port = (
        os.environ.get("BOT_ERRORS_FLEET_API_PORT")
        or fleet_api_profile_port(profile)
        or "9099"
    ).strip()
    return f"http://{bind}:{port}"


def read_fleet_token_text(path: Path) -> tuple[str | None, str | None]:
    absolute = Path(os.path.abspath(os.fspath(path)))
    if len(absolute.parts) >= 2:
        platform_root = Path(absolute.parts[0]) / absolute.parts[1]
        if platform_root in {Path("/tmp"), Path("/var")} and platform_root.is_symlink():
            absolute = Path(os.path.realpath(platform_root)).joinpath(*absolute.parts[2:])
    parts = absolute.parts
    no_follow = getattr(os, "O_NOFOLLOW", None)
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if no_follow is None or directory_flag is None or len(parts) < 2:
        return None, "token_secure_open_unavailable"

    common_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    parent_fd = os.open(parts[0], common_flags | directory_flag)
    try:
        for depth, part in enumerate(parts[1:-1], start=1):
            try:
                next_fd = os.open(part, common_flags | directory_flag | no_follow, dir_fd=parent_fd)
            except OSError as exc:
                error_name = errno.errorcode.get(exc.errno, "UNKNOWN")
                return None, f"token_parent_refused errno={error_name} depth={depth}"
            os.close(parent_fd)
            parent_fd = next_fd

        leaf = parts[-1]
        try:
            file_fd = os.open(
                leaf,
                common_flags | no_follow | getattr(os, "O_NONBLOCK", 0),
                dir_fd=parent_fd,
            )
        except OSError as exc:
            try:
                leaf_stat = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            except OSError:
                leaf_stat = None
            if leaf_stat is not None and stat.S_ISLNK(leaf_stat.st_mode):
                return None, "token_symlink_refused"
            return None, f"token_unreadable error={redact_evidence_string(str(exc), 160)}"

        try:
            st = os.fstat(file_fd)
            mode = stat.S_IMODE(st.st_mode)
            if not stat.S_ISREG(st.st_mode):
                return None, "token_non_regular_refused"
            if mode & 0o077:
                return None, f"token_mode_too_open mode={mode:o}"
            if not mode & 0o400:
                return None, f"token_owner_read_required mode={mode:o}"
            with os.fdopen(file_fd, "r", encoding="utf-8") as handle:
                file_fd = -1
                return handle.read(), None
        finally:
            if file_fd >= 0:
                os.close(file_fd)
    finally:
        os.close(parent_fd)


def load_fleet_api_token(profile: dict[str, Any]) -> tuple[str | None, str, int, str | None]:
    dry = os.environ.get("BOT_ERRORS_DRY_FLEET_TOKEN_JSON")
    token_path = (
        os.environ.get("BOT_ERRORS_FLEET_TOKEN_FILE")
        or fleet_api_profile_value(profile, "fleetApiTokenFile")
        or str(Path.home() / ".config/whatsoup/fleet-tokens.json")
    )
    source = "dry" if dry is not None else f"file {credential_path_ref(token_path, prefix='token_source_path')}"
    try:
        if dry is not None:
            raw = dry
        else:
            path = Path(token_path).expanduser()
            raw, read_error = read_fleet_token_text(path)
            if read_error is not None:
                return None, source, 0, read_error
            assert raw is not None
        loaded = json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - health evidence should include token-source failures.
        return None, source, 0, f"token_unreadable error={redact_evidence_string(str(exc), 160)}"
    if not isinstance(loaded, dict):
        return None, source, 0, "token_json_root_not_object"
    active = loaded.get("active")
    accept = loaded.get("accept")
    accept_count = len(accept) if isinstance(accept, list) else 0
    if not isinstance(active, str) or not active.strip():
        return None, source, accept_count, "active_token_missing"
    return active.strip(), source, accept_count, None


def format_fleet_api_response(endpoint: str, status: int, body: str, token_source: str, active_token_present: bool, accept_count: int) -> str:
    common = (
        f"status={status} endpoint={endpoint} token_source={token_source} "
        f"active_token_present={str(active_token_present).lower()} accept_count={accept_count}"
    )
    if status in {401, 403}:
        return f"FAIL fleet_api: fleet_api_auth_failed {common}"
    if status < 200 or status >= 500:
        return f"FAIL fleet_api: fleet_api_unhealthy {common}"
    try:
        data = json.loads(body)
    except Exception as exc:  # noqa: BLE001
        return f"FAIL fleet_api: invalid_json {common} error={str(exc)[:160]}"
    if isinstance(data, list):
        instances = data
    elif isinstance(data, dict) and isinstance(data.get("instances"), list):
        instances = data["instances"]
    elif isinstance(data, dict) and isinstance(data.get("lines"), list):
        instances = data["lines"]
    else:
        return f"FAIL fleet_api: invalid_response {common}"
    names = sorted(
        item.get("name")
        for item in instances
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    )
    return f"fleet_api: {common} instances={len(instances)} names={','.join(names) if names else 'none'}"


def fleet_api_inventory(profile: dict[str, Any]) -> list[str]:
    if not profile_bool(profile, "expectFleetApi", False):
        return ["fleet_api: skipped by health profile"]

    raw_url = (
        os.environ.get("BOT_ERRORS_FLEET_API_URL")
        or fleet_api_profile_value(profile, "fleetApiUrl")
        or fleet_api_default_url(profile)
    )
    endpoint = fleet_api_endpoint(raw_url)
    token, token_source, accept_count, token_error = load_fleet_api_token(profile)
    if token_error:
        return [f"FAIL fleet_api: {token_error} token_source={token_source} active_token_present=false accept_count={accept_count}"]

    dry_error = os.environ.get("BOT_ERRORS_DRY_FLEET_API_ERROR")
    if dry_error:
        return [f"FAIL fleet_api: fleet_api_unreachable endpoint={endpoint} token_source={token_source} error={dry_error[:160]}"]
    dry_status = os.environ.get("BOT_ERRORS_DRY_FLEET_API_STATUS")
    if dry_status is not None:
        body = os.environ.get("BOT_ERRORS_DRY_FLEET_API_BODY", "{}")
        return [format_fleet_api_response(endpoint, int(dry_status), body, token_source, bool(token), accept_count)]

    req = Request(endpoint, method="GET", headers={"Authorization": f"Bearer {token}"})
    try:
        with urlopen(req, timeout=HEALTH_PROBE_TIMEOUT_SECONDS) as response:
            body = response.read(256 * 1024).decode("utf-8", errors="replace")
            return [format_fleet_api_response(endpoint, response.status, body, token_source, True, accept_count)]
    except HTTPError as exc:
        body = exc.read(64 * 1024).decode("utf-8", errors="replace")
        return [format_fleet_api_response(endpoint, exc.code, body, token_source, True, accept_count)]
    except URLError as exc:
        return [f"FAIL fleet_api: fleet_api_unreachable endpoint={endpoint} token_source={token_source} error={exc.reason}"]
    except Exception as exc:  # noqa: BLE001
        return [f"FAIL fleet_api: fleet_api_probe_failed endpoint={endpoint} token_source={token_source} error={str(exc)[:160]}"]


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
        return ([path] if path.exists() or path.is_symlink() else []), str(path)
    if "/" in requirement or requirement.startswith("~"):
        path = required_file_path(root, requirement)
        return ([path] if path.exists() or path.is_symlink() else []), str(path)
    if not root.exists():
        return [], str(root / requirement)
    matches = sorted(path for path in root.rglob(requirement) if path.is_file() or path.is_symlink())
    return matches, str(root / "**" / requirement)


def credential_parent_dir_issues(root: Path, path: Path) -> list[str]:
    try:
        relative_parts = path.relative_to(root).parts[:-1]
        directories = [root]
        current = root
        for part in relative_parts:
            current = current / part
            directories.append(current)
    except ValueError:
        directories = [path.parent]

    issues: list[str] = []
    for directory in directories:
        parent_ref = credential_path_ref(directory, prefix="parent_path")
        try:
            st = directory.lstat()
        except OSError as exc:
            issues.append(f"parent_stat_failed {parent_ref} error={redact_evidence_string(str(exc), 160)}")
            continue
        mode = stat.S_IMODE(st.st_mode)
        if stat.S_ISLNK(st.st_mode):
            issues.append(f"parent_symlink {parent_ref} mode={mode:o}")
        elif not stat.S_ISDIR(st.st_mode):
            issues.append(f"parent_not_directory {parent_ref} mode={mode:o}")
        elif mode > 0o700:
            issues.append(f"parent_mode>{0o700:o} {parent_ref} mode={mode:o}")
    return issues


def required_credential_inventory(profile: dict[str, Any]) -> list[str]:
    requirements = credential_requirements(profile)
    if not requirements:
        return ["required_credentials: none declared"]
    root = Path.home() / ".config/whatsoup"
    lines: list[str] = []
    for requirement in requirements:
        requirement_ref = credential_requirement_ref(requirement)
        paths, expected = credential_requirement_paths(root, requirement)
        if not paths:
            lines.append(
                f"FAIL credential: {requirement_ref} missing required "
                f"{credential_path_ref(expected, prefix='expected_path')}"
            )
            continue
        for path in paths:
            path_ref = credential_path_ref(path)
            parent_issues = credential_parent_dir_issues(root, path)
            for issue in parent_issues:
                lines.append(f"FAIL credential: {requirement_ref} {issue} {path_ref}")
            try:
                st = path.lstat()
            except OSError as exc:
                lines.append(
                    f"FAIL credential: {requirement_ref} stat_failed "
                    f"{path_ref} error={redact_evidence_string(str(exc), 160)}"
                )
                continue
            mode = stat.S_IMODE(st.st_mode)
            age_days = int((time.time() - st.st_mtime) / 86400)
            if stat.S_ISLNK(st.st_mode):
                lines.append(f"FAIL credential: {requirement_ref} symlink {path_ref} mode={mode:o} age_days={age_days}")
            elif not stat.S_ISREG(st.st_mode):
                lines.append(f"FAIL credential: {requirement_ref} non_regular {path_ref} mode={mode:o} age_days={age_days}")
            elif not file_readable(path, mode):
                lines.append(f"FAIL credential: {requirement_ref} unreadable {path_ref} mode={mode:o} age_days={age_days}")
            elif mode & 0o022:
                lines.append(f"FAIL credential: {requirement_ref} world_writable {path_ref} mode={mode:o} age_days={age_days}")
            elif mode & 0o077:
                lines.append(f"FAIL credential: {requirement_ref} non_private {path_ref} mode={mode:o} age_days={age_days}")
            elif parent_issues:
                continue
            else:
                lines.append(f"OK credential: {requirement_ref} {path_ref} mode={mode:o} age_days={age_days}")
    return lines


def required_credential_existing_paths(profile: dict[str, Any]) -> set[Path]:
    root = Path.home() / ".config/whatsoup"
    paths: set[Path] = set()
    for requirement in credential_requirements(profile):
        matches, _ = credential_requirement_paths(root, requirement)
        paths.update(path.absolute() for path in matches)
    return paths


def config_mode_line(name: str, requirement: str, path: Path, mode: int, strict_max: int | None) -> str | None:
    path_ref = credential_path_ref(path, prefix="config_path") if path.name in ROOT_CREDENTIAL_FILES or path.name == "tokens.env" else f"path={path}"
    if strict_max is not None and mode > strict_max:
        return f"FAIL config {name}: mode>{strict_max:o} required {requirement} {path_ref} mode={mode:o}"
    if mode & 0o004:
        return f"WARN config {name}: world_readable required {requirement} {path_ref} mode={mode:o}"
    return None


def auth_bond_inventory(name: str, instance_root: Path, expectation: str) -> list[str]:
    auth_dir = instance_root / "auth"
    creds = auth_dir / "creds.json"
    try:
        auth_lstat = auth_dir.lstat()
    except OSError:
        auth_lstat = None
    try:
        creds_lstat = creds.lstat()
    except OSError:
        creds_lstat = None
    auth_exists = auth_lstat is not None and stat.S_ISDIR(auth_lstat.st_mode)
    creds_exists = creds_lstat is not None and stat.S_ISREG(creds_lstat.st_mode)
    if auth_lstat is not None and stat.S_ISLNK(auth_lstat.st_mode):
        return [f"FAIL auth_bond {name}: auth_dir_symlink=true credential_paths_redacted=true"]
    if creds_lstat is not None and stat.S_ISLNK(creds_lstat.st_mode):
        return [f"FAIL auth_bond {name}: creds_symlink=true credential_paths_redacted=true"]
    if auth_lstat is not None and not stat.S_ISDIR(auth_lstat.st_mode):
        return [f"FAIL auth_bond {name}: auth_dir_not_directory=true credential_paths_redacted=true"]
    if creds_lstat is not None and not stat.S_ISREG(creds_lstat.st_mode):
        return [f"FAIL auth_bond {name}: creds_not_regular=true credential_paths_redacted=true"]
    if not auth_exists or not creds_exists:
        prefix = "FAIL " if expectation == "always_on" else "WARN "
        return [
            f"{prefix}auth_bond {name}: auth_dir_exists={auth_exists} creds_exists={creds_exists} "
            "credential_paths_redacted=true"
        ]

    raw: bytes = b""
    parsed: object = None
    last_exc: Exception | None = None
    parse_ok = False
    for attempt in range(AUTH_BOND_REINSPECT_ATTEMPTS):
        if attempt > 0:
            time.sleep(AUTH_BOND_REINSPECT_DELAY_S)
        try:
            raw = creds.read_bytes()
            if not raw:
                raise ValueError("creds.json is empty")
            parsed = json.loads(raw.decode("utf-8"))
            if isinstance(parsed, dict):
                parse_ok = True
                break
            return [
                f"FAIL auth_bond {name}: invalid creds_json=true credential_paths_redacted=true"
                f" root_type={type(parsed).__name__}"
            ]
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            raw = b""

    if not parse_ok:
        try:
            creds_mtime = creds.stat().st_mtime
        except OSError:
            return [
                f"FAIL auth_bond {name}: creds_deleted_during_retry=true"
                " credential_paths_redacted=true"
            ]
        creds_age = int(time.time() - creds_mtime)
        if creds_age > AUTH_BOND_STUCK_MTIME_S:
            err = redact_evidence_string(str(last_exc), 160) if last_exc else "unknown"
            return [
                f"FAIL auth_bond {name}: creds_json_empty_or_invalid_for_seconds={creds_age}"
                f" credential_paths_redacted=true error={err}"
            ]
        return [
            f"auth_bond {name}: creds_write_in_flight=true"
            f" creds_age_seconds={creds_age} credential_paths_redacted=true"
        ]

    me = parsed.get("me")
    me_payload = json.dumps(me, sort_keys=True, separators=(",", ":")) if isinstance(me, dict) else ""
    auth_mode = stat.S_IMODE(auth_dir.stat().st_mode)
    creds_stat = creds.stat()
    creds_mode = stat.S_IMODE(creds_stat.st_mode)
    creds_hash = hashlib.sha256(raw).hexdigest()[:20]
    me_hash = hashlib.sha256(me_payload.encode("utf-8")).hexdigest()[:20] if me_payload else "missing"
    mode_issues: list[str] = []
    if auth_mode > 0o700:
        mode_issues.append(f"auth_mode>{0o700:o}")
    if creds_mode > 0o600:
        mode_issues.append(f"creds_mode>{0o600:o}")
    prefix = "FAIL " if mode_issues else ""
    suffix = f" mode_violation={','.join(mode_issues)}" if mode_issues else ""
    return [
        f"{prefix}auth_bond {name}: present creds_hash={creds_hash} me_hash={me_hash} "
        f"auth_mode={auth_mode:o} creds_mode={creds_mode:o} "
        f"creds_mtime={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(creds_stat.st_mtime))}"
        f"{suffix}"
    ]


def local_auth_bond_duplicates(root: Path, names: list[str]) -> list[str]:
    by_hash: dict[str, list[str]] = {}
    for name in names:
        creds = root / name / "auth" / "creds.json"
        try:
            st = creds.lstat()
        except OSError:
            continue
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            continue
        try:
            digest = hashlib.sha256(creds.read_bytes()).hexdigest()[:20]
        except OSError:
            continue
        by_hash.setdefault(digest, []).append(name)
    lines: list[str] = []
    for digest, instances in sorted(by_hash.items()):
        if len(instances) > 1:
            lines.append(f"FAIL auth_bond_duplicate: creds_hash={digest} instances={','.join(sorted(instances))}")
    return lines


def unprofiled_config_inventory(root: Path, expected_names: set[str]) -> list[str]:
    lines: list[str] = []
    for cfg in sorted(root.glob("*/config.json")):
        name = cfg.parent.name
        if name in expected_names:
            continue
        data, error = read_instance_config(cfg)
        if error or data is None:
            lines.append(f"FAIL profile_coverage {name}: unprofiled config invalid JSON path={cfg} error={error}")
            continue
        if data.get("enabled", True) is False:
            continue
        kind = data.get("type", "unknown")
        port = data.get("healthPort")
        lines.append(
            f"FAIL profile_coverage {name}: enabled config not declared in health profile "
            f"type={kind} healthPort={port}"
        )
    return lines


SUPPORT_WHATSOUP_SERVICE_NAMES = {
    "dashboard",
    "fleet",
    "ms365-token-backup",
    "reply-guarantee",
    "whatsoup-fleet",
}


def active_whatsoup_service_names() -> set[str]:
    dry_services = os.environ.get("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES")
    if dry_services is not None:
        return {
            item.strip().removeprefix("com.whatsoup.")
            for item in dry_services.split(",")
            if item.strip()
        }
    if HOST_PLATFORM == "darwin" or is_wsl():
        try:
            proc = subprocess.run(
                ["launchctl", "list"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=3,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return set()
        names: set[str] = set()
        for line in proc.stdout.splitlines():
            parts = line.split()
            if len(parts) < 3:
                continue
            pid, label = parts[0], parts[-1]
            if pid == "-" or not label.startswith("com.whatsoup."):
                continue
            names.add(label.removeprefix("com.whatsoup."))
        return names
    try:
        proc = subprocess.run(
            ["systemctl", "--user", "list-units", "--type=service", "--state=running", "--no-legend"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return set()
    names = set()
    for line in proc.stdout.splitlines():
        unit = line.split(maxsplit=1)[0] if line.split() else ""
        if unit.startswith("whatsoup@") and unit.endswith(".service"):
            names.add(unit.removeprefix("whatsoup@").removesuffix(".service"))
    return names


def unprofiled_service_inventory(root: Path, expected_names: set[str]) -> list[str]:
    lines: list[str] = []
    for name in sorted(active_whatsoup_service_names()):
        if name in expected_names:
            continue
        if (
            name in SUPPORT_WHATSOUP_SERVICE_NAMES
            or name.endswith("-watchdog")
            or name.endswith("-parity-watcher")
        ):
            continue
        cfg = root / name / "config.json"
        lines.append(
            f"FAIL profile_coverage_service {name}: active service not declared in health profile "
            f"service=com.whatsoup.{name} config_exists={cfg.exists()}"
        )
    return lines


# Canonical restart-decision predicates in deploy/templates/watchdog-script.sh.
# #952 made the watchdog TOLERATE the `degraded` health status (a restart cannot fix a
# degraded/auth condition — it just resets the cold-start clock and re-fires alerts). A pre-#952
# watchdog restarts on anything != "healthy", so a degraded-but-connected bot false-positive flaps.
_WATCHDOG_DEGRADED_TOLERANT_RE = re.compile(
    r"""status\s+not\s+in\s*\(\s*["']healthy["']\s*,\s*["']degraded["']""", re.IGNORECASE
)
_WATCHDOG_DEGRADED_INTOLERANT_RE = re.compile(r"""status\s*!=\s*["']healthy["']""", re.IGNORECASE)


def classify_watchdog_policy(script_text: str) -> str:
    """Classify a rendered watchdog script's restart policy w.r.t. the `degraded` health status.

    Returns:
      'degraded_tolerant'   — #952: restarts only when status not in (healthy, degraded).
      'degraded_intolerant' — pre-#952: restarts on anything != healthy (false-flap on degraded).
      'unknown'             — no recognizable restart-decision line.
    """
    if _WATCHDOG_DEGRADED_TOLERANT_RE.search(script_text):
        return "degraded_tolerant"
    if _WATCHDOG_DEGRADED_INTOLERANT_RE.search(script_text):
        return "degraded_intolerant"
    return "unknown"


def watchdog_currency_inventory(names: list[str]) -> list[str]:
    """WARN when an installed per-instance watchdog is the stale pre-#952 (degraded-intolerant)
    template. macOS-only: the rendered `~/.local/bin/<inst>-watchdog` launchd scripts. Linux hosts
    supervise via systemd timers (different mechanism) and are skipped. Instances with no installed
    fleet-standard watchdog (KeepAlive-only / bespoke) are skipped here, not flagged — that is a
    separate divergence class. This check would have caught the 2026-06-23 fleet-wide stale-watchdog
    flap drift automatically."""
    if HOST_PLATFORM != "darwin":
        return []
    lines: list[str] = []
    bindir = Path.home() / ".local" / "bin"
    for name in sorted(set(names)):
        watchdog = bindir / f"{name}-watchdog"
        if not watchdog.is_file():
            continue
        try:
            text = watchdog.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            lines.append(
                f"WARN watchdog_currency {name}: unreadable watchdog={watchdog} "
                f"error={redact_evidence_string(str(exc), 80)}"
            )
            continue
        policy = classify_watchdog_policy(text)
        if policy == "degraded_intolerant":
            lines.append(
                f"WARN watchdog_currency {name}: stale_pre_952_watchdog restarts_on_degraded "
                f"(false_positive_flap_risk) watchdog={watchdog} "
                f"remediation=redeploy_degraded_tolerant_watchdog_template"
            )
        elif policy == "unknown":
            lines.append(
                f"WARN watchdog_currency {name}: unrecognized_restart_policy watchdog={watchdog}"
            )
    return lines


def tail_text(path: Path, max_bytes: int = 512 * 1024) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes), os.SEEK_SET)
            return handle.read(max_bytes).decode("utf-8", errors="replace")
    except OSError:
        return ""


def auth_failure_log_inventory(name: str, expectation: str, health_probe: str | None) -> list[str]:
    if expectation != "always_on" or not health_probe or "FAIL " not in health_probe:
        return []
    paths = [
        Path.home() / ".config" / "whatsoup" / "instances" / name / "stdout.log",
        Path.home() / ".local" / "share" / "whatsoup" / "instances" / name / "logs" / "whatsoup.log",
    ]
    for path in paths:
        text = tail_text(path)
        if not text:
            continue
        if "device_removed" in text:
            return [f"FAIL auth_bond {name}: physical_intervention_required recent_log_pattern=device_removed log={path}"]
        if text_has_terminal_auth_failure_class(text):
            return [f"FAIL auth_bond {name}: physical_intervention_required recent_log_pattern=terminal_auth_failure_class log={path}"]
        if '"statusCode":401' in text or '"reason":"loggedOut"' in text:
            return [f"FAIL auth_bond {name}: physical_intervention_required recent_log_pattern=loggedOut log={path}"]
    return []


def parse_iso_epoch(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        raw = f"{raw}T00:00:00Z"
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def primary_phone_verifications_path() -> Path:
    return Path(
        os.environ.get(
            "BOT_ERRORS_PRIMARY_PHONE_VERIFICATIONS",
            state_root() / "primary-phone-verifications.json",
        )
    ).expanduser()


def critical_file_present(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def primary_phone_verification_state_entry(name: str) -> tuple[dict[str, Any] | None, str | None]:
    path = primary_phone_verifications_path()
    if not critical_file_present(path):
        return None, None
    state, error = read_private_json_record(path)
    if error:
        return None, error
    if not state:
        return None, None
    instances = state.get("instances")
    candidates: list[Any] = []
    if isinstance(instances, dict):
        candidates.append(instances.get(name))
    candidates.append(state.get(name))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return {"lastVerifiedAt": candidate.strip()}, None
        if isinstance(candidate, dict):
            return candidate, None
    return None, None


def primary_phone_verification_value(item: dict[str, Any], name: str) -> tuple[str | None, str, str | None]:
    state_entry, state_error = primary_phone_verification_state_entry(name)
    if state_error:
        return None, "state_error", state_error
    if state_entry:
        state_value = profile_string(state_entry, "lastVerifiedAt", "last_verified_at", "primaryPhoneLastVerifiedAt")
        if state_value:
            return state_value, "state", None
    profile_value = profile_string(item, "primaryPhoneLastVerifiedAt", "primary_phone_last_verified_at")
    if profile_value:
        return profile_value, "profile", None
    return None, "missing", None


def write_primary_phone_verification(
    instance: str,
    owner: str,
    method: str,
    note: str,
    verified_at: str,
) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", instance):
        raise ValueError("instance must contain only letters, numbers, '.', '_' or '-'")
    verified_epoch = parse_iso_epoch(verified_at)
    if verified_epoch is None:
        raise ValueError("verified-at must be an ISO timestamp or YYYY-MM-DD")
    if verified_epoch > current_epoch() + 300:
        raise ValueError("verified-at cannot be more than 5 minutes in the future")

    path = primary_phone_verifications_path()
    state: dict[str, Any] = {"version": 1, "instances": {}}
    if critical_file_present(path):
        loaded, error = read_private_json_record(path)
        if error:
            raise ValueError(f"cannot update untrusted primary-phone verification state: {error}")
        if loaded:
            state = loaded
    instances = state.get("instances")
    if not isinstance(instances, dict):
        instances = {}
        state["instances"] = instances
    instances[instance] = {
        "lastVerifiedAt": epoch_to_iso(verified_epoch) or verified_at,
        "owner": redact_evidence_string(owner, 80) if owner else "unknown",
        "method": redact_evidence_string(method, 120) if method else "operator_linked_devices_check",
        "note": redact_event_text(note)[:240] if note else "",
        "recordedAt": now_iso(),
        "recordedBy": os.environ.get("USER") or os.environ.get("LOGNAME") or "unknown",
    }
    state["version"] = 1
    state["updatedAt"] = now_iso()
    atomic_write_json(path, state)
    return path


def primary_phone_verification_required(profile: dict[str, Any], item: dict[str, Any]) -> bool:
    if "primaryPhoneVerificationRequired" in item:
        return profile_bool(item, "primaryPhoneVerificationRequired", False)
    if "primary_phone_verification_required" in item:
        return profile_bool(item, "primary_phone_verification_required", False)
    return profile_bool(profile, "expectPrimaryPhoneVerification", False)


def primary_phone_unknown_severity(profile: dict[str, Any], item: dict[str, Any]) -> str:
    raw = (
        profile_string(item, "primaryPhoneUnknownSeverity", "primary_phone_unknown_severity")
        or profile_string(profile, "primaryPhoneUnknownSeverity", "primary_phone_unknown_severity")
        or "warning"
    )
    value = raw.strip().lower()
    if value in {"critical", "fail", "error"}:
        return "critical"
    if value in {"warning", "warn", "advisory", "info"}:
        return "warning"
    return "warning"


def primary_phone_verification_inventory(profile: dict[str, Any], item: dict[str, Any], name: str, expectation: str) -> list[str]:
    last_verified, last_verified_source, state_error = primary_phone_verification_value(item, name)
    required = primary_phone_verification_required(profile, item)
    if expectation != "always_on":
        if last_verified:
            return [
                f"primary_phone {name}: skipped expected={expectation} "
                f"last_verified_source={last_verified_source} last_verified_at={last_verified}"
            ]
        return []
    if not required and not last_verified:
        return []

    warn_days = int_or_none(item.get("primaryPhoneWarnDays")) or PRIMARY_PHONE_WARN_DAYS
    fail_days = int_or_none(item.get("primaryPhoneFailDays")) or PRIMARY_PHONE_FAIL_DAYS
    expiry_days = int_or_none(item.get("primaryPhoneExpiryDays")) or PRIMARY_PHONE_EXPIRY_DAYS
    owner = profile_string(item, "primaryPhoneOwner", "primary_phone_owner", "owner") or "unknown"
    line_base = (
        f"primary_phone {name}: owner={owner} required={required} "
        f"warn_days={warn_days} fail_days={fail_days} expiry_days={expiry_days} "
        "risk=linked_devices_logout_after_primary_phone_unused"
    )
    if state_error:
        return [
            f"FAIL primary_phone_state {name}: {state_error} "
            f"state_file={primary_phone_verifications_path()}"
        ]
    if not last_verified:
        unknown_severity = primary_phone_unknown_severity(profile, item)
        prefix = "FAIL " if required and unknown_severity == "critical" else "WARN "
        return [
            f"{prefix}{line_base} verification_unknown verification_proof=missing "
            f"unknown_severity={unknown_severity} last_verified_source=missing last_verified_at=missing"
        ]

    verified_epoch = parse_iso_epoch(last_verified)
    if verified_epoch is None:
        prefix = "FAIL " if required else "WARN "
        return [
            f"{prefix}{line_base} verification_invalid "
            f"last_verified_source={last_verified_source} last_verified_at={last_verified}"
        ]

    age_seconds = max(0, current_epoch() - verified_epoch)
    age_days = age_seconds // 86400
    if age_days >= fail_days:
        prefix = "FAIL "
        state = "reverify_required"
    elif age_days >= warn_days:
        prefix = "WARN "
        state = "reverify_soon"
    else:
        prefix = "OK "
        state = "fresh"
    return [
        f"{prefix}{line_base} {state} last_verified_at={last_verified} "
        f"last_verified_source={last_verified_source} age_days={age_days} age_seconds={age_seconds}"
    ]


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
        auth_names: list[str] = []
        expected_names: set[str] = set()
        for item in expected_instances:
            name = str(item.get("name") or "").strip()
            if not name:
                lines.append("WARN config profile: instance without name")
                continue
            expected_names.add(name)
            expectation = str(item.get("expected") or "always_on")
            reason = str(item.get("reason") or "")
            cfg = root / name / "config.json"
            if expectation in {"none", "no_bot"}:
                lines.append(f"config {name}: expected={expectation} reason={reason or 'profile'}")
                continue
            if expectation == "blocked":
                exists = cfg.exists()
                enabled = None
                config_error = None
                if exists:
                    data, config_error = read_instance_config(cfg)
                    if data is not None:
                        enabled = data.get("enabled", True)
                service = item.get("service")
                service_name = str(service) if service else ""
                status = service_is_active(service_name) if service_name else "not_configured"
                line = (
                    f"config {name}: expected=blocked exists={exists} "
                    f"service_status={status} reason={reason or 'operator approval required'}"
                )
                if config_error:
                    line = f"FAIL {line} config_error={redact_evidence_string(str(config_error), 160)}"
                elif exists:
                    line += f" config_enabled={enabled}"
                    if enabled is not False:
                        line = f"FAIL {line} actual=activation_guard_missing"
                if service_name:
                    line += f" service={service_name}"
                if status == "active":
                    if line.startswith("FAIL "):
                        line += " actual=active"
                    else:
                        line = f"WARN {line} actual=active"
                lines.append(line)
                continue
            auth_names.append(name)
            strict_max = profile_mode(item.get("requiredConfigMaxMode"), profile_mode(profile.get("requiredConfigMaxMode")))
            required_configs = required_config_files(profile, item)
            for requirement in required_configs:
                required_path = required_file_path(root / name, requirement)
                if not required_path.exists():
                    expected_ref = (
                        credential_path_ref(required_path, prefix="expected_path")
                        if required_path.name in ROOT_CREDENTIAL_FILES or required_path.name == "tokens.env"
                        else f"expected_path={required_path}"
                    )
                    lines.append(f"FAIL config {name}: missing required {requirement} {expected_ref}")
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
            health_probe_line: str | None = None
            if isinstance(port, int):
                probe = probe_health(port, name)
                health_probe_line = probe
                if expectation == "on_demand":
                    lines.append(f"health {name}: on_demand_ok {probe.replace('FAIL ', 'down ')}")
                else:
                    lines.append(f"health {name}: {probe}")
                    lines.extend(auth_failure_log_inventory(name, expectation, probe))
            lines.extend(provider_probe_inventory(profile, item, name, data, expectation, health_probe_line))
            lines.extend(primary_phone_verification_inventory(profile, item, name, expectation))
            lines.extend(auth_bond_inventory(name, root / name, expectation))
            if isinstance(socket_path, str) and socket_path:
                exists = Path(socket_path).exists()
                prefix = "FAIL " if expectation == "always_on" and not exists else ""
                lines.append(f"{prefix}socket {name}: {socket_path} exists={exists}")
        if not profile_bool(profile, "allowUnprofiledInstances", False):
            lines.extend(unprofiled_config_inventory(root, expected_names))
            lines.extend(unprofiled_service_inventory(root, expected_names))
        lines.extend(watchdog_currency_inventory(auth_names))
        lines.extend(local_auth_bond_duplicates(root, auth_names))
        return lines
    ports: dict[int, str] = {}
    auth_names = []
    strict_max = profile_mode(profile.get("requiredConfigMaxMode"))
    for cfg in sorted(root.glob("*/config.json")):
        mode = stat.S_IMODE(cfg.stat().st_mode)
        data, error = read_instance_config(cfg)
        if error or data is None:
            lines.append(f"config {cfg}: invalid JSON: {error}")
            continue
        name = cfg.parent.name
        auth_names.append(name)
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
            probe = probe_health(port, name)
            lines.append(f"health {name}: {probe}")
            lines.extend(auth_failure_log_inventory(name, "always_on", probe))
        lines.extend(auth_bond_inventory(name, cfg.parent, "always_on"))
        if isinstance(socket_path, str) and socket_path:
            exists = Path(socket_path).exists()
            lines.append(f"socket {name}: {socket_path} exists={exists}")
    lines.extend(local_auth_bond_duplicates(root, auth_names))
    return lines


def credential_metadata(profile: dict[str, Any]) -> list[str]:
    root = Path.home() / ".config/whatsoup"
    lines: list[str] = []
    if not root.exists():
        return [f"credentials: missing {root}"]
    required_paths = required_credential_existing_paths(profile)
    for path in sorted(root.rglob("*")):
        if path.name not in {"tokens.env", "bot-errors.env", "fleet-token", "fleet.env", "fleet-tokens.json", "secrets.env"}:
            continue
        if path.absolute() in required_paths:
            continue
        st = path.lstat()
        mode = stat.S_IMODE(st.st_mode)
        age_days = int((time.time() - st.st_mtime) / 86400)
        path_ref = credential_path_ref(path)
        parent_issues = credential_parent_dir_issues(root, path)
        for issue in parent_issues:
            lines.append(f"FAIL credential_meta: {issue} {path_ref}")
        if stat.S_ISLNK(st.st_mode):
            lines.append(f"FAIL credential_meta: symlink {path_ref} mode={mode:o} age_days={age_days}")
        elif not stat.S_ISREG(st.st_mode):
            lines.append(f"FAIL credential_meta: non_regular {path_ref} mode={mode:o} age_days={age_days}")
        elif mode & 0o022:
            lines.append(f"FAIL credential_meta: {path_ref} mode={mode:o} age_days={age_days}")
        elif mode > 0o600:
            lines.append(f"FAIL credential_meta: mode>{0o600:o} {path_ref} mode={mode:o} age_days={age_days}")
        elif not parent_issues:
            lines.append(f"OK credential_meta: {path_ref} mode={mode:o} age_days={age_days}")
    return lines


def read_json_record(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, str(exc)
    if not isinstance(loaded, dict):
        return None, "JSON root is not an object"
    return loaded, None


def critical_file_problem(path: Path) -> str | None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return f"missing {path}"
    if stat.S_ISLNK(st.st_mode):
        return f"refusing to trust symlinked critical file {path}"
    if not stat.S_ISREG(st.st_mode):
        return f"refusing to trust non-regular critical file {path}"
    mode = st.st_mode & 0o777
    if mode & 0o077:
        return f"refusing to trust non-private critical file {path} mode={mode:o}"
    try:
        parent_stat = path.parent.lstat()
    except FileNotFoundError:
        return f"missing critical file parent {path.parent}"
    if path.parent.is_symlink():
        return f"refusing to trust critical file under symlinked directory {path.parent}"
    if not os.path.isdir(path.parent):
        return f"refusing to trust critical file under non-directory parent {path.parent}"
    parent_mode = parent_stat.st_mode & 0o777
    if parent_mode & 0o077:
        return f"refusing to trust critical file in non-private directory {path.parent} mode={parent_mode:o}"
    return None


def read_private_json_record(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    problem = critical_file_problem(path)
    if problem is not None:
        return None, problem
    return read_json_record(path)


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
    dry_sequence = os.environ.get("BOT_ERRORS_DRY_TOOL_NAMES_SEQUENCE")
    dry_names = os.environ.get("BOT_ERRORS_DRY_TOOL_NAMES")
    if dry_sequence is None and dry_names is None and not SOCKET_PATH:
        return ["tools personal: FAIL BOT_ERRORS_SOCKET_PATH is not configured"], REQUIRED_TOOLS

    attempts = max(1, env_int("BOT_ERRORS_TOOL_LIST_ATTEMPTS", 3))
    if dry_names is not None and dry_sequence is None:
        attempts = 1
    retry_delay = max(0, env_int("BOT_ERRORS_TOOL_LIST_RETRY_DELAY_SECONDS", 3))
    sequence_parts = dry_sequence.split(";") if dry_sequence is not None else []

    def load_names(attempt_index: int) -> list[str]:
        if dry_sequence is not None:
            raw = sequence_parts[min(attempt_index, len(sequence_parts) - 1)] if sequence_parts else ""
            return parse_tool_names(raw)
        if dry_names is not None:
            return parse_tool_names(dry_names)
        result = json_rpc(SOCKET_PATH, "tools/list", {})
        tools = result.get("tools", [])
        return sorted(t.get("name") for t in tools if isinstance(t, dict) and isinstance(t.get("name"), str))

    last_error: Exception | None = None
    last_lines: list[str] | None = None
    last_missing: list[str] = REQUIRED_TOOLS
    for attempt in range(1, attempts + 1):
        try:
            names = load_names(attempt - 1)
            missing = [name for name in REQUIRED_TOOLS if name and name not in names]
            prefix = "FAIL " if missing else ""
            retry_note = f" attempts={attempt}/{attempts}" if attempts > 1 else ""
            lines = [
                f"{prefix}tools personal: count={len(names)} required_missing={','.join(missing) if missing else 'none'}{retry_note}",
                f"tools personal required_present={','.join(name for name in REQUIRED_TOOLS if name in names)}",
            ]
            if not missing:
                return lines, []
            last_lines = lines
            last_missing = missing
        except Exception as exc:
            last_error = exc
            if attempt == attempts:
                return [f"tools personal: FAIL {exc} attempts={attempt}/{attempts}"], REQUIRED_TOOLS
        if attempt < attempts:
            time.sleep(retry_delay)

    if last_lines is not None:
        return last_lines, last_missing
    if last_error is not None:
        return [f"tools personal: FAIL {last_error} attempts={attempts}/{attempts}"], REQUIRED_TOOLS
    return ["tools personal: FAIL unknown tool inventory error"], REQUIRED_TOOLS


def queue_inventory() -> list[str]:
    root = state_root()
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))
    processing = root / "processing"
    quarantine = root / "quarantine"
    writefail_paths = [
        root / "writefail",
        Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail",
        Path.home() / ".bot-errors-writefail",
    ]
    state = root / "dispatcher-state.json"
    lines: list[str] = []
    state_problem = critical_file_problem(state)
    if state_problem is None:
        age = int(time.time() - state.stat().st_mtime)
        state_data, state_error = read_private_json_record(state)
        if state_error:
            lines.append(f"FAIL dispatcher_state: invalid_json {state} age_seconds={age} error={state_error}")
        else:
            failed = read_int(state_data.get("failed") if state_data else None) or 0
            last_error = state_data.get("lastError") if state_data else None
            prefix = "WARN " if failed > 0 or last_error else ""
            lines.append(
                f"{prefix}dispatcher_state: {state} age_seconds={age} "
                f"failed={failed} last_error={str(last_error)[:180] if last_error else 'none'}"
            )
    else:
        prefix = "dispatcher_state:" if state_problem.startswith("missing ") else "FAIL dispatcher_state:"
        lines.append(f"{prefix} {state_problem}")

    lines.append(queue_directory_line(
        "outbox",
        outbox,
        "*.json",
        env_int("BOT_ERRORS_OUTBOX_WARN_COUNT", 10),
        env_int("BOT_ERRORS_OUTBOX_CRITICAL_COUNT", 100),
        env_int("BOT_ERRORS_OUTBOX_WARN_OLDEST_SECONDS", 600),
        env_int("BOT_ERRORS_OUTBOX_CRITICAL_OLDEST_SECONDS", 3600),
    ))
    lines.append(queue_directory_line(
        "processing",
        processing,
        "*",
        env_int("BOT_ERRORS_PROCESSING_WARN_COUNT", 1),
        env_int("BOT_ERRORS_PROCESSING_CRITICAL_COUNT", 10),
        env_int("BOT_ERRORS_PROCESSING_WARN_OLDEST_SECONDS", 60),
        env_int("BOT_ERRORS_PROCESSING_CRITICAL_OLDEST_SECONDS", 300),
    ))
    lines.append(queue_directory_line(
        "quarantine",
        quarantine,
        "*",
        env_int("BOT_ERRORS_QUARANTINE_WARN_COUNT", 1),
        env_int("BOT_ERRORS_QUARANTINE_CRITICAL_COUNT", 25),
        env_int("BOT_ERRORS_QUARANTINE_WARN_OLDEST_SECONDS", 0),
        env_int("BOT_ERRORS_QUARANTINE_CRITICAL_OLDEST_SECONDS", 0),
    ))
    writefail_count = 0
    oldest_writefail = 0
    for path in writefail_paths:
        count, oldest = directory_stats(path, "*.writefail")
        writefail_count += count
        oldest_writefail = max(oldest_writefail, oldest)
    prefix = queue_prefix(
        writefail_count,
        oldest_writefail,
        env_int("BOT_ERRORS_WRITEFAIL_WARN_COUNT", 1),
        env_int("BOT_ERRORS_WRITEFAIL_CRITICAL_COUNT", 10),
        env_int("BOT_ERRORS_WRITEFAIL_WARN_OLDEST_SECONDS", 60),
        env_int("BOT_ERRORS_WRITEFAIL_CRITICAL_OLDEST_SECONDS", 600),
    )
    lines.append(
        f"{prefix}writefail: count={writefail_count} oldest_seconds={oldest_writefail} "
        f"paths={','.join(str(path) for path in writefail_paths)}"
    )
    return lines


def _event_file_age_seconds(path: Path, now: float) -> float:
    """Return the age in seconds for a JSON event file.

    For *.json event files, reads the event's createdAt ISO8601 field as the
    true creation time (age = now - createdAt).  Falls back to st_mtime on
    any error (missing field, unparseable timestamp, unreadable file).
    Non-JSON callers already pass non-matching patterns; this path is only
    reached for *.json glob results.
    """
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
        data = json.loads(raw)
        if isinstance(data, dict):
            created_at = data.get("createdAt")
            if isinstance(created_at, str) and created_at.strip():
                parsed = datetime.fromisoformat(created_at.strip().replace("Z", "+00:00"))
                return max(0.0, now - parsed.timestamp())
    except Exception:  # noqa: BLE001 - health path must never crash on malformed files
        pass
    try:
        return max(0.0, now - path.stat().st_mtime)
    except OSError:
        return 0.0


def directory_stats(path: Path, pattern: str) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    files = [item for item in path.glob(pattern) if item.is_file()]
    if not files:
        return 0, 0
    now = time.time()
    is_json_pattern = pattern.endswith(".json") or pattern == "*.json"
    if is_json_pattern:
        oldest = max(_event_file_age_seconds(item, now) for item in files)
    else:
        oldest = now - min(item.stat().st_mtime for item in files)
    return len(files), max(0, int(oldest))


def queue_prefix(
    count: int,
    oldest_seconds: int,
    warn_count: int,
    critical_count: int,
    warn_oldest_seconds: int,
    critical_oldest_seconds: int,
) -> str:
    if critical_count > 0 and count >= critical_count:
        return "FAIL "
    if critical_oldest_seconds > 0 and oldest_seconds >= critical_oldest_seconds:
        return "FAIL "
    if warn_count > 0 and count >= warn_count:
        return "WARN "
    if warn_oldest_seconds > 0 and oldest_seconds >= warn_oldest_seconds:
        return "WARN "
    return ""


def queue_directory_line(
    label: str,
    path: Path,
    pattern: str,
    warn_count: int,
    critical_count: int,
    warn_oldest_seconds: int,
    critical_oldest_seconds: int,
) -> str:
    count, oldest = directory_stats(path, pattern)
    exists = path.exists()
    prefix = queue_prefix(count, oldest, warn_count, critical_count, warn_oldest_seconds, critical_oldest_seconds)
    return (
        f"{prefix}{label}: count={count} oldest_seconds={oldest} exists={exists} path={path} "
        f"warn_count={warn_count} critical_count={critical_count} "
        f"warn_oldest_seconds={warn_oldest_seconds} critical_oldest_seconds={critical_oldest_seconds}"
    )


def q_loop_state_file() -> Path:
    root = Path(os.environ.get("BOT_ERRORS_Q_LOOP_STATE_DIR", Path.home() / ".local/state/bot-errors-q-loop"))
    return root.expanduser() / "state.json"


def q_loop_state_inventory(profile: dict[str, Any]) -> list[str]:
    state = q_loop_state_file()
    if not profile_bool(profile, "expectQLoop", True):
        return [f"q_loop_state: skipped by health profile {state}"]
    state_problem = critical_file_problem(state)
    if state_problem is not None:
        return [f"FAIL q_loop_state: {state_problem}"]
    state_data, state_error = read_private_json_record(state)
    age_from_mtime = max(0, int(current_epoch() - state.stat().st_mtime))
    if state_error:
        return [f"FAIL q_loop_state: invalid_json {state} age_seconds={age_from_mtime} error={state_error}"]
    updated_at = read_int(state_data.get("updated_at") if state_data else None)
    age_seconds = max(0, current_epoch() - updated_at) if updated_at is not None else age_from_mtime
    max_age_seconds = env_int("BOT_ERRORS_Q_LOOP_STATE_MAX_AGE_SECONDS", 600)
    failures = read_int(state_data.get("consecutive_poll_failures") if state_data else None) or 0
    last_error = state_data.get("last_poll_error") if state_data else None
    missing_updated = updated_at is None
    prefix = "FAIL " if missing_updated or age_seconds > max_age_seconds or failures > 0 or last_error else ""
    details = [
        f"{prefix}q_loop_state: {state}",
        f"age_seconds={age_seconds}",
        f"max_age_seconds={max_age_seconds}",
        f"phase={str(state_data.get('phase') if state_data else 'unknown')[:80]}",
        f"last_seen_pk={read_int(state_data.get('last_seen_pk') if state_data else None) or 0}",
        f"consecutive_poll_failures={failures}",
    ]
    if missing_updated:
        details.append("missing_updated_at=True")
    if last_error:
        details.append(f"last_poll_error={str(last_error)[:180]}")
    return [" ".join(details)]


def service_health_line(label: str, unit: str, expected: bool) -> str:
    if not expected:
        return f"{label}: skipped by health profile ({unit})"
    status = service_is_active(unit)
    prefix = "" if status.startswith("active") else "FAIL "
    return f"{prefix}{label}: {status} ({unit})"


_TREE_PROVENANCE_MODULE: Any = None


def _load_tree_provenance_module() -> Any:
    """Lazily load the sibling tree-provenance guard by file path.

    The hyphen in ``bot-errors-tree-provenance.py`` blocks a normal import, so
    load it via importlib the same way the test harness loads this file.  The
    module is cached after first load.  Returns None if the sibling script is
    absent (so an older deploy without the guard degrades gracefully).
    """
    global _TREE_PROVENANCE_MODULE
    if _TREE_PROVENANCE_MODULE is not None:
        return _TREE_PROVENANCE_MODULE
    script = Path(__file__).resolve().parent / "bot-errors-tree-provenance.py"
    if not script.exists():
        return None
    import importlib.util

    spec = importlib.util.spec_from_file_location("bot_errors_tree_provenance", script)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _TREE_PROVENANCE_MODULE = module
    return module


def tree_provenance_inventory(profile: dict[str, Any]) -> list[str]:
    """Daily-health lines reporting this host's tree provenance.

    Delegates to ``bot-errors-tree-provenance.tree_provenance_inventory`` so the
    detector logic lives in one place (DRY).  Network fetch is gated behind the
    ``treeProvenanceFetch`` profile flag (default offline).  Inspection errors
    are swallowed into a WARN line -- the daily probe must never crash the host
    health run.
    """
    module = _load_tree_provenance_module()
    if module is None:
        return ["tree_provenance: guard script unavailable"]
    do_fetch = profile_bool(profile, "treeProvenanceFetch", False)
    try:
        return list(module.tree_provenance_inventory(profile, do_fetch=do_fetch))
    except Exception as exc:  # defensive: never crash daily() on provenance
        return [f"WARN tree_provenance: inventory_error {str(exc)[:160]}"]


def daily() -> int:
    profile = load_health_profile()
    tool_lines, missing_required_tools = tool_inventory(profile)
    dispatcher_line = service_health_line(
        "dispatcher_service",
        DISPATCHER_SERVICE,
        profile_bool(profile, "expectDispatcher", True),
    )
    q_loop_line = service_health_line(
        "q_loop_service",
        Q_LOOP_SERVICE,
        profile_bool(profile, "expectQLoop", True),
    )
    socket_label = SOCKET_PATH or "<unset>"
    socket_exists = bool(SOCKET_PATH) and Path(SOCKET_PATH).exists()
    if profile_bool(profile, "expectPersonalSocket", True):
        personal_socket_line = f"{'FAIL ' if not socket_exists else ''}personal_socket: {socket_label} exists={socket_exists}"
    else:
        personal_socket_line = f"personal_socket: skipped by health profile {socket_label} exists={socket_exists}"
    lines = [
        f"machine: {socket.gethostname()}",
        f"profile: role={profile.get('role', 'unknown')} path={profile.get('_profilePath') or os.environ.get('BOT_ERRORS_HEALTH_PROFILE', 'default')}",
        *([f"FAIL profile: {profile['profileLoadError']}"] if profile.get("profileLoadError") else []),
        *([f"profile_fallback: {profile['profileFallback']}"] if profile.get("profileFallback") else []),
        dispatcher_line,
        f"dispatcher_enabled: {service_enabled(DISPATCHER_SERVICE)}",
        q_loop_line,
        f"q_loop_enabled: {service_enabled(Q_LOOP_SERVICE)}",
        *q_loop_state_inventory(profile),
        *fleet_api_inventory(profile),
        personal_socket_line,
        *alert_target_inventory(profile),
        *dns_inventory(profile),
        *boot_inventory(),
        *rustdesk_inventory(profile),
        *source_update_inventory(profile),
        *runtime_manifest_inventory(profile),
        *tree_provenance_inventory(profile),
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
    warnings = [line for line in lines if line.startswith("WARN ") or " WARN " in line]
    severity = daily_summary_severity(failures, warnings)
    evidence = "\n".join(lines)
    critical_asset = critical_asset_from_health_evidence(evidence) if severity != "info" else None
    if missing_required_tools:
        summary = f"BOT ERRORS daily health found issues: missing required tools {','.join(missing_required_tools)}"
    else:
        summary = (
            daily_summary_from_critical_asset(critical_asset)
            or ("BOT ERRORS daily health found issues" if severity != "info" else "BOT ERRORS daily health passed")
        )
    event_type = "clear" if severity == "info" else "alert"
    if severity == "info" and has_shadow_source_update_blocked(lines):
        summary = "BOT ERRORS daily health retained source-update shadow observation"
        event_type = "observation"
    path = outbox_event(summary, evidence, severity=severity, source="daily-health", event_type=event_type)
    print(path)
    emit_per_instance_health_failures(failures)
    source_update_signal = enforced_source_update_signal(lines)
    if source_update_signal is not None and alert_source_from_health_evidence(evidence) != "source_update":
        source_event_type, source_severity, source_summary, source_evidence = source_update_signal
        source_path = outbox_event(
            source_summary,
            source_evidence,
            severity=source_severity,
            source="daily-health",
            event_type=source_event_type,
        )
        print(source_path)
    return 0


def deadman(max_state_age: int, restart_grace: int, cooldown_seconds: int) -> int:
    root = state_root()
    state = root / "dispatcher-state.json"
    problems: list[str] = []
    state_age = None
    now_epoch = current_epoch()
    if state.exists():
        state_age = max(0, int(now_epoch - state.stat().st_mtime))
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

    deadman_state = load_deadman_state()
    incidents = deadman_state.setdefault("incidents", {})
    if not isinstance(incidents, dict):
        incidents = {}
        deadman_state["incidents"] = incidents

    if not problems:
        open_incidents = [
            (key, record)
            for key, record in incidents.items()
            if isinstance(record, dict) and record.get("status") == "open"
        ]
        for key, record in open_incidents:
            suppressed = int_or_none(record.get("suppressed")) or 0
            prior_problems = record.get("problems") if isinstance(record.get("problems"), list) else []
            text = "\n".join([
                "BOT ERRORS DEADMAN RECOVERY - dispatcher supervision restored",
                f"  > machine: {socket.gethostname()}",
                f"  > created: {now_iso()}",
                f"  > incident_key: {key}",
                f"  > prior_last_sent: {record.get('lastSentAt') or 'unknown'}",
                f"  > suppressed_duplicates: {suppressed}",
                *[f"  > resolved_problem: {problem}" for problem in prior_problems if isinstance(problem, str)],
                f"  > deadman_state: {deadman_state_path()}",
            ])
            outcome = {
                "type": "deadman_recovery",
                "incident_key": key,
                "direct_whatsapp": "not_attempted",
                "email_fallback": "not_attempted",
            }
            try:
                send_direct(text)
                outcome["direct_whatsapp"] = "sent"
                print(f"notifier direct_whatsapp=sent recovery incident_key={key}")
            except Exception as exc:
                outcome["direct_whatsapp"] = "failed"
                outcome["direct_error"] = str(exc)
                print(f"notifier direct_whatsapp=failed recovery incident_key={key} error={exc}")
                ok = email_fallback("BOT ERRORS deadman recovered", text)
                outcome["email_fallback"] = "accepted_unconfirmed" if ok else "failed"
                print(f"notifier email_fallback={'accepted_unconfirmed' if ok else 'failed'} recovery incident_key={key} channel=resend")
            record["status"] = "resolved"
            record["resolvedAtEpoch"] = current_epoch()
            record["resolvedAt"] = epoch_to_iso(record["resolvedAtEpoch"])
            record["lastRecoveryStatus"] = outcome
            append_deadman_log(outcome)
        if open_incidents:
            save_deadman_state(deadman_state)
        if grace_reason:
            state_detail = state_age if state_age is not None else "missing"
            print(f"deadman grace ok: service={service_status} {grace_reason} dispatcher_state_age_seconds={state_detail}")
        else:
            print("deadman ok")
        return 0

    incident_key = deadman_incident_key(problems)
    record = incidents.get(incident_key)
    if not isinstance(record, dict):
        record = {
            "status": "open",
            "incidentKey": incident_key,
            "problems": problems,
            "firstSeenAtEpoch": now_epoch,
            "firstSeenAt": epoch_to_iso(now_epoch),
            "sentCount": 0,
            "suppressed": 0,
        }
        incidents[incident_key] = record
    record["status"] = "open"
    record["problems"] = problems
    record["lastSeenAtEpoch"] = now_epoch
    record["lastSeenAt"] = epoch_to_iso(now_epoch)
    record["cooldownSeconds"] = cooldown_seconds
    if deadman_state.get("loadError"):
        record["stateLoadError"] = deadman_state.get("loadError")

    last_sent_epoch = int_or_none(record.get("lastSentAtEpoch"))
    remaining = 0 if last_sent_epoch is None else max(0, cooldown_seconds - (now_epoch - last_sent_epoch))
    if last_sent_epoch is not None and remaining > 0:
        record["suppressed"] = (int_or_none(record.get("suppressed")) or 0) + 1
        save_deadman_state(deadman_state)
        outcome = {
            "type": "deadman",
            "incident_key": incident_key,
            "problems": problems,
            "direct_whatsapp": "suppressed_cooldown",
            "cooldown_seconds": cooldown_seconds,
            "cooldown_remaining_seconds": remaining,
            "suppressed": record["suppressed"],
        }
        append_deadman_log(outcome)
        print(
            "notifier direct_whatsapp=suppressed_cooldown "
            f"incident_key={incident_key} cooldown_remaining_seconds={remaining} "
            f"suppressed={record['suppressed']}"
        )
        return 2

    suppressed_since_last = int_or_none(record.get("suppressed")) or 0
    text = "\n".join([
        "BOT ERRORS DEADMAN - dispatcher supervision failed",
        f"  > machine: {socket.gethostname()}",
        f"  > created: {now_iso()}",
        f"  > incident_key: {incident_key}",
        f"  > cooldown_seconds: {cooldown_seconds}",
        f"  > suppressed_since_last_send: {suppressed_since_last}",
        *[f"  > problem: {problem}" for problem in problems],
        f"  > logs: {dispatcher_log_hint()}",
        f"  > deadman_log: {state_root() / 'logs/deadman.jsonl'}",
        f"  > deadman_state: {deadman_state_path()}",
        "  > notifier: direct_whatsapp primary; email_fallback=resend when direct WhatsApp/socket fails",
        "  > requested_action: Q investigate dispatcher, queue, personal line, and email fallback.",
    ])
    outcome = {
        "type": "deadman",
        "incident_key": incident_key,
        "problems": problems,
        "direct_whatsapp": "not_attempted",
        "email_fallback": "not_attempted",
        "email_channel": "resend",
        "cooldown_seconds": cooldown_seconds,
        "suppressed_since_last_send": suppressed_since_last,
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
        outcome["email_fallback"] = "accepted_unconfirmed" if ok else "failed"
        print(f"notifier email_fallback={'accepted_unconfirmed' if ok else 'failed'} channel=resend")
    record["lastSentAtEpoch"] = now_epoch
    record["lastSentAt"] = epoch_to_iso(now_epoch)
    record["lastSendStatus"] = outcome
    record["sentCount"] = (int_or_none(record.get("sentCount")) or 0) + 1
    record["suppressed"] = 0
    save_deadman_state(deadman_state)
    append_deadman_log(outcome)
    print(text)
    return 2


def main() -> int:
    parser = argparse.ArgumentParser(description="BOT ERRORS health and deadman checks")
    parser.add_argument("--daily", action="store_true")
    parser.add_argument("--deadman", action="store_true")
    parser.add_argument("--record-primary-phone-verification", metavar="INSTANCE")
    parser.add_argument("--owner", default="")
    parser.add_argument("--method", default="operator_linked_devices_check")
    parser.add_argument("--note", default="")
    parser.add_argument("--verified-at", default=now_iso())
    parser.add_argument("--max-state-age", type=int, default=180)
    parser.add_argument("--restart-grace", type=int, default=30)
    parser.add_argument("--deadman-cooldown", type=int, default=positive_env_int("BOT_ERRORS_DEADMAN_COOLDOWN_SECONDS", 1800))
    args = parser.parse_args()

    if args.record_primary_phone_verification:
        try:
            path = write_primary_phone_verification(
                args.record_primary_phone_verification,
                args.owner,
                args.method,
                args.note,
                args.verified_at,
            )
        except Exception as exc:
            print(f"primary_phone_verification_recorded=false error={exc}", file=sys.stderr)
            return 2
        print(
            "primary_phone_verification_recorded=true "
            f"instance={args.record_primary_phone_verification} state_file={path}"
        )
        return 0
    if args.daily:
        return daily()
    if args.deadman:
        return deadman(args.max_state_age, args.restart_grace, args.deadman_cooldown)
    return daily()


if __name__ == "__main__":
    sys.exit(main())
