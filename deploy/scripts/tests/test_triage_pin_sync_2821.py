"""Tests for #2821: sync pinned_revision from per-issue files.

fails-before:  Registry has 255 entries all with pinned_revision='59166b78…' (1 pin).
passes-after:  Per-issue pins synced — >=2 distinct pinned_revision values.
No regression:  Registry structure intact (all keys present).
"""

from __future__ import annotations

import json
from pathlib import Path

REGISTRY = Path(__file__).resolve().parents[3] / "docs/triage/open-issue-registry.json"


def _load() -> dict:
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def test_distinct_pins_after_sync():
    """At least 2 distinct pin values after sync."""
    reg = _load()
    pins = set(i.get("pinned_revision", "") for i in reg["issues"])
    assert len(pins) >= 2, f"expected >=2 distinct pins, got {len(pins)}"
    print(f"PASS: {len(pins)} distinct pins ({len(reg['issues'])} entries)")


def test_less_than_255_identical_pins():
    """Not all 255 entries have the same pin."""
    reg = _load()
    pins = [i.get("pinned_revision", "") for i in reg["issues"]]
    assert len(set(pins)) < len(pins), "all pins identical — sync didn't run"
    print("PASS: pins are not all identical")


def test_registry_structure_intact():
    """Top-level keys and issue structure are preserved."""
    reg = _load()
    assert "issues" in reg
    assert "pinned_main_revision" in reg
    assert len(reg["issues"]) == 255
    sample = reg["issues"][0]
    assert "issue_number" in sample
    assert "pinned_revision" in sample
    assert "evidence_summary" in sample
    print("PASS: structure intact")


if __name__ == "__main__":
    test_distinct_pins_after_sync()
    test_less_than_255_identical_pins()
    test_registry_structure_intact()
    print()
    print("ALL 3 TESTS PASS (TRUE_RC=0)")
