#!/usr/bin/env python3
"""Tests for raw_output_handle_protocol (B1 reversibility-proof mechanism).

No pytest fixtures: manual setattr + try/finally, tempfile.TemporaryDirectory for every
store, never writing outside it. The standalone __main__ runner prints PASS <name>.

Proofs asserted here:
  - DETERMINISTIC ROUND-TRIP byte-identity: retrieve(store(x)) == x for a corpus of x
    (unicode, empty, large, secret-shaped, binary).
  - PERMISSIONS: store_dir is 0700, raw files are 0600.
  - FAIL-CLOSED: missing -> not_found; hash mismatch -> corrupt; bad syntax -> invalid_handle;
    path-traversal handle rejected; write failure -> store_error.
  - FAIL-OPEN: error-heavy / reducer-raises / non-string / unverifiable -> raw unchanged.
  - REDACTION: no raw / reduced content in the emitted report.
  - CLI e2e over a tempdir store.
"""
import io
import json
import os
import stat
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import raw_output_handle_protocol as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "raw_output_handle_protocol.py"

# Deterministic corpus exercised by the round-trip property test.
CORPUS = [
    b"",                                      # empty
    b"OK\n",                                  # trivial
    "unicode: café — 日本語 — \U0001F600\n".encode("utf-8"),  # unicode
    b"object 9f8e7d6c5b4a3210\nrow 42:7\n",   # protected tokens
    ("line\n" * 5000).encode("utf-8"),        # large
    b"token sk-ABCDEFGH12345678 secret\n",    # secret-shaped
    bytes(range(256)),                        # binary / non-utf8
]


# ---- deterministic round-trip property (the load-bearing reversibility proof) ----

def test_roundtrip_byte_identical_across_corpus():
    with TemporaryDirectory() as d:
        for x in CORPUS:
            handle = probe.store(x, d)
            assert probe.valid_handle(handle)
            assert handle == probe._sha256_full(x)
            got = probe.retrieve(handle, d)
            assert got == x, f"round-trip not byte-identical for {x[:16]!r}"


def test_determinism_same_input_same_handle():
    # Determinism: identical input -> identical full-SHA-256 handle across two distinct stores.
    with TemporaryDirectory() as d1, TemporaryDirectory() as d2:
        x = b"deterministic payload 12345\nobject deadbeef00\n"
        assert probe.store(x, d1) == probe.store(x, d2)


# ---- permissions (durability / storage safety) ----

def test_store_dir_is_0700_and_file_is_0600():
    with TemporaryDirectory() as parent:
        store_dir = Path(parent) / "store"
        handle = probe.store(b"perm-check\n", store_dir)
        dir_mode = stat.S_IMODE(store_dir.stat().st_mode)
        file_mode = stat.S_IMODE((store_dir / f"{handle}.raw").stat().st_mode)
        assert dir_mode == 0o700, oct(dir_mode)
        assert file_mode == 0o600, oct(file_mode)


# ---- fail-closed unhappy paths ----

def test_missing_handle_raises_not_found():
    with TemporaryDirectory() as d:
        absent = "0" * 64  # valid syntax, but nothing stored under it
        try:
            probe.retrieve(absent, d)
            raise AssertionError("expected FileNotFoundError for missing handle")
        except FileNotFoundError as exc:
            assert "not_found" in str(exc)


def test_corrupt_store_hash_mismatch_fails_closed():
    with TemporaryDirectory() as d:
        handle = probe.store(b"original bytes\n", d)
        # Tamper with the stored file so its content no longer hashes to the handle.
        (Path(d) / f"{handle}.raw").write_bytes(b"tampered bytes\n")
        try:
            probe.retrieve(handle, d)
            raise AssertionError("expected StoreError('corrupt') on hash mismatch")
        except probe.StoreError as exc:
            assert str(exc) == "corrupt"


def test_invalid_handle_syntax_rejected():
    with TemporaryDirectory() as d:
        for bad in ["zz", "ABCDEF" * 11, "g" * 64, "../etc/passwd"]:
            assert not probe.valid_handle(bad)
            try:
                probe.retrieve(bad, d)
                raise AssertionError(f"expected ValueError invalid_handle for {bad!r}")
            except ValueError as exc:
                assert "invalid_handle" in str(exc)


