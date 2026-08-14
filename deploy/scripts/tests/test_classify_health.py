"""Behavioral tests for the keychain-heal /health classifier (FLEET-MATRIX F1).

The load-bearing case is `healthy_but_stale_is_degraded`: a stale-green
(model_usable=True while model_usable_stale=True) must NOT be classified "ok",
or the self-heal monitor acts on out-of-date model usability — the exact
blind spot #1392 set out to close.
"""
import importlib.util
import json
import pathlib

_MOD_PATH = pathlib.Path(__file__).resolve().parents[1] / "lib" / "classify_health.py"
_spec = importlib.util.spec_from_file_location("classify_health", _MOD_PATH)
classify_health = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(classify_health)
classify = classify_health.classify
recovery_debt_issue = classify_health.recovery_debt_issue


def test_recovery_debt_matches_versioned_contract_corpus():
    fixture_path = pathlib.Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "recovery-debt-contract-v1.json"
    corpus = json.loads(fixture_path.read_text(encoding="utf-8"))
    assert corpus["version"] == 1
    for case in corpus["cases"]:
        assert recovery_debt_issue({
            "status": case["status"],
            "recovery_debt": case["debt"],
        }) == case["expectedIssue"], case["name"]


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


def _debt(**over):
    base = {
        "open": True,
        "service_blocking": False,
        "attention": "routine",
        "reason": None,
        "reasons": ["historical_turn_catchup"],
        "continuity": {"readable": True, "open": 0, "unresolved": 0, "ambiguous": 0},
        "turn_recovery": {
            "readable": True,
            "blocking_outstanding": 0,
            "retained_terminal": 0,
            "open_catchups": 1,
            "corroborated_retained": 0,
        },
        "completed_delivery_identity": {
            "readable": True,
            "blocking": 0,
            "retained": 0,
            "next_action": None,
        },
        "delivery": {
            "readable": True,
            "blocking_ambiguous": 0,
            "uncorroborated_ambiguous": 0,
            "corroborated_retained": 0,
            "oldest_uncorroborated_at": None,
        },
    }
    base.update(over)
    return base


def test_healthy_fresh_usable_is_ok():
    assert classify({"status": "healthy", "turn_capability": _tc()}) == "ok"


def test_healthy_retained_recovery_debt_is_ok():
    assert classify({
        "status": "healthy",
        "turn_capability": _tc(),
        "recovery_debt": _debt(),
    }) == "ok"


def test_healthy_blocking_recovery_debt_is_rejected_as_fields():
    assert classify({
        "status": "healthy",
        "turn_capability": _tc(),
        "recovery_debt": _debt(
            service_blocking=True,
            attention="urgent",
            reasons=["turn_recovery_actionable"],
            turn_recovery={
                "readable": True,
                "blocking_outstanding": 1,
                "retained_terminal": 0,
                "open_catchups": 0,
                "corroborated_retained": 0,
            },
        ),
    }) == "fields"


def test_malformed_recovery_debt_is_rejected_as_fields():
    assert classify({
        "status": "healthy",
        "turn_capability": _tc(),
        "recovery_debt": {"open": "yes", "service_blocking": False, "attention": "routine"},
    }) == "fields"


def test_healthy_but_stale_is_degraded():
    # stale-green: usable True but the probe is stale -> must degrade, not "ok".
    body = {"status": "healthy", "turn_capability": _tc(model_usable=True, model_usable_stale=True)}
    assert classify(body) == "degraded"


def test_healthy_model_usable_null_is_degraded():
    body = {"status": "healthy", "turn_capability": _tc(model_usable=None, model_usable_stale=True)}
    assert classify(body) == "degraded"


def test_degraded_status_is_degraded():
    assert classify({"status": "degraded", "turn_capability": _tc()}) == "degraded"


def test_degraded_blocking_recovery_debt_is_coherent():
    assert classify({
        "status": "degraded",
        "turn_capability": _tc(),
        "recovery_debt": _debt(
            service_blocking=True,
            attention="urgent",
            reasons=["turn_recovery_actionable"],
            turn_recovery={
                "readable": True,
                "blocking_outstanding": 1,
                "retained_terminal": 0,
                "open_catchups": 0,
                "corroborated_retained": 0,
            },
        ),
    }) == "degraded"


def test_missing_turn_capability_is_fields():
    assert classify({"status": "healthy"}) == "fields"


def test_missing_model_usable_is_fields():
    assert classify({"status": "healthy", "turn_capability": {"model_usability_status": "usable"}}) == "fields"


def test_non_dict_is_parse():
    assert classify(["not", "a", "dict"]) == "parse"
