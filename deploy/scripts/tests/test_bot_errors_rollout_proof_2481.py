"""Tests for #2481: rollout proof health-invariants admission check.

fails-before:  release-proof-run.sh has no health-invariants check — a runtime
               without #2446 health invariants passes unnoticed.
passes-after:  health-invariants component verifies the health endpoint and
               fails (non-zero) when invariants are missing or unreachable.

No regression: tree and runtime-staleness components are unaffected.
No regression: runtime with merged invariants passes (exit 0).

The mode file is injected via BOT_ERRORS_RELEASE_PROOF_ENV (the script's
documented override) rather than a fake HOME, and mock health endpoints run
serve_forever on a thread so an early script exit can never deadlock teardown.
"""

from __future__ import annotations

import http.server
import json
import os
import subprocess
import threading
from contextlib import contextmanager
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


@contextmanager
def _health_endpoint(payload: dict):
    # Compact separators mirror the runtime's JSON.stringify output — the
    # script greps for the compact form, so spaced JSON would false-negative.
    body = json.dumps(payload, separators=(",", ":")).encode()

    class MockHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), MockHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_unknown_component_fails():
    """Unknown components are rejected (exit 2) at the usage gate."""
    result = _run("unknown-component")
    assert result.returncode == 2, f"expected 2, got {result.returncode}"
    assert "usage" in result.stderr


def test_health_invariants_is_accepted(tmp_path: Path):
    """health-invariants passes component validation and reaches the check.

    With no endpoint and no provenance merge configured the component itself
    reports FAIL/unreachable on stdout (exit 2) — NOT the usage error, and NOT
    the missing-mode-file error.
    """
    result = _run("health-invariants", env=_mode_env(tmp_path))
    assert "usage" not in result.stderr
    assert "missing mode file" not in result.stderr
    assert result.returncode == 2, f"expected unreachable fallback 2, got {result.returncode}"
    assert "health invariants not satisfied" in result.stdout


def test_health_invariants_with_mock_endpoint(tmp_path: Path):
    """When the health endpoint carries turnCapabilityEvidence, exit 0."""
    with _health_endpoint({"healthy": True, "turnCapabilityEvidence": "affirmative"}) as port:
        result = _run(
            "health-invariants",
            env={**_mode_env(tmp_path), "BOT_ERRORS_HEALTH_PORT": str(port)},
        )
    assert result.returncode == 0, f"expected 0, got {result.returncode}: {result.stdout} {result.stderr}"
    assert "OK" in result.stdout


def test_health_invariants_missing_field(tmp_path: Path):
    """When the health endpoint lacks turnCapabilityEvidence, exit 1."""
    with _health_endpoint({"healthy": True}) as port:
        result = _run(
            "health-invariants",
            env={**_mode_env(tmp_path), "BOT_ERRORS_HEALTH_PORT": str(port)},
        )
    assert result.returncode == 1, f"expected 1, got {result.returncode}: {result.stdout} {result.stderr}"
    assert "FAIL" in result.stdout


def test_tree_component_still_works(tmp_path: Path):
    """No-regression: tree component still routes past the usage gate."""
    result = _run("tree", env={**_mode_env(tmp_path), "BOT_ERRORS_STATE_DIR": str(tmp_path)})
    assert "usage" not in result.stderr
    assert result.returncode != 0, "tree without a bundle root must not silently pass"
    assert "missing" in result.stderr
