#!/usr/bin/env python3
"""BOT ERRORS deadman and daily capability/config health checks."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
import html
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
from lib.bot_errors_envelope import new_event_fields
from lib.target_provenance import safe_observer_provenance, safe_target_provenance
from lib.health_reader import classify_projection, health_body_is_disclosed, instance_health_token, is_public_envelope
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
from lib.state_files import DEADMAN_STATE, DISPATCHER_STATE, Q_LOOP_STATE, TOOL_INVENTORY_STATE
from lib.state_root import DEFAULT_STATE_ROOT, q_loop_state_root, state_root, test_state_root


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
RUNTIME_AGENT_HEALTH_SIGNAL_REGISTRY_PATH = (
    REPO_ROOT / "src" / "lib" / "fault-taxonomy-registry.json"
)
RUNTIME_AGENT_HEALTH_SIGNAL_KINDS = {
    "current_gauge",
    "active_episode_count",
    "terminal_audit_count",
    "cumulative_total",
    "historical_maximum",
}
RUNTIME_AGENT_CURRENT_HEALTH_EFFECTS = {
    "positive_is_risk",
    "diagnostic_only",
}
RUNTIME_AGENT_AUTO_COMPACT_STATES = {"idle", "backoff"}
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
    "kimi": "KIMI_API_KEY",
    "glm": "ZAI_API_KEY",
    "xai": "XAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "google": "GOOGLE_API_KEY",
    "fireworks-ai": "FIREWORKS_API_KEY",
    "togetherai": "TOGETHER_API_KEY",
    "pinecone": "PINECONE_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "whatsoup-health-token": "WHATSOUP_HEALTH_TOKEN",
    "whatsoup_health": "WHATSOUP_HEALTH_TOKEN",
}
TERMINAL_AUTH_FAILURE_CLASSES = {"pairing_required", "serverside_logout_irreversible"}
LOGGED_OUT_STATUS_CODE = 401
LOGGED_OUT_REASON_KEY = "loggedout"


def load_runtime_agent_health_signals() -> tuple[list[dict[str, str]] | None, str | None]:
    try:
        with RUNTIME_AGENT_HEALTH_SIGNAL_REGISTRY_PATH.open("r", encoding="utf-8") as handle:
            registry = json.load(handle)
    except FileNotFoundError:
        return None, "missing"
    except json.JSONDecodeError:
        return None, "malformed_json"
    except OSError:
        return None, "unreadable"

    if not isinstance(registry, dict):
        return None, "invalid_contract"
    if registry.get("schema") != "whatsoup-fault-taxonomy-registry-v3":
        return None, "invalid_schema"
    raw_signals = registry.get("runtimeAgentHealthSignals")
    if not isinstance(raw_signals, list):
        return None, "invalid_contract"

    fields: set[str] = set()
    labels: set[str] = set()
    signals: list[dict[str, str]] = []
    for raw_signal in raw_signals:
        if not isinstance(raw_signal, dict):
            return None, "invalid_contract"
        field = raw_signal.get("field")
        label = raw_signal.get("label")
        kind = raw_signal.get("kind")
        effect = raw_signal.get("currentHealthEffect")
        owner = raw_signal.get("owner")
        test = raw_signal.get("test")
        if (
            not isinstance(field, str)
            or re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", field) is None
            or field in fields
            or not isinstance(label, str)
            or re.fullmatch(r"runtime_agent_[a-z0-9_]+", label) is None
            or label in labels
            or not isinstance(kind, str)
            or kind not in RUNTIME_AGENT_HEALTH_SIGNAL_KINDS
            or not isinstance(effect, str)
            or effect not in RUNTIME_AGENT_CURRENT_HEALTH_EFFECTS
            or not isinstance(owner, str)
            or not owner
            or not isinstance(test, str)
            or not test
        ):
            return None, "invalid_contract"
        fields.add(field)
        labels.add(label)
        signals.append({
            "field": field,
            "label": label,
            "kind": kind,
            "currentHealthEffect": effect,
        })
    return signals, None


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


def read_nvmrc_pin() -> str:
    """Read the repo's pinned node version from .nvmrc (empty string if absent/unreadable).

    #3074: the pin is the canonical .nvmrc value, also mirrored at
    package.json#volta.node and package.json#packageManager. A long-running
    instance process started under an older node keeps reporting healthy after
    the pin advances; this read supplies the comparison baseline.
    """
    try:
        return (REPO_ROOT / ".nvmrc").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def normalize_node_version(raw: str) -> str:
    """Normalize a node version string for comparison (strip leading v/V + whitespace).

    Accepts both v24.15.0 (nvm/installer convention) and 24.15.0
    (process.version in the lifecycle telemetry). #3074.
    """
    return raw.strip().lstrip("vV") if isinstance(raw, str) else ""


def node_version_drift_marker(running_version, pinned_version: str):
    """Return a node_version_drift WARN marker if the RUNNING process node version
    disagrees with the repo pin, or None when drift cannot be determined.

    #3074: running_version is the ACTUAL instance process version
    (credential_lifecycle.environment.nodeVersion from the /health body),
    not shutil.which('node') (which resolves the probe's own shell). When the
    running version is absent (no lifecycle telemetry, degraded probe) this
    returns None -- an undiscoverable running version is NOT a drift finding
    (no false positive). A bare v/V prefix is tolerated on either side.
    """
    if not running_version or not isinstance(running_version, str):
        return None
    if not pinned_version:
        return None
    running = normalize_node_version(running_version)
    pinned = normalize_node_version(pinned_version)
    if not running or not pinned:
        return None
    if running == pinned:
        return None
    return f"node_version_drift running={running} pinned={pinned}"


def health_port_authority_drift_marker(profile_port, live_port):
    """Return a health_port_authority_drift FAIL discriminator when the
    health-profile port and the LIVE instance-config healthPort disagree
    (#2342), or None when either side is absent or they agree.

    The authority that wins is runtime_config — the live config.json port the
    instance actually binds. A stale profile port must NOT be probed: probing
    it pages endpoint/daemon outage against the wrong address. Callers pass
    already-normalized int-or-None ports (bools rejected).
    """
    if profile_port is None or live_port is None:
        return None
    if profile_port == live_port:
        return None
    return (
        f"health_port_authority_drift profile={profile_port} live={live_port} "
        f"authority=runtime_config probe=inhibited"
    )


PROVIDER_EVIDENCE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
RUNTIME_PROVIDER_IDS = frozenset({
    "claude-cli",
    "codex-cli",
    "gemini-cli",
    "opencode-cli",
    "openai-api",
    "anthropic-api",
})
INVALID_RUNTIME_PROVIDER_EVIDENCE = "invalid-provider"


def bounded_provider_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    return candidate if PROVIDER_EVIDENCE_NAME_RE.fullmatch(candidate) else None


def runtime_provider_name(value: Any) -> str | None:
    candidate = bounded_provider_name(value)
    return candidate if candidate in RUNTIME_PROVIDER_IDS else None


def append_runtime_provider_evidence(details: list[str], key: str, value: Any) -> None:
    if value is None:
        return
    provider = runtime_provider_name(value)
    details.append(f"{key}={provider or INVALID_RUNTIME_PROVIDER_EVIDENCE}")


def current_epoch() -> int:
    raw = os.environ.get("BOT_ERRORS_DRY_NOW_EPOCH")
    if raw is not None:
        return int(float(raw))
    return int(time.time())


def service_env_var(service: str) -> str | None:
    return SERVICE_ENV_MAP.get(service.lower())


STRONG_TEST_SIGNAL_KEYS = ("VITEST", "VITEST_WORKER_ID", "JEST_WORKER_ID", "PYTEST_CURRENT_TEST")
CONTROLLER_LOG_CONTEXT = ControllerLogContext("deadman")


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


def canonical_path(path: Path) -> Path:
    try:
        return path.expanduser().resolve(strict=True)
    except OSError:
        try:
            return path.expanduser().parent.resolve(strict=True) / path.name
        except OSError:
            return path.expanduser().absolute()


def live_outbox_candidates() -> list[Path]:
    candidates = [DEFAULT_STATE_ROOT / "outbox"]
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
    outbox = DEFAULT_STATE_ROOT / "outbox"
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


def _durable_target(path: Path):
    ensure_private_dir(path.parent)
    return durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )


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
            target = _durable_target(path)
            absent = JsonVersion(False, None, None, None)
            publication_operation = operation_id(
                target,
                breadcrumb,
                component="health_check.writefail",
                predecessor=absent,
            )
            publication = publish_event_json(
                target,
                breadcrumb,
                component="health_check.writefail",
                operation_id=publication_operation,
            )
            require_advance(publication)
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
    if payload.get("schemaVersion") == 1 and payload.get("component") == "deadman":
        record = payload
    else:
        record = redact_json_value({"time": now_iso(), "pid": os.getpid(), **payload})
    data = (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")
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


def persist_controller_log_health(record: dict[str, Any]) -> None:
    target = _durable_target(
        state_root() / "controller-log-health" / "deadman.json"
    )
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        record,
        component="health_check.controller_log_health",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        record,
        component="health_check.controller_log_health",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    if not publication.advance_allowed:
        require_advance(publication)


def controller_log_fallback(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def _deadman_delivery_level(delivery_status: str) -> str:
    """Return 'info' only for proven-ok delivery statuses; anything else is 'warning' (#2425)."""
    return "info" if delivery_status in ("sent", "suppressed_cooldown") else "warning"


def append_deadman_log(
    payload: dict[str, Any],
    *,
    level: str = "info",
    outcome: str = "observed",
) -> str:
    logs = state_root() / "logs"
    redacted = redact_json_value(payload)
    record_kind = redacted.get("type") if isinstance(redacted, dict) else None
    if not isinstance(record_kind, str):
        raise ValueError("deadman controller log requires a bounded type")
    details = {key: value for key, value in redacted.items() if key != "type"}
    return write_controller_log(
        context=CONTROLLER_LOG_CONTEXT,
        record_kind=record_kind,
        level=level,
        outcome=outcome,
        durability_class="diagnostic_best_effort",
        details=metadata_only_controller_details(details),
        append_record=lambda record: append_private_jsonl(logs / "deadman.jsonl", record),
        persist_health=persist_controller_log_health,
        emit_fallback=controller_log_fallback,
    )


def deadman_state_path() -> Path:
    return state_root() / DEADMAN_STATE


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
    target = _durable_target(deadman_state_path())
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        state,
        component="health_check.deadman_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        state,
        component="health_check.deadman_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)


DEADMAN_PENDING_MAX_ATTEMPTS = 8

_DEADMAN_SERVICE_STATUS_TOKENS = (
    "active",
    "inactive",
    "failed",
    "activating",
    "deactivating",
    "reloading",
    "active_process_fallback",
)


def _bounded_service_status(status: str) -> str:
    if status in _DEADMAN_SERVICE_STATUS_TOKENS:
        return status
    if status.startswith(("unavailable:", "timeout:", "rc=")):
        return status
    return "unknown"


def _classify_direct_send_error(exc: BaseException) -> str:
    """Map a send_direct exception to a bounded token safe for durable state (#2425)."""
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, ConnectionRefusedError):
        return "connection_refused"
    message = str(exc)
    if "socket missing" in message:
        return "socket_missing"
    if message.startswith("send_message returned error"):
        return "send_error"
    if "BOT_ERRORS" in message:
        return "target_invalid"
    return "other"


def _deadman_attempt_delivery(text: str, email_subject: str, *, context: str) -> dict[str, Any]:
    """Attempt direct WhatsApp then email fallback; return a typed durable outcome (#2425).

    direct_whatsapp: sent | failed | outcome_unknown | not_attempted. A timeout
    is outcome_unknown because the request may have been accepted before the
    deadline (#2424 owns disambiguating ambiguous acceptance); every other
    exception is a proven rejection. email_fallback: accepted_unconfirmed |
    rejected | timed_out | unavailable | not_attempted.
    """
    outcome: dict[str, Any] = {
        "direct_whatsapp": "not_attempted",
        "email_fallback": "not_attempted",
        "email_channel": "resend",
    }
    try:
        send_direct(text)
        outcome["direct_whatsapp"] = "sent"
        print(f"notifier direct_whatsapp=sent {context}")
    except TimeoutError as exc:
        outcome["direct_whatsapp"] = "outcome_unknown"
        outcome["direct_error"] = _classify_direct_send_error(exc)
        print(f"notifier direct_whatsapp=outcome_unknown {context} error={outcome['direct_error']}")
    except Exception as exc:  # noqa: BLE001 - every rejection shape must land in the durable outcome.
        outcome["direct_whatsapp"] = "failed"
        outcome["direct_error"] = _classify_direct_send_error(exc)
        print(f"notifier direct_whatsapp=failed {context} error={outcome['direct_error']}")
    if outcome["direct_whatsapp"] != "sent":
        outcome["email_fallback"] = email_fallback_outcome(email_subject, text)
        print(f"notifier email_fallback={outcome['email_fallback']} channel=resend {context}")
    return outcome


def _deadman_outcome_accepted_kind(outcome: dict[str, Any]) -> str | None:
    if outcome.get("direct_whatsapp") == "sent":
        return "accepted"
    if outcome.get("email_fallback") == "accepted_unconfirmed":
        return "accepted_unconfirmed"
    return None


def _deadman_new_episode(now_epoch: int) -> dict[str, Any]:
    return {
        "status": "open",
        "episodeId": f"ep-{now_epoch}",
        "openedAtEpoch": now_epoch,
        "openedAt": epoch_to_iso(now_epoch),
        "revision": 0,
        "members": {},
        "onset": {"state": "pending", "attemptCount": 0, "sentCount": 0, "suppressed": 0},
    }


def migrate_deadman_state(state: dict[str, Any], now_epoch: int) -> None:
    """Adopt schemaVersion 1 open incidents into the episode model, in place (#2425).

    Legacy incident records stay in the state and are marked resolved once the
    adopting episode's recovery notice is accepted, so an upgrade never
    orphans a previously-open supervision record. Adoption counts as a
    delivered onset when any legacy incident recorded a send, anchoring the
    cooldown at the newest legacy send instead of re-paging on upgrade.
    """
    if isinstance(state.get("episode"), dict) and state["episode"].get("status") == "open":
        state["schemaVersion"] = 2
        return
    incidents = state.get("incidents")
    open_legacy = (
        [record for record in incidents.values() if isinstance(record, dict) and record.get("status") == "open"]
        if isinstance(incidents, dict)
        else []
    )
    if not open_legacy:
        state["schemaVersion"] = 2
        return
    adopted = _deadman_new_episode(now_epoch)
    adopted["adoptedLegacyIncidents"] = len(open_legacy)
    sent_epochs = [
        epoch for epoch in (int_or_none(record.get("lastSentAtEpoch")) for record in open_legacy) if epoch is not None
    ]
    if sent_epochs:
        adopted["onset"] = {
            "state": "delivered",
            "deliveredKind": "accepted",
            "attemptCount": 0,
            "sentCount": sum(int_or_none(record.get("sentCount")) or 0 for record in open_legacy),
            "suppressed": 0,
            "lastAcceptedAtEpoch": max(sent_epochs),
            "lastAcceptedAt": epoch_to_iso(max(sent_epochs)),
            "lastAcceptedRevision": 0,
        }
    state["episode"] = adopted
    state["schemaVersion"] = 2


def _resolve_deadman_episode(
    deadman_state: dict[str, Any],
    episode: dict[str, Any],
    now_epoch: int,
    *,
    resolution: str,
    outcome: dict[str, Any] | None,
) -> None:
    episode["status"] = "resolved"
    episode["resolvedAtEpoch"] = now_epoch
    episode["resolvedAt"] = epoch_to_iso(now_epoch)
    episode["resolution"] = resolution
    if outcome is not None:
        episode["lastRecoveryStatus"] = outcome
    incidents = deadman_state.get("incidents")
    if isinstance(incidents, dict):
        for record in incidents.values():
            if isinstance(record, dict) and record.get("status") == "open":
                record["status"] = "resolved"
                record["resolvedAtEpoch"] = now_epoch
    deadman_state["lastResolvedEpisode"] = episode
    deadman_state["episode"] = None


def advance_deadman_episode(
    deadman_state: dict[str, Any],
    active_members: dict[str, dict[str, Any]],
    *,
    now_epoch: int,
    cooldown_seconds: int,
    attempt_onset: Any,
    attempt_recovery: Any,
) -> dict[str, Any]:
    """Advance the single deadman supervision episode (#2425); mutates state in place.

    Lifecycle rules: sent count and cooldown advance only on an accepted
    delivery (direct sent, or email accepted_unconfirmed); a fully rejected
    notification retains durable pending state and retries with a bounded
    budget; member identities are stable problem codes, so detail churn never
    mints a new episode; a recovery notice is owed only when the onset was
    delivered (or the episode adopted legacy incidents) and resolves the
    episode only once accepted. Returns {"exitCode", "dirty", "logs", ...}.
    """
    logs: list[tuple[dict[str, Any], str]] = []
    episode = deadman_state.get("episode")
    if not isinstance(episode, dict) or episode.get("status") != "open":
        episode = None

    if active_members:
        if episode is None:
            episode = _deadman_new_episode(now_epoch)
            deadman_state["episode"] = episode
        if deadman_state.get("loadError"):
            episode["stateLoadError"] = deadman_state.get("loadError")
        members = episode.setdefault("members", {})
        onset = episode.setdefault("onset", {"state": "pending", "attemptCount": 0, "sentCount": 0, "suppressed": 0})
        revision = int_or_none(episode.get("revision")) or 0
        changed = False
        for code, detail in active_members.items():
            member = members.get(code)
            if not isinstance(member, dict):
                members[code] = {
                    "status": "active",
                    "firstSeenAtEpoch": now_epoch,
                    "firstSeenAt": epoch_to_iso(now_epoch),
                    "lastSeenAtEpoch": now_epoch,
                    "detail": detail,
                }
                changed = True
                continue
            if member.get("status") != "active":
                member["status"] = "active"
                member["reactivatedAtEpoch"] = now_epoch
                changed = True
            member["lastSeenAtEpoch"] = now_epoch
            member["detail"] = detail
        for code, member in members.items():
            if code in active_members or not isinstance(member, dict) or member.get("status") != "active":
                continue
            member["status"] = "recovered"
            member["recoveredAtEpoch"] = now_epoch
            member["recoveredAt"] = epoch_to_iso(now_epoch)
            changed = True
        if changed:
            revision += 1
            episode["revision"] = revision
            onset["attemptCount"] = 0
            if onset.get("state") == "exhausted":
                onset["state"] = "pending"
        episode.pop("recovery", None)

        last_accepted = int_or_none(onset.get("lastAcceptedAtEpoch"))
        accepted_revision = int_or_none(onset.get("lastAcceptedRevision"))
        remaining = 0 if last_accepted is None else max(0, cooldown_seconds - (now_epoch - last_accepted))
        in_cooldown = remaining > 0 and accepted_revision == revision
        member_codes = sorted(
            code for code, member in members.items() if isinstance(member, dict) and member.get("status") == "active"
        )
        base_log: dict[str, Any] = {
            "type": "deadman",
            "episode_id": episode.get("episodeId"),
            "revision": revision,
            "members": member_codes,
            "cooldown_seconds": cooldown_seconds,
        }

        if onset.get("state") == "delivered" and in_cooldown:
            onset["suppressed"] = (int_or_none(onset.get("suppressed")) or 0) + 1
            logs.append((
                {
                    **base_log,
                    "direct_whatsapp": "suppressed_cooldown",
                    "cooldown_remaining_seconds": remaining,
                    "suppressed": onset["suppressed"],
                },
                "info",
            ))
            return {
                "exitCode": 2,
                "dirty": True,
                "logs": logs,
                "delivery": "suppressed_cooldown",
                "suppressed": onset["suppressed"],
                "cooldown_remaining_seconds": remaining,
            }
        if onset.get("state") == "exhausted":
            return {"exitCode": 2, "dirty": True, "logs": logs, "delivery": "pending_exhausted_hold"}
        if (int_or_none(onset.get("attemptCount")) or 0) >= DEADMAN_PENDING_MAX_ATTEMPTS:
            onset["state"] = "exhausted"
            onset["exhaustedAtEpoch"] = now_epoch
            logs.append((
                {**base_log, "direct_whatsapp": "pending_exhausted", "attempt_count": onset.get("attemptCount")},
                "warning",
            ))
            return {"exitCode": 2, "dirty": True, "logs": logs, "delivery": "pending_exhausted"}

        outcome = attempt_onset(episode)
        onset["lastAttempt"] = outcome
        onset["lastAttemptAtEpoch"] = now_epoch
        kind = _deadman_outcome_accepted_kind(outcome)
        if kind:
            onset["state"] = "delivered"
            onset["deliveredKind"] = kind
            onset["sentCount"] = (int_or_none(onset.get("sentCount")) or 0) + 1
            onset["suppressed"] = 0
            onset["attemptCount"] = 0
            onset["lastAcceptedAtEpoch"] = now_epoch
            onset["lastAcceptedAt"] = epoch_to_iso(now_epoch)
            onset["lastAcceptedRevision"] = revision
            onset.pop("pendingSinceEpoch", None)
        else:
            onset["state"] = "pending"
            onset.setdefault("pendingSinceEpoch", now_epoch)
            onset["attemptCount"] = (int_or_none(onset.get("attemptCount")) or 0) + 1
        if outcome.get("direct_whatsapp") == "failed":
            deadman_state["lastRejectedCount"] = (int(deadman_state.get("lastRejectedCount") or 0)) + 1
        logs.append((
            {
                **base_log,
                **outcome,
                "onset_state": onset["state"],
                "attempt_count": int_or_none(onset.get("attemptCount")) or 0,
                "sent_count": int_or_none(onset.get("sentCount")) or 0,
            },
            _deadman_delivery_level(outcome.get("direct_whatsapp", "")),
        ))
        return {
            "exitCode": 2,
            "dirty": True,
            "logs": logs,
            "delivery": outcome.get("direct_whatsapp"),
            "onset_state": onset["state"],
        }

    # No active problems.
    if episode is None:
        return {"exitCode": 0, "dirty": False, "logs": logs, "delivery": "ok"}
    members = episode.setdefault("members", {})
    onset = episode.setdefault("onset", {"state": "pending", "attemptCount": 0, "sentCount": 0, "suppressed": 0})
    revision = int_or_none(episode.get("revision")) or 0
    changed = False
    for member in members.values():
        if isinstance(member, dict) and member.get("status") == "active":
            member["status"] = "recovered"
            member["recoveredAtEpoch"] = now_epoch
            member["recoveredAt"] = epoch_to_iso(now_epoch)
            changed = True
    if changed:
        revision += 1
        episode["revision"] = revision
    base_log = {"type": "deadman_recovery", "episode_id": episode.get("episodeId"), "revision": revision}
    recovery_owed = (int_or_none(onset.get("sentCount")) or 0) > 0 or bool(episode.get("adoptedLegacyIncidents"))
    if not recovery_owed:
        # Never-delivered episodes resolve quietly: the owner was never paged,
        # so there is nothing to declare recovered (marker-gated clear).
        _resolve_deadman_episode(deadman_state, episode, now_epoch, resolution="self_healed_before_delivery", outcome=None)
        logs.append(({**base_log, "delivery": "not_required"}, "info"))
        return {"exitCode": 0, "dirty": True, "logs": logs, "delivery": "recovery_not_required"}
    recovery = episode.get("recovery")
    if not isinstance(recovery, dict):
        recovery = {"state": "pending", "attemptCount": 0, "pendingSinceEpoch": now_epoch}
        episode["recovery"] = recovery
    if recovery.get("state") == "exhausted":
        return {"exitCode": 0, "dirty": changed, "logs": logs, "delivery": "recovery_exhausted_hold"}
    if (int_or_none(recovery.get("attemptCount")) or 0) >= DEADMAN_PENDING_MAX_ATTEMPTS:
        recovery["state"] = "exhausted"
        recovery["exhaustedAtEpoch"] = now_epoch
        logs.append((
            {**base_log, "delivery": "pending_exhausted", "attempt_count": recovery.get("attemptCount")},
            "warning",
        ))
        return {"exitCode": 0, "dirty": True, "logs": logs, "delivery": "recovery_pending_exhausted"}
    outcome = attempt_recovery(episode)
    recovery["lastAttempt"] = outcome
    recovery["lastAttemptAtEpoch"] = now_epoch
    kind = _deadman_outcome_accepted_kind(outcome)
    if kind:
        recovery["state"] = "delivered"
        recovery["deliveredKind"] = kind
        _resolve_deadman_episode(
            deadman_state, episode, now_epoch, resolution=f"recovery_{kind}", outcome=outcome
        )
        deadman_state["lastRecoveryResult"] = "success" if outcome.get("direct_whatsapp") == "sent" else "failed"
    else:
        recovery["state"] = "pending"
        recovery["attemptCount"] = (int_or_none(recovery.get("attemptCount")) or 0) + 1
    logs.append((
        {
            **base_log,
            **outcome,
            "recovery_state": recovery.get("state"),
            "attempt_count": int_or_none(recovery.get("attemptCount")) or 0,
        },
        _deadman_delivery_level(outcome.get("direct_whatsapp", "")),
    ))
    return {"exitCode": 0, "dirty": True, "logs": logs, "delivery": outcome.get("direct_whatsapp")}


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
    elif "fail required_tools_probe:" in lower:
        # Instance stays "unknown" so critical_asset_instance never overrides the
        # event instance: the companion clear keys on the default instance, and
        # an override here would orphan the open incident on a sibling key.
        instance = "unknown"
        code = "MCP_TOOL_INVENTORY_UNOBSERVED"
        recoverability = "operator_recoverable"
        confidence = "probable"
        domain = "tool_observability"
        asset_kind = "mcp_tool_inventory"
        operator_action = "Inspect the personal MCP socket configuration, transport, and protocol contract; do not treat required tools as missing until a trustworthy inventory observation succeeds."
        clear_requirement = "daily-health clear after a successful well-formed tools/list observation"
    elif "fail required_tools:" in lower:
        instance = "unknown"
        code = "MCP_REQUIRED_TOOLS_MISSING"
        recoverability = "operator_recoverable"
        confidence = "confirmed"
        domain = "tool_availability"
        asset_kind = "mcp_tool_inventory"
        operator_action = "Restore or register the missing required MCP tools on the personal runtime; the absence was observed by a successful inventory response."
        clear_requirement = "daily-health clear after a successful inventory observes every required tool"

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
    asset: str | None = None,
    alert_source: str | None = None,
    force_notify: bool = False,
) -> Path:
    root = state_root()
    outbox, provenance = resolve_outbox_dir()
    ensure_private_dir(root)
    event_id = f"health-{time.time_ns()}-{os.getpid()}"
    envelope_event_type = "observation" if event_type == "alert" and severity == "info" else event_type
    event = {
        **new_event_fields(envelope_event_type, severity),
        "id": event_id,
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
    if asset is not None:
        event["asset"] = {"kind": "health_target", "name": asset}
    else:
        derived_alert_source = alert_source_from_health_evidence(str(event["evidence"]))
        if not derived_alert_source:
            derived_alert_source = alert_source_from_critical_asset(critical_asset)
        if derived_alert_source:
            event["alertSource"] = derived_alert_source
    # #2358 shadow mode: separated observer/target provenance. The generic
    # `process` block above describes THIS producer; when the event names a
    # target instance distinct from the producer, resolve that target's own
    # provenance (fail-closed to unknown) instead of letting producer evidence
    # stand in for it.
    event["observerProvenance"] = redact_json_value(
        safe_observer_provenance("bot-errors-health-check", __file__, HOST_PLATFORM)
    )
    target_instance = str(event["instance"])
    if target_instance and target_instance != "bot-errors-health":
        event["targetProvenance"] = redact_json_value(safe_target_provenance(target_instance, HOST_PLATFORM))
    if force_notify:
        event["diagnostics"]["forceNotify"] = True
        event["diagnostics"]["forceNotifyLevel"] = "critical"
    path = outbox / f"{event['createdAt'].replace(':', '').replace('-', '')}.{event_id}.json"
    try:
        target = _durable_target(path)
        absent = JsonVersion(False, None, None, None)
        publication_operation = operation_id(
            target,
            event,
            component="health_check.outbox_event",
            predecessor=absent,
        )
        publication = publish_event_json(
            target,
            event,
            component="health_check.outbox_event",
            operation_id=publication_operation,
        )
        require_advance(publication)
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
            asset=instance,
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


def json_rpc(
    socket_path: str,
    method: str,
    params: dict[str, Any] | None = None,
    timeout: float = 12.0,
    *,
    initialize_sink: dict[str, Any] | None = None,
) -> dict[str, Any]:
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
            init_result = wait_for_response(reader, init_id, timeout)
            if initialize_sink is not None and isinstance(init_result, dict):
                initialize_sink.update(init_result)
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


def email_fallback_outcome(subject: str, body: str) -> str:
    """Typed email delivery outcome (#2425).

    accepted_unconfirmed: the fallback binary exited 0 (relay accepted; final
    delivery unproven). rejected: proven non-zero exit. timed_out: the binary
    ran past its budget, so acceptance is unknown but unproven. unavailable:
    the binary is missing, non-executable, or failed to spawn.
    """
    fallback = Path(EMAIL_FALLBACK)
    if not fallback.exists() or not os.access(fallback, os.X_OK):
        return "unavailable"
    try:
        proc = subprocess.run(
            [str(fallback), "--subject", subject, "--body", body],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return "timed_out"
    except OSError:
        return "unavailable"
    return "accepted_unconfirmed" if proc.returncode == 0 else "rejected"


def email_fallback(subject: str, body: str) -> bool:
    return email_fallback_outcome(subject, body) == "accepted_unconfirmed"


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


def instance_db_inventory() -> list[str]:
    """Scan WhatSoup instance roots for 0-byte .db files (decoy DB tripwire).

    EXCLUDES recovery-backups/ subtrees and *-wal/*-shm sidecars (benign
    snapshot artifacts). Alert text names the found path and points at
    docs/configuration.md's XDG table.
    """
    instances_root = Path.home() / ".local/share/whatsoup/instances"
    lines: list[str] = []
    if not instances_root.is_dir():
        return lines
    for entry in sorted(instances_root.iterdir()):
        if not entry.is_dir():
            continue
        instance_name = entry.name
        _scan_instance_db_dir(entry, instance_name, lines)
    return lines


def _scan_instance_db_dir(root: Path, instance_name: str, lines: list[str]) -> None:
    """Recurse into root, appending FAIL lines for 0-byte .db files.

    Skips recovery-backups/ subtrees and *-wal/*-shm sidecars.
    """
    try:
        entries = sorted(root.iterdir())
    except PermissionError:
        lines.append(f"WARN instance_db {instance_name}: permission_denied scanning {root}")
        return

    for child in entries:
        if child.is_dir():
            if child.name == "recovery-backups":
                continue
            _scan_instance_db_dir(child, instance_name, lines)
            continue
        name = child.name
        if name.endswith("-wal") or name.endswith("-shm"):
            continue
        if name.endswith(".db") and child.stat().st_size == 0:
            lines.append(
                f"FAIL instance_db {instance_name}: zero_byte_db path={child} — "
                "see docs/configuration.md XDG table for expected layout"
            )


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


def health_probe_details(status: int, body: str, expected_name: str | None = None, token_sent: bool = False, token_missing: bool = False) -> str:
    details: list[str] = []
    def add_marker(marker: str) -> None:
        if marker not in details:
            details.insert(0, marker)

    try:
        data = json.loads(body)
    except Exception:
        data = None
    if status == 200:
        if data is None:
            add_marker("health_body_malformed")
            return " ".join(details)
        if not isinstance(data, dict):
            add_marker("health_body_nonobject")
            return " ".join(details)
    if data is None or not isinstance(data, dict):
        return ""
    # Register F01: record which projection the evidence came from. The public
    # liveness envelope proves transport only; a token that was sent but still
    # produced the public projection was rejected — monitoring-config debt,
    # never a workload verdict.
    health_projection = classify_projection(data, token_sent=token_sent)
    append_evidence_field(details, "health_projection", health_projection)
    if token_sent and health_projection == "unobserved":
        add_marker("health_token_rejected")
    if token_missing:
        add_marker("health_token_missing")
    if health_projection != "diagnostic":
        # Authority-lattice ceiling: only the DIAGNOSTIC projection (disclosed
        # body reached with an accepted token) may contribute identity/auth/
        # DB/provider fields. Every other projection — anonymous reads,
        # rejected tokens, unrecognised body shapes — contributes liveness-only
        # fields, regardless of whether a token was attempted. A disclosed
        # shape inside this branch is only reachable unauthenticated (disclosed
        # + token classifies diagnostic) and means the server disclosed to an
        # anonymous client — a config anomaly surfaced as evidence.
        if health_body_is_disclosed(data):
            add_marker("health_unauthenticated_disclosure")
        data = {k: data[k] for k in ("schema_version", "status", "generated_at") if k in data}
    if is_public_envelope(data):
        return " ".join(details)
    whatsapp = data.get("whatsapp") if isinstance(data.get("whatsapp"), dict) else {}
    connection = whatsapp.get("connection") if isinstance(whatsapp.get("connection"), dict) else {}

    if status in {401, 403}:
        add_marker("health_probe_auth_failed")
    elif status != 200 and status < 500:
        add_marker("health_unexpected_status")

    if health_projection != "diagnostic":
        # Body-field verdicts (status text, freshness, identity, auth-bond,
        # provider, runtime) exist only under the diagnostic projection; every
        # other projection has already contributed its markers above. The
        # status-code markers stay: the HTTP status is transport evidence
        # regardless of body authenticity.
        return " ".join(details)

    status_text = data.get("status")
    if isinstance(status_text, str) and status_text:
        append_evidence_field(details, "status", status_text)
        if status_text == "degraded":
            add_marker("health_degraded")
        elif status_text == "unhealthy":
            add_marker("health_unhealthy")
        elif status == 200 and status_text != "healthy":
            add_marker("health_status_unknown")
    elif status == 200:
        add_marker("health_status_missing")
    if status == 200:
        generated_at = data.get("generated_at")
        generated_at_epoch = parse_iso_epoch(generated_at)
        if generated_at is None:
            add_marker("health_generated_at_missing")
        elif generated_at_epoch is None:
            add_marker("health_generated_at_unparseable")
        else:
            generated_at_age = current_epoch() - generated_at_epoch
            details.append(f"generated_at_age_seconds={generated_at_age}")
            max_age = env_int("BOT_ERRORS_HEALTH_BODY_MAX_AGE_SECONDS", 30)
            max_future_skew = env_int("BOT_ERRORS_HEALTH_BODY_MAX_FUTURE_SKEW_SECONDS", 5)
            if generated_at_age > max_age:
                add_marker("health_generated_at_stale")
            elif generated_at_age < -max_future_skew:
                add_marker("health_generated_at_future_skew")
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
    # #3074: assert the RUNNING instance process node version against the repo
    # pin. The running version comes from lifecycle telemetry (the ACTUAL process,
    # not shutil.which('node')); when absent (no telemetry) no drift marker is
    # emitted -- undiscoverable is not drift.
    drift_marker = node_version_drift_marker(
        lifecycle_env.get("nodeVersion"), read_nvmrc_pin()
    )
    if drift_marker:
        add_marker(drift_marker)
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
    instance_provider_value = instance_meta.get("provider")
    instance_effective_provider_value = instance_meta.get("effectiveProvider")
    instance_provider = runtime_provider_name(instance_provider_value)
    instance_effective_provider = runtime_provider_name(instance_effective_provider_value)
    instance_fallback_active_until = instance_meta.get("fallbackActiveUntil")
    append_runtime_provider_evidence(details, "instance_provider", instance_provider_value)
    append_runtime_provider_evidence(
        details, "instance_effective_provider", instance_effective_provider_value
    )
    append_evidence_field(details, "instance_fallback_active_until", instance_fallback_active_until)
    append_evidence_field(details, "instance_fallback_reason", instance_meta.get("fallbackReason"))
    append_evidence_field(details, "instance_fallback_model", instance_meta.get("fallbackModel"))
    append_evidence_field(details, "instance_fallback_reset_at", instance_meta.get("fallbackResetAt"))
    append_evidence_field(details, "instance_fallback_recovery_probe_required", instance_meta.get("fallbackRecoveryProbeRequired"))
    if provider_fallback_active(instance_provider, instance_effective_provider, instance_fallback_active_until):
        add_marker("runtime_agent_fallback_active")
    if status == 200 and expected_name and not instance_name and health_body_is_disclosed(data):
        add_marker("health_identity_missing")
        append_evidence_field(details, "expected_instance", expected_name)
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
    append_evidence_field(details, "outbound_success_at", outbound_success_at)
    if isinstance(outbound_success_at, str) and outbound_success_at:
        details.append("outbound_success_evidence=provider_acknowledged_or_better")
    runtime = data.get("runtime") if isinstance(data.get("runtime"), dict) else {}
    agent = runtime.get("agent") if isinstance(runtime.get("agent"), dict) else {}
    if agent:
        runtime_primary_provider_value = agent.get("primaryProvider") or agent.get("agentProvider")
        runtime_effective_provider_value = agent.get("effectiveProvider")
        runtime_primary_provider = runtime_provider_name(runtime_primary_provider_value)
        runtime_effective_provider = runtime_provider_name(runtime_effective_provider_value)
        runtime_fallback_active_until = agent.get("fallbackActiveUntil")
        if provider_fallback_active(runtime_primary_provider, runtime_effective_provider, runtime_fallback_active_until):
            add_marker("runtime_agent_fallback_active")
        for key, label in [
            ("lastSessionStatus", "runtime_agent_last_session_status"),
            ("sessionScope", "runtime_agent_session_scope"),
            ("primaryProvider", "runtime_agent_primary_provider"),
            ("effectiveProvider", "runtime_agent_effective_provider"),
            ("fallbackActiveUntil", "runtime_agent_fallback_active_until"),
            ("fallbackReason", "runtime_agent_fallback_reason"),
            ("fallbackModel", "runtime_agent_fallback_model"),
            ("fallbackResetAt", "runtime_agent_fallback_reset_at"),
            ("fallbackRecoveryProbeRequired", "runtime_agent_fallback_recovery_probe_required"),
            ("agentProvider", "runtime_agent_agent_provider"),
        ]:
            value = agent.get(key)
            if key in {"primaryProvider", "effectiveProvider", "agentProvider"}:
                append_runtime_provider_evidence(details, label, value)
            else:
                append_evidence_field(details, label, value)
        last_session_started_epoch = parse_iso_epoch(agent.get("lastSessionStartedAt"))
        if last_session_started_epoch is not None:
            details.append(
                "runtime_agent_last_session_lifetime_age_seconds="
                f"{current_epoch() - last_session_started_epoch}"
            )
        turn_capability = agent.get("turnCapability")
        if isinstance(turn_capability, dict):
            last_successful_turn_at = read_int(turn_capability.get("lastSuccessfulTurnAt"))
            if last_successful_turn_at is not None and last_successful_turn_at >= 0:
                details.append(
                    "runtime_agent_last_successful_turn_age_seconds="
                    f"{(current_epoch() * 1000 - last_successful_turn_at) // 1000}"
                )
            last_successful_turn_provider = runtime_provider_name(
                turn_capability.get("lastSuccessfulTurnProvider")
            )
            if last_successful_turn_provider is not None:
                details.append(
                    "runtime_agent_last_successful_turn_provider="
                    f"{last_successful_turn_provider}"
                )
            last_successful_turn_session_current = turn_capability.get(
                "lastSuccessfulTurnSessionCurrent"
            )
            if isinstance(last_successful_turn_session_current, bool):
                details.append(
                    "runtime_agent_last_successful_turn_session_current="
                    f"{str(last_successful_turn_session_current).lower()}"
                )
        health_signals, registry_error = load_runtime_agent_health_signals()
        if registry_error is not None:
            add_marker("runtime_agent_health_signal_registry_invalid")
            details.append(
                f"runtime_agent_health_signal_registry_error={registry_error}"
            )
        elif health_signals is not None:
            for signal in health_signals:
                key = signal["field"]
                number = read_int(agent.get(key))
                if number is None:
                    continue
                if number != 0 or key in {"activeSessions", "sessionCount"}:
                    details.append(f"{signal['label']}={number}")
                if signal["currentHealthEffect"] == "positive_is_risk" and number > 0:
                    add_marker("runtime_agent_at_risk")
            auto_compact_state = agent.get("autoCompactState")
            if auto_compact_state in RUNTIME_AGENT_AUTO_COMPACT_STATES:
                details.append(
                    f"runtime_agent_auto_compact_state={auto_compact_state}"
                )
        last_crash_at = agent.get("lastCrashAt")
        if isinstance(last_crash_at, str) and last_crash_at:
            details.append(f"runtime_agent_last_crash_at={last_crash_at}")
        last_resume_failed_at = agent.get("lastResumeFailedAt")
        if isinstance(last_resume_failed_at, str) and last_resume_failed_at:
            details.append(f"runtime_agent_last_resume_failed_at={last_resume_failed_at}")
    return " ".join(details)


def format_health_probe(url: str, status: int, body: str = "", expected_name: str | None = None, token_sent: bool = False, token_missing: bool = False) -> str:
    details = health_probe_details(status, body, expected_name, token_sent, token_missing)
    suffix = f" {details}" if details else ""
    # A 5xx is a workload failure only when the evidence projection is
    # diagnostic (or unknown, e.g. a malformed body): public and unobserved
    # projections cap at monitoring-debt WARNs. health_token_rejected always
    # co-occurs with health_projection=unobserved.
    non_diagnostic_evidence = (
        "health_projection=public" in details
        or "health_projection=unobserved" in details
    )
    if (
        (status >= 500 and not non_diagnostic_evidence)
        or "health_probe_auth_failed" in details
        or "health_identity_mismatch" in details
        or "health_identity_missing" in details
        or "health_body_malformed" in details
        or "health_body_nonobject" in details
        or "health_unexpected_status" in details
        or "health_generated_at_stale" in details
        or "health_generated_at_future_skew" in details
        or "auth_bond_at_risk" in details
        or "physical_intervention_required" in details
        or "health_unhealthy" in details
    ):
        prefix = "FAIL "
    elif (
        "health_degraded" in details
        or "health_status_missing" in details
        or "health_status_unknown" in details
        or "health_generated_at_missing" in details
        or "health_generated_at_unparseable" in details
        or "runtime_agent_at_risk" in details
        or "runtime_agent_health_signal_registry_invalid" in details
        or "runtime_agent_fallback_active" in details
        or "auth_bond_restore_canary_failed" in details
        or "auth_bond_backup_age_warning" in details
        or "node_version_drift" in details
        or "health_token_rejected" in details
        or "health_token_missing" in details
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
        # A dry-injected body is fixture CONTENT, not proof of authentication:
        # it evaluates under whatever authority the environment actually
        # resolves (the same token path as a live read), so an unauthenticated
        # injection can never manufacture diagnostic authority.
        dry_token = instance_health_token(expected_name) if expected_name else None
        dry_token_missing = bool(expected_name) and not dry_token
        return format_health_probe(
            url, dry_status, dry_body, expected_name, bool(dry_token), dry_token_missing
        )
    token = instance_health_token(expected_name) if expected_name else None
    # A missing token must not skip the probe: connection-refused on this very
    # attempt is how a DOWN on-demand agent is detected. The anonymous response
    # is marked health_token_missing and stays non-diagnostic.
    token_missing = bool(expected_name) and not token
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    req = Request(url, method="GET", headers=headers)
    token_sent = bool(token)
    try:
        with urlopen(req, timeout=HEALTH_PROBE_TIMEOUT_SECONDS) as response:
            body = response.read(64 * 1024).decode("utf-8", errors="replace")
            return format_health_probe(url, response.status, body, expected_name, token_sent, token_missing)
    except HTTPError as exc:
        body = exc.read(64 * 1024).decode("utf-8", errors="replace")
        return format_health_probe(url, exc.code, body, expected_name, token_sent, token_missing)
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
    targets = fallback_probe_targets(data)
    return targets[0]["provider"] if targets else None


def fallback_probe_targets(data: dict[str, Any]) -> list[dict[str, str]]:
    agent_options = agent_options_from_config(data)
    chain = agent_options.get("fallbacks")
    targets: list[dict[str, str]] = []
    if isinstance(chain, list):
        for index, raw in enumerate(chain):
            if not isinstance(raw, dict):
                continue
            provider = raw.get("provider")
            if not isinstance(provider, str) or not provider.strip():
                continue
            target = {"provider": provider.strip(), "target": f"fallback[{index}]"}
            model = raw.get("model")
            if isinstance(model, str) and model.strip():
                target["model"] = model.strip()
            targets.append(target)
        return targets

    provider = agent_options.get("fallbackProvider")
    if not isinstance(provider, str) or not provider.strip():
        return []
    target = {"provider": provider.strip(), "target": "fallback"}
    model = agent_options.get("fallbackModel")
    if isinstance(model, str) and model.strip():
        target["model"] = model.strip()
    return [target]


def fallback_target_entry(data: dict[str, Any], target: str) -> dict[str, Any] | None:
    match = re.fullmatch(r"fallback\[(\d+)\]", target)
    if match:
        chain = agent_options_from_config(data).get("fallbacks")
        index = int(match.group(1))
        if isinstance(chain, list) and index < len(chain) and isinstance(chain[index], dict):
            return chain[index]
        return None
    if target == "fallback":
        options = agent_options_from_config(data)
        return {
            "provider": options.get("fallbackProvider"),
            "model": options.get("fallbackModel"),
        }
    return None


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
    provider_config = opencode_provider_config_from_config(data, target)
    mode = provider_config.get("opencodeCommandMode")
    return mode.strip() if isinstance(mode, str) and mode.strip() else "auto"


def opencode_provider_config_from_config(data: dict[str, Any], target: str) -> dict[str, Any]:
    agent_options = agent_options_from_config(data)
    primary = agent_options.get("providerConfig")
    provider_config = dict(primary) if isinstance(primary, dict) else {}
    if not target.startswith("fallback"):
        return provider_config

    # Mirror fallbackProviderConfigFor(): OpenCode inherits the primary provider
    # execution settings, but never its custom endpoint route or credential id.
    entry = fallback_target_entry(data, target)
    if isinstance(entry, dict) and entry.get("provider") == "opencode-cli":
        provider_config.pop("baseUrl", None)
        provider_config.pop("apiKeyService", None)
        return provider_config
    return {}


def provider_model_from_config(data: dict[str, Any], target: str = "primary") -> str | None:
    agent_options = agent_options_from_config(data)
    if target.startswith("fallback"):
        entry = fallback_target_entry(data, target)
        model = entry.get("model") if isinstance(entry, dict) else None
        return model.strip() if isinstance(model, str) and model.strip() else None
    model = agent_options.get("model")
    if isinstance(model, str) and model.strip():
        return model.strip()
    model = data.get("model")
    if isinstance(model, str) and model.strip():
        return model.strip()
    models = data.get("models")
    conversation_model = models.get("conversation") if isinstance(models, dict) else None
    return conversation_model.strip() if isinstance(conversation_model, str) and conversation_model.strip() else None


def opencode_key_service_from_config(data: dict[str, Any], target: str) -> str | None:
    provider_config = opencode_provider_config_from_config(data, target)
    base_url = provider_config.get("baseUrl")
    api_key_service = provider_config.get("apiKeyService")
    if (
        isinstance(base_url, str)
        and base_url.strip()
        and isinstance(api_key_service, str)
        and api_key_service in SERVICE_ENV_MAP
    ):
        return api_key_service
    return opencode_key_service_for_model(provider_model_from_config(data, target))


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


PRIVATE_CREDENTIAL_MAX_BYTES = 4096
OPENCODE_AUTH_MAX_BYTES = 1024 * 1024


def read_private_credential_file(
    path: Path,
    max_bytes: int = PRIVATE_CREDENTIAL_MAX_BYTES,
    require_private_parent: bool = True,
) -> str | None:
    """Read a current-user 0600 regular file without following symlinks."""
    try:
        parent_stat = path.parent.lstat()
        if (
            stat.S_ISLNK(parent_stat.st_mode)
            or not stat.S_ISDIR(parent_stat.st_mode)
            or parent_stat.st_uid != os.getuid()
            or (require_private_parent and stat.S_IMODE(parent_stat.st_mode) & 0o077)
        ):
            return None
        path_stat = path.lstat()
        if (
            stat.S_ISLNK(path_stat.st_mode)
            or not stat.S_ISREG(path_stat.st_mode)
            or path_stat.st_uid != os.getuid()
            or stat.S_IMODE(path_stat.st_mode) & 0o077
            or path_stat.st_size > max_bytes
        ):
            return None
    except OSError:
        return None

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd: int | None = None
    try:
        fd = os.open(path, flags)
        opened_stat = os.fstat(fd)
        if (
            not stat.S_ISREG(opened_stat.st_mode)
            or opened_stat.st_uid != os.getuid()
            or stat.S_IMODE(opened_stat.st_mode) & 0o077
            or opened_stat.st_size > max_bytes
        ):
            return None
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining > 0:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > max_bytes:
            return None
        value = raw.decode("utf-8").strip()
        return value or None
    except (OSError, UnicodeDecodeError):
        return None
    finally:
        if fd is not None:
            os.close(fd)


def credential_home(source_env: dict[str, str] | None = None) -> Path:
    environment = source_env if source_env is not None else os.environ
    home = environment.get("HOME")
    return Path(home).expanduser() if home else Path.home()


def whatsoup_keyfile_value(service: str, source_env: dict[str, str] | None = None) -> str | None:
    environment = source_env if source_env is not None else os.environ
    base = environment.get("XDG_CONFIG_HOME") or str(credential_home(source_env) / ".config")
    return read_private_credential_file(
        Path(base) / "whatsoup" / "credentials" / f"{service}.key"
    )


def whatsoup_keyfile_present(service: str, source_env: dict[str, str] | None = None) -> bool:
    """True when ~/.config/whatsoup/credentials/<service>.key holds a non-empty value.

    This is the file store unscoped lookupCredential consults before a keyring. It is the store the
    live fleet is actually provisioned into, so the health-check MUST check it or it reports a
    runtime-resolvable key as missing (false negative). Scoped lookup excludes this store because
    it has no account dimension. NOTE: lookupCredential's file store keys on the ORIGINAL service
    name only (no migration), so we do too.
    """
    return whatsoup_keyfile_value(service, source_env) is not None


def opencode_auth_credential_value(service: str, source_env: dict[str, str] | None = None) -> str | None:
    environment = source_env if source_env is not None else os.environ
    base = environment.get("XDG_DATA_HOME") or str(credential_home(source_env) / ".local" / "share")
    auth_path = Path(base) / "opencode" / "auth.json"
    raw = read_private_credential_file(
        auth_path,
        OPENCODE_AUTH_MAX_BYTES,
        require_private_parent=False,
    )
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    entry = parsed.get(service)
    if not isinstance(entry, dict):
        return None
    key = entry.get("key")
    return key.strip() if isinstance(key, str) and key.strip() else None


def provider_credential_value(
    service: str,
    timeout_seconds: int,
    source_env: dict[str, str] | None = None,
) -> str | None:
    """Resolve one provider credential using the runtime lookup order."""
    env_key = service_env_var(service)
    environment = source_env if source_env is not None else os.environ
    if env_key:
        value = environment.get(env_key)
        if value and value.strip():
            return value.strip()

    value = whatsoup_keyfile_value(service, source_env)
    if value:
        return value

    candidates = [service, *SERVICE_KEYCHAIN_FALLBACKS.get(service, [])]
    if HOST_PLATFORM == "darwin":
        account = environment.get("USER") or credential_home(source_env).name or "unknown"
        for candidate in candidates:
            try:
                proc = subprocess.run(
                    ["security", "find-generic-password", "-s", candidate, "-a", account, "-w"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    timeout=min(timeout_seconds, 3),
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            value = proc.stdout.strip()
            if proc.returncode == 0 and value:
                return value
    elif shutil.which("secret-tool"):
        for candidate in candidates:
            try:
                proc = subprocess.run(
                    ["secret-tool", "lookup", "service", candidate],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    timeout=min(timeout_seconds, 3),
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            value = proc.stdout.strip()
            if proc.returncode == 0 and value:
                return value
    return opencode_auth_credential_value(service, source_env)


def _keychain_secret_status(
    candidates: list[str],
    account: str,
    timeout_seconds: int,
    user: str | None = None,
) -> str:
    """darwin keychain read for the first resolvable candidate.
    Returns 'present' | 'missing' | 'timeout' | 'probe_error_<detail>'."""
    for candidate in candidates:
        candidate_account = user if user is not None else account
        try:
            proc = subprocess.run(
                ["security", "find-generic-password", "-s", candidate, "-a", candidate_account, "-w"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=min(timeout_seconds, 3),
                check=False,
            )
        except subprocess.TimeoutExpired:
            return "timeout"
        except Exception as exc:  # noqa: BLE001 - credential check should be diagnostic-only.
            return f"probe_error_{redact_evidence_string(str(exc), 80)}"
        if proc.returncode == 0 and proc.stdout.strip():
            return "present"
    return "missing"


def _secret_tool_status(
    candidates: list[str],
    timeout_seconds: int,
    user: str | None = None,
) -> str:
    """linux secret-tool read for the first resolvable candidate.
    Returns 'present' | 'missing' | 'empty' | 'timeout' | 'probe_error_<detail>'."""
    saw_empty = False
    for candidate in candidates:
        args = ["secret-tool", "lookup", "service", candidate]
        if user is not None:
            args.extend(["user", user])
        try:
            proc = subprocess.run(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=min(timeout_seconds, 3),
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


def provider_credential_presence(
    service: str,
    timeout_seconds: int,
    user: str | None = None,
    source_env: dict[str, str] | None = None,
) -> tuple[bool, str, str]:
    # Mirror src/lib/keyring.ts lookupCredential resolution EXACTLY so a key the runtime can
    # resolve is never reported missing (and vice-versa):
    #   unscoped: env var -> ~/.config/whatsoup/credentials/<svc>.key -> OS keyring
    #   scoped:   OS keyring -> env var, with no unscoped .key access
    # NOTE: ~/.config/secrets/<svc>.env is the `ocw` worker store; the WhatSoup runtime does NOT
    # source it, so it is reported as a diagnostic negative only, never as provisioned. (2026-06-23:
    # the fleet is provisioned via the .key file store, not the keychain — checking only env/.env/
    # keychain produced false "missing fallback credentials" despite a healthy runtime.)
    env_key = service_env_var(service)
    environment = source_env if source_env is not None else os.environ
    dry_status = dry_credential_status(service)
    if dry_status is not None:
        present = dry_status in {"present", "ok", "true", "1"}
        return present, "dry", dry_status
    if user is None and env_key and (environment.get(env_key) or "").strip():
        return True, "env", "present"
    if user is None and whatsoup_keyfile_present(service, source_env):
        return True, "whatsoup_keyfile", "present"

    candidates = [service, *SERVICE_KEYCHAIN_FALLBACKS.get(service, [])]
    if HOST_PLATFORM == "darwin":
        account = user if user is not None else (environment.get("USER") or credential_home(source_env).name or "unknown")
        keyring_source = "macos_keychain"
        keyring_status = _keychain_secret_status(candidates, account, timeout_seconds, user)
    elif shutil.which("secret-tool"):
        keyring_source = "secret_tool"
        keyring_status = _secret_tool_status(candidates, timeout_seconds, user)
    else:
        keyring_source = "none"
        keyring_status = "missing"

    if keyring_status == "present":
        return True, keyring_source, "present"

    if user is not None and env_key and (environment.get(env_key) or "").strip():
        return True, "env", "present"

    if opencode_auth_credential_value(service, source_env):
        return True, "opencode_auth", "present"

    # Not resolvable by the runtime. A populated ocw .env is a misplacement diagnostic only.
    if secret_file_has_service_key(service, env_key):
        return False, "secret_file", "present_in_ocw_env_only_not_runtime_store"

    if keyring_status == "timeout" or keyring_status.startswith("probe_error_"):
        return False, keyring_source, keyring_status
    if keyring_status == "empty":
        return False, keyring_source, "empty"
    return False, keyring_source, "missing"


def opencode_provider_credential_fragments(
    data: dict[str, Any],
    target: str,
    timeout_seconds: int,
    source_env: dict[str, str] | None = None,
) -> tuple[bool | None, list[str]]:
    model = provider_model_from_config(data, target)
    service = opencode_key_service_from_config(data, target)
    fragments = [
        f"credential_model={redact_evidence_string(model or 'default', 100)}",
        f"credential_required={str(service is not None).lower()}",
    ]
    if service is None:
        fragments.append("credential_status=not_applicable")
        return None, fragments
    env_key = service_env_var(service)
    present, source, status = provider_credential_presence(
        service,
        timeout_seconds,
        source_env=source_env,
    )
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


def executable_candidate(command_name: str, path_value: str | None = None) -> str | None:
    on_path = shutil.which(command_name, path=path_value)
    if on_path:
        return on_path
    if path_value is not None:
        return None
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
    for directory in ("/opt/homebrew/bin", "/usr/local/bin"):
        candidate = Path(directory) / command_name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


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

    return "opencode"


PLIST_ENVIRONMENT_KEY_MARKER = "<key>EnvironmentVariables</key>"
# The dict ELEMENT token, not one literal spelling of it. `<dict>`, `<dict >`,
# `<dict\n>`, `<dict/>` and `<dict attr="x">` are the same element to any plist
# reader, so matching the literal "<dict>" made the nested-dict guard below miss
# every other spelling: the block still truncated at the first `</dict>` and a
# governed key declared AFTER the nested dict read as absent rather than as
# unknown. The lookahead keeps a hypothetical `<dictionary>` out.
# DETECTION is broad: any dict opening token at all, whatever it carries.
PLIST_DICT_OPEN_TOKEN_RE = re.compile(r"<dict(?=[ \t\r\n/>])")
# What this reader will PARSE is narrow: plain, whitespace-padded and
# self-closing. An attributed dict is REFUSED rather than consumed. Consuming to
# the first ">" would end the token early on a legal `<dict a="x>y">`, and the
# remainder of the opening tag would then be read as body pairs -- a first-wins
# injection of a governed key from inside a tag. plist(5) dicts carry no
# attributes, so refusing costs nothing and fails closed.
PLIST_DICT_OPEN_RE = re.compile(r"<dict[ \t\r\n]*(/?)>")
PLIST_DICT_CLOSE_RE = re.compile(r"</dict[ \t\r\n]*>")
# XML whitespace is exactly these four characters. Python's \s and .strip() also
# accept \x0b, \x0c and the Unicode spaces, which the system plist parser
# rejects -- so a plist this reader called well-formed could be one launchd
# refuses to load.
PLIST_XML_SPACE = " \t\r\n"
PLIST_ENV_PAIR_RE = re.compile(
    r"<key>([^<]*)</key>[ \t\r\n]*<string>([^<]*)</string>"
)


# The XML region kinds this reader must never read as markup, as
# (opener, closer) pairs. A comment, a CDATA section and a processing
# instruction are all inert text to the system plist parser: an
# EnvironmentVariables marker, a Label or a dict spelled inside one is not a
# marker, a Label or a dict, however legal the surrounding file is.
PLIST_INERT_XML_REGIONS = (
    ("<!--", "-->"),
    ("<![CDATA[", "]]>"),
    ("<?", "?>"),
)


def mask_inert_xml_regions(raw: str) -> tuple[str, list[tuple[int, int]]] | None:
    """Blank every inert XML region, PRESERVING LENGTH, and REPORT where.

    None if a region is unterminated. Returns (masked_text, spans).

    Comments alone were covered before, and TWO guards were defeated by that,
    both measured on the pre-fix code rather than reasoned about:

      the Label guard. A commented-out Label naming this instance, above a real
      Label naming a DIFFERENT one, was accepted: the reader returned the other
      instance's environment for agent-alpha. That guard exists precisely so an
      unrelated or planted plist at the expected pathname is never parsed, and
      one comment turned it off.

      the EnvironmentVariables marker. A commented-out decoy dict before the
      live one won the ``find``, so the decoy's body was read as the environment
      and the live dict never looked at.

    A CDATA section and a processing instruction are the same defect in two
    further spellings, and they were still live text here: a decoy
    ``<key>EnvironmentVariables</key><dict/>`` inside either one, placed ahead
    of the live dict, was read as an empty environment. Both spellings lint
    clean and ``plutil -extract EnvironmentVariables json`` returns the REAL
    environment for them.

    MASKED, not deleted: length is preserved, so every offset below still
    indexes the real text and no offset map has to be kept honest. '-' is not
    XML whitespace, so an inert region in a whitespace-only GAP still fails the
    checks that require whitespace there. '-' also carries no ambiguity as
    filler, because ``--`` cannot appear inside a well-formed XML comment, and
    it starts no token this reader searches for.

    THE SPANS ARE RETURNED BECAUSE THE FILLER IS NOT ENOUGH ON ITS OWN, and
    that is measured rather than reasoned. In a whitespace-only gap '-' is
    correctly rejected, but in CHARACTER DATA it is perfectly legal: masking
    ``<string><![CDATA[/opt/bin]]></string>`` yields a run of dashes that the
    pair pattern's ``[^<]*`` group matches happily. A body that fails closed
    today -- the literal "<" of ``<![CDATA[`` ends ``[^<]*``, the pair never
    matches, and the body is not fully consumed -- would have started parsing to
    a dash-valued key. The caller therefore refuses on span INTERSECTION with
    the block, which keeps the cdata_value and cdata_key_name cells closed by a
    rule instead of by a filler character's side effect.

    The EARLIEST opener wins at each step, not the first kind in the tuple: a
    processing instruction can carry ``<!--`` as literal text, and a comment can
    carry ``<?``.

    An unterminated opener is not well-formed XML. It used to be ignored, so
    everything after it was parsed as live markup; it is refused now.

    Applied once, to the whole file, BEFORE the Label search -- not just before
    the marker search. Fixing the marker alone would leave the Label decoy.

    A DOCTYPE internal subset is NOT masked. plist(5) files carry an external
    DOCTYPE with no internal subset, and inventing a fourth region kind for a
    shape the generator never emits would widen this reader for nothing.
    """
    out: list[str] = []
    spans: list[tuple[int, int]] = []
    cursor = 0
    while True:
        open_at = -1
        opener_length = 0
        closer = ""
        for candidate_opener, candidate_closer in PLIST_INERT_XML_REGIONS:
            at = raw.find(candidate_opener, cursor)
            if at < 0:
                continue
            if open_at < 0 or at < open_at:
                open_at = at
                opener_length = len(candidate_opener)
                closer = candidate_closer
        if open_at < 0:
            out.append(raw[cursor:])
            return ("".join(out), spans)
        close_at = raw.find(closer, open_at + opener_length)
        if close_at < 0:
            return None
        end = close_at + len(closer)
        out.append(raw[cursor:open_at])
        out.append("-" * (end - open_at))
        spans.append((open_at, end))
        cursor = end


def intersects_inert_region(
    spans: list[tuple[int, int]], start: int, end: int
) -> bool:
    """True when [start, end) overlaps any masked region by at least one byte."""
    return any(span_start < end and start < span_end for span_start, span_end in spans)


def instance_plist_environment(name: str) -> dict[str, str] | None:
    """Read the WHOLE EnvironmentVariables map out of a generated instance plist.

    One reader for every governed key the probe checks (PATH and
    WHATSOUP_PATH_PREPEND today), so a second key cannot arrive with a second
    copy of these guards: regular non-symlink file, bounded size, and a Label
    that matches the instance, so an unrelated or planted plist at the expected
    pathname is never parsed. None means "no readable generated plist", which
    every caller must treat as unknown rather than as absence of drift.
    """
    plist_path = Path.home() / "Library" / "LaunchAgents" / f"com.whatsoup.{name}.plist"
    try:
        plist_stat = plist_path.lstat()
        if not stat.S_ISREG(plist_stat.st_mode) or stat.S_ISLNK(plist_stat.st_mode):
            return None
        if plist_stat.st_size > 65536:
            return None
        raw = plist_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    # Masked FIRST: every search below -- Label, marker, dict bounds, body --
    # must see comments, CDATA sections and processing instructions as inert
    # filler rather than as live markup.
    masked = mask_inert_xml_regions(raw)
    if masked is None:
        return None
    raw, inert_spans = masked
    label_match = re.search(
        r"<key>Label</key>\s*<string>(.*?)</string>", raw, re.DOTALL
    )
    if label_match is None or html.unescape(label_match.group(1)) != f"com.whatsoup.{name}":
        return None
    marker = raw.find(PLIST_ENVIRONMENT_KEY_MARKER)
    if marker < 0:
        return None
    after_marker = marker + len(PLIST_ENVIRONMENT_KEY_MARKER)
    # "Exactly one top-level EnvironmentVariables dictionary." A second surviving
    # marker means the file declares the element twice. The system parser has its
    # own precedence for that; this reader must not invent a different one and
    # then report a map the loaded job does not have. Mirrors the TypeScript
    # comparator (src/fleet/launchd-env-drift.ts).
    if raw.find(PLIST_ENVIRONMENT_KEY_MARKER, after_marker) >= 0:
        return None
    token_match = PLIST_DICT_OPEN_TOKEN_RE.search(raw, after_marker)
    if token_match is None:
        return None
    # Only whitespace may separate the key from its value element; anything else
    # means this dict belongs to some later key, not to EnvironmentVariables.
    #
    # PLIST_XML_SPACE, not a bare .strip(). Python's .strip() also removes
    # U+00A0, form feed and vertical tab, which the system plist parser rejects
    # -- so this gap was the one place left where this reader could call a plist
    # well-formed that launchd refuses to load. The body-consumption checks below
    # already used the XML set; this makes the whole reader agree with itself,
    # and agree with the TypeScript comparator it mirrors.
    if raw[after_marker:token_match.start()].strip(PLIST_XML_SPACE):
        return None
    # The token is located broadly and then must match the narrow form EXACTLY
    # where it was found, so an attributed dict is refused here rather than
    # skipped over in favour of some later plain one.
    open_match = PLIST_DICT_OPEN_RE.match(raw, token_match.start())
    if open_match is None:
        return None
    # `<dict/>` is a well-formed EMPTY map, not an unreadable plist. Saying
    # "unreadable" there misnames the operator's problem; the governed-PATH
    # absence check downstream reports it accurately instead.
    if open_match.group(1):
        return {}
    close_match = PLIST_DICT_CLOSE_RE.search(raw, open_match.end())
    if close_match is None:
        return None
    # AN INERT REGION INSIDE THE BLOCK IS NOT CONTENT THIS READER MAY CONSUME.
    # The mask blanks it to '-', and '-' is legal character data, so a masked
    # CDATA value satisfies the pair pattern's ``[^<]*`` group and a block that
    # fails closed today would parse to a dash-valued key. Measured on the
    # cdata_value and cdata_key_name cells. The whitespace checks below still
    # catch a region in a gap; this catches one in character data, which they
    # cannot.
    if intersects_inert_region(inert_spans, open_match.end(), close_match.start()):
        return None
    block = raw[open_match.end():close_match.start()]
    # The block ends at the FIRST </dict>, so a nested dict truncates the map and
    # makes a declared key read as absent. The TypeScript comparator
    # (src/fleet/launchd-env-drift.ts) refuses outright in that case; match it and
    # report unknown rather than hand back a partial map.
    if PLIST_DICT_OPEN_TOKEN_RE.search(block) is not None:
        return None
    # THE BODY MUST BE FULLY CONSUMED BY THE PAIRS.
    #
    # Extracting adjacent key/string pairs and ignoring the rest is what made a
    # governed key vanish: any token interposed between a key and its string, or
    # any entry the pattern does not model, left the pair unmatched and the key
    # simply absent from the map. Absent on both sides is the benign cell, so the
    # probe reported agreement while launchd loaded the value. The system parser
    # accepts all of these spellings; this reader must not silently disagree with
    # it. So every byte of the body is accounted for: whatever is not a matched
    # pair and not XML whitespace makes the plist UNREADABLE.
    #
    # This is a general rule rather than a list of known-bad tokens, because the
    # failure is structural. It covers at least a CDATA value, a comment or a
    # processing instruction between a key and its string, whitespace inside the
    # </key> or <string> tag, an unpaired key, and a non-string value such as
    # <data> -- launchd's EnvironmentVariables is a dictionary of STRINGS, so a
    # non-string value there is a schema violation and refusing it is correct.
    environment: dict[str, str] = {}
    consumed = 0
    for match in PLIST_ENV_PAIR_RE.finditer(block):
        if block[consumed:match.start()].strip(PLIST_XML_SPACE):
            return None
        key = html.unescape(match.group(1))
        # A duplicate key is refused rather than resolved. This reader took the
        # FIRST occurrence and the TypeScript comparator took the LAST, so the
        # two disagreed about the same file; neither precedence is defensible
        # against a parser that has its own. Refusing settles it on both sides.
        if key in environment:
            return None
        environment[key] = html.unescape(match.group(2)).strip()
        consumed = match.end()
    if block[consumed:].strip(PLIST_XML_SPACE):
        return None
    return environment


def environment_value(environment: dict[str, str] | None, key: str) -> str | None:
    """Single accessor for ONE governed value out of ANY environment map.

    The generated plist, `launchctl print` output and the loaded job all answer
    the same question, so they share one reader rather than each carrying its
    own `.get(...)`. Empty and whitespace-only read as absent: launchctl drops
    empty-valued keys, and an empty PATH entry would otherwise mean the current
    directory.
    """
    if not environment:
        return None
    value = environment.get(key)
    if value is None:
        return None
    return value.strip() or None


def environment_provider_path(environment: dict[str, str] | None) -> str | None:
    """Provider PATH out of any environment map."""
    return environment_value(environment, "PATH")


def instance_provider_path(name: str) -> str | None:
    dry_path = os.environ.get("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH")
    if dry_path is not None:
        return dry_path.strip() or None
    if HOST_PLATFORM != "darwin":
        return os.environ.get("PATH") or None
    return environment_provider_path(instance_plist_environment(name))


GOVERNED_PLIST_READABLE = "readable"
GOVERNED_PLIST_NOT_APPLICABLE = "not_applicable"
GOVERNED_PLIST_UNREADABLE = "unreadable"


def instance_plist_governed_environment(name: str) -> tuple[str, dict[str, str] | None]:
    """(state, environment) for the governed checks. THREE states, not two.

    These used to collapse into one None, and that collapse was a fail-open: a
    caller could not tell "there is no LaunchAgent surface here" from "there is
    one and I could not read it", so it treated both as "no drift" and the
    default provider reported healthy on a missing, planted, oversized,
    symlinked, wrongly-labelled or unreadable plist while opencode failed
    closed on the same fixture.

      not_applicable -- benign. No LaunchAgent surface exists (systemd host) or
        the dry-run PATH override is active. The governed checks genuinely do
        not apply and resolution proceeds unchanged.

        EXACTLY TWO conditions reach this state, and stubbing the probe's OUTPUT
        is not one of them. BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT and
        BOT_ERRORS_DRY_PROVIDER_PROBE_RC replace what the CHILD PROCESS returns;
        they are consumed by provider_command_output and say nothing about
        whether this host has a LaunchAgent surface or whether that surface is
        readable. They used to be read here too, which made either variable
        leaking into a deployed environment silently switch off every check
        below: a missing, planted, symlinked or wrongly-labelled plist still
        reported healthy. A test affordance may shape what the probe EXECUTES
        and what it READS BACK; it may never decide whether a fail-closed path
        applies. Suites that stub the probe pin HOST_PLATFORM and Path.home
        themselves, which is also what keeps them from diverging between a Linux
        runner and a macOS one.
      unreadable -- NOT benign. This is darwin, a plist is expected, and the
        parser refused it. Its docstring already says None means UNKNOWN, so
        callers must fail closed rather than read it as absence of drift.
      readable -- the whole map, read once per probe run so two governed keys
        can never come from two different states of the same file.
    """
    if os.environ.get("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH") is not None:
        return (GOVERNED_PLIST_NOT_APPLICABLE, None)
    if HOST_PLATFORM != "darwin":
        return (GOVERNED_PLIST_NOT_APPLICABLE, None)
    environment = instance_plist_environment(name)
    if environment is None:
        return (GOVERNED_PLIST_UNREADABLE, None)
    return (GOVERNED_PLIST_READABLE, environment)


def launchctl_environment(output: str) -> dict[str, str]:
    environment_match = re.search(
        r"(?ms)^\s*environment = \{\s*$\n(.*?)^\s*\}\s*$",
        output,
    )
    if environment_match is None:
        return {}
    return {
        match.group(1): match.group(2).strip()
        for match in re.finditer(
            r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*) => (.*?)\s*$",
            environment_match.group(1),
        )
        if match.group(2).strip()
    }


def loaded_instance_environment(name: str) -> dict[str, str]:
    dry_path = os.environ.get("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH")
    if dry_path is not None:
        environment = dict(os.environ)
        if dry_path.strip():
            environment["PATH"] = dry_path.strip()
        else:
            environment.pop("PATH", None)
        return environment
    if HOST_PLATFORM != "darwin":
        return dict(os.environ)
    try:
        proc = subprocess.run(
            ["launchctl", "print", f"gui/{os.getuid()}/com.whatsoup.{name}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    return launchctl_environment(proc.stdout) if proc.returncode == 0 else {}


def effective_instance_provider_path(environment: dict[str, str]) -> str | None:
    inherited_path = environment.get("PATH", "").strip()
    if os.environ.get("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH") is not None:
        return inherited_path or None
    home = environment.get("HOME", "").strip()
    node = environment.get("WHATSOUP_NODE", "").strip()
    if not node and home:
        try:
            nvmrc_version = (REPO_ROOT / ".nvmrc").read_text(encoding="utf-8").strip()
        except OSError:
            nvmrc_version = ""
        if nvmrc_version:
            node = str(Path(home) / ".nvm" / "versions" / "node" / f"v{nvmrc_version}" / "bin" / "node")
    if not inherited_path or not home or not node:
        return None
    # The launcher passes the governed prepend as the helper's 4th argument
    # (whatsoup_export_runtime_path reads WHATSOUP_PATH_PREPEND). Passing only
    # three here made the probe compose a DIFFERENT effective PATH than the
    # service, so the two sides could resolve different provider binaries.
    path_prepend = environment.get("WHATSOUP_PATH_PREPEND", "").strip()
    helper = REPO_ROOT / "deploy" / "lib" / "runtime-path.sh"
    try:
        proc = subprocess.run(
            [
                "/bin/bash",
                "-c",
                '. "$1"; whatsoup_effective_runtime_path "$2" "$3" "$4" "$5"',
                "runtime-path",
                str(helper),
                home,
                node,
                inherited_path,
                path_prepend,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=3,
            check=False,
            env={"PATH": "/usr/bin:/bin"},
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    effective_path = proc.stdout.strip()
    return effective_path or None


def instance_provider_path_match(generated_path: str | None, loaded_path: str | None) -> bool:
    return bool(generated_path and loaded_path and generated_path == loaded_path)


def instance_provider_path_prepend_match(
    plist_prepend: str | None,
    loaded_prepend: str | None,
) -> bool:
    """Compare the governed prepend the plist declares against the loaded job's.

    Both absent counts as EQUAL: a host with no service.pathPrepend renders no
    key and launchd loads none, which is agreement rather than drift. Empty and
    whitespace-only normalise to absent because launchctl drops empty-valued
    keys, so an empty rendered value would otherwise never compare equal to
    itself.
    """
    return (plist_prepend or "").strip() == (loaded_prepend or "").strip()


def path_starts_with_entries(path_value: str | None, prefix_value: str | None) -> bool:
    """True when every entry of prefix_value leads path_value, entry by entry.

    Split into entries rather than compared as a string prefix: a string
    comparison would accept "/pin/binary" as satisfying a "/pin/bin" prefix.
    Empty entries are compared, not filtered out, so this agrees with
    pathStartsWithEntries in src/fleet/launchd-env-drift.ts on a hand-edited
    value like "/a::/b" instead of quietly accepting a PATH the TypeScript
    comparator rejects.
    """
    if not prefix_value:
        return True
    prefix_entries = prefix_value.split(":")
    return (path_value or "").split(":")[: len(prefix_entries)] == prefix_entries


REGENERATE_LAUNCHAGENT_REMEDIATION = (
    "regenerate_and_reload_the_instance_launchagent"
    "_or_verify_launchctl_print_output_parses"
)


def generated_provider_path_absence_failure(
    name: str,
    provider: str,
    target: str,
) -> str:
    """Path-free refusal shared by both providers when a readable plist has no PATH."""
    return (
        f"FAIL provider_probe {name}: provider={provider} target={target} "
        "failure_class=provider_runtime_path_unavailable "
        "reason=generated_path_absent governed_path_entries=0 "
        f"remediation={REGENERATE_LAUNCHAGENT_REMEDIATION}"
    )


def plist_unreadable_failure(name: str, provider: str, target: str) -> str:
    """Path-free refusal shared by both providers for an unreadable plist.

    A plist is expected here and the parser refused it: missing, planted,
    wrongly labelled, symlinked, oversized or unreadable.

    SHARED, and that is the point. The two branches described this one state
    two different ways -- the default provider named the plist, opencode
    reported provider_runtime_path_mismatch -- so an operator running both on
    one host was told to regenerate the LaunchAgent for one instance and to
    repair a PATH for the other, for the same fault. Whichever they did first
    was wrong for the other. One function means the classes cannot drift apart
    again without a diff here.

    Path-free like its sibling: the opencode line used to carry the governed
    PATH's directory, and a refusal an operator cannot act on is not worth a
    filesystem path in a health report.
    """
    return (
        f"FAIL provider_probe {name}: provider={provider} target={target} "
        "failure_class=provider_runtime_plist_unreadable "
        f"remediation={REGENERATE_LAUNCHAGENT_REMEDIATION}"
    )


def governed_prepend_failure_class(
    plist_environment: dict[str, str] | None,
    loaded_environment: dict[str, str],
) -> str | None:
    """Governed-prepend failure class shared by EVERY provider probe, or None.

    claude-cli is the default agentOptions.provider, so wiring this check into
    the opencode probe alone would leave the default provider unchecked. Both
    values come from one already-read plist map, so a regenerate landing mid-run
    cannot make the PATH and the prepend disagree by accident. A None
    plist_environment means the governed surfaces are not real here and the
    check is skipped rather than guessed.
    """
    if plist_environment is None:
        return None
    declared = environment_value(plist_environment, "WHATSOUP_PATH_PREPEND")
    if not instance_provider_path_prepend_match(
        declared,
        loaded_environment.get("WHATSOUP_PATH_PREPEND"),
    ):
        return "provider_runtime_path_prepend_mismatch"
    # A declared prepend that does not lead the plist's OWN PATH means the two
    # rendered surfaces of one config fact disagree, so the launcher and the
    # probe would compose different effective PATHs from a single plist.
    if declared and not path_starts_with_entries(
        environment_provider_path(plist_environment),
        declared,
    ):
        return "provider_runtime_path_prepend_inconsistent"
    return None


def probe_directory_is_outside_workspace(probe_cwd: str, workspace: str) -> bool:
    """True when probe_cwd is neither the workspace nor inside it.

    Creating the probe directory under a system temporary root does not PROVE it
    sits outside the instance workspace: TMPDIR can be set to a path within the
    workspace, and either path can traverse a symlink into the other. Both sides
    are resolved before comparison, and the caller fails closed when this is
    False -- an unattended probe must never fall back into the agent's own
    directory, which is the condition the neutral directory exists to guarantee.
    """
    try:
        probe = os.path.realpath(probe_cwd)
        target = os.path.realpath(workspace)
    except OSError:
        return False
    if probe == target or probe.startswith(target.rstrip(os.sep) + os.sep):
        return False
    # String comparison alone is not enough on a case-INSENSITIVE volume, which
    # is the macOS default: "/fixture/Work" and "/fixture/work" name one
    # directory, realpath preserves whichever spelling it was given, and the
    # prefix test then calls a probe directory "outside" a workspace it is
    # actually inside -- the permissive direction. os.path.normcase is NOT the
    # remedy: on POSIX it is the identity function, so it would look like a fix
    # and change nothing. Ask the FILESYSTEM instead, walking the probe's
    # ancestors and comparing by inode.
    #
    # Existence is decided ONCE, before the walk. A configured workspace that
    # does not exist cannot contain anything, so the probe is outside it and the
    # check does not apply -- refusing there would refuse EVERY probe on such an
    # instance, which is the regression this control already had to fix once.
    # Disclosed rather than silent: an absent configured workspace is reported
    # as "outside", not as a containment failure.
    if not os.path.exists(target):
        return True
    # From here the workspace EXISTS, so an unreadable identity is a fact about
    # this process, not about the paths: a permission error, a transient mount
    # failure, or the path being replaced mid-walk. Swallowing it and continuing
    # let the loop run out at the filesystem root and answer "outside", which
    # spawns the provider -- a fail-OPEN branch inside a containment control, and
    # the opposite of what the realpath failure above does. Any OSError now
    # refuses, which is the same direction as every other arm of this function.
    current = probe
    while True:
        try:
            if os.path.samefile(current, target):
                return False
        except OSError:
            return False
        parent = os.path.dirname(current)
        if parent == current:
            return True
        current = parent


def configured_agent_workspace_cwd(data: dict[str, Any]) -> str | None:
    """The CONFIGURED agent workspace, or None when the instance declares none.

    agent_workspace_cwd falls back to the home directory so a spawn always has a
    working directory. The containment check must NOT use that fallback: with no
    configured workspace there is no agent directory to keep the probe out of,
    and on a host whose TMPDIR sits under $HOME the fallback would make every
    probe refuse. The distinction only this function can make is "configured"
    versus "defaulted", so the check asks here and skips itself when the answer
    is None.
    """
    configured = agent_options_from_config(data).get("cwd")
    if isinstance(configured, str) and configured.strip():
        return str(Path(configured.strip()).expanduser())
    return None


def agent_workspace_cwd(data: dict[str, Any], name: str) -> str:
    return configured_agent_workspace_cwd(data) or str(Path.home())


def opencode_runtime_context_problem(data: dict[str, Any]) -> str | None:
    options = agent_options_from_config(data)
    if options.get("sandboxPerChat") is True:
        return "sandbox_per_chat_context_unavailable"
    sandbox = options.get("sandbox")
    if isinstance(sandbox, dict) and isinstance(sandbox.get("allowedEgress"), list):
        return "egress_proxy_context_unavailable"
    return None


def opencode_functional_probe_enabled(profile: dict[str, Any], item: dict[str, Any]) -> bool:
    return profile_bool(
        item,
        "expectOpenCodeFunctionalProbe",
        profile_bool(profile, "expectOpenCodeFunctionalProbe", False),
    )


OPENCODE_DIAGNOSTIC_LOG_RE = re.compile(
    r"^(?:\^D\x08\x08)?timestamp=\S+\s+level=(?:TRACE|DEBUG|INFO|WARN|ERROR)\b"
)


def validate_opencode_functional_jsonl(stdout: str) -> tuple[bool, str]:
    records: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        if OPENCODE_DIAGNOSTIC_LOG_RE.match(line):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            return False, "provider_stream_invalid_jsonl"
        if not isinstance(parsed, dict):
            return False, "provider_stream_invalid_event"
        records.append(parsed)

    if not records:
        return False, "provider_stream_empty"
    if records[0].get("type") != "step_start":
        return False, "provider_stream_missing_step_start"
    terminal_indexes = [
        index for index, record in enumerate(records)
        if record.get("type") == "step_finish"
        and isinstance(record.get("part"), dict)
        and record["part"].get("reason") == "stop"
    ]
    if not terminal_indexes:
        return False, "provider_stream_missing_terminal"
    if terminal_indexes != [len(records) - 1]:
        return False, "provider_stream_terminal_not_last"

    text_parts: list[str] = []
    for record in records[1:-1]:
        if record.get("type") != "text" or not isinstance(record.get("part"), dict):
            return False, "provider_stream_unexpected_event"
        text = record["part"].get("text")
        if not isinstance(text, str):
            return False, "provider_stream_missing_text"
        text_parts.append(text)
    if not text_parts:
        return False, "provider_stream_missing_text"
    if "".join(text_parts).strip() != "OK":
        return False, "provider_stream_unexpected_text"
    return True, "ok"


def opencode_functional_probe_args(command: str, data: dict[str, Any], target: str) -> list[str]:
    provider_config = opencode_provider_config_from_config(data, target)
    args = [
        command,
        "run",
        "--format",
        "json",
        "--pure",
        "--print-logs",
        "--log-level",
        "INFO",
    ]
    if provider_config.get("autoApprovePermissions") is True:
        args.append("--auto")
    execution_profile = provider_config.get("executionProfile")
    if isinstance(execution_profile, str) and execution_profile.strip():
        args.extend(["--agent", execution_profile.strip()])
    model = provider_model_from_config(data, target)
    base_url = provider_config.get("baseUrl")
    if model and not (isinstance(base_url, str) and base_url.strip()):
        args.extend(["-m", model])
    return args


COMMON_FUNCTIONAL_ENV_KEYS = (
    "PATH",
    # Without this the child environment drops the governed prepend and the
    # functional probe resolves a different binary than the service does.
    "WHATSOUP_PATH_PREPEND",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "TERM",
    "NODE_PATH",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "TMPDIR",
)

# The service can select a per-instance configuration/authentication root for
# the default provider, and the probe is meant to exercise that same identity.
# Provider credentials stay excluded.
CLAUDE_FUNCTIONAL_ENV_KEYS = COMMON_FUNCTIONAL_ENV_KEYS + ("CLAUDE_CONFIG_DIR",)

# The opencode probe child must never be WIDER than the production opencode
# child. buildOpenCodeBaseChildEnv (src/runtimes/agent/providers/child-env.ts) is
# a separate positive allowlist whose contract is that Claude-specific auth and
# config variables never enter it; CLAUDE_CONFIG_DIR reached this probe only
# because one shared tuple served both providers. Splitting the tuple keeps the
# probe inside the production envelope.
#
# WHATSOUP_PATH_PREPEND is the one deliberate difference from that production
# child: the probe exists to prove PATH parity, so it must carry the governed
# prepend the launcher uses. It is not an auth or config variable.
OPENCODE_FUNCTIONAL_ENV_KEYS = COMMON_FUNCTIONAL_ENV_KEYS


def governed_child_environment(
    provider_path: str | None = None,
    name: str | None = None,
    child_cwd: str | None = None,
    base_env: dict[str, str] | None = None,
    env_keys: tuple[str, ...] = OPENCODE_FUNCTIONAL_ENV_KEYS,
) -> dict[str, str]:
    """Allowlisted child environment carrying the GOVERNED provider PATH.

    Shared by every provider probe. The binary is selected from the governed
    PATH, so it must also RUN under that PATH: otherwise a `#!/usr/bin/env node`
    wrapper resolves its interpreter from the probe process's PATH and the probe
    exercises the right executable under the wrong runtime.

    Deliberately carries NO provider credential. opencode layers its own on top
    of this; claude-cli authenticates out of band, and handing it another
    provider's API key would be both wrong and a credential leak into a child
    that has no use for it.

    env_keys is the caller's allowlist, and it defaults to the NARROWER of the
    two: a new probe that forgets to name one gets the common set, never a set
    widened by whichever provider happened to need more.
    """
    source_env = base_env if base_env is not None else os.environ
    child_env = {
        key: value
        for key in env_keys
        if (value := source_env.get(key)) is not None
    }
    if provider_path:
        child_env["PATH"] = provider_path
    if name:
        child_env["WHATSOUP_INSTANCE"] = name
    if child_cwd:
        child_env["WHATSOUP_MCP_SOCKET"] = str(Path(child_cwd) / ".claude" / "whatsoup.sock")
    return child_env


def opencode_functional_probe_env(
    data: dict[str, Any],
    target: str,
    timeout_seconds: int,
    provider_path: str | None = None,
    name: str | None = None,
    child_cwd: str | None = None,
    base_env: dict[str, str] | None = None,
) -> dict[str, str]:
    child_env = governed_child_environment(
        provider_path,
        name,
        child_cwd,
        base_env,
        env_keys=OPENCODE_FUNCTIONAL_ENV_KEYS,
    )
    model = provider_model_from_config(data, target)
    service = opencode_key_service_from_config(data, target)
    env_key = service_env_var(service) if service else None
    credential = provider_credential_value(service, timeout_seconds, base_env) if service else None
    if env_key and credential:
        child_env[env_key] = credential
    return child_env


def opencode_provider_probe_inventory(
    profile: dict[str, Any],
    item: dict[str, Any],
    name: str,
    data: dict[str, Any],
    provider: str,
    target: str = "primary",
) -> list[str]:
    # ONE plist read per probe run; every governed key is derived from this map.
    plist_state, plist_environment = instance_plist_governed_environment(name)
    if plist_state == GOVERNED_PLIST_READABLE:
        generated_provider_path = environment_provider_path(plist_environment)
        if generated_provider_path is None:
            return [generated_provider_path_absence_failure(name, provider, target)]
    elif plist_state == GOVERNED_PLIST_NOT_APPLICABLE:
        # Preserve legacy resolution when governed checking is intentionally
        # not applicable; some stubbed Darwin fixtures may still read a plist.
        generated_provider_path = instance_provider_path(name)
    else:
        # UNREADABLE. This used to fall through with generated_provider_path
        # None, which reached instance_provider_path_match, compared None
        # against the loaded PATH and reported provider_runtime_path_mismatch --
        # a PATH remediation for a plist fault, and a different answer than the
        # default provider gave for the identical state. Refuse here, in the
        # same terms, before anything downstream can rename the cause.
        return [plist_unreadable_failure(name, provider, target)]
    loaded_environment = loaded_instance_environment(name)
    loaded_provider_path = loaded_environment.get("PATH")
    effective_provider_path = effective_instance_provider_path(loaded_environment)
    requested_command = opencode_provider_probe_command(profile, item)
    runtime_command = executable_candidate("opencode", effective_provider_path)
    command = runtime_command or "opencode"
    timeout_seconds = int_or_none(item.get("providerProbeTimeoutSeconds"))
    if timeout_seconds is None:
        timeout_seconds = int_or_none(profile.get("providerProbeTimeoutSeconds")) or 15
    timeout_seconds = max(1, min(timeout_seconds, 60))
    safe_command = redact_evidence_string(command, 120)
    configured_mode = opencode_command_mode_from_config(data, target)
    child_cwd = agent_workspace_cwd(data, name)
    child_env = opencode_functional_probe_env(
        data,
        target,
        timeout_seconds,
        effective_provider_path,
        name,
        child_cwd,
        loaded_environment,
    )

    if HOST_PLATFORM == "darwin" and not instance_provider_path_match(
        generated_provider_path,
        loaded_provider_path,
    ):
        return [(
            f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
            "failure_class=provider_runtime_path_mismatch "
            f"remediation={REGENERATE_LAUNCHAGENT_REMEDIATION}"
        )]

    prepend_failure = governed_prepend_failure_class(plist_environment, loaded_environment)
    if prepend_failure:
        return [(
            f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
            f"failure_class={prepend_failure} "
            f"remediation={REGENERATE_LAUNCHAGENT_REMEDIATION}"
        )]
    if effective_provider_path is None:
        return [(
            f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
            "failure_class=provider_runtime_path_unavailable "
            "remediation=repair_the_shared_runtime_path_helper_and_node_pin"
        )]
    if requested_command != "opencode":
        requested_path = str(Path(requested_command).expanduser())
        if runtime_command is None or os.path.realpath(requested_path) != os.path.realpath(runtime_command):
            return [(
                f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
                "failure_class=provider_runtime_command_mismatch "
                "remediation=remove_the_probe_override_and_use_the_instance_path_binary"
            )]

    context_problem = opencode_runtime_context_problem(data)
    if context_problem and opencode_functional_probe_enabled(profile, item):
        return [(
            f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
            "failure_class=provider_runtime_context_unavailable "
            f"reason={context_problem} "
            "remediation=run_a_context_bound_provider_canary_for_this_instance"
        )]

    # The three capability probes below ask the binary what it is and what it
    # supports. None of them starts a session, so none needs the instance
    # workspace or its tool socket, and both were reaching them only because
    # they shared the functional probe's child env and cwd. They run from a
    # fresh directory the probe owns, on the same governed PATH allowlist with
    # no socket synthesized. The FUNCTIONAL probe below is unchanged: it does
    # drive a real session against the instance's own context.
    # The same environment the functional probe gets, minus the socket: passing
    # no child_cwd is what suppresses the synthesized WHATSOUP_MCP_SOCKET. The
    # configured provider credential is deliberately RETAINED here. Whether a
    # capability probe needs one is a real question, but it is a different
    # question from where these three run, and narrowing it belongs to its own
    # change with its own evidence.
    diagnostic_env = opencode_functional_probe_env(
        data,
        target,
        timeout_seconds,
        effective_provider_path,
        name,
        None,
        loaded_environment,
    )
    try:
        with tempfile.TemporaryDirectory(prefix="whatsoup-opencode-diagnostic-") as diagnostic_cwd:
            configured_workspace = configured_agent_workspace_cwd(data)
            if configured_workspace is not None and not probe_directory_is_outside_workspace(
                diagnostic_cwd, configured_workspace
            ):
                return [(
                    f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
                    "failure_class=provider_probe_directory_unsafe "
                    "remediation=set_TMPDIR_outside_the_instance_workspace"
                )]
            version_stdout, version_stderr, version_rc, _ = provider_command_output(
                [command, "--version"],
                timeout_seconds,
                "BOT_ERRORS_DRY_OPENCODE_VERSION_STDOUT",
                "BOT_ERRORS_DRY_OPENCODE_VERSION_STDERR",
                "BOT_ERRORS_DRY_OPENCODE_VERSION_RC",
                child_env=diagnostic_env,
                child_cwd=diagnostic_cwd,
            )
            help_stdout, help_stderr, help_rc, _ = provider_command_output(
                [command, "--help"],
                timeout_seconds,
                "BOT_ERRORS_DRY_OPENCODE_HELP_STDOUT",
                "BOT_ERRORS_DRY_OPENCODE_HELP_STDERR",
                "BOT_ERRORS_DRY_OPENCODE_HELP_RC",
                child_env=diagnostic_env,
                child_cwd=diagnostic_cwd,
            )
            run_help_stdout, run_help_stderr, run_help_rc, _ = provider_command_output(
                [command, "run", "--help"],
                timeout_seconds,
                "BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDOUT",
                "BOT_ERRORS_DRY_OPENCODE_RUN_HELP_STDERR",
                "BOT_ERRORS_DRY_OPENCODE_RUN_HELP_RC",
                child_env=diagnostic_env,
                child_cwd=diagnostic_cwd,
            )
    except OSError as exc:
        # Same discrimination as the default provider's arm. An OS-level failure
        # here means either the binary itself is gone or unrunnable -- which the
        # compatibility class and its upgrade remediation describe correctly --
        # or something the probe brought with it failed, such as the temporary
        # directory this range added. Reporting the second as
        # provider_compatibility_unsupported tells an operator to upgrade
        # opencode when opencode is fine, so the two are separated by whether
        # the failing file IS the command.
        #
        # OSError, not FileNotFoundError. ENOENT was only the errno that had
        # been noticed: a PermissionError or an ENOSPC out of the same tempdir
        # path fell through to the catch-all below, which answers the
        # compatibility class unconditionally. Measured -- an unwritable temp
        # root reported "[Errno 13] Permission denied ... failure_class=
        # provider_compatibility_unsupported remediation=
        # install_or_upgrade_opencode_modern_run_cli". The claude-cli arm's own
        # catch-all already answers provider_probe_failed for exactly this, so
        # this closes an asymmetry between two arms of one function rather than
        # setting new policy. An OSError carrying no filename cannot be the
        # command either, and lands on the environment class, which is the
        # safer of the two to be wrong about: it asks the operator to look at
        # the probe host instead of at a provider that may be fine.
        if exc.filename == command:
            return [(
                f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
                f"failure_class=provider_compatibility_unsupported error={redact_evidence_string(str(exc), 180)} "
                "remediation=install_or_upgrade_opencode_modern_run_cli"
            )]
        return [(
            f"FAIL provider_probe {name}: provider={provider} command={safe_command} "
            f"failure_class=provider_probe_failed error={redact_evidence_string(str(exc), 180)} "
            "remediation=repair_the_probe_environment_and_retry"
        )]
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

    credential_present, credential_fragments = opencode_provider_credential_fragments(
        data,
        target,
        timeout_seconds,
        loaded_environment,
    )
    if credential_present is False:
        return [(
            f"FAIL {base} failure_class=provider_credential_missing "
            + " ".join(credential_fragments)
            + " remediation=store_provider_key_in_service_visible_env_or_keyring"
        )]

    credential_suffix = " " + " ".join(credential_fragments) if credential_fragments else ""
    if not opencode_functional_probe_enabled(profile, item):
        return [f"{base} status=ok model_override=true session_resume=true functional_status=skipped{credential_suffix}"]

    if env_flag("BOT_ERRORS_DRY_OPENCODE_FUNCTIONAL_TIMEOUT", False):
        return [(
            f"FAIL {base} failure_class=provider_timeout functional_status=failed "
            f"functional_timeout_seconds={timeout_seconds}{credential_suffix}"
        )]

    try:
        functional_stdout, functional_stderr, functional_rc, functional_timed_out = provider_command_output(
            opencode_functional_probe_args(command, data, target),
            timeout_seconds,
            "BOT_ERRORS_DRY_OPENCODE_FUNCTIONAL_STDOUT",
            "BOT_ERRORS_DRY_OPENCODE_FUNCTIONAL_STDERR",
            "BOT_ERRORS_DRY_OPENCODE_FUNCTIONAL_RC",
            "Reply with exactly OK.\n",
            child_env,
            child_cwd,
        )
    except subprocess.TimeoutExpired:
        return [(
            f"FAIL {base} failure_class=provider_timeout functional_status=failed "
            f"functional_timeout_seconds={timeout_seconds}{credential_suffix}"
        )]
    except Exception as exc:  # noqa: BLE001 - daily health must report functional probe failures.
        return [(
            f"FAIL {base} failure_class=provider_probe_failed functional_status=failed "
            f"error={redact_evidence_string(str(exc), 180)}{credential_suffix}"
        )]

    combined = "\n".join(part for part in [functional_stdout, functional_stderr] if part)
    functional_failure = classify_provider_probe_failure(combined, functional_rc, functional_timed_out)
    if functional_failure:
        return [(
            f"FAIL {base} failure_class={functional_failure} functional_status=failed "
            f"functional_rc={functional_rc}{credential_suffix}"
        )]

    valid_jsonl, stream_status = validate_opencode_functional_jsonl(functional_stdout)
    if not valid_jsonl:
        return [(
            f"FAIL {base} failure_class={stream_status} functional_status=failed "
            f"functional_rc={functional_rc}{credential_suffix}"
        )]

    return [(
        f"{base} status=ok model_override=true session_resume=true "
        f"functional_status=ok functional_rc={functional_rc}{credential_suffix}"
    )]


def provider_command_output(
    command: list[str],
    timeout_seconds: int,
    dry_stdout_env: str,
    dry_stderr_env: str,
    dry_rc_env: str,
    input_text: str | None = None,
    child_env: dict[str, str] | None = None,
    child_cwd: str | None = None,
) -> tuple[str, str, int, bool]:
    dry_stdout = os.environ.get(dry_stdout_env)
    dry_stderr = os.environ.get(dry_stderr_env, "")
    dry_rc = os.environ.get(dry_rc_env)
    if dry_stdout is not None or dry_rc is not None:
        return dry_stdout or "", dry_stderr, int(dry_rc or "0"), False
    proc = subprocess.run(
        command,
        capture_output=True,
        input=input_text,
        text=True,
        timeout=timeout_seconds,
        check=False,
        env=child_env,
        cwd=child_cwd,
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
    active = max(0, evidence_int(health_probe_line, "runtime_agent_active_sessions") or 0)
    session_lifetime_age = evidence_int(
        health_probe_line, "runtime_agent_last_session_lifetime_age_seconds"
    )
    status = evidence_field(health_probe_line, "runtime_agent_last_session_status")
    observation_age = evidence_int(health_probe_line, "generated_at_age_seconds")
    requested_provider = runtime_provider_name(provider)
    runtime_effective_provider = evidence_field(
        health_probe_line, "runtime_agent_effective_provider"
    )
    instance_effective_provider = evidence_field(
        health_probe_line, "instance_effective_provider"
    )
    effective_provider_value = (
        runtime_effective_provider
        if runtime_effective_provider is not None
        else instance_effective_provider
    )
    effective_provider = runtime_provider_name(effective_provider_value)
    effective_evidence_valid = (
        effective_provider_value is None or effective_provider is not None
    )
    primary_provider_value = next(
        (
            candidate
            for candidate in [
                evidence_field(health_probe_line, "runtime_agent_primary_provider"),
                evidence_field(health_probe_line, "runtime_agent_agent_provider"),
                evidence_field(health_probe_line, "instance_provider"),
            ]
            if candidate is not None
        ),
        None,
    )
    primary_provider = runtime_provider_name(primary_provider_value)
    current_provider = (
        effective_provider if effective_provider_value is not None else primary_provider
    )
    provider_match = (
        requested_provider is not None
        and effective_evidence_valid
        and current_provider == requested_provider
    )
    progress_age = evidence_int(
        health_probe_line, "runtime_agent_last_successful_turn_age_seconds"
    )
    progress_provider = runtime_provider_name(
        evidence_field(health_probe_line, "runtime_agent_last_successful_turn_provider")
    )
    progress_session_current_value = evidence_field(
        health_probe_line, "runtime_agent_last_successful_turn_session_current"
    )
    progress_session_current: bool | None = (
        True if progress_session_current_value == "true"
        else False if progress_session_current_value == "false"
        else None
    )

    fragments.append("live_provider_source=health")
    if active > 0:
        fragments.append(f"health_provider_active_sessions={active}")
    if current_provider is not None:
        fragments.append(f"health_provider_current={current_provider}")
    fragments.append(
        "health_provider_effective_evidence_valid="
        f"{str(effective_evidence_valid).lower()}"
    )
    fragments.append(f"health_provider_match={str(provider_match).lower()}")
    observation_fresh = False
    if observation_age is not None:
        fragments.append(f"health_provider_observation_age_seconds={observation_age}")
        max_age = env_int("BOT_ERRORS_HEALTH_BODY_MAX_AGE_SECONDS", 30)
        max_future_skew = env_int("BOT_ERRORS_HEALTH_BODY_MAX_FUTURE_SKEW_SECONDS", 5)
        observation_fresh = -max_future_skew <= observation_age <= max_age
    fragments.append(f"health_provider_observation_fresh={str(observation_fresh).lower()}")
    if session_lifetime_age is not None:
        fragments.append(
            "health_provider_session_lifetime_age_seconds="
            f"{session_lifetime_age}"
        )
    progress_fresh = False
    progress_provider_match = (
        requested_provider is not None and progress_provider == requested_provider
    )
    if progress_age is not None:
        fragments.append(f"health_provider_progress_age_seconds={progress_age}")
        max_future_skew = env_int("BOT_ERRORS_HEALTH_BODY_MAX_FUTURE_SKEW_SECONDS", 5)
        progress_fresh = -max_future_skew <= progress_age <= freshness_seconds
    if progress_provider is not None:
        fragments.append(f"health_provider_progress_provider={progress_provider}")
    fragments.append(
        f"health_provider_progress_provider_match={str(progress_provider_match).lower()}"
    )
    fragments.append(f"health_provider_progress_fresh={str(progress_fresh).lower()}")
    fragments.append(
        "health_provider_progress_session_current="
        f"{str(progress_session_current).lower() if progress_session_current is not None else 'unknown'}"
    )
    if status:
        fragments.append(f"health_provider_last_session_status={redact_evidence_string(status, 40)}")
    fresh = (
        observation_fresh
        and provider_match
        and active > 0
        and status == "active"
        and progress_provider_match
        and progress_fresh
        and progress_session_current is True
    )
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
    fresh_live_sessions = 0
    latest_progress_epoch: int | None = None
    latest_started_epoch: int | None = None
    progress_precedes_start = False
    legacy_home_bug = False
    now_epoch = current_epoch()
    max_future_skew = env_int("BOT_ERRORS_HEALTH_BODY_MAX_FUTURE_SKEW_SECONDS", 5)
    for row in matched_rows:
        transcript_path = row["transcript_path"]
        if isinstance(transcript_path, str) and "/.claude/projects/-home-" in transcript_path:
            legacy_home_bug = True
        pid = read_int(row["claude_pid"])
        row_alive = pid is not None and provider_process_alive(pid)
        if row_alive:
            alive += 1
            command_match, _ = provider_process_command_matches(pid, provider, timeout_seconds)
            if command_match:
                command_matches += 1
        started_epoch = parse_iso_epoch(row["started_at"])
        if started_epoch is not None and (
            latest_started_epoch is None or started_epoch > latest_started_epoch
        ):
            latest_started_epoch = started_epoch
        progress_epoch = parse_iso_epoch(row["last_message_at"])
        if progress_epoch is not None and (
            started_epoch is None or progress_epoch >= started_epoch
        ):
            if latest_progress_epoch is None or progress_epoch > latest_progress_epoch:
                latest_progress_epoch = progress_epoch
            progress_age = now_epoch - progress_epoch
            row_progress_fresh = -max_future_skew <= progress_age <= freshness_seconds
            if row_alive and row_progress_fresh:
                fresh_live_sessions += 1
        elif progress_epoch is not None:
            progress_precedes_start = True
    fragments.append(f"live_provider_alive_pids={alive}")
    fragments.append(f"live_provider_pid_command_matches={command_matches}")
    write_activity_recent = False
    if latest_progress_epoch is not None:
        progress_age = now_epoch - latest_progress_epoch
        fragments.append(f"live_provider_latest_age_seconds={progress_age}")
        write_activity_recent = fresh_live_sessions > 0
    if latest_started_epoch is not None:
        started_age = now_epoch - latest_started_epoch
        fragments.append(f"live_provider_latest_started_age_seconds={started_age}")
    if progress_precedes_start:
        fragments.append("live_provider_progress_precedes_session_start=true")
    fragments.append(f"live_provider_transcript_path_legacy_home_bug={str(legacy_home_bug).lower()}")
    fragments.append(f"live_provider_write_activity_recent={str(write_activity_recent).lower()}")
    fragments.append("live_provider_progress_authoritative=false")
    # last_message_at is set after stdin accepts bytes, before a provider
    # terminal result. It is liveness diagnostics, never successful-provider
    # evidence that may contradict an authentication failure.
    fresh = False
    fragments.append("live_provider_fresh=false")
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
        for fallback in fallback_probe_targets(data):
            fallback_provider = fallback["provider"]
            if fallback_provider == explicit_provider and fallback.get("model") is None:
                continue
            lines.extend(provider_probe_target_inventory(
                profile,
                item,
                name,
                data,
                fallback_provider,
                fallback["target"],
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
    for fallback in fallback_probe_targets(data):
        fallback_provider = fallback["provider"]
        if fallback_provider == primary_provider and fallback.get("model") is None:
            continue
        lines.extend(provider_probe_target_inventory(
            profile,
            item,
            name,
            data,
            fallback_provider,
            fallback["target"],
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

    # claude-cli is the DEFAULT agentOptions.provider, so it gets the governed
    # plist-state check, both prepend checks, and the effective-PATH derivation
    # the opencode probe gets. It does NOT get the generated-vs-loaded PATH
    # EQUALITY gate: instance_provider_path_match has one call site, in the
    # opencode inventory. Here a governed PATH that cannot supply the binary is
    # reported as provider_runtime_path_unavailable with a reason, not as its own
    # mismatch class. Reading the plist once here keeps both governed keys on one
    # file state.
    plist_state, plist_environment = instance_plist_governed_environment(name)
    if (
        plist_state == GOVERNED_PLIST_READABLE
        and environment_provider_path(plist_environment) is None
    ):
        return [generated_provider_path_absence_failure(name, provider, target)]
    loaded_environment = loaded_instance_environment(name)

    # The runtime-path gate is a statement about the SERVICE's PATH, not about
    # which binary the probe happens to run, so it is evaluated BEFORE and
    # independently of any operator override. It used to live inside
    # `if not command:`, which let a configured providerProbeCommand silently
    # disable it while the docs promised it unconditionally.
    effective_provider_path = effective_instance_provider_path(loaded_environment)
    # executable_candidate is only ever given a real path here: called with None
    # it widens to BOT_ERRORS_PROVIDER_BIN_DIRS and an npm-global guess, which
    # is the opencode discovery contract, not this one.
    runtime_command = (
        executable_candidate("claude", effective_provider_path)
        if effective_provider_path
        else None
    )
    runtime_path_unavailable = False
    unavailable_reason = "unknown"
    if plist_state == GOVERNED_PLIST_READABLE:
        # A readable plist and a governed PATH that cannot supply the binary.
        # TWO distinct causes: the environment yielded no effective PATH at all
        # (job unloaded, launchctl print failed), or it composed and simply
        # holds no claude. The second used to fall through to shutil.which and
        # report status=ok naming a binary outside the prepend, ~/.local/bin,
        # the pinned node dir and the plist PATH, one the service cannot run.
        if effective_provider_path is None or runtime_command is None:
            runtime_path_unavailable = True
            unavailable_reason = (
                "effective_path_uncomposable"
                if effective_provider_path is None
                else "no_claude_on_governed_path"
            )

    # An operator-configured probe command still chooses WHICH binary is
    # probed; it does not exempt the service's PATH from the gate above.
    configured_command = (
        profile_string(item, "providerProbeCommand")
        or profile_string(profile, "providerProbeCommand")
    )
    command = configured_command or runtime_command or shutil.which("claude") or "claude"

    prepend_failure = governed_prepend_failure_class(plist_environment, loaded_environment)
    if plist_state == GOVERNED_PLIST_UNREADABLE:
        # Treating an unreadable plist as "no drift" reported the default
        # provider healthy while opencode failed closed on the identical state.
        # Both now fail closed through one shared refusal, so the operator is
        # told the plist is the problem rather than the PATH, and is told it in
        # the same words whichever provider the instance runs.
        return [plist_unreadable_failure(name, provider, target)]
    if prepend_failure or runtime_path_unavailable:
        # These two lines deliberately carry NO command and no PATH element.
        # The command here is either irrelevant to the failure (the prepend
        # cases) or, worse, a binary resolved from the PROBE's own PATH that the
        # service cannot execute -- so printing it publishes the probe host's
        # filesystem layout while adding nothing an operator can act on. The
        # actionable facts are the class, which cause fired, and how many
        # entries the governed PATH offered. Matches the module's redaction
        # stance for paths (see credential_path_ref / path_fingerprint).
        if prepend_failure:
            return [(
                f"FAIL provider_probe {name}: provider={provider} target={target} "
                f"failure_class={prepend_failure} "
                f"remediation={REGENERATE_LAUNCHAGENT_REMEDIATION}"
            )]
        governed_entry_count = len(
            [entry for entry in (effective_provider_path or "").split(":") if entry]
        )
        return [(
            f"FAIL provider_probe {name}: provider={provider} target={target} "
            "failure_class=provider_runtime_path_unavailable "
            f"reason={unavailable_reason} governed_path_entries={governed_entry_count} "
            "remediation=repair_the_shared_runtime_path_helper_and_node_pin"
        )]
    timeout_seconds = int_or_none(item.get("providerProbeTimeoutSeconds"))
    if timeout_seconds is None:
        timeout_seconds = int_or_none(profile.get("providerProbeTimeoutSeconds")) or 15
    timeout_seconds = max(1, min(timeout_seconds, 60))

    # Run the provider in the environment it was SELECTED from. Passing none
    # meant the binary came from the governed PATH but executed under the probe
    # process's PATH and HOME, so an interpreter-resolving wrapper could pick a
    # different runtime than the service uses.
    #
    # The WORKSPACE is a different question, and the answer is no. This probe is
    # an unattended one-shot diagnostic; the instance workspace carries the
    # agent's own project-local .claude surface, written with bypassPermissions
    # and tool allowances (src/core/settings-template.ts), and a child started
    # there adopts them. Nothing the probe checks needs that directory: the
    # binary is already resolved to an absolute path out of the governed PATH
    # above, and PATH parity travels in child_env, not in the working directory.
    # So the probe runs from a fresh directory it owns and throws away.
    #
    # The synthesized WHATSOUP_MCP_SOCKET goes with it. Handing a diagnostic the
    # instance's tool socket widens it by the same route the workspace cwd did,
    # and no check here reads the socket.
    child_env = governed_child_environment(
        effective_provider_path,
        name,
        None,
        loaded_environment,
        env_keys=CLAUDE_FUNCTIONAL_ENV_KEYS,
    )

    # The probe no longer runs from the instance workspace, so a RELATIVE command
    # would resolve against a different directory than it used to. Resolve it
    # against the GOVERNED PATH only, so argv[0] names the binary the service
    # would run wherever the probe stands.
    #
    # There is deliberately NO ambient fallback. Resolving a bare command from
    # the health check's own PATH produces an absolute argv[0], and an absolute
    # argv[0] executes regardless of the child environment's PATH -- so a
    # configured bare probe command that is absent from the governed PATH would
    # run an ungoverned binary and report ITS health as the service's. An
    # unresolvable name stays bare and reaches the spawn bare, which fails
    # closed, exactly as it did before this resolution step existed.
    # glm-2. `resolved_on_governed_path` is PROVENANCE, not a gate, and
    # os.path.isabs was standing in for "came from the governed PATH". Both ways
    # argv[0] becomes absolute here can be ungoverned when no governed PATH
    # composed: the selection above falls back to shutil.which("claude"), which
    # searches THIS process's PATH, and shutil.which(command, path=None) below
    # silently does the same for a configured bare command -- path=None does not
    # mean "no path", it means "the caller's PATH". Neither is a statement about
    # the SERVICE's PATH, yet both used to record one, so a probe reported an
    # ungoverned binary's health as the service's under a governed label.
    #
    # When no effective PATH composed, nothing resolved here is governed,
    # whatever shape argv[0] has. The legacy chain still RUNS -- on a host with
    # no LaunchAgent surface that chain is the contract, and a host that has one
    # has already refused above with provider_runtime_path_unavailable. What
    # changes is only that the probe stops claiming governance it does not have,
    # and says so on the line.
    if effective_provider_path is None:
        resolved_on_governed_path = False
    else:
        resolved_on_governed_path = os.path.isabs(command)
        if not resolved_on_governed_path:
            candidate = shutil.which(command, path=effective_provider_path)
            if candidate:
                command = candidate
                resolved_on_governed_path = True

    # glm-2. Provenance of argv[0], stated rather than left to be inferred from
    # a field's absence. Added only in the ungoverned case, so a governed run's
    # line is byte-identical and no existing reader has to learn a new field.
    #
    # Defined HERE, before the try, rather than beside the post-spawn report:
    # the exception arms below return without reaching that section, and a
    # timeout or an ENOENT against a binary chosen by the WRONG PATH is exactly
    # when an operator most needs to know which PATH chose it.
    resolution_note = (
        "" if resolved_on_governed_path else " command_resolution=ambient_not_governed"
    )
    timed_out = False
    try:
        with tempfile.TemporaryDirectory(prefix="whatsoup-provider-probe-") as probe_cwd:
            configured_workspace = configured_agent_workspace_cwd(data)
            if configured_workspace is not None and not probe_directory_is_outside_workspace(
                probe_cwd, configured_workspace
            ):
                return [(
                    f"FAIL provider_probe {name}: provider={provider} target={target} "
                    "failure_class=provider_probe_directory_unsafe "
                    "remediation=set_TMPDIR_outside_the_instance_workspace"
                )]
            stdout, stderr, rc, timed_out = provider_command_output(
                [command, "--print", "Return exactly OK."],
                timeout_seconds,
                "BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT",
                "BOT_ERRORS_DRY_PROVIDER_PROBE_STDERR",
                "BOT_ERRORS_DRY_PROVIDER_PROBE_RC",
                child_env=child_env,
                child_cwd=probe_cwd,
            )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        rc = 124
        timed_out = True
    except FileNotFoundError as exc:
        # ENOENT reaches here from THREE places, and only one of them is a
        # statement about the governed PATH:
        #   the command never resolved, so argv[0] arrived bare -- that one;
        #   the temporary directory could not be created, e.g. TMPDIR absent;
        #   the command resolved and ran but its shebang interpreter is missing.
        #
        # exc.filename alone cannot separate them: a missing interpreter reports
        # the SCRIPT's path, which is argv[0], exactly as an unresolvable command
        # reports its own name. Measured, not assumed. The discriminator that
        # does work is whether resolution against the governed PATH succeeded, so
        # that is recorded at the resolution step and consulted here; the
        # filename check keeps a failed temporary directory out of the branch.
        if not resolved_on_governed_path and exc.filename == command:
            # The line carries no command on purpose: a name the governed PATH
            # cannot supply tells an operator nothing and publishes the probe
            # host's layout, which is this module's redaction stance for the
            # whole provider_runtime_path_* family.
            governed_entry_count = len(
                [entry for entry in (effective_provider_path or "").split(":") if entry]
            )
            return [(
                f"FAIL provider_probe {name}: provider={provider} target={target} "
                "failure_class=provider_runtime_path_unavailable "
                f"reason=command_not_on_governed_path governed_path_entries={governed_entry_count} "
                "remediation=repair_the_shared_runtime_path_helper_and_node_pin"
            )]
        safe_command = redact_evidence_string(command, 120)
        return [f"FAIL provider_probe {name}: provider={provider} target={target} command={safe_command} failure_class=provider_probe_failed error={redact_evidence_string(str(exc), 180)}{resolution_note}"]
    except Exception as exc:  # noqa: BLE001 - daily health should report provider probe failure.
        safe_command = redact_evidence_string(command, 120)
        return [f"FAIL provider_probe {name}: provider={provider} target={target} command={safe_command} failure_class=provider_probe_failed error={redact_evidence_string(str(exc), 180)}{resolution_note}"]

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
        return [line + resolution_note]
    line = f"provider_probe {name}: provider={provider} target={target} command={safe_command} status=ok rc={rc}"
    if output_excerpt:
        line += f" output={output_excerpt}"
    return [line + resolution_note]


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
    target = _durable_target(path)
    observation = observe_json(target)
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
    publication_operation = operation_id(
        target,
        state,
        component="health_check.primary_phone_verification",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        state,
        component="health_check.primary_phone_verification",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)
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
            profile_port = item.get("healthPort")
            if isinstance(profile_port, bool) or not isinstance(profile_port, int):
                profile_port = None
            live_port = data.get("healthPort")
            if isinstance(live_port, bool) or not isinstance(live_port, int):
                live_port = None
            drift_marker = health_port_authority_drift_marker(profile_port, live_port)
            if drift_marker is not None:
                # #2342: classify authority drift, inhibit the misaddressed
                # outage probe. Do not probe the stale profile port and do not
                # silently switch — the winning authority (runtime_config) is
                # recorded in the marker line.
                lines.append(f"FAIL config {name}: {drift_marker}")
                probe_port = None
            elif profile_port is not None:
                probe_port = profile_port
                if live_port is None:
                    lines.append(f"config {name}: health_port authority=profile")
            else:
                probe_port = live_port
            display_port = live_port if drift_marker is not None else probe_port
            socket_path = item.get("socketPath", data.get("socketPath"))
            service = item.get("service")
            lines.append(
                f"config {name}: expected={expectation} type={kind} enabled={enabled} "
                f"mode={mode:o} healthPort={display_port}"
            )
            if service:
                service_name = str(service)
                lines.append(f"service {name}: {service_is_active(service_name)} ({service_name})")
                lines.append(f"service_enabled {name}: {service_enabled(service_name)}")
            health_probe_line: str | None = None
            if isinstance(probe_port, int):
                probe = probe_health(probe_port, name)
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


TOOL_PROBE_FAILURE_OUTCOMES = (
    "probe_config_missing",
    "transport_unreachable",
    "rpc_error",
    "protocol_mismatch",
    "inventory_malformed",
    "probe_error",
)


class _MalformedInventory(ValueError):
    """A tools/list response arrived but its payload shape is untrustworthy (#2408)."""


class _ProtocolMismatch(RuntimeError):
    """The initialize handshake contradicts the expected runtime contract (#2408)."""


EXPECTED_TOOL_PROTOCOL_VERSION = "2024-11-05"


def _bounded_tool_contract(handshake: dict[str, Any]) -> dict[str, Any]:
    """Reduce an initialize response to three bounded identity fields (#2408)."""

    def _token(value: Any) -> str | None:
        return value[:64] if isinstance(value, str) else None

    server_info = handshake.get("serverInfo")
    server = server_info if isinstance(server_info, dict) else {}
    return {
        "protocolVersion": _token(handshake.get("protocolVersion")),
        "serverName": _token(server.get("name")),
        "serverVersion": _token(server.get("version")),
    }


def _validate_tool_contract(contract: dict[str, Any], profile_contract: dict[str, Any] | None) -> None:
    """Fail closed when the verified handshake contradicts expectations (#2408).

    A drifted protocol version always mismatches. A profile-bound contract
    additionally requires the handshake identity it names; unknown identity
    under a profile contract fails closed instead of borrowing the default
    expectation set as observed truth.
    """
    observed_protocol = contract.get("protocolVersion")
    if observed_protocol is not None and observed_protocol != EXPECTED_TOOL_PROTOCOL_VERSION:
        raise _ProtocolMismatch("initialize protocolVersion drifted from the expected contract")
    if profile_contract:
        expected_name = profile_contract.get("serverName")
        expected_protocol = profile_contract.get("protocolVersion") or EXPECTED_TOOL_PROTOCOL_VERSION
        if contract.get("serverName") != expected_name or observed_protocol != expected_protocol:
            raise _ProtocolMismatch("initialize identity does not match the profile-bound tool contract")


def _classify_tool_probe_error(exc: BaseException) -> str:
    """Map a tools/list probe exception to a bounded outcome token (#2408).

    Raw exception text must never reach probe evidence: transport errors can
    embed socket paths and RPC errors can embed server internals.
    """
    if isinstance(exc, _ProtocolMismatch):
        return "protocol_mismatch"
    if isinstance(exc, (_MalformedInventory, json.JSONDecodeError)):
        return "inventory_malformed"
    message = str(exc)
    if message.startswith("rpc error:"):
        return "rpc_error"
    if isinstance(exc, (TimeoutError, ConnectionError, OSError)):
        return "transport_unreachable"
    if "socket missing" in message or "socket closed" in message or "timeout waiting" in message:
        return "transport_unreachable"
    return "probe_error"


def _tool_probe(
    outcome: str,
    *,
    missing: list[str] | None = None,
    observed_count: int | None = None,
    attempts: str | None = None,
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "outcome": outcome,
        "missing": list(missing or []),
        "observedCount": observed_count,
        "attempts": attempts,
        "contract": contract,
    }


REQUIRED_TOOLS_ALERT_SOURCE = "required_tools"


def tool_inventory_state_path() -> Path:
    return state_root() / TOOL_INVENTORY_STATE


def load_tool_inventory_state() -> dict[str, Any]:
    path = tool_inventory_state_path()
    fresh: dict[str, Any] = {"schemaVersion": 1, "lastTrustworthy": None, "openCondition": None}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fresh
    except Exception as exc:  # noqa: BLE001 - a corrupt record must not block the probe lifecycle.
        return {**fresh, "loadError": str(exc)[:240]}
    if not isinstance(loaded, dict):
        return {**fresh, "loadError": "tool inventory state root was not an object"}
    loaded["schemaVersion"] = 1
    if not isinstance(loaded.get("lastTrustworthy"), dict):
        loaded["lastTrustworthy"] = None
    if not isinstance(loaded.get("openCondition"), dict):
        loaded["openCondition"] = None
    return loaded


def save_tool_inventory_state(state: dict[str, Any]) -> None:
    root = state_root()
    ensure_private_dir(root)
    target = _durable_target(tool_inventory_state_path())
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        state,
        component="health_check.tool_inventory_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        state,
        component="health_check.tool_inventory_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)


def _tool_inventory_trustworthy_record(probe: dict[str, Any], now_epoch: int) -> dict[str, Any]:
    contract = probe.get("contract")
    return {
        "observedAtEpoch": now_epoch,
        "observedCount": int_or_none(probe.get("observedCount")),
        "missing": [name for name in (probe.get("missing") or []) if isinstance(name, str)],
        "contract": contract if isinstance(contract, dict) else None,
    }


def _last_trustworthy_inventory_line(state: dict[str, Any], now_epoch: int) -> str:
    record = state.get("lastTrustworthy")
    if not isinstance(record, dict):
        return "tools personal last-trustworthy: none"
    age = max(0, now_epoch - (int_or_none(record.get("observedAtEpoch")) or 0))
    observed = int_or_none(record.get("observedCount"))
    missing = ",".join(name for name in (record.get("missing") or []) if isinstance(name, str)) or "none"
    return (
        "tools personal last-trustworthy: "
        f"age={age}s observed={observed if observed is not None else 'unknown'} missing={missing}"
    )


def required_tools_lifecycle(
    state: dict[str, Any],
    probe: dict[str, Any],
    now_epoch: int,
) -> tuple[bool, list[tuple[str, str, str, str]], list[str]]:
    """Advance the required-tools predicate lifecycle from one probe result (#2408).

    Returns (dirty, companion_events, extra_evidence_lines). Companion events
    carry the predicate's own alert/clear so its incident lifecycle stays
    independent of aggregate daily-health siblings; the durable openCondition
    marker makes the clear exactly-once across runs and restarts, and
    lastTrustworthy is rewritten only by a successful well-formed inventory
    observation — never by a failed probe.
    """
    outcome = str(probe.get("outcome") or "")
    events: list[tuple[str, str, str, str]] = []
    extra: list[str] = []
    dirty = False
    if outcome == "skipped":
        return dirty, events, extra
    open_condition = state.get("openCondition") if isinstance(state.get("openCondition"), dict) else None

    if outcome == "inventory_missing" or outcome in TOOL_PROBE_FAILURE_OUTCOMES:
        if outcome == "inventory_missing":
            missing = [name for name in (probe.get("missing") or []) if isinstance(name, str)]
            joined = ",".join(missing)
            kind = "inventory_missing"
            fail_line = f"FAIL required_tools: required_missing={joined}"
            summary = f"BOT ERRORS required tools missing: {joined}"
            trustworthy = _tool_inventory_trustworthy_record(probe, now_epoch)
            if state.get("lastTrustworthy") != trustworthy:
                state["lastTrustworthy"] = trustworthy
                dirty = True
        else:
            kind = "probe_failure"
            fail_line = f"FAIL required_tools_probe: outcome={outcome}"
            summary = f"BOT ERRORS required-tools inventory unobserved ({outcome})"
        if open_condition is None:
            state["openCondition"] = {
                "alertSource": REQUIRED_TOOLS_ALERT_SOURCE,
                "kind": kind,
                "outcome": outcome,
                "openedAtEpoch": now_epoch,
            }
            dirty = True
        elif open_condition.get("kind") != kind or open_condition.get("outcome") != outcome:
            open_condition["kind"] = kind
            open_condition["outcome"] = outcome
            dirty = True
        evidence_lines = [fail_line]
        if kind == "probe_failure":
            trust_line = _last_trustworthy_inventory_line(state, now_epoch)
            evidence_lines.append(trust_line)
            extra.append(trust_line)
        events.append(("alert", "critical", summary, "\n".join(evidence_lines)))
        return dirty, events, extra

    if outcome == "inventory_ok":
        trustworthy = _tool_inventory_trustworthy_record(probe, now_epoch)
        if state.get("lastTrustworthy") != trustworthy:
            state["lastTrustworthy"] = trustworthy
            dirty = True
        if open_condition is not None:
            state["openCondition"] = None
            dirty = True
            observed = int_or_none(probe.get("observedCount"))
            events.append((
                "clear",
                "info",
                "BOT ERRORS required tools verified",
                f"required_tools: verified observed={observed if observed is not None else 'unknown'} required_missing=none",
            ))
        return dirty, events, extra

    return dirty, events, extra


def required_tools_daily_sections(probe: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    """(fail_line, failure_entry, summary_override) for the daily report (#2408).

    Observed absence keeps the historical "missing required tools" wording;
    a failed probe is reported as unobserved inventory and never borrows the
    expected set as observed truth.
    """
    outcome = probe.get("outcome")
    missing = [name for name in (probe.get("missing") or []) if isinstance(name, str)]
    if outcome == "inventory_missing" and missing:
        joined = ",".join(missing)
        return (
            f"FAIL required_tools: required_missing={joined}",
            f"required tools missing: {joined}",
            f"BOT ERRORS daily health found issues: missing required tools {joined}",
        )
    if outcome in TOOL_PROBE_FAILURE_OUTCOMES:
        return (
            f"FAIL required_tools_probe: outcome={outcome}",
            f"required tools inventory unobserved: {outcome}",
            f"BOT ERRORS daily health found issues: required-tools inventory unobserved ({outcome})",
        )
    return (None, None, None)


def tool_inventory(profile: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    if not profile_bool(profile, "expectPersonalTools", True):
        return ["tools personal: skipped by health profile"], _tool_probe("skipped")
    dry_sequence = os.environ.get("BOT_ERRORS_DRY_TOOL_NAMES_SEQUENCE")
    dry_names = os.environ.get("BOT_ERRORS_DRY_TOOL_NAMES")
    if dry_sequence is None and dry_names is None and not SOCKET_PATH:
        return (
            ["tools personal: FAIL BOT_ERRORS_SOCKET_PATH is not configured"],
            _tool_probe("probe_config_missing"),
        )

    attempts = max(1, env_int("BOT_ERRORS_TOOL_LIST_ATTEMPTS", 3))
    if dry_names is not None and dry_sequence is None:
        attempts = 1
    retry_delay = max(0, env_int("BOT_ERRORS_TOOL_LIST_RETRY_DELAY_SECONDS", 3))
    sequence_parts = dry_sequence.split(";") if dry_sequence is not None else []
    raw_profile_contract = profile.get("toolContract")
    profile_contract = raw_profile_contract if isinstance(raw_profile_contract, dict) else None
    contract_holder: dict[str, Any] = {"value": None}

    def load_names(attempt_index: int) -> list[str]:
        if dry_sequence is not None:
            raw = sequence_parts[min(attempt_index, len(sequence_parts) - 1)] if sequence_parts else ""
            return parse_tool_names(raw)
        if dry_names is not None:
            return parse_tool_names(dry_names)
        handshake: dict[str, Any] = {}
        result = json_rpc(SOCKET_PATH, "tools/list", {}, initialize_sink=handshake)
        contract = _bounded_tool_contract(handshake)
        contract_holder["value"] = contract
        _validate_tool_contract(contract, profile_contract)
        tools = result.get("tools")
        if not isinstance(tools, list) or any(
            not isinstance(tool, dict) or not isinstance(tool.get("name"), str) for tool in tools
        ):
            raise _MalformedInventory("tools/list payload shape is not a well-formed inventory")
        return sorted(tool["name"] for tool in tools)

    def expected_tools() -> list[str]:
        # A profile-bound contract selects expectations only after the
        # handshake identity it names has been verified (load_names raises
        # _ProtocolMismatch otherwise), so reaching this with a profile
        # contract means the identity matched.
        if profile_contract and dry_sequence is None and dry_names is None:
            required = profile_contract.get("requiredTools")
            if isinstance(required, list) and all(isinstance(name, str) for name in required):
                return sorted(set(required))
        return REQUIRED_TOOLS

    last_error: BaseException | None = None
    observed_lines: list[str] | None = None
    observed_missing: list[str] = []
    observed_count: int | None = None
    for attempt in range(1, attempts + 1):
        try:
            names = load_names(attempt - 1)
            expected = expected_tools()
            missing = [name for name in expected if name and name not in names]
            prefix = "FAIL " if missing else ""
            retry_note = f" attempts={attempt}/{attempts}" if attempts > 1 else ""
            lines = [
                f"{prefix}tools personal: count={len(names)} required_missing={','.join(missing) if missing else 'none'}{retry_note}",
                f"tools personal required_present={','.join(name for name in expected if name in names)}",
            ]
            contract = contract_holder["value"]
            if isinstance(contract, dict) and any(value for value in contract.values()):
                lines.append(
                    "tools personal contract: "
                    f"protocol={contract.get('protocolVersion') or 'unknown'} "
                    f"server={contract.get('serverName') or 'unknown'}/{contract.get('serverVersion') or 'unknown'}"
                )
            if not missing:
                return lines, _tool_probe(
                    "inventory_ok",
                    observed_count=len(names),
                    attempts=f"{attempt}/{attempts}",
                    contract=contract_holder["value"],
                )
            observed_lines = lines
            observed_missing = missing
            observed_count = len(names)
        except Exception as exc:  # noqa: BLE001 - every probe fault becomes a bounded outcome, never observed absence.
            last_error = exc
        if attempt < attempts:
            time.sleep(retry_delay)

    if observed_lines is not None:
        # A successfully observed subset outranks a later probe failure: the
        # difference below is genuinely observed evidence.
        return observed_lines, _tool_probe(
            "inventory_missing",
            missing=observed_missing,
            observed_count=observed_count,
            attempts=f"{attempts}/{attempts}",
            contract=contract_holder["value"],
        )
    outcome = _classify_tool_probe_error(last_error) if last_error is not None else "probe_error"
    return (
        [f"tools personal: FAIL probe outcome={outcome} attempts={attempts}/{attempts}"],
        _tool_probe(outcome, attempts=f"{attempts}/{attempts}", contract=contract_holder["value"]),
    )


def deadman_observation_gap_line(
    deadman_state: dict[str, Any], now_epoch: int, window_seconds: int = 86_400
) -> str | None:
    """Render the deadman's last observed gap for the daily check.

    ``deadman()`` persists ``lastCheckGapSeconds`` / ``lastCheckGapAt`` when
    two of its graced checks were further apart than twice the timer cadence
    (a suspend, a stopped timer, a starved scheduler). Without a reader the
    record was write-only. It is rendered while younger than ``window_seconds``
    and omitted once older; an unparseable timestamp, or one from the future
    (a forward clock step), is rendered rather than hidden. Informational: a
    late deadman is a scheduler signal, not a fault of the service it watches.
    """
    gap = deadman_state.get("lastCheckGapSeconds")
    at = deadman_state.get("lastCheckGapAt")
    if isinstance(gap, bool) or not isinstance(gap, int) or gap <= 0 or not isinstance(at, str):
        return None
    try:
        age = int(now_epoch - parse_iso_epoch(at))
    except Exception:  # noqa: BLE001 - a malformed stamp is reported, not hidden
        return f"deadman_last_observation_gap: seconds={gap} at={at} age_seconds=unparseable"
    if age > window_seconds:
        return None
    return f"deadman_last_observation_gap: seconds={gap} at={at} age_seconds={age}"


def deadman_observation_gap_inventory() -> list[str]:
    try:
        line = deadman_observation_gap_line(load_deadman_state(), current_epoch())
    except Exception as exc:  # noqa: BLE001 - the daily check must not die on its own record
        return [f"deadman_last_observation_gap: unreadable ({str(exc)[:120]})"]
    return [line] if line else []


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
    state = root / DISPATCHER_STATE
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


def _is_durable_internal_entry(path: Path) -> bool:
    """Return True for durable_json internal artifacts (e.g. ``.durable-json.lock``).

    These are never data entries and must be excluded from queue-depth counts
    and age calculations. See #2727.
    """
    return path.name == ".durable-json.lock"


def directory_stats(path: Path, pattern: str) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    files = [
        item
        for item in path.glob(pattern)
        if item.is_file() and not _is_durable_internal_entry(item)
    ]
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
    root = q_loop_state_root()
    return root.expanduser() / Q_LOOP_STATE


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


def record_daily_health_receipt(event_path: Path, severity: str) -> None:
    """Write a durable receipt after queuing a daily-health event."""
    root = state_root()
    receipt_path = root / "daily-health-receipt.json"
    receipt = {
        "eventId": event_path.stem,
        "severity": severity,
        "emittedAt": now_iso(),
        "eventPath": str(event_path),
    }
    ensure_private_dir(root)
    target = _durable_target(receipt_path)
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        receipt,
        component="health_check.daily_health_receipt",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        receipt,
        component="health_check.daily_health_receipt",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)


def daily() -> int:
    profile = load_health_profile()
    tool_lines, tool_probe = tool_inventory(profile)
    tool_fail_line, tool_failure_entry, tool_summary_override = required_tools_daily_sections(tool_probe)
    tool_state = load_tool_inventory_state()
    tool_state_dirty, tool_events, tool_extra_lines = required_tools_lifecycle(
        tool_state, tool_probe, current_epoch()
    )
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
        *deadman_observation_gap_inventory(),
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
        *instance_db_inventory(),
        *clock_inventory(),
        *tool_lines,
        *tool_extra_lines,
    ]
    if tool_fail_line:
        lines.insert(0, tool_fail_line)
    failures = [
        line for line in lines
        if line.startswith("FAIL ") or " FAIL " in line or line.startswith("config ") and "invalid JSON" in line
    ]
    if tool_failure_entry:
        failures.append(tool_failure_entry)
    warnings = [line for line in lines if line.startswith("WARN ") or " WARN " in line]
    severity = daily_summary_severity(failures, warnings)
    evidence = "\n".join(lines)
    critical_asset = critical_asset_from_health_evidence(evidence) if severity != "info" else None
    if tool_summary_override:
        summary = tool_summary_override
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
    record_daily_health_receipt(path, severity)
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
    for tool_event_type, tool_severity, tool_summary, tool_evidence in tool_events:
        tool_path = outbox_event(
            tool_summary,
            tool_evidence,
            severity=tool_severity,
            source="daily-health",
            event_type=tool_event_type,
            alert_source=REQUIRED_TOOLS_ALERT_SOURCE,
        )
        print(tool_path)
    if tool_state_dirty:
        # Emit-before-save: a crash between the clear emission and this save can
        # only replay the clear next run, where the incident pop is a no-op; the
        # reverse order could lose the pending clear forever.
        save_tool_inventory_state(tool_state)
    return 0


@controller_cycle(
    CONTROLLER_LOG_CONTEXT,
    lambda kind, details, level, outcome: append_deadman_log(
        {"type": kind, **details},
        level=level,
        outcome=outcome,
    ),
)
def _deadman_member_line(code: str, member: dict[str, Any]) -> str:
    detail = member.get("detail") if isinstance(member.get("detail"), dict) else {}
    rendered = " ".join(f"{key}={value}" for key, value in sorted(detail.items()))
    return f"  > problem: {code}" + (f" {rendered}" if rendered else "")


def _deadman_onset_text(episode: dict[str, Any], cooldown_seconds: int) -> str:
    onset = episode.get("onset") if isinstance(episode.get("onset"), dict) else {}
    members = episode.get("members") if isinstance(episode.get("members"), dict) else {}
    active = {
        code: member
        for code, member in sorted(members.items())
        if isinstance(member, dict) and member.get("status") == "active"
    }
    return "\n".join([
        "BOT ERRORS DEADMAN - dispatcher supervision failed",
        f"  > machine: {socket.gethostname()}",
        f"  > created: {now_iso()}",
        f"  > episode: {episode.get('episodeId')} revision={episode.get('revision')}",
        f"  > cooldown_seconds: {cooldown_seconds}",
        f"  > suppressed_since_last_send: {int_or_none(onset.get('suppressed')) or 0}",
        *[_deadman_member_line(code, member) for code, member in active.items()],
        "  > evidence: deadman controller log + deadman state under the bot-errors state root",
        "  > notifier: direct_whatsapp primary; email_fallback=resend when direct WhatsApp/socket fails",
        "  > requested_action: Q investigate dispatcher, queue, personal line, and email fallback.",
    ])


def _deadman_recovery_text(episode: dict[str, Any]) -> str:
    onset = episode.get("onset") if isinstance(episode.get("onset"), dict) else {}
    members = episode.get("members") if isinstance(episode.get("members"), dict) else {}
    recovered = sorted(
        code for code, member in members.items() if isinstance(member, dict) and member.get("status") == "recovered"
    )
    lines = [
        "BOT ERRORS DEADMAN RECOVERY - dispatcher supervision restored",
        f"  > machine: {socket.gethostname()}",
        f"  > created: {now_iso()}",
        f"  > episode: {episode.get('episodeId')} revision={episode.get('revision')}",
        f"  > opened: {episode.get('openedAt') or 'unknown'}",
        f"  > prior_last_sent: {onset.get('lastAcceptedAt') or 'unknown'}",
        f"  > suppressed_duplicates: {int_or_none(onset.get('suppressed')) or 0}",
        *[f"  > recovered_member: {code}" for code in recovered],
    ]
    adopted = episode.get("adoptedLegacyIncidents")
    if adopted:
        lines.append(f"  > adopted_legacy_incidents: {adopted}")
    lines.append("  > evidence: deadman controller log + deadman state under the bot-errors state root")
    return "\n".join(lines)


# Cadence the shipped schedulers run the deadman at: deploy/bot-errors-deadman.timer
# (OnUnitActiveSec=5m) and the deadman agent in deploy/scripts/install-bot-errors-launchd.sh
# (StartInterval 300). Twice this is both the threshold above which a gap between
# consecutive graced checks is reported as an observation gap (lastCheckGapSeconds /
# check_gap_seconds=) and the cap on how much one late interval credits the grace
# streak, so the default must track those files; test_bot_errors_deadman_grace_attribution.py
# pins it.
DEADMAN_CHECK_INTERVAL_SECONDS = 300

_LINUX_BOOT_ID_PATH = Path("/proc/sys/kernel/random/boot_id")


def _host_boot_id() -> str | None:
    """A clock-independent identity for the current host boot, or None if unknown.

    Linux exposes a per-boot UUID; macOS exposes a per-boot session UUID. Neither
    moves when the wall clock steps, which ``now - uptime`` (and macOS
    ``kern.boottime``, which tracks the calendar) would.
    """
    dry = os.environ.get("BOT_ERRORS_DRY_HOST_BOOT_ID")
    if dry is not None:
        return dry or None
    if HOST_PLATFORM == "darwin":
        try:
            proc = subprocess.run(
                ["sysctl", "-n", "kern.bootsessionuuid"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=3,
                check=False,
            )
            value = (proc.stdout or "").strip()
            return f"bootsession:{value}" if value else None
        except Exception:  # noqa: BLE001 - unknown boot identity is handled by the caller.
            return None
    try:
        value = _LINUX_BOOT_ID_PATH.read_text(encoding="utf-8").strip()
        return f"boot_id:{value}" if value else None
    except Exception:  # noqa: BLE001 - unknown boot identity is handled by the caller.
        return None


def _host_monotonic_seconds() -> int | None:
    """Seconds since boot on a clock that keeps counting through sleep and never
    steps: Linux CLOCK_BOOTTIME, macOS CLOCK_MONOTONIC (which continues across
    sleep on Darwin). Shared by every process on the boot, so consecutive deadman
    runs can measure the interval between them without trusting the wall clock.
    None when unavailable; the caller falls back to clamped wall time."""
    dry = os.environ.get("BOT_ERRORS_DRY_HOST_MONOTONIC_SECONDS")
    if dry is not None:
        # A test knob, so a bad value degrades to the wall-clock fallback and
        # never crashes the deadman (OverflowError on "inf") or poisons the
        # record (a negative value would classify the next record corrupt).
        try:
            parsed = float(dry)
        except ValueError:
            return None
        if parsed != parsed or parsed in (float("inf"), float("-inf")) or parsed < 0:
            return None
        return int(parsed)
    clock = getattr(time, "CLOCK_MONOTONIC", None) if HOST_PLATFORM == "darwin" else getattr(time, "CLOCK_BOOTTIME", None)
    if clock is None:
        return None
    try:
        return int(time.clock_gettime(clock))
    except Exception:  # noqa: BLE001 - unavailable clock is handled by the caller.
        return None


_GRACE_STREAK_FIELDS = (
    "graceStreakSince",
    "graceStreakSeenAt",
    "graceStreakBootId",
    "graceStreakSeenMonotonic",
    "graceStreakAccumulated",
    "graceStreakGapForgiven",
)
_UNKNOWN_BOOT = "unknown"


def _grace_streak_record_state(deadman_state: dict[str, Any]) -> str:
    """Classify the persisted grace-streak record before it is consumed.

    ``absent``: no field at all (grace was not active last check, or first
    run). ``partial``: some fields (an upgrade or an older writer); it re-seeds
    silently. ``valid``: every field present and usable. ``corrupt``: every
    field present but at least one unusable (a bool or non-positive epoch, a
    non-string boot identity, a negative accumulator, a non-bool flag). A
    corrupt record still re-seeds so the next check is normal, but the check
    that finds it refuses grace: a continuity record this deadman did not
    write validly cannot vouch for a fresh restart, and re-seeding to zero
    would make grace credible again for a whole max_state_age.
    """
    present = [f for f in _GRACE_STREAK_FIELDS if f in deadman_state]
    if not present:
        return "absent"
    if len(present) < len(_GRACE_STREAK_FIELDS):
        return "partial"

    def _int(value: Any, minimum: int) -> bool:
        return not isinstance(value, bool) and isinstance(value, int) and value >= minimum

    seen_mono = deadman_state.get("graceStreakSeenMonotonic")
    valid = (
        _int(deadman_state.get("graceStreakSince"), 1)
        and _int(deadman_state.get("graceStreakSeenAt"), 1)
        and isinstance(deadman_state.get("graceStreakBootId"), str)
        and (seen_mono is None or _int(seen_mono, 0))
        and _int(deadman_state.get("graceStreakAccumulated"), 0)
        and isinstance(deadman_state.get("graceStreakGapForgiven"), bool)
    )
    return "valid" if valid else "corrupt"


def _note_grace_streak(
    deadman_state: dict[str, Any],
    grace_active: bool,
    now_epoch: int,
    boot_id: str | None,
    monotonic_now: int | None,
    gap_cap_seconds: int,
) -> tuple[int, bool, int | None]:
    """Track how long restart grace has been continuously active across checks.

    Returns ``(streak_seconds, dirty, observation_gap_seconds)``. A single
    observation cannot tell a fresh restart from a restart loop when there is no
    state age to bound grace with; the streak is the deadman's own memory of
    that, persisted in deadman-state.json.

    The streak is the sum of the intervals the deadman actually observed, on the
    boot's monotonic clock (wall time, clamped at zero, when that is unavailable),
    so a wall-clock step in either direction is neither a re-seed nor a corrupt
    record. An interval longer than ``gap_cap_seconds`` (twice the timer cadence)
    credits nothing the first time -- a suspend or a stopped timer is not observed
    grace, and the first check after it must not page a dispatcher that has only
    had seconds -- but consecutive long intervals each credit the cap, so a deadman
    that keeps running late still reports a restart loop within a few checks
    instead of re-seeding forever. Only a different boot identity re-seeds: the
    boot ended the process the previous grace belonged to. An unknown identity
    cannot disprove continuity and a missed alarm is the worse error, so it
    continues. A record missing any field, or carrying a corrupt epoch (bool or
    non-positive), re-seeds; the caller classifies the record first
    (``_grace_streak_record_state``) so a corrupt one also refuses grace for
    the check that found it.

    The interval is returned so the caller can report it: the deadman's own
    absence is a signal, not something to absorb.
    """
    if not grace_active:
        present = [f for f in _GRACE_STREAK_FIELDS if f in deadman_state]
        for f in present:
            deadman_state.pop(f, None)
        return 0, bool(present), None

    seen = deadman_state.get("graceStreakSeenAt")
    recorded_boot = deadman_state.get("graceStreakBootId")
    seen_mono = deadman_state.get("graceStreakSeenMonotonic")
    accumulated = deadman_state.get("graceStreakAccumulated")
    forgiven = deadman_state.get("graceStreakGapForgiven")
    complete = _grace_streak_record_state(deadman_state) == "valid"
    same_boot = boot_id is None or recorded_boot == _UNKNOWN_BOOT or recorded_boot == boot_id
    if not complete or not same_boot:
        deadman_state["graceStreakSince"] = int(now_epoch)
        deadman_state["graceStreakSeenAt"] = int(now_epoch)
        deadman_state["graceStreakBootId"] = boot_id if boot_id is not None else _UNKNOWN_BOOT
        deadman_state["graceStreakSeenMonotonic"] = monotonic_now
        deadman_state["graceStreakAccumulated"] = 0
        deadman_state["graceStreakGapForgiven"] = False
        return 0, True, None
    if monotonic_now is not None and isinstance(seen_mono, int) and monotonic_now >= seen_mono:
        interval = int(monotonic_now - seen_mono)
    else:
        interval = max(0, int(now_epoch - seen))
    if interval > gap_cap_seconds:
        credit = gap_cap_seconds if forgiven else 0
        forgiven = True
    else:
        credit = interval
        forgiven = False
    accumulated = int(accumulated) + credit
    deadman_state["graceStreakSeenAt"] = int(now_epoch)
    deadman_state["graceStreakSeenMonotonic"] = monotonic_now
    deadman_state["graceStreakAccumulated"] = accumulated
    deadman_state["graceStreakGapForgiven"] = forgiven
    if boot_id is not None and recorded_boot == _UNKNOWN_BOOT:
        deadman_state["graceStreakBootId"] = boot_id
    return accumulated, True, interval


def _grace_still_credible(
    grace_reason: str | None,
    grace_streak_seconds: int,
    max_state_age: int,
) -> bool:
    """Whether an open restart window still excuses a branch with no cycle timestamp.

    ``state_missing`` and ``cycle_incomplete`` cannot be attributed by age the
    way ``cycle_stale`` is: a restart legitimately follows an arbitrarily old
    heartbeat (an outage long enough to matter was reported as
    ``service_inactive`` by the checks that ran during it), and a state file
    with no ``cycleCompletedAt`` carries
    no cycle time to compare the restart against. Bounding those branches by
    the restart age reported every fresh restart whose heartbeat predated it,
    which ``tests/scripts/bot-errors-health-check.test.ts`` pins as graced.

    The evidence of a restart loop there is grace itself: a unit that keeps
    restarting has grace active on every check, so the deadman's persisted
    streak (the observed grace intervals summed on the boot's monotonic clock,
    see ``_note_grace_streak``) keeps growing. Grace that has been continuously
    active for longer than ``max_state_age`` is a loop, not a fresh start, and
    stops excusing anything.
    """
    if not grace_reason:
        return False
    return grace_streak_seconds <= max_state_age


def _restart_explains_cycle_age(
    cycle_age_seconds: int,
    restart_age: int | None,
    restart_grace: int,
) -> bool:
    """Whether a recent restart can actually account for this cycle staleness.

    Restart grace exists to cover the window in which a freshly started
    dispatcher has not yet completed its first cycle. It is keyed on service
    uptime, but the condition it suppresses is measured on the *state* -- so
    on its own it says nothing about whether the staleness is attributable to
    the restart.

    That gap is load-bearing: a dispatcher in a restart loop has
    ``service_uptime <= restart_grace`` on every check, so grace is always
    active and ``cycle_stale`` can never be raised. The deadman is then
    silenced by exactly the symptom it exists to detect, and an indefinitely
    broken dispatcher reports ``deadman grace ok``.

    A restart that happened ``restart_age`` seconds ago can only explain a
    cycle that has been stale for about that long (plus the grace window
    itself). Older staleness predates the restart and must be reported.

    ``restart_age`` must be measured on the clock that granted grace: service
    uptime for an active unit, state-change age for a unit that is not active.
    Bounding a state-change grace by uptime silenced a unit that restart-loops
    without ever re-entering active (uptime stale or unknown, change age
    always small). ``deadman`` passes the granting age, so ``None`` is not
    reachable while grace is active; it is kept for direct callers, where
    unknown age means attribution is impossible and grace stands rather than
    manufacturing an alert from missing evidence.
    """
    if restart_age is None:
        return True
    return cycle_age_seconds <= restart_age + restart_grace


def _cycle_stale_should_report(
    cycle_age_seconds: int,
    max_state_age: int,
    grace_reason: str | None,
    restart_age: int | None,
    restart_grace: int,
) -> bool:
    """Whether cycle staleness is reportable: stale, and not excused by a restart.

    The decision is factored out of ``deadman`` so it is directly testable.
    Leaving it inline meant a test could cover ``_restart_explains_cycle_age``
    while the call site silently reverted to an unconditional
    ``if not grace_reason`` and every test still passed -- the same shape as
    the guard defect this change exists to close, where the check was correct
    but not in the path that mattered.
    """
    if cycle_age_seconds <= max_state_age:
        return False
    if not grace_reason:
        return True
    return not _restart_explains_cycle_age(
        cycle_age_seconds, restart_age, restart_grace
    )


def deadman(
    max_state_age: int,
    restart_grace: int,
    cooldown_seconds: int,
    check_interval: int = DEADMAN_CHECK_INTERVAL_SECONDS,
) -> int:
    root = state_root()
    state = root / DISPATCHER_STATE
    active_members: dict[str, dict[str, Any]] = {}
    state_age = None
    cycle_completed_at = None
    now_epoch = current_epoch()
    if state.exists():
        state_age = max(0, int(now_epoch - state.stat().st_mtime))
        try:
            state_data = json.loads(state.read_text(encoding="utf-8"))
            cycle_completed = state_data.get("cycleCompletedAt")
            if isinstance(cycle_completed, str):
                completed_epoch = parse_iso_epoch(cycle_completed)
                cycle_completed_at = max(0, int(now_epoch - completed_epoch))
        except Exception:
            pass
    service_status = service_is_active(DISPATCHER_SERVICE)
    service_uptime, service_state_change_age = service_restart_ages(DISPATCHER_SERVICE)
    grace_reason = None
    # Age of the event that granted grace, on the clock that granted it. The
    # staleness bound below must use this age, not service_uptime: a unit that
    # restart-loops without re-entering active keeps its state-change age under
    # grace on every check while ActiveEnterTimestamp stays stale or unset.
    grace_age: int | None = None
    if service_status != "active":
        if service_state_change_age is not None and service_state_change_age <= restart_grace:
            grace_reason = f"service_state_change_age_seconds={service_state_change_age}"
            grace_age = service_state_change_age
        else:
            active_members["service_inactive"] = {"status": _bounded_service_status(service_status)}
    elif service_uptime is not None and service_uptime <= restart_grace:
        grace_reason = f"service_uptime_seconds={service_uptime}"
        grace_age = service_uptime
    deadman_state = load_deadman_state()
    migrate_deadman_state(deadman_state, now_epoch)
    # Classified before _note_grace_streak re-seeds it: a corrupt continuity
    # record cannot vouch for this check (see _grace_streak_record_state).
    streak_record = _grace_streak_record_state(deadman_state)
    gap_threshold = 2 * (check_interval if check_interval > 0 else DEADMAN_CHECK_INTERVAL_SECONDS)
    grace_streak_seconds, streak_dirty, observation_gap = _note_grace_streak(
        deadman_state, grace_reason is not None, now_epoch, _host_boot_id(), _host_monotonic_seconds(), gap_threshold
    )
    grace_refused = grace_reason is not None and streak_record == "corrupt"
    # The deadman's own absence is a signal: a gap between consecutive graced
    # checks longer than two timer intervals is persisted and printed, never
    # silently absorbed into the streak. The record is durable (lastCheckGapAt
    # dates it) and is replaced only by the next gap, so the daily check can
    # read it; a check at the normal cadence does not erase it.
    check_gap_note = ""
    if observation_gap is not None and observation_gap > gap_threshold:
        deadman_state["lastCheckGapSeconds"] = observation_gap
        deadman_state["lastCheckGapAt"] = epoch_to_iso(now_epoch)
        check_gap_note = f" check_gap_seconds={observation_gap}"
        streak_dirty = True
    if not state.exists():
        # No state file carries no age to bound grace with, so a restart loop
        # that never writes state would be excused on every check. The
        # deadman's own record of how long grace has been continuously active
        # is the only evidence left: grace that has outlived max_state_age is
        # a restart loop, not a fresh start.
        if grace_refused or not _grace_still_credible(grace_reason, grace_streak_seconds, max_state_age):
            detail: dict[str, Any] = {"grace_streak_seconds": grace_streak_seconds} if grace_reason else {}
            if grace_refused:
                detail["grace_refused"] = "corrupt_streak_record"
            active_members["state_missing"] = detail
    elif cycle_completed_at is None:
        # State exists but has no cycleCompletedAt — the last cycle did not
        # complete (crash between start and end). Treat as stale unless the
        # state file was just written by the crash handler (within grace) or a
        # restart window is open. The heartbeat's age is not attributable to
        # the restart (a restart legitimately follows an old heartbeat), so the
        # window is bounded by the grace streak instead: grace that has stayed
        # open longer than max_state_age is a restart loop that never
        # completes a cycle.
        if (
            state_age is not None
            and state_age > restart_grace
            and (grace_refused or not _grace_still_credible(grace_reason, grace_streak_seconds, max_state_age))
        ):
            detail = {"state_age_seconds": state_age}
            if grace_refused:
                detail["grace_refused"] = "corrupt_streak_record"
            active_members["cycle_incomplete"] = detail
    elif _cycle_stale_should_report(
        cycle_completed_at, max_state_age, grace_reason, grace_age, restart_grace
    ):
        active_members["cycle_stale"] = {"cycle_age_seconds": cycle_completed_at}
    if not SOCKET_PATH or not Path(SOCKET_PATH).exists():
        active_members["socket_missing"] = {}

    onset_text = {"value": None}

    def attempt_onset(episode: dict[str, Any]) -> dict[str, Any]:
        text = _deadman_onset_text(episode, cooldown_seconds)
        onset_text["value"] = text
        return _deadman_attempt_delivery(
            text,
            "BOT ERRORS deadman failed",
            context=f"episode={episode.get('episodeId')}",
        )

    def attempt_recovery(episode: dict[str, Any]) -> dict[str, Any]:
        return _deadman_attempt_delivery(
            _deadman_recovery_text(episode),
            "BOT ERRORS deadman recovered",
            context=f"recovery episode={episode.get('episodeId')}",
        )

    result = advance_deadman_episode(
        deadman_state,
        active_members,
        now_epoch=now_epoch,
        cooldown_seconds=cooldown_seconds,
        attempt_onset=attempt_onset,
        attempt_recovery=attempt_recovery,
    )
    if result["dirty"] or streak_dirty:
        save_deadman_state(deadman_state)
    for payload, level in result["logs"]:
        append_deadman_log(payload, level=level)

    delivery = result.get("delivery")
    if delivery == "suppressed_cooldown":
        print(
            "notifier direct_whatsapp=suppressed_cooldown "
            f"cooldown_remaining_seconds={result.get('cooldown_remaining_seconds')} "
            f"suppressed={result.get('suppressed')}"
        )
    elif delivery in ("pending_exhausted", "pending_exhausted_hold"):
        print("notifier delivery=pending_exhausted (bounded retry budget spent; re-arms on membership change)")
    elif delivery in ("recovery_pending_exhausted", "recovery_exhausted_hold"):
        print("deadman ok (recovery notice exhausted; episode retained pending delivery)")
    elif delivery == "recovery_not_required":
        print("deadman ok (episode self-healed before any delivered notification)")
    elif result["exitCode"] == 0:
        if grace_reason:
            state_detail = state_age if state_age is not None else "missing"
            print(f"deadman grace ok: service={service_status} {grace_reason} dispatcher_state_age_seconds={state_detail}{check_gap_note}")
        else:
            print("deadman ok")
    if onset_text["value"]:
        print(onset_text["value"])
    return result["exitCode"]


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
    parser.add_argument(
        "--check-interval",
        type=int,
        default=DEADMAN_CHECK_INTERVAL_SECONDS,
        help="seconds between deadman timer runs (OnUnitActiveSec); twice this is the observation-gap report threshold (check_gap_seconds / lastCheckGapSeconds) and the cap one late interval credits the restart-grace streak",
    )
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
        return deadman(args.max_state_age, args.restart_grace, args.deadman_cooldown, args.check_interval)
    return daily()


if __name__ == "__main__":
    sys.exit(main())
