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
