#!/usr/bin/env python3
"""Qualify the authenticated /health boundary on one macOS deployment host.

This is a deployment observation, not a replacement for the source-test
``health_reader`` profile.  It makes three requests to *one local* endpoint:
without a bearer, with a synthetic invalid bearer, and with the host-resolved
instance bearer.  The first two must return exactly the public envelope; the
third must return a typed diagnostic projection.  The printed receipt contains
only allowlisted health enums, booleans, counts, and timestamps.  It never
prints a token, response body, URL, instance name, identity, or exception.

Disclosure and service health have separate outcomes. A correctly redacted
degraded or unhealthy response qualifies disclosure, but overall qualification
requires a healthy authenticated diagnostic with a connected transport.
These functional observations do not establish deployment acceptance or
transport identity, which require separately bound evidence.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import math
import os
import plistlib
import re
import signal
import socket
import stat
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))
sys.dont_write_bytecode = True
if sys.pycache_prefix is None:
    from lib import deployment_effective_config, deployment_qualification_bundle, durable_json, health_reader  # noqa: E402


PROFILE_SCHEMA_VERSION = "health.deployment-qualification-profile.v1"
RECEIPT_SCHEMA_VERSION = "health.deployment-qualification.v1"
SYNTHETIC_INVALID_TOKEN = "health-qualification-invalid-token"
DEPLOYMENT_POLICY_VERSION = "whatsoup.deployment-qualification-profile.v1"
MAX_BODY_BYTES = 64 * 1024
PUBLIC_SCHEMA_VERSION = "health.public.v1"
PUBLIC_KEYS = frozenset({"schema_version", "status", "generated_at", "startupNotification"})
HEALTH_STATUSES = frozenset({"healthy", "degraded", "unhealthy", "error"})
PUBLIC_HEALTH_STATUSES = frozenset({"healthy", "degraded", "unhealthy"})
QUEUE_CONSUMER_STATES = frozenset({"idle", "current", "backlogged", "consumer_missing"})
STARTUP_NOTIFICATION_KEYS = frozenset({
    "state", "policy", "stabilitySeconds", "bootCountSinceNotification",
    "lastBootAt", "lastNotifiedAt", "nextEligibleAt", "lastSendAt",
})
STARTUP_NOTIFICATION_STATES = frozenset({
    "not_applicable", "disabled", "waiting_stability", "waiting_transport",
    "dispatching", "sent", "send_failed", "journal_unreadable",
})
STARTUP_NOTIFICATION_POLICIES = frozenset({
    "generic", "resume", "restart_loop_guard_alert", "expired_session_notice",
    "intentional_restart", "disabled", "none",
})
_INSTANCE_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")


class ProfileError(ValueError):
    """A supplied qualifier profile is unusable; details never enter receipts."""


class _DeadlineExpired(TimeoutError):
    """Raised only by the in-host wall-clock deadline handler."""


class _ValidatedLaunchAgentPath:
    """Descriptor-bound canonical LaunchAgents parent and expected plist leaf."""

    def __init__(
        self,
        *,
        target: durable_json.DurableJsonTarget,
        parent_fd: int,
        leaf: str,
        parent_identity: tuple[int, int, int, int, int],
        plist_fd: int,
        plist_identity: tuple[int, int, int, int, int],
    ) -> None:
        self.target = target
        self.parent_fd = parent_fd
        self.leaf = leaf
        self.parent_identity = parent_identity
        self.plist_fd = plist_fd
        self.plist_identity = plist_identity


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_instance_name(instance: str) -> None:
    if not isinstance(instance, str) or _INSTANCE_NAME.fullmatch(instance) is None:
        raise ProfileError("instance")


def _is_safe_enum(value: Any, allowed: frozenset[str]) -> bool:
    return isinstance(value, str) and value in allowed


def _parse_epoch_ms(value: Any) -> Optional[int]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return int(parsed.timestamp() * 1000)


def parse_profile(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the neutral deployment profile plus caller-selected port."""
    if not isinstance(profile, Mapping):
        raise ProfileError("profile")
    if profile.get("schema_version") != PROFILE_SCHEMA_VERSION:
        raise ProfileError("schema_version")
    if profile.get("profile_kind") != "deployment":
        raise ProfileError("profile_kind")
    port = profile.get("port")
    if not _is_int(port) or not 1 <= port <= 65535:
        raise ProfileError("port")
    timeout = profile.get("timeout_seconds", 5.0)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise ProfileError("timeout_seconds")
    timeout_seconds = float(timeout)
    if not math.isfinite(timeout_seconds) or not 0.01 <= timeout_seconds <= 60.0:
        raise ProfileError("timeout_seconds")
    return {"port": port, "timeout_seconds": timeout_seconds}


