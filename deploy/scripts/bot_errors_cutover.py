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
that validates and repairs both files in a single call. Validation fails before
either file is touched. Each publication is durability-proven before the next
step; if the second publication cannot be proven, the raised ``CutoverError``
explicitly reports that the two surfaces may be divergent.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any, Callable, NamedTuple


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.durable_json import (  # noqa: E402
    DurableWriteError,
    durable_json_target,
    observe_json,
    operation_id,
    publish_state_json,
    require_advance,
    require_all_advance,
)


class CutoverError(RuntimeError):
    """Raised when a blocked->always_on cutover repair cannot proceed safely.

    Validation errors occur before either surface is written. Publication
    errors identify whether a proven first publication may have left the
    surfaces divergent, so callers cannot mistake a partial repair for success.
    """


# The only two `expected` values this writer will operate on. Anything else
# (`none`, or a future value) is left untouched -- only blocked->always_on
# is a legal transition.
_LEGAL_EXPECTED_STATES = {"blocked", "always_on"}


def _durable_target(path: Path):
    try:
        parent = path.parent
        parent.lstat()
    except OSError as exc:
        raise CutoverError(f"cannot inspect cutover parent {path.parent}: {exc}") from exc
    if parent.is_symlink() or not parent.is_dir():
        raise CutoverError(f"unsafe cutover parent: {parent}")
    return durable_json_target(
        trusted_root=parent.resolve(strict=True),
        relative_path=path.name,
        owner_controlled_readable=True,
    )


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
    if Path(str(profile_filename)).name != str(profile_filename):
        raise CutoverError(f"host {host!r} has unsafe profile filename")
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

    inventory_target = _durable_target(inventory_path)
    inventory_observation = observe_json(inventory_target)
    inventory_operation = operation_id(
        inventory_target,
        inventory,
        component="cutover.inventory_state",
        predecessor=inventory_observation.version,
    )
    inventory_publication = publish_state_json(
        inventory_target,
        inventory,
        component="cutover.inventory_state",
        operation_id=inventory_operation,
        expected=inventory_observation.version,
        generation=(inventory_observation.version.generation or 0) + 1,
    )
    require_advance(inventory_publication)

    profile_target = _durable_target(profile_path)
    profile_observation = observe_json(profile_target)
    profile_operation = operation_id(
        profile_target,
        profile,
        component="cutover.profile_state",
        predecessor=profile_observation.version,
    )
    profile_publication = publish_state_json(
        profile_target,
        profile,
        component="cutover.profile_state",
        operation_id=profile_operation,
        expected=profile_observation.version,
        generation=(profile_observation.version.generation or 0) + 1,
    )
    try:
        require_all_advance([inventory_publication, profile_publication])
    except DurableWriteError as exc:
        raise CutoverError(
            "inventory publication advanced but profile publication did not; "
            "cutover surfaces may be divergent"
        ) from exc

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
