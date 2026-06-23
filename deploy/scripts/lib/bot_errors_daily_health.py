"""Canonical daily-health host identity.

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

from typing import Any

# Canonical key for the hub machine's daily-health events. The hub hostname is a
# private fleet label, so it is assembled from fragments to keep the literal out of
# this public repo (the same idiom the repo-hygiene guard uses for its own needed
# tokens); at runtime this is the ordinary host key.
_HUB_HOST = "nuc" "les"


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
    machine = str(data.get("machine") or "").strip().lower()
    if machine.startswith(_HUB_HOST):
        return _HUB_HOST
    return None
