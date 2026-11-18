"""Behavioral tests for the keychain-heal /health classifier (FLEET-MATRIX F1).

The load-bearing case is `healthy_but_stale_is_degraded`: a stale-green
(model_usable=True while model_usable_stale=True) must NOT be classified "ok",
or the self-heal monitor acts on out-of-date model usability — the exact
blind spot #1392 set out to close.
"""
import importlib.util
import json
import pathlib
import pytest
from hypothesis import given, settings, strategies as st

# Finite field and value domains: Hypothesis exhausts them, so every case runs.
_exhaustive = settings(derandomize=True, database=None, deadline=None)

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


def _compact_debt():
    return {
        "open": True,
        "reason": "continuity_gap_open",
        "continuity": {"readable": True, "open": 2, "unresolved": 1, "ambiguous": 1},
    }


@pytest.mark.parametrize("count", [0, 2])
def test_healthy_compact_continuity_is_accepted_without_clearing_debt(count):
    debt = _compact_debt()
    debt.update(open=count > 0, reason="continuity_gap_open" if count else None)
    debt["continuity"].update(open=count, unresolved=count, ambiguous=0)
    body = {"status": "healthy", "turn_capability": _tc(), "recovery_debt": debt}
    before = json.dumps(body, sort_keys=True)
    assert recovery_debt_issue(body) is None
    assert classify(body) == "ok"
    assert json.dumps(body, sort_keys=True) == before


@pytest.mark.parametrize("status,expected", [
    ("healthy", "recovery_debt_status_contradiction"), ("degraded", None),
])
def test_compact_unreadable_continuity_cannot_support_healthy_status(status, expected):
    debt = _compact_debt()
    debt["continuity"]["readable"] = False
    debt["reason"] = "continuity_gap_unreadable"
    body = {"status": status, "turn_capability": _tc(), "recovery_debt": debt}
    assert recovery_debt_issue(body) == expected
    assert classify(body) == ("fields" if status == "healthy" else "non_model")


@pytest.mark.parametrize("value", [None, True, -1, 1.5, "1", 9_007_199_254_740_992, float("inf"), float("nan")])
@_exhaustive
@given(field=st.sampled_from(("open", "unresolved", "ambiguous")))
def test_compact_counts_require_safe_nonnegative_integers(value, field):
    debt = _compact_debt()
    debt["continuity"][field] = value
    assert recovery_debt_issue({"status": "healthy", "recovery_debt": debt}) == "recovery_debt_invalid"


def test_compact_integer_valued_json_numbers_match_javascript_contract():
    debt = json.loads('{"open":true,"reason":"continuity_gap_open",'
                      '"continuity":{"readable":true,"open":2.0,"unresolved":1e0,"ambiguous":1.0}}')
    assert recovery_debt_issue({"status": "healthy", "recovery_debt": debt}) is None


@pytest.mark.parametrize("field,value", [
    ("open", False), ("open", 1), ("reason", None), ("reason", "continuity_gap_unreadable"),
    ("continuity", None), ("continuity", {}),
])
def test_compact_contradictions_and_missing_evidence_are_rejected(field, value):
    debt = _compact_debt()
    debt[field] = value
    assert recovery_debt_issue({"status": "healthy", "recovery_debt": debt}) == "recovery_debt_invalid"


@_exhaustive
@given(field=st.sampled_from(("open", "reason", "continuity")))
def test_compact_required_fields_cannot_be_omitted(field):
    debt = _compact_debt()
    del debt[field]
    assert recovery_debt_issue({"status": "healthy", "recovery_debt": debt}) == "recovery_debt_invalid"


@_exhaustive
@given(value=st.sampled_from((None, 1, "true")))
def test_compact_readability_requires_a_boolean(value):
    debt = _compact_debt()
    debt["continuity"]["readable"] = value
    assert recovery_debt_issue({"status": "healthy", "recovery_debt": debt}) == "recovery_debt_invalid"


@_exhaustive
@given(field=st.sampled_from((
    "service_blocking", "attention", "reasons", "turn_recovery", "completed_delivery_identity", "delivery",
)))
def test_partial_extended_debt_cannot_use_compact_compatibility(field):
    debt = _compact_debt()
    debt[field] = None
    assert recovery_debt_issue({"status": "healthy", "recovery_debt": debt}) == "recovery_debt_invalid"


# The producer defines continuity open as unresolved + ambiguous
# (src/core/continuity-gap-ledger.ts), so counts that disagree are a
# contradiction in either direction. Without the check the first compact case
# reads as zero debt.
@pytest.mark.parametrize("debt_open,reason,counts", [
    (False, None, (0, 1, 0)),
    (True, "continuity_gap_open", (3, 1, 1)),
])
def test_compact_continuity_open_must_be_unresolved_plus_ambiguous(debt_open, reason, counts):
    debt = _compact_debt()
    debt.update(open=debt_open, reason=reason)
    debt["continuity"].update(zip(("open", "unresolved", "ambiguous"), counts))
    body = {"status": "healthy", "turn_capability": _tc(), "recovery_debt": debt}
    assert recovery_debt_issue(body) == "recovery_debt_invalid"
    assert classify(body) == "fields"


@pytest.mark.parametrize("over", [
    {"continuity": {"readable": True, "open": 0, "unresolved": 1, "ambiguous": 0}},
    {
        "reason": "continuity_gap_open",
        "reasons": ["continuity_gap_open", "historical_turn_catchup"],
        "continuity": {"readable": True, "open": 3, "unresolved": 1, "ambiguous": 1},
    },
])
def test_extended_continuity_open_must_be_unresolved_plus_ambiguous(over):
    body = {"status": "healthy", "turn_capability": _tc(), "recovery_debt": _debt(**over)}
    assert recovery_debt_issue(body) == "recovery_debt_invalid"
    assert classify(body) == "fields"


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


@pytest.mark.parametrize("status", ["degraded", "unhealthy"])
def test_non_model_degradation_is_not_a_keychain_heal_case(status):
    assert classify({"status": status, "turn_capability": _tc()}) == "non_model"


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
    # Coherent blocking debt is valid evidence, so classification falls
    # through to the model verdict: a usable model makes it non-model.
    }) == "non_model"


def test_missing_turn_capability_is_fields():
    assert classify({"status": "healthy"}) == "fields"


def test_missing_model_usable_is_fields():
    assert classify({"status": "healthy", "turn_capability": {"model_usability_status": "usable"}}) == "fields"


def test_non_dict_is_parse():
    assert classify(["not", "a", "dict"]) == "parse"


@pytest.mark.parametrize("status", ["", "maintenance", None, 42, False, {}, []])
@pytest.mark.parametrize("usable", [True, False])
def test_unknown_status_is_fields_not_recovery(status, usable):
    assert classify({
        "status": status,
        "turn_capability": _tc(model_usable=usable),
    }) == "fields"


@pytest.mark.parametrize("status", ["healthy", "degraded"])
@pytest.mark.parametrize("usable", [True, False])
@pytest.mark.parametrize("stale", [None, "false", 0, 1, {}, []])
def test_invalid_freshness_is_fields_not_recovery(status, usable, stale):
    assert classify({
        "status": status,
        "turn_capability": _tc(model_usable=usable, model_usable_stale=stale),
    }) == "fields"


@pytest.mark.parametrize("status", ["healthy", "degraded"])
@pytest.mark.parametrize("usable", [True, False])
def test_missing_freshness_is_fields_not_recovery(status, usable):
    tc = _tc(model_usable=usable)
    del tc["model_usable_stale"]
    assert classify({"status": status, "turn_capability": tc}) == "fields"
