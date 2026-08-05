"""Tests for #2507: incident_key uses SHA source digest to prevent collisisions between distinct sources."""
from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_test", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load()


def test_old_safe_segment_collision():
    """safe_segment('abc@def') and safe_segment('abc+def') and safe_segment('abc_def')
    all map to 'abc_def' — confirming the lossy collision exists."""
    assert _mod.safe_segment("abc@def") == _mod.safe_segment("abc+def") == _mod.safe_segment("abc_def")
    assert _mod.safe_segment("a@b") == _mod.safe_segment("a b") == _mod.safe_segment("a_b")


def test_incident_key_distinct_after_hash():
    """New incident_key: sources differing by @, +, _ produce DIFFERENT keys."""
    evt1 = {"machine": "host-a", "instance": "bot-1", "source": "abc@def", "eventType": "alert", "severity": "critical"}
    evt2 = {"machine": "host-a", "instance": "bot-1", "source": "abc+def", "eventType": "alert", "severity": "critical"}
    evt3 = {"machine": "host-a", "instance": "bot-1", "source": "abc_def", "eventType": "alert", "severity": "critical"}
    keys = {_mod.incident_key(evt1), _mod.incident_key(evt2), _mod.incident_key(evt3)}
    assert len(keys) == 3, f"three distinct sources must produce three distinct keys, got {len(keys)}"


def test_incident_key_idempotent():
    """Equal events (independent dict instances) produce the same stable key."""
    evt = {"machine": "host-a", "instance": "bot-1", "source": "collector:writefail", "eventType": "alert", "severity": "critical"}
    first = _mod.incident_key(evt)
    again = _mod.incident_key(dict(evt))
    assert first == again, "key derivation must be deterministic across equal events"
    assert "host-a" in first and "bot-1" in first, f"key must embed machine+instance segments, got {first!r}"


def test_incident_key_different_machines():
    """Different machines with same source produce different keys (no regression)."""
    evt1 = {"machine": "host-a", "instance": "bot-1", "source": "collector:writefail", "eventType": "alert", "severity": "critical"}
    evt2 = {"machine": "host-b", "instance": "bot-1", "source": "collector:writefail", "eventType": "alert", "severity": "critical"}
    assert _mod.incident_key(evt1) != _mod.incident_key(evt2)
