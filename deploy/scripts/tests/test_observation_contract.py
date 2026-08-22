"""task-obs-03: the Python observation-contract reader.

Loads the governed ``deploy/observation-plane/`` data set fail-closed and
exposes deterministic lookups plus ONE canonical contract digest
(req-obs-02/req-obs-09). Malformed data is invalid evidence: there is no
fallback parser and no silent default — an unknown surface or an
out-of-domain legacy value raises instead of projecting.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import MappingProxyType

import pytest

_LIB = Path(__file__).resolve().parents[1] / "lib" / "observation_contract.py"
_CONTRACT_DIR = Path(__file__).resolve().parents[3] / "deploy" / "observation-plane"


def _load_module():
    spec = importlib.util.spec_from_file_location("observation_contract", _LIB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _committed_docs() -> dict:
    docs = {}
    for name in _mod.CONTRACT_FILE_NAMES:
        docs[name] = json.loads((_CONTRACT_DIR / name).read_text(encoding="utf-8"))
    return docs


def test_load_contract_reads_the_committed_contract_set() -> None:
    contract = _mod.load_contract()
    assert set(contract["docs"]) == set(_mod.CONTRACT_FILE_NAMES)
    assert isinstance(contract["digest"], str)
    assert len(contract["digest"]) == 64
    assert int(contract["digest"], 16) >= 0
    assert "pass" in contract["canonical_outcomes"]
    # The merged contract closes 8 legacy surfaces (#3333); the reader must
    # surface every one of them.
    assert len(contract["surfaces"]) >= 8
    assert "identity.instance_name" in contract["claims"]
    assert "auth-health" in contract["adapters"]
    assert "functional_turn" in contract["authority_tiers"]


def test_contract_digest_matches_python_canonical_json() -> None:
    # The digest definition is pinned here so the TS lockstep test proves the
    # same bytes: sha256 over json.dumps(identity, sort_keys, compact).
    docs = _committed_docs()
    identity = _mod.contract_identity(docs)
    expected = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert _mod.contract_digest(docs) == expected
    assert _mod.load_contract()["digest"] == expected


def test_contract_digest_is_content_sensitive() -> None:
    docs = _committed_docs()
    baseline = _mod.contract_digest(docs)
    mutated = copy.deepcopy(docs)
    surface = next(iter(mutated["outcome-projections.json"]["surfaces"].values()))
    surface["rows"][0]["lossy"] = not surface["rows"][0]["lossy"]
    assert _mod.contract_digest(mutated) != baseline


def test_projection_rows_cover_every_declared_domain_member() -> None:
    contract = _mod.load_contract()
    outcomes = set(contract["canonical_outcomes"])
    for surface_name, surface in contract["surfaces"].items():
        assert surface["domain"], surface_name
        for member in surface["domain"]:
            row = _mod.project_outcome(contract, surface_name, member)
            assert row["canonical"] in outcomes, (surface_name, member)
            assert isinstance(row["lossy"], bool), (surface_name, member)


def test_project_outcome_fails_closed_on_unknown_surface_and_value() -> None:
    contract = _mod.load_contract()
    with pytest.raises(_mod.ObservationContractError):
        _mod.project_outcome(contract, "no_such_surface", "valid")
    with pytest.raises(_mod.ObservationContractError):
        _mod.project_outcome(contract, "probe_report_verdict", "outside-the-domain")


def test_claim_and_adapter_lookups_fail_closed() -> None:
    contract = _mod.load_contract()
    claim = _mod.claim_row(contract, "identity.instance_name")
    assert claim["min_projection"] == "diagnostic"
    adapter = _mod.adapter_row(contract, "auth-health")
    assert "identity.instance_name" in adapter["can_establish"]
    with pytest.raises(_mod.ObservationContractError):
        _mod.claim_row(contract, "no.such_claim")
    with pytest.raises(_mod.ObservationContractError):
        _mod.adapter_row(contract, "no-such-adapter")


def test_build_contract_rejects_structural_faults() -> None:
    good = _committed_docs()

    missing = dict(good)
    del missing["claim-catalog.json"]
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(missing)

    nondict = copy.deepcopy(good)
    nondict["authority-lattice.json"] = []
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(nondict)

    dup_row = copy.deepcopy(good)
    surface = dup_row["outcome-projections.json"]["surfaces"]["probe_report_verdict"]
    surface["rows"].append(dict(surface["rows"][0]))
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(dup_row)

    non_total = copy.deepcopy(good)
    surface = non_total["outcome-projections.json"]["surfaces"]["probe_report_verdict"]
    surface["rows"] = surface["rows"][1:]
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(non_total)

    bad_canonical = copy.deepcopy(good)
    surface = bad_canonical["outcome-projections.json"]["surfaces"]["probe_report_verdict"]
    surface["rows"][0]["canonical"] = "greenish"
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(bad_canonical)

    stray_row = copy.deepcopy(good)
    surface = stray_row["outcome-projections.json"]["surfaces"]["probe_report_verdict"]
    surface["rows"].append({"legacy_value": "not-declared", "canonical": "pass", "lossy": False})
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(stray_row)

    dup_claim = copy.deepcopy(good)
    dup_claim["claim-catalog.json"]["claims"].append(
        dict(dup_claim["claim-catalog.json"]["claims"][0])
    )
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(dup_claim)

    dup_adapter = copy.deepcopy(good)
    dup_adapter["adapter-registry.json"]["adapters"].append(
        dict(dup_adapter["adapter-registry.json"]["adapters"][0])
    )
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(dup_adapter)

    bad_vocab = copy.deepcopy(good)
    bad_vocab["outcome-projections.json"]["canonical_outcomes"] = []
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(bad_vocab)


def test_digest_domain_rejects_non_integer_numbers() -> None:
    # Cross-language digest parity holds only where both encoders agree.
    # Python repr(1e-07) != JS String(1e-7), so floats are outside the digest
    # domain and must fail closed instead of silently diverging.
    mutated = copy.deepcopy(_committed_docs())
    mutated["authority-lattice.json"]["drift_epsilon"] = 1e-7
    with pytest.raises(_mod.ObservationContractError):
        _mod.contract_digest(mutated)


def test_digest_domain_rejects_unsafe_range_integers() -> None:
    # Above 2**53-1 JS loses integer precision on parse, so the digest domain
    # ends at the safe-integer boundary on both sides.
    mutated = copy.deepcopy(_committed_docs())
    mutated["authority-lattice.json"]["counter"] = 2**53
    with pytest.raises(_mod.ObservationContractError):
        _mod.contract_digest(mutated)
    boundary = copy.deepcopy(_committed_docs())
    boundary["authority-lattice.json"]["counter"] = 2**53 - 1
    assert len(_mod.contract_digest(boundary)) == 64


def test_digest_domain_rejects_non_bmp_object_keys() -> None:
    # Python sorts keys by code point, JS by UTF-16 code unit; the orders
    # disagree once a key leaves the BMP, so such keys are outside the domain.
    mutated = copy.deepcopy(_committed_docs())
    mutated["authority-lattice.json"]["\U00010000"] = True
    with pytest.raises(_mod.ObservationContractError):
        _mod.contract_digest(mutated)


def test_digest_domain_normalizes_integral_floats_to_integers() -> None:
    # Acceptance parity (req-obs-02): JS JSON.parse normalizes 1.0/1e0/-0 to
    # integers before any reader code runs, so Python must accept the same
    # values and canonicalize them to the same integer encoding.
    base = copy.deepcopy(_committed_docs())
    base["authority-lattice.json"]["ratio"] = 1
    as_float = copy.deepcopy(_committed_docs())
    as_float["authority-lattice.json"]["ratio"] = json.loads("1.0")
    as_exp = copy.deepcopy(_committed_docs())
    as_exp["authority-lattice.json"]["ratio"] = json.loads("1e0")
    assert _mod.contract_digest(as_float) == _mod.contract_digest(base)
    assert _mod.contract_digest(as_exp) == _mod.contract_digest(base)

    zero = copy.deepcopy(_committed_docs())
    zero["authority-lattice.json"]["ratio"] = 0
    neg_zero = copy.deepcopy(_committed_docs())
    neg_zero["authority-lattice.json"]["ratio"] = json.loads("-0.0")
    assert _mod.contract_digest(neg_zero) == _mod.contract_digest(zero)

    # Normalization never mutates caller-owned input.
    assert isinstance(as_float["authority-lattice.json"]["ratio"], float)


def test_digest_domain_handles_booleans_before_integers() -> None:
    # bool subclasses int in Python; booleans must encode as true/false, never
    # collapse into the integer domain.
    as_bool = copy.deepcopy(_committed_docs())
    as_bool["authority-lattice.json"]["flag"] = True
    as_int = copy.deepcopy(_committed_docs())
    as_int["authority-lattice.json"]["flag"] = 1
    assert _mod.contract_digest(as_bool) != _mod.contract_digest(as_int)


def test_build_contract_returns_normalized_documents() -> None:
    # req-obs-02 applies to the RETURNED contract data, not only the digest:
    # a Python consumer must see the same integer a TS consumer sees after
    # JSON.parse, in docs, claims, adapters, and projection rows alike.
    mutated = copy.deepcopy(_committed_docs())
    mutated["authority-lattice.json"]["ratio"] = json.loads("1.0")
    first_claim = mutated["claim-catalog.json"]["claims"][0]
    first_claim["parity_probe"] = json.loads("2.0")
    surface = mutated["outcome-projections.json"]["surfaces"]["probe_report_verdict"]
    surface["rows"][0]["parity_probe"] = json.loads("3.0")

    contract = _mod.build_contract(mutated)
    ratio = contract["docs"]["authority-lattice.json"]["ratio"]
    assert isinstance(ratio, int) and not isinstance(ratio, bool)
    claim = contract["claims"][first_claim["claim_id"]]
    assert isinstance(claim["parity_probe"], int)
    row = _mod.project_outcome(
        contract, "probe_report_verdict", surface["rows"][0]["legacy_value"]
    )
    assert isinstance(row["parity_probe"], int)


def test_load_contract_normalizes_raw_decimal_literals(tmp_path: Path) -> None:
    # The loader path itself must normalize raw bytes: a contract file
    # containing the literal 1.0 loads to the same contract (and digest) as
    # one containing 1.
    for name in _mod.CONTRACT_FILE_NAMES:
        (tmp_path / name).write_text(
            (_CONTRACT_DIR / name).read_text(encoding="utf-8"), encoding="utf-8"
        )
    lattice_text = (_CONTRACT_DIR / "authority-lattice.json").read_text(encoding="utf-8")
    assert lattice_text.lstrip().startswith("{")
    (tmp_path / "authority-lattice.json").write_text(
        lattice_text.replace("{", '{"ratio": 1.0, ', 1), encoding="utf-8"
    )
    contract = _mod.load_contract(tmp_path)
    ratio = contract["docs"]["authority-lattice.json"]["ratio"]
    assert isinstance(ratio, int) and not isinstance(ratio, bool)

    as_int = copy.deepcopy(_committed_docs())
    as_int["authority-lattice.json"]["ratio"] = 1
    assert contract["digest"] == _mod.contract_digest(as_int)


def test_digest_domain_rejects_unsafe_and_fractional_numbers_nested() -> None:
    # The bound applies after normalization and at any depth.
    huge = copy.deepcopy(_committed_docs())
    huge["authority-lattice.json"]["nested"] = [{"deep": json.loads("1e100")}]
    with pytest.raises(_mod.ObservationContractError):
        _mod.contract_digest(huge)

    frac = copy.deepcopy(_committed_docs())
    frac["authority-lattice.json"]["nested"] = [{"deep": 0.5}]
    with pytest.raises(_mod.ObservationContractError):
        _mod.contract_digest(frac)

    nonfinite = copy.deepcopy(_committed_docs())
    nonfinite["authority-lattice.json"]["nested"] = [{"deep": json.loads("1e400")}]
    with pytest.raises(_mod.ObservationContractError):
        _mod.contract_digest(nonfinite)


def test_digest_domain_rejects_nested_non_bmp_object_keys() -> None:
    mutated = copy.deepcopy(_committed_docs())
    mutated["authority-lattice.json"]["nested"] = [{"\U00010000": True}]
    with pytest.raises(_mod.ObservationContractError):
        _mod.contract_digest(mutated)


def test_digest_domain_keeps_non_bmp_string_values() -> None:
    # String VALUES are order-insensitive and surrogate-escape identically on
    # both sides (proven by the lockstep non-ASCII case), so they stay in.
    mutated = copy.deepcopy(_committed_docs())
    mutated["authority-lattice.json"]["description"] = "lockstep \U0001F9EA"
    assert len(_mod.contract_digest(mutated)) == 64


def test_lookups_fail_closed_on_prototype_chain_names() -> None:
    # Parity pin for the TS port: names that exist on Object.prototype in JS
    # must behave as ordinary unknown keys on both sides.
    contract = _mod.load_contract()
    for name in ("toString", "constructor", "__proto__"):
        with pytest.raises(_mod.ObservationContractError):
            _mod.claim_row(contract, name)
        with pytest.raises(_mod.ObservationContractError):
            _mod.adapter_row(contract, name)
        with pytest.raises(_mod.ObservationContractError):
            _mod.project_outcome(contract, name, "x")
        with pytest.raises(_mod.ObservationContractError):
            _mod.project_outcome(contract, "probe_report_verdict", name)


def test_load_contract_missing_file_fails_closed(tmp_path: Path) -> None:
    for name in _mod.CONTRACT_FILE_NAMES:
        if name == "claim-catalog.json":
            continue
        (tmp_path / name).write_text(
            (_CONTRACT_DIR / name).read_text(encoding="utf-8"), encoding="utf-8"
        )
    with pytest.raises(_mod.ObservationContractError):
        _mod.load_contract(tmp_path)


def test_build_contract_rejects_unsupported_schema_version() -> None:
    # Version enforcement must live in the READERS, not only the guard: a
    # runtime consumer must never interpret an unsupported contract version.
    mutated = copy.deepcopy(_committed_docs())
    mutated["claim-catalog.json"]["schema_version"] = "999"
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(mutated)


def test_build_contract_rejects_unknown_or_missing_min_projection() -> None:
    # min_projection is a closed, REQUIRED vocabulary: a typo like
    # "diagnotic" or a missing value must never weaken projection authority.
    typo = copy.deepcopy(_committed_docs())
    typo["claim-catalog.json"]["claims"][0]["min_projection"] = "diagnotic"
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(typo)

    missing = copy.deepcopy(_committed_docs())
    del missing["claim-catalog.json"]["claims"][0]["min_projection"]
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(missing)


def test_contract_state_is_recursively_immutable() -> None:
    # Copy-on-read accessors are not enough: the returned contract itself must
    # refuse direct mutation, or evaluated policy can drift from the digest.
    contract = _mod.load_contract()
    with pytest.raises(TypeError):
        contract["claims"]["auth_bond.status"]["min_projection"] = "public"
    with pytest.raises(TypeError):
        contract["claims"]["extra"] = {}
    surface = contract["surfaces"]["probe_report_verdict"]
    member = surface["domain"][0]
    with pytest.raises(TypeError):
        surface["rows"][member]["canonical"] = "fail"
    assert _mod.claim_row(contract, "auth_bond.status")["min_projection"] == "diagnostic"


def test_required_claim_fields_are_mandatory() -> None:
    # Closed-world authority model (deploy/observation-plane/README.md): a claim
    # missing governed authority metadata must NEVER load.
    for field in (
        "family",
        "subject_kind",
        "authority_tier",
        "generation_binding",
        "staleness_rule",
        "producing_adapters",
        "cannot_establish",
    ):
        mutated = copy.deepcopy(_committed_docs())
        del mutated["claim-catalog.json"]["claims"][0][field]
        with pytest.raises(_mod.ObservationContractError):
            _mod.build_contract(mutated)


def test_required_adapter_fields_are_mandatory() -> None:
    for field in (
        "wraps",
        "platforms",
        "privilege",
        "prerequisites",
        "projection_scope",
        "can_establish",
        "cannot_establish",
        "status",
    ):
        mutated = copy.deepcopy(_committed_docs())
        del mutated["adapter-registry.json"]["adapters"][0][field]
        with pytest.raises(_mod.ObservationContractError):
            _mod.build_contract(mutated)


def test_authority_vocabularies_are_closed() -> None:
    cases = [
        ("claim-catalog.json", "claims", "authority_tier", "nonexistent_tier"),
        ("claim-catalog.json", "claims", "generation_binding", "proccess"),
        ("adapter-registry.json", "adapters", "projection_scope", "diagnotic"),
        ("adapter-registry.json", "adapters", "status", "availble"),
    ]
    for doc, key, field, bad in cases:
        mutated = copy.deepcopy(_committed_docs())
        mutated[doc][key][0][field] = bad
        with pytest.raises(_mod.ObservationContractError):
            _mod.build_contract(mutated)


def test_staleness_rule_shape_is_validated() -> None:
    for bad in ("not-a-mapping", {}, {"kind": 7}, {"kind": "fixed_window", "window_seconds": "soon"}):
        mutated = copy.deepcopy(_committed_docs())
        mutated["claim-catalog.json"]["claims"][0]["staleness_rule"] = bad
        with pytest.raises(_mod.ObservationContractError):
            _mod.build_contract(mutated)


# `window_seconds` is CONDITIONAL on `kind`: required-and-positive for
# fixed_window, prohibited for every other declared kind. Mirrored case-for-case
# by the lockstep suite, which asserts the TS reader reaches the same verdict.
_STALENESS_REJECTED = (
    # Presence, not non-null: an explicit null must fail here exactly as it
    # does in TS, where `null !== undefined`.
    {"kind": "event_bound", "window_seconds": None},
    {"kind": "event_bound", "window_seconds": 3600},
    {"kind": "scheduler_deadline", "window_seconds": 3600},
    {"kind": "fixed_window"},
    {"kind": "fixed_window", "window_seconds": 0},
    {"kind": "fixed_window", "window_seconds": -1},
    {"kind": "fixed_window", "window_seconds": 2**53},
    {"kind": "fixed_window", "window_seconds": 86400.5},
    {"kind": "fixed_window", "window_seconds": True},
    {"kind": "fixed-window", "window_seconds": 86400},
    {"kind": "FIXED_WINDOW", "window_seconds": 86400},
    {"kind": "bounded"},
    {"kind": "event_bound", "surprise": 1},
    {"kind": "event_bound", "note": 7},
)
_STALENESS_ACCEPTED = (
    {"kind": "fixed_window", "window_seconds": 1},
    {"kind": "fixed_window", "window_seconds": 2**53 - 1},
    # Integral float: JSON `86400.0` parses to a Python float but to the
    # integer 86400 in JS. build_contract normalizes before validating, so both
    # readers accept it and return the same integer. This case cannot travel
    # the lockstep channel (json.dumps/JSON.stringify collapse it), so its
    # parity is pinned here.
    {"kind": "fixed_window", "window_seconds": 86400.0},
    {"kind": "event_bound", "note": "ok"},
    {"kind": "event_bound"},
    {"kind": "scheduler_deadline"},
    {"kind": "fixed_window", "window_seconds": 86400, "note": "n"},
)


@pytest.mark.parametrize("rule", _STALENESS_REJECTED)
def test_staleness_rule_boundaries_fail_closed(rule: object) -> None:
    mutated = copy.deepcopy(_committed_docs())
    mutated["claim-catalog.json"]["claims"][0]["staleness_rule"] = rule
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(mutated)


@pytest.mark.parametrize("rule", _STALENESS_ACCEPTED)
def test_staleness_rule_boundaries_accept_declared_shapes(rule: dict) -> None:
    mutated = copy.deepcopy(_committed_docs())
    claim_id = mutated["claim-catalog.json"]["claims"][0]["claim_id"]
    mutated["claim-catalog.json"]["claims"][0]["staleness_rule"] = rule
    built = _mod.build_contract(mutated)["claims"][claim_id]["staleness_rule"]
    assert built["kind"] == rule["kind"]
    if "window_seconds" in rule:
        # Integral floats are canonicalized to int before validation, so the
        # returned value is the same integer a TS consumer sees.
        assert isinstance(built["window_seconds"], int)
        assert built["window_seconds"] == int(rule["window_seconds"])
    else:
        assert "window_seconds" not in built


# Governed scalar fields and where they live. A malformed value for any of
# these must stay inside ObservationContractError: both readers already
# REJECTED these inputs, but they escaped as raw TypeError (`x in frozenset`
# on an unhashable dict/list), so a caller could not classify the evidence.
_GOVERNED_SCALARS = (
    ("claim-catalog.json", "claims", "min_projection"),
    ("claim-catalog.json", "claims", "authority_tier"),
    ("claim-catalog.json", "claims", "generation_binding"),
    ("adapter-registry.json", "adapters", "projection_scope"),
    ("adapter-registry.json", "adapters", "status"),
)
_WRONG_TYPES = (
    ("null", None),
    ("object", {"a": 1}),
    ("array", [1]),
    ("bool", True),
    ("number", 5),
    ("invalid_string", "definitely-not-a-declared-value"),
)


@pytest.mark.parametrize("doc,coll,field", _GOVERNED_SCALARS)
@pytest.mark.parametrize("label,value", _WRONG_TYPES)
def test_malformed_governed_scalar_stays_in_error_taxonomy(
    doc: str, coll: str, field: str, label: str, value: object
) -> None:
    mutated = copy.deepcopy(_committed_docs())
    mutated[doc][coll][0][field] = value
    # Exact class, not "raises Exception": a raw TypeError here would still be
    # a rejection but an UNCLASSIFIABLE one.
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(mutated)


@pytest.mark.parametrize("doc,coll,field", _GOVERNED_SCALARS)
@pytest.mark.parametrize("label,value", _WRONG_TYPES)
def test_caller_classifies_malformed_evidence_as_invalid_evidence(
    doc: str, coll: str, field: str, label: str, value: object
) -> None:
    """Caller-level proof of the taxonomy: a consumer that catches ONLY the
    documented error class must be able to classify every malformed input as
    invalid_evidence. Deliberately no bare `except Exception` — if the reader
    raises anything else the exception propagates and this test fails."""
    mutated = copy.deepcopy(_committed_docs())
    mutated[doc][coll][0][field] = value

    def classify(docs: dict) -> str:
        try:
            _mod.build_contract(docs)
        except _mod.ObservationContractError:
            return "invalid_evidence"
        return "pass"

    assert classify(mutated) == "invalid_evidence", f"{doc}.{field} = {label}"


def test_describe_value_never_raises_on_governed_shapes() -> None:
    cases = [
        (None, "null"),
        (True, "true"),
        (False, "false"),
        ("x", '"x"'),
        (5, "5"),
        ({"a": 1}, "object"),
        ([1], "array"),
    ]
    for value, expected in cases:
        assert _mod._describe_value(value) == expected
    # A null-prototype-equivalent mapping (no __str__ of its own) is the shape
    # that broke the TS side; the Python formatter must name it structurally.
    assert _mod._describe_value(MappingProxyType({"a": 1})) == "object"


def test_committed_staleness_rules_are_inside_the_closed_vocabulary() -> None:
    # The tightening must not reject the data it governs.
    contract = _mod.build_contract(_committed_docs())
    for claim_id, claim in contract["claims"].items():
        rule = claim["staleness_rule"]
        assert rule["kind"] in _mod.STALENESS_KINDS, claim_id
        if rule["kind"] == "fixed_window":
            assert isinstance(rule["window_seconds"], int)
            assert rule["window_seconds"] > 0, claim_id
        else:
            assert "window_seconds" not in rule, claim_id


def test_claim_adapter_producer_symmetry_is_enforced() -> None:
    # A claim naming a producer the adapter does not declare (and vice versa)
    # breaks the closed-world model in either direction.
    forward = copy.deepcopy(_committed_docs())
    claim = forward["claim-catalog.json"]["claims"][0]
    producer = claim["producing_adapters"][0]
    for adapter in forward["adapter-registry.json"]["adapters"]:
        if adapter["adapter_id"] == producer:
            adapter["can_establish"] = [
                c for c in adapter["can_establish"] if c != claim["claim_id"]
            ]
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(forward)

    reverse = copy.deepcopy(_committed_docs())
    claim = reverse["claim-catalog.json"]["claims"][0]
    claim["producing_adapters"] = [
        a for a in claim["producing_adapters"] if a != claim["producing_adapters"][0]
    ]
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(reverse)


def test_unknown_cross_references_fail_closed() -> None:
    unknown_producer = copy.deepcopy(_committed_docs())
    unknown_producer["claim-catalog.json"]["claims"][0]["producing_adapters"] = ["no-such-adapter"]
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(unknown_producer)

    unknown_claim = copy.deepcopy(_committed_docs())
    unknown_claim["adapter-registry.json"]["adapters"][0]["can_establish"] = ["no.such_claim"]
    with pytest.raises(_mod.ObservationContractError):
        _mod.build_contract(unknown_claim)


def test_contract_snapshot_is_plain_json_and_detached() -> None:
    # The frozen contract itself is not JSON-serializable (mapping proxies);
    # the official snapshot operation returns a plain, mutable, detached copy.
    contract = _mod.load_contract()
    snapshot = _mod.contract_snapshot(contract)
    serialized = json.dumps(snapshot, sort_keys=True)
    assert len(serialized) > 0
    snapshot["digest"] = "tampered"
    assert contract["digest"] != "tampered"
    assert isinstance(snapshot["docs"], dict)
    assert isinstance(snapshot["canonical_outcomes"], list)


def test_lookups_return_defensive_copies() -> None:
    # Digest-bound state must not be mutable through the lookup API: a caller
    # mutating a returned row must not poison later reads.
    contract = _mod.load_contract()
    row = _mod.claim_row(contract, "identity.instance_name")
    original = row["min_projection"]
    row["min_projection"] = "public"
    assert _mod.claim_row(contract, "identity.instance_name")["min_projection"] == original


def test_load_contract_rejects_bom_prefixed_document(tmp_path: Path) -> None:
    # A UTF-8 BOM is not part of the accepted byte domain: Python's json
    # rejects it, and the TS loader must not silently strip it.
    for name in _mod.CONTRACT_FILE_NAMES:
        (tmp_path / name).write_bytes((_CONTRACT_DIR / name).read_bytes())
    target = tmp_path / "authority-lattice.json"
    target.write_bytes(b"\xef\xbb\xbf" + target.read_bytes())
    with pytest.raises(_mod.ObservationContractError):
        _mod.load_contract(tmp_path)


def test_load_contract_invalid_utf8_fails_closed(tmp_path: Path) -> None:
    # Invalid bytes must raise the contract error, never leak a raw
    # UnicodeDecodeError, and never be lossily replaced (the TS side must
    # reject the same bytes rather than decode with U+FFFD).
    for name in _mod.CONTRACT_FILE_NAMES:
        (tmp_path / name).write_bytes((_CONTRACT_DIR / name).read_bytes())
    raw = (tmp_path / "authority-lattice.json").read_bytes()
    brace = raw.index(b"{")
    (tmp_path / "authority-lattice.json").write_bytes(
        raw[: brace + 1] + b'"probe": "' + bytes([0xC3, 0x28]) + b'", ' + raw[brace + 1 :]
    )
    with pytest.raises(_mod.ObservationContractError):
        _mod.load_contract(tmp_path)


def test_dunder_proto_identifiers_are_ordinary_keys() -> None:
    # Parity pin: __proto__ has no special meaning in Python dicts; the TS
    # port must treat it as an ordinary own key too (null-prototype
    # accumulators), neither polluting nor dropping it.
    docs = copy.deepcopy(_committed_docs())
    docs["adapter-registry.json"]["adapters"].append(
        {
            "adapter_id": "__proto__",
            "wraps": ["probe fixture"],
            "platforms": ["darwin"],
            "privilege": "none",
            "prerequisites": [],
            "projection_scope": "not_applicable",
            "can_establish": [],
            "cannot_establish": [],
            "status": "producer_pending",
        }
    )
    contract = _mod.build_contract(docs)
    row = _mod.adapter_row(contract, "__proto__")
    assert row["adapter_id"] == "__proto__"


def test_load_contract_malformed_json_fails_closed(tmp_path: Path) -> None:
    for name in _mod.CONTRACT_FILE_NAMES:
        (tmp_path / name).write_text(
            (_CONTRACT_DIR / name).read_text(encoding="utf-8"), encoding="utf-8"
        )
    (tmp_path / "outcome-projections.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(_mod.ObservationContractError):
        _mod.load_contract(tmp_path)
