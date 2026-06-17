#!/usr/bin/env python3
"""Tests for pipeline_telemetry: token_account proof classes, record_mutation claim
backing + raw-content rejection, summarize aggregation, determinism, and CLI e2e.

No-install: pure stdlib; the CLI entrypoint test runs the probe as a real subprocess to
cover the `__main__` path.
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

import pipeline_telemetry as pt  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "pipeline_telemetry.py"


# ---------------------------------------------------------------------------
# (1) token_account provider-truth path -> measured delta
# ---------------------------------------------------------------------------
def test_token_account_provider_truth_is_measured():
    acct = pt.token_account(
        usage_before={"input_tokens": 1000},
        usage_after={"input_tokens": 1200},
        before_text="ignored when usage present",
        after_text="ignored when usage present",
    )
    assert acct["proof_class"] == "measured"
    assert acct["tokens_before"] == 1000
    assert acct["tokens_after"] == 1200
    assert acct["token_delta"] == 200


# ---------------------------------------------------------------------------
# (2) token_account heuristic path -> labeled heuristic, NOT measured
# ---------------------------------------------------------------------------
def test_token_account_heuristic_path_is_labeled_not_measured():
    # 40 chars // 4 = 10 ; 20 chars // 4 = 5
    acct = pt.token_account(
        usage_before=None,
        usage_after=None,
        before_text="x" * 40,
        after_text="y" * 20,
    )
    assert acct["proof_class"] == "heuristic"
    assert acct["proof_class"] != "measured"
    assert acct["tokens_before"] == 10
    assert acct["tokens_after"] == 5
    assert acct["token_delta"] == -5


def test_token_account_one_side_measured_other_heuristic_is_heuristic():
    # measured before (provider-truth), heuristic after (text only) -> overall heuristic.
    acct = pt.token_account(
        usage_before={"input_tokens": 100},
        usage_after=None,
        before_text=None,
        after_text="z" * 40,
    )
    assert acct["proof_class"] == "heuristic"
    assert acct["tokens_before"] == 100
    assert acct["tokens_after"] == 10
    assert acct["token_delta"] == -90


# ---------------------------------------------------------------------------
# (3) token_account neither usage nor text -> "unknown" not 0 (UNHAPPY)
# ---------------------------------------------------------------------------
def test_token_account_absent_is_unknown_not_zero():
    acct = pt.token_account(
        usage_before=None,
        usage_after=None,
        before_text=None,
        after_text=None,
    )
    # The load-bearing rule: a missing token figure is "unknown", NEVER a fabricated 0.
    assert acct["proof_class"] == "unknown"
    assert acct["tokens_before"] == "unknown"
    assert acct["tokens_after"] == "unknown"
    assert acct["token_delta"] == "unknown"
    assert acct["token_delta"] != 0


def test_token_account_invalid_usage_value_falls_back_unknown():
    # A non-int input_tokens is treated as absent -> with no text, the side is unknown.
    acct = pt.token_account(
        usage_before={"input_tokens": "not-a-number"},
        usage_after={"input_tokens": "also-bad"},
        before_text=None,
        after_text=None,
    )
    assert acct["proof_class"] == "unknown"
    assert acct["tokens_before"] == "unknown"


# ---------------------------------------------------------------------------
# (4) record_mutation: claim with no evidence_ref -> claim_backed=False; with -> True
# ---------------------------------------------------------------------------
def test_record_mutation_claim_without_evidence_is_unbacked():
    rec = pt.record_mutation(
        step="compress",
        plane="reducer",
        mutation_class="compression",
        before_text="a" * 400,
        after_text="a" * 100,
        claim="reduced prompt by 75%",
        evidence_ref=None,
    )
    assert rec["claim_backed"] is False
    assert rec["claim"] == "reduced prompt by 75%"
    assert rec["plane"] == "reducer"


def test_record_mutation_claim_with_evidence_is_backed():
    rec = pt.record_mutation(
        step="compress",
        plane="reducer",
        mutation_class="compression",
        before_text="a" * 400,
        after_text="a" * 100,
        claim="reduced prompt by 75%",
        evidence_ref="reducer_canary_corpus#run-42",
    )
    assert rec["claim_backed"] is True
    assert rec["evidence_ref"] == "reducer_canary_corpus#run-42"


def test_record_mutation_emits_no_raw_text_only_hashes():
    rec = pt.record_mutation(
        step="mask",
        plane="enricher",
        mutation_class="sanitize",
        before_text="secret content here",
        after_text="__CAPE_x_TOKEN_1__",
    )
    # Never the raw text — only hashes + counts.
    assert "before_text" not in rec
    assert "after_text" not in rec
    assert rec["before_sha256_16"] == pt.sha256_16("secret content here")
    assert rec["byte_before"] == len("secret content here".encode("utf-8"))
    assert rec["reversible"] is False


def test_record_mutation_class_is_redacted_like_other_free_text_fields():
    # I3: mutation_class is caller-controlled free text; a secret-shaped value must be scrubbed by
    # redact() (consistent with step/claim), and a clean class label must pass through unchanged.
    leaky = pt.record_mutation(
        step="mask", plane="enricher",
        mutation_class="ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", before_text="x", after_text="y")
    assert "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" not in json.dumps(leaky)
    clean = pt.record_mutation(step="mask", plane="enricher", mutation_class="compression",
                               before_text="x", after_text="y")
    assert clean["mutation_class"] == "compression"


def test_record_mutation_reversible_handle_sets_reversible():
    rec = pt.record_mutation(
        step="mask",
        plane="enricher",
        mutation_class="sanitize",
        before_text="x",
        after_text="y",
        reversible_handle="swapmap#session-7",
    )
    assert rec["reversible"] is True
    assert rec["reversible_handle"] == "swapmap#session-7"


def test_record_mutation_unknown_plane_folds_to_unknown():
    rec = pt.record_mutation(
        step="weird",
        plane="not-a-real-plane",
        mutation_class="x",
    )
    assert rec["plane"] == "unknown"


# ---------------------------------------------------------------------------
# (5) mutation_summary with a raw-content-shaped value -> typed reject (UNHAPPY)
# ---------------------------------------------------------------------------
def test_mutation_summary_long_string_is_rejected():
    raised = False
    try:
        pt.record_mutation(
            step="enrich",
            plane="enricher",
            mutation_class="inject",
            mutation_summary={"snippet": "Q" * 200},  # > 120 chars: looks like raw content
        )
    except pt.RawContentInSummaryError:
        raised = True
    assert raised, "long-string summary value must raise RawContentInSummaryError"


def test_mutation_summary_newline_is_rejected():
    raised = False
    try:
        pt.record_mutation(
            step="enrich",
            plane="enricher",
            mutation_class="inject",
            mutation_summary={"blob": "line one\nline two"},
        )
    except pt.RawContentInSummaryError:
        raised = True
    assert raised, "newline-bearing summary value is invalid (raw content)"


def test_mutation_summary_path_shape_is_rejected():
    raised = False
    try:
        pt.record_mutation(
            step="enrich",
            plane="enricher",
            mutation_class="inject",
            mutation_summary={"src": "/Users/testuser/secret/file"},
        )
    except pt.RawContentInSummaryError:
        raised = True
    assert raised, "filesystem path shape in summary is invalid (raw content)"


def test_mutation_summary_secret_shape_is_rejected():
    raised = False
    try:
        pt.record_mutation(
            step="enrich",
            plane="enricher",
            mutation_class="inject",
            mutation_summary={"leak": "sk-ABCDEFGH12345678"},
        )
    except pt.RawContentInSummaryError:
        raised = True
    assert raised, "secret shape in summary is invalid (raw content)"


def test_mutation_summary_nested_raw_content_is_rejected():
    raised = False
    try:
        pt.record_mutation(
            step="enrich",
            plane="enricher",
            mutation_class="inject",
            mutation_summary={"fields": ["ok", {"deep": "z" * 200}]},
        )
    except pt.RawContentInSummaryError:
        raised = True
    assert raised, "nested raw-content value must still be rejected"


def test_mutation_summary_non_dict_is_rejected():
    raised = False
    try:
        pt.validate_mutation_summary("not-a-dict")  # type: ignore[arg-type]
    except pt.RawContentInSummaryError:
        raised = True
    assert raised, "non-dict mutation_summary is an invalid (malformed) input"


def test_mutation_summary_metadata_is_accepted():
    # Short labels, ints, counts, bool, None -> all metadata-safe (pass validation).
    rec = pt.record_mutation(
        step="enrich",
        plane="enricher",
        mutation_class="inject",
        mutation_summary={
            "injected_fields": 3,
            "kind": "memory",
            "deterministic": True,
            "note": None,
            "entity_histogram": {"TOKEN": 2, "PATH": 1},
        },
    )
    assert rec["mutation_summary"]["injected_fields"] == 3
    # Defense-in-depth: probelib.redact still scrubs values under a sensitive KEY name
    # ("TOKEN" matches the token-key rule) even after validation — the count is masked,
    # the structure preserved. A non-sensitive key keeps its count.
    assert rec["mutation_summary"]["entity_histogram"]["PATH"] == 1
    assert rec["mutation_summary"]["entity_histogram"]["TOKEN"] == "<redacted>"


# ---------------------------------------------------------------------------
# (6) summarize aggregates tokens, lists unbacked_claims, computes fractions
# ---------------------------------------------------------------------------
def _multi_step_records():
    return [
        pt.record_mutation(
            step="mask",
            plane="enricher",
            mutation_class="sanitize",
            usage_before={"input_tokens": 1000},
            usage_after={"input_tokens": 1010},
            claim="masked 4 secrets",
            evidence_ref="prompt_sanitizer#report",
            reversible_handle="swapmap#1",
        ),
        pt.record_mutation(
            step="compress",
            plane="reducer",
            mutation_class="compression",
            usage_before={"input_tokens": 1010},
            usage_after={"input_tokens": 400},
            claim="reduced 60%",  # NO evidence_ref -> unbacked
        ),
        pt.record_mutation(
            step="enrich",
            plane="enricher",
            mutation_class="inject",
            before_text="z" * 80,  # heuristic: no usage
            after_text="z" * 120,
            claim="enriched memory",
            evidence_ref="enricher_lift_gate#run",
            reversible_handle="diff#2",
        ),
        pt.record_mutation(
            step="opaque",
            plane="governance",
            mutation_class="audit",  # no usage, no text -> unknown tokens
        ),
    ]


def test_summarize_aggregates_tokens_and_flags_unbacked():
    report = pt.summarize(_multi_step_records())
    assert report["step_count"] == 4

    # tokens-in/out sum the measured + heuristic numeric sides (unknown step excluded).
    # measured: 1000+1010 ; heuristic: 20 -> in = 2030 ; out = 1010+400+30 = 1440
    assert report["total_tokens_in"] == 1000 + 1010 + 20
    assert report["total_tokens_out"] == 1010 + 400 + 30
    assert report["net_token_delta"] == 10 + (-610) + 10

    # the load-bearing audit signal: the un-evidenced compress claim is listed.
    unbacked_steps = {u["step"] for u in report["unbacked_claims"]}
    assert "compress" in unbacked_steps
    assert "mask" not in unbacked_steps
    assert "enrich" not in unbacked_steps

    # per-plane deltas present for known planes.
    assert "reducer" in report["per_plane"]
    assert report["per_plane"]["reducer"]["token_delta"] == -610
    assert report["per_plane"]["enricher"]["step_count"] == 2

    # fractions: 1 of 4 steps heuristic ; 2 of 4 reversible (mask + enrich carry handles).
    assert report["heuristic_token_fraction"] == 0.25
    assert report["reversibility_coverage"] == 0.5
    assert report["unknown_token_steps"] == 1
    assert report["proof_class_rollup"]["measured"] == 2
    assert report["proof_class_rollup"]["heuristic"] == 1
    assert report["proof_class_rollup"]["unknown"] == 1

    # I2: the "opaque" step has unknown tokens, so the totals are a PARTIAL sum and must self-label it.
    assert report["token_totals_complete"] is False


def test_summarize_token_totals_complete_when_every_step_known():
    # all steps carry numeric token counts -> the totals cover every step
    recs = [
        pt.record_mutation(step="mask", plane="enricher", mutation_class="sanitize",
                           usage_before={"input_tokens": 100}, usage_after={"input_tokens": 90}),
        pt.record_mutation(step="compress", plane="reducer", mutation_class="compression",
                           usage_before={"input_tokens": 90}, usage_after={"input_tokens": 50}),
    ]
    report = pt.summarize(recs)
    assert report["unknown_token_steps"] == 0
    assert report["token_totals_complete"] is True
    # and an empty pipeline is NOT complete (no data to total)
    assert pt.summarize([])["token_totals_complete"] is False


def test_summarize_all_unknown_tokens_reports_unknown_not_zero():
    # UNHAPPY: a pipeline of only unknown-token steps must not sum to a misleading 0.
    recs = [
        pt.record_mutation(step="a", plane="substrate", mutation_class="x"),
        pt.record_mutation(step="b", plane="substrate", mutation_class="y"),
    ]
    report = pt.summarize(recs)
    assert report["total_tokens_in"] == "unknown"
    assert report["total_tokens_out"] == "unknown"
    assert report["net_token_delta"] == "unknown"
    assert report["per_plane"]["substrate"]["token_delta"] == "unknown"
    assert report["unknown_token_steps"] == 2


def test_summarize_empty_records_is_safe():
    report = pt.summarize([])
    assert report["step_count"] == 0
    assert report["reversibility_coverage"] == 0.0
    assert report["heuristic_token_fraction"] == 0.0
    assert report["unbacked_claims"] == []


# ---------------------------------------------------------------------------
# (7) determinism
# ---------------------------------------------------------------------------
def test_record_mutation_is_deterministic():
    kwargs = dict(
        step="mask",
        plane="enricher",
        mutation_class="sanitize",
        before_text="hello world",
        after_text="masked",
        claim="masked 1",
        evidence_ref="ref#1",
        mutation_summary={"n": 1},
        reversible_handle="h#1",
    )
    a = pt.record_mutation(**kwargs)
    b = pt.record_mutation(**kwargs)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_summarize_is_deterministic():
    recs = _multi_step_records()
    a = pt.summarize(recs)
    b = pt.summarize(recs)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


# ---------------------------------------------------------------------------
# (8) CLI e2e subprocess on a records.jsonl fixture
# ---------------------------------------------------------------------------
def test_cli_e2e_on_records_jsonl(tmp_path=None):
    records = _multi_step_records()
    with tempfile.TemporaryDirectory() as d:
        records_file = Path(d) / "records.jsonl"
        records_file.write_text(
            "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8"
        )
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--records", str(records_file), "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["schema"] == "agent-runtime-cape-pipeline-telemetry"
        assert report["step_count"] == 4
        assert any(u["step"] == "compress" for u in report["unbacked_claims"])


def test_cli_missing_records_file_exits_nonzero():
    # UNHAPPY: a missing input must fail closed (nonzero exit + typed error marker).
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--records", "/nonexistent-xyz/records.jsonl"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 1
    report = json.loads(proc.stdout)
    assert report["error_type"] == "missing_input"
    assert "_error" in report


def test_cli_malformed_jsonl_exits_nonzero():
    # UNHAPPY: a malformed JSONL line must fail closed, not silently skip.
    with tempfile.TemporaryDirectory() as d:
        bad = Path(d) / "bad.jsonl"
        bad.write_text("{not valid json\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--records", str(bad)],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 1
        report = json.loads(proc.stdout)
        assert report["error_type"] == "malformed_input"


def test_main_function_direct_invocation(monkeypatch=None):
    # Cover main() in-process (argv-driven) for the happy path.
    with tempfile.TemporaryDirectory() as d:
        records_file = Path(d) / "r.jsonl"
        records_file.write_text(
            json.dumps(pt.record_mutation(step="s", plane="substrate", mutation_class="m")) + "\n",
            encoding="utf-8",
        )
        argv_backup = sys.argv
        sys.argv = ["pipeline_telemetry.py", "--records", str(records_file)]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = pt.main()
        finally:
            sys.argv = argv_backup
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["step_count"] == 1


def test_main_function_missing_input_returns_one():
    argv_backup = sys.argv
    sys.argv = ["pipeline_telemetry.py", "--records", "/nonexistent-abc/none.jsonl"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = pt.main()
    finally:
        sys.argv = argv_backup
    assert rc == 1
    report = json.loads(buf.getvalue())
    assert report["error_type"] == "missing_input"


# ---------------------------------------------------------------------------
# Branch coverage: in-process exercises of helper/error paths
# ---------------------------------------------------------------------------
def test_usage_input_tokens_present_none_is_none():
    # input_tokens key present but explicitly None -> treated as absent (not 0).
    assert pt._usage_input_tokens({"input_tokens": None}) is None
    # key absent entirely -> None.
    assert pt._usage_input_tokens({}) is None
    # non-dict -> None.
    assert pt._usage_input_tokens(None) is None


def test_validate_summary_list_branch_accepts_safe_list():
    # The list branch of _validate_summary_value: a list of safe scalars validates fine.
    out = pt.validate_mutation_summary({"items": ["short", 1, True, None]})
    assert out["items"] == ["short", 1, True, None]


def test_summarize_folds_unknown_plane_from_raw_record():
    # A raw record dict carrying an out-of-vocab plane folds to "unknown" in summarize.
    raw = {
        "step": "x",
        "plane": "bogus-plane",
        "mutation_class": "m",
        "tokens_before": "unknown",
        "tokens_after": "unknown",
        "token_delta": "unknown",
        "token_proof_class": "unknown",
        "claim": "",
        "claim_backed": False,
        "reversible": False,
        "byte_delta": "unknown",
    }
    report = pt.summarize([raw])
    assert "unknown" in report["per_plane"]
    assert report["per_step"][0]["plane"] == "unknown"


def test_load_records_read_error_is_typed(monkeypatch=None):
    # UNHAPPY: an OSError on read -> typed read_error marker (fail closed, not silent []).
    import tempfile as _tf
    with _tf.TemporaryDirectory() as d:
        p = Path(d) / "r.jsonl"
        p.write_text("{}\n", encoding="utf-8")
        orig = Path.read_text

        def boom(self, *a, **k):
            if self == p:
                raise OSError("simulated read failure")
            return orig(self, *a, **k)

        Path.read_text = boom
        try:
            records, err = pt._load_records(p)
        finally:
            Path.read_text = orig
        assert records is None
        assert err["error_type"] == "read_error"
        assert "_error" in err


def test_load_records_malformed_line_is_typed():
    # UNHAPPY: a malformed JSONL line -> typed malformed_input (in-process).
    import tempfile as _tf
    with _tf.TemporaryDirectory() as d:
        p = Path(d) / "bad.jsonl"
        p.write_text("{ broken\n", encoding="utf-8")
        records, err = pt._load_records(p)
        assert records is None
        assert err["error_type"] == "malformed_input"


def test_load_records_non_object_line_is_typed():
    # UNHAPPY: a valid-JSON but non-object line (an array) -> typed malformed_input.
    import tempfile as _tf
    with _tf.TemporaryDirectory() as d:
        p = Path(d) / "arr.jsonl"
        p.write_text("[1, 2, 3]\n", encoding="utf-8")
        records, err = pt._load_records(p)
        assert records is None
        assert err["error_type"] == "malformed_input"


def test_load_records_skips_blank_lines():
    import tempfile as _tf
    with _tf.TemporaryDirectory() as d:
        p = Path(d) / "r.jsonl"
        rec = pt.record_mutation(step="s", plane="substrate", mutation_class="m")
        p.write_text("\n" + json.dumps(rec) + "\n\n", encoding="utf-8")
        records, err = pt._load_records(p)
        assert err is None
        assert len(records) == 1


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} pipeline_telemetry tests passed")
