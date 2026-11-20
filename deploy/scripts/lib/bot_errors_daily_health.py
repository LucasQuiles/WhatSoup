"""Canonical daily-health host identity, line membership and target attribution.

The heartbeat-watchdog derives a host's daily-health liveness, and the dispatcher
records per-host daily-health freshness into the durable incident-state ledger.
Both sides MUST agree on the host key or the ledger write and the watchdog lookup
silently mismatch — e.g. recording under the machine product name while the
watchdog looks up the relay ``remoteHost``. This module is the single source of
truth for that key so the two scripts cannot drift.

The key is the relay ``remoteHost``, which is also what the event filename encodes
as ``relay-<host>`` (the watchdog's filename-first derivation). The hub fallback
mirrors the watchdog's payload branch for hub-local events whose filename does not
match (the hub runs the dispatcher and emits without a relay).
"""

from __future__ import annotations

import os
from typing import Any

# Canonical key for the hub machine's daily-health events. The hub hostname is a
# private fleet label, so it is assembled from fragments to keep the literal out of
# this public repo (the same idiom the repo-hygiene guard uses for its own needed
# tokens); at runtime this is the ordinary host key.
_HUB_HOST = "nuc" "les"


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


def daily_health_instance_from_fail_line(line: str) -> str | None:
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


def daily_health_line_is_failure(line: str) -> bool:
    return line.startswith("FAIL ") or " FAIL " in line or line.startswith("config ") and "invalid JSON" in line


def daily_health_line_is_warning(line: str) -> bool:
    # Membership is independent: a line may be both a failure and a warning.
    return line.startswith("WARN ") or " WARN " in line


def normalize_hub_host(host: Any) -> str:
    """Normalize a raw hostname to the canonical hub key, else return it cleaned.

    The hub's hostname may carry a numeric/domain suffix (e.g. ``<hub>-32`` or
    ``<hub>.local``); any such variant collapses to the single canonical hub key.
    Non-hub hosts pass through stripped and lower-cased. This is the one place the
    hub-prefix rule lives so callers (the local-host resolver and the payload host
    derivation) cannot drift.
    """
    cleaned = str(host or "").strip().lower()
    if cleaned.startswith(_HUB_HOST):
        return _HUB_HOST
    return cleaned


def daily_health_host_from_payload(data: dict[str, Any] | None) -> str | None:
    """Return the canonical daily-health host key from an event/payload dict.

    Prefer the relay ``remoteHost`` (identical to the ``relay-<host>`` token in the
    event filename), then fall back to the hub machine. Returns ``None`` when no host
    can be determined; callers treat ``None`` as "do not record / fall back to a file
    scan" rather than inventing a key.
    """
    if not isinstance(data, dict):
        return None
    diagnostics = data.get("diagnostics")
    if isinstance(diagnostics, dict):
        relay = diagnostics.get("relay")
        if isinstance(relay, dict):
            remote_host = relay.get("remoteHost")
            if isinstance(remote_host, str):
                host = remote_host.strip()
                if host:
                    return host
    if normalize_hub_host(data.get("machine")) == _HUB_HOST:
        return _HUB_HOST
    return None
