#!/usr/bin/env python3
"""Tests for sensitive_pattern_loader (Bead 2.1) — the SECURITY SSOT for the masker.

Standalone runner in the `test_pi_presence_probe.py` style (no pytest). Covers:
  (1) happy path — loads the REAL secret-pattern SSOT → provider_count>0,
      structural_count>0, pattern_source_status="ok";
  (2) F4 closure — embedded structural patterns MATCH a real absolute path
      (/Users/testuser/agent-runtime-probes), $USER/bare-username, and a hostname (proves
      PATH/USER/HOST classes — the masker's PRIMARY sensitive class — are covered,
      which the provider-token JSON does NOT cover);
  (3) UNHAPPY (fail-closed) — malformed temp config → pattern_source_status="invalid"
      AND structural patterns still present (conservative fallback, NOT empty);
      missing config → "missing" + fallback;
  (4) determinism — checksum + counts identical across two loads;
  (5) CLI e2e — run as a real subprocess.

Provenance: synthetic temp fixtures for unhappy paths; the happy/F4/determinism
tests are production-derived against the live SSOT at the canonical config path.
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sensitive_pattern_loader as loader  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "sensitive_pattern_loader.py"
REAL_SSOT = str(Path.home() / ".claude/config/secret-patterns.json")


# --- (1) happy path -------------------------------------------------------

def test_load_real_ssot_is_ok_with_both_pattern_classes():
    ps = loader.load_patterns(REAL_SSOT)
    assert ps.status == "ok", ps.status
    assert ps.provider_count > 0
    assert ps.structural_count > 0
    # PatternSet exposes the two lists as (TYPE, compiled_regex) tuples
    for typ, rx in ps.provider_patterns:
        assert isinstance(typ, str) and hasattr(rx, "search")
    for typ, rx in ps.structural_patterns:
        assert isinstance(typ, str) and hasattr(rx, "search")


def test_default_config_path_resolves_to_real_ssot():
    # load_patterns(None) must fall back to the canonical SSOT path.
    ps = loader.load_patterns(None)
    assert ps.status == "ok"
    assert ps.provider_count > 0


# --- (2) F4 closure -------------------------------------------------------

def _structural_types(ps):
    return {typ for typ, _ in ps.structural_patterns}


def _any_match(ps, text, want_type=None):
    for typ, rx in ps.structural_patterns:
        if rx.search(text):
            if want_type is None or typ == want_type:
                return typ
    return None


def test_f4_structural_patterns_cover_path_user_host_classes():
    """F4: the provider-token JSON has ZERO path/user/host coverage; this module
    must embed them. Prove a real abs path, a bare username, and a hostname match."""
    ps = loader.load_patterns(REAL_SSOT)
    types = _structural_types(ps)
    # The five required structural TYPE labels for the masker's <TYPE> placeholders.
    assert {"PATH", "USER", "HOST", "REPO", "ID"}.issubset(types), types

    # Real absolute path on this machine — must match a PATH-typed pattern.
    assert _any_match(ps, "/Users/testuser/agent-runtime-probes", "PATH") == "PATH"
    # General system path classes.
    assert _any_match(ps, "/var/folders/zz/tmpfile", "PATH") == "PATH"
    # $USER form and bare username.
    assert _any_match(ps, "$USER", "USER") == "USER"
    assert _any_match(ps, "the user q logged in", "USER") is not None
    # A hostname (FQDN / *.local).
    assert _any_match(ps, "runtime-host.local", "HOST") == "HOST"
    assert _any_match(ps, "host examplefleet.lan reachable", "HOST") is not None
    # Long numeric / hex IDs.
    assert _any_match(ps, "id=0123456789abcdef0123", "ID") == "ID"


def test_f4_provider_patterns_do_not_cover_paths():
    """Sanity: the provider-token patterns alone do NOT match an absolute path —
    this is exactly the F4 gap the structural patterns close."""
    ps = loader.load_patterns(REAL_SSOT)
    hit = None
    for typ, rx in ps.provider_patterns:
        if rx.search("/Users/testuser/agent-runtime-probes"):
            hit = typ
            break
    assert hit is None, f"provider pattern unexpectedly matched a path: {hit}"


# --- (3) UNHAPPY: fail-closed conservative fallback -----------------------

def test_malformed_config_invalid_status_but_structural_fallback_present():
    with tempfile.TemporaryDirectory() as d:
        bad = Path(d) / "bad-secret-patterns.json"
        bad.write_text("{ this is not valid json :: ", encoding="utf-8")
        ps = loader.load_patterns(str(bad))
        # invalid status, parse_status invalid — never a silent pass.
        assert ps.status == "invalid", ps.status
        assert ps.parse_status == "invalid", ps.parse_status
        # CONSERVATIVE FALLBACK: structural patterns MUST still be present and
        # non-empty so masking degrades SAFE (not open). Provider patterns absent.
        assert ps.structural_count > 0, "malformed SSOT must NOT yield empty structural set"
        assert len(ps.structural_patterns) == ps.structural_count
        assert ps.provider_count == 0


def test_missing_config_missing_status_but_structural_fallback_present():
    with tempfile.TemporaryDirectory() as d:
        ghost = Path(d) / "does-not-exist.json"
        ps = loader.load_patterns(str(ghost))
        assert ps.status == "missing", ps.status
        # Still returns the embedded structural patterns (conservative fallback).
        assert ps.structural_count > 0
        assert ps.provider_count == 0


def test_malformed_config_still_matches_a_real_path():
    """Even under a malformed SSOT, the conservative fallback must still mask the
    machine's PRIMARY sensitive class (paths/users), not pass everything."""
    with tempfile.TemporaryDirectory() as d:
        bad = Path(d) / "bad.json"
        bad.write_text("NOT JSON", encoding="utf-8")
        ps = loader.load_patterns(str(bad))
        assert _any_match(ps, "/Users/testuser/agent-runtime-probes", "PATH") == "PATH"


