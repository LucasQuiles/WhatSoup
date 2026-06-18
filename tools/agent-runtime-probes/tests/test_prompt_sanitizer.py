#!/usr/bin/env python3
"""Tests for prompt_sanitizer (Bead 2.2) — the SECURITY-CRITICAL privacy boundary.

Standalone runner in the `test_pi_presence_probe.py` style (no pytest). The masker
imports the Bead 2.1 SSOT (`sensitive_pattern_loader`) so masker + residual scan can
never diverge. Coverage of the load-bearing rules from the plan (section 12,
assumptions MASK-NONCE / NORMALIZATION / MASK-BIJECTION / B1-ORDERING):

  (1) NFC normalization — a full-width '/' (U+FF0F) and an NFD path both normalize
      and match (no Unicode-confusable bypass / LEAK);
  (2) longest-match-first, single pass, non-overlapping — `/Users/testuser` vs the longer
      `/Users/testuser/agent-runtime-probes` in one text leaves NO residual repo-name leak;
  (3) adjacent non-overlapping spans (R11) — two touching sensitive spans both mask,
      residual clean;
  (4) injective bijection — distinct entities → distinct placeholders;
      rehydrate(mask(p)) == p BYTE-IDENTICAL across empty/unicode/secret/path-dense;
  (5) collision rejection — input literally containing a `__CAPE_..._PATH_1__`
      placeholder shape fails closed (never an ambiguous swapmap);
  (6) residual threshold ZERO — after mask() residual_scan==[]; an un-masked
      email/path → residual_scan returns a hit (type-label, never the raw value);
  (7) session_key empty/invalid → typed status, do NOT mask;
  + determinism (same text+session_key → identical masked + swapmap);
  + CLI e2e subprocess;
  + >=1 UNHAPPY test with an UNHAPPY_TEST_TERMS word + assert.

Provenance: synthetic in-memory fixtures (no real secrets); the pattern set is
production-derived from the live SSOT via `sensitive_pattern_loader.load_patterns()`.
"""
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import prompt_sanitizer as ps  # noqa: E402
import sensitive_pattern_loader as spl  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "prompt_sanitizer.py"
SESSION_KEY = "test-session-key-2.2"


def _patterns():
    return spl.load_patterns(None)


# --- nonce -----------------------------------------------------------------

def test_session_nonce_is_16_hex_and_stable():
    n = ps.session_nonce(SESSION_KEY)
    assert len(n) == 16, len(n)
    assert re.fullmatch(r"[0-9a-f]{16}", n), n
    # HMAC keyed on the session_key: deterministic, and changes with the key.
    assert ps.session_nonce(SESSION_KEY) == n
    assert ps.session_nonce("different-key") != n


def test_session_nonce_rejects_empty_key():
    # Empty/invalid session_key is a typed failure, never a silent default nonce.
    raised = False
    try:
        ps.session_nonce("")
    except ps.SessionKeyError:
        raised = True
    assert raised, "empty session_key must raise SessionKeyError"


# --- (1) NFC normalization (NORMALIZATION / F7) ----------------------------

def test_nfc_normalization_catches_fullwidth_and_nfd_path():
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    # A path written with a full-width solidus U+FF0F. NFC leaves it as-is BUT the
    # canonical-equivalence test below uses an NFD-decomposed home path, which NFC
    # recomposes so the ASCII path pattern matches. The full-width case proves the
    # scan operates on the normalized form rather than the raw bytes.
    nfd_path = unicodedata.normalize("NFD", "/Users/testuser/Documents/café.txt")
    assert nfd_path != unicodedata.normalize("NFC", nfd_path)  # genuinely decomposed
    masked, swap = ps.mask(nfd_path, nonce, patterns)
    assert swap, "NFD path must still be detected after NFC normalization"
    assert ps.residual_scan(masked, patterns) == []
    # find_spans must normalize first: a raw (un-normalized) NFD input still yields spans
    spans = ps.find_spans(nfd_path, patterns)
    assert spans, "find_spans must NFC-normalize before matching"


