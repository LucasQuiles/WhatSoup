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
from typing import Any, Callable, NamedTuple


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


class GateResult(NamedTuple):
    """Outcome of ``cutover_gate``: ``ok`` plus an itemized ``failures`` list.

    ``failures`` is empty whenever ``ok`` is ``True`` -- either every surface
    genuinely agrees the cutover is complete, or the live probe reports the
    instance is not currently active+healthy (nothing to false-alert on).
    """

    ok: bool
    failures: list[str]


LiveProbe = Callable[[str, str], dict[str, Any]]


def cutover_gate(
    host: str,
    name: str,
    *,
    inventory_path: Path,
    profiles_dir: Path,
    live_probe: LiveProbe,
) -> GateResult:
    """Fail-closed post-cutover CHECK for ``host``/``name`` (#1866 Task 2).

    This is a read-only CHECK, not a repair -- see
    ``restore_service_to_always_on`` above for the writer. It never mutates
    either surface and never adds heuristics to the monitors; it only
    reports whether a cutover that ``live_probe`` says is actually live
    (``active`` and ``healthy``) is ACTUALLY visible to every surface
    monitoring reads. Fail-closed by construction: any exception while
    reading the inventory, the deployed profile, or calling ``live_probe``
    is caught and reported as ``ok=False`` -- this function never raises.

    If ``live_probe(host, name)`` reports the instance is not currently
    both ``active`` and ``healthy``, the instance is treated as genuinely
    blocked (never restored, or restored but not yet up): ``ok=True`` with
    no failures, since a stale "blocked" reading on either surface is
    expected in that state, not a false alert.

    When the probe reports active+healthy, ALL FOUR of the following must
    agree the cutover is complete, else ``ok=False`` with one itemized
    failure string per disagreement:
      1. the checked-in inventory instance's ``expected`` is ``"always_on"``,
      2. the deployed profile instance's ``expected`` is ``"always_on"``,
      3. ``healthPort`` metadata is present on BOTH surfaces, and
      4. the instance passes the real monitor membership predicate.

    Check 4 mirrors ``expected_local_instances()`` in
    bot-errors-heartbeat-watchdog.py:706-730 -- specifically its filter at
    line ~720, ``if expected != "always_on" or not service: continue`` --
    applied here against the profile instance data already read for checks
    2/3, rather than calling that function directly: it always resolves the
    LIVE local host's profile path via ``canonical_local_host()``, not the
    ``host`` argument passed to this gate. This is the ONE place in this
    module that encodes that predicate.
    """
    try:
        inventory_path = Path(inventory_path)
        profiles_dir = Path(profiles_dir)

        inventory = _load_json(inventory_path, what="inventory")
        host_entry = _find_host(inventory, host)
        inv_instance = _find_instance(host_entry, name, where=f"inventory host {host!r}")

        profile_filename = host_entry.get("profile")
        if not profile_filename:
            raise CutoverError(f"host {host!r} has no 'profile' filename in inventory")
        profile_path = profiles_dir / profile_filename

        profile = _load_json(profile_path, what="profile")
        profile_instance = _find_instance(profile, name, where=f"profile {profile_path}")

        probe = live_probe(host, name)
        active = bool(probe.get("active"))
        healthy = bool(probe.get("healthy"))
    except Exception as exc:  # fail-closed: any read/probe error -> ok=False
        return GateResult(
            ok=False, failures=[f"{host}/{name}: gate read error: {exc}"]
        )

    if not (active and healthy):
        # Genuinely blocked (or restored but not yet up) -- not currently
        # claiming to be live, so a stale "blocked" reading elsewhere is
        # expected, not a false alert.
        return GateResult(ok=True, failures=[])

    failures: list[str] = []

    inv_expected = inv_instance.get("expected")
    if inv_expected != "always_on":
        failures.append(
            f"{host}/{name}: inventory expected={inv_expected!r}, want 'always_on'"
        )

    profile_expected = profile_instance.get("expected")
    if profile_expected != "always_on":
        failures.append(
            f"{host}/{name}: profile ({profile_path}) expected={profile_expected!r}, "
            "want 'always_on'"
        )

    inv_health_port = inv_instance.get("healthPort")
    profile_health_port = profile_instance.get("healthPort")
    if inv_health_port is None or profile_health_port is None:
        failures.append(
            f"{host}/{name}: healthPort missing -- inventory={inv_health_port!r}, "
            f"profile={profile_health_port!r}"
        )

    # Monitor membership predicate -- see docstring above for exactly which
    # watchdog line this mirrors and why it is applied here instead of
    # calling that function directly.
    member_expected = str(profile_instance.get("expected") or "").strip()
    member_service = str(profile_instance.get("service") or "").strip()
    if member_expected != "always_on" or not member_service:
        failures.append(
            f"{host}/{name}: monitor membership check failed -- expected="
            f"{member_expected!r} service={member_service!r} (monitor requires "
            "expected=='always_on' and a non-empty service)"
        )

    return GateResult(ok=not failures, failures=failures)