def test_non_dict_json_is_invalid_not_pass():
    with tempfile.TemporaryDirectory() as d:
        weird = Path(d) / "list.json"
        weird.write_text("[1, 2, 3]", encoding="utf-8")
        ps = loader.load_patterns(str(weird))
        assert ps.status == "invalid"
        assert ps.structural_count > 0


# --- report() report shape ------------------------------------------------

def test_report_emits_required_metadata_only_fields():
    rep = loader.report(REAL_SSOT)
    assert rep["schema"] == "agent-runtime-sensitive-pattern-loader"
    assert rep["schema_version"] == "0.1"
    assert rep["redaction"] == "metadata-only"
    assert rep["pattern_source_status"] == "ok"
    assert rep["provider_count"] > 0
    assert rep["structural_count"] > 0
    assert rep["parse_status"] == "ok"
    # checksum present and is a 16-char hex of the loaded config bytes.
    assert re.fullmatch(r"[0-9a-f]{16}", rep["checksum_sha256_16"])
    # METADATA-ONLY: the report must NEVER carry raw regex bodies or matched values.
    blob = json.dumps(rep)
    assert "/Users/" not in blob
    assert "sk-ant" not in blob
    assert "[^/" not in blob  # no raw regex source leaked


def test_report_missing_config_status_and_no_checksum_value_pass():
    with tempfile.TemporaryDirectory() as d:
        ghost = Path(d) / "nope.json"
        rep = loader.report(str(ghost))
        assert rep["pattern_source_status"] == "missing"
        assert rep["provider_count"] == 0
        assert rep["structural_count"] > 0
        # checksum is null/None when there are no config bytes to hash.
        assert rep["checksum_sha256_16"] is None


def test_report_invalid_config_parse_status():
    with tempfile.TemporaryDirectory() as d:
        bad = Path(d) / "bad.json"
        bad.write_text("{bad", encoding="utf-8")
        rep = loader.report(str(bad))
        assert rep["pattern_source_status"] == "invalid"
        assert rep["parse_status"] == "invalid"
        assert rep["structural_count"] > 0
        # malformed file still has bytes → checksum is present.
        assert re.fullmatch(r"[0-9a-f]{16}", rep["checksum_sha256_16"])


# --- (4) determinism ------------------------------------------------------

def test_checksum_and_counts_deterministic_across_two_loads():
    a = loader.report(REAL_SSOT)
    b = loader.report(REAL_SSOT)
    assert a["checksum_sha256_16"] == b["checksum_sha256_16"]
    assert a["provider_count"] == b["provider_count"]
    assert a["structural_count"] == b["structural_count"]
    # checksum is the sha256_16 of the on-disk bytes.
    raw = Path(REAL_SSOT).read_bytes()
    import hashlib
    assert a["checksum_sha256_16"] == hashlib.sha256(raw).hexdigest()[:16]


def test_load_patterns_does_not_mutate_ssot_file():
    before = Path(REAL_SSOT).read_bytes()
    loader.load_patterns(REAL_SSOT)
    loader.report(REAL_SSOT)
    after = Path(REAL_SSOT).read_bytes()
    assert before == after, "loader MUST NOT mutate the shared SSOT config file"


# --- internal branch coverage: provider extraction edge cases -------------

