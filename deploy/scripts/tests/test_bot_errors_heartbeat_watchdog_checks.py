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

    @pytest.mark.parametrize("window,seconds_ago,alerts", [
        (1800, -1, False),
        (1800, 0, True),
        (1800, 1800, True),
        (1800, 1801, False),
        (60, 60, True),
        (60, 61, False),
    ])
    def test_rate_window_is_closed_past_interval(
        self, tmp_path, monkeypatch, window, seconds_ago, alerts
    ):
        rows = [("chatA_at_g.us", "unknown", self._recent(seconds_ago))] * 3
        problems = self._run(
            tmp_path, monkeypatch, failed_rows=rows, checkpoints=[],
            env={"BOT_ERRORS_TURN_FAILURE_WINDOW_SECONDS": str(window)},
        )
        expected = {}
        if alerts:
            expected["turn_failure:alpha"] = (
                f"turn-failure rate: instance=alpha window_seconds={window} "
                "min_count=3 affected_chats=1 "
                "ck=chatA_at_g.us failed=3 classes=unknown:3"
            )
        assert problems == expected

    @pytest.mark.parametrize("received_at", [None, "not-a-timestamp"])
    def test_rate_window_excludes_unusable_timestamps(
        self, tmp_path, monkeypatch, received_at
    ):
        problems = self._run(
            tmp_path, monkeypatch,
            failed_rows=[("chatA_at_g.us", "unknown", received_at)] * 3,
            checkpoints=[],
        )
        assert problems == {}

    def test_rate_window_aggregates_only_qualifying_failures(
        self, turn_failure_reconciliation, monkeypatch
    ):
        import sqlite3

        mod, instances, _ = turn_failure_reconciliation
        (instances / "alpha").mkdir()
        db_path = instances / "alpha" / "bot.db"
        rows = [
            ("chatA_at_g.us", None, self._recent(0)),
            ("chatA_at_g.us", "unknown", self._recent(60)),
            ("chatA_at_g.us", "timeout", self._recent(1800)),
            ("chatA_at_g.us", "future", self._recent(-1)),
            ("chatA_at_g.us", "old", self._recent(1801)),
            ("chatA_at_g.us", "missing", None),
            ("chatA_at_g.us", "invalid", "not-a-timestamp"),
        ]
        rows += [("chatB_at_g.us", "unknown", self._recent(60))] * 2
        rows += [("futureChat_at_g.us", "unknown", self._recent(-1))] * 4
        _make_turn_failure_db(db_path, failed_rows=rows, checkpoints=[])
        conn = sqlite3.connect(db_path)
        try:
            conn.executemany(
                "INSERT INTO inbound_events "
                "(conversation_key, received_at, processing_status, failure_class) "
                "VALUES ('chatB_at_g.us', ?, ?, 'unknown')",
                [(self._recent(60), status) for status in ("pending", "completed")],
            )
            conn.commit()
        finally:
            conn.close()
        monkeypatch.setattr(mod, "expected_local_services", lambda: [{"name": "alpha"}])
        problems = mod.turn_failure_rate_problems()
        assert problems == {
            "turn_failure:alpha": (
                "turn-failure rate: instance=alpha window_seconds=1800 "
                "min_count=3 affected_chats=1 "
                "ck=chatA_at_g.us failed=3 classes=unknown:2,timeout:1"
            ),
        }

    def test_rate_report_limit_preserves_affected_chat_count(
        self, tmp_path, monkeypatch
    ):
        rows = [
            (chat, "unknown", self._recent(60))
            for chat, count in (("chatA", 3), ("chatB", 5), ("chatC", 4), ("chatD", 2))
            for _ in range(count)
        ]
        problems = self._run(
            tmp_path, monkeypatch, failed_rows=rows, checkpoints=[],
            env={"BOT_ERRORS_TURN_FAILURE_MAX_CHATS": "2"},
        )
        assert problems == {
            "turn_failure:alpha": (
                "turn-failure rate: instance=alpha window_seconds=1800 "
                "min_count=3 affected_chats=3 "
                "ck=chatB failed=5 classes=unknown:5; "
                "ck=chatC failed=4 classes=unknown:4"
            ),
        }

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
        assert set(problems) == {"turn_failure_probe:alpha"}
        assert "database missing" in problems["turn_failure_probe:alpha"]