def test_fullwidth_separator_path_is_not_a_normalization_bypass():
    """UNHAPPY: a sensitive path written with FULLWIDTH solidus U+FF0F must NOT bypass
    the masker. NFC leaves U+FF0F as-is (a confusable-bypass LEAK); only NFKC folds the
    fullwidth look-alikes to ASCII '/' so the PATH pattern matches. An invalid/degraded
    normalization here is a privacy-boundary breach: the cleartext path would reach an
    untrusted delegate. Asserts >=1 span/residual hit AND that the end-to-end masked
    delegate payload does NOT contain the cleartext sensitive substring."""
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    # Fullwidth solidus U+FF0F throughout — a confusable for ASCII '/'. Under the broken
    # NFC normalization this folds to nothing and the scan sees zero spans (the LEAK).
    fullwidth_path = "／Users／qsecret／private"
    assert "／" in fullwidth_path  # genuinely fullwidth, not ASCII
    assert unicodedata.normalize("NFC", fullwidth_path) == fullwidth_path  # NFC is a no-op here
    assert "/Users" in unicodedata.normalize("NFKC", fullwidth_path)  # only NFKC folds it

    # The masker must detect the confusable path: >=1 span and a non-empty swapmap.
    spans = ps.find_spans(fullwidth_path, patterns)
    assert spans, "fullwidth-separator path must yield >=1 span (no confusable bypass)"
    masked, swap = ps.mask(fullwidth_path, nonce, patterns)
    assert swap, "fullwidth-separator path must be masked (swapmap non-empty)"
    # residual_scan over the RAW (un-masked) confusable text must also flag the leak.
    assert ps.residual_scan(fullwidth_path, patterns), "residual_scan must catch the confusable path"
    # After masking, the residual is clean and the cleartext substring is GONE.
    assert ps.residual_scan(masked, patterns) == []
    assert "Users" not in masked, "cleartext 'Users' must not survive masking"
    assert "qsecret" not in masked, "cleartext 'qsecret' must not survive masking"

    # End-to-end masked delegate payload: what an untrusted delegate would actually receive.
    rep = ps.sanitize(fullwidth_path, SESSION_KEY, patterns)
    assert rep["session_key_status"] == "ok"
    delegate_input = rep["masked"]
    assert delegate_input is not None, "a clean mask must produce a delegate payload"
    assert "Users" not in delegate_input, "delegate must NOT receive the cleartext path"
    assert "qsecret" not in delegate_input
    assert rep["report"]["residual_leaks"] == []
    assert rep["report"]["accepted"] is True


def test_residual_scan_normalizes_before_matching():
    patterns = _patterns()
    # An NFD email shape must be caught by residual_scan after NFC folding.
    nfd_email = unicodedata.normalize("NFD", "joé@example.com")
    hits = ps.residual_scan(nfd_email, patterns)
    assert hits, "residual_scan must NFC-normalize before matching"
    for h in hits:
        assert "@example.com" not in h and "joé" not in h, "residual hit must be a label/hash, never raw"


# --- (2) longest-match-first, non-overlapping (MASK-BIJECTION) -------------

def test_longest_match_first_no_repo_substring_leak():
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    text = "see /Users/testuser and also /Users/testuser/agent-runtime-probes here"
    masked, swap = ps.mask(text, nonce, patterns)
    # The longer path must win; no residual fragment of either path survives.
    assert "/Users/testuser" not in masked
    assert "agent-runtime-probes" not in masked
    assert ps.residual_scan(masked, patterns) == []
    assert ps.rehydrate(masked, swap) == unicodedata.normalize("NFC", text)


def test_find_spans_returns_non_overlapping_sorted():
    patterns = _patterns()
    text = "/Users/testuser/agent-runtime-probes and /Users/testuser/other"
    spans = ps.find_spans(text, patterns)
    # sorted by start; strictly non-overlapping
    prev_end = -1
    for start, end, typ in spans:
        assert start >= prev_end, (start, prev_end)
        assert end > start
        assert typ in {"TOKEN", "SECRET", "PATH", "USER", "HOST", "REPO", "ID"}
        prev_end = end