def test_path_traversal_handle_rejected():
    # A handle carrying path components must never be followed off the store dir.
    with TemporaryDirectory() as d:
        traversal = "../" * 4 + "etc/passwd"
        try:
            probe._handle_path(traversal, Path(d))
            raise AssertionError("expected ValueError for traversal handle")
        except ValueError as exc:
            assert "invalid_handle" in str(exc)


def test_store_write_failure_raises_store_error():
    # Force the atomic write to fail by making os.replace raise; assert fail-closed StoreError.
    with TemporaryDirectory() as d:
        orig_replace = probe.os.replace
        probe.os.replace = lambda *a, **k: (_ for _ in ()).throw(OSError("disk full"))
        try:
            probe.store(b"will not land\n", d)
            raise AssertionError("expected StoreError on write failure")
        except probe.StoreError as exc:
            assert "store_write_failed" in str(exc)
        finally:
            probe.os.replace = orig_replace


def test_store_verify_mismatch_raises_store_error():
    # Simulate silent on-disk corruption between write and read-back -> StoreError verify.
    with TemporaryDirectory() as d:
        real_read_bytes = Path.read_bytes
        orig = probe._sha256_full
        calls = {"n": 0}

        def fake_hash(data):
            # First call hashes raw (handle); readback call returns a wrong hash to mismatch.
            calls["n"] += 1
            return orig(data) if calls["n"] == 1 else "f" * 64
        probe._sha256_full = fake_hash
        try:
            probe.store(b"verify-path\n", d)
            raise AssertionError("expected StoreError verify mismatch")
        except probe.StoreError as exc:
            assert str(exc) == "store_verify_mismatch"
        finally:
            probe._sha256_full = orig
            assert Path.read_bytes is real_read_bytes


def test_store_accepts_str_and_rejects_non_bytes_type():
    with TemporaryDirectory() as d:
        # str path of _to_bytes: identical handle to its utf-8 encoding.
        h = probe.store("café 7\n", d)
        assert h == probe._sha256_full("café 7\n".encode("utf-8"))
        assert probe.retrieve(h, d) == "café 7\n".encode("utf-8")
    try:
        probe._to_bytes(12345)
        raise AssertionError("expected TypeError for non-str/bytes raw")
    except TypeError as exc:
        assert "str or bytes" in str(exc)


def test_ensure_store_dir_oserror_raises_store_error():
    with TemporaryDirectory() as d:
        orig = probe.os.chmod
        probe.os.chmod = lambda *a, **k: (_ for _ in ()).throw(OSError("denied"))
        try:
            probe.store(b"x\n", d)
            raise AssertionError("expected StoreError when store_dir cannot be secured")
        except probe.StoreError as exc:
            assert "store_dir_unwritable" in str(exc)
        finally:
            probe.os.chmod = orig


def test_store_readback_oserror_raises_store_error():
    # After a successful replace, a readback OSError must fail closed (not silently succeed).
    with TemporaryDirectory() as d:
        orig = probe.Path.read_bytes
        state = {"armed": False}

        def flaky(self, *a, **k):
            if state["armed"]:
                raise OSError("readback denied")
            return orig(self, *a, **k)
        # Arm only after the atomic write completes (replace done) by wrapping os.replace.
        orig_replace = probe.os.replace

        def armed_replace(src, dst):
            orig_replace(src, dst)
            state["armed"] = True
        probe.Path.read_bytes = flaky
        probe.os.replace = armed_replace
        try:
            probe.store(b"readback\n", d)
            raise AssertionError("expected StoreError on readback failure")
        except probe.StoreError as exc:
            assert "store_readback_failed" in str(exc)
        finally:
            probe.Path.read_bytes = orig
            probe.os.replace = orig_replace


def test_store_temp_cleanup_oserror_still_raises_write_error():
    # If replace fails AND temp cleanup fails, the original write failure is still surfaced.
    with TemporaryDirectory() as d:
        orig_replace = probe.os.replace
        orig_unlink = probe.Path.unlink
        probe.os.replace = lambda *a, **k: (_ for _ in ()).throw(OSError("replace fail"))
        probe.Path.unlink = lambda self, *a, **k: (_ for _ in ()).throw(OSError("unlink fail"))
        try:
            probe.store(b"cleanup\n", d)
            raise AssertionError("expected StoreError on write failure")
        except probe.StoreError as exc:
            assert "store_write_failed" in str(exc)
        finally:
            probe.os.replace = orig_replace
            probe.Path.unlink = orig_unlink


