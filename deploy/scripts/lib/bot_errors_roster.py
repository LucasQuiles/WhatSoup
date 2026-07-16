"""Shared fleet-roster identity and inventory for the central sentinel heartbeat
and the independent heartbeat watchdog.

Both the producer (``bot-errors-sentinel.py``) and the checker
(``bot-errors-heartbeat-watchdog.py``) derive the roster digest, epoch, and
expected counts from THIS module. Because the digest is a deterministic function
of roster membership/topology, the watchdog can recompute the expectation
directly from disk and compare it against the value the sentinel declared. A
sentinel launched with the wrong manifest path, a stale checkout, or a truncated
roster therefore produces a digest and count that no longer match the intended
roster, which the watchdog rejects as not-green.

The digest is a SHA-256 over a normalized projection of the roster, so it is
privacy-safe (an opaque hash reveals no host identifiers) and stable against
cosmetic edits (e.g. the ``description`` field) that do not change membership.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Optional


class RosterError(RuntimeError):
    """Raised when the roster cannot be read or is structurally invalid.

    Callers treat this as fail-closed: a roster that cannot be independently
    loaded must not be silently trusted.
    """


def _repo_root() -> Path:
    # lib/bot_errors_roster.py -> lib -> scripts -> deploy -> <repo root>
    return Path(__file__).resolve().parents[3]


def default_roster_path() -> Path:
    """Resolve the intended roster path.

    Defaults to the canonical public SSOT committed in the repo. An operator may
    point both the sentinel and the watchdog at a private roster via
    ``BOT_ERRORS_FLEET_SENTINEL_HOSTS``; the independence of the check comes from
    each side re-deriving the digest from disk, not from using different paths.
    """
    raw = os.environ.get("BOT_ERRORS_FLEET_SENTINEL_HOSTS", "").strip()
    if raw:
        return Path(raw).expanduser()
    return _repo_root() / "deploy" / "bot-errors-expected-fleet.json"


def _is_runtime_relevant(expected: str) -> bool:
    return expected.strip() != "none"


def roster_identity(data: Any) -> dict:
    """Normalized, membership/topology-only projection used for the digest.

    Only the fields that define *what* the fleet is (hosts, their role, whether
    they are a collector remote, and their runtime instances) are included, so
    cosmetic edits do not manufacture false drift. Hosts and instances are sorted
    to make the projection order-independent.
    """
    if not isinstance(data, dict):
        raise RosterError("roster must be a JSON object")
    hosts = data.get("hosts")
    if not isinstance(hosts, list):
        raise RosterError("roster hosts must be a list")
    projected: list[dict] = []
    for item in hosts:
        if not isinstance(item, dict):
            raise RosterError("roster host entries must be objects")
        host = str(item.get("host") or "").strip()
        if not host:
            raise RosterError("roster host entry missing host")
        instances: list[dict] = []
        raw_instances = item.get("instances")
        if isinstance(raw_instances, list):
            for inst in raw_instances:
                if not isinstance(inst, dict):
                    continue
                instances.append(
                    {
                        "name": str(inst.get("name") or inst.get("service") or "").strip(),
                        "service": str(inst.get("service") or "").strip(),
                        "expected": str(inst.get("expected") or "").strip(),
                    }
                )
        instances.sort(key=lambda entry: (entry["name"], entry["service"], entry["expected"]))
        projected.append(
            {
                "host": host,
                "role": str(item.get("role") or "").strip(),
                "collectorRemote": bool(item.get("collectorRemote")),
                "instances": instances,
            }
        )
    projected.sort(key=lambda entry: entry["host"])
    return {"schemaVersion": data.get("schemaVersion"), "hosts": projected}


def roster_digest(data: Any) -> str:
    identity = roster_identity(data)
    material = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def roster_inventory(data: Any) -> dict:
    """Expected inventory derived from the roster.

    Runtime-relevant instances exclude rows explicitly declared ``expected:
    none`` (e.g. a relay-only host that runs no bot). ``runtimeInstancesByHost``
    lets a consumer attribute runtime-instance coverage to a host's observed
    signal.
    """
    identity = roster_identity(data)
    hosts = identity["hosts"]
    expected_hosts = [host["host"] for host in hosts]
    runtime_by_host: dict[str, int] = {}
    runtime_total = 0
    for host in hosts:
        count = sum(1 for inst in host["instances"] if _is_runtime_relevant(inst["expected"]))
        if count:
            runtime_by_host[host["host"]] = count
            runtime_total += count
    collector_remotes = sorted(host["host"] for host in hosts if host["collectorRemote"])
    return {
        "digest": roster_digest(data),
        "expectedHosts": expected_hosts,
        "expectedHostCount": len(expected_hosts),
        "expectedInstanceCount": runtime_total,
        "runtimeInstancesByHost": runtime_by_host,
        "collectorRemoteHosts": collector_remotes,
        "collectorRemoteHostCount": len(collector_remotes),
    }


def load_roster(path: Optional[Path] = None) -> tuple[dict, dict]:
    """Return ``(raw_data, inventory)`` for the roster at ``path``.

    Raises :class:`RosterError` on any read/parse/structure fault so callers can
    fail closed rather than trust an unreadable roster.
    """
    resolved = Path(path) if path is not None else default_roster_path()
    try:
        text = resolved.read_text(encoding="utf-8")
    except OSError as exc:
        raise RosterError(f"cannot read roster {resolved}: {type(exc).__name__}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RosterError(f"invalid roster JSON {resolved}: {exc}") from exc
    if not isinstance(data, dict):
        raise RosterError(f"roster must be a JSON object: {resolved}")
    return data, roster_inventory(data)


def roster_epoch(path: Optional[Path] = None) -> Optional[int]:
    """Inventory epoch bound to the roster: the roster file mtime (int seconds).

    Returns ``None`` when the file cannot be stat'd, so a missing epoch is
    explicit rather than silently zero.
    """
    resolved = Path(path) if path is not None else default_roster_path()
    try:
        return int(resolved.stat().st_mtime)
    except OSError:
        return None