# --- (3) adjacent non-overlapping spans (R11) ------------------------------

def test_adjacent_spans_both_masked_residual_clean():
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    # Two sensitive spans touching with no separator: an absolute path immediately
    # followed by a long hex ID (which is a distinct ID-type entity).
    text = "/var/log/app deadbeefdeadbeef1234"
    masked, swap = ps.mask(text, nonce, patterns)
    assert ps.residual_scan(masked, patterns) == []
    assert ps.rehydrate(masked, swap) == unicodedata.normalize("NFC", text)
    assert len(swap) >= 2, "both adjacent spans must be masked"


# --- (4) injective bijection / byte-identical rehydration ------------------

def test_distinct_entities_distinct_placeholders_coreference_stable():
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    text = "/Users/testuser/a then /Users/testuser/a again then /Users/testuser/b"
    masked, swap = ps.mask(text, nonce, patterns)
    # same entity → same placeholder (coreference); distinct entity → distinct N
    placeholders = re.findall(r"__CAPE_[0-9a-f]{16}_[A-Z]+_\d+__", masked)
    distinct_vals = set(swap.values())
    # /Users/testuser/a appears twice → coreferenced to ONE placeholder; /Users/testuser/b distinct
    assert len(distinct_vals) == 2, distinct_vals
    # swapmap is a bijection: placeholder -> original, all originals distinct
    assert len(swap) == len(set(swap.values()))
    assert ps.rehydrate(masked, swap) == unicodedata.normalize("NFC", text)
    # at least one placeholder repeated (the coreference)
    assert len(placeholders) >= 3


def test_roundtrip_byte_identical_across_fixtures():
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    fixtures = [
        "",  # empty
        "no sensitive content here at all",
        "café ünïcode /Users/testuser/résumé.txt mixed",  # unicode
        "token sk-ABCDEFGH12345678 and ghp_ABCDEFGHIJKLMNOPQRST1234",  # secret-shaped
        "/Users/testuser/a /home/x/b /var/c /opt/d/e/f deadbeefcafe1234",  # path-dense
    ]
    for text in fixtures:
        masked, swap = ps.mask(text, nonce, patterns)
        assert ps.rehydrate(masked, swap) == unicodedata.normalize("NFC", text), text


def test_rehydrate_raises_on_unknown_placeholder():
    raised = False
    try:
        ps.rehydrate("text __CAPE_0000000000000000_PATH_9__ tail", {})
    except ValueError:
        raised = True
    assert raised, "rehydrate must raise ValueError on a placeholder not in swapmap"


# --- (5) collision rejection -----------------------------------------------

def test_collision_in_input_fails_closed():
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    # Input literally contains a placeholder of the SAME nonce/shape that mask() would
    # generate. mask() must fail closed (raise) rather than emit an ambiguous swapmap.
    collide = f"__CAPE_{nonce}_PATH_1__ and /Users/testuser/secret"
    raised = False
    try:
        ps.mask(collide, nonce, patterns)
    except ps.PlaceholderCollisionError:
        raised = True
    assert raised, "a pre-existing placeholder collision must fail closed"


# --- (6) residual threshold ZERO -------------------------------------------

def test_unmasked_email_path_produce_residual_hits():
    patterns = _patterns()
    # No masking applied: residual_scan must report the surviving sensitive shapes,
    # as TYPE labels / hashes, NEVER the raw values.
    leaky = "contact alice@example.com at /Users/testuser/private/notes.txt"
    hits = ps.residual_scan(leaky, patterns)
    assert hits, "un-masked sensitive content must be detected"
    for h in hits:
        assert "alice@example.com" not in h
        assert "/Users/testuser/private" not in h


def test_after_mask_residual_is_empty():
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    leaky = "contact alice@example.com at /Users/testuser/private/notes.txt host build.lab.local"
    masked, _swap = ps.mask(leaky, nonce, patterns)
    assert ps.residual_scan(masked, patterns) == []


# --- (7) session_key invalid → typed status, do NOT mask -------------------

