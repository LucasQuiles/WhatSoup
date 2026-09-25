#!/usr/bin/env python3
"""Shared authenticated /health reader and projection classifier (register F01).

One implementation of: resolve the instance health token, read the local
/health endpoint with it, and classify the response into exactly one projection
outcome so no consumer treats the intentionally-minimal public liveness
envelope as authenticated diagnostics.

Outcomes:
  - ``diagnostic``: the privileged body (carries ``whatsapp``); identity,
    auth-bond, DB, and provider fields are present and may be asserted.
  - ``public``: the intentional public liveness envelope (schema_version
    ``health.public.*``, no ``whatsapp``) obtained WITHOUT sending a token —
    proves HTTP/transport liveness only.
  - ``unobserved``: no diagnostic body was obtained — the token was missing or
    rejected, or the body was unreachable/unparseable/unrecognised. This is NOT
    a workload verdict; the operator action is to provision/repair the token,
    never to conclude the bot failed or that identity/auth fields are absent.

Consolidates the previously duplicated ``health_body_is_disclosed`` /
``instance_health_token`` logic from bot-errors-heartbeat-watchdog.py and
fleet-ground-truth.py so there is exactly one discriminator.
"""
from __future__ import annotations

import json
import http.client
import os
from pathlib import Path
from typing import Any, Callable, Optional

PUBLIC_HEALTH_SCHEMA_PREFIX = "health.public."

_DEFAULT_TIMEOUT_SECONDS = 5


class HealthTransportError(RuntimeError):
    """Content-free failure from one stage of the current loopback request."""

    def __init__(self, stage: str, number: Optional[int], *, timed_out: bool = False):
        super().__init__("loopback health transport unavailable")
        self.stage = stage
        self.errno = number if type(number) is int else None
        # A socket timeout is an OSError with errno None; without this flag it
        # is indistinguishable from any other errno-less transport failure.
        self.timed_out = timed_out


def fetch_loopback_health(
    port: int, request_path: str, headers: dict, *, timeout: float = _DEFAULT_TIMEOUT_SECONDS,
) -> tuple[int, str]:
    """One direct loopback request; callers needing a wall deadline bound the process."""
    if type(port) is not int or not 1 <= port <= 65535 or request_path not in ("/health", "/"):
        raise ValueError("invalid loopback health target")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    stage = "connect"
    try:
        connection.connect()
        stage = "request"
        connection.request("GET", request_path, headers=headers)
        stage = "response"
        response = connection.getresponse()
        stage = "read"
        raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("health response exceeds limit")
        return response.status, raw.decode("utf-8")
    except TimeoutError:
        raise HealthTransportError(stage, None, timed_out=True) from None
    except OSError as exc:
        raise HealthTransportError(stage, exc.errno) from None
    finally:
        connection.close()


def instance_health_token(name: str) -> Optional[str]:
    """Resolve the instance health token so a probe reads the privileged body.

    Env override first (deployments that inject per-instance secrets), then the
    shared env token, then the on-host instance tokens file. A probe of
    127.0.0.1 always runs on the host that owns that file.
    """
    override = os.environ.get(f"BOT_ERRORS_HEALTH_TOKEN_{name.replace('-', '_').upper()}")
    if override:
        return override.strip() or None
    shared = os.environ.get("WHATSOUP_HEALTH_TOKEN")
    if shared:
        return shared.strip() or None
    path = Path.home() / ".config" / "whatsoup" / "instances" / name / "tokens.env"
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("WHATSOUP_HEALTH_TOKEN="):
                return line.split("=", 1)[1].strip() or None
    except OSError:
        return None
    return None


def health_body_is_disclosed(payload: Any) -> bool:
    """True only for the privileged diagnostic body.

    Fail-closed: anything unrecognised counts as NOT disclosed. Every privileged
    axis (``whatsapp.connected``, ``connection.auth_failure_class``,
    ``auth_bond.status``, ``instance.name``) lives under ``whatsapp``/``instance``,
    which the public envelope omits entirely — so a ``whatsapp`` dict is the
    deterministic discriminator.
    """
    if not isinstance(payload, dict):
        return False
    schema = payload.get("schema_version")
    if isinstance(schema, str) and schema.startswith(PUBLIC_HEALTH_SCHEMA_PREFIX):
        return False
    return isinstance(payload.get("whatsapp"), dict)


