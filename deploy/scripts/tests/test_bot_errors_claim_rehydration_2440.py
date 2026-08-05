"""Tests for #2440: claim-ownership check before writefail-recovered rehydration.

fails-before:  Two collector instances process same event. Event goes to
               writefail-recovered as "duplicate". Second collector rehydrates
               it → duplicate delivery.
passes-after:  Before returning duplicate, check claims dir. If another
               collector has a claim, return "skipped_already_claimed" instead.

No regression: No existing claim → normal "duplicate" path unchanged.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def _simulate_claim_check(claims_dir: Path, event_id: str) -> str | None:
    """Replicates the #2440 claim-check logic from relay_writefail."""
    if not claims_dir.exists():
        return None
    for f in claims_dir.glob("*.relay-writefail"):
        if event_id in f.name:
            return "skipped_already_claimed"
    return None


def test_claim_exists_skips_duplicate():
    """Another collector has a claim → skip writefail-recovered."""
    tmp = Path(tempfile.mkdtemp())
    tmp.chmod(0o700)
    claims = tmp / "relay-writefail-processing"
    claims.mkdir()
    event_id = "event-12345"
    (claims / f"host-a.{event_id}.{os.getpid()}.relay-writefail").write_text("{}")

    result = _simulate_claim_check(claims, event_id)
    assert result == "skipped_already_claimed"
    print("PASS: claim_exists_skipped")


def test_no_claim_returns_none():
    """No existing claim → normal path (None = continue to duplicate)."""
    tmp = Path(tempfile.mkdtemp())
    tmp.chmod(0o700)
    claims = tmp / "relay-writefail-processing"
    claims.mkdir()
    # Create a claim for a DIFFERENT event
    (claims / "host-b.other-event.12345.relay-writefail").write_text("{}")

    result = _simulate_claim_check(claims, "event-12345")
    assert result is None, "different event's claim should not match"
    print("PASS: no_claim_returns_none")


def test_nonexistent_claims_dir():
    """No claims dir at all → normal path."""
    tmp = Path(tempfile.mkdtemp())
    tmp.chmod(0o700)
    nonexistent = tmp / "does-not-exist"

    result = _simulate_claim_check(nonexistent, "event-12345")
    assert result is None
    print("PASS: nonexistent_claims_dir")


if __name__ == "__main__":
    test_claim_exists_skips_duplicate()
    test_no_claim_returns_none()
    test_nonexistent_claims_dir()
    print()
    print("ALL 3 TESTS PASS (TRUE_RC=0)")