def test_sanitize_invalid_session_key_does_not_mask():
    patterns = _patterns()
    rep = ps.sanitize("/Users/testuser/private", "", patterns)
    assert rep["session_key_status"] == "invalid"
    assert rep["masked"] is None, "must NOT mask with an invalid session_key"
    assert rep["swapmap"] is None


def test_sanitize_valid_session_key_masks_and_reports_metadata():
    patterns = _patterns()
    rep = ps.sanitize("/Users/testuser/private alice@example.com", SESSION_KEY, patterns)
    assert rep["session_key_status"] == "ok"
    assert rep["report"]["residual_leaks"] == []
    assert rep["report"]["roundtrip_ok"] is True
    assert rep["report"]["placeholder_collision"] is False
    assert rep["report"]["nonce_present_in_input"] is False
    # metadata-only: histogram counts, no raw values anywhere in the report
    blob = json.dumps(rep["report"])
    assert "alice@example.com" not in blob
    assert "/Users/testuser/private" not in blob
    assert isinstance(rep["report"]["type_histogram"], dict)
    # placeholder_count counts OCCURRENCES in the masked output; entity_count counts
    # distinct entities. With no repeats they are equal here, but they are now distinct
    # fields carrying genuinely different information (see coreference test below).
    assert rep["report"]["entity_count"] == len(rep["swapmap"])
    assert rep["report"]["placeholder_count"] >= rep["report"]["entity_count"]


def test_placeholder_count_counts_occurrences_exceeds_entity_count_on_repeat():
    # When an entity REPEATS (coreference), placeholder_count (occurrences in the masked
    # output) must EXCEED entity_count (distinct entities). The two fields now carry
    # genuinely different information and can no longer be assumed equal.
    patterns = _patterns()
    rep = ps.sanitize("/Users/testuser/a then /Users/testuser/a again then /Users/testuser/b",
                      SESSION_KEY, patterns)
    report = rep["report"]
    # 2 distinct entities (/Users/testuser/a coreferenced, /Users/testuser/b), but 3 occurrences masked
    assert report["entity_count"] == 2, report["entity_count"]
    assert report["placeholder_count"] == 3, report["placeholder_count"]
    assert report["placeholder_count"] > report["entity_count"]


def test_sanitize_residual_leak_rejects_artifact():
    # If a sensitive shape survives masking, the report marks rejection for B1 fallback.
    patterns = _patterns()
    rep = ps.sanitize("/Users/testuser/private", SESSION_KEY, patterns,
                       _force_residual_leak=True)
    assert rep["report"]["residual_leaks"], "forced residual must surface"
    assert rep["report"]["accepted"] is False, "residual leak must REJECT the masked artifact"


# --- determinism -----------------------------------------------------------

def test_determinism_same_text_key_identical_output():
    patterns = _patterns()
    text = "/Users/testuser/agent-runtime-probes alice@example.com host=db.prod.lan"
    m1, s1 = ps.mask(text, ps.session_nonce(SESSION_KEY), patterns)
    m2, s2 = ps.mask(text, ps.session_nonce(SESSION_KEY), patterns)
    assert m1 == m2
    assert s1 == s2


# --- CLI e2e ---------------------------------------------------------------

