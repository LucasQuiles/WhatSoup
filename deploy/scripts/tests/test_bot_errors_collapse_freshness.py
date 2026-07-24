"""TRUTH-01: freshness + closure reachability for pre-process_one terminal paths.

Root cause (artifacts/baseline/TRUTH-01-root-cause.md): `collapse_ready_storms()`
moves member daily-health events out of outbox/ into storm-collapsed/ in
`run_once()` *before* the main per-event loop reaches `process_one()`. Only
`process_one()` calls `record_daily_health_freshness()` and
`close_recovered_daily_health_incidents()`, so a storm-collapsed host's
liveness stamp and any incident recovery its event carried are both silently
dropped. The heartbeat-watchdog then reports a live, correctly-reporting host
as stale, and a recovered incident never auto-closes.

The decisive test below (`test_storm_collapsed_member_stamps_freshness_and_...`)
drives `collapse_ready_storms()` directly against unmodified dispatcher.py to
prove this: pre-fix, `collapse_ready_storms()` never touches incident_state at
all, so both the freshness-stamp and incident-closure assertions fail. This is
the "process_one-only test trap" the contract warns about — a test that only
exercises `process_one()` would pass against the defect and prove nothing.

The remaining tests cover the other pre-process_one terminal paths named in
the contract: `suppress_ready_recovery_duplicates()` (a discarded recovery
duplicate must still stamp freshness for its own relay host — its relay host
can differ from the "machine" field the dedupe groups on, so the stamp is
genuinely lost, not merely delayed), `flap_scan_outbox()` (regression guard —
it does not remove events from outbox, so a flap-suppressed member already
reaches `process_one()` and stamps there; this proves that stays true), and
`suppress_test_provenance_events()` (regression guard for Global Constraint 9
— synthetic/test-provenance events must never stamp freshness, even after
this fix widens stamping to the other terminal paths).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_DISPATCHER = _SCRIPTS_DIR / "bot-errors-dispatcher.py"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_disp = _load("bot_errors_dispatcher_collapse_freshness", _DISPATCHER)

# A probe string satisfying is_verified_whatsapp_health_recovery(): "200 "
# prefix, no FAIL/WARN markers, and every required key=value pair present.
_HEALTHY_PROBE = (
    "200 status=healthy wa_connected=true state=connected "
    "auth_bond_status=present auth_bond_creds_exists=true "
    "auth_bond_creds_size=128 auth_failure_class=none"
)


def _write_event(paths: dict[str, Path], filename: str, event: dict[str, Any]) -> Path:
    path = paths["outbox"] / filename
    path.write_text(json.dumps(event), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 1. Storm-collapse — the decisive falsifier (freshness AND closure)
# ---------------------------------------------------------------------------

def test_storm_collapsed_member_stamps_freshness_and_closes_incident(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_STORM_THRESHOLD"] = "2"
    os.environ["BOT_ERRORS_STORM_WINDOW_SECONDS"] = "120"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())
        instance = "eh-bot"
        machine_a, machine_b = "relay-collapse-a", "relay-collapse-b"

        # Pre-seed an OPEN incident that machine_a's collapsed event's evidence
        # verifies as recovered (a "health_body_degraded" WhatsApp recovery
        # source; no outbound-proof requirement, so is_verified_whatsapp_health
        # _recovery(probe) alone is sufficient per daily_health_recovered_
        # incident_keys()).
        incident_state = _disp.load_incident_state(paths)
        incident_key = f"{machine_a}|{instance}|health_body_degraded"
        opened_epoch = base_epoch - 3600
        incident_state.setdefault("openIncidents", {})[incident_key] = {
            "status": "open",
            "eventCreatedAtEpoch": opened_epoch,
            "openedAt": opened_epoch,
        }
        _disp.save_incident_state(paths, incident_state)

        evidence = f"health {instance}: {_HEALTHY_PROBE}"
        created_at = _disp.iso_from_epoch(base_epoch)

        def _member(idx: int, machine: str) -> dict[str, Any]:
            return {
                "schemaVersion": 1,
                "id": f"evt-collapse-{idx}",
                "eventType": "alert",
                "severity": "critical",
                "source": "daily-health",
                "machine": machine,
                "instance": instance,
                "summary": "storm collapse freshness probe",
                "evidence": evidence,
                "createdAt": created_at,
                "diagnostics": {"relay": {"remoteHost": machine}},
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
            }

        _write_event(paths, "20260723T000001Z.a.json", _member(1, machine_a))
        _write_event(paths, "20260723T000002Z.b.json", _member(2, machine_b))

        collapsed = _disp.collapse_ready_storms(paths)
        assert collapsed == 2, f"setup bug, not the defect under test: expected both members collapsed, got {collapsed}"

        reloaded = _disp.load_incident_state(paths)
        ledger = reloaded.get("dailyHealthFreshness", {})

        # (a) freshness stamped for BOTH collapsed members' hosts.
        assert machine_a in ledger, "collapsed member lost its freshness stamp"
        assert ledger[machine_a]["lastSeenAt"] == base_epoch
        assert machine_b in ledger, "collapsed member lost its freshness stamp"
        assert ledger[machine_b]["lastSeenAt"] == base_epoch

        # (b) the open incident recovered by the collapsed event's evidence
        # must be closed, not left open just because its carrier was
        # storm-collapsed before reaching process_one.
        assert incident_key not in reloaded.get("openIncidents", {}), (
            "collapsed member should have closed the recovered incident"
        )
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_STORM_THRESHOLD", None)
        os.environ.pop("BOT_ERRORS_STORM_WINDOW_SECONDS", None)


def test_storm_collapse_below_threshold_leaves_events_for_process_one(tmp_path):
    # Guard: when the group never reaches storm_threshold(), collapse_ready_
    # storms() must not touch incident_state at all (no partial/duplicate
    # stamping) -- the events stay in outbox for the normal process_one path.
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_STORM_THRESHOLD"] = "5"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())
        event = {
            "id": "evt-nostorm-1",
            "eventType": "alert",
            "severity": "critical",
            "source": "daily-health",
            "machine": "relay-nostorm",
            "instance": "eh-bot",
            "summary": "not enough hosts to storm",
            "createdAt": _disp.iso_from_epoch(base_epoch),
            "diagnostics": {"relay": {"remoteHost": "relay-nostorm"}},
            "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
        }
        path = _write_event(paths, "20260723T000000Z.nostorm.json", event)

        collapsed = _disp.collapse_ready_storms(paths)
        assert collapsed == 0
        assert path.exists(), "sub-threshold event must remain in outbox for process_one"
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_STORM_THRESHOLD", None)


# ---------------------------------------------------------------------------
# 2. Recovery-dedup — a discarded duplicate must still stamp freshness
# ---------------------------------------------------------------------------

def test_recovery_dedupe_discarded_duplicate_still_stamps_freshness(tmp_path):
    # The dedupe group key is machine/instance (recovery_identity); the
    # freshness ledger keys on the relay remoteHost (daily_health_host_from_
    # payload). A relayed duplicate can carry a distinct remoteHost from the
    # hub "machine" field it dedupes under -- so discarding it without
    # absorbing its freshness loses a real host's liveness stamp entirely,
    # not just delays it (the kept sibling proceeds through process_one and
    # stamps its OWN relay host, not necessarily this one).
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS"] = "120"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())
        relay_host = "dedupe-worker-x"
        evidence = f"health eh-bot: {_HEALTHY_PROBE}"

        def _clear(idx: int, epoch: int) -> dict[str, Any]:
            return {
                "id": f"evt-dedupe-{idx}",
                "eventType": "clear",
                "severity": "warning",
                "source": "daily-health",
                "machine": "relay-dedupe-hub",
                "instance": "eh-bot",
                "summary": "daily health recovered",
                "evidence": evidence,
                "createdAt": _disp.iso_from_epoch(epoch),
                "diagnostics": {"relay": {"remoteHost": relay_host}},
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
            }

        kept_path = _write_event(paths, "20260723T000001Z.dedupe1.json", _clear(1, base_epoch))
        dup_path = _write_event(paths, "20260723T000002Z.dedupe2.json", _clear(2, base_epoch + 10))

        suppressed = _disp.suppress_ready_recovery_duplicates(paths)
        assert suppressed == 1, f"setup bug, not the defect under test: expected exactly one duplicate, got {suppressed}"
        assert kept_path.exists(), "the first (kept) event must remain in outbox for process_one"
        assert not dup_path.exists(), "the duplicate must be moved out of outbox"

        reloaded = _disp.load_incident_state(paths)
        ledger = reloaded.get("dailyHealthFreshness", {})
        assert relay_host in ledger, "discarded recovery duplicate lost its freshness stamp"
        # Stamped from the discarded duplicate's own createdAt (base_epoch+10),
        # not the kept sibling's (base_epoch) -- the kept sibling was never
        # run through process_one in this test, isolating which absorption
        # produced the stamp.
        assert ledger[relay_host]["lastSeenAt"] == base_epoch + 10
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS", None)


# ---------------------------------------------------------------------------
# 3. Flap-suppression — regression guard (already correct: no file movement)
# ---------------------------------------------------------------------------

def test_flap_suppressed_member_still_reaches_process_one_and_stamps_freshness(tmp_path, monkeypatch):
    # flap_scan_outbox() (§10 C1) only records flap trips into incident_state's
    # flapState; unlike collapse/dedupe it never moves event files out of
    # outbox. The member therefore still reaches process_one() in the normal
    # run_once() loop (whether or not should_suppress_send ultimately
    # suppresses delivery) and stamps freshness there. This test guards that
    # invariant so a future refactor toward the storm-collapse model does not
    # silently reintroduce the same class of loss here.
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        paths = _disp.setup_dirs()
        monkeypatch.setattr(_disp, "send_whatsapp", lambda *_a, **_k: None)
        base_epoch = int(time.time())
        relay_host = "flap-worker-y"
        event = {
            "id": "evt-flap-1",
            "eventType": "alert",
            "severity": "critical",
            "source": "daily-health-fail",
            "machine": "relay-flap-hub",
            "instance": "eh-bot",
            "summary": "daily health failing",
            "evidence": "health eh-bot: 500 status=unhealthy",
            "createdAt": _disp.iso_from_epoch(base_epoch),
            "diagnostics": {"relay": {"remoteHost": relay_host}},
            "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
        }
        path = _write_event(paths, "20260723T000000Z.flap.json", event)

        _disp.flap_scan_outbox(paths)
        assert path.exists(), "flap_scan_outbox must never remove the event file from outbox"

        ok, _detail = _disp.process_one(path, paths)
        assert ok

        reloaded = _disp.load_incident_state(paths)
        ledger = reloaded.get("dailyHealthFreshness", {})
        assert relay_host in ledger, "flap-suppressed member lost its freshness stamp"
        assert ledger[relay_host]["lastSeenAt"] == base_epoch
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


# ---------------------------------------------------------------------------
# 4. Test-provenance screening — Global Constraint 9 regression guard
# ---------------------------------------------------------------------------

def test_test_provenance_screened_never_stamps_freshness(tmp_path):
    # Global Constraint 9: synthetic/test-provenance daily-health events must
    # never manufacture liveness for a real host. suppress_test_provenance_
    # events() runs before process_one() and must stay that way -- it must
    # NOT gain freshness-stamping even though this fix widens stamping to the
    # other pre-process_one terminal paths (storm-collapse, recovery-dedup).
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        paths = _disp.setup_dirs()
        relay_host = "test-provenance-worker-z"
        event = {
            "id": "evt-testprov-1",
            "eventType": "alert",
            "severity": "info",
            "source": "daily-health",
            "machine": "relay-testprov-hub",
            "instance": "eh-bot",
            "summary": "daily health (synthetic)",
            "createdAt": _disp.iso_from_epoch(int(time.time())),
            "diagnostics": {"relay": {"remoteHost": relay_host}},
            "runtime": {"provenance": {"test": True}},
            "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
        }
        path = _write_event(paths, "20260723T000000Z.testprov.json", event)

        suppressed, _alerted = _disp.suppress_test_provenance_events(paths)
        assert suppressed == 1
        assert not path.exists()

        reloaded = _disp.load_incident_state(paths)
        assert relay_host not in reloaded.get("dailyHealthFreshness", {}), (
            "test-provenance event must never stamp freshness (Global Constraint 9)"
        )
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


# ---------------------------------------------------------------------------
# 5. SAVE-BEFORE-MOVE crash-safety
#
# collapse_storm_group() and suppress_ready_recovery_duplicates() both absorb
# freshness/closure into incident_state in memory, then physically move the
# source event file out of outbox/ (into storm-collapsed/ or suppressed/).
# Pre-fix, the terminal move happens interleaved with (or before) the state
# save, so a crash between "file moved" and "state saved" loses the absorbed
# stamp for good: the file is no longer in outbox/, so nothing will ever
# reprocess and re-absorb it. The fix restructures both functions to save
# incident_state ONCE, before any of the batch's terminal moves -- mirroring
# process_one's already-proven save-before-move pattern. A crash AFTER the
# save (during the moves) is safe: the state is already durable, and re-
# absorbing an event that never got moved is an idempotent no-op.
# ---------------------------------------------------------------------------

def test_collapse_crash_before_move_still_persists_absorbed_stamp(tmp_path, monkeypatch):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_STORM_THRESHOLD"] = "2"
    os.environ["BOT_ERRORS_STORM_WINDOW_SECONDS"] = "120"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())
        instance = "eh-bot"
        machine_a, machine_b = "relay-crash-a", "relay-crash-b"
        evidence = f"health {instance}: {_HEALTHY_PROBE}"
        created_at = _disp.iso_from_epoch(base_epoch)

        def _member(idx: int, machine: str) -> dict[str, Any]:
            return {
                "id": f"evt-crash-{idx}",
                "eventType": "alert",
                "severity": "critical",
                "source": "daily-health",
                "machine": machine,
                "instance": instance,
                "summary": "collapse crash-injection probe",
                "evidence": evidence,
                "createdAt": created_at,
                "diagnostics": {"relay": {"remoteHost": machine}},
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
            }

        _write_event(paths, "20260723T000001Z.a.json", _member(1, machine_a))
        _write_event(paths, "20260723T000002Z.b.json", _member(2, machine_b))

        # Simulate a crash exactly at the terminal move into storm_collapsed/
        # -- everything up to and including the incident_state save (if the
        # fix is present) must already have happened by the time this fires.
        real_replace = _disp.os.replace
        storm_collapsed_dir = str(paths["storm_collapsed"])

        def _crash_on_collapse_move(src, dst):
            if storm_collapsed_dir in str(dst):
                raise RuntimeError("simulated crash during terminal collapse move")
            return real_replace(src, dst)

        monkeypatch.setattr(_disp.os, "replace", _crash_on_collapse_move)

        with pytest.raises(RuntimeError, match="simulated crash"):
            _disp.collapse_ready_storms(paths)

        reloaded = _disp.load_incident_state(paths)
        ledger = reloaded.get("dailyHealthFreshness", {})
        assert machine_a in ledger, (
            "absorbed freshness stamp lost to a crash between save and move"
        )
        assert ledger[machine_a]["lastSeenAt"] == base_epoch
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_STORM_THRESHOLD", None)
        os.environ.pop("BOT_ERRORS_STORM_WINDOW_SECONDS", None)


def test_collapse_no_op_storm_never_saves_state(tmp_path, monkeypatch):
    # A storm of non-daily-health events absorbs nothing (record_daily_health_
    # freshness requires a daily-health* source), so collapsing it must not
    # trigger any incident_state save at all -- the efficiency half of (b).
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_STORM_THRESHOLD"] = "2"
    os.environ["BOT_ERRORS_STORM_WINDOW_SECONDS"] = "120"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())
        created_at = _disp.iso_from_epoch(base_epoch)

        def _member(idx: int, machine: str) -> dict[str, Any]:
            return {
                "id": f"evt-noop-{idx}",
                "eventType": "alert",
                "severity": "critical",
                "source": "provider-probe-fail",
                "machine": machine,
                "instance": "eh-bot",
                "summary": "non daily-health storm probe",
                "createdAt": created_at,
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
            }

        _write_event(paths, "20260723T000001Z.a.json", _member(1, "relay-noop-a"))
        _write_event(paths, "20260723T000002Z.b.json", _member(2, "relay-noop-b"))

        save_calls: list[int] = []
        real_save = _disp.save_incident_state

        def _counting_save(paths_arg, state_arg):
            save_calls.append(1)
            return real_save(paths_arg, state_arg)

        monkeypatch.setattr(_disp, "save_incident_state", _counting_save)

        collapsed = _disp.collapse_ready_storms(paths)
        assert collapsed == 2, "setup bug, not the defect under test: expected both members collapsed"
        assert len(save_calls) == 0, (
            f"a non-daily-health storm collapse must never save incident_state; saved {len(save_calls)}x"
        )
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_STORM_THRESHOLD", None)
        os.environ.pop("BOT_ERRORS_STORM_WINDOW_SECONDS", None)


def test_dedupe_crash_before_move_still_persists_absorbed_stamp(tmp_path, monkeypatch):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS"] = "120"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())
        relay_host = "dedupe-crash-worker"
        evidence = f"health eh-bot: {_HEALTHY_PROBE}"

        def _clear(idx: int, epoch: int) -> dict[str, Any]:
            return {
                "id": f"evt-dedupe-crash-{idx}",
                "eventType": "clear",
                "severity": "warning",
                "source": "daily-health",
                "machine": "relay-dedupe-crash-hub",
                "instance": "eh-bot",
                "summary": "daily health recovered (crash probe)",
                "evidence": evidence,
                "createdAt": _disp.iso_from_epoch(epoch),
                "diagnostics": {"relay": {"remoteHost": relay_host}},
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
            }

        _write_event(paths, "20260723T000001Z.dedupe1.json", _clear(1, base_epoch))
        _write_event(paths, "20260723T000002Z.dedupe2.json", _clear(2, base_epoch + 10))

        real_replace = _disp.os.replace
        suppressed_dir = str(paths["suppressed"])

        def _crash_on_suppress_move(src, dst):
            if suppressed_dir in str(dst):
                raise RuntimeError("simulated crash during terminal suppress move")
            return real_replace(src, dst)

        monkeypatch.setattr(_disp.os, "replace", _crash_on_suppress_move)

        with pytest.raises(RuntimeError, match="simulated crash"):
            _disp.suppress_ready_recovery_duplicates(paths)

        reloaded = _disp.load_incident_state(paths)
        ledger = reloaded.get("dailyHealthFreshness", {})
        assert relay_host in ledger, (
            "absorbed freshness stamp lost to a crash between save and move"
        )
        assert ledger[relay_host]["lastSeenAt"] == base_epoch + 10
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS", None)


def test_dedupe_no_op_duplicate_never_saves_state(tmp_path, monkeypatch):
    # A duplicate that is not daily-health-sourced absorbs nothing, so
    # suppressing it must not trigger any incident_state save.
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS"] = "120"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())

        def _clear(idx: int, epoch: int) -> dict[str, Any]:
            return {
                "id": f"evt-dedupe-noop-{idx}",
                "eventType": "clear",
                "severity": "warning",
                "source": "provider-probe-fail",
                "machine": "relay-dedupe-noop-hub",
                "instance": "eh-bot",
                "summary": "non daily-health recovery clear",
                "createdAt": _disp.iso_from_epoch(epoch),
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
            }

        _write_event(paths, "20260723T000001Z.dedupe1.json", _clear(1, base_epoch))
        _write_event(paths, "20260723T000002Z.dedupe2.json", _clear(2, base_epoch + 10))

        save_calls: list[int] = []
        real_save = _disp.save_incident_state

        def _counting_save(paths_arg, state_arg):
            save_calls.append(1)
            return real_save(paths_arg, state_arg)

        monkeypatch.setattr(_disp, "save_incident_state", _counting_save)

        suppressed = _disp.suppress_ready_recovery_duplicates(paths)
        assert suppressed == 1, "setup bug, not the defect under test: expected exactly one duplicate"
        assert len(save_calls) == 0, (
            f"a non-daily-health duplicate must never save incident_state; saved {len(save_calls)}x"
        )
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS", None)


# ---------------------------------------------------------------------------
# 6. Dead-letter terminal stamp-loss
#
# process_one() absorbs freshness/closure into incident_state in memory
# BEFORE attempting delivery. If delivery permanently fails and the event is
# moved to dead-letter/, that absorbed state must be persisted first --
# dead-lettered events are never reprocessed (unlike the transient-transport
# and generic-retry sub-paths, which requeue to outbox/ and self-heal on the
# next cycle), so an unsaved stamp here is lost for good.
# ---------------------------------------------------------------------------

def test_dead_letter_saves_absorbed_stamp_before_terminal_move(tmp_path, monkeypatch):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_EMAIL_FALLBACK"] = str(tmp_path / "no-such-fallback.sh")
    try:
        paths = _disp.setup_dirs()

        def _boom(*_a, **_k):
            raise RuntimeError("permanent failure: bad payload")

        monkeypatch.setattr(_disp, "send_whatsapp", _boom)
        base_epoch = int(time.time())
        relay_host = "deadletter-worker"
        event = {
            "id": "evt-deadletter-1",
            "eventType": "alert",
            "severity": "critical",
            "source": "daily-health-fail",
            "machine": "relay-deadletter-hub",
            "instance": "eh-bot",
            "summary": "daily health failing",
            "evidence": "health eh-bot: 500 status=unhealthy",
            "createdAt": _disp.iso_from_epoch(base_epoch),
            "diagnostics": {"relay": {"remoteHost": relay_host}},
            "delivery": {
                "attempts": _disp.BOT_ERRORS_DELIVERY_MAX_ATTEMPTS - 1,
                "status": "queued",
                "nextAttemptAtEpoch": 0,
            },
        }
        path = _write_event(paths, "20260723T000000Z.deadletter.json", event)

        ok, detail = _disp.process_one(path, paths)
        assert not ok
        assert detail.startswith("dead_letter"), (
            f"setup bug, not the defect under test: expected a dead-letter outcome, got {detail!r}"
        )

        reloaded = _disp.load_incident_state(paths)
        ledger = reloaded.get("dailyHealthFreshness", {})
        assert relay_host in ledger, "dead-lettered event's absorbed freshness stamp was lost"
        assert ledger[relay_host]["lastSeenAt"] == base_epoch
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_EMAIL_FALLBACK", None)


# ---------------------------------------------------------------------------
# 7. DRY diagnostics stamp, slimmed absorb() return shape
# ---------------------------------------------------------------------------

def test_absorb_return_shape_is_list_not_tuple():
    # Locks the slimmed contract: no caller consumes the host half of the old
    # (host, recovered) tuple (confirmed by grep across all call sites before
    # this change), so absorb_daily_health_signal() now returns just the
    # recovered-incident-keys list directly.
    state: dict[str, Any] = {}
    event = {
        "source": "daily-health",
        "machine": "relay-absorb-shape",
        "createdAt": _disp.iso_from_epoch(int(time.time())),
        "diagnostics": {"relay": {"remoteHost": "relay-absorb-shape"}},
    }
    result = _disp.absorb_daily_health_signal(event, state)
    assert isinstance(result, list), f"expected a bare list, got {type(result)}: {result!r}"


def test_collapsed_event_on_disk_carries_recovered_incidents_diagnostic(tmp_path):
    # Regression guard for the DRY refactor: the diagnostics stamp that used
    # to be copy-pasted at each of the three call sites must still land on
    # the actual on-disk collapsed event after folding it into absorb().
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    os.environ["BOT_ERRORS_STORM_THRESHOLD"] = "2"
    os.environ["BOT_ERRORS_STORM_WINDOW_SECONDS"] = "120"
    try:
        paths = _disp.setup_dirs()
        base_epoch = int(time.time())
        instance = "eh-bot"
        machine_a, machine_b = "relay-diag-a", "relay-diag-b"

        incident_state = _disp.load_incident_state(paths)
        incident_key = f"{machine_a}|{instance}|health_body_degraded"
        opened_epoch = base_epoch - 3600
        incident_state.setdefault("openIncidents", {})[incident_key] = {
            "status": "open",
            "eventCreatedAtEpoch": opened_epoch,
            "openedAt": opened_epoch,
        }
        _disp.save_incident_state(paths, incident_state)

        evidence = f"health {instance}: {_HEALTHY_PROBE}"
        created_at = _disp.iso_from_epoch(base_epoch)

        def _member(idx: int, machine: str) -> dict[str, Any]:
            return {
                "id": f"evt-diag-{idx}",
                "eventType": "alert",
                "severity": "critical",
                "source": "daily-health",
                "machine": machine,
                "instance": instance,
                "summary": "collapsed diagnostics probe",
                "evidence": evidence,
                "createdAt": created_at,
                "diagnostics": {"relay": {"remoteHost": machine}},
                "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
            }

        _write_event(paths, "20260723T000001Z.a.json", _member(1, machine_a))
        _write_event(paths, "20260723T000002Z.b.json", _member(2, machine_b))

        collapsed = _disp.collapse_ready_storms(paths)
        assert collapsed == 2, "setup bug, not the defect under test: expected both members collapsed"

        collapsed_files = list(paths["storm_collapsed"].glob("20260723T000001Z.a.json*"))
        assert len(collapsed_files) == 1, f"expected exactly one collapsed file for machine_a, found {collapsed_files}"
        on_disk = json.loads(collapsed_files[0].read_text(encoding="utf-8"))
        recovered_diag = on_disk.get("diagnostics", {}).get("sourceSpecificRecoveredIncidents")
        assert recovered_diag == [incident_key], (
            f"collapsed event on disk is missing the recovered-incidents diagnostic: {on_disk.get('diagnostics')}"
        )
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        os.environ.pop("BOT_ERRORS_STORM_THRESHOLD", None)
        os.environ.pop("BOT_ERRORS_STORM_WINDOW_SECONDS", None)
