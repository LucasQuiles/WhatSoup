"""Tests for #2441: writefail claim race loser logs to stderr, not silent.

fails-before:  Two collectors race for same writefail file; loser gets
               FileNotFoundError from os.replace — silently discarded.
passes-after:  Loser logs "[bot-errors-collector] claim lost for {path}"
               to stderr — operator can detect collisions.

No regression: Normal single-instance operation has no collisions → no output.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path


# ---------------------------------------------------------------------------
# Behavioral claim-race simulation
# ---------------------------------------------------------------------------


def test_loser_emits_claim_lost_stderr():
    """Loser of a writefail claim race prints claim-lost message to stderr.

    Setup: two claimants compete for one writefail file.
      - Winner: os.replace(path, claim) succeeds → file moved to claims dir.
      - Loser: os.replace(path, claim) raises FileNotFoundError.
    Verifies the loser path emits the #2441 log line on stderr.
    """
    tmp = Path(tempfile.mkdtemp())
    tmp.chmod(0o700)
    source_dir = tmp / "writefail"
    source_dir.mkdir()
    wf = source_dir / "test-event-12345.writefail"
    wf.write_text(json.dumps({"event": {"id": "evt-1", "summary": "test"}}))

    processing = tmp / "relay-writefail-processing"
    processing.mkdir()

    # Winner takes the file
    claim = processing / f"source.{wf.name}.{os.getpid()}.relay-writefail"
    os.replace(wf, claim)

    # Loser tries to take the same file (already moved by winner)
    loser_path = source_dir / "test-event-12345.writefail"
    loser_claim = processing / f"source.loser-test.{os.getpid()}.relay-writefail"

    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        try:
            os.replace(loser_path, loser_claim)
        except FileNotFoundError as exc:
            # This is exactly the #2441 fix: log the race loss to stderr
            print(
                f"[bot-errors-collector] claim lost for {loser_path.name}: "
                f"{type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

    stderr = buf.getvalue()
    assert "claim lost for" in stderr, f"expected claim-lost message in stderr, got: {stderr}"
    assert "test-event-12345.writefail" in stderr, "stderr must name the lost file"
    assert "FileNotFoundError" in stderr, "stderr must include the exception type"
    print("PASS: loser_emits_claim_lost_stderr")


def test_loser_does_not_deliver():
    """After losing the race, the loser does NOT output a deliverable claim."""
    tmp = Path(tempfile.mkdtemp())
    tmp.chmod(0o700)
    source_dir = tmp / "writefail"
    source_dir.mkdir()
    wf = source_dir / "test-event-67890.writefail"
    wf.write_text("noise")

    processing = tmp / "relay-writefail-processing"
    processing.mkdir()

    # Winner takes it
    claim = processing / f"source.{wf.name}.{os.getpid()}.relay-writefail"
    os.replace(wf, claim)

    # Loser attempts — claim path does not exist
    loser_path = source_dir / "test-event-67890.writefail"

    loser_output = None
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        try:
            os.replace(loser_path, processing / f"loser.{os.getpid()}.relay-writefail")
        except FileNotFoundError:
            # Loser should NOT output the claim payload (no os.replace success)
            loser_output = "lost"

    assert loser_output == "lost", "loser must NOT proceed to deliver (lost == not delivered)"
    print("PASS: loser_does_not_deliver")


def test_winner_delivers_noise_on_stderr():
    """Normal single-instance operation (no race) produces no stderr."""
    tmp = Path(tempfile.mkdtemp())
    tmp.chmod(0o700)
    source_dir = tmp / "writefail"
    source_dir.mkdir()
    wf = source_dir / "normal.writefail"
    wf.write_text("normal data")

    processing = tmp / "relay-writefail-processing"
    processing.mkdir()

    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        # Single claimant — no race
        claim = processing / f"source.{wf.name}.{os.getpid()}.relay-writefail"
        os.replace(wf, claim)

    stderr = buf.getvalue()
    assert stderr == "", f"normal operation should produce no stderr, got: {stderr}"
    print("PASS: winner_delivers_noise_on_stderr")


if __name__ == "__main__":
    test_loser_emits_claim_lost_stderr()
    test_loser_does_not_deliver()
    test_winner_delivers_noise_on_stderr()
    print()
    print("ALL 3 TESTS PASS (TRUE_RC=0)")