def is_public_envelope(payload: Any) -> bool:
    """True for the recognised public liveness envelope (schema_version
    ``health.public.*``)."""
    if not isinstance(payload, dict):
        return False
    schema = payload.get("schema_version")
    return isinstance(schema, str) and schema.startswith(PUBLIC_HEALTH_SCHEMA_PREFIX)


def classify_projection(payload: Any, *, token_sent: bool) -> str:
    """Classify a parsed /health body into ``diagnostic`` | ``public`` | ``unobserved``.

    A missing or rejected token can never yield an authenticated verdict, and
    a diagnostic-SHAPED body obtained WITHOUT authentication never gains
    diagnostic authority (the public-projection ceiling in the authority
    lattice — anyone can shape a body; only the accepted token proves the
    projection):

      - disclosed body, a token WAS sent       -> ``diagnostic``
      - disclosed body, no token was sent      -> ``unobserved`` (invalid evidence
        for privileged claims; also a server-side disclosure anomaly)
      - public envelope, no token was sent     -> ``public`` (liveness only)
      - public envelope, a token WAS sent      -> ``unobserved`` (token rejected)
      - anything else (None/unparsed/unknown)  -> ``unobserved``
    """
    if health_body_is_disclosed(payload):
        return "diagnostic" if token_sent else "unobserved"
    if is_public_envelope(payload):
        return "unobserved" if token_sent else "public"
    return "unobserved"


def _default_fetch(url: str, headers: dict) -> tuple[int, str]:
    from urllib.parse import urlsplit

    target = urlsplit(url)
    if (target.scheme != "http" or target.hostname != "127.0.0.1"
            or target.username is not None or target.password is not None
            or target.query or target.fragment):
        raise ValueError("invalid loopback health target")
    return fetch_loopback_health(target.port, target.path, headers)


def read_local_health(
    name: str,
    port: int,
    *,
    fetch: Optional[Callable[[str, dict], tuple[int, str]]] = None,
) -> tuple[str, Optional[int], str]:
    """Read the local /health endpoint for ``name`` and classify the projection.

    Returns ``(projection, http_status_or_None, raw_body)``. Resolves the
    instance token and sends it as a bearer. A missing token short-circuits to
    ``unobserved`` WITHOUT probing — the operator action is to provision the
    token, and a diagnostics-seeking consumer must not fall back to reading the
    public envelope as if it were authenticated. A diagnostics consumer that
    receives anything but ``diagnostic`` must treat identity/auth fields as
    unobserved rather than failed.
    """
    token = instance_health_token(name)
    if not token:
        return ("unobserved", None, "")
    url = f"http://127.0.0.1:{port}/health"
    headers = {"Authorization": f"Bearer {token}"}
    fetcher = fetch or _default_fetch
    try:
        status, body = fetcher(url, headers)
    except Exception:
        return ("unobserved", None, "")
    try:
        payload: Any = json.loads(body)
    except Exception:
        payload = None
    return (classify_projection(payload, token_sent=True), status, body)


# --- Disconnect classification carried by the authenticated body -----------
#
# Mirrors src/lib/disconnect-classification.ts. ``whatsapp.connection.
# disconnect_decision`` is the transport's own decision for the last close.
# Absent means a legacy body (callers keep their old 401 rule); null means no
# close since start/open; an unrecognised value stays "unknown" — never
# terminal, never healthy.

DISCONNECT_CLASSIFICATIONS = frozenset({
    "confirmed_device_removed",
    "ambiguous_401_reconnecting",
    "ambiguous_401_parked",
    "uninspected_401_conservative_exit",
    "other",
})
DISCONNECT_DECISION_VERSION = 1