def _default_launch_agent_plist(instance: str) -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"com.whatsoup.{instance}.plist"


def _launch_agent_identity(metadata: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_nlink,
    )


def _private_launch_agent_parent(metadata: os.stat_result) -> bool:
    return (
        stat.S_ISDIR(metadata.st_mode)
        and metadata.st_uid == os.getuid()
        and not (metadata.st_mode & 0o077)
        and metadata.st_nlink >= 2
    )


def _private_launch_agent_plist(metadata: os.stat_result) -> bool:
    return (
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == os.getuid()
        and not (metadata.st_mode & 0o077)
        and metadata.st_nlink == 1
    )


def _validate_launch_agent_path(
    instance: str,
    explicit_path: Optional[Path],
) -> Optional[_ValidatedLaunchAgentPath]:
    """Open the canonical private LaunchAgents parent without following paths.

    This permits a lead to name the actual local plist without accepting an
    arbitrary secrets file.  An unavailable or unsuitable path simply leaves
    the token unresolved and produces a safe inconclusive receipt.  The parent
    descriptor is retained for the subsequent no-follow plist open, rather
    than trusting a path that can change after validation.
    """
    _require_instance_name(instance)
    candidate = explicit_path or _default_launch_agent_plist(instance)
    if not candidate.is_absolute():
        return None
    expected_dir = Path.home() / "Library" / "LaunchAgents"
    if candidate.parent != expected_dir or candidate.name != f"com.whatsoup.{instance}.plist":
        return None
    if not getattr(os, "O_NOFOLLOW", 0):
        return None
    parent_fd = -1
    plist_fd = -1
    try:
        target = durable_json.durable_json_target(
            trusted_root=expected_dir,
            relative_path=candidate.name,
        )
        parent_fd, leaf = durable_json._open_target_parent(target)
        parent_metadata = os.fstat(parent_fd)
        if not _private_launch_agent_parent(parent_metadata):
            os.close(parent_fd)
            return None
        plist_fd = os.open(
            leaf,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
        plist_metadata = os.fstat(plist_fd)
        if not _private_launch_agent_plist(plist_metadata):
            os.close(plist_fd)
            plist_fd = -1
            os.close(parent_fd)
            parent_fd = -1
            return None
        return _ValidatedLaunchAgentPath(
            target=target,
            parent_fd=parent_fd,
            leaf=leaf,
            parent_identity=_launch_agent_identity(parent_metadata),
            plist_fd=plist_fd,
            plist_identity=_launch_agent_identity(plist_metadata),
        )
    except (OSError, ValueError, durable_json.DurableWriteError):
        if plist_fd >= 0:
            os.close(plist_fd)
        if parent_fd >= 0:
            os.close(parent_fd)
        return None


def _read_validated_launch_agent_token(validated: _ValidatedLaunchAgentPath) -> Optional[str]:
    """Read a validated plist by descriptor and reject path or identity drift."""
    try:
        parent_before = os.fstat(validated.parent_fd)
        if (
            _launch_agent_identity(parent_before) != validated.parent_identity
            or not _private_launch_agent_parent(parent_before)
            or not durable_json._parent_authority_matches(validated.target, validated.parent_fd)
        ):
            return None
        plist_before = os.fstat(validated.plist_fd)
        if (
            _launch_agent_identity(plist_before) != validated.plist_identity
            or not _private_launch_agent_plist(plist_before)
        ):
            return None
        with os.fdopen(validated.plist_fd, "rb", closefd=False) as handle:
            loaded = plistlib.load(handle)
        parent_after = os.fstat(validated.parent_fd)
        entry_after = os.stat(validated.leaf, dir_fd=validated.parent_fd, follow_symlinks=False)
        if (
            _launch_agent_identity(os.fstat(validated.plist_fd)) != validated.plist_identity
            or _launch_agent_identity(entry_after) != validated.plist_identity
            or _launch_agent_identity(parent_after) != validated.parent_identity
            or not _private_launch_agent_parent(parent_after)
            or not durable_json._parent_authority_matches(validated.target, validated.parent_fd)
        ):
            return None
    except (OSError, ValueError, plistlib.InvalidFileException, durable_json.DurableWriteError):
        return None
    finally:
        os.close(validated.plist_fd)
        os.close(validated.parent_fd)
    if not isinstance(loaded, dict):
        return None
    environment = loaded.get("EnvironmentVariables")
    if not isinstance(environment, dict):
        return None
    raw = environment.get("WHATSOUP_HEALTH_TOKEN")
    if not isinstance(raw, str):
        return None
    return raw.strip() or None


def resolve_deployment_token(instance: str, *, launch_agent_plist: Optional[Path] = None) -> Optional[str]:
    """Resolve a host-local health token without returning source details.

    Existing deployments use ``health_reader``'s environment/tokens.env order.
    Legacy macOS LaunchAgents may instead retain the token in their own
    ``EnvironmentVariables`` plist; that fallback is deliberately deployment
    specific, leaving the source-test reader contract unchanged.
    """
    _require_instance_name(instance)
    token = health_reader.instance_health_token(instance)
    if token:
        return token
    validated = _validate_launch_agent_path(instance, launch_agent_plist)
    if validated is None:
        return None
    return _read_validated_launch_agent_token(validated)


def qualify_health_deployment_from_effective_record(
    *,
    profile: Mapping[str, Any],
    effective_record_root: Path,
    effective_record_path: Path,
    expected_sha256: str,
    expected_context: Mapping[str, object],
    expected_target: Mapping[str, object],
    launch_agent_plist: Optional[Path] = None,
) -> dict[str, Any]:
    """Observe /health only after a matching private effective record is read.

    The existing reader owns private-record integrity, freshness, source
    re-observation, and equality against the caller's digest/context/target.
    This boundary selects only the record's instance and health port; it does
    not interpret a deployment acceptance result.
    """
    try:
        if not effective_record_root.is_absolute() or not effective_record_path.is_absolute():
            raise deployment_effective_config.EffectiveConfigRefusal()
        relative_path = effective_record_path.relative_to(effective_record_root)
        if relative_path.as_posix() in {"", "."}:
            raise deployment_effective_config.EffectiveConfigRefusal()
        target = durable_json.durable_json_target(
            trusted_root=effective_record_root,
            relative_path=relative_path,
        )
        record = deployment_effective_config.load_effective_config(
            target,
            expected_sha256=expected_sha256,
            expected_context=expected_context,
            expected_target=expected_target,
        )
        record_target = record.get("target")
        configured = record.get("configured")
        limits = record.get("limits")
        if not isinstance(record_target, Mapping) or not isinstance(configured, Mapping) or not isinstance(limits, Mapping):
            raise deployment_effective_config.EffectiveConfigRefusal()
        instance = record_target.get("instance_name")
        configured_instance = configured.get("instance")
        port = configured_instance.get("healthPort") if isinstance(configured_instance, Mapping) else None
        configured_name = configured_instance.get("name") if isinstance(configured_instance, Mapping) else None
        timeout = limits.get("timeout_seconds")
        if (
            not isinstance(instance, str)
            or configured_name != instance
            or not _is_int(port)
            or not isinstance(timeout, (int, float))
            or isinstance(timeout, bool)
        ):
            raise deployment_effective_config.EffectiveConfigRefusal()
        selected_profile = dict(profile)
        selected_profile["port"] = port
        checked = parse_profile(selected_profile)
        record_timeout = float(timeout)
        if not math.isfinite(record_timeout) or not 0.01 <= record_timeout <= 5.0:
            raise deployment_effective_config.EffectiveConfigRefusal()
        selected_profile["timeout_seconds"] = min(checked["timeout_seconds"], record_timeout)
    except deployment_effective_config.EffectiveConfigRefusal:
        raise
    except (OSError, ValueError, TypeError, durable_json.DurableWriteError):
        raise deployment_effective_config.EffectiveConfigRefusal() from None
    receipt = qualify_health_deployment(
        instance,
        selected_profile,
        launch_agent_plist=launch_agent_plist,
    )
    final_record = deployment_effective_config.load_effective_config(
        target,
        expected_sha256=expected_sha256,
        expected_context=expected_context,
        expected_target=expected_target,
    )
    if final_record != record:
        raise deployment_effective_config.EffectiveConfigRefusal()
    return receipt


class _NoRedirect(HTTPRedirectHandler):
    """Return redirect status to the qualifier; never send a second request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_LOOPBACK_OPENER = build_opener(ProxyHandler({}), _NoRedirect())


def _deadline_supported() -> bool:
    """True only where this process can safely own a SIGALRM deadline.

    The qualifier is a command-line main-thread operation on macOS.  It does
    not overwrite a host application's pre-existing timer/handler; a library
    caller without this exact primitive receives a typed inconclusive result.
    """
    if threading.current_thread() is not threading.main_thread():
        return False
    if not all(hasattr(signal, name) for name in ("SIGALRM", "ITIMER_REAL", "getitimer", "setitimer")):
        return False
    try:
        previous_delay, previous_interval = signal.getitimer(signal.ITIMER_REAL)
    except (OSError, ValueError):
        return False
    return previous_delay == 0.0 and previous_interval == 0.0


@contextmanager
def _wall_clock_deadline(timeout_seconds: float):
    """Bound connect, headers, redirects, and body collection as one request."""
    if not _deadline_supported():
        raise RuntimeError("deadline unsupported")
    previous_handler = signal.getsignal(signal.SIGALRM)

    def _expire(_signum, _frame):
        raise _DeadlineExpired()

    signal.signal(signal.SIGALRM, _expire)
    signal.setitimer(signal.ITIMER_REAL, timeout_seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)
        signal.signal(signal.SIGALRM, previous_handler)


def _response_result(observed_at_ms: int, status: int, response: Any) -> dict[str, Any]:
    raw = response.read(MAX_BODY_BYTES + 1)
    result: dict[str, Any] = {
        "observed_at_ms": observed_at_ms,
        "fetch": "response",
        "http_status": status,
        "body_oversized": len(raw) > MAX_BODY_BYTES,
    }
    if not result["body_oversized"]:
        result["raw_body"] = raw.decode("utf-8", errors="replace")
    return result


def _fetch_loopback(port: int, authorization: Optional[str], timeout_seconds: float) -> dict[str, Any]:
    """Fetch a bounded local body and retain only non-sensitive result classes."""
    headers = {"Authorization": authorization} if authorization is not None else {}
    request = Request(f"http://127.0.0.1:{port}/health", method="GET", headers=headers)
    observed_at_ms = int(time.time() * 1000)
    if not _deadline_supported():
        return {"observed_at_ms": observed_at_ms, "fetch": "deadline_unsupported", "raw_body": None}
    try:
        with _wall_clock_deadline(timeout_seconds):
            try:
                with _LOOPBACK_OPENER.open(request, timeout=timeout_seconds) as response:
                    return _response_result(observed_at_ms, int(response.status), response)
            except HTTPError as exc:
                return _response_result(observed_at_ms, int(exc.code), exc)
    except _DeadlineExpired:
        return {"observed_at_ms": observed_at_ms, "fetch": "timeout", "raw_body": None}
    except HTTPError as exc:
        return _response_result(observed_at_ms, int(exc.code), exc)
    except (socket.timeout, TimeoutError):
        return {"observed_at_ms": observed_at_ms, "fetch": "timeout", "raw_body": None}
    except URLError as exc:
        if isinstance(exc.reason, (socket.timeout, TimeoutError)):
            return {"observed_at_ms": observed_at_ms, "fetch": "timeout", "raw_body": None}
        return {"observed_at_ms": observed_at_ms, "fetch": "transport_error", "raw_body": None}
    except OSError:
        return {"observed_at_ms": observed_at_ms, "fetch": "transport_error", "raw_body": None}


def _parsed_payload(raw_body: Any) -> Optional[dict[str, Any]]:
    if not isinstance(raw_body, str):
        return None
    try:
        payload = json.loads(raw_body)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _public_body_valid(payload: Optional[dict[str, Any]]) -> bool:
    if not isinstance(payload, dict) or payload.get("schema_version") != PUBLIC_SCHEMA_VERSION:
        return False
    if frozenset(payload) != PUBLIC_KEYS:
        return False
    if not _is_safe_enum(payload.get("status"), PUBLIC_HEALTH_STATUSES):
        return False
    if _parse_epoch_ms(payload.get("generated_at")) is None:
        return False
    startup = payload.get("startupNotification")
    if not isinstance(startup, dict) or frozenset(startup) != STARTUP_NOTIFICATION_KEYS:
        return False
    if not _is_safe_enum(startup.get("state"), STARTUP_NOTIFICATION_STATES):
        return False
    if not _is_safe_enum(startup.get("policy"), STARTUP_NOTIFICATION_POLICIES):
        return False
    for key in STARTUP_NOTIFICATION_KEYS - {"state", "policy"}:
        value = startup.get(key)
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
        ):
            return False
    return True


def _health_status_code_contract(status: Any, http_status: int) -> str:
    """Classify the source's documented health-status/HTTP pairing safely."""
    if http_status not in {200, 503}:
        return "unsupported"
    expected = 503 if status == "unhealthy" else 200 if status in {"healthy", "degraded"} else None
    if expected is None:
        return "unsupported"
    return "matched" if http_status == expected else "mismatched"


def _queue_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    sqlite = payload.get("sqlite")
    if not isinstance(sqlite, dict):
        return {"available": False}
    pending = sqlite.get("fact_export_pending")
    oldest = sqlite.get("fact_export_oldest_pending_age_s")
    latest = sqlite.get("fact_export_latest_ack_age_s")
    state = sqlite.get("fact_export_consumer_state")
    if (
        not _is_int(pending) or pending < 0
        or not _is_int(oldest) or oldest < 0
        or not (latest is None or (_is_int(latest) and latest >= 0))
        or not _is_safe_enum(state, QUEUE_CONSUMER_STATES)
    ):
        return {"available": False}
    return {
        "available": True,
        "consumer_state": state,
        "pending": pending,
        "oldest_pending_age_s": oldest,
        "latest_ack_age_s": latest,
    }


def _diagnostic_safe_snapshot(payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    whatsapp = payload.get("whatsapp")
    connection = whatsapp.get("connection") if isinstance(whatsapp, dict) else None
    instance = payload.get("instance")
    sqlite = payload.get("sqlite")
    status = payload.get("status")
    generated_at_ms = _parse_epoch_ms(payload.get("generated_at"))
    valid = (
        _is_safe_enum(status, HEALTH_STATUSES)
        and generated_at_ms is not None
        and isinstance(whatsapp, dict)
        and isinstance(whatsapp.get("connected"), bool)
        and isinstance(connection, dict)
        and isinstance(connection.get("state"), str)
        and isinstance(instance, dict)
        and isinstance(sqlite, dict)
    )
    if not valid:
        return False, {}
    return True, {
        "status": status,
        "generated_at_ms": generated_at_ms,
        "connected": whatsapp["connected"],
        "queue": _queue_snapshot(payload),
    }


def _empty_leg(leg: str, token: str, observed_at_ms: int) -> dict[str, Any]:
    return {
        "leg": leg,
        "observed_at_ms": observed_at_ms,
        "token": token,
        "fetch": "not_attempted",
        "body": "none",
        "projection": "unobserved",
        "diagnostic_shape": "not_applicable",
        "http_status_contract": "not_observed",
        "safe": {},
    }


def _observe_public_leg(leg: str, port: int, timeout_seconds: float) -> dict[str, Any]:
    authorization = None if leg == "absent" else f"Bearer {SYNTHETIC_INVALID_TOKEN}"
    token = "none" if leg == "absent" else "synthetic_invalid"
    fetched = _fetch_loopback(port, authorization, timeout_seconds)
    result = {
        "leg": leg,
        "observed_at_ms": fetched["observed_at_ms"],
        "token": token,
        "fetch": fetched["fetch"],
        "body": "none",
        "projection": "unobserved",
        "diagnostic_shape": "not_applicable",
        "http_status_contract": "not_observed",
        "safe": {},
    }
    if "http_status" in fetched:
        result["http_status"] = fetched["http_status"]
    if fetched["fetch"] != "response":
        return result
    if fetched.get("body_oversized"):
        result["body"] = "oversized"
        return result
    payload = _parsed_payload(fetched["raw_body"])
    if payload is None:
        result["body"] = "malformed"
        return result
    result["projection"] = health_reader.classify_projection(payload, token_sent=False)
    result["body"] = "public_valid" if _public_body_valid(payload) else "public_invalid"
    if result["body"] == "public_valid":
        result["http_status_contract"] = _health_status_code_contract(payload["status"], fetched["http_status"])
    return result


def _observe_valid_leg(port: int, timeout_seconds: float, token: Optional[str]) -> dict[str, Any]:
    if token is None:
        return _empty_leg("valid", "unavailable", int(time.time() * 1000))
    fetched = _fetch_loopback(port, f"Bearer {token}", timeout_seconds)
    result = {
        "leg": "valid",
        "observed_at_ms": fetched["observed_at_ms"],
        "token": "host_resolved",
        "fetch": fetched["fetch"],
        "body": "none",
        "projection": "unobserved",
        "diagnostic_shape": "not_applicable",
        "http_status_contract": "not_observed",
        "safe": {},
    }
    if "http_status" in fetched:
        result["http_status"] = fetched["http_status"]
    if fetched["fetch"] != "response":
        return result
    if fetched.get("body_oversized"):
        result["body"] = "oversized"
        return result
    payload = _parsed_payload(fetched["raw_body"])
    if payload is None:
        result["body"] = "malformed"
        return result
    result["projection"] = health_reader.classify_projection(payload, token_sent=True)
    if result["projection"] == "diagnostic":
        valid, safe = _diagnostic_safe_snapshot(payload)
        result["body"] = "diagnostic_valid" if valid else "diagnostic_invalid"
        result["diagnostic_shape"] = "valid" if valid else "invalid"
        result["safe"] = safe
        if valid:
            result["http_status_contract"] = _health_status_code_contract(safe["status"], fetched["http_status"])
    elif health_reader.is_public_envelope(payload):
        result["body"] = "public_valid" if _public_body_valid(payload) else "public_invalid"
        if result["body"] == "public_valid":
            result["http_status_contract"] = _health_status_code_contract(payload["status"], fetched["http_status"])
    else:
        result["body"] = "unrecognized"
    return result


def _unresolved(legs: list[dict[str, Any]]) -> list[str]:
    unresolved: list[str] = []
    public_legs = legs[:2]
    if any(leg["fetch"] == "timeout" for leg in legs):
        unresolved.append("loopback_timeout")
    if any(leg["fetch"] == "transport_error" for leg in legs):
        unresolved.append("loopback_transport_error")
    if any(leg["fetch"] == "deadline_unsupported" for leg in legs):
        unresolved.append("loopback_deadline_unsupported")
    if any(leg["http_status_contract"] == "unsupported" for leg in legs):
        unresolved.append("health_status_code_unsupported")
    if any(leg["http_status_contract"] == "mismatched" for leg in legs):
        unresolved.append("health_status_code_mismatch")
    if any(leg["body"] == "malformed" for leg in legs):
        unresolved.append("valid_body_malformed" if legs[2]["body"] == "malformed" else "public_body_malformed")
    if any(leg["body"] == "oversized" for leg in legs):
        unresolved.append("valid_body_oversized" if legs[2]["body"] == "oversized" else "public_body_oversized")
    if any(
        leg["fetch"] == "response"
        and leg["body"] in {"public_valid", "public_invalid"}
        and (leg["body"] == "public_invalid" or leg["projection"] != "public")
        for leg in public_legs
    ):
        unresolved.append("public_disclosure_violation")
    valid = legs[2]
    if valid["token"] == "unavailable":
        unresolved.append("host_token_unavailable")
    elif valid["fetch"] == "response" and valid["body"] == "public_valid":
        unresolved.append("host_token_rejected")
    elif valid["fetch"] == "response" and valid["body"] == "diagnostic_invalid":
        unresolved.append("diagnostic_shape_invalid")
    elif valid["fetch"] == "response" and valid["body"] == "unrecognized":
        unresolved.append("valid_projection_unrecognized")
    return unresolved


def _disclosure_outcome(unresolved: list[str]) -> str:
    if not unresolved:
        return "qualified"
    if any(
        item in unresolved
        for item in ("public_disclosure_violation", "diagnostic_shape_invalid", "health_status_code_mismatch")
    ):
        return "not_qualified"
    return "inconclusive"


def _service_health_outcome(valid: dict[str, Any]) -> str:
    if valid["body"] != "diagnostic_valid" or valid["http_status_contract"] != "matched":
        return "inconclusive"
    safe = valid["safe"]
    return "qualified" if safe["status"] == "healthy" and safe["connected"] else "not_qualified"


def qualify_health_deployment(
    instance: str,
    profile: Mapping[str, Any],
    *,
    launch_agent_plist: Optional[Path] = None,
) -> dict[str, Any]:
    """Return a redacted three-leg deployment qualification receipt."""
    _require_instance_name(instance)
    checked = parse_profile(profile)
    absent = _observe_public_leg("absent", checked["port"], checked["timeout_seconds"])
    invalid = _observe_public_leg("invalid", checked["port"], checked["timeout_seconds"])
    token = resolve_deployment_token(instance, launch_agent_plist=launch_agent_plist)
    valid = _observe_valid_leg(checked["port"], checked["timeout_seconds"], token)
    legs = [absent, invalid, valid]
    unresolved = _unresolved(legs)
    disclosure = _disclosure_outcome(unresolved)
    service_health = _service_health_outcome(valid)
    outcomes = {disclosure, service_health}
    outcome = (
        "not_qualified" if "not_qualified" in outcomes
        else "inconclusive" if "inconclusive" in outcomes
        else "qualified"
    )
    return {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "profile_kind": "deployment",
        "observed_at_ms": int(time.time() * 1000),
        "outcome": outcome,
        "disclosure_outcome": disclosure,
        "service_health_outcome": service_health,
        "legs": legs,
        "unresolved": unresolved,
    }


def _load_json(path: Path) -> Mapping[str, Any]:
    with path.open(encoding="utf-8") as handle:
        loaded = json.load(handle)
    if not isinstance(loaded, dict):
        raise ProfileError("profile")
    return loaded


def _inconclusive_receipt(reason: str) -> dict[str, Any]:
    return {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "profile_kind": "deployment",
        "outcome": "inconclusive",
        "disclosure_outcome": "inconclusive",
        "service_health_outcome": "inconclusive",
        "legs": [],
        "unresolved": [reason],
    }


def _require_loaded_bundle_paths(bundle: deployment_qualification_bundle.QualificationBundle, profile_path: Path) -> None:
    root = bundle.execution_root
    if (
        Path(__file__).absolute() != bundle.qualifier_path
        or _SCRIPT_DIR != root
        or profile_path != root / "health-deployment-qualification-profile.json"
    ):
        raise deployment_qualification_bundle.QualificationBundleRefusal()
    required = {
        bundle.qualifier_path,
        profile_path,
        root / "deployment-qualification-profile.json",
        root / "runtime-test-qualification.json",
    }
    for module in (deployment_effective_config, deployment_qualification_bundle, durable_json, health_reader):
        loaded = Path(module.__file__).absolute()
        expected = root / "lib" / (module.__name__.rsplit(".", 1)[-1] + ".py")
        if loaded != expected:
            raise deployment_qualification_bundle.QualificationBundleRefusal()
        required.add(loaded)
    if not required.issubset(bundle.declared_file_paths) or any(
        path.suffix in {".pyc", ".pyo"} for path in bundle.declared_file_paths
    ):
        raise deployment_qualification_bundle.QualificationBundleRefusal()


def main() -> int:
    if sys.pycache_prefix is not None:
        print(json.dumps(_inconclusive_receipt("bundle_unavailable"), separators=(",", ":")))
        return 3
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--instance", required=True, help="local instance name; never emitted")
    parser.add_argument("--port", type=int, help="local loopback health port for an unbound observation")
    parser.add_argument("--profile", type=Path, default=_SCRIPT_DIR / "health-deployment-qualification-profile.json")
    parser.add_argument("--launch-agent-plist", type=Path, help="canonical local LaunchAgent plist; no token argument exists")
    parser.add_argument("--timeout-seconds", type=float, help="per-request local loopback timeout (0.01-60)")
    parser.add_argument("--effective-record-root", type=Path)
    parser.add_argument("--effective-record", type=Path)
    parser.add_argument("--effective-record-sha256")
    parser.add_argument("--arc-commit")
    parser.add_argument("--qfleet-commit")
    parser.add_argument("--whatsoup-commit")
    parser.add_argument("--run-context-digest")
    parser.add_argument("--host-ref")
    parser.add_argument("--user-ref")
    parser.add_argument("--instance-ref")
    parser.add_argument("--inventory-host")
    parser.add_argument("--bundle-root", type=Path)
    parser.add_argument("--bundle-manifest", type=Path)
    parser.add_argument("--bundle-sha256")
    args = parser.parse_args()
    try:
        effective_inputs = (
            args.effective_record_root, args.effective_record, args.effective_record_sha256,
            args.arc_commit, args.qfleet_commit, args.whatsoup_commit, args.run_context_digest,
            args.host_ref, args.user_ref, args.instance_ref, args.inventory_host,
        )
        bundle = None
        bundle_inputs = (args.bundle_root, args.bundle_manifest, args.bundle_sha256)
        if any(value is not None for value in bundle_inputs):
            if any(value is None for value in (*bundle_inputs, *effective_inputs)):
                raise deployment_qualification_bundle.QualificationBundleRefusal()
            bundle = deployment_qualification_bundle.load_qualification_bundle(
                args.bundle_root, args.bundle_manifest,
                expected_sha256=args.bundle_sha256,
                expected_source_commit=args.whatsoup_commit,
                expected_arc_commit=args.arc_commit,
                expected_qfleet_commit=args.qfleet_commit,
                expected_policy_version=DEPLOYMENT_POLICY_VERSION,
            )
            _require_loaded_bundle_paths(bundle, args.profile)
        profile = dict(_load_json(args.profile))
        if any(value is not None for value in effective_inputs):
            if any(value is None for value in effective_inputs) or args.port is not None or args.timeout_seconds is not None:
                raise deployment_effective_config.EffectiveConfigRefusal()
            receipt = qualify_health_deployment_from_effective_record(
                profile=profile,
                effective_record_root=args.effective_record_root,
                effective_record_path=args.effective_record,
                expected_sha256=args.effective_record_sha256,
                expected_context={
                    "arc_commit": args.arc_commit,
                    "qfleet_commit": args.qfleet_commit,
                    "whatsoup_commit": args.whatsoup_commit,
                    "run_context_digest": args.run_context_digest,
                },
                expected_target={
                    "host_ref": args.host_ref,
                    "user_ref": args.user_ref,
                    "instance_ref": args.instance_ref,
                    "inventory_host": args.inventory_host,
                    "instance_name": args.instance,
                },
                launch_agent_plist=args.launch_agent_plist,
            )
        else:
            if args.port is None:
                raise ProfileError("port")
            profile["port"] = args.port
            if args.timeout_seconds is not None:
                profile["timeout_seconds"] = args.timeout_seconds
            receipt = qualify_health_deployment(
                args.instance,
                profile,
                launch_agent_plist=args.launch_agent_plist,
            )
        if bundle is not None:
            deployment_qualification_bundle.recheck_qualification_bundle(bundle)
            receipt["bundle_binding"] = {
                "manifest_sha256": bundle.bundle_sha256,
                "effective_record_sha256": args.effective_record_sha256,
                "context": {
                    "arc_commit": args.arc_commit,
                    "qfleet_commit": args.qfleet_commit,
                    "whatsoup_commit": args.whatsoup_commit,
                    "run_context_digest": args.run_context_digest,
                },
                "target": {
                    "host_ref": args.host_ref,
                    "user_ref": args.user_ref,
                    "instance_ref": args.instance_ref,
                },
            }
    except deployment_qualification_bundle.QualificationBundleRefusal:
        print(json.dumps(_inconclusive_receipt("bundle_unavailable"), separators=(",", ":")))
        return 3
    except deployment_effective_config.EffectiveConfigRefusal:
        print(json.dumps(_inconclusive_receipt("effective_record_unavailable"), separators=(",", ":")))
        return 3
    except (OSError, ValueError, json.JSONDecodeError, ProfileError):
        # The machine-readable result must never echo a path or parse error.
        print(json.dumps(_inconclusive_receipt("profile_unavailable"), separators=(",", ":")))
        return 3
    print(json.dumps(receipt, separators=(",", ":")))
    return {"qualified": 0, "not_qualified": 2, "inconclusive": 3}[receipt["outcome"]]


if __name__ == "__main__":
    raise SystemExit(main())
