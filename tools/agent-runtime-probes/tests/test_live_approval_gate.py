#!/usr/bin/env python3
"""Tests for live_approval_gate — mechanical fail-closed interlock for live-activation steps. Standalone.

The gate greenlights a live action ONLY when a present, well-formed, in-scope, attributed, unexpired
approval artifact authorizes exactly that action; every other path is BLOCKED with a closed-vocabulary
reason code. These tests pin each branch (fail-closed default, scope, attribution, validity window,
ref binding) plus determinism, CLI exit codes, and metadata-only output.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import live_approval_gate as lag  # noqa: E402

ISSUED = 1_750_000_000
EXPIRES = 1_750_600_000
NOW_OK = 1_750_300_000  # inside [ISSUED, EXPIRES]


def _artifact(tmp: Path, **overrides) -> Path:
    doc = {
        "schema": "agent-runtime-live-approval",
        "schema_version": "0.1",
        "scope": ["shadow_run"],
        "granted_by": "q (owner)",
        "reason": "shadow dry-run over offline fixtures; no side effects",
        "issued_at_epoch": ISSUED,
        "expires_at_epoch": EXPIRES,
        "plan_ref": "ROADMAP.md@shadow-step",
    }
    doc.update(overrides)
    # allow a test to drop a key by passing it as a sentinel
    doc = {k: v for k, v in doc.items() if v is not _DROP}
    path = tmp / "live_approval.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


_DROP = object()


def test_missing_path_none_blocks():
    rep = lag.evaluate(None, "shadow_run", NOW_OK)
    assert rep["decision"] == "blocked" and rep["reason"] == lag.R_MISSING
    assert rep["artifact_present"] is False


def test_missing_path_nonexistent_blocks():
    with tempfile.TemporaryDirectory() as d:
        rep = lag.evaluate(Path(d) / "nope.json", "shadow_run", NOW_OK)
    assert rep["decision"] == "blocked" and rep["reason"] == lag.R_MISSING


def test_malformed_json_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "live_approval.json"
        p.write_text("{not json", encoding="utf-8")
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["decision"] == "blocked" and rep["reason"] == lag.R_MALFORMED
    assert rep["artifact_present"] is True and rep["artifact_checksum_sha256_16"]


def test_wrong_schema_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), schema="something-else")
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_SCHEMA


def test_scope_missing_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), scope=_DROP)
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_NO_SCOPE


def test_scope_not_a_list_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), scope="shadow_run")
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_NO_SCOPE


def test_empty_scope_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), scope=[])
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_NO_SCOPE


def test_action_out_of_scope_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), scope=["e1_calibration"])
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_OUT_OF_SCOPE and rep["scope"] == ["e1_calibration"]


def test_missing_grantor_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), granted_by="   ")
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_NO_GRANTOR


def test_missing_reason_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), reason=_DROP)
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_NO_REASON


def test_missing_window_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), issued_at_epoch=_DROP)
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_NO_WINDOW


def test_bool_window_rejected_as_not_epoch():
    # bool is an int subclass; a True/False must NOT be accepted as a valid epoch.
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), expires_at_epoch=True)
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_NO_WINDOW


def test_inverted_window_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), issued_at_epoch=EXPIRES, expires_at_epoch=ISSUED)
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["reason"] == lag.R_BAD_WINDOW


def test_zero_width_window_blocks():
    # issued == expires is a single-instant window — rejected as invalid (must span positive duration).
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), issued_at_epoch=ISSUED, expires_at_epoch=ISSUED)
        rep = lag.evaluate(p, "shadow_run", ISSUED)
    assert rep["reason"] == lag.R_BAD_WINDOW


def test_not_yet_valid_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        rep = lag.evaluate(p, "shadow_run", ISSUED - 1)
    assert rep["reason"] == lag.R_NOT_YET


def test_expired_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        rep = lag.evaluate(p, "shadow_run", EXPIRES + 1)
    assert rep["reason"] == lag.R_EXPIRED


def test_window_boundaries_inclusive_approve():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        assert lag.evaluate(p, "shadow_run", ISSUED)["decision"] == "approved"
        assert lag.evaluate(p, "shadow_run", EXPIRES)["decision"] == "approved"


def test_ref_mismatch_blocks():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        rep = lag.evaluate(p, "shadow_run", NOW_OK, expected_ref="ROADMAP.md@OTHER")
    assert rep["reason"] == lag.R_REF_MISMATCH


def test_ref_match_approves():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        rep = lag.evaluate(p, "shadow_run", NOW_OK, expected_ref="ROADMAP.md@shadow-step")
    assert rep["decision"] == "approved" and rep["reason"] == lag.R_APPROVED


def test_valid_without_expected_ref_approves():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
    assert rep["decision"] == "approved"
    assert rep["scope"] == ["shadow_run"] and rep["granted_by"] == "q (owner)"
    assert rep["validity_window"]["now_epoch"] == NOW_OK
    assert rep["artifact_checksum_sha256_16"]


def test_determinism_same_inputs_same_report():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        a = lag.evaluate(p, "shadow_run", NOW_OK)
        b = lag.evaluate(p, "shadow_run", NOW_OK)
    assert a == b


def test_metadata_only_no_raw_secret_in_output():
    # A grantor reason containing a secret-shaped token must not leak verbatim into the report.
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d), reason="approved by token sk-shouldnotappear-in-report")
        rep = lag.evaluate(p, "shadow_run", NOW_OK)
        blob = json.dumps(rep)
    # the report never echoes the artifact's free-text reason field at all
    assert "reason" not in rep or rep["reason"] in {lag.R_APPROVED}
    assert "sk-shouldnotappear-in-report" not in blob


def test_cli_approved_exit_zero():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = lag.main(["--artifact", str(p), "--action", "shadow_run", "--now-epoch", str(NOW_OK)])
        out = json.loads(buf.getvalue())
    assert rc == 0 and out["decision"] == "approved"


def test_cli_blocked_exit_two():
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = lag.main(["--action", "shadow_run", "--now-epoch", str(NOW_OK)])  # no artifact
    out = json.loads(buf.getvalue())
    assert rc == 2 and out["decision"] == "blocked" and out["reason"] == lag.R_MISSING


def test_cli_pretty_and_expected_ref():
    with tempfile.TemporaryDirectory() as d:
        p = _artifact(Path(d))
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = lag.main(["--artifact", str(p), "--action", "shadow_run", "--now-epoch", str(NOW_OK),
                           "--expected-ref", "ROADMAP.md@shadow-step", "--pretty"])
    assert rc == 0


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} live_approval_gate tests passed")