def disconnect_decision_reading(connection: Any) -> tuple[str, Optional[str]]:
    """Return ``(kind, classification)``; kind is absent|none|classified|unknown."""
    if not isinstance(connection, dict) or "disconnect_decision" not in connection:
        return ("absent", None)
    node = connection.get("disconnect_decision")
    if node is None:
        return ("none", None)
    if not isinstance(node, dict) or node.get("version") != DISCONNECT_DECISION_VERSION:
        return ("unknown", None)
    classification = node.get("classification")
    if isinstance(classification, str) and classification in DISCONNECT_CLASSIFICATIONS:
        return ("classified", classification)
    return ("unknown", None)


# --- Private (authenticated) health verification ----------------------------
#
# HTTP 200 proves none of authentication, connectivity or debt: the public
# envelope is also 200, and a degraded private body is 200 too. A private
# health read is VERIFIED only when a token was resolved and sent, the body is
# the diagnostic projection with the expected field types, its HTTP status
# agrees with its own status field (200 healthy/degraded, 503 unhealthy), and
# generated_at is fresh. Every other outcome is PRIVATE_HEALTH_UNVERIFIED with
# a distinct reason; the service's own status is reported separately and is
# never inferred from an unverified read.

PRIVATE_HEALTH_UNVERIFIED = "PRIVATE_HEALTH_UNVERIFIED"
PRIVATE_HEALTH_STATUSES = frozenset({"healthy", "degraded", "unhealthy"})
DEFAULT_PRIVATE_HEALTH_MAX_AGE_SECONDS = 30
DEFAULT_PRIVATE_HEALTH_MAX_FUTURE_SKEW_SECONDS = 5


def _parse_generated_at_ms(value: Any) -> Optional[int]:
    from datetime import datetime

    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return int(parsed.timestamp() * 1000)


def _private_shape_problem(payload: dict) -> Optional[str]:
    """Name the first structural defect of a diagnostic body, or None."""
    whatsapp = payload.get("whatsapp")
    if not isinstance(whatsapp, dict):
        return "whatsapp"
    if type(whatsapp.get("connected")) is not bool:
        return "whatsapp.connected"
    connection = whatsapp.get("connection")
    if not isinstance(connection, dict):
        return "whatsapp.connection"
    if not isinstance(connection.get("state"), str):
        return "whatsapp.connection.state"
    if not isinstance(connection.get("auth_failure_class"), str):
        return "whatsapp.connection.auth_failure_class"
    if "disconnect_decision" in connection:
        node = connection["disconnect_decision"]
        if node is not None and not isinstance(node, dict):
            return "whatsapp.connection.disconnect_decision"
    instance = payload.get("instance")
    if not isinstance(instance, dict) or not isinstance(instance.get("name"), str):
        return "instance.name"
    return None


