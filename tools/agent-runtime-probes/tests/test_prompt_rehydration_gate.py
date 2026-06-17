#!/usr/bin/env python3
"""Tests for prompt_rehydration_gate (Bead 2.3): the safe masked-delegation round-trip.

Standalone runner (test_pi_presence_probe.py style; no pytest). Uses tempfile for the
B1 --store-dir. Adversarial fixtures cover the load-bearing B1-ORDERING + MASK-BIJECTION
assumptions: store-before-delegate ordering, mutated/dropped/hallucinated placeholders,
residual-leak rehydration, store-failure passthrough (delegate NEVER invoked), determinism,
and CLI e2e via subprocess.
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

import prompt_rehydration_gate as gate  # noqa: E402
import raw_output_handle_protocol as b1  # noqa: E402

GATE_PATH = Path(__file__).resolve().parent.parent / "prompt_rehydration_gate.py"

# A prompt carrying several distinct sensitive entities (path/repo/id) so masking produces
# multiple placeholders the integrity check can reason about. Chosen so prompt_sanitizer
# accepts it cleanly (no residual): the structural USER lookbehind ("user <name>") would
# otherwise re-fire on the trailing "_" of an adjacent placeholder, so we avoid that shape.
SENSITIVE_TEXT = (
    "Deploy from /Users/alice/agent-runtime-probes and repo origin/main "
    "with session 9f8e7d6c5b4a32109f8e7d6c5b4a3210."
)
SESSION_KEY = "cape-rehydration-test-key"


def _spans_session_key(text=SENSITIVE_TEXT, key=SESSION_KEY):
    return text, key


# ---------------------------------------------------------------------------
# (1) Clean round-trip with the default identity delegate.
# ---------------------------------------------------------------------------
def test_clean_roundtrip_identity_delegate_integrity_ok():
    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir)  # default identity delegate
    report = result["report"]
    assert report["integrity"] == "ok"
    assert report["fallback"] is None
    assert report["store_status"] == "stored"
    assert report["handle_present"] is True
    assert report["residual_clean"] is True
    # sent==returned placeholders for an identity delegate
    assert report["sent_placeholder_count"] == report["returned_placeholder_count"]
    assert report["sent_placeholder_count"] > 0
    # The caller-facing restored output is the byte-identical original.
    assert result["restored"] == text


def test_clean_roundtrip_restored_is_byte_identical_original():
    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir)
    assert isinstance(result["restored"], str)
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_clean_roundtrip_delegate_saw_masked_not_raw():
    # The delegate must receive MASKED text — no raw sensitive substring may reach it.
    seen = {}

    def spy_delegate(masked: str) -> str:
        seen["text"] = masked
        return masked

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir, delegate=spy_delegate)
    assert result["report"]["integrity"] == "ok"
    assert "/Users/alice" not in seen["text"]
    assert "origin/main" not in seen["text"]
    assert "__CAPE_" in seen["text"]


# ---------------------------------------------------------------------------
# (2) Mutated-placeholder delegate -> integrity violated + verbatim B1 fallback.
# ---------------------------------------------------------------------------
def test_mutated_placeholder_delegate_integrity_violated_b1_fallback():
    def mutating_delegate(masked: str) -> str:
        # Corrupt one placeholder token so the returned set no longer matches the sent set.
        return masked.replace("_PATH_1__", "_PATH_999__", 1)

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir, delegate=mutating_delegate)
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    # The restored output is recovered byte-identical from B1, NOT the corrupted delegate text.
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_dropped_placeholder_delegate_integrity_violated():
    def dropping_delegate(masked: str) -> str:
        # Drop a placeholder entirely (subset OK, but rehydrate must then fail/residual).
        import re
        return re.sub(r"__CAPE_[0-9a-f]+_PATH_\d+__", "", masked, count=1)

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir, delegate=dropping_delegate)
    report = result["report"]
    # A dropped placeholder is a subset of sent, so it passes the subset test, but the
    # rehydrated text differs from the original (an entity vanished). Integrity must still
    # be violated via the rehydration-equality check, with B1 fallback.
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_hallucinated_placeholder_delegate_integrity_violated():
    def hallucinating_delegate(masked: str) -> str:
        # Append a placeholder that was never sent (hallucination). It is NOT a subset.
        return masked + " __CAPE_deadbeefdeadbeef_TOKEN_1__"

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir, delegate=hallucinating_delegate)
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


# ---------------------------------------------------------------------------
# (3) Store failure -> delegate NEVER invoked + verbatim passthrough (B1-ORDERING).
# ---------------------------------------------------------------------------
def test_store_failure_delegate_never_invoked_verbatim_passthrough():
    # B1-ORDERING (load-bearing): if store() raises BEFORE masking/delegation, the worker
    # must NEVER see anything. A spy flag proves the delegate was not invoked. This is the
    # invalid/error unhappy path; a store_error must fail closed to verbatim passthrough.
    invoked = {"called": False}

    def spy_delegate(masked: str) -> str:
        invoked["called"] = True
        return masked

    orig_store = gate.store

    def failing_store(raw, store_dir):
        raise b1.StoreError("store_write_failed:simulated")

    gate.store = failing_store
    text, key = _spans_session_key()
    try:
        with tempfile.TemporaryDirectory() as store_dir:
            result = gate.run_gate(text, key, store_dir, delegate=spy_delegate)
    finally:
        gate.store = orig_store

    report = result["report"]
    assert invoked["called"] is False  # delegate NEVER invoked on store error
    assert report["store_status"] == "store_error"
    assert report["handle_present"] is False
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_passthrough"
    # Passthrough returns the original verbatim (we still hold it in memory pre-store).
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_missing_handle_on_retrieve_typed_violation():
    # A handle that points at a store with no file -> retrieve FileNotFoundError -> typed
    # violation. We force this by deleting the stored file before the integrity retrieve.
    def evil_delegate(masked: str) -> str:
        return masked.replace("_PATH_1__", "_PATH_999__", 1)  # force fallback -> retrieve

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        # Patch retrieve to simulate a missing/failed handle during fallback.
        orig_retrieve = gate.retrieve

        def missing_retrieve(handle, sd):
            raise FileNotFoundError(f"not_found:{handle}")

        gate.retrieve = missing_retrieve
        try:
            result = gate.run_gate(text, key, store_dir, delegate=evil_delegate)
        finally:
            gate.retrieve = orig_retrieve
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    # Recovery itself failed (missing handle) -> typed recovery error, restored is None.
    assert report["recovery_status"] == "retrieve_error"
    assert result["restored"] is None


# ---------------------------------------------------------------------------
# (4) Residual leak after rehydrate -> fallback even if placeholders matched.
# ---------------------------------------------------------------------------
def test_residual_leak_after_rehydrate_forces_fallback():
    # A delegate that injects a *fresh* sensitive shape (not via placeholder) so the
    # rehydrated output carries a residual the residual_scan catches. Even though the
    # original placeholders are an exact subset, a residual leak rejects the delegate output.
    def leaky_delegate(masked: str) -> str:
        return masked + " leaked /Users/eve/secret-path"

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir, delegate=leaky_delegate)
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["residual_clean"] is False
    assert report["fallback"] == "verbatim_b1"
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_invalid_session_key_typed_no_delegate():
    # An empty/invalid session key must fail closed BEFORE delegation (no mask possible).
    invoked = {"called": False}

    def spy_delegate(masked: str) -> str:
        invoked["called"] = True
        return masked

    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(SENSITIVE_TEXT, "   ", store_dir, delegate=spy_delegate)
    report = result["report"]
    assert invoked["called"] is False
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_passthrough"
    assert report["session_key_status"] == "invalid"
    assert result["restored"].encode("utf-8") == SENSITIVE_TEXT.encode("utf-8")


def test_sanitizer_rejected_artifact_forces_passthrough():
    # If the masker itself rejects the artifact (e.g. residual/collision -> masked is None),
    # the gate must not delegate; it falls back to verbatim passthrough (we hold the original).
    invoked = {"called": False}

    def spy_delegate(masked: str) -> str:
        invoked["called"] = True
        return masked

    orig_sanitize = gate.sanitize

    def rejecting_sanitize(text, key, patterns, **kw):
        return {
            "session_key_status": "ok",
            "masked": None,
            "swapmap": None,
            "report": {"accepted": False, "placeholder_collision": True},
        }

    gate.sanitize = rejecting_sanitize
    try:
        with tempfile.TemporaryDirectory() as store_dir:
            result = gate.run_gate(SENSITIVE_TEXT, SESSION_KEY, store_dir, delegate=spy_delegate)
    finally:
        gate.sanitize = orig_sanitize
    report = result["report"]
    # A rejected mask short-circuits BEFORE store(), so the original was never written to B1;
    # the only recoverable copy is the in-memory original -> verbatim_passthrough, not _b1.
    assert invoked["called"] is False
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_passthrough"
    assert report["store_status"] == "not_attempted"
    assert report["mask_status"] == "rejected"
    assert result["restored"].encode("utf-8") == SENSITIVE_TEXT.encode("utf-8")


def test_accepted_false_with_materialized_masked_swapmap_forces_passthrough():
    # The discriminating rejection case: the masker can set accepted=False while STILL
    # returning a non-None masked text and swapmap. prompt_sanitizer.sanitize does exactly
    # this on its production residual-leak and roundtrip-failure paths
    # (accepted = (not residual) and roundtrip_ok and (not collision); the masked/swapmap are
    # the real materialized values). The gate must honor accepted=False and short-circuit to
    # verbatim passthrough WITHOUT ever invoking the untrusted delegate — the rejection guard
    # is `masked is None OR swapmap is None OR not accepted`, and the load-bearing disjunct
    # HERE is `not accepted` (masked/swapmap are present). A guard that only rejected when
    # masked/swapmap were None would route a masker-REJECTED-but-materialized artifact straight
    # to the worker: a fail-open. (The sibling test above exercises the masked-is-None disjunct,
    # under which the rejection holds regardless of the `not accepted` term.)
    invoked = {"called": False}

    def spy_delegate(masked: str) -> str:
        invoked["called"] = True
        return masked

    orig_sanitize = gate.sanitize

    def rejecting_sanitize_with_output(text, key, patterns, **kw):
        # masked + swapmap PRESENT (non-None), but the masker did NOT accept the artifact.
        return {
            "session_key_status": "ok",
            "masked": "__CAPE_deadbeefdeadbeef_PATH_0__ ping",
            "swapmap": {"__CAPE_deadbeefdeadbeef_PATH_0__": "/Users/alice/x"},
            "report": {"accepted": False, "placeholder_collision": False},
        }

    gate.sanitize = rejecting_sanitize_with_output
    try:
        with tempfile.TemporaryDirectory() as store_dir:
            result = gate.run_gate(SENSITIVE_TEXT, SESSION_KEY, store_dir, delegate=spy_delegate)
    finally:
        gate.sanitize = orig_sanitize
    report = result["report"]
    # Load-bearing: the delegate must NEVER see a masker-rejected artifact.
    assert invoked["called"] is False, "delegate invoked on a masker-REJECTED artifact (fail-open)"
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_passthrough"
    assert report["store_status"] == "not_attempted"
    assert report["mask_status"] == "rejected"
    assert report["violation_reason"] == "mask_rejected"
    assert result["restored"].encode("utf-8") == SENSITIVE_TEXT.encode("utf-8")


# ---------------------------------------------------------------------------
# (5) Determinism: identical inputs produce identical metadata + restored bytes.
# ---------------------------------------------------------------------------
def test_determinism_identical_inputs_identical_report():
    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
        r1 = gate.run_gate(text, key, d1)
        r2 = gate.run_gate(text, key, d2)
    # Metadata-only report is identical across runs (handles are content-addressed -> equal).
    assert r1["report"] == r2["report"]
    assert r1["restored"] == r2["restored"]


# ---------------------------------------------------------------------------
# Report shape / redaction posture.
# ---------------------------------------------------------------------------
def test_report_is_metadata_only_no_raw_text():
    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir)
    report = result["report"]
    blob = json.dumps(report)
    assert report["schema"] == "agent-runtime-prompt-rehydration-gate"
    assert report["schema_version"] == "0.1"
    assert report["redaction"] == "metadata-only"
    # No raw sensitive substrings of the original may appear in the report.
    assert "/Users/alice" not in blob
    assert "origin/main" not in blob
    assert "__CAPE_" not in blob  # placeholder strings carry the nonce; keep them out of reports


def test_default_delegate_is_identity():
    assert gate.identity_delegate("xyz masked text") == "xyz masked text"


# ---------------------------------------------------------------------------
# (6) CLI e2e via subprocess.
# ---------------------------------------------------------------------------
def test_cli_e2e_clean_roundtrip(tmp_path_unused=None):
    with tempfile.TemporaryDirectory() as work:
        artifact = Path(work) / "prompt.txt"
        artifact.write_text(SENSITIVE_TEXT, encoding="utf-8")
        store_dir = Path(work) / "b1store"
        proc = subprocess.run(
            [sys.executable, str(GATE_PATH),
             "--text-artifact", str(artifact),
             "--session-key", SESSION_KEY,
             "--store-dir", str(store_dir),
             "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["schema"] == "agent-runtime-prompt-rehydration-gate"
        assert report["integrity"] == "ok"
        assert report["fallback"] is None
        assert report["handle_present"] is True
        # No raw sensitive substring leaks to stdout.
        assert "/Users/alice" not in proc.stdout


def test_cli_missing_artifact_typed_nonzero():
    with tempfile.TemporaryDirectory() as work:
        store_dir = Path(work) / "b1store"
        proc = subprocess.run(
            [sys.executable, str(GATE_PATH),
             "--text-artifact", str(Path(work) / "nope.txt"),
             "--session-key", SESSION_KEY,
             "--store-dir", str(store_dir)],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 1
        report = json.loads(proc.stdout)
        assert report["input_status"] == "missing"


def test_cli_invalid_session_key_nonzero():
    with tempfile.TemporaryDirectory() as work:
        artifact = Path(work) / "prompt.txt"
        artifact.write_text(SENSITIVE_TEXT, encoding="utf-8")
        store_dir = Path(work) / "b1store"
        proc = subprocess.run(
            [sys.executable, str(GATE_PATH),
             "--text-artifact", str(artifact),
             "--session-key", "",
             "--store-dir", str(store_dir)],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 1
        report = json.loads(proc.stdout)
        assert report["session_key_status"] == "invalid"
        assert report["fallback"] == "verbatim_passthrough"


def test_main_function_clean_via_capture():
    # Exercise main() in-process for the happy CLI path (covers json.dump + return 0).
    with tempfile.TemporaryDirectory() as work:
        artifact = Path(work) / "prompt.txt"
        artifact.write_text(SENSITIVE_TEXT, encoding="utf-8")
        store_dir = Path(work) / "b1store"
        argv = ["--text-artifact", str(artifact), "--session-key", SESSION_KEY,
                "--store-dir", str(store_dir)]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = gate.main_argv(argv)
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["integrity"] == "ok"


def test_cli_read_error_on_directory_artifact():
    # Passing a directory as --text-artifact triggers an OSError read path (typed read_error).
    with tempfile.TemporaryDirectory() as work:
        store_dir = Path(work) / "b1store"
        proc = subprocess.run(
            [sys.executable, str(GATE_PATH),
             "--text-artifact", work,  # a directory, not a file
             "--session-key", SESSION_KEY,
             "--store-dir", str(store_dir)],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 1
        report = json.loads(proc.stdout)
        assert report["input_status"] == "read_error"


# ---------------------------------------------------------------------------
# Additional branch coverage: untrusted-delegate failure modes and recovery faults.
# ---------------------------------------------------------------------------
def test_delegate_raises_integrity_violated_b1_fallback():
    def raising_delegate(masked: str) -> str:
        raise RuntimeError("delegate blew up")

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir, delegate=raising_delegate)
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    assert report["violation_reason"].startswith("delegate_raised:")
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_delegate_returns_non_string_integrity_violated():
    def non_string_delegate(masked: str):
        return 12345  # not a str -> typed violation, never a silent pass

    text, key = _spans_session_key()
    with tempfile.TemporaryDirectory() as store_dir:
        result = gate.run_gate(text, key, store_dir, delegate=non_string_delegate)
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    assert report["violation_reason"].startswith("delegate_non_string:")
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_placeholder_collision_error_guard_forces_passthrough():
    # sanitize() normally catches collisions internally; this exercises the gate's
    # defensive guard for a RAISED PlaceholderCollisionError from the masker contract.
    orig_sanitize = gate.sanitize

    def raising_sanitize(text, key, patterns, **kw):
        raise gate.PlaceholderCollisionError("forced collision")

    gate.sanitize = raising_sanitize
    try:
        with tempfile.TemporaryDirectory() as store_dir:
            result = gate.run_gate(SENSITIVE_TEXT, SESSION_KEY, store_dir)
    finally:
        gate.sanitize = orig_sanitize
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_passthrough"
    assert report["violation_reason"] == "placeholder_collision"
    assert report["mask_status"] == "rejected"
    assert result["restored"].encode("utf-8") == SENSITIVE_TEXT.encode("utf-8")


def test_rehydrate_failed_forces_violation():
    # A returned text whose placeholder set is a subset but rehydrate() raises (swapmap not
    # the bijection) is a typed rehydrate_failed violation, not a silent restore. We force
    # rehydrate to raise while keeping the residual scan clean.
    orig_rehydrate = gate.rehydrate

    def raising_rehydrate(masked, swapmap):
        raise ValueError("placeholder not in swapmap")

    gate.rehydrate = raising_rehydrate
    text, key = _spans_session_key()
    try:
        with tempfile.TemporaryDirectory() as store_dir:
            result = gate.run_gate(text, key, store_dir)  # identity delegate (clean subset)
    finally:
        gate.rehydrate = orig_rehydrate
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    assert report["violation_reason"] == "rehydrate_failed"
    assert result["restored"].encode("utf-8") == text.encode("utf-8")


def test_handle_unverifiable_when_anchor_retrieve_fails_on_ok_path():
    # On the otherwise-clean path, the final B1 anchor recheck must reconstruct the original.
    # If retrieve() raises there, the "ok" verdict must be downgraded to handle_unverifiable
    # (a violation), proving "ok" carries a real reversibility guarantee. After downgrade the
    # fallback retrieve also fails -> typed retrieve_error, restored None.
    orig_retrieve = gate.retrieve

    def failing_retrieve(handle, sd):
        raise gate.StoreError("corrupt")

    gate.retrieve = failing_retrieve
    text, key = _spans_session_key()
    try:
        with tempfile.TemporaryDirectory() as store_dir:
            result = gate.run_gate(text, key, store_dir)  # identity delegate
    finally:
        gate.retrieve = orig_retrieve
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["violation_reason"] == "handle_unverifiable"
    assert report["fallback"] == "verbatim_b1"
    assert report["recovery_status"] == "retrieve_error"
    assert result["restored"] is None


def test_recovered_mismatch_when_b1_returns_wrong_bytes():
    # If B1 retrieve returns bytes that decode to something other than the original during
    # fallback recovery, that is a typed recovered_mismatch (corrupt handle), restored None.
    def mutating_delegate(masked: str) -> str:
        return masked.replace("_PATH_1__", "_PATH_999__", 1)  # force fallback

    orig_retrieve = gate.retrieve

    def wrong_bytes_retrieve(handle, sd):
        return b"totally different bytes"

    gate.retrieve = wrong_bytes_retrieve
    text, key = _spans_session_key()
    try:
        with tempfile.TemporaryDirectory() as store_dir:
            result = gate.run_gate(text, key, store_dir, delegate=mutating_delegate)
    finally:
        gate.retrieve = orig_retrieve
    report = result["report"]
    assert report["integrity"] == "violated"
    assert report["fallback"] == "verbatim_b1"
    assert report["recovery_status"] == "recovered_mismatch"
    assert result["restored"] is None


def test_main_argv_violation_returns_nonzero():
    # main_argv on a violated round-trip must exit nonzero (fail-closed CLI). We force a
    # store error so the gate falls back to passthrough (integrity violated) but main still
    # emits a metadata-only report and returns 1.
    orig_store = gate.store

    def failing_store(raw, store_dir):
        raise gate.StoreError("store_write_failed:simulated")

    gate.store = failing_store
    try:
        with tempfile.TemporaryDirectory() as work:
            artifact = Path(work) / "prompt.txt"
            artifact.write_text(SENSITIVE_TEXT, encoding="utf-8")
            store_dir = Path(work) / "b1store"
            argv = ["--text-artifact", str(artifact), "--session-key", SESSION_KEY,
                    "--store-dir", str(store_dir)]
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = gate.main_argv(argv)
            assert rc == 1
            report = json.loads(buf.getvalue())
            assert report["integrity"] == "violated"
            assert report["store_status"] == "store_error"
    finally:
        gate.store = orig_store


def test_main_argv_missing_artifact_in_process():
    with tempfile.TemporaryDirectory() as work:
        store_dir = Path(work) / "b1store"
        argv = ["--text-artifact", str(Path(work) / "nope.txt"),
                "--session-key", SESSION_KEY, "--store-dir", str(store_dir)]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = gate.main_argv(argv)
        assert rc == 1
        report = json.loads(buf.getvalue())
        assert report["input_status"] == "missing"


def test_main_argv_read_error_in_process():
    # A directory passed as the artifact triggers the OSError read_error branch in-process.
    with tempfile.TemporaryDirectory() as work:
        store_dir = Path(work) / "b1store"
        argv = ["--text-artifact", work, "--session-key", SESSION_KEY,
                "--store-dir", str(store_dir)]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = gate.main_argv(argv)
        assert rc == 1
        report = json.loads(buf.getvalue())
        assert report["input_status"] == "read_error"
        assert "error_type" in report


def test_main_entrypoint_invokes_main_argv():
    # Cover main() (sys.argv pass-through) in-process via a clean round-trip.
    with tempfile.TemporaryDirectory() as work:
        artifact = Path(work) / "prompt.txt"
        artifact.write_text(SENSITIVE_TEXT, encoding="utf-8")
        store_dir = Path(work) / "b1store"
        orig_argv = sys.argv
        sys.argv = ["prompt_rehydration_gate.py", "--text-artifact", str(artifact),
                    "--session-key", SESSION_KEY, "--store-dir", str(store_dir)]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = gate.main()
        finally:
            sys.argv = orig_argv
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["integrity"] == "ok"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} prompt_rehydration_gate tests passed")
