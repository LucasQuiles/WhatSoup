"""Behavioral tests for the keychain-heal /health classifier (FLEET-MATRIX F1).

The load-bearing case is `healthy_but_stale_is_degraded`: a stale-green
(model_usable=True while model_usable_stale=True) must NOT be classified "ok",
or the self-heal monitor acts on out-of-date model usability — the exact
blind spot #1392 set out to close.
"""
import importlib.util
import pathlib

_MOD_PATH = pathlib.Path(__file__).resolve().parents[1] / "lib" / "classify_health.py"
_spec = importlib.util.spec_from_file_location("classify_health", _MOD_PATH)
classify_health = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(classify_health)
classify = classify_health.classify


def _tc(**over):
    base = {
        "model_usable": True,
        "model_usable_stale": False,
        "model_usable_checked_at": 1_782_349_406_162,
        "model_usability_status": "usable",
        "last_successful_turn_at": None,
        "last_turn_error_class": None,
        "last_turn_error_at": None,
    }
    base.update(over)
    return base


def test_healthy_fresh_usable_is_ok():
    assert classify({"status": "healthy", "turn_capability": _tc()}) == "ok"


def test_healthy_but_stale_is_degraded():
    # stale-green: usable True but the probe is stale -> must degrade, not "ok".
    body = {"status": "healthy", "turn_capability": _tc(model_usable=True, model_usable_stale=True)}
    assert classify(body) == "degraded"


def test_healthy_model_usable_null_is_degraded():
    body = {"status": "healthy", "turn_capability": _tc(model_usable=None, model_usable_stale=True)}
    assert classify(body) == "degraded"


def test_degraded_status_is_degraded():
    assert classify({"status": "degraded", "turn_capability": _tc()}) == "degraded"


def test_missing_turn_capability_is_fields():
    assert classify({"status": "healthy"}) == "fields"


def test_missing_model_usable_is_fields():
    assert classify({"status": "healthy", "turn_capability": {"model_usability_status": "usable"}}) == "fields"


def test_non_dict_is_parse():
    assert classify(["not", "a", "dict"]) == "parse"
