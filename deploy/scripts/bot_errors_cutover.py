#!/usr/bin/env python3
"""Authoritative writer for repairing a fleet service's cutover declaration.

A restored fleet service can stay declared ``expected: "blocked"`` in two
independent JSON surfaces even after it comes back up:

- the checked-in inventory, ``deploy/bot-errors-expected-fleet.json``
  (``hosts[].instances[]``), and
- the deployed per-host profile, ``deploy/health-profiles/<host>.json``
  (its own ``instances[]``), whose filename is the inventory host's
  ``profile`` field.

Monitoring reads both, so repairing only one leaves the service hidden from
monitoring via the other. ``restore_service_to_always_on`` is the ONE writer
that repairs both files in a single call -- it never edits one without the
other -- and is fail-closed: an absent instance, an illegal ``expected``
transition, or an unresolvable ``healthPort`` raises ``CutoverError`` before
either file is touched.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent

# `atomic_write_json` (temp file in the same directory, fsync the file,
# atomic rename, fsync the parent directory) lives in
# bot-errors-heartbeat-watchdog.py. That filename has hyphens, so it cannot
# be imported as a normal module; load it via importlib instead of forking
# its write semantics. This mirrors the existing test convention in
# tests/test_bot_errors_heartbeat_watchdog_roster.py, which loads the same
# file the same way to reach `atomic_write_json`.
_WATCHDOG_PATH = SCRIPT_DIR / "bot-errors-heartbeat-watchdog.py"


def _load_watchdog_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog_for_cutover", _WATCHDOG_PATH
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load watchdog module from {_WATCHDOG_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


atomic_write_json = _load_watchdog_module().atomic_write_json


class CutoverError(RuntimeError):
    """Raised when a blocked->always_on cutover repair cannot proceed safely.

    Fail-closed: callers must treat this as "no write happened to either
    surface" -- an absent instance, an illegal ``expected`` transition, or an
    unresolvable ``healthPort`` is caught before any ``atomic_write_json``
    call, so the inventory and the deployed profile are never left
    diverging from each other.
    """


# The only two `expected` values this writer will operate on. Anything else
# (`none`, or a future value) is left untouched -- only blocked->always_on
# is a legal transition.
_LEGAL_EXPECTED_STATES = {"blocked", "always_on"}


def _load_json(path: Path, *, what: str) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CutoverError(f"cannot read {what} {path}: {exc}") from exc
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise CutoverError(f"cannot parse {what} {path} as JSON: {exc}") from exc


def _find_host(inventory: dict[str, Any], host: str) -> dict[str, Any]:
    for entry in inventory.get("hosts", []):
        if entry.get("host") == host:
            return entry
    raise CutoverError(f"host {host!r} not found in inventory")


def _find_instance(container: dict[str, Any], name: str, *, where: str) -> dict[str, Any]:
    for inst in container.get("instances", []):
        if inst.get("name") == name:
            return inst
    raise CutoverError(f"instance {name!r} not found in {where}")


def restore_service_to_always_on(
    host: str,
    name: str,
    *,
    inventory_path: Path,
    profiles_dir: Path,
) -> dict[str, Any]:
    """Flip ``host``/``name`` from ``blocked`` to ``always_on`` in both
    the checked-in inventory and the deployed per-host profile, in one call.

    Returns ``{host, name, healthPort, inventoryRepaired, profileRepaired}``
    where ``inventoryRepaired``/``profileRepaired`` report whether that
    surface's ``expected`` was actually ``"blocked"`` (and so was flipped)
    versus already ``"always_on"``.

    Raises ``CutoverError`` -- before writing anything -- if:
    - the host or the named instance is absent from either surface,
    - either the inventory instance's or the profile instance's ``expected``
      is not in ``{"blocked", "always_on"}`` (only blocked->always_on is
      legal, on EITHER surface), or
    - ``healthPort`` is missing from both surfaces and cannot be sourced.
    """
    inventory_path = Path(inventory_path)
    profiles_dir = Path(profiles_dir)

    inventory = _load_json(inventory_path, what="inventory")
    host_entry = _find_host(inventory, host)
    inv_instance = _find_instance(host_entry, name, where=f"inventory host {host!r}")

    inv_expected = inv_instance.get("expected")
    if inv_expected not in _LEGAL_EXPECTED_STATES:
        raise CutoverError(
            f"{host}/{name}: expected={inv_expected!r} is not a legal "
            "blocked->always_on transition"
        )

    profile_filename = host_entry.get("profile")
    if not profile_filename:
        raise CutoverError(f"host {host!r} has no 'profile' filename in inventory")
    profile_path = profiles_dir / profile_filename

    profile = _load_json(profile_path, what="profile")
    profile_instance = _find_instance(profile, name, where=f"profile {profile_path}")

    profile_expected = profile_instance.get("expected")
    if profile_expected not in _LEGAL_EXPECTED_STATES:
        raise CutoverError(
            f"{host}/{name}: profile expected={profile_expected!r} is not a "
            "legal blocked->always_on transition"
        )

    health_port = inv_instance.get("healthPort")
    if health_port is None:
        health_port = profile_instance.get("healthPort")
    if health_port is None:
        raise CutoverError(
            f"{host}/{name}: healthPort missing from both the inventory and "
            f"the profile ({profile_path}); cannot repair"
        )

    inventory_repaired = inv_expected == "blocked"
    profile_repaired = profile_expected == "blocked"

    inv_instance["healthPort"] = health_port
    inv_instance["expected"] = "always_on"
    profile_instance["healthPort"] = health_port
    profile_instance["expected"] = "always_on"

    atomic_write_json(inventory_path, inventory)
    atomic_write_json(profile_path, profile)

    return {
        "host": host,
        "name": name,
        "healthPort": health_port,
        "inventoryRepaired": inventory_repaired,
        "profileRepaired": profile_repaired,
    }