@pytest.fixture
def turn_failure_reconciliation(tmp_path, monkeypatch):
    """Use the real probe, controller-state envelope and private local outbox."""
    root = tmp_path.resolve()
    state = root / "state"
    state.mkdir(mode=0o700)
    instances = root / "instances"
    instances.mkdir()
    monkeypatch.setattr(os, "environ", {
        "HOME": str(root),
        "WHATSOUP_INSTANCE_CONFIG_ROOT": str(root / "config"),
        "BOT_ERRORS_STATE_DIR": str(state),
        "BOT_ERRORS_OUTBOX_DIR": str(state / "outbox"),
        "BOT_ERRORS_WEDGE_DB_ROOT": str(instances),
        "BOT_ERRORS_WATCHDOG_CHECKS": "turn_failure_rate",
        "BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS": "2",
        "BOT_ERRORS_DRY_NOW": "1700000000",
    })
    mod = _load_module()
    return mod, instances, mod.active_reconcile_prefixes({"turn_failure_rate"})


@pytest.mark.parametrize("unavailable,prefix", [
    ("database_missing", "session_collision:"),
    ("database_missing", "turn_failure:"),
    ("checkpoint_table_missing", "session_collision:"),
    ("inbound_table_missing", "turn_failure:"),
    ("inbound_table_missing", "session_collision:"),
    ("database_corrupt", "turn_failure:"),
    ("database_corrupt", "session_collision:"),
])
def test_unavailable_collision_observation_preserves_prior_incident(
    turn_failure_reconciliation, monkeypatch, unavailable, prefix,
):
    import sqlite3

    mod, instances, prefixes = turn_failure_reconciliation
    instance = instances / "alpha"
    instance.mkdir()
    if unavailable == "database_corrupt":
        (instance / "bot.db").write_bytes(b"not a SQLite database")
    if unavailable == "inbound_table_missing":
        with sqlite3.connect(instance / "bot.db") as conn:
            conn.execute("CREATE TABLE unrelated (value TEXT)")
    if unavailable == "checkpoint_table_missing":
        db = instance / "bot.db"
        _make_turn_failure_db(db, failed_rows=[], checkpoints=[])
        with sqlite3.connect(db) as conn:
            conn.execute(
                "ALTER TABLE session_checkpoints RENAME TO unavailable_session_checkpoints"
            )
    monkeypatch.setattr(
        mod, "expected_local_services",
        lambda: [{"name": "alpha", "service": "whatsoup-alpha.service"}],
    )
    monkeypatch.setattr(
        mod, "expected_local_instances", lambda: [{"name": "alpha", "healthPort": 3200}],
    )
    monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES", json.dumps({
        "alpha": {"body": {"status": "healthy", "instance": {"name": "alpha"},
                            "whatsapp": {"connected": True}}},
    }))
    http = mock.Mock(side_effect=AssertionError("unexpected HTTP request"))
    monkeypatch.setattr(mod, "urlopen", http)
    key = prefix + "alpha"
    mod.reconcile({key: "previously confirmed shared session"}, prefixes)
    before = mod.load_state()["open"][key].copy()
    events = []
    for tick in (1700000001, 1700000002):
        monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_NOW", str(tick))
        evaluated_keys = set()
        evaluated_instances = set()
        problems = mod.collect_problems(
            SimpleNamespace(), checks={"turn_failure_rate", "local_instance_health"},
            evaluated_instances=evaluated_instances, evaluated_keys=evaluated_keys,
        )
        assert set(problems) == {"turn_failure_probe:alpha"}
        assert evaluated_instances == {"alpha"}
        assert evaluated_keys == set()
        events.extend(mod.reconcile(
            problems, prefixes, evaluated_instances=evaluated_instances,
            evaluated_keys=evaluated_keys,
        ))
    http.assert_not_called()
    persisted = mod.load_state()["open"]
    assert key in persisted
    assert persisted[key]["lastEvidence"] == before["lastEvidence"]
    assert persisted[key].get("recoveryObservations", 0) == 0
    assert not any(
        json.loads(path.read_text()).get("eventType") == "clear"
        and json.loads(path.read_text()).get("alertSource") == key
        for path in events
    )


@pytest.mark.parametrize("prefix", ["turn_failure:", "session_collision:"])
def test_unevaluated_instance_retained_while_evaluated_instance_recovers(
    turn_failure_reconciliation, monkeypatch, prefix,
):
    mod, instances, prefixes = turn_failure_reconciliation
    beta = instances / "beta"
    beta.mkdir()
    _make_turn_failure_db(beta / "bot.db", failed_rows=[], checkpoints=[])
    monkeypatch.setattr(
        mod, "expected_local_services",
        lambda: [{"name": "beta", "service": "whatsoup-beta.service"}],
    )
    retained, recovered = prefix + "alpha", prefix + "beta"
    mod.reconcile({retained: "prior failure", recovered: "prior failure"}, prefixes)
    assert {retained, recovered} <= set(mod.load_state()["open"])
    before = mod.load_state()["open"][retained].copy()
    events = []
    for tick in (1700000001, 1700000002):
        monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_NOW", str(tick))
        evaluated_keys = set()
        problems = mod.collect_problems(
            SimpleNamespace(), checks={"turn_failure_rate"}, evaluated_keys=evaluated_keys,
        )
        assert problems == {}
        events.extend(mod.reconcile(problems, prefixes, evaluated_keys=evaluated_keys))
    persisted = mod.load_state()["open"]
    assert retained in persisted
    assert persisted[retained]["lastEvidence"] == before["lastEvidence"]
    assert persisted[retained].get("recoveryObservations", 0) == 0
    assert recovered not in persisted
    clears = [
        json.loads(path.read_text())["alertSource"] for path in events
        if json.loads(path.read_text()).get("eventType") == "clear"
    ]
    assert clears == [recovered]


