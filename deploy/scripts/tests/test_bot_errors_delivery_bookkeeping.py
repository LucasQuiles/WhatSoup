"""A page's notification bookkeeping is written when it is delivered, never before its send.

The send decision runs before the send. When it stamped the open record as notified itself, a
page that then failed was still recorded as sent as soon as any later commit persisted the shared
incident state, and its retry was suppressed as a duplicate of a page nobody received. The
decision now leaves only an intent on the event's delivery block, and the delivery applies it.

These tests drive the real process_one through a real incident-state cycle and its commit, reload
the state from the store, and check what a failed, held, retried, delivered or replayed page
leaves behind. A crash is reproduced from the dispatcher's own terminal records: the delivered
record is moved back into processing/, and for a crash before the commit the stored state is put
back as it was before the pass.

Tests whose names contain `_pin_` hold behaviour that is already right and must stay so.
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
import time as real_time
from pathlib import Path
from typing import Any
from unittest.mock import patch

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))

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
    "BOT_ERRORS_DRY_SEND_CAPTURE",
    "BOT_ERRORS_DRY_SEND_FAIL",
    "BOT_ERRORS_OWNER_ROUTE_JID",
    "BOT_ERRORS_OWNER_ROUTE_SOCKET",
]

_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)

T0 = 1_790_000_000
BASE = 6 * 3600  # the default renotify interval
CAP = 24 * 3600  # the default renotify interval cap
HOUR = 3600
EPOCH = "e1d2c3b4a5968778"
TOKEN_A = "a0c1e2f3a4b5c6d7"
MACHINE = "host-a"
INSTANCE = "instance-a"
PHYSICAL_INSTANCE = "instance-p"
FORCE_SOURCE = "heartbeat-watchdog"
FORCE_LEVEL = "critical"
SCOPED_SOURCE = "agent_turn_admission_rejected"
SCOPE = "cs1_a1b2c3d4e5f60718"
BOOKKEEPING = ("lastNotifiedAt", "lastNotifiedIso", "renotifyCount", "renotifyIntervalSeconds", "forceNotifyLevels")
TOKEN_RE = re.compile(r"[a-f][0-9a-f]{15}")


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

    def __init__(self, tmp_path: Path, *, adopted: bool = True, env: dict[str, str] | None = None) -> None:
        state_dir = tmp_path / "state"
        os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
        for name, value in (env or {}).items():
            os.environ[name] = value
        (state_dir / "logs").mkdir(parents=True, exist_ok=True)
        self.mod = dispatcher_fixtures.load_module_from_path(
            f"bot_errors_dispatcher_delivery_bookkeeping_{tmp_path.name}", _SCRIPT
        )
        self.clock = _Clock(T0)
        self.mod.time = self.clock
        self.paths = self.mod.setup_dirs()
        os.chmod(self.paths["incident_state"].parent, 0o700)
        self.adopted = adopted
        self.attempts: list[str] = []
        self.delivered: list[str] = []
        self.step_records: list[dict[str, Any]] = []
        self._names = 0

    def _session(self):
        return open_controller_state(
            self.paths["incident_state"],
            component="dispatcher-incident",
            bootstrap=self.mod.dispatcher_bootstrap_state,
            validate_payload=self.mod.validate_dispatcher_state,
            lock_timeout_seconds=10,
        )

    def seed(self, payload: dict[str, Any]) -> None:
        if not self.adopted:
            self.mod.save_incident_state(self.paths, copy.deepcopy(payload))
            return
        session = self._session()
        with session:
            loaded = session.load()
            session.save(copy.deepcopy(payload), loaded.capability)

    def state(self) -> dict[str, Any]:
        if not self.adopted:
            return self.mod.load_incident_state(self.paths)
        session = self._session()
        with session:
            return session.load().payload

    def record(self, key: str) -> dict[str, Any]:
        records = self.state().get("openIncidents")
        record = records.get(key) if isinstance(records, dict) else None
        return record if isinstance(record, dict) else {}

    def put(self, event: dict[str, Any]) -> Path:
        self._names += 1
        name = f"{self.clock.now}.{self._names:03d}.{event['source']}.{event['id']}.json"
        return dispatcher_fixtures.write_outbox_event(self.paths, name, event)

    def queued(self, path: Path) -> Path:
        requeued = self.paths["outbox"] / path.name
        assert requeued.exists(), f"{path.name} must be back in the queue for its retry"
        return requeued

    def ready(self, path: Path) -> bool:
        return self.mod.ready(path, self.paths["quarantine"])

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

    def cycle(self, *steps: tuple[Path, str]) -> list[tuple[bool, str]]:
        """One dispatcher cycle over `steps` (path, send outcome), in the order given."""
        results: list[tuple[bool, str]] = []
        self.step_records = []
        if not self.adopted:
            for path, outcome in steps:
                with patch.object(self.mod, "send_whatsapp", side_effect=self._sender(outcome)):
                    results.append(self.mod.process_one(path, self.paths))
            return results
        session = self._session()
        with session:
            loaded = session.load()
            incident = self.mod.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=self.paths)
            for path, outcome in steps:
                with patch.object(self.mod, "send_whatsapp", side_effect=self._sender(outcome)):
                    results.append(self.mod.process_one(path, self.paths, incident=incident))
                self.step_records.append(copy.deepcopy(incident.payload.get("openIncidents") or {}))
        return results

    def sweep(self) -> None:
        """One stale-incident sweep inside a cycle, every send delivered."""
        session = self._session()
        with session:
            loaded = session.load()
            incident = self.mod.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=self.paths)
            with patch.object(self.mod, "send_whatsapp", side_effect=self._sender("ok")):
                self.mod.sweep_stale_incidents(self.paths, incident=incident)

    def processing_file(self, path: Path) -> Path:
        return self.paths["processing"] / f"{path.name}.999.processing"

    def unarchive(self, path: Path) -> Path:
        """Move the delivered record back into processing/: a crash before the archive move."""
        archived = sorted(self.paths["sent"].glob(f"{path.name}.*.sent"))
        assert len(archived) == 1, f"expected one archived delivery for {path.name}, found {len(archived)}"
        target = self.processing_file(path)
        os.replace(archived[0], target)
        return target

    def claimed(self, event: dict[str, Any]) -> Path:
        """Write a terminal record straight into processing/."""
        self._names += 1
        name = f"{self.clock.now}.{self._names:03d}.{event['source']}.{event['id']}.json"
        target = self.paths["processing"] / f"{name}.999.processing"
        target.write_text(json.dumps(event), encoding="utf-8")
        target.chmod(0o600)
        return target

    def edit_delivery(self, claimed: Path, edit) -> None:
        event = json.loads(claimed.read_text(encoding="utf-8"))
        edit(event["delivery"])
        claimed.write_text(json.dumps(event), encoding="utf-8")
        claimed.chmod(0o600)

    def replay(self) -> None:
        """Reclaim processing/ and process every queued file once, as a restarted cycle does."""
        self.mod.reclaim_processing(self.paths)
        queued = sorted(self.paths["outbox"].glob("*.json"))
        assert queued, "the crashed record must be back in the queue"
        self.cycle(*[(path, "ok") for path in queued])

    def log_records(self, record_type: str) -> list[dict[str, Any]]:
        return [r for r in dispatcher_fixtures.dispatch_log_records(self.paths) if r.get("type") == record_type]


def _iso(epoch: int) -> str:
    return real_time.strftime("%Y-%m-%dT%H:%M:%SZ", real_time.gmtime(epoch))


def _is_token(value: Any) -> bool:
    return isinstance(value, str) and TOKEN_RE.fullmatch(value) is not None


def _alert(event_id: str, *, source: str = "socket_down", instance: str = INSTANCE,
           evidence: str = "the socket closed and did not come back", **extra: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": "critical",
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


def _force_alert(event_id: str) -> dict[str, Any]:
    return _alert(event_id, source=FORCE_SOURCE, diagnostics={"forceNotify": True, "forceNotifyLevel": FORCE_LEVEL})


def _physical_alert(event_id: str, **extra: Any) -> dict[str, Any]:
    return _alert(event_id, source="instance_logged_out", instance=PHYSICAL_INSTANCE,
                  evidence="auth_failure_class=pairing_required", **extra)


def _physical_key_alert(event_id: str) -> dict[str, Any]:
    """Same key as _physical_alert, but not itself a physical signal."""
    return _alert(event_id, source="instance_logged_out", instance=PHYSICAL_INSTANCE,
                  evidence="the instance reported a disconnect")


def _clear(event_id: str, **extra: Any) -> dict[str, Any]:
    event = _alert(event_id, **extra)
    event["eventType"] = "clear"
    event["severity"] = "info"
    return event


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


def _scoped_alert(event_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": "unknown",
        "instance": "instance-x",
        "source": SCOPED_SOURCE,
        "id": event_id,
        "createdAt": "2026-09-21T12:00:00Z",
        "conversationScope": SCOPE,
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": "00" * 32},
        "delivery": {"attempts": 1, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def _open_record(event_id: str = "evt-opening", *, last_notified: int = T0 - 7 * HOUR,
                 opened: int = T0 - 8 * HOUR, token: str | None = TOKEN_A, **extra: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "status": "open",
        "eventId": event_id,
        "openedAt": opened,
        "openedIso": _iso(opened),
        "lastSeenAt": last_notified,
        "lastSeenIso": _iso(last_notified),
        "lastSentAt": last_notified,
        "lastSentIso": _iso(last_notified),
        "lastNotifiedAt": last_notified,
        "lastNotifiedIso": _iso(last_notified),
        "suppressedCount": 0,
    }
    if token is not None:
        record["generationToken"] = token
    record.update(extra)
    return record


def _later_nonces(count: int, prefix: str = "b") -> list[str]:
    return [f"{prefix}{index:015x}" for index in range(count)]


def _state(records: dict[str, dict[str, Any]], *, seq: int = 0, nonces: list[str] | None = None,
           **top: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "version": 1,
        "openIncidents": copy.deepcopy(records),
        "lastSentAt": {key: record.get("lastSentAt", 0) for key, record in records.items()},
        "deliveryEpoch": EPOCH,
        "deliverySeq": seq,
        "deliveredSendNonces": list(nonces or []),
    }
    payload.update(top)
    return payload


def _page(bench: _Bench, kind: str) -> tuple[str, dict[str, Any]]:
    """Seed one open record whose next same-key event is due a page of `kind`."""
    if kind == "renotify":
        event = _alert("evt-renotify-1")
        record = _open_record()
    elif kind == "force":
        event = _force_alert("evt-force-1")
        record = _open_record()
    else:
        event = _physical_alert("evt-physical-2")
        record = _open_record("evt-physical-0", last_notified=T0 - HOUR,
                              physicalCandidateCount=1, physicalCandidateLastEventId="evt-physical-1")
    key = bench.mod.incident_key(event)
    bench.seed(_state({key: record}))
    return key, event


def _bookkeeping_changed(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """The BOOKKEEPING fields whose presence or value differs between `before` and `after`."""
    return [field for field in BOOKKEEPING
            if (field in after) != (field in before) or after.get(field) != before.get(field)]


def _failed_page(tmp_path: Path, kind: str, exit_: str, *,
                 adopted: bool = True) -> tuple[_Bench, str, Path, dict[str, Any]]:
    """One failed page of `kind` on `exit_`, and what the pass left on the reloaded record.

    The observation holds the BOOKKEEPING fields the pass changed, whether the intervening event changed the
    test key's record (None when the pass has no intervening event), and the record's lastSeenAt.
    """
    bench = _Bench(tmp_path, adopted=adopted)
    key, event = _page(bench, kind)
    if exit_ == "dead_letter":
        event["delivery"]["attempts"] = 9
        bench.mod.EMAIL_FALLBACK = str(tmp_path / "no-email-fallback")
    path = bench.put(event)
    before = bench.record(key)
    steps = [(path, "transient" if exit_ == "transient" else "fail")]
    intervening = adopted and exit_ != "dead_letter"
    if intervening:
        steps.append((bench.put(_daily_health("evt-daily-1")), "ok"))
    bench.cycle(*steps)
    after = bench.record(key)
    observed = {
        "bookkeepingChanged": _bookkeeping_changed(before, after),
        "interveningChangedRecord": (
            bench.step_records[1].get(key) != bench.step_records[0].get(key) if intervening else None
        ),
        "lastSeenAt": after.get("lastSeenAt"),
    }
    return bench, key, path, observed


def _retry(bench: _Bench, path: Path, exit_: str) -> dict[str, Any]:
    """Run the page's retry at its own backoff; returns whether it was due and how many pages were delivered."""
    bench.clock.now = T0 + (60 if exit_ == "retry" else 300)
    requeued = bench.queued(path)
    due = bench.ready(requeued)
    if due:
        bench.cycle((requeued, "ok"))
    return {"due": due, "delivered": len(bench.delivered)}