def _run_main(argv):
    """Invoke main() in-process with a patched argv; return (rc, parsed_report)."""
    orig = sys.argv
    sys.argv = ["prompt_sanitizer.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = ps.main()
    finally:
        sys.argv = orig
    return rc, json.loads(buf.getvalue())


def test_main_inprocess_ok_artifact_accepted():
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write("/Users/testuser/private alice@example.com")
        artifact = fh.name
    try:
        rc, rep = _run_main(["--text-artifact", artifact, "--session-key", SESSION_KEY, "--pretty"])
        assert rc == 0
        assert rep["input_status"] == "ok"
        assert rep["session_key_status"] == "ok"
        assert rep["accepted"] is True
        assert rep["pattern_source_status"] in {"ok", "missing", "invalid"}
    finally:
        os.unlink(artifact)


def test_main_inprocess_missing_artifact():
    rc, rep = _run_main(["--text-artifact", "/nonexistent-xyz/none.txt", "--session-key", SESSION_KEY])
    assert rc == 1
    assert rep["input_status"] == "missing"
    assert rep["session_key_status"] == "not_evaluated"


def test_main_inprocess_read_error_on_directory():
    # Reading a DIRECTORY as text raises OSError → typed read_error, nonzero.
    d = tempfile.mkdtemp()
    rc, rep = _run_main(["--text-artifact", d, "--session-key", SESSION_KEY])
    assert rc == 1
    assert rep["input_status"] == "read_error"
    assert "error_type" in rep


def test_main_inprocess_invalid_session_key():
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write("/Users/testuser/private")
        artifact = fh.name
    try:
        rc, rep = _run_main(["--text-artifact", artifact, "--session-key", "   "])
        assert rc == 1
        assert rep["session_key_status"] == "invalid"
    finally:
        os.unlink(artifact)


def test_main_inprocess_residual_or_collision_rejects():
    # An input that literally contains a placeholder of the would-be nonce makes mask()
    # raise PlaceholderCollisionError inside sanitize(), which fails closed (rejected).
    nonce = ps.session_nonce(SESSION_KEY)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write(f"__CAPE_{nonce}_PATH_1__ /Users/testuser/x")
        artifact = fh.name
    try:
        rc, rep = _run_main(["--text-artifact", artifact, "--session-key", SESSION_KEY])
        assert rc == 1
        assert rep["session_key_status"] == "ok"
        assert rep["accepted"] is False
        assert rep["placeholder_collision"] is True
    finally:
        os.unlink(artifact)


def test_sanitize_collision_returns_rejected_report():
    # Direct sanitize() collision branch (not just the mask() raise).
    patterns = _patterns()
    nonce = ps.session_nonce(SESSION_KEY)
    rep = ps.sanitize(f"__CAPE_{nonce}_PATH_1__ /Users/testuser/x", SESSION_KEY, patterns)
    assert rep["session_key_status"] == "ok"
    assert rep["masked"] is None
    assert rep["report"]["placeholder_collision"] is True
    assert rep["report"]["accepted"] is False


def test_find_spans_skips_zero_width_match():
    # A pathological zero-width-capable pattern must be skipped, never a 0-length span.
    import sensitive_pattern_loader as _spl
    ps_empty = _spl.PatternSet(
        provider_patterns=[],
        structural_patterns=[("PATH", re.compile(r"(?=/Users)"))],  # zero-width lookahead
        status="ok",
        parse_status="ok",
        checksum_sha256_16=None,
    )
    spans = ps.find_spans("see /Users/testuser here", ps_empty)
    assert spans == [], "zero-width matches must not produce spans"


def test_cli_entrypoint_emits_metadata_only_report():
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write("/Users/testuser/private alice@example.com")
        artifact = fh.name
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH),
             "--text-artifact", artifact, "--session-key", SESSION_KEY, "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        report = json.loads(proc.stdout)
        assert report["schema_version"] == "0.1"
        assert report["redaction"] == "metadata-only"
        assert report["session_key_status"] == "ok"
        assert report["residual_leaks"] == []
        assert report["roundtrip_ok"] is True
        # CLI report must never echo the raw input
        assert "alice@example.com" not in proc.stdout
        assert "/Users/testuser/private" not in proc.stdout
    finally:
        os.unlink(artifact)


def test_cli_missing_artifact_is_typed_nonzero():
    # UNHAPPY: a missing input artifact is a typed nonzero exit, not a synthesized pass.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH),
         "--text-artifact", "/nonexistent-xyz/none.txt", "--session-key", SESSION_KEY],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    report = json.loads(proc.stdout)
    assert report["input_status"] == "missing"


def test_cli_invalid_session_key_is_typed_nonzero():
    # UNHAPPY: empty session_key → invalid status, nonzero, no masking.
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write("/Users/testuser/private")
        artifact = fh.name
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH),
             "--text-artifact", artifact, "--session-key", ""],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode != 0
        report = json.loads(proc.stdout)
        assert report["session_key_status"] == "invalid"
    finally:
        os.unlink(artifact)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} prompt_sanitizer tests passed")
