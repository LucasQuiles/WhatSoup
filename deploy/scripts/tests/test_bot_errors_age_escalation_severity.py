"""Age or repeat-count escalation raises a still-open reminder by one severity step (R73).

append_still_open_context set every escalated still-open reminder to critical,
whatever severity the sender chose. The release-currency observer sends at warning,
so an open drift incident became a critical page on every reminder once it was a
day old: maintenance debt paged as an outage. Escalation now raises the sender's
severity by at most one step -- warning to error, error to critical, critical stays
critical -- and a severity the dispatcher cannot read escalates to critical, toward
paging.

The decision tests drive the real should_suppress_send over an in-memory incident
state and render the result with format_event. The retry tests drive process_one
through a failed send and its retry: a failed send requeues the event with the
raised severity, and the retry must not raise it a second time.

The sender's severity is recorded once and survives every retry path, and a retry
that escalates again raises from it. Every producer writes a fixed fresh delivery
block, and a writer that could plant the field could set the severity itself, so a
planted value is outside the threat model: the rule is never worse than base.
Pattern D (transient tiering) cannot lower where escalation starts. A reminder that is
"escalated now" (escalated_now: the delivery.escalatedNow marker, set where base set
critical and cleared wherever base then overwrote it, plus a readable recorded
severity, the escalated=true line, and a severity at least the escalation of the
recorded one) gets base's critical treatment in storm collapse and in a new Pattern
D record; any other event, including a retry Pattern D restored to a lower severity,
keeps its own severity.

The owner copy (lib/owner_route.py) qualified escalated reminders only because
escalation forced critical. Those reminders now qualify through the sender's
severity the dispatcher records on the delivery block, so an owner-route source
that sends at warning keeps the copy it got before, and no other source gains one.

Tests whose names contain `_pin_` hold behaviour that is already right and must
stay so. All fixtures are synthetic.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import time as real_time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from hypothesis import example, given, strategies as st

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from bot_errors_property_support import properties  # noqa: E402
from support import dispatcher_fixtures  # noqa: E402

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))

from lib import owner_route  # noqa: E402
from lib.bot_errors_envelope import SEVERITIES  # noqa: E402
from lib.controller_state import open_controller_state  # noqa: E402

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_OUTBOX_DIR",
    "BOT_ERRORS_SEND_DAILY_HEALTH_INFO",
    "BOT_ERRORS_INCIDENT_RENOTIFY_SECONDS",
    "BOT_ERRORS_INCIDENT_RENOTIFY_CAP_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SUPPRESSED",
    "BOT_ERRORS_INCIDENT_STALE_SECONDS",
    "BOT_ERRORS_AWAITING_PHYSICAL_CONFIRMATIONS",
    "BOT_ERRORS_AWAITING_PHYSICAL_RENOTIFY_SECONDS",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_TRANSIENT_SOURCES",
    "BOT_ERRORS_TRANSIENT_TIERING",
    "BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES",
    "BOT_ERRORS_SUPPRESS_OPEN_NONACTIONABLE_RENOTIFY",
    "BOT_ERRORS_TEST_LEAK_PATH_PATTERNS",
    "BOT_ERRORS_DRY_SEND_CAPTURE",
    "BOT_ERRORS_DRY_SEND_FAIL",
    "BOT_ERRORS_OWNER_ROUTE_JID",
    "BOT_ERRORS_OWNER_ROUTE_SOCKET",
    "BOT_ERRORS_STORM_THRESHOLD",
    "BOT_ERRORS_STORM_WINDOW_SECONDS",
]

_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)

T0 = 1_790_000_000
HOUR = 3600
TOKEN_A = "a0c1e2f3a4b5c6d7"
MACHINE = "host-a"
INSTANCE = "instance-a"
SEVERITY_LINE = "  > severity: {}"
ESCALATED_PREFIX = "ESCALATED still open: "

# The release-currency observer's alert, as scripts/live-release-currency-alert.ts
# hands it to bot-errors-emit.py: severity warning, the observation as JSON
# evidence, and its three key=value diagnostics.
RELEASE_SOURCE = "release-currency"
RELEASE_INSTANCE = "release-bot"
RELEASE_PATH = "/opt/whatsoup/releases/current"
RELEASE_MANIFEST = RELEASE_PATH + "/release-manifest.json"
RELEASE_SUMMARY = "release currency target differs: current"


class _Clock:
    """The dispatcher's clock: time() and gmtime() read `now`; everything else is the real module."""

    def __init__(self, now: int) -> None:
        self.now = now

    def time(self) -> float:
        return float(self.now)

    def gmtime(self, seconds: float | None = None):
        return real_time.gmtime(self.now if seconds is None else seconds)

    def __getattr__(self, name: str) -> Any:
        return getattr(real_time, name)


class _Bench:
    """One dispatcher state directory, a fixed clock and a recording sender."""

    def __init__(self, tmp_path: Path) -> None:
        state_dir = tmp_path / "state"
        os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
        (state_dir / "logs").mkdir(parents=True, exist_ok=True)
        self.mod = dispatcher_fixtures.load_module_from_path(
            f"bot_errors_dispatcher_age_escalation_{tmp_path.name}", _SCRIPT
        )
        self.clock = _Clock(T0)
        self.mod.time = self.clock
        self.paths = self.mod.setup_dirs()
        os.chmod(self.paths["incident_state"].parent, 0o700)
        self.attempts: list[str] = []
        self.delivered: list[str] = []
        self._names = 0

    # --- the send decision alone ---------------------------------------------------------

    def decide(self, event: dict[str, Any], record: dict[str, Any], **top: Any) -> str:
        """Run the send decision for `event` against one open record; return the text it would send."""
        state = _state({self.mod.incident_key(event): record}, **top)
        reason = self.mod.should_suppress_send(event, state)
        assert reason is None, f"the due reminder must be sent, not suppressed: {reason}"
        return self.mod.format_event(event)

    # --- the whole send path -------------------------------------------------------------

    def _session(self):
        return open_controller_state(
            self.paths["incident_state"],
            component="dispatcher-incident",
            bootstrap=self.mod.dispatcher_bootstrap_state,
            validate_payload=self.mod.validate_dispatcher_state,
            lock_timeout_seconds=10,
        )

    def seed(self, payload: dict[str, Any]) -> None:
        session = self._session()
        with session:
            loaded = session.load()
            session.save(copy.deepcopy(payload), loaded.capability)

    def put(self, event: dict[str, Any]) -> Path:
        self._names += 1
        name = f"{self.clock.now}.{self._names:03d}.{event['source']}.{event['id']}.json"
        return dispatcher_fixtures.write_outbox_event(self.paths, name, event)

    def queued(self, path: Path) -> Path:
        requeued = self.paths["outbox"] / path.name
        assert requeued.exists(), f"{path.name} must be back in the queue for its retry"
        return requeued

    def archived(self, path: Path) -> dict[str, Any]:
        sent = sorted(self.paths["sent"].glob(f"{path.name}.*.sent"))
        assert len(sent) == 1, f"expected one archived delivery for {path.name}, found {len(sent)}"
        return json.loads(sent[0].read_text(encoding="utf-8"))

    def _sender(self, outcome: str):
        def send(text: str, *args: Any, **kwargs: Any) -> None:
            self.attempts.append(outcome)
            if outcome == "ok":
                self.delivered.append(text)
                return None
            if outcome == "transient":
                raise RuntimeError("WhatsApp is temporarily disconnected")
            if outcome == "ambiguous":
                raise self.mod.AmbiguousSendOutcome(
                    "no reply after the request", phase=self.mod.JSON_RPC_POST_REQUEST_PHASE
                )
            raise RuntimeError("the remote rejected the message")

        return send

    def cycle(self, *steps: tuple[Path, str]) -> None:
        """One dispatcher cycle over `steps` (path, send outcome), in the order given."""
        session = self._session()
        with session:
            loaded = session.load()
            incident = self.mod.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=self.paths)
            for path, outcome in steps:
                with patch.object(self.mod, "send_whatsapp", side_effect=self._sender(outcome)):
                    self.mod.process_one(path, self.paths, incident=incident)

    def collapse(self) -> int:
        """One storm-collapse scan of the outbox inside a cycle; returns how many events it collapsed."""
        session = self._session()
        with session:
            loaded = session.load()
            incident = self.mod.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=self.paths)
            return self.mod.collapse_ready_storms(self.paths, incident=incident)

    def outbox_events(self) -> list[dict[str, Any]]:
        return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(self.paths["outbox"].glob("*.json"))]


