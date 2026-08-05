"""Tests for #2439: truncate_evidence preserves head context.

fails-before:  truncate returns only the last limit chars — evidence header
               (source=, instance=, failure=) is lost.
passes-after:  truncate_evidence keeps the first limit/2 chars (context) and
               last limit/2 chars (tail) with a truncation marker.

No regression: short output (< limit) unchanged.
No regression: output exactly = limit unchanged.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-runner.py"


def _load_mod():
    spec = importlib.util.spec_from_file_location("runner_2439", str(_SCRIPT))
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# truncate_evidence unit tests
# ---------------------------------------------------------------------------


class TestTruncateEvidence:
    """truncate_evidence preserves context while limiting size."""

    def test_short_output_unchanged(self):
        """No-regression: output under limit passes through unchanged."""
        mod = _load_mod()
        text = "failure=test\nsource=watchdog\ninstance=alpha"
        result = mod.truncate_evidence(text, 5000)
        assert result == text
        print("PASS: short_output_unchanged")

    def test_exact_limit_unchanged(self):
        """No-regression: output exactly at limit passes through unchanged."""
        mod = _load_mod()
        text = "x" * 2000
        result = mod.truncate_evidence(text, 2000)
        assert result == text
        assert len(result) == 2000
        print("PASS: exact_limit_unchanged")

    def test_head_context_preserved(self):
        """Long output preserves first half (context header) and last half (tail)."""
        mod = _load_mod()
        # 5000-char output with 2000-char header + 3000-char tail; limit=2000
        header = "failure=test\nsource=watchdog\ninstance=alpha\n" + "context_" * 490
        tail = "output_data_" * 500
        text = header + tail
        assert len(text) > 2000, "test precondition: text must exceed limit"

        result = mod.truncate_evidence(text, 2000)

        # Result should be approximately 2000 + marker length
        assert len(result) <= 2000 + 25  # allow marker overhead

        # First part should contain the header context
        assert "failure=test" in result[:1000], "head context must be preserved"
        assert "source=watchdog" in result[:1000]

        # Last part should contain the tail data
        assert result.endswith(tail[-1000:]), "recent tail must be preserved"

        # Truncation marker should be present
        assert "[truncated]" in result
        print("PASS: head_context_preserved")

    def test_marker_inserted_at_truncation(self):
        """The truncation marker [truncated] is present in truncated output."""
        mod = _load_mod()
        text = "A" * 3000
        result = mod.truncate_evidence(text, 1000)
        assert "[truncated]" in result
        # Marker should be between head and tail
        parts = result.split("[truncated]")
        assert len(parts) == 2
        assert len(parts[0]) <= 510, f"head too long: {len(parts[0])}"
        assert "AAA" in parts[0], f"head should contain input: {parts[0][:20]}"
        assert "AAA" in parts[1], f"tail should contain input: {parts[1][:20]}"
        assert len(parts[1]) <= 510, f"tail too long: {len(parts[1])}"
        print("PASS: marker_inserted")


if __name__ == "__main__":
    t = TestTruncateEvidence()
    t.test_short_output_unchanged()
    t.test_exact_limit_unchanged()
    t.test_head_context_preserved()
    t.test_marker_inserted_at_truncation()
    print()
    print("ALL 4 TESTS PASS (TRUE_RC=0)")
