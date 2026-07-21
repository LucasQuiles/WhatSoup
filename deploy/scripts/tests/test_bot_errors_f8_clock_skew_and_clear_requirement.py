"""Authoritative clear-proof contract and dispatcher integration tests."""
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


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_f8", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _clear_event(
    epoch: int,
    *,
    source: str = "socket_down",
    machine: str = "host-a",
    instance: str = "ana-bot",
    schema_version: int = 1,
    policy: str = "same_source_newer",
    proof_ref: str | None = None,
    state: str = "healthy",
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schemaVersion": schema_version,
        "id": f"clear-{source}-{epoch}",
        "eventType": "clear",
        "severity": "info",
        "source": source,
        "instance": instance,
        "machine": machine,
        "summary": f"Recovery from {source}",
        "evidence": "system recovered",
        "createdAt": _iso(epoch),
    }
    if schema_version == 2:
        event.update({
            "observedAt": _iso(epoch),
            "observation": {
                "state": state,
                "confidence": "confirmed",
                "fingerprint": "a" * 64,
                "producerSequence": 8,
            },
            "clearPolicy": {
                "kind": policy,
                "minimumSchemaVersion": 2,
                **({"proofRef": proof_ref, "proofObservedAt": _iso(epoch)} if proof_ref else {}),
            },
            "remediation": {
                "recoverability": "auto_recoverable",
                "requestedAction": "observe_recovery",
                "authorization": "automatic_read_only",
            },
        })
    return event


def _open_record(
    key: str,
    opened: int,
    *,
    source: str = "socket_down",
    policy: str = "same_source_newer",
    minimum_schema: int = 1,
) -> dict[str, Any]:
    return {
        "status": "open",
        "incidentKey": key,
        "incidentSource": source,
        "eventCreatedAtEpoch": opened,
        "openedAt": opened,
        "openedIso": _iso(opened),
        "schemaVersion": minimum_schema,
        "clearPolicy": {"kind": policy, "minimumSchemaVersion": minimum_schema},
        "suppressedCount": 0,
    }


def _decision(mod: Any, record: dict[str, Any], event: dict[str, Any], receipts: list[dict[str, Any]] | None = None):
    observation = mod.normalize_dispatch_observation(event)
    assert type(observation).__name__ == "NormalizedObservation", observation
    return mod.evaluate_clear(record, observation, receipts or [])


class IsolatedDispatcherTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._old_state = os.environ.get("BOT_ERRORS_STATE_DIR")
        self._temp = tempfile.TemporaryDirectory(prefix="bot-errors-f8-")
        self.state_dir = Path(self._temp.name)
        os.environ["BOT_ERRORS_STATE_DIR"] = str(self.state_dir)
        self.mod = _load_module()

    def tearDown(self) -> None:
        if self._old_state is None:
            os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        else:
            os.environ["BOT_ERRORS_STATE_DIR"] = self._old_state
        self._temp.cleanup()

    def assert_isolated(self, paths: dict[str, Path] | None = None) -> None:
        self.assertEqual(self.mod.state_root().resolve(), self.state_dir.resolve())
        if paths is not None:
            self.assertEqual(paths["root"].resolve(), self.state_dir.resolve())


