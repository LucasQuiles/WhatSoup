"""Tests for #2136: correlate log tails to alert source before attaching as evidence.

fails-before:  build_evidence attaches all stdout/stderr lines regardless of
               whether they belong to the current alert (stale content dilutes
               signal).
passes-after:  correlate_tail filters to source-matching lines only, so only
               the current alert's output is attached.

No regression: text with all matching lines passes through unmodified.
No regression: empty text returns empty.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_runner_2136",
        _SCRIPT_ROOT / "bot-errors-runner.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# correlate_tail unit tests
# ---------------------------------------------------------------------------


class TestCorrelateTail:
    """correlate_tail filters lines to those matching the alert source."""

    def test_old_stderr_lines_are_filtered_out(self):
        """Stderr with 200 old lines + 2 current lines — only current survives."""
        mod = _load_module()
        old_lines = [
            f"old-failure-{i}: something went wrong in module_x" for i in range(200)
        ]
        current_lines = [
            "current-alert: BOT ERRORS runner detected timeout on instance=line-alpha",
            "current-alert: action=restart duration_ms=34000 exit_code=-1",
        ]
        text = "\n".join(old_lines + current_lines)

        result = mod.correlate_tail(text, "current-alert")

        lines = result.split("\n")
        assert len(lines) == 2, f"expected 2 lines, got {len(lines)}"
        assert all("current-alert" in line for line in lines)
        assert all("old-failure" not in line for line in lines)

    def test_all_matching_lines_pass_through(self):
        """No-regression: text with all matching lines is unchanged."""
        mod = _load_module()
        lines = [
            "watchdog: check pass for instance=alpha",
            "watchdog: check pass for instance=beta",
        ]
        text = "\n".join(lines)

        result = mod.correlate_tail(text, "watchdog")

        assert result == text, "all lines match source — must pass through unchanged"

    def test_empty_text_returns_empty(self):
        """No-regression: empty text returns empty string."""
        mod = _load_module()
        assert mod.correlate_tail("", "anything") == ""

    def test_no_matching_lines_returns_empty(self):
        """Correlated text with no matching source returns empty."""
        mod = _load_module()
        text = "unrelated: something happened\nother: different error"
        result = mod.correlate_tail(text, "my-alert")
        assert result == "", "no lines match the source"

    def test_source_is_part_of_word(self):
        """Source matching uses substring — 'alert' matches 'my-alert-line'."""
        mod = _load_module()
        text = "my-alert-line: test output\nother: noise"
        result = mod.correlate_tail(text, "alert")
        assert result == "my-alert-line: test output"
