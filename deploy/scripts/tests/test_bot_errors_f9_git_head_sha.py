"""Tests for F9 (second half): git_head_sha runtime-skew observable.

Contract:
- No expected_head_sha → observability line, no FAIL/WARN prefix.
- Expected matches real HEAD (full or prefix) → match line, no FAIL.
- Expected present and mismatched → FAIL line with git_head_sha_mismatch.
- Malformed expected_head_sha → WARN, no FAIL (observability line still omitted).
- Git failure / non-repo / unavailable → WARN, not FAIL.
"""
from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _real_head_sha() -> str:
    """Return the real HEAD sha of the repo under test (REPO_ROOT)."""
    proc = subprocess.run(
        ["git", "-C", str(_mod.REPO_ROOT), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip().lower()


def _manifest(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    m: dict[str, Any] = {"schemaVersion": 1}
    if extra:
        m.update(extra)
    return m


def _fake_runner(stdout: str, stderr: str = "", rc: int = 0):
    """Return a _run_git_rev_parse replacement that emits fixed values."""
    def _inner(repo_root: Path) -> tuple[str, str, int]:
        return stdout, stderr, rc
    return _inner


# ---------------------------------------------------------------------------
# (a) No expected → observability line, no FAIL
# ---------------------------------------------------------------------------

class TestNoExpected:
    def test_observability_line_emitted(self):
        """Without expected_head_sha, a plain line is emitted with expected=unset."""
        head = _real_head_sha()
        line = _mod.git_head_sha_line(_manifest())
        assert line.startswith("git_head_sha:"), (
            f"Line should start with 'git_head_sha:' (no FAIL/WARN), got: {line!r}"
        )
        assert "expected=unset" in line, f"Line should contain expected=unset: {line!r}"
        assert head in line, f"Line should contain actual HEAD sha {head!r}: {line!r}"

    def test_no_fail_prefix(self):
        """No FAIL prefix when expected is absent."""
        line = _mod.git_head_sha_line(_manifest())
        assert not line.startswith("FAIL"), f"Should not FAIL with no expected: {line!r}"

    def test_no_warn_prefix_on_success(self):
        """No WARN prefix when git works and expected is absent."""
        line = _mod.git_head_sha_line(_manifest())
        assert not line.startswith("WARN"), f"Should not WARN with no expected and working git: {line!r}"


# ---------------------------------------------------------------------------
# (b) Expected matches real HEAD → match line, no FAIL
# ---------------------------------------------------------------------------

class TestExpectedMatches:
    def test_full_sha_match(self):
        """Full 40-char expected sha that matches HEAD → match line, no FAIL."""
        head = _real_head_sha()
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": head}))
        assert "match" in line, f"Line should contain 'match': {line!r}"
        assert not line.startswith("FAIL"), f"Should not FAIL on match: {line!r}"

    def test_short_prefix_match(self):
        """Short 7-char prefix of HEAD → match line."""
        head = _real_head_sha()
        short = head[:7]
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": short}))
        assert "match" in line, f"Line should contain 'match' for prefix: {line!r}"
        assert not line.startswith("FAIL"), f"Should not FAIL on prefix match: {line!r}"

    def test_match_is_case_insensitive(self):
        """Expected sha in uppercase is matched case-insensitively."""
        head = _real_head_sha()
        upper = head.upper()
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": upper}))
        assert "match" in line, f"Upper-case expected should still match: {line!r}"
        assert not line.startswith("FAIL"), f"Should not FAIL on case-insensitive match: {line!r}"


# ---------------------------------------------------------------------------
# (c) Expected present and mismatched → FAIL with git_head_sha_mismatch
# ---------------------------------------------------------------------------

class TestExpectedMismatch:
    def test_mismatch_emits_fail(self):
        """A known-wrong expected sha produces a FAIL line with git_head_sha_mismatch."""
        # Use a 40-char sha that cannot match any real HEAD
        wrong = "deadbeef" * 5  # 40-char hex, unlikely to match
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": wrong}))
        assert line.startswith("FAIL "), f"Line should start with 'FAIL ': {line!r}"
        assert "git_head_sha_mismatch" in line, (
            f"Line should contain 'git_head_sha_mismatch': {line!r}"
        )

    def test_mismatch_includes_actual_and_expected(self):
        """FAIL line includes both the actual sha and the wrong expected sha."""
        wrong = "cafebabe" * 5
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": wrong}))
        actual = _real_head_sha()
        assert actual in line, f"FAIL line should include actual sha {actual!r}: {line!r}"
        assert wrong.lower() in line, f"FAIL line should include expected sha: {line!r}"

    def test_mismatch_via_monkeypatched_runner(self):
        """Simulate mismatched sha via monkeypatched git runner."""
        fake_sha = "a" * 40
        mod = _load_module()
        wrong_expected = "b" * 40
        with patch.object(mod, "_run_git_rev_parse", _fake_runner(fake_sha + "\n")):
            line = mod.git_head_sha_line(_manifest({"expected_head_sha": wrong_expected}))
        assert line.startswith("FAIL "), f"Should FAIL on mismatch: {line!r}"
        assert "git_head_sha_mismatch" in line, f"Should contain git_head_sha_mismatch: {line!r}"


# ---------------------------------------------------------------------------
# (d) Malformed expected_head_sha → WARN, no FAIL
# ---------------------------------------------------------------------------

class TestMalformedExpected:
    def test_non_hex_string_warns(self):
        """A non-hex string in expected_head_sha emits WARN, not FAIL."""
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": "not-a-sha!"}))
        assert line.startswith("WARN "), f"Malformed expected should WARN: {line!r}"
        assert not line.startswith("FAIL"), f"Should not FAIL for malformed expected: {line!r}"

    def test_too_short_string_warns(self):
        """A hex string shorter than 7 chars (invalid short sha) emits WARN."""
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": "abc123"}))  # 6 chars
        assert line.startswith("WARN "), f"Too-short sha should WARN: {line!r}"

    def test_non_string_value_warns(self):
        """A non-string expected_head_sha (e.g. integer) emits WARN."""
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": 12345}))
        assert line.startswith("WARN "), f"Non-string expected should WARN: {line!r}"

    def test_malformed_contains_redacted(self):
        """WARN line for malformed expected contains '<redacted>' (not the raw value)."""
        line = _mod.git_head_sha_line(_manifest({"expected_head_sha": "s3cr3t!not-hex"}))
        assert "<redacted>" in line, f"Malformed WARN should redact the value: {line!r}"


# ---------------------------------------------------------------------------
# (e) Git failure paths → WARN, not FAIL
# ---------------------------------------------------------------------------

class TestGitFailurePaths:
    def test_git_unavailable_warns(self):
        """FileNotFoundError from git binary absence → WARN git_unavailable."""
        mod = _load_module()

        def _raise_not_found(repo_root: Path) -> tuple[str, str, int]:
            raise FileNotFoundError("git not found")

        with patch.object(mod, "_run_git_rev_parse", _raise_not_found):
            line = mod.git_head_sha_line(_manifest())
        assert line.startswith("WARN "), f"git unavailable should WARN: {line!r}"
        assert "git_unavailable" in line, f"Should mention git_unavailable: {line!r}"

    def test_git_timeout_warns(self):
        """TimeoutExpired → WARN git_rev_parse_timeout."""
        mod = _load_module()

        def _raise_timeout(repo_root: Path) -> tuple[str, str, int]:
            raise subprocess.TimeoutExpired(cmd=["git", "rev-parse", "HEAD"], timeout=10)

        with patch.object(mod, "_run_git_rev_parse", _raise_timeout):
            line = mod.git_head_sha_line(_manifest())
        assert line.startswith("WARN "), f"git timeout should WARN: {line!r}"
        assert "timeout" in line, f"Should mention timeout: {line!r}"

    def test_git_nonzero_rc_warns(self):
        """Non-zero returncode → WARN."""
        mod = _load_module()
        with patch.object(mod, "_run_git_rev_parse", _fake_runner("", "error: not a git repo\n", rc=128)):
            line = mod.git_head_sha_line(_manifest())
        assert line.startswith("WARN "), f"Non-zero rc should WARN: {line!r}"

    def test_git_not_a_repo_warns(self):
        """'not a git repository' in stderr → WARN not_a_git_repository."""
        mod = _load_module()
        with patch.object(mod, "_run_git_rev_parse", _fake_runner("", "fatal: not a git repository", rc=128)):
            line = mod.git_head_sha_line(_manifest())
        assert line.startswith("WARN "), f"Not-a-repo should WARN: {line!r}"
        assert "not_a_git_repository" in line, f"Should mention not_a_git_repository: {line!r}"

    def test_git_unexpected_output_warns(self):
        """git succeeds (rc=0) but output is not a sha → WARN unexpected_output."""
        mod = _load_module()
        with patch.object(mod, "_run_git_rev_parse", _fake_runner("not-a-sha-at-all\n")):
            line = mod.git_head_sha_line(_manifest())
        assert line.startswith("WARN "), f"Non-sha output should WARN: {line!r}"
        assert "unexpected_output" in line, f"Should mention unexpected_output: {line!r}"

    def test_git_failure_does_not_fail_when_expected_set(self):
        """Even with expected_head_sha set, a git failure produces WARN (not FAIL)."""
        mod = _load_module()

        def _raise_not_found(repo_root: Path) -> tuple[str, str, int]:
            raise FileNotFoundError("git not found")

        with patch.object(mod, "_run_git_rev_parse", _raise_not_found):
            line = mod.git_head_sha_line(_manifest({"expected_head_sha": "a" * 40}))
        assert line.startswith("WARN "), f"git failure must WARN even with expected set: {line!r}"
        assert not line.startswith("FAIL"), f"Should not FAIL on git error: {line!r}"


# ---------------------------------------------------------------------------
# (f) _run_git_rev_parse uses --no-optional-locks
# ---------------------------------------------------------------------------

class TestRunGitRevParseNoOptionalLocks:
    def test_run_git_rev_parse_uses_no_optional_locks(self, tmp_path, monkeypatch):
        """_run_git_rev_parse must pass --no-optional-locks to git command."""
        calls: list[list[str]] = []

        class _Proc:
            stdout = "a" * 40 + "\n"
            stderr = ""
            returncode = 0

        def fake_run(argv, **kwargs):
            calls.append(list(argv))
            return _Proc()

        monkeypatch.setattr(_mod.subprocess, "run", fake_run)
        _mod._run_git_rev_parse(tmp_path)
        assert calls, "expected a git invocation"
        assert calls[0][:2] == ["git", "--no-optional-locks"]