def test_probe_and_workload_recover_only_after_successful_observation_resumes(
    turn_failure_reconciliation, monkeypatch,
):
    mod, instances, prefixes = turn_failure_reconciliation
    alpha = instances / "alpha"
    alpha.mkdir()
    monkeypatch.setattr(
        mod, "expected_local_services",
        lambda: [{"name": "alpha", "service": "whatsoup-alpha.service"}],
    )
    key = "session_collision:alpha"
    probe_key = "turn_failure_probe:alpha"
    mod.reconcile({key: "previously confirmed shared session"}, prefixes)
    assert mod.run_once(SimpleNamespace()) == 0
    assert {key, probe_key} <= set(mod.load_state()["open"])
    _make_turn_failure_db(alpha / "bot.db", failed_rows=[], checkpoints=[])
    monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_NOW", "1700000001")
    assert mod.run_once(SimpleNamespace()) == 0
    before = mod.load_state()["open"]
    assert before[key]["recoveryObservations"] == 1
    assert before[probe_key]["recoveryObservations"] == 1
    (alpha / "bot.db").rename(alpha / "unavailable.db")
    monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_NOW", "1700000002")
    assert mod.run_once(SimpleNamespace()) == 0
    held = mod.load_state()["open"][key]
    assert held["recoveryObservations"] == 1
    assert held["lastEvidence"] == before[key]["lastEvidence"]
    (alpha / "unavailable.db").rename(alpha / "bot.db")
    for tick in (1700000003, 1700000004):
        monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_NOW", str(tick))
        assert mod.run_once(SimpleNamespace()) == 0
    assert mod.load_state()["open"] == {}
    events = [json.loads(path.read_text()) for path in (mod.state_root() / "outbox").glob("*.json")]
    assert {event["alertSource"] for event in events if event["eventType"] == "clear"} == {
        key, probe_key,
    }


def test_unavailable_observation_holds_deferred_workload_recovery_notice(
    turn_failure_reconciliation, monkeypatch,
):
    mod, instances, prefixes = turn_failure_reconciliation
    alpha = instances / "alpha"
    alpha.mkdir()
    _make_turn_failure_db(alpha / "bot.db", failed_rows=[], checkpoints=[])
    monkeypatch.setattr(
        mod, "expected_local_services",
        lambda: [{"name": "alpha", "service": "whatsoup-alpha.service"}],
    )
    monkeypatch.setitem(os.environ, "BOT_ERRORS_WATCHDOG_FLAP_REARM_SECONDS", "30")

    def observe(tick):
        monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_NOW", str(tick))
        evaluated_keys = set()
        problems = mod.collect_problems(
            SimpleNamespace(), checks={"turn_failure_rate"}, evaluated_keys=evaluated_keys,
        )
        return mod.reconcile(problems, prefixes, evaluated_keys=evaluated_keys)

    key = "session_collision:alpha"
    mod.reconcile({key: "confirmed collision"}, prefixes)
    observe(1700000001)
    observe(1700000002)
    monkeypatch.setitem(os.environ, "BOT_ERRORS_DRY_NOW", "1700000003")
    mod.reconcile({key: "confirmed collision again"}, prefixes)
    observe(1700000004)
    observe(1700000005)
    before = mod.load_state()["recentlyRecovered"][key].copy()
    assert before["holdNotice"] is True
    (alpha / "bot.db").rename(alpha / "unavailable.db")
    events = observe(1700000040)
    assert mod.load_state()["recentlyRecovered"][key] == before
    assert not any(json.loads(path.read_text())["eventType"] == "clear" for path in events)
    (alpha / "unavailable.db").rename(alpha / "bot.db")
    events = observe(1700000041)
    clears = [json.loads(path.read_text()) for path in events
              if json.loads(path.read_text())["eventType"] == "clear"]
    assert [event["alertSource"] for event in clears] == [key]
