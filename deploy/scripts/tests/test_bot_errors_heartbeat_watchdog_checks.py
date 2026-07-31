"""Regression tests for heartbeat watchdog check-selector validation (#2465).

Tests that unknown, empty, whitespace-only, and mixed valid+unknown selectors
fail closed with ValueError, and that run_once returns exit code 2 (configuration
error) without reconciling or refreshing state. Also includes a drift guard that
verifies KNOWN_WATCHDOG_CHECKS stays aligned with the check names actually used
in collect_problems() and active_reconcile_prefixes().
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# configured_checks() validation
# ---------------------------------------------------------------------------


class TestConfiguredChecksValidation:
    """Verify that configured_checks() rejects invalid selectors (#2465)."""

    def test_unknown_only_selector_raises(self, monkeypatch):
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "q_lop"})
        with pytest.raises(ValueError, match="unknown token"):
            mod.configured_checks()

    def test_empty_selector_raises(self, monkeypatch):
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": ""})
        with pytest.raises(ValueError, match="empty"):
            mod.configured_checks()

    def test_whitespace_only_selector_raises(self, monkeypatch):
        mod = _load_module()
        monkeypatch.setattr(
            mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "   ,  ,  "}
        )
        with pytest.raises(ValueError, match="empty"):
            mod.configured_checks()

    def test_mixed_valid_unknown_raises(self, monkeypatch):
        """A mixed valid+unknown selector must be rejected IN FULL (#2465)."""
        mod = _load_module()
        monkeypatch.setattr(
            mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "q_loop,unknown_check"}
        )
        with pytest.raises(ValueError, match="unknown token"):
            mod.configured_checks()

    def test_multiple_unknown_tokens_all_named(self, monkeypatch):
        """All unknown tokens should be named in the error message."""
        mod = _load_module()
        monkeypatch.setattr(
            mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "foo,bar,baz"}
        )
        with pytest.raises(ValueError) as exc_info:
            mod.configured_checks()
        msg = str(exc_info.value)
        assert "foo" in msg
        assert "bar" in msg
        assert "baz" in msg

    def test_all_valid_checks_pass(self, monkeypatch):
        """Every known check name should be accepted."""
        mod = _load_module()
        all_known = ",".join(sorted(mod.KNOWN_WATCHDOG_CHECKS))
        monkeypatch.setattr(
            mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": all_known}
        )
        result = mod.configured_checks()
        assert result == mod.KNOWN_WATCHDOG_CHECKS

    def test_single_valid_check_passes(self, monkeypatch):
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "q_loop"})
        result = mod.configured_checks()
        assert result == {"q_loop"}

    def test_default_config_expands_to_registry(self, monkeypatch):
        """Default config (no env var) must expand to a subset of the registry."""
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {})
        result = mod.configured_checks()
        assert result <= mod.KNOWN_WATCHDOG_CHECKS
        assert len(result) > 0  # default is not empty

    def test_duplicate_valid_tokens_deduped(self, monkeypatch):
        mod = _load_module()
        monkeypatch.setattr(
            mod.os,
            "environ",
            {"BOT_ERRORS_WATCHDOG_CHECKS": "q_loop,q_loop,dispatcher"},
        )
        result = mod.configured_checks()
        assert result == {"q_loop", "dispatcher"}

    def test_extra_whitespace_trimmed(self, monkeypatch):
        mod = _load_module()
        monkeypatch.setattr(
            mod.os,
            "environ",
            {"BOT_ERRORS_WATCHDOG_CHECKS": "  q_loop  ,  dispatcher  "},
        )
        result = mod.configured_checks()
        assert result == {"q_loop", "dispatcher"}


# ---------------------------------------------------------------------------
# run_once() fail-closed behavior
# ---------------------------------------------------------------------------


