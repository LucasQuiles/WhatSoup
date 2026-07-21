"""Replay-safe processed-event receipts and collision quarantine tests."""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"
_MODULE_SEQUENCE = 0


def _load_module():
    global _MODULE_SEQUENCE
    _MODULE_SEQUENCE += 1
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_replay_{_MODULE_SEQUENCE}", _SCRIPT
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _event(
    epoch: int,
    *,
    event_id: str | None = None,
    event_type: str = "alert",
    schema_version: int = 2,
    source: str = "socket_down",
    machine: str = "host-a",
    instance: str = "ana-bot",
    summary: str | None = None,
    evidence: str = "socket observation failed",
    fingerprint: str = "a" * 64,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schemaVersion": schema_version,
        "id": event_id if event_id is not None else f"event-{event_type}-{epoch}",
        "eventType": event_type,
        "severity": "info" if event_type == "clear" else "critical",
        "source": source,
        "machine": machine,
        "instance": instance,
        "summary": summary or (
            f"Recovered from {source}" if event_type == "clear" else f"Failure from {source}"
        ),
        "evidence": evidence,
        "createdAt": _iso(epoch),
        "diagnostics": {"omitDispatchLogInMessage": True},
    }
    if schema_version == 2:
        event.update({
            "observedAt": _iso(epoch),
            "observation": {
                "state": "healthy" if event_type == "clear" else "fault",
                "confidence": "confirmed",
                "fingerprint": fingerprint,
                "producerSequence": 1,
            },
            "clearPolicy": {
                "kind": "same_source_newer",
                "minimumSchemaVersion": 2,
            },
            "remediation": {
                "recoverability": "auto_recoverable",
                "requestedAction": "observe_recovery" if event_type == "clear" else "inspect_socket",
                "authorization": "automatic_read_only",
            },
        })
    return event


def _open_record(mod: Any, event: dict[str, Any], opened: int) -> dict[str, Any]:
    normalized = mod.normalize_dispatch_observation(event)
    assert type(normalized).__name__ == "NormalizedObservation", normalized
    return {
        "status": "open",
        "incidentKey": normalized.incident_key,
        "incidentSource": normalized.incident_source,
        "eventId": event.get("id"),
        "eventCreatedAt": event.get("createdAt"),
        "eventCreatedAtEpoch": opened,
        "openedAt": opened,
        "openedIso": _iso(opened),
        "schemaVersion": normalized.schema_version,
        "clearPolicy": {
            "kind": "same_source_newer",
            "minimumSchemaVersion": normalized.schema_version,
        },
        "suppressedCount": 0,
    }


def _receipt(identity: str, receipt_time: int, *, content: str | None = None) -> dict[str, Any]:
    return {
        "identityDigest": identity,
        "displayIdentity": "bounded-id",
        "evidenceFingerprint": "e" * 64,
        "eventContentDigest": content or ("c" * 64),
        "incidentKey": "host-a|ana-bot|socket_down",
        "incidentSource": "socket_down",
        "observationTime": receipt_time - 1,
        "receiptTime": receipt_time,
        "decision": "sent_alert",
        "notificationState": "delivered",
    }


class ReplayReceiptTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {
            key: os.environ.get(key)
            for key in (
                "BOT_ERRORS_STATE_DIR",
                "BOT_ERRORS_FLAP_DETECTION",
                "BOT_ERRORS_FLAP_TRIP_THRESHOLD",
            )
        }
        self._temp = tempfile.TemporaryDirectory(prefix="bot-errors-replay-")
        self.state_dir = Path(self._temp.name)
        os.environ["BOT_ERRORS_STATE_DIR"] = str(self.state_dir)
        os.environ["BOT_ERRORS_FLAP_DETECTION"] = "0"
        self.mod = _load_module()

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._temp.cleanup()

    def assert_isolated(self, paths: dict[str, Path] | None = None) -> None:
        self.assertEqual(self.mod.state_root().resolve(), self.state_dir.resolve())
        if paths is not None:
            self.assertEqual(paths["root"].resolve(), self.state_dir.resolve())

    def write_event(self, paths: dict[str, Path], name: str, event: dict[str, Any]) -> Path:
        self.assert_isolated(paths)
        path = paths["outbox"] / name
        path.write_text(json.dumps(event), encoding="utf-8")
        return path

    def process(self, paths: dict[str, Path], name: str, event: dict[str, Any], send: Any = None):
        path = self.write_event(paths, name, event)
        sender = send if send is not None else (lambda _text: None)
        with patch.object(self.mod, "send_whatsapp", side_effect=sender) as mocked_send:
            self.assert_isolated(paths)
            result = self.mod.process_one(path, paths)
        return path, result, mocked_send

    def authorize_clear(self, state: dict[str, Any], event: dict[str, Any], opened: int) -> str:
        observation = self.mod.normalize_dispatch_observation(event)
        self.assertEqual(type(observation).__name__, "NormalizedObservation")
        decision = self.mod.evaluate_clear(_open_record(self.mod, event, opened), observation, [])
        self.mod.record_accepted_clear_notification(
            state, event, observation, [(observation.incident_key, decision)]
        )
        return self.mod.clear_event_identity_digest(event)

    def test_pure_classification_distinguishes_exact_replay_and_content_collision(self) -> None:
        identity = "1" * 64
        existing = {identity: _receipt(identity, 100, content="2" * 64)}
        exact = self.mod.classify_processed_event(existing, identity, "2" * 64)
        collision = self.mod.classify_processed_event(existing, identity, "3" * 64)
        new = self.mod.classify_processed_event(existing, "4" * 64, "5" * 64)
        self.assertEqual(exact.status, "exact_replay")
        self.assertEqual(collision.status, "identity_collision")
        self.assertEqual(new.status, "new")
        self.assertIs(exact.receipt, existing[identity])

    def test_exact_replay_is_immutable_across_restart(self) -> None:
        paths = self.mod.setup_dirs()
        event = _event(int(time.time()), event_id="restart-safe-event")
        _, first_result, first_send = self.process(paths, "first.json", event)
        self.assertEqual(first_result, (True, "sent"))
        first_send.assert_called_once()
        state_bytes = paths["incident_state"].read_bytes()
        first_state = self.mod.load_incident_state(paths)
        identity = self.mod.event_replay_identity_digest(event, self.mod.normalize_dispatch_observation(event))
        receipt_before = json.loads(json.dumps(first_state["processedEvents"][identity]))

        restarted = _load_module()
        self.mod = restarted
        replay = self.write_event(paths, "replay.json", event)
        with patch.object(self.mod, "send_whatsapp") as replay_send:
            result = self.mod.process_one(replay, paths)
        self.assertEqual(result, (True, "exact_replay"))
        replay_send.assert_not_called()
        self.assertEqual(paths["incident_state"].read_bytes(), state_bytes)
        state_after = self.mod.load_incident_state(paths)
        self.assertEqual(state_after["processedEvents"][identity], receipt_before)
        key = self.mod.incident_key(event)
        self.assertEqual(state_after["openIncidents"][key]["suppressedCount"], 0)

    def test_same_id_different_evidence_is_quarantined_without_lifecycle_mutation(self) -> None:
        paths = self.mod.setup_dirs()
        epoch = int(time.time())
        original = _event(epoch, event_id="collision-event", fingerprint="a" * 64)
        self.process(paths, "original.json", original)
        before = self.mod.load_incident_state(paths)
        identity = self.mod.event_replay_identity_digest(
            original, self.mod.normalize_dispatch_observation(original)
        )
        original_receipt = json.loads(json.dumps(before["processedEvents"][identity]))
        protected_before = {
            key: json.loads(json.dumps(before.get(key)))
            for key in ("openIncidents", "closedHistory", "flapState", "acceptedClearNotifications")
        }
        collision = _event(
            epoch,
            event_id="collision-event",
            evidence="mutated evidence",
            fingerprint="b" * 64,
        )
        path, result, sender = self.process(paths, "collision.json", collision)
        self.assertFalse(result[0])
        self.assertEqual(result[1], "protocol_quarantine:identity_collision")
        sender.assert_not_called()
        self.assertFalse(path.exists())
        self.assertEqual(len(list(paths["quarantine"].iterdir())), 1)
        after = self.mod.load_incident_state(paths)
        self.assertEqual(after["processedEvents"][identity], original_receipt)
        for key, value in protected_before.items():
            self.assertEqual(after.get(key), value, key)
        self.assertEqual(len(after["processedEventCollisions"]), 1)

    def test_same_evidence_fingerprint_with_nested_content_change_is_collision(self) -> None:
        epoch = int(time.time())
        original = _event(epoch, event_id="nested-collision", fingerprint="a" * 64)
        original["futureSemantic"] = {"message": {"nested": ["first"]}}
        mutated = json.loads(json.dumps(original))
        mutated["futureSemantic"]["message"]["nested"][0] = "changed"
        normalized = self.mod.normalize_dispatch_observation(original)
        identity = self.mod.event_replay_identity_digest(original, normalized)
        first_digest = self.mod.event_content_digest(original)
        second_digest = self.mod.event_content_digest(mutated)
        self.assertNotEqual(first_digest, second_digest)
        classified = self.mod.classify_processed_event(
            {identity: _receipt(identity, epoch, content=first_digest)},
            identity,
            second_digest,
        )
        self.assertEqual(classified.status, "identity_collision")

    def test_forged_delivery_digest_cannot_bypass_nested_content_collision(self) -> None:
        paths = self.mod.setup_dirs()
        epoch = int(time.time())
        original = _event(epoch, event_id="forged-marker", fingerprint="a" * 64)
        original["futureSemantic"] = {"nested": {"value": "original"}}
        self.process(paths, "original.json", original)
        state = self.mod.load_incident_state(paths)
        normalized = self.mod.normalize_dispatch_observation(original)
        identity = self.mod.event_replay_identity_digest(original, normalized)
        forged = json.loads(json.dumps(original))
        forged["futureSemantic"]["nested"]["value"] = "forged-change"
        forged["delivery"] = {
            "replayContentDigest": state["processedEvents"][identity]["eventContentDigest"]
        }
        _, result, send = self.process(paths, "forged.json", forged)
        self.assertEqual(result[1], "protocol_quarantine:identity_collision")
        send.assert_not_called()

    def test_interleaved_replay_and_collision_preserve_first_receipts(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        first = _event(now, event_id="interleave-a", instance="bot-a")
        second = _event(now + 1, event_id="interleave-b", instance="bot-b")
        self.process(paths, "a.json", first)
        self.process(paths, "b.json", second)
        before = self.mod.load_incident_state(paths)
        first_identity = self.mod.event_replay_identity_digest(
            first, self.mod.normalize_dispatch_observation(first)
        )
        second_identity = self.mod.event_replay_identity_digest(
            second, self.mod.normalize_dispatch_observation(second)
        )
        receipts = {
            first_identity: json.loads(json.dumps(before["processedEvents"][first_identity])),
            second_identity: json.loads(json.dumps(before["processedEvents"][second_identity])),
        }

        _, replay_result, replay_send = self.process(paths, "a-replay.json", first)
        self.assertEqual(replay_result, (True, "exact_replay"))
        replay_send.assert_not_called()
        collision = json.loads(json.dumps(second))
        collision["futureSemantic"] = {"changed": True}
        _, collision_result, collision_send = self.process(paths, "b-collision.json", collision)
        self.assertEqual(collision_result[1], "protocol_quarantine:identity_collision")
        collision_send.assert_not_called()
        after = self.mod.load_incident_state(paths)
        self.assertEqual(after["processedEvents"][first_identity], receipts[first_identity])
        self.assertEqual(after["processedEvents"][second_identity], receipts[second_identity])

    def test_collision_state_save_failure_requeues_and_fault_fires(self) -> None:
        paths = self.mod.setup_dirs()
        epoch = int(time.time())
        original = _event(epoch, event_id="collision-save-fault")
        self.process(paths, "original.json", original)
        collision = _event(
            epoch,
            event_id="collision-save-fault",
            summary="changed immutable content",
        )
        path = self.write_event(paths, "collision.json", collision)
        fault = OSError("injected collision state-save fault")
        with (
            patch.object(self.mod, "save_incident_state", side_effect=fault) as save,
            patch.object(self.mod, "send_whatsapp") as send,
        ):
            result = self.mod.process_one(path, paths)
        self.assertFalse(result[0])
        self.assertIn("collision_state_persist_failed", result[1])
        self.assertEqual(save.call_count, 1, "injected state-save fault must fire exactly once")
        send.assert_not_called()
        self.assertTrue(path.exists(), "collision must remain retry-owned in outbox")
        self.assertFalse(list(paths["quarantine"].iterdir()))

    def test_ordinary_post_send_state_failure_exposes_at_least_once_window(self) -> None:
        paths = self.mod.setup_dirs()
        event = _event(int(time.time()), event_id="ordinary-post-send-fault")
        path = self.write_event(paths, "ordinary.json", event)
        fault = OSError("injected post-send state fault")
        with (
            patch.object(self.mod, "save_incident_state", side_effect=fault) as save,
            patch.object(self.mod, "send_whatsapp") as send,
        ):
            result = self.mod.process_one(path, paths)
        self.assertFalse(result[0])
        self.assertIn("post_send_state_persist_failed", result[1])
        send.assert_called_once()
        self.assertEqual(save.call_count, 1, "injected post-send state fault must fire")
        self.assertTrue(path.exists())
        persisted = self.mod.load_incident_state(paths)
        self.assertFalse(persisted.get("processedEvents"))

    def test_accepted_clear_pending_retry_then_delivered_replay_is_suppressed(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        alert = _event(now - 300, event_id="opening-alert")
        key = self.mod.incident_key(alert)
        state = {
            "version": 1,
            "openIncidents": {key: _open_record(self.mod, alert, now - 300)},
            "lastSentAt": {key: now - 300},
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        clear = _event(now, event_id="accepted-clear", event_type="clear")
        clear_path = self.write_event(paths, "clear.json", clear)
        with patch.object(
            self.mod, "send_whatsapp", side_effect=RuntimeError("injected transport failure")
        ) as first_send:
            first_result = self.mod.process_one(clear_path, paths)
        self.assertFalse(first_result[0])
        self.assertIn("injected transport failure", first_result[1])
        first_send.assert_called_once()
        pending = self.mod.load_incident_state(paths)
        identity = self.mod.event_replay_identity_digest(
            clear, self.mod.normalize_dispatch_observation(clear)
        )
        first_receipt_time = pending["processedEvents"][identity]["receiptTime"]
        self.assertEqual(pending["processedEvents"][identity]["notificationState"], "pending")
        authorization = pending["acceptedClearNotifications"][
            self.mod.clear_event_identity_digest(clear)
        ]
        self.assertEqual(authorization["notificationState"], "pending")
        self.assertEqual(len(pending["closedHistory"]), 1)

        with patch.object(self.mod, "send_whatsapp") as retry_send:
            retry_result = self.mod.process_one(clear_path, paths)
        self.assertEqual(retry_result, (True, "sent"))
        retry_send.assert_called_once()
        delivered = self.mod.load_incident_state(paths)
        self.assertEqual(delivered["processedEvents"][identity]["notificationState"], "delivered")
        self.assertEqual(delivered["processedEvents"][identity]["receiptTime"], first_receipt_time)
        self.assertEqual(len(delivered["closedHistory"]), 1)
        authorization = delivered["acceptedClearNotifications"][
            self.mod.clear_event_identity_digest(clear)
        ]
        self.assertEqual(authorization["notificationState"], "delivered")

        duplicate_path = self.write_event(paths, "clear-duplicate.json", clear)
        with patch.object(self.mod, "send_whatsapp") as duplicate_send:
            duplicate_result = self.mod.process_one(duplicate_path, paths)
        self.assertEqual(duplicate_result, (True, "exact_replay"))
        duplicate_send.assert_not_called()
        final_state = self.mod.load_incident_state(paths)
        self.assertEqual(len(final_state["closedHistory"]), 1)

    def test_out_of_order_alert_after_close_is_receipted_without_reopen(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        alert = _event(now - 300, event_id="old-open")
        key = self.mod.incident_key(alert)
        state = {
            "version": 1,
            "openIncidents": {key: _open_record(self.mod, alert, now - 300)},
            "lastSentAt": {key: now - 300},
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        clear = _event(now, event_id="close-boundary", event_type="clear")
        self.process(paths, "close.json", clear)

        stale = _event(now, event_id="different-but-not-newer")
        _, result, sender = self.process(paths, "stale.json", stale)
        self.assertEqual(result, (True, "stale_out_of_order"))
        sender.assert_not_called()
        after = self.mod.load_incident_state(paths)
        self.assertNotIn(key, after["openIncidents"])
        identity = self.mod.event_replay_identity_digest(
            stale, self.mod.normalize_dispatch_observation(stale)
        )
        self.assertEqual(after["processedEvents"][identity]["decision"], "stale_out_of_order")

    def test_suppressed_accepted_close_write_crash_reclaims_as_exact_replay(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        key = "host-a|ana-bot|daily-health-fail:ana-bot"
        opening = _event(
            now - 300,
            event_id="daily-fail-open",
            schema_version=1,
            source="daily-health-fail",
            instance="ana-bot",
        )
        record = _open_record(self.mod, opening, now - 300)
        record.update({
            "incidentKey": key,
            "incidentSource": "daily-health-fail:ana-bot",
            "clearPolicy": {"kind": "health_snapshot", "minimumSchemaVersion": 1},
        })
        state = {
            "version": 1,
            "openIncidents": {key: record},
            "lastSentAt": {key: now - 300},
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        summary = _event(
            now,
            event_id="daily-summary-close",
            schema_version=1,
            source="daily-health",
            instance="bot-errors-health",
            summary="BOT ERRORS daily health passed",
            evidence="health ana-bot: 200 status=healthy Result=success ExecMainStatus=0",
        )
        summary["severity"] = "info"
        event_path = self.write_event(paths, "daily-summary.json", summary)
        original_write = self.mod.atomic_write_json
        fault_count = 0

        def fail_suppressed_claim(target: Path, payload: dict[str, Any]) -> None:
            nonlocal fault_count
            delivery = payload.get("delivery") if isinstance(payload, dict) else None
            if isinstance(delivery, dict) and delivery.get("status") == "suppressed":
                fault_count += 1
                raise OSError("injected suppressed archive write crash")
            original_write(target, payload)

        with (
            patch.object(self.mod, "atomic_write_json", side_effect=fail_suppressed_claim),
            patch.object(self.mod, "send_whatsapp") as send,
            self.assertRaises(OSError),
        ):
            self.mod.process_one(event_path, paths)
        self.assertEqual(fault_count, 1, "suppressed claim write fault must fire")
        send.assert_not_called()
        persisted = self.mod.load_incident_state(paths)
        self.assertNotIn(key, persisted["openIncidents"])
        self.assertEqual(len(persisted["closedHistory"]), 1)
        identity = self.mod.event_replay_identity_digest(
            summary, self.mod.normalize_dispatch_observation(summary)
        )
        receipt_before = json.loads(json.dumps(persisted["processedEvents"][identity]))
        self.assertEqual(receipt_before["decision"], "accepted_clear_suppressed")

        self.assertEqual(self.mod.reclaim_processing(paths), 1)
        reclaimed = next(paths["outbox"].glob("*.json"))
        with patch.object(self.mod, "send_whatsapp") as replay_send:
            result = self.mod.process_one(reclaimed, paths)
        self.assertEqual(result, (True, "exact_replay"))
        replay_send.assert_not_called()
        final_state = self.mod.load_incident_state(paths)
        self.assertEqual(final_state["processedEvents"][identity], receipt_before)
        self.assertEqual(len(final_state["closedHistory"]), 1)
        self.assertFalse(list(paths["quarantine"].iterdir()))

    def test_orphan_rejected_and_candidate_clear_decisions_persist_receipts(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        orphan = _event(now, event_id="orphan-clear", event_type="clear", schema_version=1)
        _, orphan_result, orphan_send = self.process(paths, "orphan.json", orphan)
        self.assertEqual(orphan_result, (True, "suppressed"))
        orphan_send.assert_not_called()

        rejected_alert = _event(now, event_id="rejected-open", schema_version=1, instance="rejected")
        rejected_key = self.mod.incident_key(rejected_alert)
        state = self.mod.load_incident_state(paths)
        state["openIncidents"][rejected_key] = _open_record(self.mod, rejected_alert, now)
        self.mod.save_incident_state(paths, state)
        rejected = _event(
            now - 120,
            event_id="rejected-clear",
            event_type="clear",
            schema_version=1,
            instance="rejected",
        )
        _, rejected_result, rejected_send = self.process(paths, "rejected.json", rejected)
        self.assertEqual(rejected_result, (True, "suppressed"))
        rejected_send.assert_not_called()

        candidate_alert = _event(now - 300, event_id="candidate-open", schema_version=1, instance="candidate")
        candidate_key = self.mod.incident_key(candidate_alert)
        state = self.mod.load_incident_state(paths)
        candidate_record = _open_record(self.mod, candidate_alert, now - 300)
        candidate_record["clearPolicy"] = {
            "kind": "health_snapshot",
            "minimumSchemaVersion": 1,
        }
        state["openIncidents"][candidate_key] = candidate_record
        self.mod.save_incident_state(paths, state)
        candidate = _event(
            now,
            event_id="candidate-clear",
            event_type="clear",
            schema_version=1,
            instance="candidate",
        )
        _, candidate_result, candidate_send = self.process(paths, "candidate.json", candidate)
        self.assertEqual(candidate_result, (True, "suppressed"))
        candidate_send.assert_not_called()

        persisted = self.mod.load_incident_state(paths)
        decisions = {}
        for event in (orphan, rejected, candidate):
            identity = self.mod.event_replay_identity_digest(
                event, self.mod.normalize_dispatch_observation(event)
            )
            decisions[event["id"]] = persisted["processedEvents"][identity]["decision"]
        self.assertEqual(decisions["orphan-clear"], "suppressed")
        self.assertEqual(decisions["rejected-clear"], "clear_rejected")
        self.assertEqual(decisions["candidate-clear"], "clear_candidate")

    def test_idless_legacy_clear_authorizations_do_not_alias(self) -> None:
        now = int(time.time())
        state: dict[str, Any] = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        keys = []
        for instance in ("bot-a", "bot-b"):
            event = _event(
                now,
                event_id="",
                event_type="clear",
                schema_version=1,
                instance=instance,
            )
            event.pop("id")
            normalized = self.mod.normalize_dispatch_observation(event)
            record = _open_record(
                self.mod,
                _event(now - 1, event_id="opening", schema_version=1, instance=instance),
                now - 1,
            )
            decision = self.mod.evaluate_clear(record, normalized, [])
            self.mod.record_accepted_clear_notification(
                state, event, normalized, [(normalized.incident_key, decision)]
            )
            keys.append(self.mod.accepted_clear_notification_key(event, normalized))
        self.assertNotEqual(keys[0], keys[1])
        self.assertEqual(set(state["acceptedClearNotifications"]), set(keys))

    def test_age_and_capacity_pruning_are_deterministic(self) -> None:
        now = 1_000
        identities = [f"{value:064x}" for value in range(1, 6)]
        events = {
            identities[0]: _receipt(identities[0], 100),
            identities[1]: _receipt(identities[1], 100),
            identities[2]: _receipt(identities[2], 995),
            identities[3]: _receipt(identities[3], 996),
            identities[4]: _receipt(identities[4], 997),
        }
        aged = self.mod.prune_processed_events(
            events,
            protected_identities={identities[0]},
            now=now,
            max_age_seconds=10,
            capacity=4,
        )
        self.assertEqual(set(aged), {identities[0], identities[2], identities[3], identities[4]})
        capacity = self.mod.prune_processed_events(
            events,
            protected_identities=set(),
            now=now,
            max_age_seconds=10_000,
            capacity=3,
        )
        self.assertEqual(list(capacity), identities[2:])

    def test_every_protected_reference_class_survives_pruning(self) -> None:
        now = int(time.time())
        digests = {name: f"{index:064x}" for index, name in enumerate((
            "open", "last", "weak", "candidate", "rejected", "pending", "closed_open",
            "closed_close", "flap",
        ), 1)}
        state = {
            "openIncidents": {
                "key": {
                    "eventIdentityDigest": digests["open"],
                    "lastEventIdentityDigest": digests["last"],
                    "weakObservationEvidence": [
                        {"eventIdentityDigest": digests["weak"]}
                    ],
                    "candidateClearProofs": [
                        {"eventIdentityDigest": digests["candidate"]}
                    ],
                    "rejectedClearProofs": [
                        {"eventIdentityDigest": digests["rejected"]}
                    ],
                }
            },
            "acceptedClearNotifications": {
                "auth": {
                    "notificationState": "pending",
                    "eventIdentityDigest": digests["pending"],
                }
            },
            "closedHistory": [{
                "openingEventIdentityDigest": digests["closed_open"],
                "closingEventIdentityDigest": digests["closed_close"],
                "receiptTime": now,
            }],
            "flapState": {
                "key": {"eventIdentityDigests": [digests["flap"]]}
            },
        }
        protected = self.mod.protected_processed_event_identities(state, now)
        self.assertEqual(protected, set(digests.values()))
        events = {digest: _receipt(digest, 1) for digest in digests.values()}
        pruned = self.mod.prune_processed_events(
            events,
            protected_identities=protected,
            now=now,
            max_age_seconds=1,
            capacity=len(events),
        )
        self.assertEqual(set(pruned), protected)

    def test_protected_capacity_exhaustion_fails_closed(self) -> None:
        capacity = 2
        old = [f"{value:064x}" for value in (1, 2)]
        incoming = f"{3:064x}"
        events = {
            old[0]: _receipt(old[0], 100),
            old[1]: _receipt(old[1], 101),
            incoming: _receipt(incoming, 102),
        }
        with self.assertRaises(self.mod.ProcessedReceiptCapacityError) as caught:
            self.mod.prune_processed_events(
                events,
                protected_identities=set(old),
                now=102,
                max_age_seconds=1_000,
                capacity=capacity,
                required_identity=incoming,
            )
        self.assertEqual(caught.exception.protected_count, capacity)

    def test_protected_capacity_exhaustion_preflight_does_not_send(self) -> None:
        paths = self.mod.setup_dirs()
        self.mod.PROCESSED_EVENT_CAPACITY = 1
        protected = "1" * 64
        state = {
            "version": 1,
            "openIncidents": {
                "host-a|ana-bot|socket_down": {
                    "eventIdentityDigest": protected,
                    "incidentKey": "host-a|ana-bot|socket_down",
                    "incidentSource": "socket_down",
                }
            },
            "lastSentAt": {},
            "processedEvents": {protected: _receipt(protected, int(time.time()))},
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        incoming = _event(int(time.time()), event_id="capacity-blocked")
        path = self.write_event(paths, "capacity.json", incoming)
        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)
        self.assertFalse(result[0])
        self.assertIn("processed_receipt_capacity_exhausted", result[1])
        send.assert_not_called()
        self.assertTrue(path.exists())
        persisted = self.mod.load_incident_state(paths)
        self.assertEqual(set(persisted["processedEvents"]), {protected})

    def test_flap_scan_never_mutates_raw_fault_arrivals(self) -> None:
        os.environ["BOT_ERRORS_FLAP_DETECTION"] = "1"
        os.environ["BOT_ERRORS_FLAP_TRIP_THRESHOLD"] = "99"
        self.mod = _load_module()
        paths = self.mod.setup_dirs()
        event = _event(int(time.time()), event_id="preprocess-crash-window", schema_version=1)
        self.write_event(paths, "flap.json", event)
        with patch.object(self.mod, "send_whatsapp") as send:
            self.assertEqual(self.mod.flap_scan_outbox(paths), 0)
            self.assertEqual(self.mod.flap_scan_outbox(paths), 0)
        send.assert_not_called()
        state = self.mod.load_incident_state(paths)
        self.assertNotIn("flapState", state)

    def test_flap_scan_does_not_write_state_for_raw_fault(self) -> None:
        os.environ["BOT_ERRORS_FLAP_DETECTION"] = "1"
        os.environ["BOT_ERRORS_FLAP_TRIP_THRESHOLD"] = "1"
        self.mod = _load_module()
        paths = self.mod.setup_dirs()
        event = _event(int(time.time()), event_id="flap-save-fault", schema_version=1)
        path = self.write_event(paths, "flap.json", event)
        with (
            patch.object(self.mod, "save_incident_state") as save,
            patch.object(self.mod, "send_whatsapp") as send,
        ):
            queued = self.mod.flap_scan_outbox(paths)
        self.assertEqual(queued, 0)
        save.assert_not_called()
        send.assert_not_called()
        self.assertTrue(path.exists())
        self.assertNotIn("flapState", self.mod.load_incident_state(paths))

    def test_flap_enqueue_write_failure_retains_pending_and_retries_without_recount(self) -> None:
        os.environ["BOT_ERRORS_FLAP_DETECTION"] = "1"
        os.environ["BOT_ERRORS_FLAP_TRIP_THRESHOLD"] = "1"
        self.mod = _load_module()
        paths = self.mod.setup_dirs()
        event = _event(int(time.time()), event_id="flap-enqueue-fault", schema_version=1)
        key = self.mod.incident_key(event)
        now = int(time.time())
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {key: {"status": "open"}},
            "lastSentAt": {},
            "flapState": {
                key: {
                    "stormAt": now,
                    "verifiedReopenTimestamps": [now],
                    "verifiedReopenCount": 1,
                    "firstVerifiedReopenAt": now,
                    "lastVerifiedReopenAt": now,
                    "pendingStormNotification": {
                        "decisionAt": now,
                        "severity": "warning",
                        "reason": "flap_storm_opened",
                    },
                }
            },
        })
        original_write = self.mod.atomic_write_json
        fault_count = 0

        def fail_storm_write(target: Path, payload: dict[str, Any]) -> None:
            nonlocal fault_count
            if target.parent == paths["outbox"] and payload.get("source") == "flap_storm":
                fault_count += 1
                raise OSError("injected flap enqueue fault")
            original_write(target, payload)

        with (
            patch.object(self.mod, "atomic_write_json", side_effect=fail_storm_write),
            patch.object(self.mod, "send_whatsapp") as send,
        ):
            self.assertEqual(self.mod.flap_scan_outbox(paths), 0)
        self.assertEqual(fault_count, 1, "injected flap enqueue fault must fire once")
        send.assert_not_called()
        pending = self.mod.load_incident_state(paths)
        entry = pending["flapState"][key]
        self.assertEqual(entry["verifiedReopenCount"], 1)
        self.assertIn("pendingStormNotification", entry)
        original_pending = json.loads(json.dumps(entry["pendingStormNotification"]))
        with patch.object(self.mod, "atomic_write_json", side_effect=fail_storm_write):
            self.assertEqual(self.mod.flap_scan_outbox(paths), 0)
        self.assertEqual(fault_count, 2, "pending enqueue fault must fire on retry")
        still_pending = self.mod.load_incident_state(paths)
        entry = still_pending["flapState"][key]
        self.assertEqual(entry["verifiedReopenCount"], 1)
        self.assertEqual(entry["pendingStormNotification"], original_pending)

        with patch.object(self.mod, "send_whatsapp") as retry_send:
            self.assertEqual(self.mod.flap_scan_outbox(paths), 1)
        retry_send.assert_not_called()
        settled = self.mod.load_incident_state(paths)
        entry = settled["flapState"][key]
        self.assertEqual(entry["verifiedReopenCount"], 1)
        self.assertNotIn("pendingStormNotification", entry)
        queued = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in paths["outbox"].glob("*.json")
        ]
        self.assertEqual(sum(item.get("source") == "flap_storm" for item in queued), 1)

    def test_known_event_terminal_scope_does_not_self_match_current_file(self) -> None:
        paths = self.mod.setup_dirs()
        event = _event(int(time.time()), event_id="writefail-self-match", schema_version=1)
        current = self.write_event(paths, "current.json", event)
        terminal = self.mod.build_known_event_index(
            paths,
            directory_keys=("sent", "storm_collapsed", "suppressed", "quarantine", "dead_letter"),
        )
        self.assertFalse(self.mod.event_already_known(event, paths, terminal))
        (paths["sent"] / "known.json.sent").write_text(json.dumps(event), encoding="utf-8")
        terminal = self.mod.build_known_event_index(
            paths,
            directory_keys=("sent", "storm_collapsed", "suppressed", "quarantine", "dead_letter"),
        )
        self.assertTrue(self.mod.event_already_known(event, paths, terminal))
        self.assertTrue(current.exists())

    def test_long_and_missing_legacy_ids_have_stable_non_aliasing_identities(self) -> None:
        now = int(time.time())
        first = _event(now, event_id="x" * 512 + "a", schema_version=1)
        second = _event(now, event_id="x" * 512 + "b", schema_version=1)
        first_identity = self.mod.event_replay_identity_digest(
            first, self.mod.normalize_dispatch_observation(first)
        )
        second_identity = self.mod.event_replay_identity_digest(
            second, self.mod.normalize_dispatch_observation(second)
        )
        self.assertNotEqual(first_identity, second_identity)

        recurring = _event(now, event_id="stable-recurring", schema_version=1)
        later = _event(now + 60, event_id="stable-recurring", schema_version=1)
        recurring_identity = self.mod.event_replay_identity_digest(
            recurring, self.mod.normalize_dispatch_observation(recurring)
        )
        later_identity = self.mod.event_replay_identity_digest(
            later, self.mod.normalize_dispatch_observation(later)
        )
        self.assertNotEqual(recurring_identity, later_identity)

        missing = _event(now, event_id="", schema_version=1)
        missing.pop("id")
        copy = json.loads(json.dumps(missing))
        missing_identity = self.mod.event_replay_identity_digest(
            missing, self.mod.normalize_dispatch_observation(missing)
        )
        self.assertEqual(
            missing_identity,
            self.mod.event_replay_identity_digest(copy, self.mod.normalize_dispatch_observation(copy)),
        )
        self.assertRegex(missing_identity, r"^[0-9a-f]{64}$")

    def test_processed_state_load_fails_closed_on_invalid_receipt(self) -> None:
        paths = self.mod.setup_dirs()
        self.mod.PROCESSED_EVENT_CAPACITY = 2
        valid = [f"{value:064x}" for value in (1, 2, 3)]
        state = {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "processedEvents": {
                **{identity: _receipt(identity, index + 1) for index, identity in enumerate(valid)},
                "invalid": {"receiptTime": "bad"},
            },
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        with self.assertRaises(self.mod.ProcessedReceiptValidationError) as caught:
            self.mod.load_incident_state(paths)
        self.assertEqual(caught.exception.invalid_count, 1)

        event = _event(int(time.time()), event_id="blocked-by-invalid-state")
        event_path = self.write_event(paths, "blocked.json", event)
        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(event_path, paths)
        self.assertFalse(result[0])
        self.assertIn("processed_receipt_state_invalid", result[1])
        send.assert_not_called()
        self.assertTrue(event_path.exists())

    def test_processed_state_load_fails_closed_on_malformed_container(self) -> None:
        paths = self.mod.setup_dirs()
        state = {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "processedEvents": ["not", "a", "receipt-map"],
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        with self.assertRaises(self.mod.ProcessedReceiptValidationError):
            self.mod.load_incident_state(paths)

    def test_state_load_fails_closed_when_protected_receipts_exceed_capacity(self) -> None:
        paths = self.mod.setup_dirs()
        self.mod.PROCESSED_EVENT_CAPACITY = 1
        first, second = "1" * 64, "2" * 64
        state = {
            "version": 1,
            "openIncidents": {
                "host-a|ana-bot|socket_down": {
                    "eventIdentityDigest": first,
                    "lastEventIdentityDigest": second,
                }
            },
            "lastSentAt": {},
            "processedEvents": {
                first: _receipt(first, 1),
                second: _receipt(second, 2),
            },
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        with self.assertRaises(self.mod.ProcessedReceiptCapacityError) as caught:
            self.mod.load_incident_state(paths)
        self.assertEqual(caught.exception.protected_count, 2)

    def test_corrupt_state_json_fails_closed_without_send_and_retains_queue_ownership(self) -> None:
        paths = self.mod.setup_dirs()
        corrupt = b'{"version":1,"processedEvents":'
        paths["incident_state"].write_bytes(corrupt)
        event = _event(int(time.time()), event_id="corrupt-state-must-not-send")
        path = self.write_event(paths, "corrupt-state.json", event)

        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)

        self.assertFalse(result[0])
        self.assertIn("incident_state_corrupt", result[1])
        send.assert_not_called()
        self.assertEqual(paths["incident_state"].read_bytes(), corrupt)
        self.assertTrue(path.exists())
        self.assertFalse(list(paths["sent"].iterdir()))

    def test_pending_clear_retry_rejects_changed_message_bearing_diagnostics(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        alert = _event(now - 300, event_id="diagnostic-binding-open")
        key = self.mod.incident_key(alert)
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {key: _open_record(self.mod, alert, now - 300)},
            "lastSentAt": {key: now - 300},
        })
        clear = _event(now, event_id="diagnostic-binding-clear", event_type="clear")
        clear["diagnostics"].update({
            "queue": "/producer/original-queue",
            "writefailRecovery": {
                "recordedAt": "2026-07-21T00:00:00Z",
                "failedTarget": "/producer/original-target",
                "breadcrumb": "/producer/original-breadcrumb",
                "harvest": {"fromHost": "host-a"},
            },
        })
        path = self.write_event(paths, "diagnostic-binding.json", clear)
        with patch.object(
            self.mod, "send_whatsapp", side_effect=RuntimeError("injected transport failure")
        ):
            first = self.mod.process_one(path, paths)
        self.assertFalse(first[0])

        retry = json.loads(path.read_text(encoding="utf-8"))
        retry["diagnostics"]["queue"] = "/producer/changed-queue"
        retry["diagnostics"]["writefailRecovery"]["failedTarget"] = "/producer/changed-target"
        path.write_text(json.dumps(retry), encoding="utf-8")
        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)

        self.assertEqual(result, (False, "protocol_quarantine:identity_collision"))
        send.assert_not_called()

    def test_pending_clear_retry_rejects_changed_omitted_dispatch_log_value(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        alert = _event(now - 300, event_id="dispatch-log-binding-open")
        key = self.mod.incident_key(alert)
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {key: _open_record(self.mod, alert, now - 300)},
            "lastSentAt": {key: now - 300},
        })
        clear = _event(now, event_id="dispatch-log-binding-clear", event_type="clear")
        clear["diagnostics"]["dispatchLog"] = "/producer/original-dispatch.log"
        path = self.write_event(paths, "dispatch-log-binding.json", clear)
        with patch.object(
            self.mod, "send_whatsapp", side_effect=RuntimeError("injected transport failure")
        ):
            first = self.mod.process_one(path, paths)
        self.assertFalse(first[0])

        retry = json.loads(path.read_text(encoding="utf-8"))
        retry["diagnostics"]["dispatchLog"] = "/producer/changed-dispatch.log"
        path.write_text(json.dumps(retry), encoding="utf-8")
        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)

        self.assertEqual(result, (False, "protocol_quarantine:identity_collision"))
        send.assert_not_called()

    def test_pending_authorization_is_never_evicted(self) -> None:
        now = int(time.time())
        state: dict[str, Any] = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        first = _event(now, event_id="protected-pending", event_type="clear")
        protected_key = self.authorize_clear(state, first, now - 300)
        for index in range(1, 50):
            event = _event(now + index, event_id=f"delivered-{index}", event_type="clear")
            key = self.authorize_clear(state, event, now - 300)
            state["acceptedClearNotifications"][key]["notificationState"] = "delivered"
        newest = _event(now + 60, event_id="newest-pending", event_type="clear")
        newest_key = self.authorize_clear(state, newest, now - 300)

        self.assertEqual(len(state["acceptedClearNotifications"]), 50)
        self.assertIn(protected_key, state["acceptedClearNotifications"])
        self.assertIn(newest_key, state["acceptedClearNotifications"])
        self.assertEqual(
            state["acceptedClearNotifications"][protected_key]["notificationState"], "pending"
        )

    def test_pending_authorization_capacity_fails_closed_with_queue_ownership(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        target_alert = _event(now - 300, event_id="authorization-capacity-open")
        target_key = self.mod.incident_key(target_alert)
        state: dict[str, Any] = {
            "version": 1,
            "openIncidents": {target_key: _open_record(self.mod, target_alert, now - 300)},
            "lastSentAt": {target_key: now - 300},
        }
        for index in range(50):
            event = _event(
                now + index,
                event_id=f"authorization-pending-{index}",
                event_type="clear",
                instance=f"bot-{index}",
            )
            self.authorize_clear(state, event, now - 300)
        self.mod.save_incident_state(paths, state)
        clear = _event(now + 50, event_id="authorization-overflow", event_type="clear")
        path = self.write_event(paths, "authorization-overflow.json", clear)

        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)

        self.assertFalse(result[0], result)
        self.assertIn("accepted_clear_notification_capacity", result[1])
        send.assert_not_called()
        self.assertTrue(path.exists())
        persisted = self.mod.load_incident_state(paths)
        self.assertIn(target_key, persisted["openIncidents"])
        self.assertEqual(len(persisted["acceptedClearNotifications"]), 50)

    def test_recent_close_boundary_survives_history_capacity_and_blocks_stale_fault(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        recent = {
            "incidentKey": "host-a|ana-bot|socket_down",
            "receiptTime": now,
            "closedAt": now,
            "closingObservationTime": now,
            "closingEventIdentityDigest": "f" * 64,
        }
        other_recent = [
            {
                "incidentKey": f"host-a|ana-bot|recent-{index}",
                "receiptTime": now - index - 1,
                "closedAt": now - index - 1,
                "closingObservationTime": now - index - 1,
            }
            for index in range(50)
        ]
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "closedHistory": [recent, *other_recent],
        })
        loaded = self.mod.load_incident_state(paths)
        self.assertEqual(len(loaded["closedHistory"]), 51)
        self.assertIn(recent, loaded["closedHistory"])

        stale = _event(now, event_id="stale-after-retained-boundary")
        path = self.write_event(paths, "stale-after-boundary.json", stale)
        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)
        self.assertEqual(result, (True, "stale_out_of_order"))
        send.assert_not_called()

    def test_recent_close_history_capacity_exhaustion_fails_closed(self) -> None:
        paths = self.mod.setup_dirs()
        self.mod.CLOSED_HISTORY_LIMIT = 50
        now = int(time.time())
        recent = [
            {
                "incidentKey": f"host-a|ana-bot|recent-{index}",
                "receiptTime": now - index,
                "closedAt": now - index,
                "closingObservationTime": now - index,
            }
            for index in range(51)
        ]
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "closedHistory": recent,
        })
        event = _event(now, event_id="history-capacity-must-not-send")
        path = self.write_event(paths, "history-capacity.json", event)
        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)
        self.assertFalse(result[0])
        self.assertIn("closed_history_capacity", result[1])
        send.assert_not_called()
        self.assertTrue(path.exists())

    def test_flap_reference_capacity_does_not_recount_verified_reopen(self) -> None:
        self.mod.FLAP_EVENT_REFERENCE_LIMIT = 2
        flap_state: dict[str, Any] = {}
        key = "host-a|ana-bot|socket_down"
        first, second, third = "1" * 64, "2" * 64, "3" * 64
        self.mod.record_verified_reopen(flap_state, key, 100, first)
        self.mod.record_verified_reopen(flap_state, key, 101, second)
        with self.assertRaises(self.mod.FlapReferenceCapacityError):
            self.mod.record_verified_reopen(flap_state, key, 102, third)
        self.mod.record_verified_reopen(flap_state, key, 103, first)
        self.assertEqual(flap_state[key]["verifiedReopenCount"], 2)
        self.assertEqual(flap_state[key]["eventIdentityDigests"], [first, second])

    def test_settled_flap_refs_are_pruned_before_processed_capacity_preflight(self) -> None:
        os.environ["BOT_ERRORS_FLAP_DETECTION"] = "1"
        os.environ["BOT_ERRORS_FLAP_TRIP_THRESHOLD"] = "99"
        self.mod = _load_module()
        self.mod.PROCESSED_EVENT_CAPACITY = 2
        self.mod.FLAP_EVENT_REFERENCE_LIMIT = 2
        paths = self.mod.setup_dirs()
        now = int(time.time())
        settled_events = [
            _event(now - 2, event_id="settled-flap-a", schema_version=1),
            _event(now - 1, event_id="settled-flap-b", schema_version=1),
        ]
        settled_identities = []
        for event in settled_events:
            normalized = self.mod.normalize_dispatch_observation(event)
            settled_identities.append(self.mod.event_replay_identity_digest(event, normalized))
        key = self.mod.incident_key(settled_events[0])
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "processedEvents": {
                identity: _receipt(identity, now - 2 + index)
                for index, identity in enumerate(settled_identities)
            },
            "flapState": {
                key: {
                    "tripTimestamps": [now - 2, now - 1],
                    "cumulativeCount": 2,
                    "eventIdentityDigests": settled_identities,
                }
            },
        })
        incoming = _event(now, event_id="new-after-settled-flap", schema_version=1)
        incoming_normalized = self.mod.normalize_dispatch_observation(incoming)
        incoming_identity = self.mod.event_replay_identity_digest(incoming, incoming_normalized)
        path = self.write_event(paths, "new-after-settled-flap.json", incoming)

        with patch.object(self.mod, "send_whatsapp") as send:
            scan_result = self.mod.flap_scan_outbox(paths)
            after_scan = self.mod.load_incident_state(paths)
            process_result = self.mod.process_one(path, paths)

        self.assertEqual(scan_result, 0)
        self.assertEqual(process_result, (True, "sent"), process_result)
        send.assert_called_once()
        self.assertEqual(after_scan["flapState"][key]["eventIdentityDigests"], [])
        self.assertEqual(after_scan["flapState"][key]["verifiedReopenCount"], 0)
        final = self.mod.load_incident_state(paths)
        self.assertIn(incoming_identity, final["processedEvents"])
        self.assertLessEqual(len(final["processedEvents"]), 2)

    def test_load_prunes_settled_flap_refs_before_receipt_capacity_protection(self) -> None:
        self.mod.PROCESSED_EVENT_CAPACITY = 2
        paths = self.mod.setup_dirs()
        now = int(time.time())
        settled_events = [
            _event(now - 3, event_id="load-settled-a", schema_version=1),
            _event(now - 2, event_id="load-settled-b", schema_version=1),
            _event(now - 1, event_id="load-settled-c", schema_version=1),
        ]
        settled_identities = [
            self.mod.event_replay_identity_digest(
                event, self.mod.normalize_dispatch_observation(event)
            )
            for event in settled_events
        ]
        key = self.mod.incident_key(settled_events[0])
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "processedEvents": {
                identity: _receipt(identity, now - 3 + index)
                for index, identity in enumerate(settled_identities)
            },
            "flapState": {
                key: {
                    "tripTimestamps": [now - 3, now - 2, now - 1],
                    "cumulativeCount": 3,
                    "eventIdentityDigests": settled_identities,
                }
            },
        })

        loaded = self.mod.load_incident_state(paths)

        self.assertEqual(loaded["flapState"][key]["eventIdentityDigests"], [])
        self.assertEqual(len(loaded["processedEvents"]), 2)
        persisted_before_save = json.loads(
            paths["incident_state"].read_text(encoding="utf-8")
        )
        self.assertEqual(
            persisted_before_save["flapState"][key]["eventIdentityDigests"],
            settled_identities,
        )
        self.assertEqual(len(persisted_before_save["processedEvents"]), 3)

        self.mod.save_incident_state(paths, loaded)

        persisted_after_save = json.loads(
            paths["incident_state"].read_text(encoding="utf-8")
        )
        self.assertEqual(
            persisted_after_save["flapState"][key]["eventIdentityDigests"], []
        )
        self.assertEqual(len(persisted_after_save["processedEvents"]), 2)

    def test_stale_transaction_save_failure_retains_raw_authority_and_queue(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        settled = _event(now - 1, event_id="stale-save-settled", schema_version=1)
        settled_normalized = self.mod.normalize_dispatch_observation(settled)
        settled_identity = self.mod.event_replay_identity_digest(settled, settled_normalized)
        key = self.mod.incident_key(settled)
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "processedEvents": {settled_identity: _receipt(settled_identity, now - 1)},
            "flapState": {
                key: {
                    "tripTimestamps": [now - 1],
                    "cumulativeCount": 1,
                    "eventIdentityDigests": [settled_identity],
                }
            },
            "closedHistory": [{
                "incidentKey": key,
                "receiptTime": now,
                "closedAt": now,
                "closingObservationTime": now,
                "closingEventIdentityDigest": "f" * 64,
            }],
        })
        incoming = _event(now, event_id="stale-save-incoming", schema_version=1)
        incoming_normalized = self.mod.normalize_dispatch_observation(incoming)
        incoming_identity = self.mod.event_replay_identity_digest(
            incoming, incoming_normalized
        )
        path = self.write_event(paths, "stale-save-incoming.json", incoming)

        with (
            patch.object(self.mod, "send_whatsapp") as send,
            patch.object(
                self.mod,
                "save_incident_state",
                side_effect=OSError("injected stale transaction save failure"),
            ) as save,
        ):
            result = self.mod.process_one(path, paths)

        self.assertEqual(
            result,
            (False, "stale_receipt_persist_failed: injected stale transaction save failure"),
        )
        self.assertEqual(save.call_count, 1, "stale transaction save fault must fire once")
        send.assert_not_called()
        self.assertTrue(path.exists())
        self.assertEqual(list(paths["processing"].iterdir()), [])
        persisted = json.loads(paths["incident_state"].read_text(encoding="utf-8"))
        self.assertEqual(
            persisted["flapState"][key]["eventIdentityDigests"], [settled_identity]
        )
        self.assertEqual(set(persisted["processedEvents"]), {settled_identity})
        self.assertNotIn(incoming_identity, persisted["processedEvents"])

    def test_direct_process_prunes_settled_flap_refs_when_detection_is_disabled(self) -> None:
        self.mod.PROCESSED_EVENT_CAPACITY = 2
        self.mod.FLAP_EVENT_REFERENCE_LIMIT = 2
        paths = self.mod.setup_dirs()
        now = int(time.time())
        settled_events = [
            _event(now - 2, event_id="direct-settled-a", schema_version=1),
            _event(now - 1, event_id="direct-settled-b", schema_version=1),
        ]
        settled_identities = [
            self.mod.event_replay_identity_digest(
                event, self.mod.normalize_dispatch_observation(event)
            )
            for event in settled_events
        ]
        key = self.mod.incident_key(settled_events[0])
        self.mod.save_incident_state(paths, {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "processedEvents": {
                identity: _receipt(identity, now - 2 + index)
                for index, identity in enumerate(settled_identities)
            },
            "flapState": {
                key: {
                    "tripTimestamps": [now - 2, now - 1],
                    "cumulativeCount": 2,
                    "eventIdentityDigests": settled_identities,
                }
            },
        })
        incoming = _event(now, event_id="direct-after-settled", schema_version=1)
        normalized = self.mod.normalize_dispatch_observation(incoming)
        incoming_identity = self.mod.event_replay_identity_digest(incoming, normalized)
        path = self.write_event(paths, "direct-after-settled.json", incoming)

        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)

        self.assertEqual(result, (True, "sent"), result)
        send.assert_called_once()
        final = self.mod.load_incident_state(paths)
        self.assertEqual(final["flapState"][key]["eventIdentityDigests"], [])
        self.assertIn(incoming_identity, final["processedEvents"])
        self.assertLessEqual(len(final["processedEvents"]), 2)

    def test_v2_missing_id_is_protocol_quarantined(self) -> None:
        paths = self.mod.setup_dirs()
        event = _event(int(time.time()), event_id="temporary-v2-id")
        event.pop("id")
        path = self.write_event(paths, "missing-v2-id.json", event)
        with patch.object(self.mod, "send_whatsapp") as send:
            result = self.mod.process_one(path, paths)
        self.assertEqual(result, (False, "protocol_quarantine:invalid_event_id"))
        send.assert_not_called()
        self.assertFalse(path.exists())
        self.assertEqual(len(list(paths["quarantine"].iterdir())), 1)

        oversized = _event(int(time.time()), event_id="x" * 4097)
        rejected = self.mod.normalize_dispatch_observation(oversized)
        self.assertEqual(rejected.code.value, "invalid_event_id")

        first = _event(int(time.time()), event_id="x" * 4095 + "a")
        second = _event(int(time.time()), event_id="x" * 4095 + "b")
        first_normalized = self.mod.normalize_dispatch_observation(first)
        second_normalized = self.mod.normalize_dispatch_observation(second)
        self.assertEqual(type(first_normalized).__name__, "NormalizedObservation")
        self.assertEqual(type(second_normalized).__name__, "NormalizedObservation")
        self.assertNotEqual(
            self.mod.event_replay_identity_digest(first, first_normalized),
            self.mod.event_replay_identity_digest(second, second_normalized),
        )


if __name__ == "__main__":
    unittest.main()
