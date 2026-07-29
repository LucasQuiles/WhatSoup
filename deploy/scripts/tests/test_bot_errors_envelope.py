"""Contract tests for the BOT ERRORS queue event envelope."""

from __future__ import annotations

import ast
import importlib.util
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


def test_rejects_critical_clear_with_bounded_code() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="invalid_kind_severity"):
        envelope.normalize_event({"schemaVersion": 1, "eventType": "clear", "severity": "critical"})


def test_rejects_missing_schema_version_with_bounded_code() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="missing_schema_version"):
        envelope.classify_event({"eventType": "alert", "severity": "critical"})


def test_rejects_unsupported_schema_version_with_bounded_code() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="unsupported_schema_version"):
        envelope.classify_event({"schemaVersion": 3, "eventType": "alert", "severity": "critical"})


def test_new_fields_reject_new_informational_alert() -> None:
    envelope = load_envelope()
    with pytest.raises(envelope.EnvelopeError, match="invalid_kind_severity"):
        envelope.new_event_fields("alert", "info")


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