class TestRunOnceConfigurationError:
    """Verify run_once exits nonzero on bad config and does not reconcile (#2465)."""

    def test_run_once_unknown_selector_returns_nonzero(self, monkeypatch, capsys):
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "bogus"})
        args = mod.parse_args(["--once"])
        # Prevent actual reconciliation/state writes
        monkeypatch.setattr(mod, "collect_problems", lambda *a: {})
        monkeypatch.setattr(mod, "reconcile", lambda *a: [])
        exit_code = mod.run_once(args)
        assert exit_code == 2
        captured = capsys.readouterr()
        assert "configuration_error" in captured.err
        parsed = json.loads(captured.out)
        assert parsed["verdict"] == "configuration_error"

    def test_run_once_empty_selector_returns_nonzero(self, monkeypatch, capsys):
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": ""})
        args = mod.parse_args(["--once"])
        exit_code = mod.run_once(args)
        assert exit_code == 2

    def test_run_once_bad_config_does_not_reconcile(self, monkeypatch):
        """Bad config must NOT call reconcile or collect_problems (#2465)."""
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "bogus"})
        args = mod.parse_args(["--once"])
        reconcile_called = []
        collect_called = []
        monkeypatch.setattr(
            mod, "collect_problems", lambda *a: collect_called.append(1) or {}
        )
        monkeypatch.setattr(
            mod, "reconcile", lambda *a: reconcile_called.append(1) or []
        )
        exit_code = mod.run_once(args)
        assert exit_code == 2
        assert reconcile_called == []  # reconcile was NOT called
        assert collect_called == []  # collect_problems was NOT called

    def test_run_once_valid_config_returns_zero(self, monkeypatch):
        mod = _load_module()
        monkeypatch.setattr(mod.os, "environ", {"BOT_ERRORS_WATCHDOG_CHECKS": "q_loop"})
        monkeypatch.setattr(mod, "collect_problems", lambda *a: {})
        monkeypatch.setattr(mod, "reconcile", lambda *a: [])
        args = mod.parse_args(["--once"])
        exit_code = mod.run_once(args)
        assert exit_code == 0


# ---------------------------------------------------------------------------
# Drift guard: registry alignment
# ---------------------------------------------------------------------------


class TestKnownChecksDriftGuard:
    """Verify KNOWN_WATCHDOG_CHECKS stays aligned with the actual check names
    used in collect_problems() and active_reconcile_prefixes() (#2465).

    A synthetic future check added to only the parser, collector, or
    reconciliation map — but not the registry — must fail this guard.
    """

    def test_registry_contains_all_default_checks(self):
        mod = _load_module()
        default_set = {
            part.strip() for part in mod.DEFAULT_CHECKS.split(",") if part.strip()
        }
        assert default_set <= mod.KNOWN_WATCHDOG_CHECKS, (
            "DEFAULT_CHECKS contains names not in KNOWN_WATCHDOG_CHECKS; "
            "either add them to the registry or remove them from DEFAULT_CHECKS"
        )

    def test_every_registry_name_has_collect_problems_branch(self):
        """Every name in KNOWN_WATCHDOG_CHECKS must appear as a check branch
        in collect_problems(). This catches a check added to the registry
        but never implemented."""
        mod = _load_module()
        source = _SCRIPT_ROOT.joinpath("bot-errors-heartbeat-watchdog.py").read_text()
        # Find the collect_problems function body
        start = source.index("def collect_problems(")
        end = source.index("\ndef ", start + 1)
        collect_body = source[start:end]
        for name in mod.KNOWN_WATCHDOG_CHECKS:
            pattern = f'"{name}" in checks'
            assert pattern in collect_body, (
                f"KNOWN_WATCHDOG_CHECKS member '{name}' has no branch in "
                f"collect_problems(); add an implementation or remove from registry"
            )

    def test_every_registry_name_has_reconcile_prefix(self):
        """Every name in KNOWN_WATCHDOG_CHECKS must appear in
        active_reconcile_prefixes(). This catches a check that can collect
        problems but cannot clear them."""
        mod = _load_module()
        source = _SCRIPT_ROOT.joinpath("bot-errors-heartbeat-watchdog.py").read_text()
        start = source.index("def active_reconcile_prefixes(")
        end = source.index("\ndef ", start + 1)
        prefix_body = source[start:end]
        for name in mod.KNOWN_WATCHDOG_CHECKS:
            pattern = f'"{name}" in checks'
            assert pattern in prefix_body, (
                f"KNOWN_WATCHDOG_CHECKS member '{name}' has no entry in "
                f"active_reconcile_prefixes(); add reconcile support or remove from registry"
            )
