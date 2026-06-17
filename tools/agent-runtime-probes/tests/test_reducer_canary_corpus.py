#!/usr/bin/env python3
"""Tests for reducer_canary_corpus (B2 reducer canary corpus — pre-reducer safety gate).

No pytest fixtures: manual setattr + try/finally, tempfile.TemporaryDirectory for every
B1 store (never writing outside it). The standalone __main__ runner prints PASS <name>.

Load-bearing proofs asserted here:
  - identity reducer       -> canary PASS (lossless passthrough, anchors survive, no leak).
  - corrupting reducer     -> canary FAIL (drops a load-bearing line -> required_anchor_lost).
                              THIS is the proof the gate detects silent corruption.
  - handle_backed reducer  -> canary PASS via byte-identical B1 restore (anchors recoverable
                              from the handle even though the reduced view drops them).
  - UNHAPPY: reducer raises -> fail-closed; reducer returns non-str -> typed error + fail;
             malformed fixture (no anchors / anchor absent in raw) -> typed error + fail;
             handle-backed reducer whose handle does not restore -> fail.
  - DETERMINISM: two runs over identical input -> byte-identical report (sans ts; none present).
  - REDACTION: no synthetic secret ever appears in the emitted report.
  - CLI e2e over a real subprocess.
"""
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import reducer_canary_corpus as probe  # noqa: E402
import raw_output_handle_protocol as b1  # noqa: E402
from compaction_survival_canary import Anchor, ForbiddenPattern  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "reducer_canary_corpus.py"

# Every synthetic secret embedded in the default corpus. None may ever leak into a report.
SYNTHETIC_SECRETS = [
    "re_synthetic_secret_0001",
    "ghp_syntheticSecret0123456789abcdefABCDEF",
    "Bearer synthetictoken0123456789abcdef",
    "pcsk_synthetic_pw_9999",
    "sk-syntheticAnomaly0123456789",
    "xoxb-synthetic-1234567890-slacktoken",
]


# --------------------------------------------------------------------------------------
# Load-bearing reference-reducer proofs (identity / corrupting / handle_backed).
# --------------------------------------------------------------------------------------

def test_identity_reducer_passes_every_fixture():
    report = probe.build_report(probe.identity_reducer, "identity")
    assert report["summary"]["verdict"] == "pass"
    assert report["summary"]["fail_count"] == 0
    assert report["summary"]["pass_count"] == len(probe.default_corpus())
    # identity is a lossless passthrough on every fixture: that is exactly why it passes.
    assert report["summary"]["lossless_passthrough_count"] == report["summary"]["fixture_count"]
    for row in report["fixtures"]:
        assert row["verdict"] == "pass", row
        assert row["fail_reasons"] == []


def test_corrupting_reducer_fails_canary_required_anchor_lost():
    # THE load-bearing proof: a reducer that drops a load-bearing line MUST fail the canary.
    report = probe.build_report(probe.corrupting_reducer, "corrupting")
    assert report["summary"]["verdict"] == "fail"
    assert report["summary"]["fail_count"] == len(probe.default_corpus())
    # The corruption is detected as a lost required anchor on every fixture.
    assert report["summary"]["fail_reason_counts"].get("required_anchor_lost") == report["summary"]["fixture_count"]
    for row in report["fixtures"]:
        assert row["verdict"] == "fail", row
        assert "required_anchor_lost" in row["fail_reasons"]
        # A genuine lossy transform occurred (not a passthrough) — so the gate can blame it.
        assert row["lossless_passthrough"] is False


def test_handle_backed_reducer_passes_via_byte_identical_restore():
    with TemporaryDirectory() as d:
        reducer = probe.make_handle_backed_reducer(d)
        report = probe.build_report(reducer, "handle_backed", store_dir=Path(d))
        assert report["summary"]["verdict"] == "pass"
        assert report["summary"]["pass_count"] == report["summary"]["fixture_count"]
        # Every fixture's anchors fell off the lossy reduced view but were recovered via handle.
        assert report["summary"]["survived_via_handle_count"] == report["summary"]["fixture_count"]
        assert report["summary"]["restore_byte_identical_count"] == report["summary"]["fixture_count"]
        for row in report["fixtures"]:
            assert row["verdict"] == "pass", row
            assert row["restore_status"] == "byte_identical"
            assert row["handle_present"] is True
            assert row["survived_via_handle"] is True


