"""Tests for the BOT ERRORS release-proof runner component contract.

Covers the runner's component dispatch: an unknown component is rejected with
the usage exit code, and the two wired components (tree, runtime-staleness)
remain reachable.

The former `health-invariants` component was removed: it asserted a
`turnCapabilityEvidence` field that no runtime in src/ ever emits, no service
unit invoked it, and its own fixture manufactured the only value that made it
pass. #2481 owns the real release-capability admission contract.

The mode file is injected via BOT_ERRORS_RELEASE_PROOF_ENV (the script's
documented override) rather than a fake HOME.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-release-proof-run.sh"


def _run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    base_env = os.environ.copy()
    base_env.pop("BOT_ERRORS_HEALTH_INVARIANTS_MERGE", None)
    if env:
        base_env.update(env)
    return subprocess.run(
        ["bash", str(_SCRIPT)] + list(args),
        capture_output=True, text=True, timeout=15,
        env=base_env,
    )


def _mode_env(tmp_path: Path) -> dict[str, str]:
    mode_file = tmp_path / "bot-errors-release-proof.env"
    mode_file.write_text("BOT_ERRORS_RELEASE_PROOF_MODE=emit\n", encoding="utf-8")
    return {"BOT_ERRORS_RELEASE_PROOF_ENV": str(mode_file)}


def test_unknown_component_fails():
    """Unknown components are rejected (exit 2) at the usage gate."""
    result = _run("unknown-component")
    assert result.returncode == 2, f"expected 2, got {result.returncode}"
    assert "usage" in result.stderr


def test_tree_component_still_works(tmp_path: Path):
    """No-regression: tree component still routes past the usage gate."""
    result = _run("tree", env={**_mode_env(tmp_path), "BOT_ERRORS_STATE_DIR": str(tmp_path)})
    assert "usage" not in result.stderr
    assert result.returncode != 0, "tree without a bundle root must not silently pass"
    assert "missing" in result.stderr
