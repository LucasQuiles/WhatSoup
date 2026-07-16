"""Canonical BOT ERRORS monitoring-policy contract (issue #1874).

Single source of truth for the ``guiSessionExpected`` policy vocabulary declared
in ``deploy/bot-errors-expected-fleet.json`` and, for each policy value, its
intended disposition across the four monitors (GUI-session, collector, sentinel,
daily-health). Consolidating the vocabulary here means the monitors cannot drift
on which values are legal or on what ``best_effort`` means.

WHY THIS LIVES UNDER tests/support (not deploy/scripts/lib)
-----------------------------------------------------------
The deployed monitors are integrity-pinned by an explicit per-file manifest
(``deploy/bot-errors-runtime-manifest.json`` + ``whatsoup-bot-errors-deploy.sh``).
A new module under ``deploy/scripts/`` or ``deploy/scripts/lib/`` would require a
manifest+deploy.sh entry — and those files are policed/contested. This module is
imported only by tests, so it is a test-support CONTRACT, not deployed runtime
code, and needs no manifest entry.

SCOPE — declared vs enforced
----------------------------
Only the GUI-session monitor consumes ``guiSessionExpected`` at runtime. It keeps
its OWN local copy of the vocabulary (``KNOWN_GUI_SESSION_POLICIES`` /
``_EXCLUDING_POLICIES`` in ``bot-errors-gui-session-monitor.py``) — NOT a runtime
import of this module — and a drift-guard test
(``test_gui_vocabulary_matches_policy_ssot``) asserts the two stay identical, so
they cannot silently diverge. The collector, sentinel, and daily-health monitors
derive their "expected-intermittent" notion from SEPARATE signals, NOT from
``guiSessionExpected``:

  - collector  -> host-keyed ``--best-effort-remote`` CLI axis (info-tier gate),
                  and the manifest's per-host ``collectorRemote`` flag;
  - sentinel   -> ``load_hosts`` reads host/role/paths only (no policy field);
  - daily-health -> ``BOT_ERRORS_DAILY_HEALTH_OPTIONAL_HOSTS`` + collector state
                  (``bot-errors-heartbeat-watchdog.py``), consumed by the
                  ``bot-errors-health-check.py`` script.

Their entries in ``DISPOSITIONS`` therefore record the DECLARED intent
(documented, testable) so ``best_effort`` has one defined meaning in one place.
Wiring those monitors onto the manifest policy would re-architect three separate
axes and is intentionally out of scope for this module — the disposition fields
document the contract; they do not gate those monitors at runtime.
"""
from __future__ import annotations

from dataclasses import dataclass

# --- Policy vocabulary (the ``guiSessionExpected`` enum) --------------------
POLICY_ALWAYS_AQUA = "always_aqua"        # GUI LaunchAgent must hold an Aqua session -> monitor
POLICY_HEADLESS_OK = "headless_ok"        # headless / on_demand, no Aqua session -> GUI-excluded
POLICY_NOT_APPLICABLE = "not_applicable"  # systemd / no-bot / blocked -> GUI-excluded
POLICY_BEST_EFFORT = "best_effort"        # intentionally intermittent (expected-sleeping) -> GUI-excluded

KNOWN_GUI_SESSION_POLICIES = frozenset(
    {POLICY_ALWAYS_AQUA, POLICY_HEADLESS_OK, POLICY_NOT_APPLICABLE, POLICY_BEST_EFFORT}
)

# Declared policies that explicitly EXCLUDE a target from GUI-session monitoring
# (an auditable decision in the SSOT, not an implicit label-shape guess).
_EXCLUDING_POLICIES = (POLICY_HEADLESS_OK, POLICY_NOT_APPLICABLE, POLICY_BEST_EFFORT)

# --- Per-monitor disposition tokens ----------------------------------------
GUI_MONITOR = "monitor"
GUI_EXCLUDE = "exclude"
COLLECTOR_REMOTE_PROBE = "remote_probe"
COLLECTOR_EXCLUDE = "exclude"
SENTINEL_ACTIVE = "active"
SENTINEL_EXPECTED_INTERMITTENT = "expected_intermittent"
DAILY_HEALTH_REQUIRED = "required"
DAILY_HEALTH_OPTIONAL = "optional"