def test_retrieve_read_oserror_raises_store_error():
    with TemporaryDirectory() as d:
        handle = probe.store(b"read-fail\n", d)
        orig = probe.Path.read_bytes
        probe.Path.read_bytes = lambda self, *a, **k: (_ for _ in ()).throw(OSError("denied"))
        try:
            probe.retrieve(handle, d)
            raise AssertionError("expected StoreError on retrieve read failure")
        except probe.StoreError as exc:
            assert "retrieve_read_failed" in str(exc)
        finally:
            probe.Path.read_bytes = orig


def test_reduction_reversible_false_on_missing_handle():
    # The _reduction_reversible except path: a never-stored handle is not reversible.
    with TemporaryDirectory() as d:
        assert probe._reduction_reversible(b"x", "0" * 64, Path(d)) is False


def test_main_wrapper_delegates_to_main_argv():
    with TemporaryDirectory() as d:
        orig = sys.argv
        sys.argv = ["raw_output_handle_protocol.py", "--store-dir", d]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig
        assert rc == 0
        assert json.loads(buf.getvalue())["roundtrip"]["byte_identical"] is True


# ---- reduce_with_handle: happy + fail-open + fail-closed branches ----

def test_reduce_with_reversible_handle_applies_and_is_recoverable():
    with TemporaryDirectory() as d:
        raw = b"keep object 9f8e7d6c and row 10:4 and value 777 plus filler text here\n"
        result = probe.reduce_with_handle(raw, lambda t: t.replace("filler text here", ""), d)
        assert result["reduced_applied"] is True
        assert result["store_status"] == "stored"
        assert probe.valid_handle(result["handle"])
        # Raw is recoverable byte-identical via the proven-reversible handle.
        assert probe.retrieve(result["handle"], d) == raw


def test_reduce_error_heavy_output_fails_open():
    with TemporaryDirectory() as d:
        raw = b"FATAL error: migration failed at step 3\n"
        result = probe.reduce_with_handle(raw, lambda t: "shrunk", d)
        assert result["reduced_applied"] is False
        assert result["reason"] == "error_heavy_output_fail_open"
        assert result["reduced"] == raw.decode("utf-8")  # raw returned unchanged


def test_reduce_reducer_raises_fails_open():
    with TemporaryDirectory() as d:
        raw = b"plain ok output 12345\n"

        def boom(_text):
            raise RuntimeError("reducer blew up")
        result = probe.reduce_with_handle(raw, boom, d)
        assert result["reduced_applied"] is False
        assert "reducer_raised" in (result["error_type"] or "")
        assert result["reduced"] == raw.decode("utf-8")


def test_reduce_non_string_reducer_fails_open():
    with TemporaryDirectory() as d:
        raw = b"plain ok output 6789\n"
        result = probe.reduce_with_handle(raw, lambda _t: 12345, d)
        assert result["reduced_applied"] is False
        assert "reducer_non_string" in (result["error_type"] or "")


def test_reduce_unverifiable_reduction_fails_open():
    # If the handle cannot reconstruct raw (store proven unreversible), reduction fails open.
    with TemporaryDirectory() as d:
        raw = b"plain ok output 2468\n"
        orig = probe._reduction_reversible
        probe._reduction_reversible = lambda *a, **k: False
        try:
            result = probe.reduce_with_handle(raw, lambda t: "shrunk", d)
        finally:
            probe._reduction_reversible = orig
        assert result["reduced_applied"] is False
        assert result["reason"] == "handle_not_reversible_fail_open"


def test_reduce_store_error_fails_closed():
    # Raw store unwritable -> fail-closed store_error, reduction not applied.
    with TemporaryDirectory() as d:
        orig = probe.store

        def raise_store(*a, **k):
            raise probe.StoreError("store_write_failed:OSError")
        probe.store = raise_store
        try:
            result = probe.reduce_with_handle(b"anything 99\n", lambda t: "x", d)
        finally:
            probe.store = orig
        assert result["reduced_applied"] is False
        assert result["store_status"] == "store_error"
        assert result["handle"] is None


def test_reduce_omission_count_tracks_dropped_protected_tokens():
    with TemporaryDirectory() as d:
        raw = b"object 9f8e7d6c5b4a3210 and number 42 stay\n"
        # Drop the hash token; it is omitted from `reduced` but recoverable via the handle.
        result = probe.reduce_with_handle(raw, lambda t: t.replace("9f8e7d6c5b4a3210", ""), d)
        assert result["reduced_applied"] is True
        assert result["omission_count"] >= 1