def verify_private_health(
    http_status: Optional[int],
    body: str,
    *,
    now_ms: int,
    expected_instance: Optional[str] = None,
    max_age_seconds: float = DEFAULT_PRIVATE_HEALTH_MAX_AGE_SECONDS,
    max_future_skew_seconds: float = DEFAULT_PRIVATE_HEALTH_MAX_FUTURE_SKEW_SECONDS,
) -> dict:
    """Verify one authenticated response. Assumes a token was sent.

    Returns a content-free verdict: ``verified``, ``outcome``,
    ``diagnostic_code`` (``PRIVATE_HEALTH_UNVERIFIED`` unless verified),
    ``http_status``, ``service_status`` (the body's own status, only once the
    body is verified), ``disconnect_classification`` and ``generated_at_ms``.
    """
    verdict: dict = {
        "verified": False,
        "outcome": "malformed_json",
        "diagnostic_code": PRIVATE_HEALTH_UNVERIFIED,
        "http_status": http_status,
        "service_status": None,
        "disconnect_classification": None,
        "generated_at_ms": None,
        "problem": None,
    }
    try:
        payload: Any = json.loads(body)
    except (TypeError, ValueError):
        return verdict
    if not isinstance(payload, dict):
        verdict["outcome"] = "malformed_json"
        return verdict
    if is_public_envelope(payload):
        # A token was sent and the server still answered with the public
        # envelope: the token was rejected (or the route fell back).
        verdict["outcome"] = "public_fallback"
        return verdict
    if classify_projection(payload, token_sent=True) != "diagnostic":
        verdict["outcome"] = "schema_invalid"
        verdict["problem"] = "projection"
        return verdict
    schema = payload.get("schema_version")
    if schema is not None and not isinstance(schema, str):
        verdict["outcome"] = "schema_invalid"
        verdict["problem"] = "schema_version"
        return verdict
    status = payload.get("status")
    if not isinstance(status, str) or status not in PRIVATE_HEALTH_STATUSES:
        verdict["outcome"] = "schema_invalid"
        verdict["problem"] = "status"
        return verdict
    problem = _private_shape_problem(payload)
    if problem is not None:
        verdict["outcome"] = "schema_invalid"
        verdict["problem"] = problem
        return verdict
    expected_http = 503 if status == "unhealthy" else 200
    if http_status != expected_http:
        verdict["outcome"] = "http_status_mismatch"
        return verdict
    generated_at_ms = _parse_generated_at_ms(payload.get("generated_at"))
    if generated_at_ms is None:
        verdict["outcome"] = "schema_invalid"
        verdict["problem"] = "generated_at"
        return verdict
    verdict["generated_at_ms"] = generated_at_ms
    age_ms = now_ms - generated_at_ms
    if age_ms > max_age_seconds * 1000:
        verdict["outcome"] = "stale"
        return verdict
    if age_ms < -max_future_skew_seconds * 1000:
        verdict["outcome"] = "future_skew"
        return verdict
    if expected_instance is not None and payload["instance"]["name"] != expected_instance:
        verdict["outcome"] = "identity_mismatch"
        return verdict
    kind, classification = disconnect_decision_reading(payload["whatsapp"]["connection"])
    verdict.update({
        "verified": True,
        "outcome": "verified",
        "diagnostic_code": None,
        "service_status": status,
        "disconnect_classification": classification if kind == "classified" else kind,
    })
    return verdict


def read_private_health(
    name: str,
    port: int,
    *,
    now_ms: Optional[int] = None,
    fetch: Optional[Callable[[str, dict], tuple[int, str]]] = None,
    max_age_seconds: float = DEFAULT_PRIVATE_HEALTH_MAX_AGE_SECONDS,
    max_future_skew_seconds: float = DEFAULT_PRIVATE_HEALTH_MAX_FUTURE_SKEW_SECONDS,
) -> dict:
    """Resolve the token on this host, read /health with it, verify the body.

    The token is resolved locally (env / tokens.env), sent only as a header on
    the loopback request, and never returned, logged or put in argv. Outcomes
    before a body exists: ``token_unresolved``, ``timeout``,
    ``transport_error``; after: see :func:`verify_private_health`.
    """
    import time

    unverified = {
        "verified": False,
        "diagnostic_code": PRIVATE_HEALTH_UNVERIFIED,
        "http_status": None,
        "service_status": None,
        "disconnect_classification": None,
        "generated_at_ms": None,
        "problem": None,
    }
    try:
        token = instance_health_token(name)
    except Exception:
        token = None
    if not token:
        return {**unverified, "outcome": "token_unresolved"}
    url = f"http://127.0.0.1:{port}/health"
    headers = {"Authorization": f"Bearer {token}"}
    fetcher = fetch or _default_fetch
    try:
        http_status, body = fetcher(url, headers)
    except HealthTransportError as exc:
        return {**unverified, "outcome": "timeout" if exc.timed_out else "transport_error"}
    except TimeoutError:
        return {**unverified, "outcome": "timeout"}
    except Exception:
        return {**unverified, "outcome": "transport_error"}
    current_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    return verify_private_health(
        http_status,
        body,
        now_ms=current_ms,
        expected_instance=name,
        max_age_seconds=max_age_seconds,
        max_future_skew_seconds=max_future_skew_seconds,
    )
