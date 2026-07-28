"""P0-8B: deploy.sh sha() tool failure must produce SHA_ERROR not DRIFT.

Before fix: sha() suppresses stderr and returns empty string on failure;
caller classifies "" != want as DRIFT — same label as content mismatch.

After fix: sha() emits SHA_FAILED + returns rc=1; caller emits SHA_ERROR,
not DRIFT, for unreadable/unhashable files.

These tests call bash against the actual deploy script to verify real behavior.
Run from the repo root.
"""
from __future__ import annotations

import os
import stat as stat_mod
import subprocess
import sys
from pathlib import Path

import pytest


_DEPLOY_SH = Path(__file__).resolve().parents[1] / "whatsoup-bot-errors-deploy.sh"
# deploy/scripts/tests/test_*.py → parents: [0]=tests, [1]=scripts, [2]=deploy, [3]=repo_root
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _bash_verify(root: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(_DEPLOY_SH), "verify", str(root)],
        capture_output=True,
        text=True,
    )


def test_sha_tool_failure_emits_sha_error_not_drift(tmp_path: Path):
    """An unreadable file that passes the -f test must produce SHA_ERROR, not DRIFT.

    Before fix: sha() returns empty string; empty != want -> "DRIFT  path got=".
    After fix: sha() emits SHA_FAILED + rc=1; caller branch emits SHA_ERROR.
    """
    # Mirror the exact structure that do_verify() expects
    target_dir = tmp_path / "deploy" / "scripts" / "lib"
    target_dir.mkdir(parents=True)

    # Create bot_errors_redaction.py as a readable file (needed for smoke_redaction skipped by verify)
    # We need every FILES entry present, but only need one to be unreadable.
    # Easiest: populate all files from repo, then chmod one to 0o000.
    files_in_deployer = [
        "deploy/scripts/bot-errors-dispatcher.py",
        "deploy/scripts/bot-errors-health-check.py",
        "deploy/scripts/bot-errors-heartbeat-watchdog.py",
        "deploy/scripts/bot-errors-q-loop.py",
        "src/lib/bot-errors-outbox.ts",
        "src/lib/fault-taxonomy-registry.json",
        "deploy/scripts/bot-errors-collector.py",
        "deploy/scripts/bot-errors-emit.py",
        "deploy/scripts/bot-errors-runner.py",
        "deploy/scripts/lib/__init__.py",
        "deploy/scripts/lib/bot_errors_redaction.py",
        "deploy/scripts/lib/bot_errors_daily_health.py",
        "deploy/scripts/lib/bot_errors_roster.py",
    ]

    # Copy real files from repo root so the structure is valid,
    # then chmod the first one to 0o000 to trigger a sha tool failure.
    for rel in files_in_deployer:
        src = _REPO_ROOT / rel
        dst = tmp_path / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.exists():
            dst.write_bytes(src.read_bytes())
        else:
            dst.write_bytes(b"placeholder\n")

    # Make the first file unreadable — passes -f test but sha tool fails
    target_file = tmp_path / files_in_deployer[0]
    target_file.chmod(0o000)

    try:
        result = _bash_verify(tmp_path)
    finally:
        # Restore so tmp cleanup works
        target_file.chmod(0o644)

    # FAILING before fix: "DRIFT" appears for bot-errors-dispatcher.py
    # After fix: "SHA_ERROR" appears; "DRIFT" does NOT appear for this path
    lines_for_file = [
        line for line in result.stdout.splitlines()
        if "bot-errors-dispatcher" in line
    ]
    assert lines_for_file, (
        f"Expected output for bot-errors-dispatcher.py, got stdout:\n{result.stdout}"
    )
    assert not any("DRIFT" in line for line in lines_for_file), (
        f"Unreadable file must NOT produce DRIFT (that confuses hash failure with content mismatch). "
        f"Got lines: {lines_for_file}\nFull stdout:\n{result.stdout}"
    )
    assert any("SHA_ERROR" in line for line in lines_for_file), (
        f"Expected SHA_ERROR for unreadable file, got lines: {lines_for_file}\nFull stdout:\n{result.stdout}"
    )


def test_sha_tool_failure_sets_nonzero_exit(tmp_path: Path):
    """deploy.sh verify must exit non-zero when sha() fails (SHA_ERROR path sets fail=1)."""
    files_in_deployer = [
        "deploy/scripts/bot-errors-dispatcher.py",
        "deploy/scripts/bot-errors-health-check.py",
        "deploy/scripts/bot-errors-heartbeat-watchdog.py",
        "deploy/scripts/bot-errors-q-loop.py",
        "src/lib/bot-errors-outbox.ts",
        "src/lib/fault-taxonomy-registry.json",
        "deploy/scripts/bot-errors-collector.py",
        "deploy/scripts/bot-errors-emit.py",
        "deploy/scripts/bot-errors-runner.py",
        "deploy/scripts/lib/__init__.py",
        "deploy/scripts/lib/bot_errors_redaction.py",
        "deploy/scripts/lib/bot_errors_daily_health.py",
        "deploy/scripts/lib/bot_errors_roster.py",
    ]
    for rel in files_in_deployer:
        src = _REPO_ROOT / rel
        dst = tmp_path / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.exists():
            dst.write_bytes(src.read_bytes())
        else:
            dst.write_bytes(b"placeholder\n")

    target_file = tmp_path / files_in_deployer[0]
    target_file.chmod(0o000)

    try:
        result = _bash_verify(tmp_path)
    finally:
        target_file.chmod(0o644)

    # Both before and after fix, exit code must be non-zero when a file can't be hashed.
    # Before fix it exits non-zero via DRIFT; after fix via SHA_ERROR. Both are fail=1.
    assert result.returncode != 0, (
        f"Expected non-zero exit for unreadable file, got rc={result.returncode}"
    )


def test_matching_files_still_emit_match_not_sha_error(tmp_path: Path):
    """Regression: clean verifiable root must still show MATCH, not SHA_ERROR."""
    # Use the live repo root — all files are readable and match pinned hashes
    result = _bash_verify(_REPO_ROOT)
    stdout = result.stdout
    assert result.returncode == 0, (
        f"verify of repo root should pass, rc={result.returncode}\n{stdout}"
    )
    assert "SHA_ERROR" not in stdout, (
        f"No SHA_ERROR expected for clean readable files, got:\n{stdout}"
    )
    # Every managed file should be MATCH
    match_lines = [l for l in stdout.splitlines() if "MATCH" in l]
    assert len(match_lines) == 14, (
        f"Expected 14 MATCH lines for clean repo root, got {len(match_lines)}:\n{stdout}"
    )
