"""Contract tests for the BOT ERRORS queue event envelope."""

from __future__ import annotations

import ast
import importlib.util
from itertools import product
from pathlib import Path
import sys

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))


def load_envelope():
    module_path = _SCRIPT_ROOT / "lib" / "bot_errors_envelope.py"
    assert module_path.is_file(), "BOT ERRORS envelope module must exist"
    spec = importlib.util.spec_from_file_location("bot_errors_envelope", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_normalizes_v1_info_alert_to_observation() -> None:
    envelope = load_envelope()
    normalized = envelope.normalize_event({"schemaVersion": 1, "eventType": "alert", "severity": "info"})

    assert normalized == {
        "schemaVersion": 2,
        "eventKind": "observation",
        "eventType": "observation",
        "severity": "info",
    }


def test_normalizes_v1_error_alert_to_incident_alert() -> None:
    envelope = load_envelope()
    normalized = envelope.normalize_event({"schemaVersion": 1, "eventType": "alert", "severity": "error"})

    assert normalized == {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "error",
    }


def test_classifies_schema_v2_recovery() -> None:
    envelope = load_envelope()
    classification = envelope.classify_event(
        {
            "schemaVersion": 2,
            "eventKind": "incident_recovery",
            "eventType": "clear",
            "severity": "info",
        }
    )

    assert classification.kind == "incident_recovery"
    assert classification.event_type == "clear"
    assert classification.severity == "info"
    assert classification.legacy is False


def test_v2_classification_declares_every_kind_type_severity_combination() -> None:
    envelope = load_envelope()
    valid = {
        ("incident_alert", "alert", "critical"),
        ("incident_alert", "alert", "error"),
        ("incident_alert", "alert", "warning"),
        ("incident_recovery", "clear", "info"),
        ("observation", "observation", "info"),
    }

    for kind, event_type, severity in product(envelope.EVENT_KINDS, envelope.EVENT_TYPES, envelope.SEVERITIES):
        payload = {
            "schemaVersion": 2,
            "eventKind": kind,
            "eventType": event_type,
            "severity": severity,
        }
        if (kind, event_type, severity) in valid:
            assert envelope.classify_event(payload).kind == kind
        else:
            with pytest.raises(envelope.EnvelopeError, match="invalid_kind_severity"):
                envelope.classify_event(payload)


def test_v1_compatibility_declares_valid_legacy_pairs_and_v2_only_observation() -> None:
    envelope = load_envelope()
    valid = {
        ("alert", "critical"): "incident_alert",
        ("alert", "error"): "incident_alert",
        ("alert", "warning"): "incident_alert",
        ("alert", "info"): "observation",
        ("clear", "info"): "incident_recovery",
    }

    for event_type, severity in product(("alert", "clear", "observation"), envelope.SEVERITIES):
        payload = {"schemaVersion": 1, "eventType": event_type, "severity": severity}
        expected_kind = valid.get((event_type, severity))
        if expected_kind is not None:
            assert envelope.classify_event(payload).kind == expected_kind
        else:
            expected_code = "unknown_event_type" if event_type == "observation" else "invalid_kind_severity"
            with pytest.raises(envelope.EnvelopeError, match=expected_code):
                envelope.classify_event(payload)


def test_new_fields_declares_complete_v2_kind_severity_matrix() -> None:
    envelope = load_envelope()
    valid = {
        ("alert", "critical"): ("incident_alert", "alert", "critical"),
        ("alert", "error"): ("incident_alert", "alert", "error"),
        ("alert", "warning"): ("incident_alert", "alert", "warning"),
        ("clear", "info"): ("incident_recovery", "clear", "info"),
        ("observation", "info"): ("observation", "observation", "info"),
    }

    for (event_type, severity), expected in valid.items():
        assert envelope.new_event_fields(event_type, severity) == {
            "schemaVersion": 2,
            "eventKind": expected[0],
            "eventType": expected[1],
            "severity": expected[2],
        }

    for event_type, severity in product(envelope.EVENT_TYPES, envelope.SEVERITIES):
        if (event_type, severity) in valid:
            continue
        with pytest.raises(envelope.EnvelopeError, match="invalid_kind_severity"):
            envelope.new_event_fields(event_type, severity)


def test_rejects_missing_schema_version_with_bounded_code() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="missing_schema_version"):
        envelope.classify_event({"eventType": "alert", "severity": "critical"})


def test_rejects_unsupported_schema_version_with_bounded_code() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="unsupported_schema_version"):
        envelope.classify_event({"schemaVersion": 3, "eventType": "alert", "severity": "critical"})


@pytest.mark.parametrize(
    ("payload", "code"),
    (
        ({"schemaVersion": 2, "eventType": "alert", "severity": "critical"}, "missing_event_kind"),
        ({"schemaVersion": 2, "eventKind": "incident_alert", "severity": "critical"}, "missing_event_type"),
        ({"schemaVersion": 2, "eventKind": "incident_alert", "eventType": "alert"}, "missing_severity"),
        ({"schemaVersion": 2, "eventKind": "unknown", "eventType": "alert", "severity": "critical"}, "unknown_event_kind"),
        ({"schemaVersion": 2, "eventKind": "incident_alert", "eventType": "unknown", "severity": "critical"}, "unknown_event_type"),
        ({"schemaVersion": 2, "eventKind": "incident_alert", "eventType": "alert", "severity": "unknown"}, "unknown_severity"),
    ),
)
def test_v2_rejects_missing_or_unknown_core_tags(payload: dict[str, object], code: str) -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match=code):
        envelope.classify_event(payload)


def test_v1_rejects_v2_kind_tag_before_it_can_be_misclassified_as_recovery() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="unexpected_legacy_event_kind"):
        envelope.normalize_event(
            {
                "schemaVersion": 1,
                "eventKind": "incident_alert",
                "eventType": "clear",
                "severity": "info",
            }
        )


def test_v1_rejects_v2_only_observation_type() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="unknown_event_type"):
        envelope.normalize_event({"schemaVersion": 1, "eventType": "observation", "severity": "info"})


def test_new_fields_emit_v2_observation() -> None:
    envelope = load_envelope()
    assert envelope.new_event_fields("observation", "info") == {
        "schemaVersion": 2,
        "eventKind": "observation",
        "eventType": "observation",
        "severity": "info",
    }


def test_direct_queue_event_constructors_do_not_inline_v1_envelopes() -> None:
    producer_names = (
        "bot-errors-emit.py",
        "bot-errors-collector.py",
        "bot-errors-dispatcher.py",
        "bot-errors-health-check.py",
        "bot-errors-heartbeat-watchdog.py",
        "bot-errors-runner.py",
        "bot-errors-tree-provenance.py",
    )
    stale_literals: list[str] = []
    missing_builder_calls: list[str] = []

    for name in producer_names:
        path = _SCRIPT_ROOT / name
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        builder_calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "new_event_fields"
        ]
        if not builder_calls:
            missing_builder_calls.append(name)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Dict):
                continue
            pairs = {
                key.value: value
                for key, value in zip(node.keys, node.values, strict=True)
                if isinstance(key, ast.Constant) and isinstance(key.value, str)
            }
            schema_version = pairs.get("schemaVersion")
            if (
                "eventType" in pairs
                and isinstance(schema_version, ast.Constant)
                and schema_version.value == 1
            ):
                stale_literals.append(f"{name}:{node.lineno}")

    assert missing_builder_calls == []
    assert stale_literals == []
