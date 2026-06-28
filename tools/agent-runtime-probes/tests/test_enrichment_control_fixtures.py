#!/usr/bin/env python3
"""Tests for enrichment_control_fixtures (Bead 2.4): control-arm generator.

Standalone runner in the test_pi_presence_probe.py style (no pytest). Covers:
  - near_miss arm is DISTINCT from random (similarity_tag + wrongness_reason + verifier);
  - unverifiable near-miss increments invalid_nearmiss_count (UNHAPPY);
  - position_ablation has same content as gold but a different position slot;
  - determinism: same seed -> byte-identical report and content;
  - padding arm matches gold token budget, carries no query terms;
  - malformed query fixtures -> typed invalid (UNHAPPY);
  - empty query fixtures -> degraded marker (UNHAPPY);
  - out-dir write failure -> typed error (UNHAPPY);
  - report is metadata-only (no content strings leak);
  - CLI e2e via real subprocess.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import enrichment_control_fixtures as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "enrichment_control_fixtures.py"
SEED = 1729


def _report(seed=SEED, **kw):
    return probe.build_report(seed, **kw)


def test_schema_envelope_and_seed_present():
    r = _report()
    assert r["schema"] == "agent-runtime-enrichment-control-fixtures"
    assert r["schema_version"] == "0.1"
    assert r["redaction"] == "metadata-only"
    assert r["seed"] == SEED
    assert set(r["arms"]) == {"gold", "random", "near_miss", "padding", "position_ablation"}


def test_all_five_arms_have_items():
    r = _report()
    by_arm = {s["arm"]: s for s in r["arms_summary"]}
    for arm in ("gold", "random", "near_miss", "padding", "position_ablation"):
        assert by_arm[arm]["item_count"] >= 1, arm


def test_near_miss_distinct_from_random():
    # The hard control must be DISTINGUISHABLE from the noise-floor control: it carries
    # similarity_tag + wrongness_reason + verifier, random carries only an "unrelated" tag.
    r = _report()
    by_arm = {s["arm"]: s for s in r["arms_summary"]}
    near = by_arm["near_miss"]
    rand = by_arm["random"]
    assert near["verifier"] == "value_mismatch_verifier"
    assert near["wrongness_reason"] != ""
    assert near["similarity_tag"] != rand["similarity_tag"]
    assert "verifier" not in rand
    assert rand["similarity_tag"] == "unrelated"


def test_unverifiable_near_miss_increments_invalid_count():
    # UNHAPPY: a near-miss with no checkable claim is invalid, never silently valid.
    r = _report()
    assert r["invalid_nearmiss_count"] >= 1
    # The vague France near-miss (no asserted/correct pair) must be excluded.
    near_summary = next(s for s in r["arms_summary"] if s["arm"] == "near_miss")
    # Two fixtures supply verifiable near-misses; the third near-miss is invalid.
    assert near_summary["item_count"] == 3


def test_unverifiable_near_miss_verifier_logic():
    # UNHAPPY: directly exercise the verifier on an invalid (asserted==correct) claim.
    verified, label = probe._verify_near_miss(
        {"asserted_value": "X", "correct_value": "X"}
    )
    assert verified is False
    assert label == "asserted_equals_correct"
    verified2, label2 = probe._verify_near_miss({"text": "no claim"})
    assert verified2 is False
    assert label2 == "no_checkable_claim"


def test_position_ablation_same_content_different_slot():
    # H10: position_ablation reuses gold content byte-for-byte, only position differs,
    # and the query is held fixed.
    out_dir = Path(tempfile.mkdtemp(prefix="cape_ctrl_"))
    _report(out_dir=out_dir)
    gold = [json.loads(l) for l in (out_dir / "gold.jsonl").read_text().splitlines()]
    abl = [json.loads(l) for l in (out_dir / "position_ablation.jsonl").read_text().splitlines()]
    gold_by_q = {g["query_id"]: g for g in gold}
    for item in abl:
        g = gold_by_q[item["query_id"]]
        assert item["content"] == g["content"]  # SAME content
        assert item["position"] == "suffix"      # DIFFERENT position
        assert "query" in item                    # query recorded (held fixed)


def test_padding_matches_gold_token_budget_no_query_terms():
    out_dir = Path(tempfile.mkdtemp(prefix="cape_pad_"))
    _report(out_dir=out_dir)
    gold = [json.loads(l) for l in (out_dir / "gold.jsonl").read_text().splitlines()]
    pad = [json.loads(l) for l in (out_dir / "padding.jsonl").read_text().splitlines()]
    gold_by_q = {g["query_id"]: g for g in gold}
    for item in pad:
        g = gold_by_q[item["query_id"]]
        # within one token of gold (filler is sized to the gold token budget)
        assert abs(item["token_estimate"] - g["token_estimate"]) <= 1
        # padding carries no gold word
        assert "France" not in item["content"]
        assert "Paris" not in item["content"]


def test_determinism_same_seed_identical_report():
    r1 = _report()
    r2 = _report()
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


def test_determinism_same_seed_identical_content():
    d1 = Path(tempfile.mkdtemp(prefix="cape_det1_"))
    d2 = Path(tempfile.mkdtemp(prefix="cape_det2_"))
    r1 = _report(out_dir=d1)
    r2 = _report(out_dir=d2)
    assert r1["content_out"]["content_sha256_16"] == r2["content_out"]["content_sha256_16"]
    for arm in probe.ARMS:
        assert (d1 / f"{arm}.jsonl").read_text() == (d2 / f"{arm}.jsonl").read_text()


def test_different_seed_changes_random_and_padding():
    # Determinism does not mean seed-insensitivity: the seeded arms vary across seeds.
    d_a = Path(tempfile.mkdtemp(prefix="cape_seedA_"))
    d_b = Path(tempfile.mkdtemp(prefix="cape_seedB_"))
    _report(seed=1, out_dir=d_a)
    _report(seed=999999, out_dir=d_b)
    a = (d_a / "padding.jsonl").read_text()
    b = (d_b / "padding.jsonl").read_text()
    # gold content is seed-invariant, but padding filler char is seeded -> differs.
    assert a != b


def test_malformed_query_fixtures_typed_invalid():
    # UNHAPPY: a non-list JSON top level is malformed -> typed invalid, not silent empty.
    _fd, _name = tempfile.mkstemp(prefix="cape_bad_", suffix=".json"); os.close(_fd); bad = Path(_name)
    bad.write_text('{"not": "a list"}')
    r = _report(query_fixtures_path=bad)
    assert r["parse_status"] == "invalid"
    assert r["error_type"] == "malformed_query_fixtures"
    assert "_error" in r


def test_malformed_json_query_fixtures_typed_invalid():
    # UNHAPPY: invalid JSON -> MalformedQueryFixtureError -> typed invalid report.
    _fd, _name = tempfile.mkstemp(prefix="cape_badjson_", suffix=".json"); os.close(_fd); bad = Path(_name)
    bad.write_text("{ this is not json")
    r = _report(query_fixtures_path=bad)
    assert r["parse_status"] == "invalid"
    assert r["error_type"] == "malformed_query_fixtures"


def test_missing_required_field_typed_invalid():
    # UNHAPPY: a fixture entry missing `gold` -> typed invalid.
    _fd, _name = tempfile.mkstemp(prefix="cape_missing_", suffix=".json"); os.close(_fd); bad = Path(_name)
    bad.write_text(json.dumps([{"query_id": "x", "query": "hi"}]))
    r = _report(query_fixtures_path=bad)
    assert r["parse_status"] == "invalid"
    assert "missing_field:gold" in r["_error"]


def test_missing_query_fixtures_file_typed_invalid():
    # UNHAPPY: a nonexistent fixture path raises a typed read_error -> invalid report.
    missing = Path("/nonexistent-cape-xyz/queries.json")
    r = _report(query_fixtures_path=missing)
    assert r["parse_status"] == "invalid"
    assert r["error_type"] == "malformed_query_fixtures"
    assert "read_error" in r["_error"]


def test_empty_query_fixtures_degraded():
    # UNHAPPY: an empty (valid) list -> degraded marker, never a fabricated success.
    _fd, _name = tempfile.mkstemp(prefix="cape_empty_", suffix=".json"); os.close(_fd); empty = Path(_name)
    empty.write_text("[]")
    r = _report(query_fixtures_path=empty)
    assert r["status"] == "degraded"
    assert r["error_type"] == "empty_query_fixtures"
    assert r["arms_summary"] == []
    assert r["invalid_nearmiss_count"] == 0


def test_out_dir_write_error_typed():
    # UNHAPPY: an unwritable out-dir surfaces a typed out_dir_write_error, not a swallow.
    # Point out-dir under a regular file so mkdir fails with OSError.
    _fd, _name = tempfile.mkstemp(prefix="cape_block_"); os.close(_fd); blocker = Path(_name)
    blocker.write_text("i am a file")
    out_dir = blocker / "sub"
    buf = io.StringIO()
    argv = sys.argv
    sys.argv = ["enrichment_control_fixtures.py", "--seed", str(SEED), "--out-dir", str(out_dir)]
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = argv
    assert rc == 1
    report = json.loads(buf.getvalue())
    assert report["error_type"] == "out_dir_write_error"
    assert report["parse_status"] == "invalid"


def test_report_is_metadata_only_no_content_leak():
    # The report must not carry fixture CONTENT strings (the gold/near-miss/random
    # context sentences). wrongness_reason IS a sanctioned per-arm metadata field per
    # the Bead 2.4 report contract, so a rationale that names an entity is allowed; the
    # actual context payload sentences must never appear.
    r = _report()
    blob = json.dumps(r)
    for fixture in probe._SYNTHETIC_FIXTURES:
        assert fixture["gold"] not in blob, fixture["query_id"]
        for fact in fixture.get("irrelevant", []):
            assert fact not in blob
        for nm in fixture.get("near_miss", []):
            assert nm["text"] not in blob
    # Only class labels / counts / tags are present.
    assert "arms_summary" in r and "invalid_nearmiss_count" in r


def test_caller_supplied_fixtures_used():
    _fd, _name = tempfile.mkstemp(prefix="cape_good_", suffix=".json"); os.close(_fd); good = Path(_name)
    good.write_text(json.dumps([
        {"query_id": "c1", "query": "Q?", "gold": "A gold answer here.",
         "irrelevant": ["unrelated fact one"],
         "near_miss": [{"text": "wrong but related", "similarity_tag": "t",
                        "wrongness_reason": "w", "asserted_value": "1", "correct_value": "2"}]},
    ]))
    r = _report(query_fixtures_path=good)
    assert r["fixtures_source"] == "caller_supplied"
    assert r["query_fixture_count"] == 1
    assert r["invalid_nearmiss_count"] == 0


def test_token_estimate_heuristic():
    assert probe.token_estimate("") == 0
    assert probe.token_estimate("abcd") == 1
    assert probe.token_estimate("abcde") == 2


def test_random_arm_falls_back_without_irrelevant_pool():
    # When fixtures carry no irrelevant facts, the random arm still produces a noise item.
    _fd, _name = tempfile.mkstemp(prefix="cape_norand_", suffix=".json"); os.close(_fd); good = Path(_name)
    good.write_text(json.dumps([{"query_id": "c1", "query": "Q?", "gold": "gold text"}]))
    out_dir = Path(tempfile.mkdtemp(prefix="cape_norand_out_"))
    r = _report(query_fixtures_path=good, out_dir=out_dir)
    rand_summary = next(s for s in r["arms_summary"] if s["arm"] == "random")
    assert rand_summary["item_count"] == 1
    rand = [json.loads(l) for l in (out_dir / "random.jsonl").read_text().splitlines()]
    assert rand[0]["provenance"] == "synthetic_random_noise"


def test_malformed_near_miss_text_counted_invalid():
    # UNHAPPY: a near-miss whose `text` is missing/empty is unverifiable -> invalid count.
    _fd, _name = tempfile.mkstemp(prefix="cape_nmtext_", suffix=".json"); os.close(_fd); good = Path(_name)
    good.write_text(json.dumps([
        {"query_id": "c1", "query": "Q?", "gold": "gold",
         "near_miss": [{"text": "", "asserted_value": "1", "correct_value": "2"}]},
    ]))
    r = _report(query_fixtures_path=good)
    assert r["invalid_nearmiss_count"] == 1


def test_cli_entrypoint_emits_valid_json():
    # e2e: real subprocess covers __main__ + json.dump path.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--seed", str(SEED), "--pretty"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-enrichment-control-fixtures"
    assert "arms_summary" in report
    assert report["invalid_nearmiss_count"] >= 1


def test_cli_malformed_fixtures_exit_nonzero():
    # UNHAPPY e2e: malformed fixture file -> nonzero exit + typed invalid report.
    _fd, _name = tempfile.mkstemp(prefix="cape_cli_bad_", suffix=".json"); os.close(_fd); bad = Path(_name)
    bad.write_text("not json at all {")
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--seed", str(SEED), "--query-fixtures", str(bad)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 1
    report = json.loads(proc.stdout)
    assert report["parse_status"] == "invalid"


def test_empty_required_field_is_malformed():
    # A required field must be a NON-EMPTY string (guard `not isinstance(value, str) or not value`).
    # An empty string is malformed; an and->or weakening would accept it (isinstance is True, so the
    # conjunction is False). The existing tests use MISSING fields, not empty ones.
    _fd, _name = tempfile.mkstemp(prefix="cape_empty_", suffix=".json"); os.close(_fd); bad = Path(_name)
    bad.write_text(json.dumps([{"query_id": "x", "query": "", "gold": "g"}]))
    try:
        r = _report(query_fixtures_path=bad)
    finally:
        bad.unlink(missing_ok=True)
    assert r["parse_status"] == "invalid"
    assert "missing_field:query" in r["_error"]


def test_near_miss_without_checkable_correct_value_is_invalid():
    # A near-miss needs a checkable claim: BOTH asserted_value and correct_value must be strings
    # (guard `not isinstance(asserted, str) or not isinstance(correct, str)`). If correct_value is
    # absent/non-str the claim is unverifiable. An and->or weakening would fall through to the
    # equality check (asserted == None -> False) and wrongly PROMOTE it to a valid value_mismatch
    # control — a soft (unfalsifiable) near-miss masquerading as a hard one.
    verified, label = probe._verify_near_miss({"asserted_value": "Paris", "correct_value": None})
    assert verified is False
    assert label == "no_checkable_claim"


def test_irrelevant_facts_filtered_and_used_for_random_arm():
    # The irrelevant pool is built from `fixture.get("irrelevant", []) or []` (default to empty) and
    # filtered by `isinstance(fact, str) and fact`. A non-string fact must be EXCLUDED (an and->or
    # weakening appends the int -> the pool .sort() raises TypeError), and a present pool must be USED
    # for the random arm (an and->[] weakening empties the pool -> the random arm falls back to the
    # default filler). One fixture with a mixed irrelevant list exercises both.
    import random
    fixtures = [{"query_id": "q1", "query": "what is the capital", "gold": "the gold answer",
                 "irrelevant": [123, "DISTINCTIVE_NOISE_FACT"]}]
    arm_items, _invalid = probe._build_arm_items(fixtures, random.Random(0))
    assert arm_items["random"][0]["content"] == "DISTINCTIVE_NOISE_FACT"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} enrichment_control_fixtures tests passed")
