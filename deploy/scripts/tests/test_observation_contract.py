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
        {"adapter_id": "__proto__", "can_establish": [], "cannot_establish": []}
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