def test_handle_backed_store_actually_restores_raw_byte_identical():
    # Independent proof of the B1 restore the canary relies on: retrieve(handle) == raw bytes.
    with TemporaryDirectory() as d:
        reducer = probe.make_handle_backed_reducer(d)
        for fx in probe.default_corpus():
            out = reducer(fx.raw_text)
            assert b1.valid_handle(out["handle"])
            assert b1.retrieve(out["handle"], d) == fx.raw_text.encode("utf-8")


# --------------------------------------------------------------------------------------
# UNHAPPY paths (fail-closed, typed, never silent).
# --------------------------------------------------------------------------------------

def test_reducer_that_raises_fails_closed_not_silent():
    def boom(_raw):
        raise RuntimeError("reducer exploded")
    report = probe.build_report(boom, "raising")
    assert report["summary"]["verdict"] == "fail"
    for row in report["fixtures"]:
        assert row["verdict"] == "fail"
        assert any(r.startswith("reducer_raised:") for r in row["fail_reasons"]), row["fail_reasons"]


def test_reducer_returning_non_string_yields_typed_error_and_fail():
    # A reducer returning a non-string `reduced` is a typed error, not a silent coercion.
    report = probe.build_report(lambda _raw: 12345, "non_string")
    assert report["summary"]["verdict"] == "fail"
    for row in report["fixtures"]:
        assert any(r.startswith("reducer_bad_result_type:") for r in row["fail_reasons"]), row["fail_reasons"]

    # Dict-with-non-string-reduced is the other non-str branch.
    report2 = probe.build_report(lambda _raw: {"reduced": 99}, "non_string_dict")
    for row in report2["fixtures"]:
        assert any(r.startswith("reducer_non_string_reduced:") for r in row["fail_reasons"]), row["fail_reasons"]


def test_reducer_returning_non_string_handle_yields_typed_error():
    report = probe.build_report(lambda raw: {"reduced": raw, "handle": 7}, "bad_handle_type")
    assert report["summary"]["verdict"] == "fail"
    for row in report["fixtures"]:
        assert any(r.startswith("reducer_non_string_handle:") for r in row["fail_reasons"]), row["fail_reasons"]


def test_malformed_fixture_no_required_anchors_fails_typed():
    # A fixture with zero load-bearing anchors cannot prove survival -> malformed (typed) fail.
    malformed = (
        probe.CorpusFixture(
            fixture_id="malformed_no_anchors",
            kind="synthetic_malformed",
            raw_text="some benign output line\n",
            required_anchors=(),
            forbidden_patterns=(),
        ),
    )
    report = probe.build_report(probe.identity_reducer, "identity", fixtures=malformed)
    assert report["summary"]["verdict"] == "fail"
    row = report["fixtures"][0]
    assert "malformed_fixture_no_required_anchors" in row["fail_reasons"]


def test_malformed_fixture_anchor_absent_in_raw_fails_typed():
    # An anchor whose pattern is not even present in the raw fixture is a malformed fixture.
    malformed = (
        probe.CorpusFixture(
            fixture_id="anchor_not_in_raw",
            kind="synthetic_malformed",
            raw_text="totally unrelated text\n",
            required_anchors=(Anchor("ghost", "state", (r"THIS_PATTERN_IS_ABSENT",)),),
            forbidden_patterns=(),
        ),
    )
    report = probe.build_report(probe.identity_reducer, "identity", fixtures=malformed)
    assert report["summary"]["verdict"] == "fail"
    assert "malformed_fixture_anchor_absent_in_raw" in report["fixtures"][0]["fail_reasons"]


def test_handle_backed_without_valid_restore_fails():
    # A reducer that emits a syntactically-valid but never-stored handle cannot restore -> fail.
    with TemporaryDirectory() as d:
        absent_handle = "0" * 64  # valid hex syntax, nothing stored under it

        def fake_handle_reducer(raw):
            first = raw.splitlines(keepends=True)
            return {"reduced": first[0] if first else "", "handle": absent_handle}

        report = probe.build_report(fake_handle_reducer, "fake_handle", store_dir=Path(d))
        assert report["summary"]["verdict"] == "fail"
        for row in report["fixtures"]:
            assert row["restore_status"] == "not_found"
            assert "handle_restore_failed" in row["fail_reasons"]
            # The anchors fell off the reduced view AND the handle did not restore -> lost.
            assert "required_anchor_lost" in row["fail_reasons"]


