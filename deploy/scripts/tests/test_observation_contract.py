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


def test_load_contract_missing_file_fails_closed(tmp_path: Path) -> None:
    for name in _mod.CONTRACT_FILE_NAMES:
        if name == "claim-catalog.json":
            continue
        (tmp_path / name).write_text(
            (_CONTRACT_DIR / name).read_text(encoding="utf-8"), encoding="utf-8"
        )
    with pytest.raises(_mod.ObservationContractError):
        _mod.load_contract(tmp_path)


def test_load_contract_malformed_json_fails_closed(tmp_path: Path) -> None:
    for name in _mod.CONTRACT_FILE_NAMES:
        (tmp_path / name).write_text(
            (_CONTRACT_DIR / name).read_text(encoding="utf-8"), encoding="utf-8"
        )
    (tmp_path / "outcome-projections.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(_mod.ObservationContractError):
        _mod.load_contract(tmp_path)
