"""Contract tests for the BOT ERRORS legacy/v2 normalization boundary."""
from __future__ import annotations

import copy
from contextlib import contextmanager
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from bot_errors_protocol import (  # noqa: E402 - match dispatcher script import path.
    ClearPolicyKind,
    NormalizedObservation,
    ObservationState,
    QuarantineReason,
    normalize_observation,
)


ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "tests" / "fixtures" / "bot-errors-observation-v2.json"
DISPATCHER = SCRIPTS_DIR / "bot-errors-dispatcher.py"


@contextmanager
def loaded_dispatcher(state_dir: Path):
    old = os.environ.get("BOT_ERRORS_STATE_DIR")
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_protocol_test", DISPATCHER)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        yield module
    finally:
        if old is None:
            os.environ.pop("BOT_ERRORS_STATE_DIR", None)
        else:
            os.environ["BOT_ERRORS_STATE_DIR"] = old


def context(event: dict[str, object]) -> dict[str, object]:
    machine = str(event.get("machine") or "unknown")
    instance = str(event.get("instance") or "unknown")
    source = str(event.get("source") or "unknown")
    return {
        "incident_key": f"{machine}|{instance}|{source}",
        "incident_source": source,
        "is_logged_out_physical_signal": False,
        "is_verified_device_bond_lost_signal": False,
    }


def weak_auth_event() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "id": "weak-auth-3",
        "eventType": "alert",
        "severity": "warning",
        "createdAt": "2026-07-20T10:00:05.000Z",
        "machine": "fixture-host",
        "instance": "fixture-agent",
        "source": "instance_logged_out",
        "summary": "weak auth diagnostic",
        "evidence": (
            "connected=false disconnect_class=none reconnect_phase=backoff "
            "reconnect_attempts=0 weak_signal_polls=3"
        ),
        "criticalAsset": {
            "asset": {"kind": "whatsapp_linked_device", "instance": "fixture-agent"},
            "failure": {
                "code": "WA_AUTH_BOND_SERVER_REVOKED",
                "recoverability": "manual_relink_required",
                "confidence": "probable",
                "clearRequirement": "confirmed terminal auth evidence or reconnect recovery",
            },
            "evidenceRefs": [
                "connected=false",
                "state=connecting",
                "disconnect_class=none",
                "reconnect_phase=backoff",
                "reconnect_attempts=0",
                "weak_signal_polls=3",
            ],
        },
    }


class ProtocolAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_v1_alert_normalizes_to_fault_with_safe_minimum(self) -> None:
        event = {
            **self.fixture["legacy"]["alert"],
            "machine": "fixture-host",
        }

        result = normalize_observation(event, **context(event))

        self.assertIsInstance(result, NormalizedObservation)
        assert isinstance(result, NormalizedObservation)
        self.assertEqual(result.schema_version, 1)
        self.assertEqual(result.state, ObservationState.FAULT)
        self.assertEqual(result.incident_key, "fixture-host|fixture-agent|fixture-health")
        self.assertEqual(result.incident_source, "fixture-health")
        self.assertEqual(result.clear_policy.kind, ClearPolicyKind.SAME_SOURCE_NEWER)
        self.assertEqual(result.clear_policy.minimum_schema_version, 1)

    def test_v1_clear_targets_only_same_key_and_carries_freshness_guard(self) -> None:
        event = {
            **self.fixture["legacy"]["clear"],
            "machine": "fixture-host",
        }

        result = normalize_observation(event, **context(event))

        self.assertIsInstance(result, NormalizedObservation)
        assert isinstance(result, NormalizedObservation)
        self.assertEqual(result.state, ObservationState.HEALTHY)
        self.assertEqual(result.target_incident_key, "fixture-host|fixture-agent|fixture-health")
        self.assertTrue(result.requires_same_incident_key)
        self.assertTrue(result.requires_newer_observation)
        self.assertTrue(result.clear_is_fresh_for(result.incident_key, result.observed_at_epoch - 1, 60))
        self.assertFalse(result.clear_is_fresh_for("other|fixture-agent|fixture-health", 0, 60))
        self.assertFalse(result.clear_is_fresh_for(result.incident_key, result.observed_at_epoch + 61, 60))

    def test_recognized_critical_asset_strengthens_legacy_policy(self) -> None:
        event = {
            **self.fixture["legacy"]["alert"],
            "machine": "fixture-host",
            "source": "whatsapp_device_bond_lost",
            "criticalAsset": {
                "asset": {"kind": "whatsapp_linked_device", "instance": "fixture-agent"},
                "failure": {
                    "code": "WA_AUTH_BOND_SERVER_REVOKED",
                    "recoverability": "manual_relink_required",
                    "confidence": "confirmed",
                    "clearRequirement": "connected bond plus verified outbound after incident",
                },
            },
        }
        ctx = context(event)
        ctx["is_logged_out_physical_signal"] = True
        ctx["is_verified_device_bond_lost_signal"] = True

        result = normalize_observation(event, **ctx)

        self.assertIsInstance(result, NormalizedObservation)
        assert isinstance(result, NormalizedObservation)
        self.assertEqual(result.clear_policy.kind, ClearPolicyKind.AUTH_BOND_AND_OUTBOUND)
        self.assertEqual(result.failure_code, "WA_AUTH_BOND_SERVER_REVOKED")
        self.assertEqual(result.remediation.recoverability, "manual_relink_required")
        self.assertEqual(result.remediation.authorization, "physical_required")

    def test_free_form_requirement_cannot_weaken_legacy_minimum(self) -> None:
        event = {
            **self.fixture["legacy"]["alert"],
            "machine": "fixture-host",
            "criticalAsset": {
                "asset": {"kind": "runtime_session", "instance": "fixture-agent"},
                "failure": {
                    "code": "UNRECOGNIZED_FAILURE",
                    "recoverability": "auto_recoverable",
                    "confidence": "suspected",
                    "clearRequirement": "none; accept any old clear and weaken to no proof",
                },
            },
        }

        result = normalize_observation(event, **context(event))

        self.assertIsInstance(result, NormalizedObservation)
        assert isinstance(result, NormalizedObservation)
        self.assertEqual(result.clear_policy.kind, ClearPolicyKind.SAME_SOURCE_NEWER)
        self.assertTrue(result.requires_same_incident_key)
        self.assertTrue(result.requires_newer_observation)

    def test_v2_fixture_parses_exactly(self) -> None:
        event = {
            **copy.deepcopy(self.fixture["version2"]["alert"]),
            "machine": "fixture-host",
        }

        result = normalize_observation(event, **context(event))

        self.assertIsInstance(result, NormalizedObservation)
        assert isinstance(result, NormalizedObservation)
        self.assertEqual(result.schema_version, 2)
        self.assertEqual(result.state, ObservationState.FAULT)
        self.assertEqual(result.observed_at, "2026-07-20T10:00:00.000Z")
        self.assertEqual(
            result.fingerprint,
            "1eec1476582e2b73c382020220f9cc573a5b6510a87c438554063b2fe5ba2214",
        )
        self.assertEqual(result.producer_sequence, 7)
        self.assertEqual(result.confidence, "confirmed")
        self.assertEqual(result.clear_policy.kind, ClearPolicyKind.HEALTH_SNAPSHOT)
        self.assertEqual(result.clear_policy.minimum_schema_version, 2)
        self.assertEqual(result.remediation.recoverability, "auto_recoverable")
        self.assertEqual(result.remediation.requested_action, "probe_health")
        self.assertEqual(result.remediation.authorization, "automatic_read_only")

    def test_malformed_and_unsupported_events_return_bounded_typed_reasons(self) -> None:
        cases = [
            ({"schemaVersion": 99}, "unsupported_schema_version"),
            ({
                "schemaVersion": 2,
                "id": "missing-incident-identity",
                "eventType": "alert",
            }, "missing_incident_identity"),
            ({
                **self.fixture["version2"]["alert"],
                "machine": "fixture-host",
                "observation": {"state": "broken"},
            }, "invalid_v2_observation"),
        ]
        for event, expected_code in cases:
            with self.subTest(expected_code):
                result = normalize_observation(event, **context(event))
                self.assertIsInstance(result, QuarantineReason)
                assert isinstance(result, QuarantineReason)
                self.assertEqual(result.code.value, expected_code)
                self.assertLessEqual(len(result.receipt), 96)
                self.assertNotIn(str(event), result.receipt)

    def test_unhashable_malformed_fields_never_escape_the_boundary(self) -> None:
        valid_v2 = {
            **copy.deepcopy(self.fixture["version2"]["alert"]),
            "machine": "fixture-host",
        }
        cases = [
            ({"schemaVersion": []}, "unsupported_schema_version"),
            ({"schemaVersion": {}}, "unsupported_schema_version"),
            ({
                **self.fixture["legacy"]["alert"],
                "machine": "fixture-host",
                "eventType": [],
            }, "invalid_event_type"),
            ({
                **copy.deepcopy(valid_v2),
                "observation": {**valid_v2["observation"], "confidence": []},
            }, "invalid_v2_observation"),
            ({
                **copy.deepcopy(valid_v2),
                "remediation": {**valid_v2["remediation"], "recoverability": []},
            }, "invalid_v2_remediation"),
            ({
                **copy.deepcopy(valid_v2),
                "remediation": {**valid_v2["remediation"], "authorization": {}},
            }, "invalid_v2_remediation"),
        ]
        for event, expected_code in cases:
            with self.subTest(expected_code=expected_code, malformed=event):
                result = normalize_observation(event, **context(event))
                self.assertIsInstance(result, QuarantineReason)
                assert isinstance(result, QuarantineReason)
                self.assertEqual(result.code.value, expected_code)
                self.assertLessEqual(len(result.receipt), 96)

    def test_identity_fields_are_bounded_non_empty_strings(self) -> None:
        base = {
            **self.fixture["legacy"]["alert"],
            "machine": "fixture-host",
        }
        for field, value in [
            ("machine", []),
            ("instance", {}),
            ("source", ["fixture-health"]),
            ("machine", "x" * 257),
        ]:
            with self.subTest(field=field, value=value):
                event = {**base, field: value}
                result = normalize_observation(event, **context(event))
                self.assertIsInstance(result, QuarantineReason)
                assert isinstance(result, QuarantineReason)
                self.assertEqual(result.code.value, "missing_incident_identity")

    def test_v2_producer_sequence_uses_javascript_safe_integer_bounds(self) -> None:
        maximum = 9_007_199_254_740_991
        base = {
            **copy.deepcopy(self.fixture["version2"]["alert"]),
            "machine": "fixture-host",
        }
        accepted_event = {
            **copy.deepcopy(base),
            "observation": {**base["observation"], "producerSequence": maximum},
        }
        rejected_event = {
            **copy.deepcopy(base),
            "observation": {**base["observation"], "producerSequence": maximum + 1},
        }

        accepted = normalize_observation(accepted_event, **context(accepted_event))
        rejected = normalize_observation(rejected_event, **context(rejected_event))

        self.assertIsInstance(accepted, NormalizedObservation)
        assert isinstance(accepted, NormalizedObservation)
        self.assertEqual(accepted.producer_sequence, maximum)
        self.assertIsInstance(rejected, QuarantineReason)
        assert isinstance(rejected, QuarantineReason)
        self.assertEqual(rejected.code.value, "invalid_v2_observation")

    def test_weak_auth_observation_remains_inferred_transient(self) -> None:
        event = weak_auth_event()
        ctx = context(event)
        ctx["is_logged_out_physical_signal"] = True
        ctx["is_verified_device_bond_lost_signal"] = True

        result = normalize_observation(event, **ctx)

        self.assertIsInstance(result, NormalizedObservation)
        assert isinstance(result, NormalizedObservation)
        self.assertEqual(result.classification, "inferred_transient")
        self.assertEqual(result.failure_code, "WEAK_LOGGED_OUT_SIGNAL")
        self.assertNotEqual(result.failure_code, "WA_AUTH_BOND_SERVER_REVOKED")
        self.assertNotEqual(result.remediation.recoverability, "manual_relink_required")
        self.assertNotEqual(result.remediation.authorization, "physical_required")
        self.assertEqual(result.clear_policy.kind, ClearPolicyKind.SAME_SOURCE_NEWER)

    def test_v2_weak_auth_preserves_declared_stronger_clear_policy(self) -> None:
        event = {
            **copy.deepcopy(self.fixture["version2"]["alert"]),
            "machine": "fixture-host",
            "source": "instance_logged_out",
            "clearPolicy": {
                "kind": "auth_bond_and_outbound",
                "minimumSchemaVersion": 2,
            },
            "remediation": {
                "recoverability": "manual_relink_required",
                "requestedAction": "preserve_and_relink",
                "authorization": "physical_required",
            },
            "criticalAsset": weak_auth_event()["criticalAsset"],
        }
        ctx = context(event)
        ctx["is_logged_out_physical_signal"] = True
        ctx["is_verified_device_bond_lost_signal"] = True

        result = normalize_observation(event, **ctx)

        self.assertIsInstance(result, NormalizedObservation)
        assert isinstance(result, NormalizedObservation)
        self.assertEqual(result.classification, "inferred_transient")
        self.assertEqual(result.failure_code, "WEAK_LOGGED_OUT_SIGNAL")
        self.assertEqual(result.remediation.recoverability, "auto_recoverable")
        self.assertEqual(result.remediation.authorization, "automatic_read_only")
        self.assertEqual(result.clear_policy.kind, ClearPolicyKind.AUTH_BOND_AND_OUTBOUND)


