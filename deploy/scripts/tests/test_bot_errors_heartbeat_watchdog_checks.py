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


# ---------------------------------------------------------------------------
# turn_failure_rate: terminal per-chat failure rate + session-sharing collision
# ---------------------------------------------------------------------------


def _make_turn_failure_db(db_path: Path, *, failed_rows, checkpoints):
    """Build a minimal instance DB with just the columns the probe reads.

    failed_rows: list of (conversation_key, failure_class, received_at_utc_str)
    checkpoints: list of (conversation_key, session_id, session_status)
    """
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE inbound_events ("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT, "
            "received_at TEXT, processing_status TEXT, failure_class TEXT)"
        )
        conn.executemany(
            "INSERT INTO inbound_events (conversation_key, received_at, "
            "processing_status, failure_class) VALUES (?, ?, 'failed', ?)",
            [(ck, ts, fc) for (ck, fc, ts) in failed_rows],
        )
        conn.execute(
            "CREATE TABLE session_checkpoints ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT UNIQUE, "
            "session_id TEXT, session_status TEXT)"
        )
        conn.executemany(
            "INSERT INTO session_checkpoints (conversation_key, session_id, "
            "session_status) VALUES (?, ?, ?)",
            checkpoints,
        )
        conn.commit()
    finally:
        conn.close()


class TestTurnFailureRateProbe:
    """turn_failure_rate_problems(): terminal-failure-rate alerting and the
    scheduled/interactive session-sharing collision detector (root cause of the
    "Exact ... could not be closed" WHATBOT/MOMS RESUME incident)."""

    _NOW = 1_700_000_000

    def _recent(self, seconds_ago: int) -> str:
        from datetime import datetime, timezone

        return datetime.fromtimestamp(
            self._NOW - seconds_ago, tz=timezone.utc
        ).strftime("%Y-%m-%d %H:%M:%S")

    def _run(self, tmp_path, monkeypatch, *, failed_rows, checkpoints, env=None):
        mod = _load_module()
        root = tmp_path / "instances"
        (root / "alpha").mkdir(parents=True)
        _make_turn_failure_db(
            root / "alpha" / "bot.db", failed_rows=failed_rows, checkpoints=checkpoints
        )
        base_env = {
            "BOT_ERRORS_WEDGE_DB_ROOT": str(root),
            "BOT_ERRORS_DRY_NOW": str(self._NOW),
            "BOT_ERRORS_TURN_FAILURE_WINDOW_SECONDS": "1800",
            "BOT_ERRORS_TURN_FAILURE_MIN_COUNT": "3",
        }
        if env:
            base_env.update(env)
        monkeypatch.setattr(mod.os, "environ", base_env)
        monkeypatch.setattr(
            mod, "expected_local_services",
            lambda: [{"name": "alpha", "service": "whatsoup-alpha.service"}],
        )
        return mod.turn_failure_rate_problems()

    def test_alerts_when_chat_exceeds_failure_threshold(self, tmp_path, monkeypatch):
        rows = [("chatA_at_g.us", "unknown", self._recent(60)) for _ in range(3)]
        problems = self._run(
            tmp_path, monkeypatch, failed_rows=rows, checkpoints=[]
        )
        assert "turn_failure:alpha" in problems
        assert "chatA_at_g.us" in problems["turn_failure:alpha"]
        assert "failed=3" in problems["turn_failure:alpha"]
        assert "session_collision:alpha" not in problems

    def test_below_threshold_is_silent(self, tmp_path, monkeypatch):
        rows = [("chatA_at_g.us", "unknown", self._recent(60)) for _ in range(2)]
        problems = self._run(
            tmp_path, monkeypatch, failed_rows=rows, checkpoints=[]
        )
        assert "turn_failure:alpha" not in problems

    def test_stale_failures_outside_window_excluded(self, tmp_path, monkeypatch):
        rows = [("chatA_at_g.us", "unknown", self._recent(4000)) for _ in range(5)]
        problems = self._run(
            tmp_path, monkeypatch, failed_rows=rows, checkpoints=[]
        )
        assert "turn_failure:alpha" not in problems

    def test_session_collision_alerts_independent_of_failure_rate(
        self, tmp_path, monkeypatch
    ):
        # Zero recent failures, but a scheduled+interactive checkpoint share a
        # session_id — the structural defect must alert on its own.
        checkpoints = [
            ("chatB_at_g.us", "S-shared", "active"),
            ("chatB@g.us::scheduled-agent-job", "S-shared", "active"),
        ]
        problems = self._run(
            tmp_path, monkeypatch, failed_rows=[], checkpoints=checkpoints
        )
        assert "session_collision:alpha" in problems
        assert "shared_session_id=S-shared" in problems["session_collision:alpha"]
        assert "chatB_at_g.us" in problems["session_collision:alpha"]
        assert "turn_failure:alpha" not in problems

    def test_isolated_sessions_do_not_collide(self, tmp_path, monkeypatch):
        checkpoints = [
            ("chatB_at_g.us", "S-interactive", "active"),
            ("chatB@g.us::scheduled-agent-job", "S-scheduled", "active"),
        ]
        problems = self._run(
            tmp_path, monkeypatch, failed_rows=[], checkpoints=checkpoints
        )
        assert "session_collision:alpha" not in problems

    def test_missing_database_is_flagged(self, tmp_path, monkeypatch):
        mod = _load_module()
        root = tmp_path / "instances"
        (root / "alpha").mkdir(parents=True)  # no bot.db
        monkeypatch.setattr(
            mod.os, "environ", {"BOT_ERRORS_WEDGE_DB_ROOT": str(root)}
        )
        monkeypatch.setattr(
            mod, "expected_local_services",
            lambda: [{"name": "alpha", "service": "whatsoup-alpha.service"}],
        )
        problems = mod.turn_failure_rate_problems()
        assert "turn_failure:alpha" in problems
        assert "database missing" in problems["turn_failure:alpha"]
