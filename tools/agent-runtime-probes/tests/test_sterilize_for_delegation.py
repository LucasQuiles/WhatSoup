#!/usr/bin/env python3
"""Tests for tools/sterilize_for_delegation — the sanitize-then-delegate trust boundary.

Standalone runner in the `test_pi_presence_probe.py` style (no pytest). Covers:
  - sterilize -> rehydrate round trip (placeholders swap back to originals);
  - residual-clean guarantee (a sterilized artifact is emitted ONLY residual-clean, and a
    forced residual leak FAILS CLOSED, refusing to write the output);
  - H4: the missing-input _error marker carries NO raw `/Users/...` path (a sha256_16 hash
    stands in for the path instead);
  - typed fail-closed errors, CLI e2e (both subcommands), and the chmod-failure branch.

Provenance: synthetic in-memory fixtures (no real secrets); the pattern set is the live
production SSOT via `sensitive_pattern_loader.load_patterns()`.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOL_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import sterilize_for_delegation as ster  # noqa: E402
import prompt_sanitizer as ps  # noqa: E402
import sensitive_pattern_loader as spl  # noqa: E402
from probelib import sha256_16  # noqa: E402

TOOL_PATH = TOOL_DIR / "sterilize_for_delegation.py"

# Content with sensitive shapes the live SSOT masks (a path + an email/host).
SENSITIVE_TEXT = (
    "Worker, please review /Users/testuser/secret/project/notes.txt and email alice@example.com "
    "with your findings about /Users/testuser/secret/project/other.txt"
)
SESSION_KEY = "test-sterilize-session-key"


def _raises(exc_types, fn, *args, **kwargs) -> bool:
    try:
        fn(*args, **kwargs)
    except exc_types:
        return True
    return False


# --- coverage: trace the module body via a fresh import under settrace --------

def test_module_reloads_under_trace_for_coverage():
    spec = importlib.util.spec_from_file_location("sterilize_reloaded_for_coverage", TOOL_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.SCHEMA == ster.SCHEMA
    assert module.SCHEMA_VERSION == ster.SCHEMA_VERSION


# --- sterilize -> rehydrate round trip ----------------------------------------

def test_sterilize_then_rehydrate_round_trip():
    masked, swapmap = ster.sterilize(SENSITIVE_TEXT, SESSION_KEY)
    # The raw sensitive shapes are gone from the masked artifact.
    assert "/Users/testuser/secret" not in masked
    assert "alice@example.com" not in masked
    assert swapmap  # at least one placeholder
    # A worker's findings reference the placeholders; rehydration restores the originals.
    findings = "I reviewed " + " and ".join(swapmap.keys()) + " — looks fine."
    rehydrated = ster.rehydrate_findings(findings, swapmap)
    for placeholder, original in swapmap.items():
        assert placeholder not in rehydrated
        assert original in rehydrated


def test_rehydrate_leaves_unknown_placeholders_untouched():
    masked, swapmap = ster.sterilize(SENSITIVE_TEXT, SESSION_KEY)
    hallucinated = "__CAPE_deadbeefdeadbeef_PATH_99__"
    findings = f"saw {hallucinated} which was never in the map"
    out = ster.rehydrate_findings(findings, swapmap)
    assert hallucinated in out  # left as-is, not crashed


def test_rehydrate_rejects_non_dict_map():
    assert _raises(ster.SterilizeError, ster.rehydrate_findings, "x", ["not", "a", "dict"])


# --- residual-clean guarantee (fail closed) -----------------------------------

def test_sterilize_is_residual_clean():
    masked, _ = ster.sterilize(SENSITIVE_TEXT, SESSION_KEY)
    patterns = spl.load_patterns()
    assert ps.residual_scan(masked, patterns) == []


def test_sterilize_fails_closed_on_residual_leak(monkeypatch_residual=True):
    # Force residual_scan to report a surviving shape -> sterilize must refuse to emit.
    orig = ster.ps.residual_scan
    ster.ps.residual_scan = lambda masked, patterns: ["PATH:deadbeef"]
    try:
        try:
            ster.sterilize(SENSITIVE_TEXT, SESSION_KEY)
        except ster.SterilizeError as exc:
            assert exc.error_type == "residual_leak"
        else:
            raise AssertionError("expected SterilizeError on residual leak")
    finally:
        ster.ps.residual_scan = orig


def test_sterilize_unexpected_pattern_status_fails_closed():
    orig = ster.spl.load_patterns

    class _FakePatterns:
        status = "exploded"

    ster.spl.load_patterns = lambda *a, **k: _FakePatterns()
    try:
        try:
            ster.sterilize(SENSITIVE_TEXT, SESSION_KEY)
        except ster.SterilizeError as exc:
            assert exc.error_type == "pattern_source"
        else:
            raise AssertionError("expected SterilizeError on bad pattern status")
    finally:
        ster.spl.load_patterns = orig


# --- H4: missing-input _error carries NO raw path, only a hash ----------------

def test_missing_input_error_has_no_raw_path_only_hash():
    path = Path("/Users/secretuser/private/delegate/leak-me.txt")
    try:
        ster._read_text(path)
    except ster.SterilizeError as exc:
        marker = exc.as_marker()
        msg = marker["_error"]
        assert "/Users/" not in msg
        assert str(path) not in msg
        assert sha256_16(str(path)) in msg
        assert marker["status"] == "blocked"
    else:
        raise AssertionError("expected SterilizeError for missing input")


def test_read_text_oserror_branch():
    # A directory path exists but read_text() raises OSError -> typed read_error.
    # H4 (C2 regression guard): the OSError message must NOT leak the raw path —
    # the path is hashed. A directory name is itself a raw filesystem path.
    with tempfile.TemporaryDirectory() as d:
        try:
            ster._read_text(Path(d))
        except ster.SterilizeError as exc:
            assert exc.error_type == "read_error"
            assert str(Path(d)) not in exc.message, "raw path leaked through read_error message"
            assert "path_sha256_16=" in exc.message
        else:
            raise AssertionError("expected SterilizeError read_error for directory read")


# --- session key helper -------------------------------------------------------

def test_fresh_session_key_honors_supplied_and_generates_otherwise():
    assert ster._fresh_session_key("supplied-key") == "supplied-key"
    gen = ster._fresh_session_key(None)
    assert isinstance(gen, str) and len(gen) == 32  # 16 random bytes -> 32 hex chars


# --- main()/CLI e2e -----------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["sterilize_for_delegation.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = ster.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_sterilize_then_rehydrate_round_trip_via_cli():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        src = dp / "in.txt"
        out = dp / "masked.txt"
        mapf = dp / "swapmap.json"
        src.write_text(SENSITIVE_TEXT, encoding="utf-8")

        rc, rep = _run_main([
            "sterilize", "--in", str(src), "--out", str(out),
            "--map", str(mapf), "--session-key", SESSION_KEY,
        ])
        assert rc == 0
        assert rep["mode"] == "sterilize"
        assert rep["status"] == "ok"
        assert rep["residual_clean"] is True
        assert rep["placeholder_count"] >= 1
        # The masked artifact on disk is residual-clean (no raw sensitive shapes).
        masked_disk = out.read_text(encoding="utf-8")
        assert "/Users/testuser/secret" not in masked_disk
        assert "alice@example.com" not in masked_disk
        # The swapmap file is 0600 (local-only secret).
        assert (os.stat(mapf).st_mode & 0o777) == 0o600

        # Rehydrate a worker's findings using the on-disk swapmap.
        swapmap = json.loads(mapf.read_text(encoding="utf-8"))
        findings = dp / "findings.txt"
        findings.write_text("Reviewed " + " and ".join(swapmap.keys()), encoding="utf-8")
        rehy = dp / "rehydrated.txt"
        rc2, rep2 = _run_main([
            "rehydrate", "--findings", str(findings),
            "--map", str(mapf), "--out", str(rehy),
        ])
        assert rc2 == 0
        assert rep2["mode"] == "rehydrate"
        assert rep2["status"] == "ok"
        restored = rehy.read_text(encoding="utf-8")
        for original in swapmap.values():
            assert original in restored


def test_main_sterilize_missing_input_blocks_nonzero_no_path_leak():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        rc, rep = _run_main([
            "sterilize", "--in", str(dp / "nope.txt"),
            "--out", str(dp / "o.txt"), "--map", str(dp / "m.json"),
        ])
        assert rc == 1
        assert rep["status"] == "blocked"
        assert rep["error_type"] == "missing_input"
        assert "/Users/" not in rep["_error"]


def test_main_rehydrate_invalid_map_blocks():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        findings = dp / "f.txt"
        findings.write_text("nothing sensitive", encoding="utf-8")
        mapf = dp / "bad.json"
        mapf.write_text("{not valid json", encoding="utf-8")
        rc, rep = _run_main([
            "rehydrate", "--findings", str(findings),
            "--map", str(mapf), "--out", str(dp / "o.txt"),
        ])
        assert rc == 1
        assert rep["error_type"] == "invalid_map"


def test_do_sterilize_chmod_failure_fails_closed():
    # Force os.chmod to raise -> the map_chmod branch fails closed.
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        src = dp / "in.txt"
        src.write_text(SENSITIVE_TEXT, encoding="utf-8")
        args = type("A", (), {})()
        args.__dict__["in"] = str(src)
        args.out = str(dp / "masked.txt")
        args.map = str(dp / "map.json")
        args.session_key = SESSION_KEY
        orig = ster.os.chmod
        ster.os.chmod = lambda *a, **k: (_ for _ in ()).throw(OSError("denied"))
        try:
            ster._do_sterilize(args)
        except ster.SterilizeError as exc:
            assert exc.error_type == "map_chmod"
        else:
            raise AssertionError("expected SterilizeError map_chmod")
        finally:
            ster.os.chmod = orig


def test_cli_subprocess_entrypoint_round_trip():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        src = dp / "in.txt"
        out = dp / "masked.txt"
        mapf = dp / "map.json"
        src.write_text(SENSITIVE_TEXT, encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(TOOL_PATH), "sterilize", "--in", str(src),
             "--out", str(out), "--map", str(mapf), "--session-key", SESSION_KEY],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        rep = json.loads(proc.stdout)
        assert rep["status"] == "ok"
        assert rep["redaction"] == "metadata-only"


def test_cli_subprocess_missing_input_no_path_leak():
    proc = subprocess.run(
        [sys.executable, str(TOOL_PATH), "sterilize",
         "--in", "/Users/secretuser/private/nope.txt",
         "--out", "/tmp/o.txt", "--map", "/tmp/m.json"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 1
    rep = json.loads(proc.stdout)
    assert rep["error_type"] == "missing_input"
    assert "/Users/" not in rep["_error"]
    assert sha256_16("/Users/secretuser/private/nope.txt") in rep["_error"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} sterilize_for_delegation tests passed")