def _deliver(bench: _Bench, event: dict[str, Any], outcome: str = "ok") -> Path:
    path = bench.put(event)
    bench.cycle((path, outcome))
    return path


def _crash_before_commit(bench: _Bench, event: dict[str, Any]) -> Path:
    """Deliver `event`, then leave the disk as a crash after the sent record and before the commit."""
    before = bench.state()
    path = _deliver(bench, event)
    bench.seed(before)
    return bench.unarchive(path)


def _crash_before_archive(bench: _Bench, event: dict[str, Any]) -> Path:
    """Deliver and commit `event`, then leave its record in processing/ as a crash before the move."""
    path = _deliver(bench, event)
    return bench.unarchive(path)


def _seed_later_deliveries(bench: _Bench, count: int, prefix: str = "b") -> None:
    """Stand for `count` later deliveries to other keys: the list keeps the newest 256, seq rises by count."""
    payload = bench.state()
    nonces = list(payload.get("deliveredSendNonces") or [])
    payload["deliveredSendNonces"] = (nonces + _later_nonces(count, prefix))[-256:]
    payload["deliverySeq"] = int(payload.get("deliverySeq") or 0) + count
    bench.seed(payload)


def _committed_then_rewritten(bench: _Bench, *, seq: int = 0, nonces: list[str] | None = None) -> tuple[str, Path]:
    """A renotify A delivered and committed but not archived, then a force-notify B for the same key."""
    event_a = _alert("evt-a", source=FORCE_SOURCE)
    key = bench.mod.incident_key(event_a)
    bench.seed(_state({key: _open_record()}, seq=seq, nonces=nonces))
    claimed = _crash_before_archive(bench, event_a)
    bench.clock.now = T0 + 60
    _deliver(bench, _force_alert("evt-b"))
    assert bench.record(key).get("eventId") == "evt-b", "B must rewrite the record's event id"
    return key, claimed


