#!/usr/bin/env python3
"""Tests for injection_budget_rail: deterministic token/item capping, unknown-token
adoption block, typed fail-closed errors, empty degradation, and CLI e2e.

No-install (pi_presence_probe.py style): asserts directly on the in-process API and
runs the CLI as a real subprocess for the __main__ entrypoint.
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

import injection_budget_rail as rail  # noqa: E402

RAIL_PATH = Path(__file__).resolve().parent.parent / "injection_budget_rail.py"


def _items(n):
    return [{"id": i} for i in range(n)]


def test_items_beyond_token_cap_dropped_deterministically():
    # 4 items of 200 tokens each, cap 500 -> admit first 2 (400), drop last 2.
    items = _items(4)
    counts = [200, 200, 200, 200]
    res = rail.apply_injection_budget(items, counts, max_tokens=500, max_items=10)
    assert res["budget_status"] == "token_capped"
    assert res["item_count"] == 2
    assert [a["rank_index"] for a in res["admitted_items"]] == [0, 1]
    assert [d["rank_index"] for d in res["dropped_items"]] == [2, 3]
    assert res["total_admitted_tokens"] == 400
    # Determinism: same input -> identical admit/drop split.
    res2 = rail.apply_injection_budget(items, counts, max_tokens=500, max_items=10)
    assert res == res2


def test_items_beyond_item_cap_dropped():
    # 6 cheap items, generous token cap, item cap 3 -> admit 3, drop 3 (item_capped).
    items = _items(6)
    counts = [10, 10, 10, 10, 10, 10]
    res = rail.apply_injection_budget(items, counts, max_tokens=10000, max_items=3)
    assert res["budget_status"] == "item_capped"
    assert res["item_count"] == 3
    assert [a["rank_index"] for a in res["admitted_items"]] == [0, 1, 2]
    assert [d["rank_index"] for d in res["dropped_items"]] == [3, 4, 5]
    assert all(d["reason"] == "item_capped" for d in res["dropped_items"])


def test_within_budget_admits_all():
    res = rail.apply_injection_budget(_items(3), [50, 50, 50], max_tokens=500, max_items=5)
    assert res["budget_status"] == "within_budget"
    assert res["item_count"] == 3
    assert res["dropped_items"] == []
    assert res["total_admitted_tokens"] == 150


def test_unknown_token_metric_blocks_adoption():
    # An unknown/absent token count is adoption-blocking: a measurement report is still
    # emitted, but budget_status flips to unknown_tokens_block_adoption (UNHAPPY).
    items = _items(3)
    counts = [100, None, 100]  # middle item's count is unknown/absent
    res = rail.apply_injection_budget(items, counts, max_tokens=500, max_items=5)
    assert res["budget_status"] == "unknown_tokens_block_adoption"
    # the unknown item is recorded with an explicit unknown contribution (not 0)
    contribs = {a["rank_index"]: a.get("token_contribution") for a in res["admitted_items"]}
    assert contribs[1] == "unknown"
    # "unknown" literal string also marks an absent metric
    res2 = rail.apply_injection_budget(items, [100, "unknown", 100], max_tokens=500, max_items=5)
    assert res2["budget_status"] == "unknown_tokens_block_adoption"


def test_mismatched_lengths_raises_typed_error():
    # mismatched items/token_counts -> typed error (fail closed), not a silent result.
    try:
        rail.apply_injection_budget(_items(3), [10, 10], max_tokens=500, max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "length_mismatch"
    else:
        raise AssertionError("expected InjectionBudgetError for mismatched lengths")


def test_negative_token_count_raises_typed_error():
    # negative token count is malformed -> typed error marker.
    try:
        rail.apply_injection_budget(_items(2), [10, -5], max_tokens=500, max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_token_count"
    else:
        raise AssertionError("expected InjectionBudgetError for negative token count")


def test_non_int_token_count_raises_typed_error():
    try:
        rail.apply_injection_budget(_items(2), [10, "lots"], max_tokens=500, max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_token_count"
    else:
        raise AssertionError("expected InjectionBudgetError for non-int token count")


def test_bool_token_count_raises_typed_error():
    # bool is an int subclass; it must be rejected, not silently treated as 0/1.
    try:
        rail.apply_injection_budget(_items(1), [True], max_tokens=500, max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_token_count"
    else:
        raise AssertionError("expected InjectionBudgetError for bool token count")


def test_invalid_cap_raises_typed_error():
    try:
        rail.apply_injection_budget(_items(1), [10], max_tokens=-1, max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
    else:
        raise AssertionError("expected InjectionBudgetError for negative cap")


def test_non_list_input_raises_typed_error():
    try:
        rail.apply_injection_budget("notalist", [10], max_tokens=500, max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_type"
    else:
        raise AssertionError("expected InjectionBudgetError for non-list input")


def test_empty_items_returns_empty_status_not_crash():
    # empty (absent) items -> degraded "empty" status, not a crash.
    res = rail.apply_injection_budget([], [], max_tokens=500, max_items=5)
    assert res["budget_status"] == "empty"
    assert res["item_count"] == 0
    assert res["admitted_items"] == []
    assert res["dropped_items"] == []
    assert res["total_admitted_tokens"] == 0


def test_determinism_repeated_calls_identical():
    items = _items(8)
    counts = [120, 130, 90, 200, 60, 300, 40, 75]
    runs = [
        rail.apply_injection_budget(items, counts, max_tokens=500, max_items=5)
        for _ in range(5)
    ]
    assert all(r == runs[0] for r in runs)


def test_build_report_is_metadata_only():
    # report carries only counts/caps/status — never raw item content.
    report = rail.build_report(_items(4), [200, 200, 200, 200], max_tokens=500, max_items=10)
    assert report["schema"] == "agent-runtime-injection-budget-rail"
    assert report["schema_version"] == "0.1"
    assert report["redaction"] == "metadata-only"
    assert report["max_tokens"] == 500 and report["max_items"] == 10
    assert report["admitted_count"] == 2 and report["dropped_count"] == 2
    assert report["total_admitted_tokens"] == 400
    assert report["budget_status"] == "token_capped"
    blob = json.dumps(report)
    assert "id" not in json.loads(blob).keys()


def test_cli_e2e_token_capped():
    # e2e: covers __main__ + real json.dump path through a subprocess.
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "items.json"
        artifact.write_text(json.dumps({
            "items": [{"id": i} for i in range(4)],
            "token_counts": [200, 200, 200, 200],
        }))
        proc = subprocess.run(
            [sys.executable, str(RAIL_PATH), "--items-artifact", str(artifact),
             "--max-tokens", "500", "--max-items", "10"],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["budget_status"] == "token_capped"
        assert report["admitted_count"] == 2
        assert report["dropped_count"] == 2
        assert report["total_admitted_tokens"] == 400


def test_cli_e2e_human_number_cap():
    # --max-tokens 1K is parsed via reused parse_human_number.
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "items.json"
        artifact.write_text(json.dumps({
            "items": [{"id": i} for i in range(3)],
            "token_counts": [300, 300, 300],
        }))
        proc = subprocess.run(
            [sys.executable, str(RAIL_PATH), "--items-artifact", str(artifact),
             "--max-tokens", "1K", "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["max_tokens"] == 1000
        # 300+300=600 admitted; third would be 900 (<=1000) so all 3 fit -> within_budget
        assert report["budget_status"] == "within_budget"
        assert report["admitted_count"] == 3


def test_cli_e2e_missing_artifact_typed_error_nonzero_exit():
    # UNHAPPY: missing artifact -> typed error marker, nonzero exit.
    proc = subprocess.run(
        [sys.executable, str(RAIL_PATH), "--items-artifact", "/nonexistent-xyz/items.json"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 1
    report = json.loads(proc.stdout)
    assert report["error_type"] == "missing_input"
    assert report["budget_status"] == "error"


def test_cli_e2e_malformed_artifact_typed_error():
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "bad.json"
        artifact.write_text(json.dumps({"items": [{"id": 0}]}))  # token_counts missing
        proc = subprocess.run(
            [sys.executable, str(RAIL_PATH), "--items-artifact", str(artifact)],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 1
        report = json.loads(proc.stdout)
        assert report["error_type"] == "malformed_input"


def _run_main(argv):
    """Drive main() in-process (so coverage_check traces it), capturing stdout."""
    saved = sys.argv
    sys.argv = ["injection_budget_rail.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = rail.main()
    finally:
        sys.argv = saved
    return rc, buf.getvalue()


def test_validate_caps_rejects_negative_max_items():
    # second cap branch: max_items < 0 -> invalid_cap (line 74-77 path).
    try:
        rail.apply_injection_budget(_items(1), [10], max_tokens=500, max_items=-1)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
        assert "max_items" in exc.message
    else:
        raise AssertionError("expected InjectionBudgetError for negative max_items")


def test_validate_caps_rejects_bool_max_tokens():
    # bool is an int subclass; must be rejected as a cap, not treated as 1/0.
    try:
        rail.apply_injection_budget(_items(1), [10], max_tokens=True, max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
        assert "max_tokens" in exc.message
    else:
        raise AssertionError("expected InjectionBudgetError for bool max_tokens")


def test_validate_caps_rejects_bool_max_items():
    try:
        rail.apply_injection_budget(_items(1), [10], max_tokens=500, max_items=True)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
        assert "max_items" in exc.message
    else:
        raise AssertionError("expected InjectionBudgetError for bool max_items")


def test_validate_caps_rejects_non_int_max_tokens():
    try:
        rail.apply_injection_budget(_items(1), [10], max_tokens="500", max_items=5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
    else:
        raise AssertionError("expected InjectionBudgetError for non-int max_tokens")


def test_normalize_token_count_none_and_unknown_return_none():
    # genuinely-unknown counts normalize to None (adoption-blocking, not a crash).
    assert rail._normalize_token_count(None) is None
    assert rail._normalize_token_count("unknown") is None


def test_normalize_token_count_valid_int_passthrough():
    assert rail._normalize_token_count(0) == 0
    assert rail._normalize_token_count(42) == 42


def test_normalize_token_count_bool_raises():
    try:
        rail._normalize_token_count(True)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_token_count"
    else:
        raise AssertionError("expected InjectionBudgetError for bool count")


def test_normalize_token_count_non_int_raises():
    try:
        rail._normalize_token_count(3.5)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_token_count"
    else:
        raise AssertionError("expected InjectionBudgetError for float count")


def test_normalize_token_count_negative_raises():
    try:
        rail._normalize_token_count(-1)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_token_count"
    else:
        raise AssertionError("expected InjectionBudgetError for negative count")


def test_unknown_token_admitted_with_unknown_contribution():
    # The unknown item is admitted-with-unknown (measurement complete) and forces the
    # adoption-blocking status; total_admitted_tokens counts only the known contributions.
    res = rail.apply_injection_budget(
        _items(3), [100, "unknown", 100], max_tokens=500, max_items=5
    )
    assert res["budget_status"] == "unknown_tokens_block_adoption"
    contribs = {a["rank_index"]: a.get("token_contribution") for a in res["admitted_items"]}
    assert contribs == {0: 100, 1: "unknown", 2: 100}
    assert res["total_admitted_tokens"] == 200


def test_as_marker_shape_is_metadata_only_error_envelope():
    # InjectionBudgetError.as_marker() emits the typed metadata-only error envelope.
    exc = rail.InjectionBudgetError("missing_input", "no such file")
    marker = exc.as_marker()
    assert marker["schema"] == "agent-runtime-injection-budget-rail"
    assert marker["schema_version"] == "0.1"
    assert marker["redaction"] == "metadata-only"
    assert marker["error_type"] == "missing_input"
    assert marker["_error"] == "no such file"
    assert marker["budget_status"] == "error"


def test_coerce_cap_parses_plain_and_human_number():
    assert rail._coerce_cap("500", rail.DEFAULT_MAX_TOKENS) == 500
    assert rail._coerce_cap("1K", rail.DEFAULT_MAX_TOKENS) == 1000


def test_coerce_cap_unparseable_raises():
    # parse_human_number returns an _error dict -> invalid_cap (line 217-218).
    try:
        rail._coerce_cap("notanumber", rail.DEFAULT_MAX_TOKENS)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
    else:
        raise AssertionError("expected InjectionBudgetError for unparseable cap")


def test_coerce_cap_non_integral_float_raises():
    # "1.5" parses to a non-integral float -> must be rejected (line 219-221).
    try:
        rail._coerce_cap("1.5", rail.DEFAULT_MAX_TOKENS)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
        assert "integral" in exc.message
    else:
        raise AssertionError("expected InjectionBudgetError for non-integral cap")


def test_coerce_cap_negative_raises():
    # "-3" parses to int -3 -> non-negative check fires (line 223-224).
    try:
        rail._coerce_cap("-3", rail.DEFAULT_MAX_TOKENS)
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "invalid_cap"
        assert "non-negative" in exc.message
    else:
        raise AssertionError("expected InjectionBudgetError for negative cap")


def test_load_items_artifact_missing_file_raises():
    try:
        rail._load_items_artifact(Path("/nonexistent-xyz-abc/items.json"))
    except rail.InjectionBudgetError as exc:
        assert exc.error_type == "missing_input"
    else:
        raise AssertionError("expected InjectionBudgetError for missing artifact")


def test_missing_artifact_error_has_no_raw_path_only_hash():
    # H4: the missing_input _error marker must NOT leak the raw absolute path; a sha256_16
    # hash stands in for the path instead.
    from probelib import sha256_16
    path = Path("/Users/secretuser/private/items/leak-me.json")
    try:
        rail._load_items_artifact(path)
    except rail.InjectionBudgetError as exc:
        marker = exc.as_marker()
        msg = marker["_error"]
        assert "/Users/" not in msg
        assert str(path) not in msg
        assert sha256_16(str(path)) in msg
    else:
        raise AssertionError("expected InjectionBudgetError for missing artifact")


def test_load_items_artifact_non_dict_raises():
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "list.json"
        artifact.write_text(json.dumps([1, 2, 3]))  # JSON array, not object
        try:
            rail._load_items_artifact(artifact)
        except rail.InjectionBudgetError as exc:
            assert exc.error_type == "malformed_input"
        else:
            raise AssertionError("expected InjectionBudgetError for non-dict artifact")


def test_load_items_artifact_error_marker_raises():
    # Invalid JSON -> load_json returns an _error marker -> malformed_input (line 243-244).
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "bad.json"
        artifact.write_text("{not valid json")
        try:
            rail._load_items_artifact(artifact)
        except rail.InjectionBudgetError as exc:
            assert exc.error_type == "malformed_input"
        else:
            raise AssertionError("expected InjectionBudgetError for _error marker")


def test_load_items_artifact_non_list_fields_raises():
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "shape.json"
        artifact.write_text(json.dumps({"items": "nope", "token_counts": []}))
        try:
            rail._load_items_artifact(artifact)
        except rail.InjectionBudgetError as exc:
            assert exc.error_type == "malformed_input"
        else:
            raise AssertionError("expected InjectionBudgetError for non-list fields")


def test_load_items_artifact_valid_returns_parallel_lists():
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "ok.json"
        artifact.write_text(json.dumps({"items": [{"id": 0}], "token_counts": [7]}))
        items, counts = rail._load_items_artifact(artifact)
        assert items == [{"id": 0}] and counts == [7]


def test_main_in_process_success_within_budget():
    # In-process main() success path (covers argparse + build_report + json.dump + return 0).
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "items.json"
        artifact.write_text(json.dumps({
            "items": [{"id": i} for i in range(3)],
            "token_counts": [50, 50, 50],
        }))
        rc, out = _run_main(["--items-artifact", str(artifact),
                             "--max-tokens", "500", "--max-items", "5"])
        assert rc == 0
        report = json.loads(out)
        assert report["budget_status"] == "within_budget"
        assert report["admitted_count"] == 3


def test_main_in_process_pretty_flag_token_capped():
    with tempfile.TemporaryDirectory() as tmp:
        artifact = Path(tmp) / "items.json"
        artifact.write_text(json.dumps({
            "items": [{"id": i} for i in range(4)],
            "token_counts": [200, 200, 200, 200],
        }))
        rc, out = _run_main(["--items-artifact", str(artifact),
                             "--max-tokens", "500", "--pretty"])
        assert rc == 0
        assert "\n  " in out  # pretty (indent=2) emitted
        report = json.loads(out)
        assert report["budget_status"] == "token_capped"


def test_main_in_process_error_path_returns_one():
    # UNHAPPY: main() InjectionBudgetError branch -> error marker + return 1 (lines 272-277).
    rc, out = _run_main(["--items-artifact", "/nonexistent-xyz-abc/items.json"])
    assert rc == 1
    report = json.loads(out)
    assert report["error_type"] == "missing_input"
    assert report["budget_status"] == "error"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} injection_budget_rail tests passed")
