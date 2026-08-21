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
import os
from pathlib import Path
from typing import Any, Callable, Optional

PUBLIC_HEALTH_SCHEMA_PREFIX = "health.public."

_DEFAULT_TIMEOUT_SECONDS = 5


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
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen

    req = Request(url, method="GET", headers=headers)
    try:
        with urlopen(req, timeout=_DEFAULT_TIMEOUT_SECONDS) as response:
            return int(response.status), response.read(64 * 1024).decode("utf-8", errors="replace")
    except HTTPError as exc:
        return int(exc.code), exc.read(64 * 1024).decode("utf-8", errors="replace")


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