def _expiry(bench: _Bench, key: str) -> dict[str, Any]:
    """What a replay left: the record's renotifyCount, terminalReplayExpiredCount, and its expiry log records."""
    return {
        "renotifyCount": bench.record(key).get("renotifyCount"),
        "expiredCount": bench.state().get("terminalReplayExpiredCount"),
        "expiredLogs": len(bench.log_records("terminal_replay_expired")),
    }


# --- a failed page records nothing; its retry sends -------------------------------------------


def test_a_renotify_that_fails_records_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "renotify", "retry")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": False, "lastSeenAt": T0}
    assert _retry(bench, path, "retry") == {"due": True, "delivered": 1}


def test_a_renotify_deferred_by_transport_records_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "renotify", "transient")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": False, "lastSeenAt": T0}
    assert _retry(bench, path, "transient") == {"due": True, "delivered": 1}


def test_a_dead_lettered_renotify_records_nothing_but_keeps_the_refresh(tmp_path):
    bench, _key, _path, page = _failed_page(tmp_path, "renotify", "dead_letter")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": None, "lastSeenAt": T0}
    assert list(bench.paths["dead_letter"].glob("*")), "the page must be dead-lettered"


def test_a_force_notify_that_fails_records_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "force", "retry")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": False, "lastSeenAt": T0}
    assert _retry(bench, path, "retry") == {"due": True, "delivered": 1}


def test_a_force_notify_deferred_by_transport_records_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "force", "transient")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": False, "lastSeenAt": T0}
    assert _retry(bench, path, "transient") == {"due": True, "delivered": 1}


def test_a_dead_lettered_force_notify_records_nothing_but_keeps_the_refresh(tmp_path):
    bench, _key, _path, page = _failed_page(tmp_path, "force", "dead_letter")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": None, "lastSeenAt": T0}
    assert list(bench.paths["dead_letter"].glob("*")), "the page must be dead-lettered"


def test_an_announcement_that_fails_records_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "announce", "retry")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": False, "lastSeenAt": T0}
    assert _retry(bench, path, "retry") == {"due": True, "delivered": 1}


def test_an_announcement_deferred_by_transport_records_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "announce", "transient")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": False, "lastSeenAt": T0}
    assert _retry(bench, path, "transient") == {"due": True, "delivered": 1}


def test_a_dead_lettered_announcement_records_nothing_but_keeps_the_refresh(tmp_path):
    bench, _key, _path, page = _failed_page(tmp_path, "announce", "dead_letter")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": None, "lastSeenAt": T0}
    assert list(bench.paths["dead_letter"].glob("*")), "the page must be dead-lettered"


def test_pin_without_a_cycle_a_failed_renotify_saves_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "renotify", "retry", adopted=False)
    assert page["bookkeepingChanged"] == []
    assert _retry(bench, path, "retry") == {"due": True, "delivered": 1}


def test_pin_without_a_cycle_a_deferred_renotify_saves_nothing_and_its_retry_sends(tmp_path):
    bench, _key, path, page = _failed_page(tmp_path, "renotify", "transient", adopted=False)
    assert page["bookkeepingChanged"] == []
    assert _retry(bench, path, "transient") == {"due": True, "delivered": 1}


def test_without_a_cycle_a_dead_lettered_renotify_saves_only_the_refresh(tmp_path):
    bench, _key, _path, page = _failed_page(tmp_path, "renotify", "dead_letter", adopted=False)
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": None, "lastSeenAt": T0}
    assert list(bench.paths["dead_letter"].glob("*")), "the page must be dead-lettered"