@dataclass(frozen=True)
class PolicyDisposition:
    """How one ``guiSessionExpected`` policy is treated by each monitor.

    ``gui_session`` is ENFORCED (the GUI monitor imports the vocabulary and acts
    on it). ``collector`` / ``sentinel`` / ``daily_health`` are DECLARED intent:
    those monitors read separate signals today (see the module docstring), so
    these fields document the canonical meaning and back the consistency tests
    rather than gating those monitors at runtime.
    """

    gui_session: str
    collector: str
    sentinel: str
    daily_health: str
    description: str


DISPOSITIONS: dict[str, PolicyDisposition] = {
    POLICY_ALWAYS_AQUA: PolicyDisposition(
        gui_session=GUI_MONITOR,
        collector=COLLECTOR_REMOTE_PROBE,
        sentinel=SENTINEL_ACTIVE,
        daily_health=DAILY_HEALTH_REQUIRED,
        description="GUI LaunchAgent that must hold an Aqua session; fully monitored.",
    ),
    POLICY_HEADLESS_OK: PolicyDisposition(
        gui_session=GUI_EXCLUDE,
        collector=COLLECTOR_REMOTE_PROBE,
        sentinel=SENTINEL_ACTIVE,
        daily_health=DAILY_HEALTH_REQUIRED,
        description=(
            "Headless / on_demand host: no Aqua session expected, so excluded from "
            "GUI-session monitoring, but still an active collector/relay and daily-health "
            "target (per-axis, NOT a blanket exclude)."
        ),
    ),
    POLICY_NOT_APPLICABLE: PolicyDisposition(
        gui_session=GUI_EXCLUDE,
        collector=COLLECTOR_REMOTE_PROBE,
        sentinel=SENTINEL_ACTIVE,
        daily_health=DAILY_HEALTH_REQUIRED,
        description="systemd / no-bot / blocked entry: not a GUI-session target.",
    ),
    POLICY_BEST_EFFORT: PolicyDisposition(
        gui_session=GUI_EXCLUDE,
        collector=COLLECTOR_EXCLUDE,
        sentinel=SENTINEL_EXPECTED_INTERMITTENT,
        daily_health=DAILY_HEALTH_OPTIONAL,
        description=(
            "Intentionally intermittent (expected-sleeping) host: excluded from "
            "GUI-session monitoring, not remotely probed by the collector "
            "(collectorRemote:false), treated as expected-intermittent by the sentinel, "
            "and optional for daily-health so its absence never pages."
        ),
    ),
}


def is_known(value: object) -> bool:
    """True when ``value`` is a recognized policy string."""
    return isinstance(value, str) and value.strip() in KNOWN_GUI_SESSION_POLICIES


def disposition_for(policy: object) -> PolicyDisposition | None:
    """Return the disposition for a known policy value, else ``None``."""
    if not isinstance(policy, str):
        return None
    return DISPOSITIONS.get(policy.strip())


def gui_session_excluded(policy: object) -> bool:
    """True when a KNOWN policy explicitly excludes a target from GUI monitoring."""
    return isinstance(policy, str) and policy.strip() in _EXCLUDING_POLICIES


def _clean(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def best_effort_collector_consistency_errors(fleet: dict) -> list[dict]:
    """Cross-monitor consistency: a best_effort host must not be an active collector remote.

    A host declared ``guiSessionExpected: best_effort`` is intentionally
    intermittent; the collector's remote-probe path and the GUI-session monitor
    must AGREE that it is excluded. The manifest expresses the collector side via
    ``collectorRemote: false``. This PURE function reports any best_effort host
    that is still ``collectorRemote: true`` — the two monitors would then disagree
    about the same declared policy (the #1874 class of drift).

    Report-only (returns offenders), deliberately NOT an arm-time gate: the
    collector's info-tier is host-keyed and independent of ``collectorRemote``, so
    a future best_effort + collectorRemote:true host could be legitimate. Callers
    decide how loudly to surface it. Each offender: ``{"host", "collectorRemote"}``.
    """
    offenders: list[dict] = []
    hosts = fleet.get("hosts")
    if not isinstance(hosts, list):
        return offenders
    for host_entry in hosts:
        if not isinstance(host_entry, dict):
            continue
        if _clean(host_entry.get("guiSessionExpected")) != POLICY_BEST_EFFORT:
            continue
        if host_entry.get("collectorRemote") is True:
            offenders.append(
                {"host": _clean(host_entry.get("host")) or "<unnamed-host>", "collectorRemote": True}
            )
    return offenders
