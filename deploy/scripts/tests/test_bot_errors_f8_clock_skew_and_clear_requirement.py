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

    def test_clock_skew_tolerance_boundary_is_inclusive(self) -> None:
        opened = int(time.time())
        key = "host-a|ana-bot|socket_down"
        tolerance = self.mod.CLOCK_SKEW_TOLERANCE_SECONDS
        at_boundary = _decision(
            self.mod,
            _open_record(key, opened),
            _clear_event(opened - tolerance),
        )
        beyond_boundary = _decision(
            self.mod,
            _open_record(key, opened),
            _clear_event(opened - tolerance - 1),
        )
        self.assertEqual(at_boundary.status.value, "accepted")
        self.assertEqual(beyond_boundary.status.value, "rejected")
        self.assertIn("stale", beyond_boundary.reason)

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

    def test_missing_unreferenced_receipt_is_candidate(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded")
        record = _open_record(
            key,
            now - 300,
            source="health_body_degraded",
            policy="health_snapshot",
        )
        decision = _decision(self.mod, record, event, [])
        self.assertEqual(decision.status.value, "candidate")

    def test_unreferenced_wrong_key_receipt_rejects(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded")
        record = _open_record(
            key,
            now - 300,
            source="health_body_degraded",
            policy="health_snapshot",
        )
        receipt = {
            "kind": "health_snapshot",
            "verified": True,
            "schemaVersion": 1,
            "observedAtEpoch": now,
            "incidentKey": "host-a|other-bot|health_body_degraded",
            "scope": "application_health",
            "state": "healthy",
            "ok": True,
        }
        decision = _decision(self.mod, record, event, [receipt])
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("identity", decision.reason)

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

    def test_reachability_requires_explicit_healthy_state(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|instance_unreachable"
        event = _clear_event(now, source="instance_unreachable", schema_version=2, policy="health_snapshot", proof_ref="reachability:1")
        record = _open_record(key, now - 300, source="instance_unreachable", policy="health_snapshot", minimum_schema=2)
        base = {
            "kind": "health_snapshot",
            "ref": "reachability:1",
            "verified": True,
            "schemaVersion": 2,
            "observedAtEpoch": now,
            "incidentKey": key,
            "scope": "reachability",
        }
        self.assertEqual(
            _decision(self.mod, record, event, [{**base, "state": "healthy"}]).status.value,
            "accepted",
        )
        for state in (None, "unknown", "unreachable", "degraded"):
            with self.subTest(state=state):
                receipt = dict(base)
                if state is not None:
                    receipt["state"] = state
                self.assertEqual(
                    _decision(self.mod, record, event, [receipt]).status.value,
                    "candidate",
                )

    def test_transition_batch_requires_directional_healthy_semantics(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        event = _clear_event(now, source="health_body_degraded", schema_version=2, policy="health_snapshot", proof_ref="batch:semantic")
        record = _open_record(key, now - 300, source="health_body_degraded", policy="health_snapshot", minimum_schema=2)
        base = {
            "kind": "health_snapshot",
            "ref": "batch:semantic",
            "verified": True,
            "schemaVersion": 2,
            "observedAtEpoch": now,
            "incidentKey": key,
            "scope": "transition_batch",
        }
        positive = {**base, "transitionCount": 1, "state": "healthy", "ok": True}
        self.assertEqual(_decision(self.mod, record, event, [positive]).status.value, "accepted")
        negatives = [
            {**base, "state": "healthy", "ok": True},
            {**base, "transitionCount": "1", "state": "healthy", "ok": True},
            {**base, "transitionCount": True, "state": "healthy", "ok": True},
            {**base, "transitionCount": 0, "state": "healthy", "ok": True},
            {**base, "transitionCount": -1, "state": "healthy", "ok": True},
            {**base, "transitionCount": 1, "ok": True},
            {**base, "transitionCount": 1, "state": "unknown", "ok": True},
            {**base, "transitionCount": 1, "state": "healthy"},
            {**base, "transitionCount": 1, "state": "healthy", "ok": False},
        ]
        for index, receipt in enumerate(negatives):
            with self.subTest(index=index, receipt=receipt):
                self.assertEqual(
                    _decision(self.mod, record, event, [receipt]).status.value,
                    "candidate",
                )

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
    def _persist_state_and_event(
        self,
        paths: dict[str, Path],
        state: dict[str, Any],
        event: dict[str, Any],
        name: str,
    ) -> Path:
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        event.setdefault("diagnostics", {})["omitDispatchLogInMessage"] = True
        event_path = paths["outbox"] / name
        event_path.write_text(json.dumps(event), encoding="utf-8")
        return event_path

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

    def test_stale_clear_persists_one_rejected_proof_without_notification(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        key = "host-a|ana-bot|socket_down"
        state = {"version": 1, "openIncidents": {key: _open_record(key, now)}, "lastSentAt": {key: now}}
        event = _clear_event(now - 90)
        event_path = self._persist_state_and_event(paths, state, event, "stale.json")
        with patch.object(self.mod, "send_whatsapp") as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertTrue(ok, detail)
        self.assertEqual(detail, "suppressed")
        send.assert_not_called()
        persisted = self.mod.load_incident_state(paths)
        self.assertIn(key, persisted["openIncidents"])
        proofs = persisted["openIncidents"][key]["rejectedClearProofs"]
        self.assertEqual(len(proofs), 1)
        self.assertIn("stale", proofs[0]["reason"])

    def test_direct_accepted_with_source_candidate_records_sibling_evidence(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        direct_key = "host-a|bot-errors-health|daily-health"
        source_key = "host-a|ana-bot|whatsapp_device_bond_lost"
        state = {
            "version": 1,
            "openIncidents": {
                direct_key: _open_record(direct_key, now - 300, source="daily-health"),
                source_key: _open_record(source_key, now - 300, source="whatsapp_device_bond_lost", policy="auth_bond_and_outbound"),
            },
            "lastSentAt": {},
        }
        probe = "200 status=healthy wa_connected=true state=connected auth_bond_status=present auth_bond_creds_exists=true auth_bond_creds_size=4096 auth_failure_class=none"
        event = _clear_event(now, source="daily-health", instance="bot-errors-health")
        event["evidence"] = f"health ana-bot: {probe}"
        event_path = self._persist_state_and_event(paths, state, event, "mixed-direct-accepted.json")
        with patch.object(self.mod, "send_whatsapp") as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertTrue(ok, detail)
        self.assertEqual(detail, "sent")
        send.assert_called_once()
        persisted = self.mod.load_incident_state(paths)
        self.assertNotIn(direct_key, persisted["openIncidents"])
        self.assertIn(source_key, persisted["openIncidents"])
        self.assertTrue(persisted["openIncidents"][source_key]["candidateClearProofs"])
        sent_event = json.loads(next(paths["sent"].iterdir()).read_text(encoding="utf-8"))
        self.assertNotIn(source_key, sent_event["evidence"])

    def test_direct_rejected_with_source_accepted_closes_only_source(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        direct_key = "host-a|bot-errors-health|daily-health"
        source_key = "host-a|ana-bot|health_body_degraded"
        state = {
            "version": 1,
            "openIncidents": {
                direct_key: _open_record(direct_key, now - 300, source="daily-health", policy="health_snapshot", minimum_schema=2),
                source_key: _open_record(source_key, now - 300, source="health_body_degraded", policy="health_snapshot"),
            },
            "lastSentAt": {},
        }
        probe = "200 status=healthy wa_connected=true state=connected auth_bond_status=present auth_bond_creds_exists=true auth_bond_creds_size=4096 auth_failure_class=none"
        event = _clear_event(now, source="daily-health", instance="bot-errors-health")
        event["evidence"] = f"health ana-bot: {probe}"
        event_path = self._persist_state_and_event(paths, state, event, "mixed-direct-rejected.json")
        with patch.object(self.mod, "send_whatsapp") as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertTrue(ok, detail)
        self.assertEqual(detail, "sent")
        send.assert_called_once()
        persisted = self.mod.load_incident_state(paths)
        self.assertIn(direct_key, persisted["openIncidents"])
        self.assertTrue(persisted["openIncidents"][direct_key]["rejectedClearProofs"])
        self.assertNotIn(source_key, persisted["openIncidents"])
        sent_event = json.loads(next(paths["sent"].iterdir()).read_text(encoding="utf-8"))
        self.assertIn(source_key, sent_event["evidence"])
        self.assertNotIn(f"recovered_incidents={direct_key}", sent_event["evidence"])

    def test_terminal_unit_success_closes_unit_not_attention_application(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        unit_key = "host-a|bot-errors-health|daily-health-fail:ana-bot"
        app_key = "host-a|ana-bot|daily-health:attention-required"
        state = {
            "version": 1,
            "openIncidents": {
                unit_key: _open_record(unit_key, now - 300, source="daily-health-fail:ana-bot", policy="health_snapshot"),
                app_key: _open_record(app_key, now - 300, source="daily-health:attention-required", policy="health_snapshot"),
            },
            "lastSentAt": {},
        }
        event = _clear_event(now, source="daily-health", instance="ana-bot")
        event.update({
            "eventType": "alert",
            "severity": "warning",
            "alertSource": "attention-required",
            "summary": "BOT ERRORS daily health found issues",
        })
        event["evidence"] = "health ana-bot: 200 status=attention-required ok=false Result=success ExecMainStatus=0"
        event_path = self._persist_state_and_event(paths, state, event, "unit-terminal.json")
        with patch.object(self.mod, "send_whatsapp", side_effect=RuntimeError("transport unavailable")) as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertFalse(ok)
        self.assertIn("transport unavailable", detail)
        send.assert_called_once()
        persisted = self.mod.load_incident_state(paths)
        self.assertNotIn(unit_key, persisted["openIncidents"])
        self.assertIn(app_key, persisted["openIncidents"])
        queued_retry = json.loads(event_path.read_text(encoding="utf-8"))
        self.assertIsNotNone(
            self.mod.pending_clear_notification_decision(
                queued_retry,
                persisted,
                self.mod.normalize_dispatch_observation(queued_retry),
            )
        )
        self.assertTrue(event_path.exists())

        with patch.object(self.mod, "send_whatsapp") as retry_send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertTrue(ok, detail)
        self.assertEqual(detail, "sent")
        retry_send.assert_called_once()
        reloaded = self.mod.load_incident_state(paths)
        self.assertNotIn(unit_key, reloaded["openIncidents"])
        self.assertIn(app_key, reloaded["openIncidents"])
        sent_event = json.loads(next(paths["sent"].iterdir()).read_text(encoding="utf-8"))
        self.assertIn(unit_key, sent_event["evidence"])

    def test_running_unit_and_partial_health_are_candidates_with_evidence(self) -> None:
        now = int(time.time())
        unit_key = "host-a|bot-errors-health|daily-health-fail:ana-bot"
        health_key = "host-a|ana-bot|health_body_degraded"
        state = {
            "version": 1,
            "openIncidents": {
                unit_key: _open_record(unit_key, now - 300, source="daily-health-fail:ana-bot", policy="health_snapshot"),
                health_key: _open_record(health_key, now - 300, source="health_body_degraded", policy="health_snapshot"),
            },
            "lastSentAt": {},
        }
        event = _clear_event(now, source="daily-health", instance="bot-errors-health")
        event["evidence"] = "health ana-bot: 200 status=unknown ActiveState=running Result=exit-code ExecMainStatus=1"
        observation = self.mod.normalize_dispatch_observation(event)
        self.assert_isolated()
        decisions = self.mod.source_specific_clear_decisions(event, state, observation)
        by_key = dict(decisions)
        self.assertEqual(by_key[unit_key].status.value, "candidate")
        self.assertEqual(by_key[health_key].status.value, "candidate")
        self.assert_isolated()
        reason = self.mod.should_suppress_send(event, state, observation, None, decisions)
        self.assertIsNotNone(reason)
        self.assertTrue(state["openIncidents"][unit_key]["candidateClearProofs"])
        self.assertTrue(state["openIncidents"][health_key]["candidateClearProofs"])

    def test_alert_candidate_proofs_are_durable_before_transport_failure(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        unit_key = "host-a|bot-errors-health|daily-health-fail:ana-bot"
        state = {
            "version": 1,
            "openIncidents": {
                unit_key: _open_record(
                    unit_key,
                    now - 300,
                    source="daily-health-fail:ana-bot",
                    policy="health_snapshot",
                ),
            },
            "lastSentAt": {},
        }
        event = _clear_event(now, source="daily-health", instance="ana-bot")
        event.update({
            "eventType": "alert",
            "severity": "warning",
            "alertSource": "attention-required",
        })
        event["evidence"] = "health ana-bot: 200 status=attention-required ok=false ActiveState=running Result=exit-code ExecMainStatus=1"
        event_path = self._persist_state_and_event(paths, state, event, "candidate-send-fail.json")
        with patch.object(self.mod, "send_whatsapp", side_effect=RuntimeError("transport unavailable")) as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertFalse(ok)
        self.assertIn("transport unavailable", detail)
        send.assert_called_once()
        persisted = self.mod.load_incident_state(paths)
        self.assertTrue(persisted["openIncidents"][unit_key]["candidateClearProofs"])
        self.assertTrue(event_path.exists())

        interleaved = {**event, "id": "candidate-interleaved", "createdAt": _iso(now + 1)}
        interleaved_path = paths["outbox"] / "candidate-interleaved.json"
        interleaved_path.write_text(json.dumps(interleaved), encoding="utf-8")
        with (
            patch.object(self.mod.time, "time", return_value=now + 10),
            patch.object(self.mod, "send_whatsapp", side_effect=RuntimeError("transport unavailable")),
        ):
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(interleaved_path, paths)
        self.assertFalse(ok)
        self.assertIn("transport unavailable", detail)

        with (
            patch.object(self.mod.time, "time", return_value=now + 20),
            patch.object(self.mod, "send_whatsapp", side_effect=RuntimeError("transport unavailable")),
        ):
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertFalse(ok)
        self.assertIn("transport unavailable", detail)
        reloaded = self.mod.load_incident_state(paths)
        proofs = reloaded["openIncidents"][unit_key]["candidateClearProofs"]
        self.assertEqual(len(proofs), 2)
        self.assertEqual(len({proof["proofIdentity"] for proof in proofs}), 2)

    def test_alert_candidate_proof_save_failure_requeues_before_send(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        unit_key = "host-a|bot-errors-health|daily-health-fail:ana-bot"
        state = {
            "version": 1,
            "openIncidents": {
                unit_key: _open_record(
                    unit_key,
                    now - 300,
                    source="daily-health-fail:ana-bot",
                    policy="health_snapshot",
                ),
            },
            "lastSentAt": {},
        }
        event = _clear_event(now, source="daily-health", instance="ana-bot")
        event.update({
            "eventType": "alert",
            "severity": "warning",
            "alertSource": "attention-required",
        })
        event["evidence"] = "health ana-bot: 200 status=attention-required ok=false ActiveState=running Result=exit-code ExecMainStatus=1"
        event_path = self._persist_state_and_event(paths, state, event, "candidate-save-fail.json")
        with (
            patch.object(self.mod, "save_incident_state", side_effect=OSError("injected proof save fault")) as save,
            patch.object(self.mod, "send_whatsapp") as send,
        ):
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertFalse(ok)
        self.assertIn("proof_state_persist_failed", detail)
        save.assert_called_once()
        send.assert_not_called()
        self.assertTrue(event_path.exists())
        self.assertFalse(list(paths["sent"].iterdir()))

    def test_source_specific_skew_is_selected_then_evaluator_decides(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        probe = "200 status=healthy wa_connected=true state=connected auth_bond_status=present auth_bond_creds_exists=true auth_bond_creds_size=4096 auth_failure_class=none"
        for offset, expected in ((-30, "accepted"), (-90, "rejected")):
            with self.subTest(offset=offset):
                opened = now
                state = {"version": 1, "openIncidents": {key: _open_record(key, opened, source="health_body_degraded", policy="health_snapshot")}, "lastSentAt": {}}
                event = _clear_event(opened + offset, source="daily-health", instance="bot-errors-health")
                event["evidence"] = f"health ana-bot: {probe}"
                observation = self.mod.normalize_dispatch_observation(event)
                self.assert_isolated()
                candidates = self.mod.daily_health_clear_candidate_keys(event, state)
                self.assertIn(key, candidates)
                decisions = self.mod.source_specific_clear_decisions(event, state, observation)
                self.assertEqual(dict(decisions)[key].status.value, expected)
                if expected == "rejected":
                    self.assert_isolated()
                    self.mod.should_suppress_send(event, state, observation, None, decisions)
                    self.assertTrue(state["openIncidents"][key]["rejectedClearProofs"])

    def test_alert_storage_applies_source_minimum_clear_policy(self) -> None:
        now = int(time.time())
        cases = [
            ("health_body_degraded", "ana-bot", None),
            ("daily-health-fail", "bot-errors-health", "ana-bot"),
            ("instance_unreachable", "ana-bot", None),
        ]
        for source, instance, alert_source in cases:
            with self.subTest(source=source):
                event = _clear_event(now, source=source, instance=instance)
                event.update({"id": f"alert-{source}", "eventType": "alert", "severity": "warning"})
                if alert_source:
                    event["alertSource"] = alert_source
                normalized = self.mod.normalize_dispatch_observation(event)
                state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
                self.assert_isolated()
                self.mod.mark_incident_sent(event, state, normalized)
                key = normalized.incident_key
                self.assertEqual(state["openIncidents"][key]["clearPolicy"]["kind"], "health_snapshot")
                clear = {**event, "id": f"clear-{source}", "eventType": "clear", "severity": "info"}
                clear_normalized = self.mod.normalize_dispatch_observation(clear)
                decision = self.mod.direct_clear_decision(clear, state, clear_normalized)
                self.assertIsNotNone(decision)
                self.assertEqual(decision.status.value, "candidate")

        weak = _clear_event(now, source="instance_logged_out")
        weak.update({"id": "weak-auth-alert", "eventType": "alert", "severity": "warning"})
        weak["criticalAsset"] = {
            "asset": {"kind": "whatsapp_linked_device", "instance": "ana-bot"},
            "failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED", "recoverability": "manual_relink_required", "confidence": "probable"},
            "evidenceRefs": ["connected=false", "state=connecting", "disconnect_class=none", "reconnect_phase=backoff", "reconnect_attempts=0", "weak_signal_polls=3"],
        }
        weak_normalized = self.mod.normalize_dispatch_observation(weak)
        weak_state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        self.assert_isolated()
        self.mod.mark_incident_sent(weak, weak_state, weak_normalized)
        self.assertEqual(weak_state["openIncidents"][weak_normalized.incident_key]["clearPolicy"]["kind"], "same_source_newer")
        terminal = {**weak, "id": "terminal-auth-alert", "criticalAsset": {**weak["criticalAsset"], "evidenceRefs": []}}
        terminal_normalized = self.mod.normalize_dispatch_observation(terminal)
        terminal_state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        self.assert_isolated()
        self.mod.mark_incident_sent(terminal, terminal_state, terminal_normalized)
        self.assertEqual(terminal_state["openIncidents"][terminal_normalized.incident_key]["clearPolicy"]["kind"], "auth_bond_and_outbound")

    def test_weaker_repeated_alert_cannot_downgrade_policy_or_authority(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|health_body_degraded"
        existing = _open_record(
            key,
            now - 300,
            source="health_body_degraded",
            policy="auth_bond_and_outbound",
            minimum_schema=2,
        )
        existing.update({"classification": "physical_intervention", "clearAuthority": "authoritative"})
        state = {"version": 1, "openIncidents": {key: existing}, "lastSentAt": {}}
        repeated = _clear_event(now, source="health_body_degraded")
        repeated.update({"id": "weaker-repeat", "eventType": "alert", "severity": "warning"})
        normalized = self.mod.normalize_dispatch_observation(repeated)
        self.assert_isolated()
        self.mod.mark_incident_sent(repeated, state, normalized)
        stored = state["openIncidents"][key]
        self.assertEqual(stored["schemaVersion"], 2)
        self.assertEqual(stored["clearPolicy"], {
            "kind": "auth_bond_and_outbound",
            "minimumSchemaVersion": 2,
        })
        self.assertEqual(stored["classification"], "physical_intervention")
        self.assertEqual(stored["clearAuthority"], "authoritative")

        weak_clear = _clear_event(now + 1, source="health_body_degraded")
        decision = self.mod.direct_clear_decision(
            weak_clear,
            state,
            self.mod.normalize_dispatch_observation(weak_clear),
        )
        self.assertIsNotNone(decision)
        self.assertEqual(decision.status.value, "rejected")
        self.assertIn("schema", decision.reason)

    def test_weak_repeat_preserves_legacy_authoritative_record(self) -> None:
        now = int(time.time())
        key = "host-a|ana-bot|instance_logged_out"
        legacy = _open_record(key, now - 300, source="instance_logged_out")
        legacy.pop("classification", None)
        legacy.pop("clearAuthority", None)
        state = {"version": 1, "openIncidents": {key: legacy}, "lastSentAt": {}}
        weak = _clear_event(now, source="instance_logged_out")
        weak.update({"id": "weak-repeat-legacy", "eventType": "alert", "severity": "warning"})
        weak["criticalAsset"] = {
            "asset": {"kind": "whatsapp_linked_device", "instance": "ana-bot"},
            "failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED", "recoverability": "manual_relink_required", "confidence": "probable"},
            "evidenceRefs": ["connected=false", "state=connecting", "disconnect_class=none", "reconnect_phase=backoff", "reconnect_attempts=0", "weak_signal_polls=3"],
        }
        normalized = self.mod.normalize_dispatch_observation(weak)
        self.assertEqual(normalized.classification, "inferred_transient")
        self.assert_isolated()
        self.mod.mark_incident_sent(weak, state, normalized)
        stored = state["openIncidents"][key]
        self.assertEqual(stored["classification"], "standard")
        self.assertEqual(stored["clearAuthority"], "authoritative")
        self.assertEqual(stored["clearPolicy"]["kind"], "auth_bond_and_outbound")

    def test_weak_auth_cannot_supersede_symptoms_but_terminal_auth_can(self) -> None:
        now = int(time.time())
        symptom_keys = [
            "host-a|ana-bot|health_body_degraded",
            "host-a|ana-bot|instance_unreachable",
            "host-a|ana-bot|outbound_send_failed",
        ]

        def symptom_state() -> dict[str, Any]:
            return {
                "version": 1,
                "openIncidents": {
                    key: _open_record(key, now - 300, source=key.rsplit("|", 1)[-1])
                    for key in symptom_keys
                },
                "lastSentAt": {},
            }

        weak = _clear_event(now, source="instance_logged_out")
        weak.update({"id": "weak-auth", "eventType": "alert", "severity": "warning"})
        weak["criticalAsset"] = {
            "asset": {"kind": "whatsapp_linked_device", "instance": "ana-bot"},
            "failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED", "recoverability": "manual_relink_required", "confidence": "probable"},
            "evidenceRefs": ["connected=false", "state=connecting", "disconnect_class=none", "reconnect_phase=backoff", "reconnect_attempts=0", "weak_signal_polls=3"],
        }
        weak_state = symptom_state()
        weak_normalized = self.mod.normalize_dispatch_observation(weak)
        self.assertEqual(weak_normalized.classification, "inferred_transient")
        self.assert_isolated()
        self.mod.mark_incident_sent(weak, weak_state, weak_normalized)
        for key in symptom_keys:
            self.assertIn(key, weak_state["openIncidents"])
        weak_key = weak_normalized.incident_key
        self.assertEqual(weak_state["openIncidents"][weak_key]["clearAuthority"], "transient")
        symptom_event = _clear_event(now + 1, source="health_body_degraded")
        symptom_event.update({"eventType": "alert", "severity": "warning"})
        self.assertIsNone(self.mod.stronger_open_incident_for(symptom_event, weak_state))

        terminal = {**weak, "id": "terminal-auth"}
        terminal["evidence"] = "last_disconnect_reason=loggedOut auth_failure_class=pairing_required"
        terminal["criticalAsset"] = {
            **weak["criticalAsset"],
            "evidenceRefs": [],
        }
        terminal_state = symptom_state()
        terminal_normalized = self.mod.normalize_dispatch_observation(terminal)
        self.assertNotEqual(terminal_normalized.classification, "inferred_transient")
        self.assert_isolated()
        self.mod.mark_incident_sent(terminal, terminal_state, terminal_normalized)
        for key in symptom_keys:
            self.assertNotIn(key, terminal_state["openIncidents"])

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
            digest = self.mod.clear_event_identity_digest(event)
            if index < 54:
                state["acceptedClearNotifications"][digest]["notificationState"] = "delivered"
                for closed in state["closedHistory"]:
                    if closed.get("incidentKey") == key:
                        old = now - self.mod.PROCESSED_EVENT_MAX_AGE_SECONDS - index - 1
                        closed["receiptTime"] = old
                        closed["closedAt"] = old
            last_event = event
        self.assertEqual(len(state["acceptedClearNotifications"]), 50)
        assert last_event is not None
        observation = self.mod.normalize_dispatch_observation(last_event)
        self.assertIsNotNone(self.mod.pending_clear_notification_decision(last_event, state, observation))
        mutated = {**last_event, "source": "health_body_degraded"}
        mutated_observation = self.mod.normalize_dispatch_observation(mutated)
        self.assertIsNone(self.mod.pending_clear_notification_decision(mutated, state, mutated_observation))

    def test_retry_authorization_binds_notification_content_not_delivery_metadata(self) -> None:
        now = int(time.time())
        event = _clear_event(now)
        observation = self.mod.normalize_dispatch_observation(event)
        key = observation.incident_key
        record = _open_record(key, now - 300)
        decision = self.mod.evaluate_clear(record, observation, [])
        state: dict[str, Any] = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        self.mod.record_accepted_clear_notification(state, event, observation, [(key, decision)])

        delivery_retry = json.loads(json.dumps(event))
        delivery_retry["delivery"] = {
            "attempts": 7,
            "status": "queued",
            "lastError": "transport unavailable",
            "ageAtDeliverySeconds": 900,
            "revalidated": False,
        }
        self.assertIsNotNone(
            self.mod.pending_clear_notification_decision(
                delivery_retry,
                state,
                self.mod.normalize_dispatch_observation(delivery_retry),
            )
        )

        mutations = {
            "summary": "tampered recovery summary",
            "evidence": "tampered recovery evidence",
            "severity": "critical",
            "criticalAsset": {
                "asset": {"kind": "whatsapp_linked_device", "instance": "ana-bot"},
                "failure": {
                    "code": "WA_AUTH_BOND_SERVER_REVOKED",
                    "recoverability": "manual_relink_required",
                    "operatorAction": "perform a different action",
                },
            },
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                mutated = json.loads(json.dumps(event))
                mutated[field] = value
                self.assertIsNone(
                    self.mod.pending_clear_notification_decision(
                        mutated,
                        state,
                        self.mod.normalize_dispatch_observation(mutated),
                    )
                )

    def test_proof_identity_preserves_future_semantic_receipt_fields(self) -> None:
        now = int(time.time())
        event = _clear_event(now)
        base = {
            "status": "candidate",
            "incidentKey": "host-a|ana-bot|health_body_degraded",
            "incidentSource": "health_body_degraded",
            "policy": "health_snapshot",
            "schemaVersion": 1,
            "observedAtEpoch": now,
            "evidenceRefs": [
                {"kind": "evaluation_clock", "observedAtEpoch": now},
                {"kind": "health_snapshot", "incidentKey": "host-a|ana-bot|health_body_degraded"},
                "future-nondict-ref",
            ],
            "futureNested": {
                "clock": {"kind": "evaluation_clock", "observedAtEpoch": now},
                "semantic": {"value": "first"},
            },
        }
        first = self.mod.ClearDecision(
            self.mod.ClearStatus.CANDIDATE,
            "authoritative proof is not yet terminal",
            base,
        )
        clock_only_change = self.mod.ClearDecision(
            self.mod.ClearStatus.CANDIDATE,
            "authoritative proof is not yet terminal",
            {
                **base,
                "evidenceRefs": [
                    {"kind": "evaluation_clock", "observedAtEpoch": now + 99},
                    {"kind": "health_snapshot", "incidentKey": "host-a|ana-bot|health_body_degraded"},
                    "future-nondict-ref",
                ],
                "futureNested": {
                    **base["futureNested"],
                    "clock": {"kind": "evaluation_clock", "observedAtEpoch": now + 99},
                },
            },
        )
        semantic_change = self.mod.ClearDecision(
            self.mod.ClearStatus.CANDIDATE,
            "authoritative proof is not yet terminal",
            {
                **base,
                "futureNested": {
                    **base["futureNested"],
                    "semantic": {"value": "second"},
                },
            },
        )
        self.assertEqual(
            self.mod.clear_proof_identity(first, event),
            self.mod.clear_proof_identity(clock_only_change, event),
        )
        self.assertNotEqual(
            self.mod.clear_proof_identity(first, event),
            self.mod.clear_proof_identity(semantic_change, event),
        )

    def test_tampered_authorized_alert_retry_is_durably_suppressed(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        unit_key = "host-a|bot-errors-health|daily-health-fail:ana-bot"
        state = {
            "version": 1,
            "openIncidents": {
                unit_key: _open_record(
                    unit_key,
                    now - 300,
                    source="daily-health-fail:ana-bot",
                    policy="health_snapshot",
                ),
            },
            "lastSentAt": {},
        }
        event = _clear_event(now, source="daily-health", instance="ana-bot")
        event.update({
            "eventType": "alert",
            "severity": "warning",
            "alertSource": "attention-required",
            "summary": "BOT ERRORS daily health found issues",
            "evidence": "health ana-bot: 200 status=attention-required ok=false Result=success ExecMainStatus=0",
        })
        event_path = self._persist_state_and_event(paths, state, event, "tampered-retry.json")
        with patch.object(self.mod, "send_whatsapp", side_effect=RuntimeError("transport unavailable")):
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertFalse(ok)
        self.assertIn("transport unavailable", detail)
        authorized = self.mod.load_incident_state(paths)
        digest = self.mod.clear_event_identity_digest(event)
        self.assertIn(digest, authorized["acceptedClearNotifications"])
        authorization_before = json.loads(json.dumps(authorized["acceptedClearNotifications"][digest]))
        receipt_before = json.loads(json.dumps(authorized["processedEvents"][digest]))
        self.assertNotIn(unit_key, authorized["openIncidents"])

        queued = json.loads(event_path.read_text(encoding="utf-8"))
        queued["summary"] = "tampered same-id alert"
        event_path.write_text(json.dumps(queued), encoding="utf-8")
        with patch.object(self.mod, "send_whatsapp") as send:
            self.assert_isolated(paths)
            ok, detail = self.mod.process_one(event_path, paths)
        self.assertFalse(ok)
        self.assertEqual(detail, "protocol_quarantine:identity_collision")
        send.assert_not_called()
        persisted = self.mod.load_incident_state(paths)
        self.assertIn(digest, persisted["acceptedClearNotifications"])
        self.assertEqual(persisted["acceptedClearNotifications"][digest], authorization_before)
        self.assertEqual(persisted["processedEvents"][digest], receipt_before)
        self.assertNotIn("dailyHealthFreshness", persisted)
        self.assertFalse(event_path.exists())
        self.assertFalse(list(paths["suppressed"].iterdir()))
        self.assertEqual(len(list(paths["quarantine"].iterdir())), 1)
        self.assertEqual(len(persisted["processedEventCollisions"]), 1)
        self.assertEqual(persisted["processedEventCollisions"][0]["identityDigest"], digest)
        self.assertNotIn("tampered same-id alert", json.dumps(persisted["processedEventCollisions"]))
        dispatch_records = [
            json.loads(line)
            for line in (paths["logs"] / "dispatch.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        collision_audit = [
            record for record in dispatch_records
            if record.get("type") == "protocol_quarantine"
            and record.get("reason") == "identity_collision"
        ]
        self.assertEqual(len(collision_audit), 1)
        self.assertNotIn("tampered same-id alert", json.dumps(collision_audit))

    def test_retry_authorization_order_survives_sorted_save_reload_and_overflow(self) -> None:
        paths = self.mod.setup_dirs()
        now = int(time.time())
        state: dict[str, Any] = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        events: list[tuple[dict[str, Any], Any]] = []
        for index in range(49):
            event = _clear_event(now + index, instance=f"bot-{index}")
            observation = self.mod.normalize_dispatch_observation(event)
            decision = self.mod.evaluate_clear(
                _open_record(observation.incident_key, now - 300), observation, []
            )
            self.mod.record_accepted_clear_notification(
                state, event, observation, [(observation.incident_key, decision)]
            )
            if index < 5:
                digest = self.mod.clear_event_identity_digest(event)
                state["acceptedClearNotifications"][digest]["notificationState"] = "delivered"
            events.append((event, observation))
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        state = self.mod.load_incident_state(paths)
        for index in range(49, 55):
            event = _clear_event(now + index, instance=f"bot-{index}")
            observation = self.mod.normalize_dispatch_observation(event)
            decision = self.mod.evaluate_clear(
                _open_record(observation.incident_key, now - 300), observation, []
            )
            self.mod.record_accepted_clear_notification(
                state, event, observation, [(observation.incident_key, decision)]
            )
            events.append((event, observation))
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, state)
        reloaded = self.mod.load_incident_state(paths)
        self.assertEqual(len(reloaded["acceptedClearNotifications"]), 50)
        for event, _ in events[:5]:
            self.assertNotIn(self.mod.clear_event_identity_digest(event), reloaded["acceptedClearNotifications"])
        for event, _ in events[5:]:
            self.assertIn(self.mod.clear_event_identity_digest(event), reloaded["acceptedClearNotifications"])
        newest_event, newest_observation = events[-1]
        self.assertIsNotNone(
            self.mod.pending_clear_notification_decision(newest_event, reloaded, newest_observation)
        )

        malformed = {
            "version": 1,
            "openIncidents": {},
            "lastSentAt": {},
            "acceptedClearNotificationSequence": "bad",
            "acceptedClearNotifications": {
                f"{index:064x}": {"eventIdDigest": f"{index:064x}", "closures": [{}]}
                for index in range(60)
            },
        }
        self.assert_isolated(paths)
        self.mod.save_incident_state(paths, malformed)
        with self.assertRaises(self.mod.AcceptedClearNotificationCapacityError):
            self.mod.load_incident_state(paths)

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
        candidate_key = f"{machine}|bot-errors-health|daily-health-fail:{instance}"
        state = {
            "version": 1,
            "openIncidents": {
                accepted_key: _open_record(accepted_key, now - 300, source="health_body_degraded", policy="health_snapshot"),
                candidate_key: _open_record(candidate_key, now - 300, source=f"daily-health-fail:{instance}", policy="health_snapshot"),
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