def test_forbidden_payload_survives_lossy_transform_fails():
    # A lossy reducer (not a passthrough) that retains a secret in its reduced view -> leak fail.
    leaky = (
        probe.CorpusFixture(
            fixture_id="leaky",
            kind="synthetic_leak",
            raw_text="anchor line keep me\nsecret sk-syntheticLeak0123456789 here\n",
            required_anchors=(Anchor("keep", "state", (r"anchor line keep me",)),),
            forbidden_patterns=(ForbiddenPattern("leak", r"sk-syntheticLeak0123456789"),),
        ),
    )

    def lossy_keep_secret(raw):
        # Drop the anchor line (so reduced != raw) but RETAIN the secret line -> a real leak.
        return "secret sk-syntheticLeak0123456789 here\n"

    report = probe.build_report(lossy_keep_secret, "lossy_leak", fixtures=leaky)
    row = report["fixtures"][0]
    assert row["verdict"] == "fail"
    assert "forbidden_payload_survived" in row["fail_reasons"]
    assert row["lossless_passthrough"] is False


def test_normalize_reducer_result_branches():
    # Direct unit coverage of the fail-closed normalizer.
    assert probe._normalize_reducer_result("x") == ("x", None, None)
    assert probe._normalize_reducer_result({"reduced": "y"}) == ("y", None, None)
    assert probe._normalize_reducer_result({"reduced": "y", "handle": "h"}) == ("y", "h", None)
    _, _, e1 = probe._normalize_reducer_result({"reduced": 1})
    assert e1 and e1.startswith("reducer_non_string_reduced:")
    _, _, e2 = probe._normalize_reducer_result({"reduced": "y", "handle": 2})
    assert e2 and e2.startswith("reducer_non_string_handle:")
    _, _, e3 = probe._normalize_reducer_result(42)
    assert e3 and e3.startswith("reducer_bad_result_type:")


def test_restore_status_branches():
    with TemporaryDirectory() as d:
        sd = Path(d)
        assert probe._restore_status(None, "raw", sd)["restore_status"] == "no_handle"
        assert probe._restore_status("h", "raw", None)["restore_status"] == "no_store_dir"
        assert probe._restore_status("not-hex", "raw", sd)["restore_status"] == "invalid_handle"
        absent = "0" * 64
        assert probe._restore_status(absent, "raw", sd)["restore_status"] == "not_found"
        handle = b1.store("byte-perfect raw\n", sd)
        ok = probe._restore_status(handle, "byte-perfect raw\n", sd)
        assert ok["restore_status"] == "byte_identical"
        mism = probe._restore_status(handle, "different raw\n", sd)
        assert mism["restore_status"] == "restore_mismatch"


def test_restore_status_store_error_branch():
    # Force b1.retrieve to raise StoreError -> typed store_error restore status (fail-closed).
    with TemporaryDirectory() as d:
        sd = Path(d)
        handle = b1.store("x\n", sd)
        orig = b1.retrieve

        def raise_store(*a, **k):
            raise b1.StoreError("corrupt")
        probe.b1.retrieve = raise_store
        try:
            status = probe._restore_status(handle, "x\n", sd)
        finally:
            probe.b1.retrieve = orig
        assert status["restore_status"].startswith("store_error:")


# --------------------------------------------------------------------------------------
# DETERMINISM + REDACTION.
# --------------------------------------------------------------------------------------

def test_determinism_two_runs_identical_report():
    r1 = probe.build_report(probe.identity_reducer, "identity")
    r2 = probe.build_report(probe.identity_reducer, "identity")
    # No timestamp fields are present by design; the whole report is byte-identical.
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)
    assert "ts" not in r1 and "timestamp" not in r1


def test_report_never_leaks_synthetic_secrets():
    # Run the WORST case for leaks: identity passes raw straight through. The REPORT must still
    # contain no secret (raw/reduced bodies are suppressed; only metadata/hashes are emitted).
    report = probe.build_report(probe.identity_reducer, "identity")
    blob = json.dumps(report)
    for secret in SYNTHETIC_SECRETS:
        assert secret not in blob, f"secret leaked into report: {secret}"