class DispatcherIntegrationTests(unittest.TestCase):
    def test_dispatcher_uses_live_classifiers_but_weak_refs_win(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                event = weak_auth_event()
                self.assertTrue(dispatcher.is_logged_out_physical_signal(event))
                self.assertTrue(dispatcher.is_verified_device_bond_lost_signal(event))

                result = dispatcher.normalize_dispatch_observation(event)

                self.assertEqual(type(result).__name__, "NormalizedObservation")
                self.assertEqual(result.classification, "inferred_transient")
                self.assertNotEqual(result.failure_code, "WA_AUTH_BOND_SERVER_REVOKED")
                self.assertNotEqual(result.remediation.recoverability, "manual_relink_required")
                self.assertNotEqual(result.remediation.authorization, "physical_required")

    def test_invalid_event_quarantines_before_state_flap_or_notification_mutation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                paths = dispatcher.setup_dirs()
                sensitive_value = "synthetic-secret-value-123456789"
                invalid = {
                    "schemaVersion": 99,
                    "id": f"token={sensitive_value}",
                    "eventType": "alert",
                    "severity": "critical",
                    "createdAt": "2026-07-20T10:00:05.000Z",
                    "machine": "fixture-host",
                    "instance": "fixture-agent",
                    "source": "fixture-health",
                    "summary": "unsupported event",
                }
                event_path = paths["outbox"] / "unsupported.json"
                event_path.write_text(json.dumps(invalid), encoding="utf-8")
                self.assertEqual(json.loads(event_path.read_text(encoding="utf-8"))["schemaVersion"], 99)

                with (
                    patch.object(dispatcher, "load_incident_state") as load_state,
                    patch.object(dispatcher, "record_flap_trip") as record_flap,
                    patch.object(dispatcher, "send_whatsapp") as send_whatsapp,
                ):
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(paths["root"].resolve(), state_dir.resolve())
                    ok, detail = dispatcher.process_one(event_path, paths)

                self.assertFalse(ok)
                self.assertEqual(detail, "protocol_quarantine:unsupported_schema_version")
                load_state.assert_not_called()
                record_flap.assert_not_called()
                send_whatsapp.assert_not_called()
                self.assertFalse(event_path.exists())
                quarantined = list(paths["quarantine"].glob("*"))
                self.assertEqual(len(quarantined), 1)
                self.assertEqual(quarantined[0].stat().st_mode & 0o777, 0o600)
                log_path = paths["logs"] / "dispatch.jsonl"
                self.assertEqual(log_path.stat().st_mode & 0o777, 0o600)
                raw_receipts = log_path.read_text()
                self.assertNotIn(sensitive_value, raw_receipts)
                receipts = [json.loads(line) for line in raw_receipts.splitlines()]
                receipt = receipts[-1]
                self.assertEqual(receipt["type"], "protocol_quarantine")
                self.assertEqual(receipt["reason"], "unsupported_schema_version")
                self.assertLessEqual(len(receipt["eventId"]), 128)
                self.assertLessEqual(len(receipt["receipt"]), 96)
                self.assertLessEqual(len(json.dumps(receipt, sort_keys=True)), 1024)

    def test_valid_json_array_quarantines_before_identity_or_mutation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                paths = dispatcher.setup_dirs()
                event_path = paths["outbox"] / "array.json"
                event_path.write_text("[]", encoding="utf-8")
                self.assertEqual(json.loads(event_path.read_text(encoding="utf-8")), [])

                with (
                    patch.object(dispatcher, "load_incident_state") as load_state,
                    patch.object(dispatcher, "record_flap_trip") as record_flap,
                    patch.object(dispatcher, "send_whatsapp") as send_whatsapp,
                ):
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(paths["root"].resolve(), state_dir.resolve())
                    ok, detail = dispatcher.process_one(event_path, paths)

                self.assertFalse(ok)
                self.assertEqual(detail, "protocol_quarantine:event_not_object")
                load_state.assert_not_called()
                record_flap.assert_not_called()
                send_whatsapp.assert_not_called()
                self.assertEqual(len(list(paths["quarantine"].glob("*protocol_quarantine"))), 1)

    def test_protocol_quarantine_chmod_failure_is_inconclusive_not_success(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                paths = dispatcher.setup_dirs()
                event_path = paths["outbox"] / "unsupported.json"
                event_path.write_text(json.dumps({
                    "schemaVersion": 99,
                    "id": "chmod-fault",
                    "eventType": "alert",
                    "createdAt": "2026-07-20T10:00:05.000Z",
                    "machine": "fixture-host",
                    "instance": "fixture-agent",
                    "source": "fixture-health",
                }), encoding="utf-8")
                self.assertEqual(json.loads(event_path.read_text())["schemaVersion"], 99)
                real_chmod = Path.chmod
                injected_faults: list[Path] = []

                def fail_quarantine_chmod(target: Path, mode: int, *args, **kwargs) -> None:
                    if target.parent == paths["quarantine"] and mode == 0o600:
                        injected_faults.append(target)
                        raise OSError("injected protocol quarantine chmod failure")
                    real_chmod(target, mode, *args, **kwargs)

                with (
                    patch.object(Path, "chmod", fail_quarantine_chmod),
                    patch.object(dispatcher, "send_whatsapp") as send_whatsapp,
                ):
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(paths["root"].resolve(), state_dir.resolve())
                    ok, detail = dispatcher.process_one(event_path, paths)

                self.assertEqual(len(injected_faults), 1, "intended chmod fault did not occur exactly once")
                self.assertFalse(ok)
                self.assertEqual(
                    detail,
                    "protocol_quarantine_inconclusive:permission_hardening_failed",
                )
                send_whatsapp.assert_not_called()
                receipts = [
                    json.loads(line)
                    for line in (paths["logs"] / "dispatch.jsonl").read_text().splitlines()
                ]
                self.assertEqual(receipts[-1]["type"], "protocol_quarantine_inconclusive")
                self.assertEqual(receipts[-1]["reason"], "permission_hardening_failed")
                self.assertFalse(any(row["type"] == "protocol_quarantine" for row in receipts))
                self.assertLessEqual(len(json.dumps(receipts[-1], sort_keys=True)), 1024)

    def test_protocol_prepass_quarantines_valid_json_scalar_without_notification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                paths = dispatcher.setup_dirs()
                event_path = paths["outbox"] / "scalar.json"
                event_path.write_text("42", encoding="utf-8")
                self.assertEqual(json.loads(event_path.read_text(encoding="utf-8")), 42)

                with patch.object(dispatcher, "send_whatsapp") as send_whatsapp:
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(paths["root"].resolve(), state_dir.resolve())
                    quarantined = dispatcher.quarantine_invalid_protocol_events(paths)

                self.assertEqual(quarantined, 1)
                send_whatsapp.assert_not_called()
                self.assertFalse(event_path.exists())
                self.assertEqual(len(list(paths["quarantine"].glob("*protocol_quarantine"))), 1)

    def test_post_prepass_nonobject_race_preserves_protocol_and_poison_routes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                paths = dispatcher.setup_dirs()
                original_prepass = dispatcher.quarantine_invalid_protocol_events
                injected = 0

                def prepass_then_inject(active_paths) -> int:
                    nonlocal injected
                    quarantined = original_prepass(active_paths)
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(active_paths["root"].resolve(), state_dir.resolve())
                    (active_paths["outbox"] / "late-list.json").write_text("[]", encoding="utf-8")
                    (active_paths["outbox"] / "late-invalid-alert.json").write_text(
                        json.dumps({
                            "schemaVersion": 99,
                            "id": "late-invalid-alert",
                            "eventType": "alert",
                            "severity": "critical",
                            "createdAt": "2026-07-20T10:00:05.000Z",
                            "machine": "fixture-host",
                            "instance": "fixture-agent",
                            "source": "fixture-health",
                        }),
                        encoding="utf-8",
                    )
                    (active_paths["outbox"] / "late-unreadable.json").write_text(
                        "{not-json", encoding="utf-8"
                    )
                    self.assertEqual(
                        json.loads((active_paths["outbox"] / "late-list.json").read_text()),
                        [],
                    )
                    self.assertEqual(
                        json.loads(
                            (active_paths["outbox"] / "late-invalid-alert.json").read_text()
                        )["schemaVersion"],
                        99,
                    )
                    injected += 1
                    return quarantined

                with (
                    patch.object(
                        dispatcher,
                        "quarantine_invalid_protocol_events",
                        side_effect=prepass_then_inject,
                    ),
                    patch.object(dispatcher, "record_flap_trip") as record_flap,
                    patch.object(dispatcher, "send_whatsapp") as send_whatsapp,
                ):
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(paths["root"].resolve(), state_dir.resolve())
                    dispatcher.run_once(max_events=25)

                self.assertEqual(injected, 1, "post-prepass race injection did not occur exactly once")
                record_flap.assert_not_called()
                send_whatsapp.assert_called_once()
                protocol_files = list(paths["quarantine"].glob("*protocol_quarantine"))
                poison_files = list(paths["quarantine"].glob("*.poison"))
                self.assertEqual(len(protocol_files), 2)
                self.assertEqual(
                    {"late-list.json", "late-invalid-alert.json"},
                    {
                        name
                        for name in ("late-list.json", "late-invalid-alert.json")
                        if any(name in path.name for path in protocol_files)
                    },
                )
                self.assertEqual(len(poison_files), 1)
                self.assertIn("late-unreadable.json", poison_files[0].name)
                receipts = [
                    json.loads(line)
                    for line in (paths["logs"] / "dispatch.jsonl").read_text().splitlines()
                ]
                protocol_receipts = [row for row in receipts if row["type"] == "protocol_quarantine"]
                poison_receipts = [row for row in receipts if row["type"] == "quarantine"]
                self.assertEqual(
                    sorted(row["reason"] for row in protocol_receipts),
                    ["event_not_object", "unsupported_schema_version"],
                )
                self.assertEqual(len(poison_receipts), 1)
                self.assertEqual(poison_receipts[0]["directWhatsapp"], "sent")
                if paths["incident_state"].exists():
                    incident_state = json.loads(paths["incident_state"].read_text())
                    self.assertEqual(incident_state.get("openIncidents", {}), {})
                    self.assertEqual(incident_state.get("flapState", {}), {})

    def test_protocol_prepass_leaves_unreadable_json_for_existing_poison_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                paths = dispatcher.setup_dirs()
                event_path = paths["outbox"] / "invalid.json"
                event_path.write_text("{not-json", encoding="utf-8")

                with patch.object(dispatcher, "quarantine_poison") as quarantine_poison:
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(paths["root"].resolve(), state_dir.resolve())
                    quarantined = dispatcher.quarantine_invalid_protocol_events(paths)

                self.assertEqual(quarantined, 0)
                quarantine_poison.assert_not_called()
                self.assertTrue(event_path.exists())

    def test_ready_preserves_unreadable_json_poison_notification_behavior(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bot-errors-protocol-") as raw:
            state_dir = Path(raw)
            with loaded_dispatcher(state_dir) as dispatcher:
                paths = dispatcher.setup_dirs()
                event_path = paths["outbox"] / "invalid.json"
                event_path.write_text("{not-json", encoding="utf-8")

                with patch.object(dispatcher, "send_whatsapp") as send_whatsapp:
                    self.assertEqual(dispatcher.state_root().resolve(), state_dir.resolve())
                    self.assertEqual(paths["root"].resolve(), state_dir.resolve())
                    ready = dispatcher.ready(event_path, paths)

                self.assertFalse(ready)
                send_whatsapp.assert_called_once()
                self.assertFalse(event_path.exists())
                poisoned = list(paths["quarantine"].glob("*.poison"))
                self.assertEqual(len(poisoned), 1)
                receipts = [
                    json.loads(line)
                    for line in (paths["logs"] / "dispatch.jsonl").read_text().splitlines()
                ]
                self.assertEqual(receipts[-1]["type"], "quarantine")
                self.assertEqual(receipts[-1]["directWhatsapp"], "sent")


if __name__ == "__main__":
    unittest.main()
