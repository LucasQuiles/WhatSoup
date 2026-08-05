#!/usr/bin/env python3
"""External (off-GUI) GUI-session monitor for WhatSoup bot LaunchAgents.

The problem this defends against
--------------------------------
WhatSoup bots are per-user macOS GUI LaunchAgents. When a bot's user logs out of
the GUI (e.g. /dev/console owned by root at the login window), the bot drops AND
the in-GUI heartbeat watchdog dies in the same failure, so the outage is silent.

This monitor runs OFF the target host (over SSH) so it survives the bot user's
GUI logout. For each expected GUI-LaunchAgent host it determines the expected
bot user + agent label + uid from the SSOT (deploy/bot-errors-expected-fleet.json
and deploy/health-profiles/*.json), runs two read-only probes, and classifies
the session state:

  - ok                : console owner == bot user AND agent running
  - gui_session_absent: console owner != bot user / no Aqua session
  - agent_unloaded    : Aqua session present but agent not loaded/running
  - unreachable       : probe failed (SSH/transport)
  - inconclusive      : probe returned empty/garbage output (FAIL-CLOSED)

The probes it WOULD run per host (never executed in unit tests):
  ssh <host> stat -f %Su /dev/console                 -> console owner login
  ssh <host> launchctl print gui/<uid>/<label>        -> agent state

FAIL-CLOSED: unknown / empty / timeout / permission-denied probe results are
NEVER classified ``ok`` — they become ``unreachable`` or ``inconclusive``. A
BOT ERRORS event is emitted (via the existing bot-errors-emit.py outbox) for any
non-ok state, only after a configurable consecutive-failure threshold.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.durable_json import (
    durable_json_target,
    observe_json,
    operation_id,
    publish_state_json,
    require_advance,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
EMIT_SCRIPT = SCRIPT_DIR / "bot-errors-emit.py"


# --- classification states -------------------------------------------------

STATE_OK = "ok"
STATE_GUI_SESSION_ABSENT = "gui_session_absent"
STATE_AGENT_UNLOADED = "agent_unloaded"
STATE_UNREACHABLE = "unreachable"
STATE_INCONCLUSIVE = "inconclusive"

STATE_POST_REBOOT_REGRESSION = "post_reboot_regression"

NON_OK_STATES = (
    STATE_GUI_SESSION_ABSENT,
    STATE_AGENT_UNLOADED,
    STATE_UNREACHABLE,
    STATE_INCONCLUSIVE,
    STATE_POST_REBOOT_REGRESSION,
)

# Distilled agent states (the host-iteration layer maps ``launchctl print``
# output into one of these before handing the probe to the classifier).
AGENT_STATE_RUNNING = "running"
AGENT_STATE_NOT_RUNNING = "not_running"  # loaded but not running (e.g. waiting)
AGENT_STATE_UNLOADED = "unloaded"       # ``Could not find service`` -> not loaded
KNOWN_AGENT_STATES = frozenset(
    {AGENT_STATE_RUNNING, AGENT_STATE_NOT_RUNNING, AGENT_STATE_UNLOADED}
)

# Console-owner values that are syntactically plausible login names. ``stat``
# emits a bare username; empty / whitespace / multi-token output is garbage.
_USERNAME_MAX_LEN = 32


def _is_known_console_owner(value: str) -> bool:
    if not value or len(value) > _USERNAME_MAX_LEN:
        return False
    # A real login name is a single shell-safe token (letters, digits, _, -, .).
    return all(ch.isalnum() or ch in "_-." for ch in value)


def _is_known_agent_state(value: str) -> bool:
    return value in KNOWN_AGENT_STATES


def classify_gui_session(*, expected_user, probe) -> str:
    """Classify GUI-session health from injected probe results (PURE).

    ``probe`` is a mapping with keys:
      console_owner : str | None  -- output of ``stat -f %Su /dev/console``
      agent_state   : str | None  -- distilled launchctl agent state
      console_ok    : bool        -- console probe transport succeeded
      agent_ok      : bool        -- agent probe transport succeeded
      error         : str | None  -- transport/error detail (optional)
    """
    console_owner = _norm(probe.get("console_owner"))
    agent_state = _norm(probe.get("agent_state"))
    expected = _norm(expected_user)

    # FAIL-CLOSED #1: an unknown expectation cannot be proven healthy.
    if not expected:
        return STATE_INCONCLUSIVE

    # FAIL-CLOSED #2: any transport failure on either probe is unreachable —
    # never ``ok``, even if the other probe happened to look fine.
    if not probe.get("console_ok", False) or not probe.get("agent_ok", False):
        return STATE_UNREACHABLE

    # FAIL-CLOSED #3: a transport-success probe with empty/garbage payload is
    # inconclusive (e.g. permission denied, truncated output) — never ``ok``.
    if not _is_known_console_owner(console_owner) or not _is_known_agent_state(agent_state):
        return STATE_INCONCLUSIVE

    # GUI session gone: the login-window owns the console (root) or some other
    # user is logged in — the bot user has no Aqua session, so the agent (and
    # its in-GUI watchdog) is dead.
    if console_owner != expected:
        return STATE_GUI_SESSION_ABSENT

    # Session present but the agent is not actually running.
    if agent_state != AGENT_STATE_RUNNING:
        return STATE_AGENT_UNLOADED

    return STATE_OK


def _norm(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


# --- probe-output distillation (raw SSH stdout -> classifier inputs) -------


def distill_console_owner(raw, ok: bool):
    """Distill ``stat -f %Su /dev/console`` stdout into a console-owner login.

    Returns the bare username, or ``None`` when the probe failed (transport)
    or produced empty output — both of which the classifier treats as
    unreachable / inconclusive (fail-closed).
    """
    if not ok:
        return None
    owner = _norm(raw)
    return owner or None


def distill_agent_state(raw, ok: bool):
    """Distill ``launchctl print gui/<uid>/<label>`` stdout into an agent state.

    Returns one of the KNOWN_AGENT_STATES, or ``None`` when the probe failed,
    was empty, or was unrecognizable — fail-closed so the classifier never
    reads such output as ``ok``.
    """
    if not ok:
        return None
    text = _norm(raw)
    if not text:
        return None
    lowered = text.lower()
    # launchctl emits "Could not find service ..." / "Could not find domain ..."
    # when the agent is not loaded or the gui/<uid> Aqua domain is absent.
    if "could not find" in lowered:
        return AGENT_STATE_UNLOADED
    # A printed service block: distinguish running (has pid / state = running)
    # from merely loaded-but-not-running.
    if "= {" in text or "= {\n" in text or text.rstrip().endswith("}"):
        if "state = running" in lowered or _has_live_pid(text):
            return AGENT_STATE_RUNNING
        return AGENT_STATE_NOT_RUNNING
    return None


def _has_live_pid(text: str) -> bool:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("pid ") or stripped.startswith("pid="):
            digits = "".join(ch for ch in stripped if ch.isdigit())
            if digits and int(digits) > 0:
                return True
    return False


def distill_boot_id(raw, ok: bool):
    """Distill a stable boot identifier from a boot-time probe.

    Primary source is macOS ``sysctl -n kern.boottime`` which emits e.g.
    ``{ sec = 1718000000, usec = 123456 } Mon Jun 10 ...``; the ``sec`` value is
    a stable, monotonic-per-boot identifier. A bare integer (e.g. a fallback
    uptime/boot-epoch bucket) is also accepted. Returns the id as a string, or
    ``None`` when the probe failed, was empty, or was unrecognizable —
    fail-closed so the caller can never read garbage as a confirmed boot id.
    """
    if not ok:
        return None
    text = _norm(raw)
    if not text:
        return None
    # `sysctl kern.boottime` form: capture the `sec = <int>` field.
    match = re.search(r"sec\s*=\s*(\d+)", text)
    if match:
        return match.group(1)
    # Fallback: a bare integer boot identifier.
    if text.isdigit():
        return text
    return None


# --- post-reboot regression detection --------------------------------------

# Base states that, when observed right after a confirmed reboot, indicate the
# bot's GUI LaunchAgent failed to come back up (the regression we alert on).
_REBOOT_REGRESSION_BASE_STATES = (STATE_AGENT_UNLOADED, STATE_GUI_SESSION_ABSENT)


def detect_reboot(*, prior_boot_id, current_boot_id) -> bool:
    """Return True only when a reboot is POSITIVELY confirmed.

    A reboot is confirmed when both boot ids are known and differ. A missing
    prior id (first-ever observation) or a missing/garbage current id yields
    False — we never fabricate a reboot from incomplete information.
    """
    prior = _norm(prior_boot_id)
    current = _norm(current_boot_id)
    if not prior or not current:
        return False
    return prior != current


def classify_with_reboot(*, base_state: str, prior_boot_id, current_boot_id) -> str:
    """Promote a post-reboot agent failure to ``post_reboot_regression``.

    When a reboot is positively confirmed AND the GUI agent is now unloaded or
    its session is absent, the agent failed to recover across the reboot — a
    distinct, higher-signal failure than a steady-state drop. Otherwise the base
    classification is returned unchanged (transient unloads stay on the normal
    threshold path; inconclusive/unreachable are never masked).
    """
    if (
        detect_reboot(prior_boot_id=prior_boot_id, current_boot_id=current_boot_id)
        and base_state in _REBOOT_REGRESSION_BASE_STATES
    ):
        return STATE_POST_REBOOT_REGRESSION
    return base_state


# --- emit-decision (consecutive-failure threshold gating) ------------------

DEFAULT_FAILURE_THRESHOLD = 2


def default_failure_threshold() -> int:
    """Configurable consecutive-failure threshold before emitting (default 2).

    Honors BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD; a non-positive or
    unparseable override falls back to the safe default rather than ever
    disabling alerting (fail-closed configuration).
    """
    raw = os.environ.get("BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD", "").strip()
    if not raw:
        return DEFAULT_FAILURE_THRESHOLD
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_FAILURE_THRESHOLD
    return value if value >= 1 else DEFAULT_FAILURE_THRESHOLD


# --- SSOT-driven GUI-LaunchAgent target enumeration -----------------------

# Only macOS GUI LaunchAgents live under gui/<uid>/<label> and depend on an
# Aqua session. Their labels are the reverse-DNS ``com.whatsoup.*`` form.
# systemd .service units (central host) and on_demand/blocked/no-bot entries
# are NOT GUI-session targets.
GUI_LABEL_PREFIX = "com.whatsoup."

# Per-host (or per-instance) session policy declared in the SSOT under the
# ``guiSessionExpected`` key. This is a NON-PII enum — host aliases + a policy
# value only; no OS usernames are stored in committed SSOT (those stay
# live-resolved, see resolve_expected_user).
#
# The CANONICAL definition of this vocabulary + each policy's cross-monitor
# disposition lives in lib/bot_errors_policy.py (the #1874 SSOT). These constants
# are kept local here — NOT imported at runtime — because the deployed monitor is
# packaged by an explicit per-file allowlist (deploy/bot-errors-runtime-manifest
# .json, whatsoup-bot-errors-deploy.sh), so importing a new lib module would add a
# deploy dependency on those manifests. A drift-guard test
# (test_gui_vocabulary_matches_policy_ssot) asserts these values stay byte-identical
# to the SSOT, so the two cannot silently diverge. best_effort is an intentionally-
# intermittent (expected-sleeping) host -> an auditable exclusion, NOT a
# missing/unknown policy that must fail closed.
POLICY_ALWAYS_AQUA = "always_aqua"      # GUI LaunchAgent must have an Aqua session -> monitor
POLICY_HEADLESS_OK = "headless_ok"      # headless/on_demand, no Aqua session -> exclude
POLICY_NOT_APPLICABLE = "not_applicable"  # systemd / no-bot / blocked -> exclude
POLICY_BEST_EFFORT = "best_effort"      # intentionally intermittent (expected-sleeping) host -> exclude
KNOWN_GUI_SESSION_POLICIES = frozenset(
    {POLICY_ALWAYS_AQUA, POLICY_HEADLESS_OK, POLICY_NOT_APPLICABLE, POLICY_BEST_EFFORT}
)
# Declared policies that explicitly EXCLUDE a target from GUI-session monitoring.
_EXCLUDING_POLICIES = (POLICY_HEADLESS_OK, POLICY_NOT_APPLICABLE, POLICY_BEST_EFFORT)

# Public manifests may use sanitized placeholder labels for private hosts. Those
# hosts must declare this marker and provide their live labels via a hub-private
# BOT_ERRORS_EXPECTED_FLEET file outside the repo root before the monitor probes.
PRIVATE_MONITOR_OVERRIDE_REQUIRED_KEY = "privateMonitorOverrideRequired"


def policy_for_target(host_entry: dict, instance: dict):
    """Resolve the declared ``guiSessionExpected`` policy for a host/instance.

    Instance-level policy overrides host-level. Returns one of the
    KNOWN_GUI_SESSION_POLICIES, or ``None`` when no valid policy is declared
    (missing or an unrecognized value). A ``None`` result hands the decision to
    the fail-closed default in ``gui_targets_from_fleet``.
    """
    for source in (instance, host_entry):
        if not isinstance(source, dict):
            continue
        value = _norm(source.get("guiSessionExpected"))
        if value in KNOWN_GUI_SESSION_POLICIES:
            return value
    return None


def unknown_policy_values(fleet: dict) -> list[dict]:
    """Collect declared ``guiSessionExpected`` values that are not recognized.

    A PRESENT-but-unrecognized policy (a typo or a retired enum) is a config
    error: ``policy_for_target`` resolves it to ``None`` and it then silently
    falls through to the fail-closed default in ``gui_targets_from_fleet``,
    changing monitor membership without an auditable SSOT decision (the #1874
    class of defect). A MISSING policy is NOT flagged — absence is the
    intentional fail-closed default, not a typo.

    Returns one record per offending declaration:
    ``{"host": str, "instance": str | None, "value": str}`` (host-level
    declarations carry ``instance=None``). Order is deterministic:
    host-level first, then each instance in declaration order.
    """
    offenders: list[dict] = []
    hosts = fleet.get("hosts")
    if not isinstance(hosts, list):
        return offenders
    for host_entry in hosts:
        if not isinstance(host_entry, dict):
            continue
        host = _norm(host_entry.get("host")) or "<unnamed-host>"
        host_value = _norm(host_entry.get("guiSessionExpected"))
        if host_value and host_value not in KNOWN_GUI_SESSION_POLICIES:
            offenders.append({"host": host, "instance": None, "value": host_value})
        instances = host_entry.get("instances")
        if not isinstance(instances, list):
            continue
        for instance in instances:
            if not isinstance(instance, dict):
                continue
            inst_value = _norm(instance.get("guiSessionExpected"))
            if inst_value and inst_value not in KNOWN_GUI_SESSION_POLICIES:
                offenders.append({
                    "host": host,
                    "instance": _norm(instance.get("name")) or None,
                    "value": inst_value,
                })
    return offenders


def gui_targets_from_fleet(fleet: dict) -> list[dict]:
    """Enumerate GUI-session monitor targets from the expected-fleet SSOT.

    Selection is driven by the declared ``guiSessionExpected`` policy so that
    headless / no-bot / systemd hosts are EXPLICITLY excluded by policy (an
    auditable decision in the SSOT) rather than implicitly by service-label
    shape:

      - policy ``always_aqua``   -> monitored
      - policy ``headless_ok``   -> excluded
      - policy ``not_applicable``-> excluded
      - policy ``best_effort``   -> excluded (intentionally intermittent /
        expected-sleeping host; an auditable exclusion, not a forgotten policy)
      - policy missing/unknown   -> FAIL-CLOSED default: a plausible GUI
        LaunchAgent (``always_on`` + ``com.whatsoup.*`` label) is STILL
        monitored so a profile that forgot the policy is never silently dropped;
        non-LaunchAgent entries (systemd units, on_demand/blocked) remain
        excluded.

    Consumes the SSOT — never a hardcoded host list. Returns dicts with: host,
    instance, label.
    """
    targets: list[dict] = []
    hosts = fleet.get("hosts")
    if not isinstance(hosts, list):
        return targets
    for host_entry in hosts:
        if not isinstance(host_entry, dict):
            continue
        host = _norm(host_entry.get("host"))
        if not host:
            continue
        instances = host_entry.get("instances")
        if not isinstance(instances, list):
            continue
        for instance in instances:
            if not isinstance(instance, dict):
                continue
            policy = policy_for_target(host_entry, instance)
            if policy in _EXCLUDING_POLICIES:
                # Explicit declared exclusion wins over any label shape.
                continue
            if policy == POLICY_ALWAYS_AQUA:
                # Declared GUI agent: trust the policy, still require a usable
                # label to probe.
                label = _norm(instance.get("service"))
                name = _norm(instance.get("name")) or label
                if label:
                    targets.append({"host": host, "instance": name, "label": label})
                continue
            # policy is None (missing/unknown): FAIL-CLOSED default — only a
            # plausible always_on GUI LaunchAgent is monitored.
            if _norm(instance.get("expected")) != "always_on":
                continue
            label = _norm(instance.get("service"))
            if not label.startswith(GUI_LABEL_PREFIX):
                continue
            name = _norm(instance.get("name")) or label
            targets.append({"host": host, "instance": name, "label": label})
    return targets


def private_monitor_override_required_count(fleet: dict) -> int:
    """Count hosts that require a hub-private expected-fleet override.

    This carries no live labels. It lets the public SSOT mark "the checked-in
    labels are sanitized; do not arm from this file" without committing private
    service names.
    """
    hosts = fleet.get("hosts")
    if not isinstance(hosts, list):
        return 0
    return sum(
        1
        for host_entry in hosts
        if isinstance(host_entry, dict)
        and host_entry.get(PRIVATE_MONITOR_OVERRIDE_REQUIRED_KEY) is True
    )


def _path_is_under(path: Path, root: Path) -> bool:
    try:
        return path.expanduser().resolve().is_relative_to(root.resolve())
    except OSError:
        return False


def private_override_contract_error(
    fleet: dict,
    *,
    expected_fleet_override: str | None = None,
) -> str | None:
    """Return a fail-closed config error when a private override is required.

    If any public manifest host declares privateMonitorOverrideRequired, the
    monitor must be launched with BOT_ERRORS_EXPECTED_FLEET pointing to a
    hub-private JSON file outside the repository. Otherwise it would probe
    sanitized placeholder labels and create false health evidence.
    """
    required_count = private_monitor_override_required_count(fleet)
    if required_count == 0:
        return None

    raw_override = (
        os.environ.get("BOT_ERRORS_EXPECTED_FLEET", "")
        if expected_fleet_override is None
        else expected_fleet_override
    )
    override = _norm(raw_override)
    if not override:
        return (
            f"private expected-fleet override required for {required_count} host(s); "
            "set BOT_ERRORS_EXPECTED_FLEET to a hub-private JSON path outside the repo"
        )

    if _path_is_under(Path(override), REPO_ROOT):
        return (
            "BOT_ERRORS_EXPECTED_FLEET must point outside the repo root when "
            "private monitor overrides are required"
        )
    return None


@dataclass(frozen=True)
class EmitDecision:
    should_emit: bool
    reason: str


EMIT_SOURCE = "gui_session_monitor"

# A confirmed logged-out session / unloaded agent is a hard outage; a probe we
# could not complete is a softer (warning) signal pending confirmation.
_STATE_SEVERITY = {
    STATE_GUI_SESSION_ABSENT: "critical",
    STATE_AGENT_UNLOADED: "critical",
    STATE_POST_REBOOT_REGRESSION: "critical",
    STATE_UNREACHABLE: "warning",
    STATE_INCONCLUSIVE: "warning",
}


def build_emit_argv(
    *,
    host: str,
    instance: str,
    label: str,
    state: str,
    consecutive_failures: int,
    threshold: int,
) -> list[str]:
    """Build the argv for bot-errors-emit.py for a non-ok GUI-session state.

    Pure (no subprocess): returns the flag list so the emit path is unit-tested
    without writing to the outbox. Carries only public identifiers (host,
    instance, reverse-DNS label) — no filesystem paths, tokens, or phone
    numbers.
    """
    if state == STATE_OK:
        raise ValueError("build_emit_argv must not be called for an ok state")
    severity = _STATE_SEVERITY.get(state, "warning")
    summary = (
        f"GUI-session monitor: {state} for {instance} on {host} "
        f"(agent {label}); persisted {consecutive_failures} consecutive checks"
    )
    return [
        "--severity", severity,
        "--instance", instance,
        "--source", EMIT_SOURCE,
        "--summary", summary,
        "--diagnostic", f"gui_state={state}",
        "--diagnostic", f"host={host}",
        "--diagnostic", f"agent_label={label}",
        "--diagnostic", f"consecutive_failures={consecutive_failures}",
        "--diagnostic", f"failure_threshold={threshold}",
        "--log-hint", f"ssh {host} stat -f %Su /dev/console",
        "--log-hint", f"ssh {host} launchctl print gui/<uid>/{label}",
    ]


@dataclass(frozen=True)
class TargetOutcome:
    state: str
    new_state: dict
    emit_decision: "EmitDecision"
    emit_argv: "list[str] | None"


def run_target(*, target: dict, expected_user, probe, prior_state, threshold: int) -> TargetOutcome:
    """Classify one target, update its consecutive-failure counter, and decide.

    ``prior_state`` is the persisted per-target record (or None). The returned
    ``new_state`` is what the caller should persist. ``emit_argv`` is populated
    only when the threshold is met for a non-ok state.
    """
    base_state = classify_gui_session(expected_user=expected_user, probe=probe)
    prior = prior_state if isinstance(prior_state, dict) else {}
    prior_count = prior.get("consecutive_failures", 0)
    try:
        prior_count = int(prior_count)
    except (TypeError, ValueError):
        prior_count = 0

    # Boot-aware promotion: an agent failure right after a confirmed reboot is a
    # distinct post_reboot_regression. The current boot id comes from the probe;
    # carry the last known boot id forward when the boot probe failed so we do
    # not lose the reboot baseline (and so we never fabricate a reboot).
    prior_boot_id = prior.get("boot_id")
    current_boot_id = probe.get("boot_id") if isinstance(probe, dict) else None
    state = classify_with_reboot(
        base_state=base_state,
        prior_boot_id=prior_boot_id,
        current_boot_id=current_boot_id,
    )
    persisted_boot_id = current_boot_id if _norm(current_boot_id) else prior_boot_id

    if state == STATE_OK:
        consecutive = 0
    else:
        consecutive = prior_count + 1

    decision = evaluate_emit_decision(
        state=state, consecutive_failures=consecutive, threshold=threshold
    )
    emit_argv = None
    if decision.should_emit:
        emit_argv = build_emit_argv(
            host=str(target.get("host", "")),
            instance=str(target.get("instance", "")),
            label=str(target.get("label", "")),
            state=state,
            consecutive_failures=consecutive,
            threshold=threshold,
        )
    new_state = {
        "consecutive_failures": consecutive,
        "last_state": state,
        "boot_id": persisted_boot_id,
    }
    return TargetOutcome(
        state=state,
        new_state=new_state,
        emit_decision=decision,
        emit_argv=emit_argv,
    )


def evaluate_emit_decision(*, state: str, consecutive_failures: int, threshold: int) -> EmitDecision:
    """Decide whether a non-ok state has persisted long enough to alert.

    A single transient blip must not page; we require ``threshold`` consecutive
    non-ok observations. ``ok`` never emits.
    """
    if state == STATE_OK:
        return EmitDecision(should_emit=False, reason="state_ok")
    if state not in NON_OK_STATES:
        # Unknown state is itself a problem, but gate it like any non-ok state.
        pass
    if consecutive_failures < threshold:
        return EmitDecision(
            should_emit=False,
            reason=f"below_threshold:{consecutive_failures}/{threshold}",
        )
    return EmitDecision(
        should_emit=True,
        reason=f"threshold_met:{consecutive_failures}/{threshold}",
    )


# ===========================================================================
# Production I/O glue (thin shell around the unit-tested pure core above).
# The pure functions above are the behavior under test; everything below is
# the fail-closed SSH/persistence/emit plumbing exercised by integration runs.
# ===========================================================================


def ssh_command() -> list[str]:
    raw = os.environ.get("BOT_ERRORS_SSH_COMMAND", "").strip()
    return shlex.split(raw) if raw else ["ssh"]


def ssh_timeout_seconds() -> float:
    raw = os.environ.get("BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS", "15")
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 15.0


def fleet_path() -> Path:
    raw = os.environ.get("BOT_ERRORS_EXPECTED_FLEET", "").strip()
    if raw:
        return Path(raw).expanduser()
    return REPO_ROOT / "deploy" / "bot-errors-expected-fleet.json"


# ---------------------------------------------------------------------------
# Inventory validation (#2467)
#
# The scheduled runtime (run_once) and installer preflight (config_check)
# share one canonical validator.  An invalid inventory NEVER yields targets;
# the caller must exit non-zero without probing, writing state, or emitting.
# ---------------------------------------------------------------------------

INVENTORY_VALID = "valid"
INVENTORY_NOT_APPLICABLE = "not_applicable"
INVENTORY_MISSING = "missing"
INVENTORY_UNREADABLE = "unreadable"
INVENTORY_MALFORMED = "malformed"
INVENTORY_NON_OBJECT = "non_object"
INVENTORY_INVALID_POLICY = "invalid_policy"
INVENTORY_IMPLICIT_EMPTY = "implicit_empty"

# Inventory statuses that represent a valid (green) inventory.
INVENTORY_OK_STATUSES = frozenset({INVENTORY_VALID, INVENTORY_NOT_APPLICABLE})


class InventoryValidationResult(NamedTuple):
    """Typed result of fleet inventory validation.

    Both config_check() and run_once() consume this so that the same
    canonical validator protects installer preflight and every scheduled
    runtime cycle (#2467).  An invalid result NEVER yields targets; the
    caller must exit non-zero without probing, writing state, or emitting.
    """
    status: str
    error: str | None
    fleet: dict | None
    targets: list


def _fleet_declares_not_applicable(fleet: dict) -> bool:
    """True when the fleet has at least one instance declaring not_applicable.

    Distinguishes an intentionally-empty monitor scope (every relevant
    instance is explicitly excluded) from an implicit-empty file (no hosts,
    missing instances, or all entries silently excluded by default).
    """
    hosts = fleet.get("hosts")
    if not isinstance(hosts, list):
        return False
    for host_entry in hosts:
        if not isinstance(host_entry, dict):
            continue
        instances = host_entry.get("instances")
        if not isinstance(instances, list):
            continue
        for instance in instances:
            if not isinstance(instance, dict):
                continue
            policy = policy_for_target(host_entry, instance)
            if policy == POLICY_NOT_APPLICABLE:
                return True
    return False


def validate_inventory() -> InventoryValidationResult:
    """Validate the expected-fleet inventory exactly once.

    Replaces the silent-error pattern in load_fleet() with a typed result
    that distinguishes valid (including explicitly empty / not_applicable)
    from every invalid class.  This is the single canonical validator used
    by both --config-check and the scheduled --once path (#2467).
    """
    path = fleet_path()
    # --- read + parse ---
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return InventoryValidationResult(
            INVENTORY_MISSING, f"expected fleet file not found: {path}", None, [])
    except json.JSONDecodeError as exc:
        return InventoryValidationResult(
            INVENTORY_MALFORMED,
            f"expected fleet file is not valid JSON: {path}: {exc}", None, [])
    except OSError as exc:
        return InventoryValidationResult(
            INVENTORY_UNREADABLE,
            f"expected fleet file is not readable: {path}: {exc}", None, [])

    if not isinstance(data, dict):
        return InventoryValidationResult(
            INVENTORY_NON_OBJECT,
            f"expected fleet file must contain a JSON object: {path}", None, [])

    # --- semantic validation ---
    unknown = unknown_policy_values(data)
    if unknown:
        detail = ", ".join(
            f"{o['host']}" + (f"/{o['instance']}" if o["instance"] else "") + f"={o['value']!r}"
            for o in unknown
        )
        return InventoryValidationResult(
            INVENTORY_INVALID_POLICY,
            "expected fleet file declares unknown guiSessionExpected policy value(s): "
            f"{detail}; known values: {sorted(KNOWN_GUI_SESSION_POLICIES)}: {path}",
            None, [])

    private_override_error = private_override_contract_error(data)
    if private_override_error is not None:
        return InventoryValidationResult(
            INVENTORY_INVALID_POLICY, private_override_error, None, [])

    # --- target enumeration ---
    targets = gui_targets_from_fleet(data)
    if targets:
        return InventoryValidationResult(INVENTORY_VALID, None, data, targets)

    # Zero targets: distinguish explicit not_applicable from implicit-empty.
    if _fleet_declares_not_applicable(data):
        return InventoryValidationResult(INVENTORY_NOT_APPLICABLE, None, data, targets)

    return InventoryValidationResult(
        INVENTORY_IMPLICIT_EMPTY,
        "expected fleet file has no GUI-session monitor targets and no explicit "
        f"not_applicable declaration: {path}",
        None, [])


def load_fleet() -> dict:
    try:
        with fleet_path().open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        # Fail-closed: an unreadable SSOT yields no targets rather than a crash;
        # the caller logs the empty enumeration.
        return {}


def config_check() -> int:
    """Validate monitor configuration without probing hosts or writing state."""
    result = validate_inventory()
    if result.status == INVENTORY_VALID:
        print(f"gui-session-monitor config ok: expected_fleet={fleet_path()} "
              f"targets={len(result.targets)}")
        return 0
    if result.status == INVENTORY_NOT_APPLICABLE:
        print(f"gui-session-monitor config ok (not_applicable): "
              f"expected_fleet={fleet_path()} targets=0")
        return 0
    print(result.error, file=sys.stderr)
    return 2


def state_path() -> Path:
    raw = os.environ.get("BOT_ERRORS_GUI_MONITOR_STATE", "").strip()
    if raw:
        return Path(raw).expanduser()
    base = os.environ.get("BOT_ERRORS_STATE_DIR", "").strip()
    root = Path(base) if base else (Path.home() / ".local/state/bot-errors")
    return root / "gui-session-monitor-state.json"


def load_state() -> dict:
    try:
        with state_path().open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    path = state_path()
    try:
        path.parent.lstat()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.parent.is_symlink() or not path.parent.is_dir():
            raise RuntimeError("refusing non-directory GUI monitor state root")
    path.parent.chmod(0o700)
    target = durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )
    observation = observe_json(target)
    merged = dict(observation.payload or {})
    merged.update(state)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        merged,
        component="gui_session_monitor.state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        merged,
        component="gui_session_monitor.state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    require_advance(publication)


def resolve_expected_user(host: str) -> str | None:
    """Resolve the expected GUI/login user for ``host``.

    SSOT GAP: deploy/health-profiles/*.json do not yet carry a bot GUI user.
    Until they do (component 3), resolve the SSH login user from ``ssh -G`` and
    allow an explicit override map via BOT_ERRORS_GUI_MONITOR_USERS=host=user,...
    Returns None when it cannot be resolved (caller -> inconclusive, fail-closed).
    """
    overrides = _parse_user_overrides()
    if host in overrides:
        return overrides[host]
    try:
        proc = subprocess.run(
            [*ssh_command(), "-G", host],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=ssh_timeout_seconds(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    for line in proc.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "user" and parts[1].strip():
            return parts[1].strip()
    return None


def _parse_user_overrides() -> dict[str, str]:
    raw = os.environ.get("BOT_ERRORS_GUI_MONITOR_USERS", "").strip()
    result: dict[str, str] = {}
    for item in raw.split(","):
        if "=" in item:
            host, user = item.split("=", 1)
            if host.strip() and user.strip():
                result[host.strip()] = user.strip()
    return result


def _run_ssh(host: str, remote_cmd: list[str]) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            [*ssh_command(), host, *remote_cmd],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=ssh_timeout_seconds(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False, ""
    if proc.returncode != 0:
        # Nonzero with stdout (e.g. "Could not find service") is still usable
        # output for distillation; nonzero with no stdout is a transport/remote
        # failure -> not ok.
        return (bool(proc.stdout.strip()), proc.stdout)
    return True, proc.stdout


def probe_host(host: str, expected_user: str | None, label: str) -> dict:
    """Run the two read-only SSH probes and distill them into a probe dict.

    Never raises: any failure becomes a fail-closed probe (console_ok/agent_ok
    False), which the classifier maps to ``unreachable``.
    """
    console_ok, console_raw = _run_ssh(host, ["stat", "-f", "%Su", "/dev/console"])
    console_owner = distill_console_owner(console_raw, ok=console_ok)

    uid = None
    if expected_user:
        uid_ok, uid_raw = _run_ssh(host, ["id", "-u", expected_user])
        if uid_ok and _norm(uid_raw).isdigit():
            uid = _norm(uid_raw)
    if uid:
        agent_ok, agent_raw = _run_ssh(host, ["launchctl", "print", f"gui/{uid}/{label}"])
    else:
        agent_ok, agent_raw = False, ""
    agent_state = distill_agent_state(agent_raw, ok=agent_ok)

    # Boot identifier for post-reboot regression detection (best-effort; a
    # failed boot probe yields None and never fabricates a reboot downstream).
    boot_ok, boot_raw = _run_ssh(host, ["sysctl", "-n", "kern.boottime"])
    boot_id = distill_boot_id(boot_raw, ok=boot_ok)

    return {
        "console_owner": console_owner,
        "agent_state": agent_state,
        "console_ok": console_ok,
        "agent_ok": agent_ok,
        "boot_id": boot_id,
        "error": None,
    }


def emit_event(emit_argv: list[str], *, dry_run: bool) -> int:
    if dry_run:
        print("[dry-run] would emit:", " ".join(shlex.quote(a) for a in emit_argv))
        return 0
    try:
        proc = subprocess.run(
            [sys.executable, str(EMIT_SCRIPT), *emit_argv],
            check=False,
        )
        return proc.returncode
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"emit failed: {exc}", file=sys.stderr)
        return 1


def run_once(*, dry_run: bool) -> int:
    threshold = default_failure_threshold()
    result = validate_inventory()
    if result.status not in INVENTORY_OK_STATUSES:
        # Invalid inventory: fail closed, preserve prior state, emit nothing.
        # The scheduled runtime must agree with config_check on every invalid
        # class (#2467) — missing, unreadable, malformed, non-object, invalid
        # policy, and implicit-empty all exit 2 without probing.
        print(result.error, file=sys.stderr)
        return 2
    if result.status == INVENTORY_NOT_APPLICABLE:
        # Explicitly-empty scope: valid, no probes, no state mutation.
        return 0
    targets = result.targets
    state = load_state()
    exit_code = 0
    for target in targets:
        host = target["host"]
        label = target["label"]
        key = f"{host}/{label}"
        expected_user = resolve_expected_user(host)
        if expected_user is None:
            probe = {
                "console_owner": None, "agent_state": None,
                "console_ok": False, "agent_ok": False,
                "boot_id": None,
                "error": "expected_user_unresolved",
            }
        else:
            probe = probe_host(host, expected_user, label)
        outcome = run_target(
            target=target,
            expected_user=expected_user or "",
            probe=probe,
            prior_state=state.get(key),
            threshold=threshold,
        )
        state[key] = outcome.new_state
        print(f"{key}: state={outcome.state} "
              f"failures={outcome.new_state['consecutive_failures']} "
              f"emit={outcome.emit_decision.should_emit}")
        if outcome.emit_argv is not None:
            rc = emit_event(outcome.emit_argv, dry_run=dry_run)
            if rc != 0:
                exit_code = 1
    if not dry_run:
        save_state(state)
    return exit_code


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="External off-GUI WhatSoup GUI-session monitor."
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Classify and report; do not write state or emit events.",
    )
    parser.add_argument(
        "--once", action="store_true",
        help="Run a single cycle (default; reserved for future loop mode).",
    )
    parser.add_argument(
        "--config-check", action="store_true",
        help="Validate monitor config only; do not SSH, write state, or emit events.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.config_check:
        return config_check()
    return run_once(dry_run=args.dry_run)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