def test_secret_shaped_raw_flags_sensitivity_class():
    with TemporaryDirectory() as d:
        raw = b"plain line token sk-ABCDEFGH12345678 here number 5\n"
        result = probe.reduce_with_handle(raw, lambda t: t, d)
        assert result["sensitivity_class"] == "secret_shaped_synthetic_or_private"


# ---- redaction: no raw / reduced content in the emitted report ----

def test_report_omits_raw_and_reduced_content():
    with TemporaryDirectory() as d:
        marker = "TOPSECRETMARKER42"
        raw = f"line one {marker} value 9\n".encode("utf-8")
        result = probe.reduce_with_handle(raw, lambda t: t, d)
        report = probe.report_for_result(result)
        blob = json.dumps(report)
        assert marker not in blob, "raw marker leaked into report"
        assert "reduced" not in report.get("metadata", {})
        assert report["schema"] == "agent-runtime-raw-output-handle-protocol"


# ---- main() / determinism of report ----

def test_main_roundtrip_demo_emits_metadata():
    with TemporaryDirectory() as d:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--store-dir", d])
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["roundtrip"]["byte_identical"] is True
        assert report["roundtrip"]["store_dir_mode"] == "0o700"


def test_main_determinism_same_input_same_report():
    # Build the report twice from identical input; assert identical (no ts fields present).
    with TemporaryDirectory() as d1, TemporaryDirectory() as d2:
        inp = Path(d1) / "seed.txt"
        inp.write_bytes(b"seed line object abcdef12 value 3\n")
        b1, b2 = io.StringIO(), io.StringIO()
        with redirect_stdout(b1):
            probe.main_argv(["--store-dir", str(Path(d1) / "s"), "--input", str(inp)])
        with redirect_stdout(b2):
            probe.main_argv(["--store-dir", str(Path(d2) / "s"), "--input", str(inp)])
        r1, r2 = json.loads(b1.getvalue()), json.loads(b2.getvalue())
        # store_dir paths differ; compare the content-addressed handle + identity verdict.
        assert r1["roundtrip"]["handle"] == r2["roundtrip"]["handle"]
        assert r1["roundtrip"]["byte_identical"] == r2["roundtrip"]["byte_identical"]
        assert r1["metadata"]["reason"] == r2["metadata"]["reason"]


def test_main_retrieve_missing_handle_reports_not_found():
    with TemporaryDirectory() as d:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--store-dir", d, "--retrieve", "0" * 64])
        assert rc == 1
        report = json.loads(buf.getvalue())
        assert report["status"] == "not_found"
        assert report["error_type"] == "not_found"


def test_main_retrieve_invalid_handle_reports_invalid():
    with TemporaryDirectory() as d:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--store-dir", d, "--retrieve", "not-a-hex-handle"])
        assert rc == 1
        report = json.loads(buf.getvalue())
        assert report["status"] == "invalid_handle"


def test_main_input_missing_file_reports_input_error():
    with TemporaryDirectory() as d:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--store-dir", d, "--input", str(Path(d) / "nope.bin")])
        assert rc == 1
        report = json.loads(buf.getvalue())
        assert report["status"] == "input_error"


def test_main_store_error_reports_store_error():
    with TemporaryDirectory() as d:
        orig = probe.store
        probe.store = lambda *a, **k: (_ for _ in ()).throw(probe.StoreError("store_write_failed:OSError"))
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main_argv(["--store-dir", d])
        finally:
            probe.store = orig
        assert rc == 1
        report = json.loads(buf.getvalue())
        assert report["status"] == "store_error"


def test_main_retrieve_roundtrip_after_store():
    with TemporaryDirectory() as d:
        handle = probe.store(b"stored for retrieval 11\n", d)
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--store-dir", d, "--retrieve", handle, "--pretty"])
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["metadata"]["reason"] == "retrieve_verified"


# ---- CLI e2e (real subprocess over a tempdir store) ----

def test_cli_e2e_roundtrip_subprocess():
    with TemporaryDirectory() as d:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--store-dir", d],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["schema"] == "agent-runtime-raw-output-handle-protocol"
        assert report["roundtrip"]["byte_identical"] is True
        # The store dir really exists with a stored .raw file at 0600.
        raws = list(Path(d).glob("*.raw"))
        assert raws, "expected a stored .raw file"
        assert stat.S_IMODE(raws[0].stat().st_mode) == 0o600


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} raw_output_handle_protocol tests passed")