def test_extract_provider_skips_malformed_and_nonstring_and_nondict():
    data = {
        "providers": {
            "good": {"token_prefix_patterns": ["ok-[a-z]{4,}"]},
            "bad_regex": {"token_prefix_patterns": ["((unbalanced"]},
            "nonstring": {"token_prefix_patterns": [123, None]},
            "not_a_dict": ["nope"],
            "no_patterns_key": {"env_vars": ["X"]},
        },
        "structural_patterns": {
            "pk": {"patterns": ["BEGIN [A-Z]+ KEY"]},
            "bad": {"patterns": ["(unbalanced"]},
            "nonstr": {"patterns": [42]},
            "not_dict": "stringval",
        },
    }
    out, malformed = loader._extract_provider_patterns(data)
    types = [t for t, _ in out]
    # one good TOKEN, one good SECRET kept; non-string/non-dict skipped.
    assert types.count("TOKEN") == 1
    assert types.count("SECRET") == 1
    # the two malformed external regexes are COUNTED, never silently fail-open skipped.
    assert malformed == 2


def test_extract_provider_malformed_external_regex_is_counted_not_silent():
    # A single bad external regex is recorded (malformed_pattern_count) and surfaced
    # while good patterns are retained — proves the fail-closed (non-fail-open) handler.
    data = {"providers": {"p": {"token_prefix_patterns": ["good-[0-9]+", "((bad"]}}}
    out, malformed = loader._extract_provider_patterns(data)
    assert [t for t, _ in out] == ["TOKEN"]  # the good one kept
    assert malformed == 1


def test_extract_provider_handles_absent_sections():
    assert loader._extract_provider_patterns({}) == ([], 0)
    assert loader._extract_provider_patterns({"providers": "notadict"}) == ([], 0)
    assert loader._extract_provider_patterns({"structural_patterns": 5}) == ([], 0)


def test_compile_structural_raises_on_bad_embedded_pattern():
    orig = loader._STRUCTURAL_SOURCES
    loader._STRUCTURAL_SOURCES = (("PATH", "((unbalanced"),)
    try:
        raised = False
        try:
            loader._compile_structural()
        except ValueError as exc:
            raised = True
            assert "failed to compile" in str(exc)
        assert raised, "a malformed embedded pattern must raise a typed ValueError"
    finally:
        loader._STRUCTURAL_SOURCES = orig


def test_present_but_unreadable_config_is_missing_status():
    # Simulate a present-but-unreadable SSOT (OSError on read_bytes) → fail-closed
    # "missing" status with conservative fallback, never a silent pass.
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "perm.json"
        f.write_text("{}", encoding="utf-8")
        orig = Path.read_bytes

        def boom(self, *a, **k):
            if str(self) == str(f):
                raise OSError("EACCES simulated")
            return orig(self, *a, **k)

        Path.read_bytes = boom
        try:
            ps = loader.load_patterns(str(f))
        finally:
            Path.read_bytes = orig
        assert ps.status == "missing"
        assert ps.provider_count == 0
        assert ps.structural_count > 0
        assert ps.checksum_sha256_16 is None


# --- (5) CLI e2e ----------------------------------------------------------

def test_cli_entrypoint_emits_valid_json():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--config", REAL_SSOT],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    rep = json.loads(proc.stdout)
    assert rep["schema"] == "agent-runtime-sensitive-pattern-loader"
    assert rep["pattern_source_status"] == "ok"
    assert rep["provider_count"] > 0
    assert rep["structural_count"] > 0


def test_cli_default_config_pretty():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--pretty"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    rep = json.loads(proc.stdout)
    assert rep["pattern_source_status"] == "ok"


def test_cli_missing_config_exits_nonzero():
    with tempfile.TemporaryDirectory() as d:
        ghost = Path(d) / "nope.json"
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--config", str(ghost)],
            capture_output=True, text=True, timeout=30,
        )
        # missing SSOT is an unhappy (fail-closed) status → nonzero exit, but the
        # report still carries the conservative fallback.
        assert proc.returncode == 1, proc.stderr
        rep = json.loads(proc.stdout)
        assert rep["pattern_source_status"] == "missing"
        assert rep["structural_count"] > 0


def test_main_returns_zero_on_ok():
    argv = sys.argv
    sys.argv = ["sensitive_pattern_loader.py", "--config", REAL_SSOT]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = loader.main()
    finally:
        sys.argv = argv
    assert rc == 0
    rep = json.loads(buf.getvalue())
    assert rep["pattern_source_status"] == "ok"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} sensitive_pattern_loader tests passed")