def test_report_redaction_field_and_schema_present():
    report = probe.build_report(probe.identity_reducer, "identity")
    assert report["schema"] == "agent-runtime-reducer-canary-corpus"
    assert report["schema_version"] == "0.1"
    assert "redaction" in report and "metadata-only" in report["redaction"]
    # B2-TOTAL: must NOT claim total-session deltas.
    assert report["scope"] == "fixture_local_only"
    assert "B2-TOTAL" in report["redaction"]


# --------------------------------------------------------------------------------------
# CLI surface (main_argv default identity reducer + e2e subprocess).
# --------------------------------------------------------------------------------------

def test_main_argv_default_identity_passes_and_exits_zero():
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = probe.main_argv([])
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-reducer-canary-corpus"
    assert report["summary"]["verdict"] == "pass"
    assert report["reducer_id"] == "identity"


def test_main_argv_with_explicit_store_dir_pretty():
    with TemporaryDirectory() as d:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--store-dir", d, "--pretty"])
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["summary"]["verdict"] == "pass"


def test_main_wrapper_delegates_to_main_argv():
    orig = sys.argv
    sys.argv = ["reducer_canary_corpus.py"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig
    assert rc == 0
    assert json.loads(buf.getvalue())["summary"]["verdict"] == "pass"


def test_cli_e2e_subprocess_default_reducer():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-reducer-canary-corpus"
    assert report["summary"]["verdict"] == "pass"
    # No synthetic secret may appear on the CLI stdout either.
    for secret in SYNTHETIC_SECRETS:
        assert secret not in proc.stdout


def test_cli_e2e_subprocess_pretty_with_store_dir():
    with TemporaryDirectory() as d:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--store-dir", d, "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["reducer_id"] == "identity"


# --------------------------------------------------------------------------------------
# F2: --reducer flag selects the built-in reference reducer and STAMPS the actual reducer_id
# as a top-level field (a B3 sibling asserts canary reducer_id == intervention reducer_id).
# --------------------------------------------------------------------------------------

def test_resolve_reducer_maps_each_choice():
    # Total function over the CLI choice set; identity/corrupting are stateless, handle_backed
    # is store-dependent (built per-invocation).
    with TemporaryDirectory() as d:
        sd = Path(d)
        assert probe.resolve_reducer("identity", sd) is probe.identity_reducer
        assert probe.resolve_reducer("corrupting", sd) is probe.corrupting_reducer
        # handle_backed is a freshly built closure over the store dir, not a module singleton.
        hb = probe.resolve_reducer("handle_backed", sd)
        assert callable(hb)
        out = hb("first line\nsecond line\n")
        assert isinstance(out, dict) and "handle" in out


def test_resolve_reducer_rejects_unknown_id_fail_closed():
    # Defense in depth: even if argparse `choices` were bypassed, resolve_reducer is fail-closed
    # (raises) rather than silently defaulting to identity.
    with TemporaryDirectory() as d:
        try:
            probe.resolve_reducer("not_a_real_reducer", Path(d))
        except ValueError as exc:
            assert "unknown reducer_id" in str(exc)
        else:
            raise AssertionError("resolve_reducer should reject an unknown id")


def test_main_argv_reducer_identity_stamps_id_and_passes():
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = probe.main_argv(["--reducer", "identity"])
    assert rc == 0
    report = json.loads(buf.getvalue())
    # The stamped top-level reducer_id matches the selected reducer, and the verdict is pass.
    assert report["reducer_id"] == "identity"
    assert report["summary"]["verdict"] == "pass"


def test_main_argv_reducer_corrupting_stamps_id_and_fails():
    # F2 load-bearing: a real workflow CAN now run the corrupting reducer, so a downstream B3
    # "canary pass" gate is no longer vacuous. The stamped id proves which reducer was tested.
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = probe.main_argv(["--reducer", "corrupting"])
    # corrupting drops a load-bearing line on every fixture -> overall fail -> nonzero exit.
    assert rc == 2
    report = json.loads(buf.getvalue())
    assert report["reducer_id"] == "corrupting"
    assert report["summary"]["verdict"] == "fail"
    assert report["summary"]["fail_count"] == report["summary"]["fixture_count"]


def test_main_argv_reducer_handle_backed_stamps_id_and_passes():
    with TemporaryDirectory() as d:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--reducer", "handle_backed", "--store-dir", d])
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["reducer_id"] == "handle_backed"
        assert report["summary"]["verdict"] == "pass"
        assert report["summary"]["restore_byte_identical_count"] == report["summary"]["fixture_count"]


def test_cli_e2e_subprocess_reducer_corrupting_fails_nonzero():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--reducer", "corrupting"],
        capture_output=True, text=True, timeout=30,
    )
    # Real subprocess: --reducer corrupting -> nonzero exit, stamped id == "corrupting".
    assert proc.returncode == 2, proc.stderr
    report = json.loads(proc.stdout)
    assert report["reducer_id"] == "corrupting"
    assert report["summary"]["verdict"] == "fail"
    for secret in SYNTHETIC_SECRETS:
        assert secret not in proc.stdout