def test_without_a_cycle_a_dead_lettered_force_notify_saves_only_the_refresh(tmp_path):
    bench, _key, _path, page = _failed_page(tmp_path, "force", "dead_letter", adopted=False)
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": None, "lastSeenAt": T0}
    assert list(bench.paths["dead_letter"].glob("*")), "the page must be dead-lettered"


def test_without_a_cycle_a_dead_lettered_announcement_saves_only_the_refresh(tmp_path):
    bench, _key, _path, page = _failed_page(tmp_path, "announce", "dead_letter", adopted=False)
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": None, "lastSeenAt": T0}
    assert list(bench.paths["dead_letter"].glob("*")), "the page must be dead-lettered"


# --- a delivered page records its bookkeeping once --------------------------------------------


def test_a_delivered_renotify_counts_once_and_doubles_the_interval_once(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    payload = bench.state()
    payload["openIncidents"][key]["renotifyCount"] = 2
    bench.seed(payload)
    _deliver(bench, event)
    record = bench.record(key)
    assert record.get("renotifyCount") == 3
    assert record.get("lastNotifiedAt") == T0
    assert record.get("renotifyIntervalSeconds") == 2 * BASE


def test_a_renotify_delivered_by_email_counts_once_and_doubles_the_interval_once(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    event["delivery"]["attempts"] = 2
    path = bench.put(event)
    fallback = dispatcher_fixtures.fallback_script(tmp_path, 0)
    with patch.object(bench.mod, "email_fallback_blocked_reason", return_value=None), \
            patch.object(bench.mod, "EMAIL_FALLBACK", str(fallback)):
        results = bench.cycle((path, "fail"))
    assert results == [(True, "email_delivered")]
    record = bench.record(key)
    assert record.get("renotifyCount") == 1
    assert record.get("lastNotifiedAt") == T0
    assert record.get("renotifyIntervalSeconds") == 2 * BASE


def test_pin_a_delivered_force_notify_stamps_its_level_and_keeps_the_interval(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "force")
    _deliver(bench, event)
    record = bench.record(key)
    assert len(bench.delivered) == 1
    assert (record.get("forceNotifyLevels") or {}).get(FORCE_LEVEL) == T0
    assert "renotifyIntervalSeconds" not in record


def test_pin_a_delivered_announcement_keeps_the_interval(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "announce")
    _deliver(bench, event)
    record = bench.record(key)
    assert len(bench.delivered) == 1
    assert record.get("status") == "awaiting_physical"
    assert "renotifyIntervalSeconds" not in record


def test_an_opening_delivery_gives_the_record_a_generation_token(tmp_path):
    bench = _Bench(tmp_path)
    event = _alert("evt-first")
    key = bench.mod.incident_key(event)
    bench.seed(_state({}))
    _deliver(bench, event)
    assert _is_token(bench.record(key).get("generationToken"))


def test_a_record_without_a_token_gets_one_and_advances_from_its_next_renotify(tmp_path):
    bench = _Bench(tmp_path)
    event = _alert("evt-renotify-1")
    key = bench.mod.incident_key(event)
    bench.seed(_state({key: _open_record(token=None)}))
    _deliver(bench, event)
    record = bench.record(key)
    assert "renotifyIntervalSeconds" not in record, "a record without a token must not advance yet"
    assert _is_token(record.get("generationToken")), "the delivery must give the record a token"
    bench.clock.now = T0 + BASE + 60
    _deliver(bench, _alert("evt-renotify-2"))
    assert len(bench.delivered) == 2
    assert bench.record(key).get("renotifyIntervalSeconds") == 2 * BASE


# --- a replayed terminal record applies its transition at most once ---------------------------


def test_a_renotify_replayed_after_a_crash_before_its_commit_applies_once(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    _crash_before_commit(bench, event)
    bench.replay()
    record = bench.record(key)
    state = bench.state()
    assert record.get("renotifyCount") == 1
    assert record.get("renotifyIntervalSeconds") == 2 * BASE
    assert state.get("deliverySeq") == 1
    assert len(state.get("deliveredSendNonces") or []) == 1
    assert len(bench.delivered) == 1, "the replay must not send again"


def test_pin_a_renotify_replayed_after_its_commit_changes_nothing(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    _crash_before_archive(bench, event)
    committed = bench.record(key)
    committed_seq = bench.state().get("deliverySeq")
    bench.replay()
    record = bench.record(key)
    assert record.get("renotifyCount") == committed.get("renotifyCount")
    assert record.get("renotifyIntervalSeconds") == committed.get("renotifyIntervalSeconds")
    assert bench.state().get("deliverySeq") == committed_seq
    assert len(bench.delivered) == 1


def test_a_committed_renotify_is_recognised_by_its_nonce_after_the_record_is_rewritten(tmp_path):
    bench = _Bench(tmp_path)
    key, _claimed = _committed_then_rewritten(bench, seq=300, nonces=_later_nonces(256, "c"))
    bench.replay()
    record = bench.record(key)
    assert record.get("renotifyCount") == 2, "A and B must each count once"
    assert record.get("renotifyIntervalSeconds") == 2 * BASE
    assert "terminalReplayExpiredCount" not in bench.state()


def test_pin_a_terminal_record_without_a_replay_identity_keeps_the_event_id_test(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    event["delivery"] = {"attempts": 1, "status": "sent", "nextAttemptAtEpoch": 0, "lastError": None}
    bench.claimed(event)
    bench.replay()
    assert bench.record(key).get("renotifyCount") == 1
    assert "terminalReplayExpiredCount" not in bench.state()


def test_pin_an_uncommitted_renotify_replayed_into_a_reopened_incident_leaves_its_interval(tmp_path):
    bench = _Bench(tmp_path)
    event = _alert("evt-a")
    key = bench.mod.incident_key(event)
    bench.seed(_state({key: _open_record(opened=T0)}))
    _crash_before_commit(bench, event)
    _deliver(bench, _clear("evt-c"))
    _deliver(bench, _alert("evt-x"))
    assert bench.record(key).get("openedAt") == T0, "the clock is frozen, so the new record opens at T0 too"
    bench.replay()
    assert "renotifyIntervalSeconds" not in bench.record(key)


def test_a_committed_renotify_is_still_recognised_after_254_later_deliveries(tmp_path):
    bench = _Bench(tmp_path)
    helper = getattr(bench.mod, "record_delivered_send_nonce", None)
    assert callable(helper), "the append-and-trim helper must exist"
    key, _claimed = _committed_then_rewritten(bench, seq=2, nonces=_later_nonces(2, "c"))
    payload = bench.state()
    for nonce in _later_nonces(253):
        helper(payload, nonce)
    bench.seed(payload)
    bench.replay()
    assert bench.record(key).get("renotifyCount") == 2
    assert "terminalReplayExpiredCount" not in bench.state()


def test_a_committed_renotify_is_still_recognised_after_255_later_deliveries(tmp_path):
    bench = _Bench(tmp_path)
    key, _claimed = _committed_then_rewritten(bench)
    _seed_later_deliveries(bench, 254)
    bench.replay()
    assert bench.record(key).get("renotifyCount") == 2
    assert "terminalReplayExpiredCount" not in bench.state()


def test_a_committed_renotify_evicted_by_256_later_deliveries_expires(tmp_path):
    bench = _Bench(tmp_path)
    key, _claimed = _committed_then_rewritten(bench)
    _seed_later_deliveries(bench, 255)
    before = bench.record(key)
    bench.replay()
    assert _expiry(bench, key) == {"renotifyCount": 2, "expiredCount": 1, "expiredLogs": 1}
    after = bench.record(key)
    for field in ("lastNotifiedAt", "renotifyIntervalSeconds", "eventId"):
        assert after.get(field) == before.get(field), f"an expired replay changed {field}"
    assert list(bench.paths["sent"].glob("*.sent")), "an expired replay is archived to sent/"
    assert not list(bench.paths["processing"].glob("*.processing"))


def test_an_uncommitted_renotify_256_deliveries_behind_expires(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    _crash_before_commit(bench, event)
    _seed_later_deliveries(bench, 256)
    bench.replay()
    assert "renotifyCount" not in bench.record(key)
    assert bench.state().get("terminalReplayExpiredCount") == 1


def test_pin_a_committed_renotify_is_skipped_by_its_event_id_when_the_list_is_malformed(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    _crash_before_archive(bench, event)
    committed = bench.record(key).get("renotifyCount")
    payload = bench.state()
    payload["deliveredSendNonces"] = "not-a-list"
    bench.seed(payload)
    bench.replay()
    assert bench.record(key).get("renotifyCount") == committed
    assert "terminalReplayExpiredCount" not in bench.state()


def test_a_committed_renotify_expires_when_the_nonce_list_is_malformed(tmp_path):
    bench = _Bench(tmp_path)
    key, _claimed = _committed_then_rewritten(bench, seq=10, nonces=_later_nonces(10, "c"))
    payload = bench.state()
    payload["deliveredSendNonces"] = "not-a-list"
    bench.seed(payload)
    bench.replay()
    assert _expiry(bench, key) == {"renotifyCount": 2, "expiredCount": 1, "expiredLogs": 1}


def test_a_committed_renotify_expires_when_the_sequence_is_malformed(tmp_path):
    bench = _Bench(tmp_path)
    key, _claimed = _committed_then_rewritten(bench, seq=10, nonces=_later_nonces(10, "c"))
    _seed_later_deliveries(bench, 255)
    payload = bench.state()
    payload["deliverySeq"] = True
    bench.seed(payload)
    bench.replay()
    assert _expiry(bench, key) == {"renotifyCount": 2, "expiredCount": 1, "expiredLogs": 1}


def test_a_committed_renotify_expires_after_the_state_was_reinitialised(tmp_path):
    bench = _Bench(tmp_path)
    key, _claimed = _committed_then_rewritten(bench, seq=10, nonces=_later_nonces(10, "c"))
    payload = bench.state()
    payload["deliveredSendNonces"] = "not-a-list"
    bench.seed(payload)
    _deliver(bench, _alert("evt-other", source="disk_full"))
    assert bench.state().get("deliveryEpoch") != EPOCH, "the next mint must start a new epoch"
    bench.replay()
    assert _expiry(bench, key) == {"renotifyCount": 2, "expiredCount": 1, "expiredLogs": 1}


def test_a_committed_renotify_expires_when_the_list_was_truncated(tmp_path):
    bench = _Bench(tmp_path)
    key, _claimed = _committed_then_rewritten(bench, seq=2, nonces=_later_nonces(2, "c"))
    _seed_later_deliveries(bench, 1)
    payload = bench.state()
    assert payload.get("deliverySeq") == 5
    payload["deliveredSendNonces"] = []
    bench.seed(payload)
    bench.replay()
    assert _expiry(bench, key) == {"renotifyCount": 2, "expiredCount": 1, "expiredLogs": 1}


def test_a_committed_renotify_with_a_partial_replay_identity_expires(tmp_path):
    variants = {
        "mint-seq-removed": lambda d: d.pop("mintSeq", None),
        "mint-epoch-malformed": lambda d: d.update(mintEpoch="x"),
    }
    for name, edit in variants.items():
        bench = _Bench(tmp_path / name)
        key, claimed = _committed_then_rewritten(bench)
        _seed_later_deliveries(bench, 255)
        bench.edit_delivery(claimed, edit)
        bench.replay()
        assert _expiry(bench, key) == {"renotifyCount": 2, "expiredCount": 1, "expiredLogs": 1}, name


def test_a_committed_renotify_without_a_valid_nonce_expires(tmp_path):
    variants = {"nonce-removed": lambda d: d.pop("nonce", None), "nonce-malformed": lambda d: d.update(nonce="x")}
    for name, edit in variants.items():
        bench = _Bench(tmp_path / name)
        key, claimed = _committed_then_rewritten(bench)
        bench.edit_delivery(claimed, edit)
        bench.replay()
        assert _expiry(bench, key) == {"renotifyCount": 2, "expiredCount": 1, "expiredLogs": 1}, name


def test_an_uncommitted_renotify_ten_deliveries_behind_applies(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    _crash_before_commit(bench, event)
    _seed_later_deliveries(bench, 10)
    bench.replay()
    record = bench.record(key)
    assert record.get("renotifyCount") == 1
    assert record.get("renotifyIntervalSeconds") == 2 * BASE
    assert bench.state().get("deliverySeq") == 11
    assert "terminalReplayExpiredCount" not in bench.state()


def _clear_replayed(tmp_path: Path, prepare) -> dict[str, bool]:
    """A clear delivered and lost to a crash before its commit, replayed after `prepare` ran.

    Returns what the replay left: whether the incident is still open and still has a lastSentAt entry, whether
    deliverySeq and deliveredSendNonces kept their values from before the replay, and whether an expiry was counted.
    """
    bench = _Bench(tmp_path)
    alert = _alert("evt-opening")
    key = bench.mod.incident_key(alert)
    bench.seed(_state({key: _open_record()}))
    _crash_before_commit(bench, _clear("evt-c"))
    assert bench.record(key), "the crash must leave the incident open on disk"
    prepare(bench)
    before = bench.state()
    bench.replay()
    after = bench.state()
    return {
        "open": key in (after.get("openIncidents") or {}),
        "lastSentAt": key in (after.get("lastSentAt") or {}),
        "deliverySeqKept": after.get("deliverySeq") == before.get("deliverySeq"),
        "noncesKept": after.get("deliveredSendNonces") == before.get("deliveredSendNonces"),
        "expiryCounted": "terminalReplayExpiredCount" in after,
    }


def _make_list_malformed(bench: _Bench) -> None:
    payload = bench.state()
    payload["deliveredSendNonces"] = "not-a-list"
    bench.seed(payload)


def test_pin_a_clear_replayed_beyond_the_horizon_still_closes_its_incident(tmp_path):
    replayed = _clear_replayed(tmp_path, lambda bench: _seed_later_deliveries(bench, 256))
    assert replayed == {"open": False, "lastSentAt": False, "deliverySeqKept": True, "noncesKept": True,
                        "expiryCounted": False}, "a replayed clear must close its incident and change nothing else"


def test_pin_a_clear_replayed_into_a_new_epoch_still_closes_its_incident(tmp_path):
    def reinitialise(bench: _Bench) -> None:
        _make_list_malformed(bench)
        _deliver(bench, _alert("evt-other", source="disk_full"))

    replayed = _clear_replayed(tmp_path, reinitialise)
    assert replayed == {"open": False, "lastSentAt": False, "deliverySeqKept": True, "noncesKept": True,
                        "expiryCounted": False}, "a replayed clear must close its incident and change nothing else"


def test_pin_a_clear_replayed_with_a_malformed_list_still_closes_its_incident(tmp_path):
    replayed = _clear_replayed(tmp_path, _make_list_malformed)
    assert replayed == {"open": False, "lastSentAt": False, "deliverySeqKept": True, "noncesKept": True,
                        "expiryCounted": False}, "a replayed clear must close its incident and change nothing else"


def test_an_expired_replay_still_records_its_conversation(tmp_path):
    bench = _Bench(tmp_path)
    event = _scoped_alert("evt-scoped")
    key = bench.mod.incident_key(event)
    bench.seed(_state({key: _open_record()}, seq=300, nonces=_later_nonces(256, "c")))
    event["delivery"].update({"status": "sent", "nonce": "f00000000000000a", "mintEpoch": EPOCH, "mintSeq": 0})
    bench.claimed(event)
    bench.replay()
    state = bench.state()
    assert state.get("terminalReplayExpiredCount") == 1
    scopes = state.get("conversationScopes") or {}
    assert SCOPE in (scopes.get(key) or {}), "an expired replay must still record its conversation"


# --- a stale intent never acts on a later pass ------------------------------------------------


def test_a_requeued_renotify_carries_a_pending_announcement_and_not_its_old_intent(tmp_path):
    bench = _Bench(tmp_path)
    event_a = _alert("evt-a")
    key = bench.mod.incident_key(event_a)
    bench.seed(_state({key: _open_record()}))
    event_c = _alert("evt-c", criticalAsset={"failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED"}})
    path_a = bench.put(event_a)
    path_c = bench.put(event_c)
    bench.cycle((path_a, "fail"), (path_c, "fail"), (bench.put(_daily_health("evt-daily-1")), "ok"))
    assert bench.record(key).get("status") == "awaiting_physical"
    bench.clock.now = T0 + 60
    bench.cycle(*[(path, "ok") for path in sorted([bench.queued(path_a), bench.queued(path_c)])])
    record = bench.record(key)
    assert len(bench.delivered) == 1, "one page: the owed announcement, carried by A's retry"
    assert record.get("awaitingPhysicalAnnouncedFor") == record.get("awaitingPhysicalAt")
    assert "renotifyIntervalSeconds" not in record


# --- the awaiting-physical announcement waits for its delivery -------------------------------


def test_a_failed_announcement_is_carried_by_the_retry_and_stamped_once(tmp_path):
    bench, key, path, page = _failed_page(tmp_path, "announce", "retry")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": False, "lastSeenAt": T0}
    bench.clock.now = T0 + 60
    bench.cycle((bench.queued(path), "ok"))
    record = bench.record(key)
    assert record.get("awaitingPhysicalAnnouncedFor") == record.get("awaitingPhysicalAt") == T0
    bench.clock.now = T0 + 120
    bench.cycle((bench.put(_physical_alert("evt-physical-3")), "ok"))
    assert len(bench.delivered) == 1, "a further candidate must not announce again"


def test_an_announcement_in_the_second_of_a_delivery_is_still_owed(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "announce")
    payload = bench.state()
    payload["openIncidents"][key].update(lastNotifiedAt=T0, lastNotifiedIso=_iso(T0))
    bench.seed(payload)
    path = bench.put(event)
    bench.cycle((path, "fail"), (bench.put(_daily_health("evt-daily-1")), "ok"))
    assert bench.attempts.count("fail") == 1, "the transition pass must issue the announcement"
    bench.clock.now = T0 + 60
    bench.cycle((bench.queued(path), "ok"))
    assert len(bench.delivered) == 1, "the retry must announce"


def test_an_announcement_after_a_backward_clock_step_is_still_sent(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "announce")
    payload = bench.state()
    payload["openIncidents"][key].update(lastNotifiedAt=T0 + 600, lastNotifiedIso=_iso(T0 + 600))
    bench.seed(payload)
    _deliver(bench, event)
    record = bench.record(key)
    assert len(bench.delivered) == 1
    assert record.get("awaitingPhysicalAnnouncedFor") == record.get("awaitingPhysicalAt") == T0


def test_an_announcement_delivered_after_a_backward_clock_step_is_not_repeated(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "announce")
    path = bench.put(event)
    bench.cycle((path, "fail"), (bench.put(_daily_health("evt-daily-1")), "ok"))
    bench.clock.now = T0 - 1800
    _deliver(bench, _physical_key_alert("evt-next"))
    record = bench.record(key)
    assert len(bench.delivered) == 1, "the next same-key event carries the owed announcement"
    assert record.get("awaitingPhysicalAnnouncedFor") == T0
    assert record.get("lastNotifiedAt") == T0 - 1800
    bench.clock.now = T0 - 1740
    _deliver(bench, _physical_alert("evt-physical-3"))
    assert len(bench.delivered) == 1, "a later candidate inside the cadence must not announce again"


def test_a_stale_digest_does_not_acknowledge_a_pending_announcement(tmp_path):
    bench = _Bench(tmp_path)
    event = _physical_key_alert("evt-next")
    key = bench.mod.incident_key(event)
    record = _open_record("evt-physical-1", last_notified=T0 - 25 * HOUR, opened=T0 - 30 * HOUR,
                          status="awaiting_physical", awaitingPhysicalAt=T0 - 26 * HOUR,
                          awaitingPhysicalAnnouncedFor=0, physicalCandidateCount=2)
    bench.seed(_state({key: record}))
    bench.sweep()
    assert len(bench.delivered) == 1, "the stale digest must be sent"
    assert bench.record(key).get("awaitingPhysicalAnnouncedFor") == 0
    bench.clock.now = T0 + 60
    _deliver(bench, event)
    record = bench.record(key)
    assert len(bench.delivered) == 2, "the next same-key event must carry the owed announcement"
    assert record.get("awaitingPhysicalAnnouncedFor") == record.get("awaitingPhysicalAt")


def test_a_transition_made_during_delivery_is_announced_by_that_delivery(tmp_path):
    bench = _Bench(tmp_path)
    event = _physical_alert("evt-revoked-1", criticalAsset={"failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED"}})
    key = bench.mod.incident_key(event)
    bench.seed(_state({}))
    _deliver(bench, event)
    record = bench.record(key)
    assert record.get("status") == "awaiting_physical"
    assert record.get("awaitingPhysicalAnnouncedFor") == record.get("awaitingPhysicalAt")
    bench.clock.now = T0 + 60
    _deliver(bench, _physical_alert("evt-revoked-2", criticalAsset={"failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED"}}))
    assert len(bench.delivered) == 1, "no separate announcement follows"


def test_a_dead_lettered_announcement_is_carried_by_the_next_candidate(tmp_path):
    bench, key, _path, page = _failed_page(tmp_path, "announce", "dead_letter")
    assert page == {"bookkeepingChanged": [], "interveningChangedRecord": None, "lastSeenAt": T0}
    bench.clock.now = T0 + 60
    _deliver(bench, _physical_alert("evt-physical-3"))
    record = bench.record(key)
    assert len(bench.delivered) == 1, "the next candidate must announce"
    assert record.get("awaitingPhysicalAnnouncedFor") == record.get("awaitingPhysicalAt")


def test_pin_an_announced_record_without_a_marker_stays_announced(tmp_path):
    bench = _Bench(tmp_path)
    event = _physical_key_alert("evt-next")
    key = bench.mod.incident_key(event)
    bench.seed(_state({key: _open_record(last_notified=T0 - 2 * HOUR, status="awaiting_physical",
                                         awaitingPhysicalAt=T0 - 2 * HOUR)}))
    results = bench.cycle((bench.put(event), "ok"))
    assert results == [(True, "suppressed")]
    assert bench.delivered == []


def test_an_unannounced_record_without_a_marker_announces(tmp_path):
    bench = _Bench(tmp_path)
    event = _physical_key_alert("evt-next")
    key = bench.mod.incident_key(event)
    bench.seed(_state({key: _open_record(last_notified=T0 - 2 * HOUR, status="awaiting_physical",
                                         awaitingPhysicalAt=T0 - HOUR)}))
    _deliver(bench, event)
    assert len(bench.delivered) == 1


def _three_passes(bench: _Bench) -> None:
    for index in range(3):
        bench.clock.now = T0 + 60 * index
        _deliver(bench, _physical_key_alert(f"evt-pass-{index}"))


def test_an_awaiting_record_with_an_invalid_transition_time_announces_once(tmp_path):
    variants = {"absent": None, "string": "x", "negative": -5, "boolean": True}
    for name, value in variants.items():
        bench = _Bench(tmp_path / name)
        record = _open_record(last_notified=T0 - HOUR, status="awaiting_physical", awaitingPhysicalAnnouncedFor=0)
        if value is not None:
            record["awaitingPhysicalAt"] = value
        key = bench.mod.incident_key(_physical_key_alert("evt-key"))
        bench.seed(_state({key: record}))
        _three_passes(bench)
        stored = bench.record(key)
        assert len(bench.delivered) == 1, f"{name}: exactly one announcement over three passes"
        assert stored.get("awaitingPhysicalAt") == T0, f"{name}: the repair stamps the first pass's clock"
        assert stored.get("awaitingPhysicalAnnouncedFor") == T0, f"{name}: the delivery stamps the marker"


def test_an_awaiting_record_without_a_marker_or_transition_time_announces_once(tmp_path):
    bench = _Bench(tmp_path)
    key = bench.mod.incident_key(_physical_key_alert("evt-key"))
    bench.seed(_state({key: _open_record(last_notified=T0, status="awaiting_physical")}))
    _three_passes(bench)
    assert len(bench.delivered) == 1
    assert bench.record(key).get("awaitingPhysicalAnnouncedFor") == T0


# --- a retried event counts once ---------------------------------------------------------------


def _fail_with_commit(bench: _Bench, *paths: Path) -> None:
    bench.cycle(*[(path, "fail") for path in paths], (bench.put(_daily_health(f"evt-daily-{bench.clock.now}")), "ok"))


def test_a_retried_event_counts_once_as_suppressed(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    bench.mod.EMAIL_FALLBACK = str(tmp_path / "no-email-fallback")
    path = bench.put(event)
    _fail_with_commit(bench, path)
    for now in (T0 + 60, T0 + 360):
        bench.clock.now = now
        _fail_with_commit(bench, bench.queued(path))
    assert len(bench.attempts) == 3, "the event must be sent and retried twice"
    assert bench.record(key).get("suppressedCount") == 1


def test_interleaved_retries_count_each_event_once(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    path_a = bench.put(event)
    path_b = bench.put(_alert("evt-renotify-2"))
    _fail_with_commit(bench, path_a, path_b)
    bench.clock.now = T0 + 60
    _fail_with_commit(bench, bench.queued(path_a))
    assert len(bench.attempts) == 3, "A, B and A's retry must each be sent"
    assert bench.record(key).get("suppressedCount") == 2


def test_pin_an_event_without_an_id_counts_on_every_pass(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    state = bench.state()
    event.pop("id")
    for _ in range(2):
        bench.mod.should_suppress_send(copy.deepcopy(event), state)
    assert state["openIncidents"][key].get("suppressedCount") == 2


def test_interleaved_physical_candidates_count_each_event_once(tmp_path):
    bench = _Bench(tmp_path, env={"BOT_ERRORS_AWAITING_PHYSICAL_CONFIRMATIONS": "10"})
    event = _physical_alert("evt-physical-2")
    key = bench.mod.incident_key(event)
    # Due a renotify, so each candidate pass is a send that fails and is retried.
    bench.seed(_state({key: _open_record("evt-physical-0", physicalCandidateCount=1,
                                         physicalCandidateLastEventId="evt-physical-1")}))
    path_a = bench.put(event)
    path_b = bench.put(_physical_alert("evt-physical-3"))
    _fail_with_commit(bench, path_a, path_b)
    bench.clock.now = T0 + 60
    _fail_with_commit(bench, bench.queued(path_a))
    record = bench.record(key)
    assert len(bench.attempts) == 3, "A, B and A's retry must each be sent"
    assert record.get("status") == "open"
    assert record.get("physicalCandidateCount") == 3


def test_a_retried_event_at_the_escalation_threshold_still_escalates(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    payload = bench.state()
    payload["openIncidents"][key]["suppressedCount"] = bench.mod.INCIDENT_ESCALATE_SUPPRESSED - 1
    bench.seed(payload)
    path = bench.put(event)
    _fail_with_commit(bench, path)
    bench.clock.now = T0 + 60
    bench.cycle((bench.queued(path), "ok"))
    assert bench.record(key).get("suppressedCount") == bench.mod.INCIDENT_ESCALATE_SUPPRESSED
    assert len(bench.delivered) == 1
    assert "ESCALATED still open" in bench.delivered[0]


# --- an ambiguous send is held and records nothing -----------------------------------------


def test_a_held_page_records_nothing_and_the_next_event_is_sent(tmp_path):
    bench = _Bench(tmp_path)
    key, event = _page(bench, "renotify")
    path = bench.put(event)
    before = bench.record(key)
    bench.cycle((path, "ambiguous"), (bench.put(_daily_health("evt-daily-1")), "ok"))
    state = bench.state()
    assert _bookkeeping_changed(before, bench.record(key)) == [], "a held page must record no bookkeeping"
    held = sorted(bench.paths["processing"].glob("*.processing"))
    assert len(held) == 1, "the held record stays in processing/"
    held_nonce = json.loads(held[0].read_text(encoding="utf-8"))["delivery"].get("nonce")
    assert held_nonce not in (state.get("deliveredSendNonces") or [])
    bench.clock.now = T0 + 60
    bench.mod.reclaim_processing(bench.paths)
    assert len(sorted(bench.paths["processing"].glob("*.processing"))) == 1, "a held record is never resent"
    _deliver(bench, _alert("evt-renotify-2"))
    assert len(bench.delivered) == 1, "the next distinct event must be sent"


# --- deferred chains collapse on recovery ------------------------------------------------------


def test_deferred_renotify_chains_collapse_to_one_page_on_recovery(tmp_path):
    bench = _Bench(tmp_path)
    _key, event = _page(bench, "renotify")
    paths = [bench.put(event), bench.put(_alert("evt-renotify-2")), bench.put(_alert("evt-renotify-3"))]
    bench.cycle(*[(path, "transient") for path in paths], (bench.put(_daily_health("evt-daily-1")), "ok"))
    assert bench.attempts.count("transient") == 3, "each due event must try its own send"
    bench.clock.now = T0 + 300
    bench.cycle(*[(bench.queued(path), "ok") for path in paths])
    assert len(bench.delivered) == 1, "the chains must collapse to one page"
    assert len(list(bench.paths["suppressed"].glob("*.evt-renotify-*"))) == 2


# --- the page text names the previous delivery -------------------------------------------------


def _last_notified_values(text: str) -> list[str]:
    return re.findall(r"last_notified=(\S+)", text)


def test_a_renotify_names_the_previous_delivery_and_carries_no_intent(tmp_path):
    bench = _Bench(tmp_path)
    _key, event = _page(bench, "renotify")
    path = _deliver(bench, event)
    text = bench.delivered[0]
    assert _last_notified_values(text) == [_iso(T0 - 7 * HOUR)]
    assert "renotifyGeneration" not in text and TOKEN_A not in text
    archived = sorted(bench.paths["sent"].glob(f"{path.name}.*.sent"))
    nonce = json.loads(archived[0].read_text(encoding="utf-8"))["delivery"].get("nonce")
    assert nonce is None or nonce not in text


def test_a_retried_renotify_names_the_previous_delivery(tmp_path):
    bench = _Bench(tmp_path)
    _key, event = _page(bench, "renotify")
    path = bench.put(event)
    _fail_with_commit(bench, path)
    bench.clock.now = T0 + 60
    bench.cycle((bench.queued(path), "ok"))
    assert len(bench.delivered) == 1
    assert _last_notified_values(bench.delivered[0])[-1] == _iso(T0 - 7 * HOUR)