class ClearEvaluatorTests(IsolatedDispatcherTestCase):
    def test_same_source_newer_accepts_with_clock_skew_tolerance(self) -> None:
        opened = int(time.time())
        key = "host-a|ana-bot|socket_down"
        decision = _decision(self.mod, _open_record(key, opened), _clear_event(opened - 30))
        self.assertEqual(decision.status.value, "accepted")
        self.assertLessEqual(len(decision.reason), 256)
        self.assertEqual(decision.proof_receipt["incidentKey"], key)

    def test_stale_clear_rejects(self) -> None:
        opened = int(time.time())
        key = "host-a|ana-bot|socket_down"
        decision = _decision(self.mod, _open_record(key, opened), _clear_event(opened - 90))
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("stale", decision.reason)

    def test_wrong_source_and_key_reject(self) -> None:
        now = int(time.time())
        record = _open_record("host-a|ana-bot|socket_down", now - 300)
        decision = _decision(self.mod, record, _clear_event(now, source="health_body_degraded"))
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("identity", decision.reason)

    def test_future_proof_rejects(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|socket_down"
        decision = _decision(
            self.mod,
            _open_record(key, now - 300),
            _clear_event(now + 120),
            [{"kind": "evaluation_clock", "observedAtEpoch": now}],
        )
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("future", decision.reason)

    def test_unknown_observation_is_candidate(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|socket_down"
        observation = self.mod.normalize_dispatch_observation(_clear_event(now))
        observation = observation.__class__(**{**observation.__dict__, "state": self.mod.ObservationState.UNKNOWN})
        decision = self.mod.evaluate_clear(_open_record(key, now - 300), observation, [])
        self.assertEqual(decision.status.value, "candidate")

    def test_v1_clear_cannot_weaken_stored_v2_policy(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|socket_down"
        record = _open_record(key, now - 300, policy="health_snapshot", minimum_schema=2)
        decision = _decision(self.mod, record, _clear_event(now, schema_version=1))
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("schema", decision.reason)

    def test_missing_referenced_receipt_rejects(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(
            now,
            source="health_body_degraded",
            schema_version=2,
            policy="health_snapshot",
            proof_ref="health:missing",
        )
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        decision = _decision(self.mod, record, event, [])
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("receipt", decision.reason)

    def test_weak_receipt_schema_rejects(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="health:1")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipts = [{"kind": "health_snapshot", "ref": "health:1", "verified": True, "schemaVersion": 1, "observedAtEpoch": now, "incidentKey": key}]
        decision = _decision(self.mod, record, event, receipts)
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("schema", decision.reason)

    def test_health_snapshot_accepts_matching_authoritative_receipt(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="health:2")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipt = {"kind": "health_snapshot", "ref": "health:2", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "application_health", "state": "healthy", "ok": True}
        decision = _decision(self.mod, record, event, [receipt])
        self.assertEqual(decision.status.value, "accepted")

    def test_future_oracle_receipt_rejects(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="health:future")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipts = [
            {"kind": "health_snapshot", "ref": "health:future", "verified": True, "schemaVersion": 2, "observedAtEpoch": now + 120, "incidentKey": key, "scope": "application_health", "state": "healthy", "ok": True},
            {"kind": "evaluation_clock", "observedAtEpoch": now},
        ]
        self.assertEqual(_decision(self.mod, record, event, receipts).status.value, "rejected")

    def test_unknown_health_scope_is_candidate(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="health:unknown")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipt = {"kind": "health_snapshot", "ref": "health:unknown", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "mystery"}
        self.assertEqual(_decision(self.mod, record, event, [receipt]).status.value, "candidate")

    def test_missing_health_scope_is_candidate(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="health:missing-scope")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipt = {"kind": "health_snapshot", "ref": "health:missing-scope", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key}
        self.assertEqual(_decision(self.mod, record, event, [receipt]).status.value, "candidate")

    def test_wrong_v2_observation_identity_rejects_even_with_matching_receipt(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="other_health", schema_version=2, policy="health_snapshot", proof_ref="health:2")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipt = {"kind": "health_snapshot", "ref": "health:2", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "application_health"}
        decision = _decision(self.mod, record, event, [receipt])
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("identity", decision.reason)

    def test_proof_receipt_fields_and_serialized_form_are_bounded(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="health:2")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipt = {"kind": "health_snapshot", "ref": "health:2", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "x" * 10_000, "state": "y" * 10_000}
        decision = _decision(self.mod, record, event, [receipt])
        encoded = json.dumps(decision.proof_receipt, sort_keys=True)
        self.assertLessEqual(len(encoded), 2048)
        for bounded in decision.proof_receipt["evidenceRefs"]:
            for value in bounded.values():
                if isinstance(value, str):
                    self.assertLessEqual(len(value), 256)

    def test_outbound_after_incident_accepts(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|bot_errors_delivery"
        event = _clear_event(now, source="bot_errors_delivery", schema_version=2, policy="outbound_after_incident", proof_ref="outbound:9")
        record = _open_record(key, now - 300, source="bot_errors_delivery", policy="outbound_after_incident", minimum_schema=2)
        receipt = {"kind": "outbound_after_incident", "ref": "outbound:9", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key}
        self.assertEqual(_decision(self.mod, record, event, [receipt]).status.value, "accepted")

    def test_outbound_at_incident_open_is_candidate(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|bot_errors_delivery"
        event = _clear_event(now, source="bot_errors_delivery", schema_version=2, policy="outbound_after_incident", proof_ref="outbound:old")
        record = _open_record(key, now - 300, source="bot_errors_delivery", policy="outbound_after_incident", minimum_schema=2)
        receipt = {"kind": "outbound_after_incident", "ref": "outbound:old", "verified": True, "schemaVersion": 2, "observedAtEpoch": now - 300, "incidentKey": key}
        self.assertEqual(_decision(self.mod, record, event, [receipt]).status.value, "candidate")

    def test_continuity_policy_without_open_epoch_is_candidate(self) -> None:
        now = int(time.time())
        for policy, source in (
            ("outbound_after_incident", "bot_errors_delivery"),
            ("auth_bond_and_outbound", "whatsapp_device_bond_lost"),
        ):
            with self.subTest(policy=policy):
                key = f"host-a|ana-bot|{source}"
                event = _clear_event(now, source=source, schema_version=2, policy=policy, proof_ref="continuity:1")
                record = _open_record(key, now - 300, source=source, policy=policy, minimum_schema=2)
                record["openedAt"] = 0
                record["eventCreatedAtEpoch"] = 0
                receipts = [
                    {"kind": "auth_bond", "ref": "continuity:1", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "state": "present"},
                    {"kind": "outbound_after_incident", "ref": "continuity:1", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key},
                ]
                self.assertEqual(_decision(self.mod, record, event, receipts).status.value, "candidate")

    def test_auth_bond_plus_outbound_accepts(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|whatsapp_device_bond_lost"
        event = _clear_event(now, source="whatsapp_device_bond_lost", schema_version=2, policy="auth_bond_and_outbound", proof_ref="auth:9")
        record = _open_record(key, now - 300, source="whatsapp_device_bond_lost", policy="auth_bond_and_outbound", minimum_schema=2)
        receipts = [
            {"kind": "auth_bond", "ref": "auth:9", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "state": "present"},
            {"kind": "outbound_after_incident", "ref": "auth:9", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key},
        ]
        self.assertEqual(_decision(self.mod, record, event, receipts).status.value, "accepted")

    def test_auth_bond_requires_present_state(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|whatsapp_device_bond_lost"
        event = _clear_event(now, source="whatsapp_device_bond_lost", schema_version=2, policy="auth_bond_and_outbound", proof_ref="auth:weak")
        record = _open_record(key, now - 300, source="whatsapp_device_bond_lost", policy="auth_bond_and_outbound", minimum_schema=2)
        receipts = [
            {"kind": "auth_bond", "ref": "auth:weak", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "state": "unknown"},
            {"kind": "outbound_after_incident", "ref": "auth:weak", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key},
        ]
        self.assertEqual(_decision(self.mod, record, event, receipts).status.value, "candidate")

    def test_source_quiet_and_health_requires_semantic_receipts(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|flap_storm"
        event = _clear_event(now, source="flap_storm", schema_version=2, policy="source_quiet_and_health", proof_ref="quiet:1")
        record = _open_record(key, now - 300, source="flap_storm", policy="source_quiet_and_health", minimum_schema=2)
        health = {"kind": "health_snapshot", "ref": "quiet:1", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "application_health", "state": "healthy", "ok": True}
        noisy = {"kind": "source_quiet", "ref": "quiet:1", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "state": "noisy"}
        self.assertEqual(_decision(self.mod, record, event, [health, noisy]).status.value, "candidate")
        quiet = {**noisy, "state": "quiet"}
        self.assertEqual(_decision(self.mod, record, event, [health, quiet]).status.value, "accepted")

    def test_degraded_reachability_is_not_application_health_proof(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="reach:1")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipt = {"kind": "health_snapshot", "ref": "reach:1", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "reachability", "priorState": "unreachable", "state": "degraded"}
        self.assertEqual(_decision(self.mod, record, event, [receipt]).status.value, "candidate")

    def test_running_oneshot_with_prior_failure_is_unknown(self) -> None:
        now = int(time.time())
        key = "host-a|health-check|daily-health-fail:unit"
        event = _clear_event(now, source="daily-health-fail", schema_version=2, policy="health_snapshot", proof_ref="unit:1")
        record = _open_record(key, now - 300, source="daily-health-fail:unit", policy="health_snapshot", minimum_schema=2)
        observation = self.mod.normalize_dispatch_observation(event)
        observation = observation.__class__(**{
            **observation.__dict__,
            "incident_key": key,
            "incident_source": "daily-health-fail:unit",
            "target_incident_key": key,
        })
        for state in ("activating", "running"):
            with self.subTest(state=state):
                receipt = {"kind": "health_snapshot", "ref": "unit:1", "verified": False, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "unit_execution", "state": state, "priorResult": "failed"}
                self.assertEqual(self.mod.evaluate_clear(record, observation, [receipt]).status.value, "candidate")

    def test_terminal_success_closes_only_matching_unit_incident(self) -> None:
        now = int(time.time())
        unit_key = "host-a|health-check|daily-health-fail:unit"
        app_key = "host-a|health-check|daily-health:attention-required"
        event = _clear_event(now, source="daily-health-fail", schema_version=2, policy="health_snapshot", proof_ref="unit:2")
        receipt = {"kind": "health_snapshot", "ref": "unit:2", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": unit_key, "scope": "unit_execution", "state": "terminal_success", "result": "success", "exitStatus": 0}
        unit = _open_record(unit_key, now - 300, source="daily-health-fail:unit", policy="health_snapshot", minimum_schema=2)
        app = _open_record(app_key, now - 300, source="daily-health:attention-required", policy="health_snapshot", minimum_schema=2)
        unit_observation = self.mod.normalize_dispatch_observation(event)
        unit_observation = unit_observation.__class__(**{
            **unit_observation.__dict__,
            "incident_key": unit_key,
            "incident_source": "daily-health-fail:unit",
            "target_incident_key": unit_key,
        })
        self.assertEqual(self.mod.evaluate_clear(unit, unit_observation, [receipt]).status.value, "accepted")
        app_receipt = {**receipt, "incidentKey": app_key, "scope": "application_health", "state": "attention-required", "ok": False}
        app_observation = self.mod.normalize_dispatch_observation(event)
        app_observation = app_observation.__class__(**{
            **app_observation.__dict__,
            "incident_key": app_key,
            "incident_source": "daily-health:attention-required",
            "target_incident_key": app_key,
        })
        self.assertNotEqual(self.mod.evaluate_clear(app, app_observation, [app_receipt]).status.value, "accepted")

    def test_empty_transition_batch_is_candidate_not_health_proof(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="batch:0")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        receipt = {"kind": "health_snapshot", "ref": "batch:0", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": key, "scope": "transition_batch", "transitionCount": 0}
        self.assertEqual(_decision(self.mod, record, event, [receipt]).status.value, "candidate")


class DispatcherClearEnforcementTests(IsolatedDispatcherTestCase):
    def test_requirement_mismatch_is_suppressed_and_open_incident_retained(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        key = "host-a|ana-bot|socket_down"
        record = _open_record(key, now - 300, policy="auth_bond_and_outbound", minimum_schema=2)
        state = {"version": 1, "openIncidents": {key: record}, "lastSentAt": {key: now - 300}}
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        event = _clear_event(now)
        event_path = paths["outbox"] / "mismatch.json"
        event_path.write_text(json.dumps(event), encoding="utf-8")

        with patch.object(self.mod, "send_whatsapp") as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)

        self.assertTrue(ok, detail)
        self.assertEqual(detail, "suppressed")
        send.assert_not_called()
        persisted = self.mod.load_incident_state(paths)
        self.assertIn(key, persisted["openIncidents"])
        evidence = persisted["openIncidents"][key]["rejectedClearProofs"]
        self.assertTrue(evidence)
        self.assertNotIn("advisory_only_incident_still_closed", json.dumps(persisted))

    def test_weak_auth_never_gains_physical_authority_or_absorbs_symptom_freshness(self) -> None:
        now = int(time.time())
        event = _clear_event(now, source="instance_logged_out")
        event["eventType"] = "alert"
        event["severity"] = "warning"
        event["criticalAsset"] = {
            "asset": {"kind": "whatsapp_linked_device", "instance": "ana-bot"},
            "failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED", "recoverability": "manual_relink_required", "confidence": "probable"},
            "evidenceRefs": ["connected=false", "state=connecting", "disconnect_class=none", "reconnect_phase=backoff", "reconnect_attempts=0", "weak_signal_polls=3"],
        }
        key = self.mod.incident_key(event)
        state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        self.assert_isolated()
        self.mod.mark_incident_sent(event, state, self.mod.normalize_dispatch_observation(event))
        record = state["openIncidents"][key]
        self.assertNotEqual(record["status"], "awaiting_physical")
        self.assertEqual(record["clearPolicy"]["kind"], "same_source_newer")
        repeated = {**event, "id": "weak-auth-repeat"}
        normalized_repeat = self.mod.normalize_dispatch_observation(repeated)
        self.assertEqual(normalized_repeat.classification, "inferred_transient")
        with patch.object(self.mod, "update_awaiting_physical_tracking") as update_physical:
            self.assert_isolated()
            self.mod.should_suppress_send(repeated, state, normalized_repeat)
        update_physical.assert_not_called()
        before = record["lastSeenAt"]
        before_suppressed = record["suppressedCount"]
        symptom = {**event, "id": "symptom", "source": "health_body_degraded", "criticalAsset": {}}
        self.assert_isolated()
        self.mod.should_suppress_send(symptom, state, self.mod.normalize_dispatch_observation(symptom))
        self.assertEqual(record["lastSeenAt"], before)
        self.assertEqual(record["suppressedCount"], before_suppressed)

    def test_transient_auth_recovers_without_relink_but_terminal_auth_requires_stronger_proof(self) -> None:
        now = int(time.time())
        transient_key = "host-a|ana-bot|instance_logged_out"
        transient = _open_record(transient_key, now - 300, source="instance_logged_out")
        connected = _clear_event(now, source="instance_logged_out")
        self.assertEqual(_decision(self.mod, transient, connected).status.value, "accepted")

        terminal = _open_record(
            transient_key,
            now - 300,
            source="instance_logged_out",
            policy="auth_bond_and_outbound",
            minimum_schema=2,
        )
        weak = _clear_event(now, source="instance_logged_out", schema_version=1)
        self.assertEqual(_decision(self.mod, terminal, weak).status.value, "rejected")
        strong = _clear_event(now, source="instance_logged_out", schema_version=2, policy="auth_bond_and_outbound", proof_ref="auth:terminal")
        receipts = [
            {"kind": "auth_bond", "ref": "auth:terminal", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": transient_key, "state": "present"},
            {"kind": "outbound_after_incident", "ref": "auth:terminal", "verified": True, "schemaVersion": 2, "observedAtEpoch": now, "incidentKey": transient_key},
        ]
        self.assertEqual(_decision(self.mod, terminal, strong, receipts).status.value, "accepted")

    def test_accepted_close_state_write_fault_requeues_without_notification_or_ack(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        key = "host-a|ana-bot|socket_down"
        state = {"version": 1, "openIncidents": {key: _open_record(key, now - 300)}, "lastSentAt": {key: now - 300}}
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        event_path = paths["outbox"] / "accepted.json"
        event_path.write_text(json.dumps(_clear_event(now)), encoding="utf-8")
        fault = OSError("injected accepted-close state write fault")

        with (
            patch.object(self.mod, "save_incident_state", side_effect=fault) as save,
            patch.object(self.mod, "send_whatsapp") as send,
        ):
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)

        self.assertFalse(ok)
        self.assertIn("clear_state_persist_failed", detail)
        self.assertEqual(save.call_count, 1, "injected fault must occur exactly once")
        send.assert_not_called()
        self.assertTrue(event_path.exists(), "accepted clear must remain retry-owned in outbox")
        self.assertFalse(list(paths["sent"].iterdir()))
        persisted = self.mod.load_incident_state(paths)
        self.assertIn(key, persisted["openIncidents"])
        self.assertNotIn("closedHistory", persisted)

    def test_send_failure_keeps_durable_close_and_retry_can_notify(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        key = "host-a|ana-bot|socket_down"
        state = {"version": 1, "openIncidents": {key: _open_record(key, now - 300)}, "lastSentAt": {key: now - 300}}
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        event_path = paths["outbox"] / "send-retry.json"
        retry_event = _clear_event(now)
        retry_event["diagnostics"] = {"omitDispatchLogInMessage": True}
        event_path.write_text(json.dumps(retry_event), encoding="utf-8")

        with patch.object(self.mod, "send_whatsapp", side_effect=RuntimeError("transport unavailable")) as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertFalse(ok)
        self.assertIn("transport unavailable", detail)
        send.assert_called_once()
        persisted = self.mod.load_incident_state(paths)
        self.assertNotIn(key, persisted["openIncidents"])
        self.assertTrue(persisted["closedHistory"])
        digest = self.mod.clear_event_identity_digest(_clear_event(now))
        self.assertIn(digest, persisted["acceptedClearNotifications"])
        self.assertTrue(event_path.exists())

        with patch.object(self.mod, "send_whatsapp") as retry_send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertTrue(ok, detail)
        self.assertEqual(detail, "sent")
        retry_send.assert_called_once()
        self.assertFalse(event_path.exists())
        self.assertTrue(list(paths["sent"].iterdir()))

    def test_accepted_retry_receipt_is_bounded_and_rejects_mutated_same_id(self) -> None:
        now = int(time.time())
        state: dict[str, Any] = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        last_event: dict[str, Any] | None = None
        for index in range(55):
            key = f"host-a|bot-{index}|socket_down"
            event = _clear_event(now + index, instance=f"bot-{index}")
            record = _open_record(key, now - 300, source="socket_down")
            state["openIncidents"][key] = record
            observation = self.mod.normalize_dispatch_observation(event)
            decision = self.mod.evaluate_clear(self.mod.clear_record_view(key, record), observation, [])
            self.assert_isolated()
            self.mod.finalize_accepted_clear(state, key, event, decision)
            self.assert_isolated()
            self.mod.record_accepted_clear_notification(state, event, observation, [(key, decision)])
            last_event = event
        self.assertEqual(len(state["acceptedClearNotifications"]), 50)
        assert last_event is not None
        observation = self.mod.normalize_dispatch_observation(last_event)
        self.assertIsNotNone(self.mod.pending_clear_notification_decision(last_event, state, observation))
        mutated = {**last_event, "source": "health_body_degraded"}
        mutated_observation = self.mod.normalize_dispatch_observation(mutated)
        self.assertIsNone(self.mod.pending_clear_notification_decision(mutated, state, mutated_observation))

    def test_long_prefix_event_ids_do_not_alias_retry_authorization(self) -> None:
        now = int(time.time())
        state: dict[str, Any] = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        digests: list[str] = []
        for suffix in ("a", "b"):
            event = _clear_event(now)
            event["id"] = "x" * 128 + suffix
            observation = self.mod.normalize_dispatch_observation(event)
            self.assertEqual(type(observation).__name__, "NormalizedObservation")
            decision = self.mod.evaluate_clear(
                _open_record(observation.incident_key, now - 300), observation, []
            )
            self.assert_isolated()
            self.mod.record_accepted_clear_notification(
                state, event, observation, [(observation.incident_key, decision)]
            )
            digests.append(self.mod.clear_event_identity_digest(event))
        self.assertNotEqual(digests[0], digests[1])
        self.assertEqual(len(state["acceptedClearNotifications"]), 2)

    def test_multi_close_retry_binds_original_envelope_identity(self) -> None:
        now = int(time.time())
        event = _clear_event(now, source="daily-health", instance="bot-errors-health")
        observation = self.mod.normalize_dispatch_observation(event)
        state: dict[str, Any] = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        closures = []
        for source in ("health_body_degraded", "instance_degraded"):
            key = f"host-a|ana-bot|{source}"
            target = observation.__class__(**{
                **observation.__dict__,
                "incident_key": key,
                "incident_source": source,
                "target_incident_key": key,
            })
            record = _open_record(key, now - 300, source=source, policy="health_snapshot")
            receipt = {"kind": "health_snapshot", "verified": True, "schemaVersion": 1, "observedAtEpoch": now, "incidentKey": key, "scope": "application_health", "state": "healthy", "ok": True}
            decision = self.mod.evaluate_clear(record, target, [receipt])
            closures.append((key, decision))
        self.assert_isolated()
        self.mod.record_accepted_clear_notification(state, event, observation, closures)
        self.assertIsNotNone(self.mod.pending_clear_notification_decision(event, state, observation))
        stored = next(iter(state["acceptedClearNotifications"].values()))
        self.assertEqual(len(stored["closures"]), 2)

    def test_mixed_source_batch_records_nonaccepted_sibling_evidence(self) -> None:
        now = int(time.time())
        machine, instance = "host-a", "ana-bot"
        accepted_key = f"{machine}|{instance}|health_body_degraded"
        candidate_key = f"{machine}|{instance}|daily-health-fail:unit"
        state = {
            "version": 1,
            "openIncidents": {
                accepted_key: _open_record(accepted_key, now - 300, source="health_body_degraded", policy="health_snapshot"),
                candidate_key: _open_record(candidate_key, now - 300, source="daily-health-fail:unit", policy="health_snapshot"),
            },
            "lastSentAt": {},
        }
        probe = (
            "200 status=healthy wa_connected=true state=connected auth_bond_status=present "
            "auth_bond_creds_exists=true auth_bond_creds_size=4096 auth_failure_class=none"
        )
        event = _clear_event(now, source="daily-health", instance="bot-errors-health")
        event["evidence"] = f"health {instance}: {probe}"
        observation = self.mod.normalize_dispatch_observation(event)
        self.assert_isolated()
        decisions = self.mod.source_specific_clear_decisions(event, state, observation)
        by_key = {key: decision.status.value for key, decision in decisions}
        self.assertEqual(by_key[accepted_key], "accepted")
        self.assertEqual(by_key[candidate_key], "candidate")
        self.assert_isolated()
        reason = self.mod.should_suppress_send(event, state, observation, None, decisions)
        self.assertIsNone(reason)
        self.assertIn(candidate_key, state["openIncidents"])
        self.assertTrue(state["openIncidents"][candidate_key]["candidateClearProofs"])
        accepted_keys = [key for key, decision in decisions if decision.status.value == "accepted"]
        self.assert_isolated()
        self.mod.append_clear_context(event, state, accepted_keys)
        self.assertIn(accepted_key, event["evidence"])
        self.assertNotIn(candidate_key, event["evidence"])


if __name__ == "__main__":
    unittest.main()