def test_main_argv_unknown_reducer_rejected_by_argparse():
    # Unknown --reducer values are rejected at the CLI boundary (argparse SystemExit), never
    # silently coerced to identity.
    try:
        probe.main_argv(["--reducer", "definitely_not_a_reducer"])
    except SystemExit as exc:
        assert exc.code != 0
    else:
        raise AssertionError("unknown --reducer value should have raised SystemExit")


# --------------------------------------------------------------------------------------
# F6: a lossless passthrough no longer SILENTLY excuses the forbidden-payload check. A
# non-identity reducer that passes a secret-bearing fixture through verbatim is stamped
# `forbidden_check="not_applicable_lossless"` (leak axis unproven), not a silent clean pass.
# --------------------------------------------------------------------------------------

def test_adaptive_passthrough_marks_secret_fixture_not_applicable_lossless():
    # An ADAPTIVE reducer: returns the secret-bearing fixture verbatim (passthrough) but genuinely
    # reduces every other fixture. The verbatim fixture must NOT silently pass on the leak axis;
    # it must carry forbidden_check="not_applicable_lossless" (suppression NOT proven by reduction).
    secret = "sk-syntheticAdaptive0123456789"
    secret_raw = "anchor keep me\nsecret " + secret + " here\n"
    secret_fx = probe.CorpusFixture(
        fixture_id="adaptive_secret",
        kind="synthetic_adaptive_leak",
        raw_text=secret_raw,
        required_anchors=(Anchor("keep", "state", (r"anchor keep me",)),),
        forbidden_patterns=(ForbiddenPattern("leak", secret),),
    )
    other_fx = probe.CorpusFixture(
        fixture_id="adaptive_other",
        kind="synthetic_adaptive_other",
        raw_text="OTHER anchor keep me\nbenign tail line\n",
        required_anchors=(Anchor("keep2", "state", (r"OTHER anchor keep me",)),),
        forbidden_patterns=(),
    )

    def adaptive(raw):
        # Pass the secret-bearing fixture through verbatim; reduce everything else (drop a line).
        if raw == secret_raw:
            return raw
        return raw.splitlines(keepends=True)[0]

    report = probe.build_report(adaptive, "adaptive", fixtures=(secret_fx, other_fx))
    rows = {row["fixture_ref"]: row for row in report["fixtures"]}

    secret_row = rows["adaptive_secret"]
    # The secret fixture was a verbatim passthrough -> leak axis UNPROVEN, explicitly stamped.
    assert secret_row["lossless_passthrough"] is True
    assert secret_row["forbidden_check"] == "not_applicable_lossless"
    # It is a NON-identity reducer, so the passthrough is NOT the trusted identity baseline.
    assert secret_row["forbidden_check_baseline_trusted"] is False
    # forbidden_payload_survived must NOT be silently asserted, nor silently cleared:
    assert "forbidden_payload_survived" not in secret_row["fail_reasons"]

    # The genuinely-reduced fixture went through the real forbidden check.
    other_row = rows["adaptive_other"]
    assert other_row["lossless_passthrough"] is False
    assert other_row["forbidden_check"] == "checked"


def test_identity_passthrough_is_baseline_trusted_lossless():
    # The identity baseline passthrough is the EXPECTED no-op: stamped not_applicable_lossless AND
    # marked baseline-trusted, distinguishing it from an unproven non-identity passthrough.
    report = probe.build_report(probe.identity_reducer, "identity")
    for row in report["fixtures"]:
        assert row["forbidden_check"] == "not_applicable_lossless"
        assert row["forbidden_check_baseline_trusted"] is True
    # Summary aggregates surface the leak-axis accounting.
    assert report["summary"]["forbidden_not_applicable_lossless_count"] == report["summary"]["fixture_count"]
    assert report["summary"]["forbidden_checked_count"] == 0


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} reducer_canary_corpus tests passed")