_PURE: list[Any] = []


def _pure_dispatcher() -> Any:
    """The dispatcher loaded once, for properties over functions that touch no state."""
    if not _PURE:
        _PURE.append(dispatcher_fixtures.load_module_from_path("bot_errors_dispatcher_age_escalation_pure", _SCRIPT))
    return _PURE[0]


def _iso(epoch: int) -> str:
    return real_time.strftime("%Y-%m-%dT%H:%M:%SZ", real_time.gmtime(epoch))


def _alert(event_id: str, *, severity: str = "warning", source: str = "socket_down",
           instance: str = INSTANCE, evidence: str = "the socket closed and did not come back",
           **extra: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": severity,
        "id": event_id,
        "source": source,
        "machine": MACHINE,
        "instance": instance,
        "summary": f"{source} on {instance}",
        "evidence": evidence,
        "createdAt": _iso(T0 - 30),
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    event.update(extra)
    return event


def _release_currency_alert(event_id: str) -> dict[str, Any]:
    observation = {
        "check": "live-release-currency-alert",
        "state": "target-differs",
        "reason": "exact-commit-mismatch",
        "healthImpact": "none",
        "observedAt": _iso(T0 - 60),
        "releasePath": RELEASE_PATH,
        "manifestPath": RELEASE_MANIFEST,
        "deployed": {"ref": "refs/heads/main", "commit": "a" * 40},
        "target": {"ref": "refs/heads/main", "commit": "b" * 40},
        "resolutionHint": (
            "Review the approved release and required capabilities before rollout; "
            "this observation does not authorize deploying the target."
        ),
    }
    return _alert(
        event_id,
        source=RELEASE_SOURCE,
        instance=RELEASE_INSTANCE,
        evidence=json.dumps(observation, indent=2),
        summary=RELEASE_SUMMARY,
        diagnostics={
            "logHints": [],
            "release": RELEASE_PATH,
            "manifest": RELEASE_MANIFEST,
            "target_ref": "refs/heads/main",
        },
    )


def _daily_health(event_id: str) -> dict[str, Any]:
    """Another key's event that the decision suppresses, so its pass commits the cycle."""
    return {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": "info",
        "source": "daily-health",
        "machine": "host-z",
        "instance": "zz-bot",
        "summary": "daily health ok",
        "evidence": "all checks passed",
        "createdAt": _iso(T0 - 30),
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def _open_record(*, opened: int, last_notified: int = T0 - 7 * HOUR, suppressed: int = 0,
                 **extra: Any) -> dict[str, Any]:
    """An open record whose renotify is due: 7 h since the last page, past the 6 h default."""
    record: dict[str, Any] = {
        "status": "open",
        "eventId": "evt-opening",
        "openedAt": opened,
        "openedIso": _iso(opened),
        "lastSeenAt": last_notified,
        "lastSeenIso": _iso(last_notified),
        "lastSentAt": last_notified,
        "lastSentIso": _iso(last_notified),
        "lastNotifiedAt": last_notified,
        "lastNotifiedIso": _iso(last_notified),
        "suppressedCount": suppressed,
        "generationToken": TOKEN_A,
    }
    record.update(extra)
    return record


def _state(records: dict[str, dict[str, Any]], **top: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "version": 1,
        "openIncidents": copy.deepcopy(records),
        "lastSentAt": {key: record.get("lastSentAt", 0) for key, record in records.items()},
    }
    payload.update(top)
    return payload


def _evidence_lines(event: dict[str, Any]) -> list[str]:
    return str(event.get("evidence") or "").splitlines()


# --- the helper's table --------------------------------------------------------------------


ESCALATION_TABLE: list[tuple[Any, str]] = [
    ("info", "warning"),
    ("warning", "error"),
    ("error", "critical"),
    ("critical", "critical"),
    # Read the way classify_event reads a severity: stripped, case-insensitive.
    (" Warning ", "error"),
    # Anything it cannot read pages.
    (None, "critical"),
    ("", "critical"),
    ("fatal", "critical"),
    (3, "critical"),
    (["warning"], "critical"),
]


def test_escalated_severity_raises_one_step_and_reads_anything_else_as_critical(tmp_path):
    bench = _Bench(tmp_path)
    observed = {repr(sent): bench.mod.escalated_severity(sent) for sent, _expected in ESCALATION_TABLE}
    assert observed == {repr(sent): expected for sent, expected in ESCALATION_TABLE}


# --- age and repeat-count escalation through the send decision ------------------------------


def test_a_warning_open_25_hours_escalates_to_error_not_critical(tmp_path):
    bench = _Bench(tmp_path)
    event = _alert("evt-warning-25h", severity="warning")
    text = bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert event["severity"] == "error"
    assert event["summary"] == ESCALATED_PREFIX + "socket_down on instance-a"
    assert "escalated=true" in _evidence_lines(event)
    assert text.splitlines()[0] == "BOT ERROR - " + ESCALATED_PREFIX + "socket_down on instance-a"
    assert SEVERITY_LINE.format("error") in text.splitlines()
    assert SEVERITY_LINE.format("critical") not in text.splitlines()


def test_pin_an_error_open_25_hours_escalates_to_critical(tmp_path):
    bench = _Bench(tmp_path)
    event = _alert("evt-error-25h", severity="error")
    text = bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert event["severity"] == "critical"
    assert event["summary"] == ESCALATED_PREFIX + "socket_down on instance-a"
    assert "escalated=true" in _evidence_lines(event)
    assert SEVERITY_LINE.format("critical") in text.splitlines()


def test_pin_a_critical_open_25_hours_stays_critical(tmp_path):
    bench = _Bench(tmp_path)
    event = _alert("evt-critical-25h", severity="critical")
    text = bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert event["severity"] == "critical"
    assert event["summary"] == ESCALATED_PREFIX + "socket_down on instance-a"
    assert "escalated=true" in _evidence_lines(event)
    assert SEVERITY_LINE.format("critical") in text.splitlines()


def test_a_warning_escalated_by_repeat_count_alone_escalates_to_error(tmp_path):
    bench = _Bench(tmp_path)
    threshold = bench.mod.INCIDENT_ESCALATE_SUPPRESSED
    event = _alert("evt-warning-repeats", severity="warning")
    # Eight hours old, well under the age threshold; this event is the repeat that
    # reaches the count threshold.
    text = bench.decide(event, _open_record(opened=T0 - 8 * HOUR, suppressed=threshold - 1))
    assert 8 * HOUR < bench.mod.INCIDENT_ESCALATE_SECONDS
    lines = _evidence_lines(event)
    assert f"suppressed_duplicates={threshold}" in lines
    assert f"age_seconds={8 * HOUR}" in lines
    assert "escalated=true" in lines
    assert event["severity"] == "error"
    assert event["summary"] == ESCALATED_PREFIX + "socket_down on instance-a"
    assert SEVERITY_LINE.format("error") in text.splitlines()


_MISSING = object()


@pytest.mark.parametrize("severity", [_MISSING, "fatal", 3], ids=["missing", "unknown", "non-string"])
def test_pin_an_unreadable_severity_still_escalates_to_critical(tmp_path, severity):
    """should_suppress_send cannot reach this: it classifies the event first, and the
    envelope rejects a missing or unknown severity. The branch is called directly to
    pin that it still fails toward paging."""
    bench = _Bench(tmp_path)
    event = _alert("evt-unreadable-25h")
    if severity is _MISSING:
        event.pop("severity")
    else:
        event["severity"] = severity
    record = _open_record(opened=T0 - 25 * HOUR)
    bench.mod.append_still_open_context(event, record, "host-a|instance-a|socket_down", T0, 0, True)
    assert event["severity"] == "critical"
    assert event["summary"] == ESCALATED_PREFIX + "socket_down on instance-a"
    assert "escalated=true" in _evidence_lines(event)


def test_pin_a_warning_open_23_hours_reminds_at_warning_without_escalating(tmp_path):
    bench = _Bench(tmp_path)
    event = _alert("evt-warning-23h", severity="warning")
    text = bench.decide(event, _open_record(opened=T0 - 23 * HOUR))
    assert event["severity"] == "warning"
    assert event["summary"] == "Still-open digest: socket_down on instance-a"
    assert "escalated=false" in _evidence_lines(event)
    assert text.splitlines()[0] == "BOT WARNING - Still-open digest: socket_down on instance-a"
    assert SEVERITY_LINE.format("warning") in text.splitlines()


# --- awaiting physical action keeps its own severity rules ----------------------------------


def _awaiting_alert(event_id: str) -> dict[str, Any]:
    """Same key as a logged-out instance, but not itself a physical signal."""
    return _alert(event_id, severity="warning", source="instance_logged_out",
                  evidence="the instance reported a disconnect")


def test_pin_an_awaiting_physical_reminder_keeps_the_sender_severity_at_any_age(tmp_path):
    bench = _Bench(tmp_path)
    event = _awaiting_alert("evt-awaiting-digest")
    awaiting_at = T0 - 26 * HOUR
    record = _open_record(
        opened=T0 - 30 * HOUR,
        last_notified=T0 - 25 * HOUR,  # past the 24 h awaiting-physical cadence
        status="awaiting_physical",
        awaitingPhysicalAt=awaiting_at,
        awaitingPhysicalIso=_iso(awaiting_at),
        **{bench.mod.AWAITING_PHYSICAL_ANNOUNCED_FIELD: awaiting_at},
    )
    text = bench.decide(event, record)
    lines = _evidence_lines(event)
    assert "incident_status=awaiting_physical" in lines
    assert "escalated=false" in lines
    assert event["severity"] == "warning"
    assert event["summary"] == "Still-open digest, awaiting physical action: instance_logged_out on instance-a"
    assert SEVERITY_LINE.format("warning") in text.splitlines()


def test_pin_an_awaiting_physical_announcement_is_sent_critical(tmp_path):
    bench = _Bench(tmp_path)
    event = _awaiting_alert("evt-awaiting-announce")
    awaiting_at = T0 - HOUR
    record = _open_record(
        opened=T0 - 30 * HOUR,
        last_notified=T0 - 2 * HOUR,
        status="awaiting_physical",
        awaitingPhysicalAt=awaiting_at,
        awaitingPhysicalIso=_iso(awaiting_at),
        **{bench.mod.AWAITING_PHYSICAL_ANNOUNCED_FIELD: 0},  # owed, not yet delivered
    )
    text = bench.decide(event, record)
    assert "escalated=false" in _evidence_lines(event)
    assert event["severity"] == "critical"
    assert event["summary"] == "Awaiting physical action: instance_logged_out on instance-a"
    assert SEVERITY_LINE.format("critical") in text.splitlines()


def test_an_awaiting_physical_announcement_ends_a_retried_reminders_escalation_marker(tmp_path):
    """An escalated reminder's send failed; its incident then moved to
    awaiting physical action, and the retry carries the announcement, which sets critical
    as base did. That write replaces escalation's severity, so the marker ends; the
    recorded severity stays.

    This pins the field rather than an outcome: while the event is critical, every reader
    of the marker (storm candidacy, fingerprint, digest severity, the Pattern D seed and
    the owner copy) gives the same answer with or without it, and the only later severity
    writes (Pattern D, escalation) clear or set it themselves."""
    bench = _Bench(tmp_path)
    event = _awaiting_alert("evt-awaiting-escalated")
    event.update({"severity": "error", "evidence": REMINDER_EVIDENCE})
    event["delivery"].update({"escalatedFromSeverity": "warning", "escalatedNow": True})
    awaiting_at = T0 - HOUR
    record = _open_record(
        opened=T0 - 30 * HOUR,
        last_notified=T0 - 2 * HOUR,
        status="awaiting_physical",
        awaitingPhysicalAt=awaiting_at,
        awaitingPhysicalIso=_iso(awaiting_at),
        **{bench.mod.AWAITING_PHYSICAL_ANNOUNCED_FIELD: 0},
    )
    bench.decide(event, record)
    assert event["summary"] == "Awaiting physical action: instance_logged_out on instance-a"
    assert event["severity"] == "critical"
    assert "escalatedNow" not in event["delivery"]
    assert event["delivery"]["escalatedFromSeverity"] == "warning"


# --- the release-currency observer ----------------------------------------------------------


def test_a_release_currency_drift_open_25_hours_is_an_error_never_critical(tmp_path):
    bench = _Bench(tmp_path)
    event = _release_currency_alert("evt-release-currency-25h")
    text = bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert event["severity"] == "error"
    assert event["summary"] == ESCALATED_PREFIX + RELEASE_SUMMARY
    assert "escalated=true" in _evidence_lines(event)
    assert "  > source: release-currency" in text.splitlines()
    assert SEVERITY_LINE.format("error") in text.splitlines()
    assert SEVERITY_LINE.format("critical") not in text.splitlines()


@pytest.mark.parametrize("outcome", ["fail", "transient"])
def test_a_retried_escalated_warning_is_raised_once_not_once_per_attempt(tmp_path, outcome):
    """A failed send requeues the event carrying the severity its first attempt raised.

    The retry is still due and still escalated, so a raise taken from the event's
    current severity would turn the requeued error into a critical: two steps for one
    reminder, and the daily critical page this change removes.
    """
    bench = _Bench(tmp_path)
    event = _release_currency_alert("evt-release-currency-retry")
    bench.seed(_state({bench.mod.incident_key(event): _open_record(opened=T0 - 25 * HOUR)}))
    path = bench.put(event)
    bench.cycle((path, outcome), (bench.put(_daily_health("evt-daily-1")), "ok"))
    requeued = json.loads(bench.queued(path).read_text(encoding="utf-8"))
    assert requeued["severity"] == "error", "the first attempt raised the warning one step"
    assert requeued["delivery"]["escalatedNow"] is True
    bench.clock.now = T0 + 300
    bench.cycle((bench.queued(path), "ok"))
    assert bench.attempts == [outcome, "ok"]
    assert len(bench.delivered) == 1
    delivered = bench.delivered[0].splitlines()
    assert delivered[0] == "BOT ERROR - " + ESCALATED_PREFIX + RELEASE_SUMMARY
    assert SEVERITY_LINE.format("error") in delivered
    assert SEVERITY_LINE.format("critical") not in delivered
    assert bench.archived(path)["severity"] == "error"


def test_pin_a_recorded_info_cannot_lower_a_critical_event(tmp_path):
    """Raising a recorded "info" one step gives "warning"; escalation must never lower
    the critical the event itself carries (the never-lower clause of escalated_severity)."""
    bench = _Bench(tmp_path)
    event = _alert("evt-forged-info", severity="critical")
    event["delivery"]["escalatedFromSeverity"] = "info"
    text = bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert event["severity"] == "critical"
    assert SEVERITY_LINE.format("critical") in text.splitlines()
    assert SEVERITY_LINE.format("warning") not in text.splitlines()


def test_a_requeued_error_with_its_recorded_warning_stays_error(tmp_path):
    """A requeue keeps its recorded value: the event carries the error its first attempt
    raised and the warning it recorded, and stays error."""
    bench = _Bench(tmp_path)
    event = _release_currency_alert("evt-release-requeued")
    event["severity"] = "error"
    event["delivery"]["escalatedFromSeverity"] = "warning"
    text = bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert event["severity"] == "error"
    assert event["delivery"]["escalatedFromSeverity"] == "warning"
    assert SEVERITY_LINE.format("error") in text.splitlines()
    assert SEVERITY_LINE.format("critical") not in text.splitlines()


def _requeued_owner_reminder(event_id: str, *, recorded: str = "warning", severity: str = "error",
                             machine: str = MACHINE, created: int = T0 - 30,
                             escalated_now: bool = True) -> dict[str, Any]:
    """An owner-route reminder escalated from `recorded` whose send failed, as requeued: the
    severity it now carries, the recorded one, both still-open evidence lines and, unless
    something since overwrote the escalated severity, the escalatedNow marker."""
    event = _alert(
        event_id, severity=severity, source=OWNER_SOURCE, machine=machine, createdAt=_iso(created),
        summary=ESCALATED_PREFIX + "primary model unusable", evidence=REMINDER_EVIDENCE,
    )
    event["delivery"].update({
        "attempts": 1,
        "nextAttemptAtEpoch": T0 - 1,
        "lastError": "the remote rejected the message",
        "escalatedFromSeverity": recorded,
    })
    if escalated_now:
        event["delivery"]["escalatedNow"] = True
    return event


def test_a_requeued_reminder_keeps_its_owner_copy_after_a_state_reinitialisation(tmp_path):
    """The incident state was reinitialised and holds no open incident. The queued
    reminder takes the first-open path; it stays error and its owner copy is kept, as
    base's queued critical was copied."""
    bench = _Bench(tmp_path)
    event = _requeued_owner_reminder("evt-owner-reinit")
    assert bench.mod.should_suppress_send(event, _state({})) is None
    assert event["severity"] == "error"
    assert event["delivery"]["escalatedFromSeverity"] == "warning"
    assert owner_route.qualifies(event, _owner_sources(), True) is None


def test_a_released_held_reminder_keeps_its_recorded_severity(tmp_path):
    """An ambiguous send holds the reminder in processing/; the operator releases it as
    the README documents (delivery.status back to queued, the file moved to outbox/ under
    its original name), and the retry still raises from the recorded warning: it goes out
    at error, not critical."""
    bench = _Bench(tmp_path)
    event = _release_currency_alert("evt-release-held")
    bench.seed(_state({bench.mod.incident_key(event): _open_record(opened=T0 - 25 * HOUR)}))
    path = bench.put(event)
    bench.cycle((path, "ambiguous"), (bench.put(_daily_health("evt-daily-1")), "ok"))
    held = sorted(bench.paths["processing"].glob("*.processing"))
    assert len(held) == 1, "the ambiguous send is held in processing/"
    record = json.loads(held[0].read_text(encoding="utf-8"))
    assert record["severity"] == "error"
    assert record["delivery"]["escalatedFromSeverity"] == "warning"
    assert record["delivery"]["escalatedNow"] is True
    record["delivery"]["status"] = "queued"  # the release edits the status and nothing else
    released = bench.paths["outbox"] / bench.mod.original_name_from_processing(held[0])
    assert released.name == path.name
    released.write_text(json.dumps(record), encoding="utf-8")
    released.chmod(0o600)
    held[0].unlink()
    bench.clock.now = T0 + 300
    bench.cycle((released, "ok"))
    assert bench.attempts == ["ambiguous", "ok"]
    delivered = bench.delivered[0].splitlines()
    assert SEVERITY_LINE.format("error") in delivered
    assert SEVERITY_LINE.format("critical") not in delivered
    assert bench.archived(path)["severity"] == "error"


def test_a_crash_reclaimed_reminder_keeps_its_recorded_severity(tmp_path):
    """A failed send requeues the reminder at error; the dispatcher then dies in the
    retry's send decision, before the send is issued. reclaim_processing returns the
    claim to outbox/, and the next retry still raises from the recorded warning: it goes
    out at error, not critical."""
    bench = _Bench(tmp_path)
    event = _release_currency_alert("evt-release-crash")
    bench.seed(_state({bench.mod.incident_key(event): _open_record(opened=T0 - 25 * HOUR)}))
    path = bench.put(event)
    bench.cycle((path, "fail"), (bench.put(_daily_health("evt-daily-1")), "ok"))
    bench.clock.now = T0 + 300
    with patch.object(bench.mod, "should_suppress_send", side_effect=RuntimeError("the dispatcher stopped")):
        with pytest.raises(RuntimeError, match="the dispatcher stopped"):
            bench.cycle((bench.queued(path), "ok"))
    [claimed] = sorted(bench.paths["processing"].glob("*.processing"))
    record = json.loads(claimed.read_text(encoding="utf-8"))
    assert record["severity"] == "error"
    assert record["delivery"]["escalatedFromSeverity"] == "warning"
    assert record["delivery"]["escalatedNow"] is True
    assert bench.mod.reclaim_processing(bench.paths) == 1
    bench.cycle((bench.queued(path), "ok"))
    assert bench.attempts == ["fail", "ok"]
    delivered = bench.delivered[0].splitlines()
    assert SEVERITY_LINE.format("error") in delivered
    assert SEVERITY_LINE.format("critical") not in delivered
    assert bench.archived(path)["severity"] == "error"


def test_a_dead_lettered_reminder_keeps_its_recorded_severity(tmp_path):
    """Dead-letter is terminal: the dispatcher never reprocesses dead-letter/. The record
    it keeps holds the raised severity and the recorded warning, so the enclosed event,
    requeued by hand with its status set back to queued, still raises from the warning:
    it goes out at error, not critical."""
    os.environ["BOT_ERRORS_DELIVERY_MAX_ATTEMPTS"] = "1"
    bench = _Bench(tmp_path)
    event = _release_currency_alert("evt-release-dead")
    bench.seed(_state({bench.mod.incident_key(event): _open_record(opened=T0 - 25 * HOUR)}))
    path = bench.put(event)
    bench.cycle((path, "fail"), (bench.put(_daily_health("evt-daily-1")), "ok"))
    [dead] = sorted(bench.paths["dead_letter"].glob("*.dead_letter.json"))
    enclosed = json.loads(dead.read_text(encoding="utf-8"))["event"]
    assert enclosed["severity"] == "error"
    assert enclosed["delivery"]["escalatedFromSeverity"] == "warning"
    assert enclosed["delivery"]["escalatedNow"] is True
    enclosed["delivery"]["status"] = "queued"
    bench.clock.now = T0 + 300
    requeued = bench.put(enclosed)
    bench.cycle((requeued, "ok"))
    assert bench.attempts == ["fail", "ok"]
    delivered = bench.delivered[0].splitlines()
    assert SEVERITY_LINE.format("error") in delivered
    assert SEVERITY_LINE.format("critical") not in delivered
    assert bench.archived(requeued)["severity"] == "error"


# Classified transient by its suffix (classify_failure_mode), with no environment needed.
TRANSIENT_SOURCE = "peer_online_ssh_timeout"


def test_a_critical_sender_rewritten_by_transient_tiering_still_escalates_from_critical(tmp_path):
    """Pattern D restores a promoted transient to the first severity it saw, which can be
    below what this occurrence's sender sent. Escalation starts from the higher of the two,
    so a critical sender never goes out below critical."""
    bench = _Bench(tmp_path)
    event = _alert("evt-transient-critical", severity="critical", source=TRANSIENT_SOURCE)
    transient = {
        bench.mod.incident_key(event): {
            "transientSince": T0 - 26 * HOUR,
            "firstSeverity": "warning",
            "promoted": True,
            "promotedAt": T0 - 25 * HOUR,
            "lastSeenAt": T0 - HOUR,
        }
    }
    text = bench.decide(event, _open_record(opened=T0 - 25 * HOUR), transientState=transient)
    assert event["diagnostics"]["transientPromoted"] is True
    assert "escalated=true" in _evidence_lines(event)
    assert event["severity"] == "critical"
    assert event["delivery"]["escalatedFromSeverity"] == "critical"
    assert SEVERITY_LINE.format("critical") in text.splitlines()


def test_a_transient_record_started_by_an_escalated_retry_restores_critical_as_base_did(tmp_path):
    """A warning-origin reminder escalated to error failed and was
    requeued; a clear then removed its incident and Pattern D's record. The retry starts
    a new Pattern D record, which base started from the critical its retry carried. The
    next episode, promoted past the window, must be restored to critical as in base, not
    to the error this retry carries."""
    bench = _Bench(tmp_path)
    retry = _alert("evt-transient-retry", severity="error", source=TRANSIENT_SOURCE,
                   summary=ESCALATED_PREFIX + "peer unreachable", evidence=REMINDER_EVIDENCE)
    retry["delivery"].update({"escalatedFromSeverity": "warning", "escalatedNow": True})
    state = _state({})
    reason = bench.mod.should_suppress_send(retry, state)
    assert reason is not None and reason.startswith("transient_held")
    assert state["transientState"][bench.mod.incident_key(retry)]["firstSeverity"] == "critical"
    assert "escalatedNow" not in retry["delivery"], "base's hold overwrote the critical with warning"
    bench.clock.now = T0 + bench.mod.TRANSIENT_PROMOTE_SECONDS
    episode = _alert("evt-transient-next", severity="warning", source=TRANSIENT_SOURCE)
    assert bench.mod.should_suppress_send(episode, state) is None
    assert episode["diagnostics"]["transientPromoted"] is True
    assert episode["severity"] == "critical"


# --- storm collapse keeps a requeued escalated reminder -------------------------------------

STORM_HOSTS = ("host-a", "host-b", "host-c")


def _requeued_reminder(event_id: str, machine: str, created: int, **delivery: Any) -> dict[str, Any]:
    """A release-currency reminder escalated warning -> error whose send failed, as requeued,
    still carrying the escalatedNow marker its escalation set."""
    event = _release_currency_alert(event_id)
    event.update({
        "machine": machine,
        "severity": "error",
        "summary": ESCALATED_PREFIX + RELEASE_SUMMARY,
        "evidence": event["evidence"] + "\nincident_still_open=true\nescalated=true",
        "createdAt": _iso(created),
    })
    event["delivery"] = {
        "attempts": 1,
        "status": "queued",
        "nextAttemptAtEpoch": T0 - 1,
        "lastError": "the remote rejected the message",
        "escalatedNow": True,
        **delivery,
    }
    return event


def _storm_bench(tmp_path: Path) -> _Bench:
    os.environ["BOT_ERRORS_STORM_THRESHOLD"] = "3"
    os.environ["BOT_ERRORS_STORM_WINDOW_SECONDS"] = "120"
    bench = _Bench(tmp_path)
    bench.seed(_state({}))
    return bench


def _put_requeued_reminders(
    bench: _Bench, hosts: tuple[str, ...], recorded: tuple[str, ...], created: int
) -> None:
    """One requeued escalated reminder per host, each at the severity escalation gave its recorded one."""
    for offset, (machine, sender) in enumerate(zip(hosts, recorded)):
        reminder = _requeued_reminder(f"evt-storm-{machine}", machine, created + offset, escalatedFromSeverity=sender)
        reminder["severity"] = bench.mod.escalated_severity(sender)
        bench.put(reminder)


def _queued_digest_paths(bench: _Bench) -> list[Path]:
    return [
        path for path in sorted(bench.paths["outbox"].glob("*.json"))
        if json.loads(path.read_text(encoding="utf-8")).get("source") == "storm-collapse"
    ]


def test_requeued_escalated_reminders_from_three_hosts_collapse_into_one_critical_digest(tmp_path):
    """Base requeued these at critical, a storm candidate, and its digest paged critical.
    At error they must still collapse, and the digest still pages critical."""
    bench = _storm_bench(tmp_path)
    _put_requeued_reminders(bench, STORM_HOSTS, ("warning",) * 3, T0 - 60)
    assert bench.collapse() == 3
    queued = bench.outbox_events()
    assert [event["id"] for event in queued if event["id"].startswith("evt-storm-")] == []
    digests = [event for event in queued if event.get("source") == "storm-collapse"]
    assert len(digests) == 1, "one digest replaces the three reminders"
    digest = digests[0]
    assert digest["severity"] == "critical"
    assert "severity:critical" in _evidence_lines(digest)
    assert digest["storm"]["collapsedEvents"] == 3
    assert digest["storm"]["hosts"] == list(STORM_HOSTS)


def test_requeued_reminders_raised_from_different_severities_collapse_into_one_critical_digest(tmp_path):
    """Two warning-origin reminders requeued at error and one error-origin reminder requeued
    at critical: base requeued all three at critical, one fingerprint, one critical digest,
    and so must this."""
    bench = _storm_bench(tmp_path)
    _put_requeued_reminders(bench, STORM_HOSTS, ("warning", "warning", "error"), T0 - 60)
    assert bench.collapse() == 3
    digests = [event for event in bench.outbox_events() if event.get("source") == "storm-collapse"]
    assert len(digests) == 1
    assert digests[0]["severity"] == "critical"
    assert digests[0]["storm"]["collapsedEvents"] == 3
    assert digests[0]["storm"]["hosts"] == list(STORM_HOSTS)


LATE_HOSTS = ("host-d", "host-e", "host-f")


def test_a_later_revision_of_an_escalated_storm_window_keeps_its_critical_page(tmp_path):
    """Three warning-origin reminders storm: the digest that pages the window is critical,
    as base's was. Once it is sent, three more from other hosts land in the same window,
    one raised from error to critical. They become a superseding revision, which the
    window's force-notify cooldown may absorb, so the window's critical must already have
    paged; the revision carries them at critical too, never below base.

    The digest is delivered by moving it to sent/, as the storm suites do. process_one
    would drop it here, at base too: its diagnostics.queue names the bench's temporary
    outbox, which the test-leak patterns match."""
    bench = _storm_bench(tmp_path)
    _put_requeued_reminders(bench, STORM_HOSTS, ("warning",) * 3, T0 - 60)
    assert bench.collapse() == 3
    [first] = _queued_digest_paths(bench)
    page = json.loads(first.read_text(encoding="utf-8"))
    assert page["severity"] == "critical"
    assert SEVERITY_LINE.format("critical") in bench.mod.format_event(page).splitlines()
    os.replace(first, bench.paths["sent"] / f"{first.name}.{T0}.sent")
    _put_requeued_reminders(bench, LATE_HOSTS, ("warning", "warning", "error"), T0 - 50)
    assert bench.collapse() == 3
    queued = bench.outbox_events()
    assert [event["id"] for event in queued if event["id"].startswith("evt-storm-")] == []
    [revision] = [event for event in queued if event.get("source") == "storm-collapse"]
    assert revision["id"].endswith("-v2")
    assert revision["severity"] == "critical"
    assert "severity:critical" in _evidence_lines(revision)
    assert revision["storm"]["collapsedEvents"] == 3
    assert revision["storm"]["hosts"] == list(LATE_HOSTS)


def test_pin_alerts_that_were_not_escalated_keep_their_severity_in_the_storm_fingerprint(tmp_path):
    """Only an escalated reminder's fingerprint is pinned to critical: first-open alerts at
    warning and at critical are different storms, so neither group reaches the threshold."""
    bench = _storm_bench(tmp_path)
    for offset, (machine, severity) in enumerate(zip(STORM_HOSTS, ("warning", "warning", "critical"))):
        bench.put(_alert(
            f"evt-first-{machine}", severity=severity, machine=machine, createdAt=_iso(T0 - 60 + offset),
        ))
    assert bench.collapse() == 0
    assert len(bench.outbox_events()) == 3


@properties
@given(recorded=st.sampled_from(SEVERITIES))
@example(recorded="warning")
@example(recorded="info")
def test_an_escalated_reminder_has_the_storm_fingerprint_base_gave_it(recorded):
    """Base escalated a reminder by setting it to critical and recorded nothing. At the
    severity this dispatcher writes, one step above the recorded one, the reminder must
    have the fingerprint of the critical, unrecorded reminder base queued, so storms
    group and persisted fingerprint hashes match."""
    dispatcher = _pure_dispatcher()
    reminder = _requeued_reminder("evt-storm-fingerprint", "host-a", T0 - 60, escalatedFromSeverity=recorded)
    reminder["severity"] = dispatcher.escalated_severity(recorded)
    assert dispatcher.storm_fingerprint(reminder) == dispatcher.storm_fingerprint(_as_base_queued(reminder, "critical"))


def _as_base_queued(event: dict[str, Any], severity: str) -> dict[str, Any]:
    """Base's copy of `event`: the same event at `severity`, with neither R73 field."""
    twin = copy.deepcopy(event)
    twin["severity"] = severity
    for field in ("escalatedFromSeverity", "escalatedNow"):
        twin["delivery"].pop(field, None)
    return twin


def test_pin_a_reminder_tiered_below_its_escalation_is_treated_by_its_own_severity_as_base_did(tmp_path):
    """Three error-origin owner-route reminders from three hosts
    were escalated to critical; Pattern D later restored one retry to error, which ended
    its escalatedNow marker but left the recorded severity and the evidence lines. Base
    saw two critical candidates and an error it never admits: below the threshold, no
    collapse, and the two critical reminders keep their owner copies."""
    bench = _storm_bench(tmp_path)
    reminders = [
        _requeued_owner_reminder(
            f"evt-owner-storm-{machine}", recorded="error", severity=severity,
            machine=machine, created=T0 - 60 + offset, escalated_now=severity == "critical",
        )
        for offset, (machine, severity) in enumerate(zip(STORM_HOSTS, ("critical", "critical", "error")))
    ]
    assert [bench.mod.is_storm_candidate(reminder) for reminder in reminders] == [True, True, False]
    for reminder in reminders:
        base_copy = _as_base_queued(reminder, reminder["severity"])
        assert bench.mod.storm_fingerprint(reminder) == bench.mod.storm_fingerprint(base_copy)
        bench.put(reminder)
    assert bench.collapse() == 0
    assert sorted(event["id"] for event in bench.outbox_events()) == sorted(r["id"] for r in reminders)
    assert [owner_route.qualifies(r, _owner_sources(), True) for r in reminders] == [None, None, "not_critical"]


def _escalated_transient_owner_reminder(bench: _Bench, machine: str, created: int) -> dict[str, Any]:
    """An aged warning reminder of an owner-route source configured as transient. Its
    incident opened once Pattern D promoted it, so its record is promoted; the decision
    restores the warning and escalates it to error (base: critical)."""
    event = _alert(f"evt-route-{machine}", severity="warning", source=OWNER_SOURCE,
                   machine=machine, createdAt=_iso(created))
    key = bench.mod.incident_key(event)
    promoted = {"transientSince": T0 - 26 * HOUR, "firstSeverity": "warning", "promoted": True,
                "promotedAt": T0 - 25 * HOUR, "lastSeenAt": T0 - HOUR}
    state = _state({key: _open_record(opened=T0 - 25 * HOUR)}, transientState={key: promoted})
    assert bench.mod.should_suppress_send(event, state) is None
    assert event["severity"] == "error"
    assert event["delivery"]["escalatedNow"] is True
    return event


def _requeue(bench: _Bench, event: dict[str, Any]) -> None:
    """The send failed: the event goes back to outbox/ as the decision left it."""
    event["delivery"].update({"status": "queued", "attempts": 1, "nextAttemptAtEpoch": bench.clock.now - 1,
                              "lastError": "the remote rejected the message"})
    bench.put(event)


def _restored_by_a_newer_transient_record(bench: _Bench) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Three hosts' reminders escalated warning -> error; the third, held, is later restored
    to error by a transient record a newer occurrence started, up to its first-open send.
    Returns the three reminders and the incident state it was decided on."""
    # 1. Each host's aged warning reminder escalates to error (base: critical).
    reminders = [_escalated_transient_owner_reminder(bench, machine, T0 - 60 + offset)
                 for offset, machine in enumerate(STORM_HOSTS)]
    restored = reminders[2]
    # 2. While the third reminder is held, its incident closes, and the transient record goes with it.
    state = _state({})
    # 3. A fresh occurrence at error (the sender's severity varies) starts a new transient record.
    bench.clock.now = T0 + 60
    fresh = _alert("evt-route-fresh", severity="error", source=OWNER_SOURCE, machine=restored["machine"])
    assert bench.mod.should_suppress_send(fresh, state).startswith("transient_held")
    assert state["transientState"][bench.mod.incident_key(restored)]["firstSeverity"] == "error"
    # 4. Released after the promotion window, the reminder is restored to error and sent first-open.
    bench.clock.now = T0 + 60 + bench.mod.TRANSIENT_PROMOTE_SECONDS
    assert bench.mod.should_suppress_send(restored, state) is None
    assert restored["diagnostics"]["transientPromoted"] is True
    assert restored["severity"] == "error"
    return reminders, state


def test_a_reminder_restored_to_error_by_a_newer_transient_record_is_treated_as_base_did(tmp_path):
    """Pattern D restored the third reminder to the error a newer transient record saw,
    which ends its escalatedNow marker; the recorded warning and the evidence lines
    remain. Its send fails again, and all three requeues land in one storm window. Base
    saw two critical candidates and an error it never admits: below the threshold, no
    collapse, and the two critical reminders keep their owner copies."""
    os.environ["BOT_ERRORS_TRANSIENT_SOURCES"] = OWNER_SOURCE
    bench = _storm_bench(tmp_path)
    reminders, _ = _restored_by_a_newer_transient_record(bench)
    for reminder in reminders:
        _requeue(bench, reminder)
    assert [bench.mod.is_storm_candidate(reminder) for reminder in reminders] == [True, True, False]
    base_severities = ("critical", "critical", "error")
    for reminder, severity in zip(reminders, base_severities):
        assert bench.mod.storm_fingerprint(reminder) == bench.mod.storm_fingerprint(_as_base_queued(reminder, severity))
    assert bench.collapse() == 0
    assert sorted(event["id"] for event in bench.outbox_events()) == sorted(r["id"] for r in reminders)
    assert [owner_route.qualifies(r, _owner_sources(), True) for r in reminders] == [None, None, "not_critical"]


def test_a_transient_record_restarted_by_a_restored_retry_stores_its_own_severity(tmp_path):
    """After the sequence above, the restored reminder's send fails and a second removal
    (a reinitialisation) drops its transient record. The retry starts a new one; base
    stored the error the retry carried, and so must this."""
    os.environ["BOT_ERRORS_TRANSIENT_SOURCES"] = OWNER_SOURCE
    bench = _storm_bench(tmp_path)
    reminders, _ = _restored_by_a_newer_transient_record(bench)
    restored = reminders[2]
    reinitialised = _state({})
    assert bench.mod.should_suppress_send(restored, reinitialised).startswith("transient_held")
    assert reinitialised["transientState"][bench.mod.incident_key(restored)]["firstSeverity"] == "error"


_ABSENT = object()


# A recorded value: absent, any unreadable value, or a known severity.
_RECORDED = st.one_of(st.just(_ABSENT), st.sampled_from(SEVERITIES), st.none(), st.integers(),
                      st.text(max_size=12).filter(lambda text: text.strip().lower() not in SEVERITIES))


@properties
@given(recorded=_RECORDED, escalated_line=st.booleans(), marker=st.booleans())
@example(recorded="warning", escalated_line=True, marker=True)
@example(recorded="warning", escalated_line=True, marker=False)
@example(recorded="warning", escalated_line=False, marker=True)
@example(recorded="error", escalated_line=True, marker=True)
@example(recorded="fatal", escalated_line=True, marker=True)
@example(recorded=_ABSENT, escalated_line=True, marker=True)
def test_an_error_event_is_a_storm_candidate_only_as_a_reminder_escalated_now(recorded, escalated_line, marker):
    """An error is a candidate only while escalation's error stands: the escalatedNow
    marker, a recorded info or warning, and the escalated=true line. A recorded error or
    critical escalates to critical, so an error carrying one was restored below it; a
    missing marker means base overwrote its critical. Base never admitted an error."""
    reminder = _requeued_reminder("evt-storm-candidate", "host-a", T0 - 60)
    if not escalated_line:
        reminder["evidence"] = reminder["evidence"].replace("\nescalated=true", "")
    if not marker:
        del reminder["delivery"]["escalatedNow"]
    if recorded is not _ABSENT:
        reminder["delivery"]["escalatedFromSeverity"] = recorded
    escalated_to_error = isinstance(recorded, str) and recorded.strip().lower() in {"info", "warning"}
    assert _pure_dispatcher().is_storm_candidate(reminder) is (marker and escalated_to_error and escalated_line)


# --- the owner copy keeps its escalated reminders -------------------------------------------

# An owner-route source whose producer sends at warning
# (tests/runtimes/agent/runtime.test.ts: primary_model_unusable, 'warning').
OWNER_SOURCE = "primary_model_unusable"
OWNER_JID = "15550000001@s.whatsapp.net"  # an allowed fixture JID; the route passes it through unparsed


def _owner_sources() -> list[str]:
    return [source for source in owner_route.DEFAULT_SOURCES.split(",") if source]


class _OwnerRecorder:
    def __init__(self) -> None:
        self.sends: list[dict[str, Any]] = []
        self.emails: list[tuple[str, str]] = []
        self.logs: list[dict[str, Any]] = []

    def rpc(self, socket_path, method, params, timeout=15.0, **_kwargs):
        self.sends.append({"method": method, "params": params})
        return {"ok": True}

    def email(self, subject: str, body: str, timeout: float = 20) -> bool:
        self.emails.append((subject, body))
        return True

    def log(self, record: dict[str, Any]) -> None:
        self.logs.append(record)


def _route_owner(event: dict[str, Any], rec: _OwnerRecorder, state_dir: Path, key: str) -> None:
    owner_route.route_owner_critical(
        event,
        key=key,
        is_alert=True,
        group_text="group text",
        state_dir=state_dir,
        json_rpc_call=rec.rpc,
        email_fallback=rec.email,
        log=rec.log,
    )


@pytest.mark.parametrize("field", ["DELIVERY_ESCALATED_FROM_FIELD", "DELIVERY_ESCALATED_NOW_FIELD"])
def test_the_owner_route_reads_the_fields_the_dispatcher_writes(tmp_path, field):
    """The copy rests on the recorded severity and the escalatedNow marker the decision
    wrote: without either one the same escalated reminder gets no copy."""
    bench = _Bench(tmp_path)
    event = _alert("evt-owner-consumes", severity="warning", source=OWNER_SOURCE)
    bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert owner_route.qualifies(event, _owner_sources(), True) is None
    del event["delivery"][getattr(bench.mod, field)]
    assert owner_route.qualifies(event, _owner_sources(), True) == "not_critical"


def test_an_escalated_warning_from_an_owner_source_keeps_its_owner_copy(tmp_path):
    bench = _Bench(tmp_path)
    assert OWNER_SOURCE in _owner_sources()
    event = _alert("evt-owner-25h", severity="warning", source=OWNER_SOURCE)
    bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert event["severity"] == "error"
    assert "escalated=true" in _evidence_lines(event)
    assert owner_route.qualifies(event, _owner_sources(), True) is None


@pytest.mark.parametrize("severity", ["warning", "error"])
def test_pin_a_non_escalated_reminder_from_an_owner_source_gets_no_owner_copy(tmp_path, severity):
    bench = _Bench(tmp_path)
    event = _alert(f"evt-owner-23h-{severity}", severity=severity, source=OWNER_SOURCE)
    bench.decide(event, _open_record(opened=T0 - 23 * HOUR))
    assert event["severity"] == severity
    assert "escalated=false" in _evidence_lines(event)
    assert owner_route.qualifies(event, _owner_sources(), True) == "not_critical"


@pytest.mark.parametrize("severity", ["warning", "error"])
def test_pin_a_first_open_below_critical_from_an_owner_source_gets_no_owner_copy(severity):
    event = _alert(f"evt-owner-first-{severity}", severity=severity, source=OWNER_SOURCE)
    assert owner_route.qualifies(event, _owner_sources(), True) == "not_critical"


def test_pin_an_escalated_release_currency_reminder_gets_no_owner_copy(tmp_path):
    bench = _Bench(tmp_path)
    assert RELEASE_SOURCE not in _owner_sources()
    event = _release_currency_alert("evt-release-owner")
    bench.decide(event, _open_record(opened=T0 - 25 * HOUR))
    assert "escalated=true" in _evidence_lines(event)
    assert owner_route.qualifies(event, _owner_sources(), True) == "source_not_routed"


# The still-open lines the dispatcher appends to an escalated reminder, around the sender's own text.
REMINDER_EVIDENCE = "probe failed\nincident_still_open=true\nage_seconds=90000\nescalated=true"


@properties
@given(missing=st.sampled_from(["escalatedFromSeverity", "escalatedNow", "incident_still_open=true", "escalated=true"]))
@example(missing="escalatedFromSeverity")
@example(missing="escalatedNow")
@example(missing="incident_still_open=true")
@example(missing="escalated=true")
def test_an_owner_reminder_at_its_escalated_severity_missing_one_marker_gets_no_owner_copy(missing):
    """At error with a recorded warning, the severity escalation gives, so only the marker
    left out can refuse the copy: either delivery field, the still-open line or the
    escalated line."""
    reminder = _requeued_owner_reminder("evt-owner-markers")
    # Control: with all four markers the same reminder is copied.
    assert owner_route.qualifies(reminder, _owner_sources(), True) is None
    if missing in reminder["delivery"]:
        del reminder["delivery"][missing]
    else:
        reminder["evidence"] = "\n".join(line for line in REMINDER_EVIDENCE.splitlines() if line != missing)
    assert owner_route.qualifies(reminder, _owner_sources(), True) == "not_critical"


# Any recorded value that is not a string naming a known severity (after strip and
# lower-casing, as owner_route reads it): other JSON types, unknown words, empty text.
_UNREADABLE_SEVERITY = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(),
    st.floats(allow_nan=False, allow_infinity=False),
    st.lists(st.text(max_size=8), max_size=3),
    st.dictionaries(st.text(max_size=8), st.text(max_size=8), max_size=2),
    st.text(max_size=16).filter(lambda text: text.strip().lower() not in SEVERITIES),
)


@properties
@given(value=_UNREADABLE_SEVERITY)
@example(value="fatal")
@example(value="")
@example(value=None)
@example(value=3)
def test_a_recorded_severity_outside_the_known_set_gets_no_owner_copy(value):
    reminder = _requeued_owner_reminder("evt-owner-reminder")
    # Control: the same reminder with a readable recorded severity is copied, so the
    # refusal below is the value's doing.
    assert owner_route.qualifies(reminder, _owner_sources(), True) is None
    reminder["delivery"]["escalatedFromSeverity"] = value
    assert owner_route.qualifies(reminder, _owner_sources(), True) == "not_critical"


@properties
@given(value=_UNREADABLE_SEVERITY)
@example(value="fatal")
@example(value=None)
@example(value=3)
def test_an_unreadable_recorded_severity_is_replaced_by_the_senders(value):
    """A stored value that is not a readable severity counts as missing: escalation
    records the sender's warning in its place and raises from that, to error."""
    event = _alert("evt-unreadable-recorded", severity="warning")
    event["delivery"]["escalatedFromSeverity"] = value
    _pure_dispatcher().append_still_open_context(
        event, _open_record(opened=T0 - 25 * HOUR), "host-a|instance-a|socket_down", T0, 0, True,
        sender_severity="warning",
    )
    assert event["delivery"]["escalatedFromSeverity"] == "warning"
    assert event["severity"] == "error"


# The rule both copies of escalated_now implement, written out independently of either.
_ESCALATION_STEP_SPEC = {"info": "warning", "warning": "error", "error": "critical", "critical": "critical"}
_SEVERITY_VALUE = st.one_of(st.sampled_from(SEVERITIES), st.sampled_from([" Error ", "WARNING"]),
                            st.none(), st.integers(), st.text(max_size=8))


def _readable(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() in SEVERITIES


_LINES_WITH_ESCALATED = "probe failed\nincident_still_open=true\nescalated=true"
# Evidence as a reminder carries it (text with or without the escalated=true line), or a
# non-string value holding the same words, which neither copy may read as the line.
_EVIDENCE = st.one_of(
    st.sampled_from([_LINES_WITH_ESCALATED, "probe failed\nincident_still_open=true"]),
    st.dictionaries(st.sampled_from(["evidence", "escalated", "detail"]),
                    st.sampled_from(["escalated=true", "true", _LINES_WITH_ESCALATED]), max_size=2),
    st.lists(st.sampled_from(["escalated=true", _LINES_WITH_ESCALATED]), max_size=3),
)
# The escalatedNow marker as JSON could carry it: only the boolean true counts.
_MARKER = st.one_of(st.just(_ABSENT), st.sampled_from([True, False, "true", 1, None]))


@properties
@given(recorded=_RECORDED, severity=_SEVERITY_VALUE, evidence=_EVIDENCE, marker=_MARKER)
@example(recorded="warning", severity="error", evidence=_LINES_WITH_ESCALATED, marker=True)
@example(recorded="warning", severity="error", evidence=_LINES_WITH_ESCALATED, marker=_ABSENT)
@example(recorded="warning", severity="error", evidence=_LINES_WITH_ESCALATED, marker="true")
@example(recorded="error", severity="error", evidence=_LINES_WITH_ESCALATED, marker=True)
@example(recorded="error", severity="critical", evidence=_LINES_WITH_ESCALATED, marker=True)
@example(recorded="warning", severity="warning", evidence=_LINES_WITH_ESCALATED, marker=True)
@example(recorded="warning", severity="error", evidence="probe failed\nincident_still_open=true", marker=True)
@example(recorded="warning", severity="error", evidence={"evidence": _LINES_WITH_ESCALATED}, marker=True)
@example(recorded="warning", severity="error", evidence=["escalated=true"], marker=True)
@example(recorded="fatal", severity="critical", evidence=_LINES_WITH_ESCALATED, marker=True)
def test_the_dispatcher_and_the_owner_route_share_one_escalated_now_rule(recorded, severity, evidence, marker):
    """One table for the dispatcher's escalated_now and owner_route's copy: the boolean
    escalatedNow marker, a readable recorded severity, an escalated=true line in string
    evidence, and a current severity at least the one-step escalation of the recorded one."""
    event = _alert("evt-escalated-now", evidence=evidence)
    event["severity"] = severity
    if recorded is not _ABSENT:
        event["delivery"]["escalatedFromSeverity"] = recorded
    if marker is not _ABSENT:
        event["delivery"]["escalatedNow"] = marker
    expected = (
        marker is True and _readable(recorded) and _readable(severity)
        and isinstance(evidence, str) and "escalated=true" in evidence.splitlines()
        and SEVERITIES.index(severity.strip().lower())
        <= SEVERITIES.index(_ESCALATION_STEP_SPEC[recorded.strip().lower()])
    )
    assert _pure_dispatcher().escalated_now(event) is expected
    assert owner_route.escalated_now(event) is expected


def test_pin_a_retried_reminder_sent_below_its_escalation_gets_no_owner_copy(tmp_path):
    """Its incident gone (a stale auto-close removes the record but leaves Pattern D's
    promoted record), a retried escalated reminder of an owner-route source configured
    as transient takes the first-open path, and Pattern D restores the warning the
    transient first saw. Base sent that warning and copied nothing; the recorded field and
    evidence lines must not earn a copy below the severity escalation gives."""
    os.environ["BOT_ERRORS_TRANSIENT_SOURCES"] = OWNER_SOURCE
    bench = _Bench(tmp_path)
    event = _requeued_owner_reminder("evt-owner-tiered")
    promoted = {
        "transientSince": T0 - 26 * HOUR,
        "firstSeverity": "warning",
        "promoted": True,
        "promotedAt": T0 - 25 * HOUR,
        "lastSeenAt": T0 - HOUR,
    }
    state = _state({}, transientState={bench.mod.incident_key(event): promoted})
    assert bench.mod.should_suppress_send(event, state) is None
    assert event["diagnostics"]["transientPromoted"] is True
    assert event["severity"] == "warning"
    assert event["delivery"]["escalatedFromSeverity"] == "warning"
    assert owner_route.qualifies(event, _owner_sources(), True) == "not_critical"


def test_a_forged_escalation_field_outside_the_owner_sources_gets_no_owner_copy(tmp_path, monkeypatch):
    for name in list(os.environ):
        if name.startswith("BOT_ERRORS_OWNER_ROUTE_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_JID", OWNER_JID)
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_SOCKET", str(tmp_path / "line.sock"))
    monkeypatch.setattr(owner_route, "validate_send_acceptance", lambda result, jid: {"audit_receipt": "r1"})
    rec = _OwnerRecorder()
    # At error with a recorded warning, the severity escalation gives, so only the source
    # can refuse the copy.
    forged = _alert("evt-forged", severity="error", source="health_body_degraded",
                    evidence="incident_still_open=true\nescalated=true\nage_seconds=90000")
    forged["delivery"].update({"escalatedFromSeverity": "warning", "escalatedNow": True})
    assert owner_route.qualifies(forged, _owner_sources(), True) == "source_not_routed"
    _route_owner(forged, rec, tmp_path, "host-a|instance-a|health_body_degraded")
    assert rec.sends == [] and rec.emails == []
    assert not (tmp_path / "owner-route-state.json").exists()
    # Control: the same harness does send a qualifying copy, so the silence above is a decision.
    _route_owner(_alert("evt-owner-critical", severity="critical", source=OWNER_SOURCE), rec, tmp_path,
                 f"host-a|instance-a|{OWNER_SOURCE}")
    assert len(rec.sends) == 1 and len(rec.emails) == 1


# --- the collector relay keeps the escalation fields ----------------------------------------

# The collector suites' shared scaffolding, loaded under its own name as they load it.
_COLLECTOR_CONFTEST_SPEC = importlib.util.spec_from_file_location(
    "bot_errors_collector_test_conftest_age_escalation", _TESTS_DIR / "conftest.py"
)
_collector_conftest = importlib.util.module_from_spec(_COLLECTOR_CONFTEST_SPEC)  # type: ignore[arg-type]
_COLLECTOR_CONFTEST_SPEC.loader.exec_module(_collector_conftest)  # type: ignore[union-attr]

FRESH_RELAY_DELIVERY = {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None}


def _collector(tmp_path: Path) -> tuple[Any, Path, Path]:
    """The collector, with its own state root and the hub outbox it relays into."""
    state_dir, outbox_dir = tmp_path / "collector", tmp_path / "hub-outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return _collector_conftest._load_mod_with_dirs(state_dir, outbox_dir), state_dir, outbox_dir


def _relay(tmp_path: Path, event: dict[str, Any]) -> dict[str, Any]:
    """Relay `event` through the collector's relay_event, as a claimed remote outbox file,
    and return what the hub outbox holds."""
    collector, state_dir, outbox_dir = _collector(tmp_path)
    record = {"payload": json.dumps(event), "claim": "/remote/processing/claim-1.relay", "name": "claim-1.json"}
    with _collector_conftest._env(state_dir, outbox_dir):
        path = collector.relay_event("host-b", "/remote/root", record)
    assert path.parent == outbox_dir
    return json.loads(path.read_text(encoding="utf-8"))


def test_a_relayed_escalated_reminder_keeps_its_fields_and_its_owner_copy_at_the_hub(tmp_path, monkeypatch):
    """A collected host's dispatcher escalated an owner-route warning to error and its
    send failed; the collector claims the requeued file. Base relayed its
    critical, so the hub sent it first-open at critical with an owner copy. The relay starts
    a fresh delivery block for the hub's attempts but keeps the two escalation fields, so
    the hub sees a reminder escalated now and copies it."""
    relayed = _relay(tmp_path, _requeued_owner_reminder("evt-relay-escalated", machine="host-b"))
    assert relayed["severity"] == "error"
    assert relayed["delivery"] == {**FRESH_RELAY_DELIVERY, "escalatedFromSeverity": "warning", "escalatedNow": True}
    bench = _Bench(tmp_path)
    assert bench.mod.escalated_now(relayed) is True
    assert bench.mod.should_suppress_send(relayed, _state({})) is None, "a first-open send at the hub"
    assert relayed["severity"] == "error"
    assert owner_route.qualifies(relayed, _owner_sources(), True) is None
    for name in list(os.environ):
        if name.startswith("BOT_ERRORS_OWNER_ROUTE_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_JID", OWNER_JID)
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_SOCKET", str(tmp_path / "line.sock"))
    monkeypatch.setattr(owner_route, "validate_send_acceptance", lambda result, jid: {"audit_receipt": "r1"})
    rec = _OwnerRecorder()
    _route_owner(relayed, rec, tmp_path, bench.mod.incident_key(relayed))
    assert len(rec.sends) == 1 and len(rec.emails) == 1


def test_pin_a_relayed_event_without_escalation_fields_arrives_with_a_fresh_delivery_block(tmp_path):
    """The remote's own delivery bookkeeping (attempts, status, last error) stays behind:
    the hub starts its attempts from the fresh block."""
    event = _alert("evt-relay-plain", severity="warning", source=OWNER_SOURCE, machine="host-b")
    event["delivery"].update({"attempts": 3, "status": "sending", "nextAttemptAtEpoch": T0 - 1,
                              "lastError": "the remote rejected the message"})
    relayed = _relay(tmp_path, event)
    assert relayed["delivery"] == FRESH_RELAY_DELIVERY
    assert owner_route.qualifies(relayed, _owner_sources(), True) == "not_critical"


_COLLECTOR: list[Any] = []

# Delivery fields a remote dispatcher can leave on a requeued file, with values of the
# right type, of a wrong type, and the dispatcher's other bookkeeping.
_REMOTE_DELIVERY = st.dictionaries(
    st.sampled_from(["escalatedFromSeverity", "escalatedNow", "attempts", "status", "lastError",
                     "nextAttemptAtEpoch", "nonce", "renotifyGeneration", "sendIssuedAt"]),
    st.one_of(st.sampled_from(SEVERITIES), st.booleans(), st.integers(), st.none(), st.text(max_size=6)),
    max_size=6,
)


@properties
@given(remote=_REMOTE_DELIVERY)
@example(remote={"escalatedFromSeverity": "warning", "escalatedNow": True, "attempts": 3, "status": "queued"})
@example(remote={"escalatedFromSeverity": 3, "escalatedNow": "true"})
@example(remote={"escalatedNow": 1})
@example(remote={})
def test_the_relay_keeps_only_the_escalation_fields_of_the_remote_delivery_block(remote):
    """Every other delivery field starts fresh at the hub, and each escalation field is
    kept only with its type: text for the recorded severity, a boolean for the marker."""
    if not _COLLECTOR:
        _COLLECTOR.append(_collector_conftest._load_module())
    expected = dict(FRESH_RELAY_DELIVERY)
    if type(remote.get("escalatedFromSeverity")) is str:
        expected["escalatedFromSeverity"] = remote["escalatedFromSeverity"]
    if type(remote.get("escalatedNow")) is bool:
        expected["escalatedNow"] = remote["escalatedNow"]
    assert _COLLECTOR[0].relayed_delivery(remote) == expected
