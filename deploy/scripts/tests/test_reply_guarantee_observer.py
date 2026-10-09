from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from hypothesis import example, given, strategies as st

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

from bot_errors_property_support import private_case, properties  # noqa: E402


_SCRIPT = Path(__file__).resolve().parents[1] / "reply-guarantee-observer.py"
_WRAPPER = Path(__file__).resolve().parents[1] / "reply-guarantee-drain.sh"


def _load_module():
    spec = importlib.util.spec_from_file_location("reply_guarantee_observer", _SCRIPT)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _create_schema(db: sqlite3.Connection, *, attempt_failure_class: bool = True) -> None:
    # A NULL class is the fixture default; the existing debt rows rely on it.
    failure_class_column = "attempt_failure_class TEXT," if attempt_failure_class else ""
    db.executescript(
        f"""
        CREATE TABLE inbound_events (
          seq INTEGER PRIMARY KEY,
          message_id TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          received_at TEXT NOT NULL,
          processing_status TEXT NOT NULL,
          completed_at TEXT,
          terminal_reason TEXT,
          continuity_candidate_reason TEXT,
          continuity_candidate_source TEXT,
          continuity_candidate_marked_at TEXT,
          failure_class TEXT
        );
        CREATE TABLE turn_terminal_records (
          id INTEGER PRIMARY KEY,
          inbound_seq INTEGER,
          inbound_seq_key INTEGER NOT NULL,
          inbound_disposition TEXT NOT NULL,
          delivery_kind TEXT NOT NULL,
          delivery_op_id INTEGER,
          {failure_class_column}
          reply_guarantee_disarmed INTEGER NOT NULL
        );
        CREATE TABLE outbound_ops (
          id INTEGER PRIMARY KEY,
          source_inbound_seq INTEGER,
          status TEXT NOT NULL,
          is_terminal INTEGER NOT NULL,
          replay_policy TEXT NOT NULL,
          submitted_at TEXT,
          echoed_at TEXT
        );
        CREATE TABLE turn_recovery_jobs (
          id INTEGER PRIMARY KEY,
          terminal_record_id INTEGER NOT NULL,
          source_inbound_seq INTEGER NOT NULL,
          state TEXT NOT NULL,
          next_attempt_at TEXT NOT NULL,
          claim_expires_at TEXT
        );
        CREATE TABLE messages (
          pk INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          sender_jid TEXT NOT NULL,
          message_id TEXT UNIQUE,
          content TEXT,
          content_type TEXT NOT NULL DEFAULT 'text',
          is_from_me INTEGER NOT NULL DEFAULT 0,
          timestamp INTEGER NOT NULL
        );
        """
    )


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    path = tmp_path / "instances" / "agent-a" / "bot.db"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as db:
        _create_schema(db)
    return path


def _insert_inbound(
    db: sqlite3.Connection,
    *,
    seq: int,
    received_at: str,
    status: str,
    failure_class: str | None = None,
    continuity: str | None = None,
    message_id: str | None = None,
    conversation_key: str | None = None,
    chat_jid: str | None = None,
) -> None:
    db.execute(
        """
        INSERT INTO inbound_events (
          seq, message_id, conversation_key, chat_jid, received_at,
          processing_status, completed_at, terminal_reason,
          continuity_candidate_reason, continuity_candidate_source,
          continuity_candidate_marked_at, failure_class
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            seq,
            message_id or f"message-{seq}",
            conversation_key or f"private-conversation-{seq}",
            chat_jid or f"private-jid-{seq}",
            received_at,
            status,
            received_at if status in {"complete", "failed"} else None,
            "error" if status == "failed" else None,
            continuity,
            "runtime_fault_disarm" if continuity else None,
            received_at if continuity else None,
            failure_class,
        ),
    )


def test_reads_uncheckpointed_wal_frames_in_read_only_mode(db_path: Path) -> None:
    mod = _load_module()
    writer = sqlite3.connect(db_path)
    try:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute("PRAGMA wal_autocheckpoint=0")
        _insert_inbound(
            writer,
            seq=1,
            received_at="2026-08-15 21:00:00",
            status="failed",
            failure_class="session_crash",
            continuity="runtime_fault_no_terminal_outbound",
        )
        writer.commit()
        assert Path(f"{db_path}-wal").stat().st_size > 0

        result = mod.observe_database(
            db_path,
            instance="agent-a",
            now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
            stale_seconds=900,
        )
    finally:
        writer.close()

    assert result["state"] == "recovery-debt"
    assert result["healthImpact"] == "none"
    assert result["counts"]["unresolvedContinuityCandidates"] == 1
    assert result["database"]["walSidecarPresent"] is True


def test_separates_active_breach_from_historical_recovery_debt(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(
            db,
            seq=1,
            received_at="2026-08-15 20:00:00",
            status="processing",
        )
        _insert_inbound(
            db,
            seq=2,
            received_at="2026-07-01 00:00:00",
            status="failed",
            failure_class="crash_recovery",
            continuity="crash_reclaim_no_terminal_outbound",
        )

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "active-breach"
    assert result["healthImpact"] == "operational"
    assert result["counts"] == {
        "staleOpenInbounds": 1,
        "staleRecoveryJobs": 0,
        "unresolvedContinuityCandidates": 1,
        "syntheticContinuityCandidates": 0,
        "failedTerminalDebt": 0,
        "failedTerminalWithEchoEvidence": 0,
        "blockedOrExhaustedRecoveryJobs": 0,
    }
    rendered = str(result)
    assert "private-conversation" not in rendered
    assert "private-jid" not in rendered
    assert "message-" not in rendered


def test_failed_terminal_and_exhausted_recovery_are_debt_not_runtime_health(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(
            db,
            seq=1,
            received_at="2026-08-01 00:00:00",
            status="failed",
            failure_class="session_crash",
        )
        db.execute(
            """
            INSERT INTO turn_terminal_records (
              id, inbound_seq, inbound_seq_key, inbound_disposition,
              delivery_kind, delivery_op_id, reply_guarantee_disarmed
            ) VALUES (10, 1, 1, 'failed_terminal', 'none', NULL, 0)
            """
        )
        db.execute(
            """
            INSERT INTO turn_recovery_jobs (
              id, terminal_record_id, source_inbound_seq, state,
              next_attempt_at, claim_expires_at
            ) VALUES (20, 10, 1, 'exhausted', '2026-08-01 00:00:00', NULL)
            """
        )
        db.execute(
            """
            INSERT INTO outbound_ops (
              id, source_inbound_seq, status, is_terminal, replay_policy
            ) VALUES (30, 1, 'echoed', 0, 'unsafe')
            """
        )

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "recovery-debt"
    assert result["healthImpact"] == "none"
    assert result["counts"]["failedTerminalDebt"] == 1
    assert result["counts"]["failedTerminalWithEchoEvidence"] == 1
    assert result["counts"]["blockedOrExhaustedRecoveryJobs"] == 1


def test_synthetic_scheduled_job_continuity_mark_is_not_reply_debt(db_path: Path) -> None:
    # #3754: a crash-reclaimed scheduled agent job owes no user a reply. Its
    # continuity mark is counted apart and raises no debt state or latch.
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(
            db,
            seq=1,
            received_at="2026-08-15 20:00:00",
            status="failed",
            failure_class="crash_recovery",
            continuity="crash_reclaim_no_terminal_outbound",
            message_id="agentjob-7-1780000000-occ11",
        )

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )
    latches = mod._desired_latches(
        result,
        {"activeAlerted": False, "debtAlerted": False, "observerAlerted": False, "lastState": None},
    )

    assert result["state"] == "clear"
    assert result["counts"]["unresolvedContinuityCandidates"] == 0
    assert result["counts"]["syntheticContinuityCandidates"] == 1
    assert latches["reply-guarantee-recovery-debt"] is False
    assert "agentjob-" not in str(result)


def test_continuity_mark_split_matches_the_case_sensitive_synthetic_prefix(db_path: Path) -> None:
    # Only the exact lowercase prefix is synthetic, as in the runtime's GLOB.
    # A real user's mark and an uppercase lookalike stay reply-guarantee debt.
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        for seq, message_id in ((1, "agentjob-7-1780000000-occ11"), (2, "AGENTJOB-7-1780000000-occ12"), (3, "message-3")):
            _insert_inbound(
                db,
                seq=seq,
                received_at="2026-08-15 20:00:00",
                status="failed",
                failure_class="crash_recovery",
                continuity="crash_reclaim_no_terminal_outbound",
                message_id=message_id,
            )

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "recovery-debt"
    assert result["counts"]["unresolvedContinuityCandidates"] == 2
    assert result["counts"]["syntheticContinuityCandidates"] == 1


def test_clean_database_reports_clear(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(
            db,
            seq=1,
            received_at="2026-08-15 21:00:00",
            status="complete",
        )

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "clear"
    assert result["healthImpact"] == "none"
    assert all(value == 0 for value in result["counts"].values())


def test_missing_schema_is_inconclusive_not_clear(tmp_path: Path) -> None:
    mod = _load_module()
    path = tmp_path / "bot.db"
    sqlite3.connect(path).close()

    result = mod.observe_database(
        path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    assert result["healthImpact"] == "unknown"
    assert "schema" in result["reason"]


def test_missing_attempt_failure_class_is_named_inconclusive(tmp_path: Path) -> None:
    mod = _load_module()
    path = tmp_path / "bot.db"
    with sqlite3.connect(path) as db:
        _create_schema(db, attempt_failure_class=False)

    result = mod.observe_database(
        path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    assert "turn_terminal_records(attempt_failure_class)" in result["reason"]


def _insert_failed_terminal(
    db: sqlite3.Connection,
    *,
    seq: int,
    failure_class: str,
    echoed_op: bool,
) -> None:
    _insert_inbound(db, seq=seq, received_at="2026-08-01 00:00:00", status="failed", failure_class=failure_class)
    db.execute(
        """
        INSERT INTO turn_terminal_records (
          id, inbound_seq, inbound_seq_key, inbound_disposition,
          delivery_kind, delivery_op_id, reply_guarantee_disarmed, attempt_failure_class
        ) VALUES (?, ?, ?, 'failed_terminal', 'none', NULL, 0, ?)
        """,
        (100 + seq, seq, seq, failure_class),
    )
    if echoed_op:
        db.execute(
            """
            INSERT INTO outbound_ops (
              id, source_inbound_seq, status, is_terminal, replay_policy
            ) VALUES (?, ?, 'echoed', 0, 'unsafe')
            """,
            (200 + seq, seq),
        )


def test_operator_stop_is_not_recovery_debt(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_failed_terminal(db, seq=1, failure_class="operator_cancelled", echoed_op=True)

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["counts"]["failedTerminalDebt"] == 0
    assert result["counts"]["failedTerminalWithEchoEvidence"] == 0
    assert result["state"] == "clear"


def test_operator_stop_exclusion_keeps_a_runtime_fault_as_debt(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_failed_terminal(db, seq=1, failure_class="operator_cancelled", echoed_op=True)
        _insert_failed_terminal(db, seq=2, failure_class="crash", echoed_op=True)

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["counts"]["failedTerminalDebt"] == 1
    assert result["counts"]["failedTerminalWithEchoEvidence"] == 1
    assert result["state"] == "recovery-debt"


def test_missing_instance_root_warns_about_user_and_gui_context(tmp_path: Path) -> None:
    mod = _load_module()
    missing = tmp_path / "not-this-users-home" / ".local" / "share" / "whatsoup" / "instances"

    result = mod.observe_instances(
        missing,
        instance=None,
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    hints = " ".join(result["resolutionHints"])
    assert "target user" in hints
    assert "GUI" in hints
    assert ".local/share/whatsoup/instances" in hints


def test_default_data_root_honors_existing_whatsoup_and_xdg_overrides(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    mod = _load_module()
    whatsoup_root = tmp_path / "custom-whatsoup"
    xdg_root = tmp_path / "xdg"

    monkeypatch.setenv("WHATSOUP_DATA_DIR", str(whatsoup_root))
    monkeypatch.setenv("XDG_DATA_HOME", str(xdg_root))
    assert mod._default_data_root() == whatsoup_root / "instances"

    monkeypatch.delenv("WHATSOUP_DATA_DIR")
    assert mod._default_data_root() == xdg_root / "whatsoup" / "instances"


def test_read_only_cli_is_single_file_portable_without_emit(db_path: Path, tmp_path: Path) -> None:
    standalone = tmp_path / "reply-guarantee-observer.py"
    shutil.copyfile(_SCRIPT, standalone)

    completed = subprocess.run(
        [
            sys.executable,
            str(standalone),
            "--data-root",
            str(db_path.parents[1]),
            "--instance",
            "agent-a",
            "--json",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout)["state"] == "clear"


def test_explicit_instance_symlink_is_inconclusive(db_path: Path) -> None:
    mod = _load_module()
    data_root = db_path.parents[1]
    (data_root / "alias").symlink_to(db_path.parent, target_is_directory=True)

    result = mod.observe_instances(
        data_root,
        instance="alias",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    assert result["instances"][0]["state"] == "inconclusive"
    assert "symlink" in result["instances"][0]["reason"]


def test_explicit_instance_name_cannot_escape_data_root(db_path: Path) -> None:
    mod = _load_module()

    result = mod.observe_instances(
        db_path.parents[1],
        instance="../agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    assert result["instances"] == []
    assert "instance name" in result["reason"]


def test_invalid_active_timestamp_is_inconclusive_not_clear(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(db, seq=1, received_at="not-a-timestamp", status="processing")

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    assert "timestamp" in result["reason"]


def test_future_active_timestamp_is_inconclusive_not_clear(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(db, seq=1, received_at="2026-08-15 23:00:00", status="processing")

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    assert "timestamp" in result["reason"]


def test_open_inbound_with_exhausted_recovery_is_an_active_breach(db_path: Path) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(db, seq=1, received_at="2026-08-01 00:00:00", status="processing")
        db.execute(
            """
            INSERT INTO turn_terminal_records (
              id, inbound_seq, inbound_seq_key, inbound_disposition,
              delivery_kind, delivery_op_id, reply_guarantee_disarmed
            ) VALUES (10, 1, 1, 'transferred_to_recovery_owner', 'enqueued', 99, 0)
            """
        )
        db.execute(
            """
            INSERT INTO turn_recovery_jobs (
              id, terminal_record_id, source_inbound_seq, state,
              next_attempt_at, claim_expires_at
            ) VALUES (20, 10, 1, 'exhausted', '2026-08-01 00:00:00', NULL)
            """
        )

    result = mod.observe_database(
        db_path,
        instance="agent-a",
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "active-breach"
    assert result["counts"]["staleRecoveryJobs"] == 1
    assert result["counts"]["blockedOrExhaustedRecoveryJobs"] == 1


# --- R46: progress diagnostics -------------------------------------------------
# The observation, its counts and every latch stay exactly as before R46.
# progressDiagnostics describes the staleOpenInbounds set with one statement,
# run after every instance's base observation: staleRows, staleChats
# (distinct chats with a stale row), and staleRowsWithRecentSend (stale rows
# with an accepted send tied through outbound_ops.source_inbound_seq whose
# send time, COALESCE(datetime(echoed_at), datetime(submitted_at)), is after
# receipt, no later than now and within the threshold).
# Only tests that pass against base 82da64ac5 carry `_pin_`.
# An echoed send is also stored as a bot message in the chat. The fixtures
# insert that echo, so a chat-wide bot-message rule would read it as a send.

_PROGRESS_NOW = datetime(2026, 8, 15, 22, 0, tzinfo=UTC)
_CHAT_KEY = "15550001111"
_OTHER_CHAT_KEY = "15550002222"
_THIRD_CHAT_KEY = "15550003333"
_BOT_JID = "15550009999@s.whatsapp.net"
# The runtime writes timestamps as "YYYY-MM-DD HH:MM:SS"; the ISO form with T
# and Z compares differently as text.
_CANONICAL = "%Y-%m-%d %H:%M:%S"
_ISO = "%Y-%m-%dT%H:%M:%SZ"
_NO_LATCHES = {"activeAlerted": False, "debtAlerted": False, "observerAlerted": False, "lastState": None}
_ACTIVE_LATCHES = {
    "reply-guarantee-active-breach": True,
    "reply-guarantee-recovery-debt": False,
    "reply-guarantee-observer": False,
}


def _diagnosed(rows: int, chats: int, recent: int) -> dict:
    return {
        "available": True,
        "staleRows": rows,
        "staleChats": chats,
        "staleRowsWithRecentSend": recent,
    }


def _unavailable(reason: str) -> dict:
    return {"available": False, "reason": reason}


def _without_diagnostics(observation: dict) -> dict:
    return {key: value for key, value in observation.items() if key != "progressDiagnostics"}


def _ago_text(seconds: int, now: datetime = _PROGRESS_NOW, time_format: str = _CANONICAL) -> str:
    return (now - timedelta(seconds=seconds)).strftime(time_format)


def _ago_epoch(seconds: int, now: datetime = _PROGRESS_NOW) -> int:
    return int((now - timedelta(seconds=seconds)).timestamp())


def _insert_row(
    db: sqlite3.Connection,
    *,
    seq: int,
    age: int,
    status: str = "processing",
    conversation_key: str = _CHAT_KEY,
    now: datetime = _PROGRESS_NOW,
) -> None:
    _insert_inbound(
        db,
        seq=seq,
        received_at=_ago_text(age, now),
        status=status,
        conversation_key=conversation_key,
        chat_jid=f"{conversation_key}@s.whatsapp.net",
    )


def _insert_send(
    db: sqlite3.Connection,
    *,
    op_id: int,
    seq: int | None,
    status: str,
    submitted_ago: int | None = None,
    echoed_ago: int | None = None,
    echo_message_ago: int | None = None,
    is_terminal: int = 0,
    conversation_key: str = _CHAT_KEY,
    now: datetime = _PROGRESS_NOW,
    time_format: str = _CANONICAL,
) -> None:
    """Insert one outbound op; a negative age lies in the future.

    echo_message_ago also stores the op's echo as a bot message in the chat.
    """
    db.execute(
        """
        INSERT INTO outbound_ops (
          id, source_inbound_seq, status, is_terminal, replay_policy, submitted_at, echoed_at
        ) VALUES (?, ?, ?, ?, 'unsafe', ?, ?)
        """,
        (
            op_id,
            seq,
            status,
            is_terminal,
            None if submitted_ago is None else _ago_text(submitted_ago, now, time_format),
            None if echoed_ago is None else _ago_text(echoed_ago, now, time_format),
        ),
    )
    if echo_message_ago is not None:
        db.execute(
            """
            INSERT INTO messages (
              chat_jid, conversation_key, sender_jid, message_id, content_type,
              is_from_me, timestamp
            ) VALUES (?, ?, ?, ?, 'text', 1, ?)
            """,
            (
                f"{conversation_key}@s.whatsapp.net",
                conversation_key,
                _BOT_JID,
                f"echo-{op_id}",
                _ago_epoch(echo_message_ago, now),
            ),
        )


def _insert_echoed_send(
    db: sqlite3.Connection,
    *,
    op_id: int,
    seq: int | None,
    ago: int,
    is_terminal: int = 0,
    now: datetime = _PROGRESS_NOW,
) -> None:
    _insert_send(
        db,
        op_id=op_id,
        seq=seq,
        status="echoed",
        submitted_ago=ago,
        echoed_ago=ago,
        echo_message_ago=ago,
        is_terminal=is_terminal,
        now=now,
    )


def _progress_db(root: Path) -> Path:
    path = root / "instances" / "agent-a" / "bot.db"
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as db:
        _create_schema(db)
    return path


def _observe_progress(db_path: Path, now: datetime = _PROGRESS_NOW) -> dict:
    return _observe_with(_load_module(), db_path, now)


def _record_emissions(mod, monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    commands: list[list[str]] = []

    class _Completed:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(command, **_kwargs):
        commands.append(command)
        return _Completed()

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    return commands


def _active_breach_clears(commands: list[list[str]]) -> list[bool]:
    """Return, in order, whether each active-breach emission was a --clear."""
    return [
        "--clear" in command
        for command in commands
        if command[command.index("--source") + 1] == "reply-guarantee-active-breach"
    ]


def _observe_and_emit(mod, db_path: Path, repo_root: Path, now: datetime) -> dict:
    result = mod.observe_instances(db_path.parents[1], instance="agent-a", now=now, stale_seconds=900)
    assert mod._emit(repo_root, result) is True
    return result["instances"][0]


def _observe_with(mod, db_path: Path, now: datetime = _PROGRESS_NOW) -> dict:
    """Observe one instance through an already loaded module, so its monkeypatches apply.

    observe_instances is the entry point that attaches progressDiagnostics.
    """
    result = mod.observe_instances(db_path.parents[1], instance=db_path.parent.name, now=now, stale_seconds=900)
    return result["instances"][0]


def _emission_projection(commands: list[list[str]]) -> list[tuple[str, str, bool, str | None]]:
    """Project emissions onto what pages; --evidence embeds the diagnostics."""
    return [
        (
            command[command.index("--instance") + 1],
            command[command.index("--source") + 1],
            "--clear" in command,
            command[command.index("--severity") + 1] if "--severity" in command else None,
        )
        for command in commands
    ]


def _force_invalid_statement(mod, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mod, "_PROGRESS_DIAGNOSTICS_SQL", "SELECT no_such_column FROM outbound_ops")


def _force_budget_abort(mod, monkeypatch: pytest.MonkeyPatch) -> None:
    # The deadline has passed before the statement starts, and the handler runs
    # at the first check, so the statement is interrupted however small it is.
    monkeypatch.setattr(mod, "DIAGNOSTIC_BUDGET_SECONDS", -1.0)
    monkeypatch.setattr(mod, "DIAGNOSTIC_BUDGET_CHECK_OPCODES", 1)


@properties
@given(
    ago=st.integers(min_value=0, max_value=900),
    status=st.sampled_from(("submitted", "echoed")),
    time_format=st.sampled_from((_CANONICAL, _ISO)),
)
@example(ago=900, status="submitted", time_format=_CANONICAL)
@example(ago=0, status="echoed", time_format=_ISO)
def test_stale_row_with_a_recent_tied_send_still_breaches(ago: int, status: str, time_format: str) -> None:
    # Either accepted status counts, from now back to the threshold, in either
    # timestamp form. The send is only diagnosed: the row pages as before R46.
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            _insert_row(db, seq=1, age=1500)
            _insert_send(
                db,
                op_id=10,
                seq=1,
                status=status,
                submitted_ago=ago,
                echoed_ago=ago if status == "echoed" else None,
                time_format=time_format,
            )
        result = _observe_progress(path)

    assert result["state"] == "active-breach"
    assert result["healthImpact"] == "operational"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 1)
    assert _load_module()._desired_latches(result, _NO_LATCHES) == _ACTIVE_LATCHES
    assert _CHAT_KEY not in str(result)


@properties
@given(ago=st.integers(min_value=901, max_value=1999))
@example(ago=901)
def test_tied_send_older_than_the_threshold_is_not_recent(ago: int) -> None:
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            _insert_row(db, seq=1, age=2000)
            _insert_echoed_send(db, op_id=10, seq=1, ago=ago)
        result = _observe_progress(path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)


def test_reply_tied_to_another_inbound_is_not_recent(db_path: Path) -> None:
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
        _insert_row(db, seq=2, age=400, status="complete")
        _insert_echoed_send(db, op_id=10, seq=2, ago=300)

    result = _observe_progress(db_path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)


def test_future_dated_tied_send_is_not_recent(db_path: Path) -> None:
    # Stamped two minutes ahead: after receipt and inside the window from
    # below, so only the "no later than now" bound leaves it out.
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
        _insert_echoed_send(db, op_id=10, seq=1, ago=-120)

    result = _observe_progress(db_path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)


def test_untied_queued_receipts_are_not_recent(db_path: Path) -> None:
    # The shape of a production probe (2026-10-09), in seconds from the stale
    # row's receipt: "Queued behind the current task" receipts at +0, +275,
    # +423 and +652, echoed, is_terminal 0 and tied to no inbound
    # (src/runtimes/agent/runtime.ts queuedTurnReceipts calls sendTracked with
    # no source inbound); the previous turn's final reply, tied to that turn,
    # at +444; nothing tied to the stale row or the row behind it.
    stale_age = 1037
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=6, age=stale_age + 600, status="complete")
        _insert_row(db, seq=7, age=stale_age)
        _insert_row(db, seq=11, age=stale_age - 275, status="pending")
        _insert_echoed_send(db, op_id=20, seq=None, ago=stale_age)
        _insert_echoed_send(db, op_id=21, seq=None, ago=stale_age - 275)
        _insert_echoed_send(db, op_id=22, seq=None, ago=stale_age - 423)
        _insert_echoed_send(db, op_id=23, seq=None, ago=stale_age - 652)
        _insert_echoed_send(db, op_id=24, seq=6, ago=stale_age - 444, is_terminal=1)

    result = _observe_progress(db_path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)
    assert _CHAT_KEY not in str(result)


def test_send_echoed_after_a_silence_counts_from_its_echo(db_path: Path) -> None:
    # Submitted, then maybe_sent, then echoed: echo matching accepts a
    # maybe_sent op (src/core/durability.ts selectOutboundForEchoMatch). The
    # submission lies outside the window and the echo inside it, so the op
    # counts only because echoed_at takes precedence.
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
        _insert_send(db, op_id=10, seq=1, status="echoed", submitted_ago=990, echoed_ago=30, echo_message_ago=30)

    result = _observe_progress(db_path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 1)


def test_echoed_send_without_echoed_at_counts_from_submitted_at(db_path: Path) -> None:
    # COALESCE(datetime(echoed_at), datetime(submitted_at)): with no echo time
    # the submission time is used.
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
        _insert_send(db, op_id=10, seq=1, status="echoed", submitted_ago=300)

    result = _observe_progress(db_path)

    assert result["state"] == "active-breach"
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 1)


def test_tied_send_stamped_before_receipt_is_not_recent(db_path: Path) -> None:
    # A receipt written with a UTC offset sorts as stale under base's text
    # comparison ("21:30:00-00:20" < "21:45:00") but is 21:50 UTC. The send at
    # 21:47 is inside the window and before now, so only the after-receipt
    # bound leaves it out. With the runtime's own format a stale receipt is
    # older than the window, which then excludes earlier sends by itself.
    with sqlite3.connect(db_path) as db:
        _insert_inbound(
            db,
            seq=1,
            received_at="2026-08-15 21:30:00-00:20",
            status="processing",
            conversation_key=_CHAT_KEY,
            chat_jid=f"{_CHAT_KEY}@s.whatsapp.net",
        )
        _insert_send(db, op_id=10, seq=1, status="submitted", submitted_ago=780)

    result = _observe_progress(db_path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)


@properties
@given(status=st.sampled_from(("pending", "sending", "maybe_sent", "failed_permanent", "quarantined")))
def test_tied_op_the_provider_did_not_accept_is_not_recent(status: str) -> None:
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            _insert_row(db, seq=1, age=1000)
            _insert_send(db, op_id=10, seq=1, status=status, submitted_ago=300)
        result = _observe_progress(path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)


@properties
@given(status=st.sampled_from(("submitted", "echoed")), stamp=st.sampled_from((None, "not-a-time")))
@example(status="echoed", stamp=None)
def test_accepted_tied_op_without_a_usable_time_is_not_recent(status: str, stamp: str | None) -> None:
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            _insert_row(db, seq=1, age=1000)
            db.execute(
                """
                INSERT INTO outbound_ops (
                  id, source_inbound_seq, status, is_terminal, replay_policy, submitted_at, echoed_at
                ) VALUES (10, 1, ?, 0, 'unsafe', ?, ?)
                """,
                (status, stamp, stamp),
            )
        result = _observe_progress(path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)


@properties
@given(echoed_at=st.sampled_from(("not-a-time", "")))
@example(echoed_at="not-a-time")
def test_malformed_echoed_at_falls_back_to_submitted_at(echoed_at: str) -> None:
    # The send time is the first of echoed_at and submitted_at that parses, so
    # a malformed echo time does not hide a recent submission.
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            _insert_row(db, seq=1, age=1000)
            db.execute(
                """
                INSERT INTO outbound_ops (
                  id, source_inbound_seq, status, is_terminal, replay_policy, submitted_at, echoed_at
                ) VALUES (10, 1, 'echoed', 0, 'unsafe', ?, ?)
                """,
                (_ago_text(300), echoed_at),
            )
        result = _observe_progress(path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 1)


def test_pin_breach_then_a_queued_receipt_stays_latched_without_a_clear(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    mod = _load_module()
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    commands = _record_emissions(mod, monkeypatch)
    first_pass = _PROGRESS_NOW
    second_pass = _PROGRESS_NOW + timedelta(seconds=60)
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000, now=first_pass)

    assert _observe_and_emit(mod, db_path, tmp_path, first_pass)["state"] == "active-breach"
    assert _active_breach_clears(commands) == [False]

    with sqlite3.connect(db_path) as db:
        # A nudge queued behind the stuck turn draws the untied receipt.
        _insert_row(db, seq=2, age=31, status="pending", now=second_pass)
        _insert_echoed_send(db, op_id=10, seq=None, ago=30, now=second_pass)
    second = _observe_and_emit(mod, db_path, tmp_path, second_pass)

    assert second["state"] == "active-breach"
    assert second["counts"]["staleOpenInbounds"] == 1
    assert _active_breach_clears(commands) == [False]


def test_pin_breach_then_a_tied_reply_stays_latched_until_the_turn_is_terminal(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # As before R46, an open stale row stays a breach whatever it sends; the
    # alert clears only when the turn is terminal.
    mod = _load_module()
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    commands = _record_emissions(mod, monkeypatch)
    first_pass = _PROGRESS_NOW
    second_pass = _PROGRESS_NOW + timedelta(seconds=60)
    third_pass = _PROGRESS_NOW + timedelta(seconds=120)
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000, now=first_pass)

    assert _observe_and_emit(mod, db_path, tmp_path, first_pass)["state"] == "active-breach"
    assert _active_breach_clears(commands) == [False]

    with sqlite3.connect(db_path) as db:
        _insert_echoed_send(db, op_id=10, seq=1, ago=30, now=second_pass)
    second = _observe_and_emit(mod, db_path, tmp_path, second_pass)

    assert second["state"] == "active-breach"
    assert second["counts"]["staleOpenInbounds"] == 1
    assert _active_breach_clears(commands) == [False]

    with sqlite3.connect(db_path) as db:
        db.execute(
            "UPDATE inbound_events SET processing_status = 'complete', completed_at = ? WHERE seq = 1",
            (_ago_text(20, third_pass),),
        )
    third = _observe_and_emit(mod, db_path, tmp_path, third_pass)

    assert third["state"] == "clear"
    assert _active_breach_clears(commands) == [False, True]


@properties
@given(extra=st.integers(min_value=0, max_value=3))
@example(extra=0)
@example(extra=1)
def test_stale_chats_counts_each_chat_with_a_stale_row_once(extra: int) -> None:
    # One stale row in each of three chats, plus `extra` more in the first.
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            for seq, conversation_key in enumerate((_CHAT_KEY, _OTHER_CHAT_KEY, _THIRD_CHAT_KEY), start=1):
                _insert_row(db, seq=seq, age=2000, conversation_key=conversation_key)
            for seq in range(4, 4 + extra):
                _insert_row(db, seq=seq, age=1500, status="pending")
        result = _observe_progress(path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 3 + extra
    assert result["progressDiagnostics"] == _diagnosed(3 + extra, 3, 0)


def test_open_row_with_a_terminal_record_is_left_out_of_the_diagnostics(db_path: Path) -> None:
    # The first row has a terminal record and a recent tied send. It is outside
    # the stale set, so neither the row nor its send is counted.
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=2000)
        db.execute(
            """
            INSERT INTO turn_terminal_records (
              id, inbound_seq, inbound_seq_key, inbound_disposition,
              delivery_kind, delivery_op_id, reply_guarantee_disarmed
            ) VALUES (10, 1, 1, 'transferred_to_recovery_owner', 'enqueued', 99, 0)
            """
        )
        _insert_echoed_send(db, op_id=10, seq=1, ago=30)
        _insert_row(db, seq=2, age=1500, status="pending")

    result = _observe_progress(db_path)

    assert result["state"] == "active-breach"
    assert result["counts"]["staleOpenInbounds"] == 1
    assert result["progressDiagnostics"] == _diagnosed(1, 1, 0)


@pytest.mark.parametrize(
    ("row_age", "expected_state", "stale"),
    [
        (900, "clear", 0),
        (901, "active-breach", 1),
    ],
)
def test_pin_open_row_with_no_terminal_and_no_tied_send_breaches_after_the_threshold(
    db_path: Path,
    row_age: int,
    expected_state: str,
    stale: int,
) -> None:
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=row_age)

    result = _observe_progress(db_path)

    assert result["state"] == expected_state
    assert result["counts"]["staleOpenInbounds"] == stale


@properties
@given(
    missing=st.sampled_from((
        ("inbound_events", "conversation_key"),
        ("outbound_ops", "submitted_at"),
        ("outbound_ops", "echoed_at"),
    )),
)
@example(missing=("inbound_events", "conversation_key"))
def test_missing_diagnostic_column_leaves_the_observation_unchanged(missing: tuple[str, str]) -> None:
    table, column = missing
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            _insert_row(db, seq=1, age=2000)
            _insert_row(db, seq=2, age=1500, status="pending")
        complete = _observe_progress(path)
        with sqlite3.connect(path) as db:
            db.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        reduced = _observe_progress(path)

    assert complete["progressDiagnostics"] == _diagnosed(2, 1, 0)
    assert reduced["progressDiagnostics"] == _unavailable("diagnostic_columns_missing")
    assert _without_diagnostics(reduced) == _without_diagnostics(complete)
    assert reduced["state"] == "active-breach"
    assert reduced["counts"]["staleOpenInbounds"] == 2


def _insert_two_stale_rows(db_path: Path) -> list[str]:
    """Insert two rows stale against any current clock; return the CLI argv."""
    with sqlite3.connect(db_path) as db:
        _insert_inbound(
            db, seq=1, received_at="2026-08-01 00:00:00", status="processing",
            conversation_key=_CHAT_KEY, chat_jid=f"{_CHAT_KEY}@s.whatsapp.net",
        )
        _insert_inbound(
            db, seq=2, received_at="2026-08-01 00:05:00", status="pending",
            conversation_key=_CHAT_KEY, chat_jid=f"{_CHAT_KEY}@s.whatsapp.net",
        )
    return [
        "--data-root", str(db_path.parents[1]), "--instance", "agent-a",
        "--emit", "--json", "--repo-root", str(db_path.parents[2]),
    ]


def _run_cli(mod, monkeypatch: pytest.MonkeyPatch, capsys, commands: list, argv: list[str], state_dir: Path):
    """Run main from an empty latch state; return status, output, emissions, latches."""
    del commands[:]
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state_dir))
    status = mod.main(argv)
    output = json.loads(capsys.readouterr().out)
    return status, output, _emission_projection(commands), mod._state_target_and_observation()[1].payload


def _run_diagnostics(run) -> dict:
    return run[1]["instances"][0]["progressDiagnostics"]


def _paging_outcome(run) -> tuple:
    """Everything a run pages, saves and exits with, without its progress diagnostics."""
    status, output, emissions, latches = run
    observation = _without_diagnostics(output["instances"][0])
    return status, observation, output["state"], output["emissionSucceeded"], emissions, latches


def _breach_page_facts(outcome: tuple) -> tuple:
    """The facts every two-stale-row run must show: exit 0, one sent breach page, the latch armed."""
    status, _observation, state, succeeded, emissions, latches = outcome
    return (
        status,
        state,
        succeeded is True,
        [(source, clear) for _instance, source, clear, _severity in emissions],
        latches["instances"]["agent-a"]["activeAlerted"] is True,
    )


_BREACH_PAGED = (0, "active-breach", True, [("reply-guarantee-active-breach", False)], True)


@pytest.mark.parametrize(
    ("force", "reason"),
    [
        (_force_invalid_statement, "diagnostic_failed"),
        (_force_budget_abort, "diagnostic_budget_exceeded"),
    ],
)
def test_failed_diagnostic_keeps_emissions_latches_and_exit_code(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    force,
    reason: str,
) -> None:
    mod = _load_module()
    commands = _record_emissions(mod, monkeypatch)
    argv = _insert_two_stale_rows(db_path)
    expected = _run_cli(mod, monkeypatch, capsys, commands, argv, tmp_path / "state-expected")
    force(mod, monkeypatch)

    observed = _run_cli(mod, monkeypatch, capsys, commands, argv, tmp_path / "state-observed")

    assert _run_diagnostics(expected) == _diagnosed(2, 1, 0)
    assert _run_diagnostics(observed) == _unavailable(reason)
    assert _paging_outcome(observed) == _paging_outcome(expected)
    assert (
        _breach_page_facts(_paging_outcome(expected))
        == _breach_page_facts(_paging_outcome(observed))
        == _BREACH_PAGED
    )


def test_lock_held_through_the_diagnostics_costs_at_most_the_budget(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    # A writer takes an exclusive lock after base's reads are done and holds
    # it while the diagnostics run. In rollback-journal mode, which the runtime
    # writes under before it enables WAL (src/core/database.ts), that lock
    # blocks every read, so only the remaining-budget busy timeout ends the
    # wait. The base result comes from a run with no lock.
    mod = _load_module()
    commands = _record_emissions(mod, monkeypatch)
    argv = _insert_two_stale_rows(db_path)
    expected = _run_cli(mod, monkeypatch, capsys, commands, argv, tmp_path / "state-expected")
    durations: list[float] = []
    diagnose = mod._progress_diagnostics

    def diagnose_under_a_write_lock(*args, **kwargs):
        writer = sqlite3.connect(db_path, isolation_level=None)
        try:
            assert writer.execute("PRAGMA journal_mode").fetchone() == ("delete",)
            writer.execute("BEGIN EXCLUSIVE")
            started = time.monotonic()
            try:
                return diagnose(*args, **kwargs)
            finally:
                durations.append(time.monotonic() - started)
                writer.execute("ROLLBACK")
        finally:
            writer.close()

    monkeypatch.setattr(mod, "_progress_diagnostics", diagnose_under_a_write_lock)

    observed = _run_cli(mod, monkeypatch, capsys, commands, argv, tmp_path / "state-observed")

    # diagnostic_failed is the outcome on an SQLite build without usleep,
    # whose sub-second busy timeout gives up at once.
    assert _run_diagnostics(expected) == _diagnosed(2, 1, 0)
    assert _run_diagnostics(observed) in [
        _unavailable("diagnostic_budget_exceeded"), _unavailable("diagnostic_failed"),
    ]
    assert _paging_outcome(observed) == _paging_outcome(expected)
    assert (
        _breach_page_facts(_paging_outcome(expected))
        == _breach_page_facts(_paging_outcome(observed))
        == _BREACH_PAGED
    )
    # Absolute: the 2 s budget plus a margin for the last wait and scheduling.
    assert len(durations) == 1
    assert durations[0] <= 2.5


@pytest.mark.parametrize("locked_before", ["outbound_ops", "aggregate"])
def test_lock_taken_after_a_slow_read_waits_only_for_the_remaining_budget(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    locked_before: str,
) -> None:
    # The read before the locked statement takes 1 s of the budget (the
    # diagnostics' clock moves on by 1 s), then a writer takes an exclusive
    # lock: before the second column read ("outbound_ops") or before the
    # aggregate. The locked statement may wait only for the 1 s that remains.
    # A busy timeout left over from the earlier statement would allow about
    # 2 s of real waiting.
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
    expected = _observe_with(mod, db_path)
    slow_table = {"outbound_ops": "inbound_events", "aggregate": "outbound_ops"}[locked_before]
    offset = [0.0]
    real_clock = time.monotonic
    diagnosing = [False]
    writers: list[sqlite3.Connection] = []
    durations: list[float] = []
    columns = mod._columns
    diagnose = mod._progress_diagnostics

    def columns_then_lock(db, table):
        observed_columns = columns(db, table)
        if diagnosing[0] and table == slow_table and not writers:
            offset[0] += 1.0
            writer = sqlite3.connect(db_path, isolation_level=None)
            writer.execute("BEGIN EXCLUSIVE")
            writers.append(writer)
        return observed_columns

    def timed_diagnose(*args, **kwargs):
        diagnosing[0] = True
        started = real_clock()
        try:
            return diagnose(*args, **kwargs)
        finally:
            durations.append(real_clock() - started)
            diagnosing[0] = False
            for writer in writers:
                writer.execute("ROLLBACK")
                writer.close()

    monkeypatch.setattr(mod, "time", type("ShiftedClock", (), {"monotonic": staticmethod(lambda: real_clock() + offset[0])}))
    monkeypatch.setattr(mod, "_columns", columns_then_lock)
    monkeypatch.setattr(mod, "_progress_diagnostics", timed_diagnose)

    observed = _observe_with(mod, db_path)

    assert len(writers) == 1
    assert observed["progressDiagnostics"] in (
        _unavailable("diagnostic_budget_exceeded"),
        _unavailable("diagnostic_failed"),
    )
    assert _without_diagnostics(observed) == _without_diagnostics(expected)
    # Real time: the 1 s that remains plus a margin; a leftover timeout gives
    # about 2 s.
    assert len(durations) == 1
    assert durations[0] <= 1.5


def _step_the_clock(mod, monkeypatch: pytest.MonkeyPatch) -> None:
    """Make each clock read move on by more than the budget; the handler never runs."""
    readings = iter(range(0, 3_000, 3))
    monkeypatch.setattr(mod, "time", type("SteppingClock", (), {"monotonic": staticmethod(lambda: float(next(readings)))}))
    monkeypatch.setattr(mod, "DIAGNOSTIC_BUDGET_CHECK_OPCODES", 1_000_000_000)


def _diagnose_directly(mod, db_path: Path) -> dict:
    db = sqlite3.connect(db_path)
    try:
        return mod._progress_diagnostics(
            db,
            now_text=_PROGRESS_NOW.strftime(_CANONICAL),
            modifier="-900 seconds",
            stale_open_inbounds=1,
        )
    finally:
        db.close()


def test_values_that_arrive_after_the_budget_are_discarded(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The statement completes, but the handler never ran (it checks only every
    # N instructions) and the clock shows the budget spent, as after a long
    # lock wait that ends just as the lock is released.
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
    _step_the_clock(mod, monkeypatch)

    assert _diagnose_directly(mod, db_path) == _unavailable("diagnostic_budget_exceeded")


def test_column_read_that_ends_after_the_budget_reports_the_budget(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A diagnostic column is missing, but the read that finds it ends after the
    # budget: the overdue outcome takes precedence over the missing column.
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
        db.execute("ALTER TABLE outbound_ops DROP COLUMN echoed_at")
    within_budget = _diagnose_directly(mod, db_path)
    _step_the_clock(mod, monkeypatch)

    assert within_budget == _unavailable("diagnostic_columns_missing")
    assert _diagnose_directly(mod, db_path) == _unavailable("diagnostic_budget_exceeded")


def test_diagnostics_never_delay_another_instance_base_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Two instances, each with one stale row. While agent-a's diagnostics run,
    # the runtime finalises agent-b's stale row. Base reads agent-b before
    # that write, since base has no diagnostics; so must R46. Reading it after
    # would turn agent-b's breach into a clear and change what pages.
    mod = _load_module()
    commands = _record_emissions(mod, monkeypatch)
    paths = {}
    for name in ("agent-a", "agent-b"):
        path = tmp_path / "instances" / name / "bot.db"
        path.parent.mkdir(parents=True)
        with sqlite3.connect(path) as db:
            _create_schema(db)
            _insert_inbound(
                db, seq=1, received_at="2026-08-01 00:00:00", status="processing",
                conversation_key=_CHAT_KEY, chat_jid=f"{_CHAT_KEY}@s.whatsapp.net",
            )
        paths[name] = path
    argv = ["--data-root", str(tmp_path / "instances"), "--emit", "--json", "--repo-root", str(tmp_path)]
    expected = _run_cli(mod, monkeypatch, capsys, commands, argv, tmp_path / "state-expected")
    diagnose = mod._progress_diagnostics
    calls: list[int] = []

    def finalise_agent_b_during_the_first_diagnostics(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            with sqlite3.connect(paths["agent-b"]) as writer:
                writer.execute(
                    "UPDATE inbound_events SET processing_status = 'complete', completed_at = received_at WHERE seq = 1"
                )
        return diagnose(*args, **kwargs)

    monkeypatch.setattr(mod, "_progress_diagnostics", finalise_agent_b_during_the_first_diagnostics)

    observed = _run_cli(mod, monkeypatch, capsys, commands, argv, tmp_path / "state-observed")

    expected_status, expected_output, expected_emissions, expected_latches = expected
    status, output, emissions, latches = observed
    assert [item["instance"] for item in output["instances"]] == ["agent-a", "agent-b"]
    assert [_without_diagnostics(item) for item in output["instances"]] == [
        _without_diagnostics(item) for item in expected_output["instances"]
    ]
    assert output["instances"][1]["state"] == "active-breach"
    assert output["instances"][1]["counts"]["staleOpenInbounds"] == 1
    # agent-b's diagnostics run after the write and see the changed count.
    assert output["instances"][1]["progressDiagnostics"] == _unavailable("diagnostic_count_changed")
    assert status == expected_status == 0
    assert output["state"] == expected_output["state"] == "active-breach"
    assert emissions == expected_emissions
    assert latches == expected_latches


def test_diagnostic_budget_is_two_seconds() -> None:
    # docs/reply-guarantee.md states this value.
    assert _load_module().DIAGNOSTIC_BUDGET_SECONDS == 2.0


def test_diagnostics_connection_is_read_only_when_it_closes_last(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A WAL database whose writer has gone, so the observer's connections are
    # the only ones and the diagnostics connection closes last. Closing last,
    # a read-write connection checkpoints the WAL into the database file and
    # deletes the WAL; a read-only one changes neither. query_only must also
    # be on before the diagnostics read.
    mod = _load_module()
    scratch = tmp_path / "scratch" / "bot.db"
    scratch.parent.mkdir()
    path = tmp_path / "instances" / "agent-a" / "bot.db"
    path.parent.mkdir(parents=True)
    writer = sqlite3.connect(scratch)
    try:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute("PRAGMA wal_autocheckpoint=0")
        _create_schema(writer)
        _insert_row(writer, seq=1, age=1000)
        writer.commit()
        # Copied while the writer is open, as if it had stopped before its
        # closing checkpoint.
        for suffix in ("", "-wal", "-shm"):
            shutil.copyfile(f"{scratch}{suffix}", f"{path}{suffix}")
    finally:
        writer.close()
    database_bytes = path.read_bytes()
    wal_bytes = Path(f"{path}-wal").read_bytes()
    assert wal_bytes
    query_only: list[tuple[int]] = []
    diagnose = mod._progress_diagnostics

    def record_query_only_then_diagnose(db, *args, **kwargs):
        query_only.append(db.execute("PRAGMA query_only").fetchone())
        return diagnose(db, *args, **kwargs)

    monkeypatch.setattr(mod, "_progress_diagnostics", record_query_only_then_diagnose)

    observed = _observe_with(mod, path)

    assert observed["state"] == "active-breach"
    assert observed["database"]["walSidecarPresent"] is True
    assert observed["progressDiagnostics"] == _diagnosed(1, 1, 0)
    assert query_only == [(1,)]
    assert Path(f"{path}-wal").read_bytes() == wal_bytes
    assert path.read_bytes() == database_bytes


def test_wal_sidecar_is_read_before_the_diagnostics(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Base reads walSidecarPresent after its last count; R46 keeps that point,
    # ahead of the diagnostics, so their time cannot change what it reports.
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
    events: list[str] = []
    sidecar_name = f"{db_path.name}-wal"

    class _RecordingPath(type(db_path)):
        def is_file(self) -> bool:
            if self.name == sidecar_name:
                events.append("walSidecarPresent")
            return super().is_file()

    diagnose = mod._progress_diagnostics

    def recording_diagnose(*args, **kwargs):
        events.append("progressDiagnostics")
        return diagnose(*args, **kwargs)

    monkeypatch.setattr(mod, "Path", _RecordingPath)
    monkeypatch.setattr(mod, "_progress_diagnostics", recording_diagnose)

    observed = _observe_with(mod, db_path)

    assert events == ["walSidecarPresent", "progressDiagnostics"]
    assert observed["database"]["walSidecarPresent"] is False
    assert observed["progressDiagnostics"] == _diagnosed(1, 1, 0)


def test_budget_abort_removes_the_progress_handler(db_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
    expected = _observe_with(mod, db_path)
    _force_budget_abort(mod, monkeypatch)

    observed = _observe_with(mod, db_path)

    assert expected["progressDiagnostics"] == _diagnosed(1, 1, 0)
    assert observed["progressDiagnostics"] == _unavailable("diagnostic_budget_exceeded")
    assert _without_diagnostics(observed) == _without_diagnostics(expected)
    db = sqlite3.connect(db_path)
    try:
        assert mod._progress_diagnostics(
            db,
            now_text=_PROGRESS_NOW.strftime(_CANONICAL),
            modifier="-900 seconds",
            stale_open_inbounds=1,
        ) == _unavailable("diagnostic_budget_exceeded")
        # Left installed, the expired handler would interrupt this statement.
        assert db.execute("SELECT COUNT(*) FROM inbound_events").fetchone() == (1,)
        # The connection's own busy timeout (5 s) is back.
        assert db.execute("PRAGMA busy_timeout").fetchone() == (5000,)
    finally:
        db.close()


_FAN_OUT_SENDS = 200_000


class _RecordingConnection:
    """Pass a connection through, recording each statement the progress handler stops."""

    def __init__(self, db: sqlite3.Connection, interrupted: list[str]) -> None:
        self._db = db
        self._interrupted = interrupted
        self._statement: str | None = None

    def execute(self, sql: str, *params):
        self._statement = sql
        return self._db.execute(sql, *params)

    def set_progress_handler(self, handler, n: int):
        if handler is None:
            return self._db.set_progress_handler(None, n)

        def recording_handler():
            stop = handler()
            if stop:
                self._interrupted.append(self._statement)
            return stop

        return self._db.set_progress_handler(recording_handler, n)

    def __getattr__(self, name: str):
        return getattr(self._db, name)


def test_large_tied_send_fan_out_completes_within_the_budget_or_reports_it(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # One stale row with many tied echoed sends, all after receipt but older
    # than the window, so the EXISTS probe walks every one of them on
    # idx_outbound_ops_source before the one recent send, which has the
    # highest id. The production indexes are created so the plan matches
    # bot.db (src/core/database.ts:236-237).
    mod = _load_module()
    path = _progress_db(tmp_path)
    old = _ago_text(1500)
    with sqlite3.connect(path) as db:
        db.execute("CREATE INDEX idx_outbound_ops_status ON outbound_ops(status)")
        db.execute("CREATE INDEX idx_outbound_ops_source ON outbound_ops(source_inbound_seq)")
        _insert_row(db, seq=1, age=2000)
        db.executemany(
            """
            INSERT INTO outbound_ops (
              id, source_inbound_seq, status, is_terminal, replay_policy, submitted_at, echoed_at
            ) VALUES (?, 1, 'echoed', 0, 'unsafe', ?, ?)
            """,
            ((op_id, old, old) for op_id in range(1, _FAN_OUT_SENDS + 1)),
        )
        _insert_send(db, op_id=_FAN_OUT_SENDS + 1, seq=1, status="echoed", submitted_ago=30, echoed_ago=30)
    durations: list[float] = []
    interrupted: list[str] = []
    diagnose = mod._progress_diagnostics

    def timed(db, *args, **kwargs):
        started = time.monotonic()
        try:
            return diagnose(_RecordingConnection(db, interrupted), *args, **kwargs)
        finally:
            durations.append(time.monotonic() - started)

    monkeypatch.setattr(mod, "_progress_diagnostics", timed)

    observed = _observe_with(mod, path)

    assert observed["state"] == "active-breach"
    assert observed["counts"]["staleOpenInbounds"] == _base_stale_open_count(path) == 1
    assert observed["progressDiagnostics"] in (
        _diagnosed(1, 1, 1),
        _unavailable("diagnostic_budget_exceeded"),
    )
    # Absolute: the 2 s budget plus one second for the last check interval
    # and scheduling.
    assert len(durations) == 1
    assert durations[0] <= 3.0

    # A budget far below the cost of the walk: the progress handler stops the
    # aggregate part way, rather than the deadline check after it completes,
    # and the observation is the same.
    del interrupted[:]
    monkeypatch.setattr(mod, "DIAGNOSTIC_BUDGET_SECONDS", 0.001)
    aborted = _observe_with(mod, path)

    assert aborted["progressDiagnostics"] == _unavailable("diagnostic_budget_exceeded")
    assert interrupted == [mod._PROGRESS_DIAGNOSTICS_SQL]
    assert _without_diagnostics(aborted) == _without_diagnostics(observed)


def test_stale_count_change_between_the_reads_withholds_the_diagnostics(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A writer adds a stale row after staleOpenInbounds is read and before the
    # diagnostic statement runs. The observation keeps the count it read; the
    # diagnostics are withheld rather than describe a different set.
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_row(db, seq=1, age=1000)
    expected = _observe_with(mod, db_path)
    diagnose = mod._progress_diagnostics

    def write_then_diagnose(*args, **kwargs):
        writer = sqlite3.connect(db_path)
        try:
            with writer:
                _insert_row(writer, seq=2, age=1200, status="pending")
        finally:
            writer.close()
        return diagnose(*args, **kwargs)

    monkeypatch.setattr(mod, "_progress_diagnostics", write_then_diagnose)

    observed = _observe_with(mod, db_path)

    assert expected["progressDiagnostics"] == _diagnosed(1, 1, 0)
    assert observed["progressDiagnostics"] == _unavailable("diagnostic_count_changed")
    assert _without_diagnostics(observed) == _without_diagnostics(expected)
    assert observed["counts"]["staleOpenInbounds"] == 1


# --- R46: the observation matches base 82da64ac5 on generated databases -------

_OPEN_STATUSES = ("pending", "processing", "turn_done")
# Base's text comparison is kept, so the ISO form is generated alongside the
# runtime's own.
_RECEIPT_FORMATS = (_CANONICAL, _ISO)
_GENERATED_ROW = st.tuples(
    st.sampled_from((_CHAT_KEY, _OTHER_CHAT_KEY, _THIRD_CHAT_KEY)),
    st.sampled_from((*_OPEN_STATUSES, "complete", "failed")),
    st.sampled_from((0, 600, 899, 900, 901, 1500, 3599, 3600, 3601, 7200)),
    st.booleans(),
    st.sampled_from(_RECEIPT_FORMATS),
)
# (target seq, status, seconds ago). A target above the row count is an untied
# send. Every send also stores its echo message, which a chat-wide rule reads.
_GENERATED_SEND = st.tuples(
    st.integers(min_value=1, max_value=8),
    st.sampled_from(("submitted", "echoed", "maybe_sent", "quarantined")),
    st.sampled_from((-120, 30, 300, 899, 901, 1500, 3600)),
)
_BASE_STATE = {True: "active-breach", False: "clear"}
# Base 82da64ac5, deploy/scripts/reply-guarantee-observer.py:196-208, verbatim.
_BASE_STALE_OPEN_INBOUNDS_SQL = """
                SELECT COUNT(*)
                FROM inbound_events i
                WHERE i.processing_status IN ('pending', 'processing', 'turn_done')
                  AND i.received_at < datetime(?, ?)
                  AND NOT EXISTS (
                    SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq = i.seq
                  )
                """


def _base_stale_open_count(path: Path) -> int:
    """Run base's own staleOpenInbounds query on the generated database.

    Base 82da64ac5 then adds staleRecoveryJobs into active_count (:295), zero
    here since no recovery jobs are generated; active_count > 0 is
    active-breach (:301-302), and the active latch is state == "active-breach"
    (:515).
    """
    db = sqlite3.connect(path)
    try:
        row = db.execute(
            _BASE_STALE_OPEN_INBOUNDS_SQL,
            (_PROGRESS_NOW.strftime("%Y-%m-%d %H:%M:%S"), "-900 seconds"),
        ).fetchone()
    finally:
        db.close()
    return int(row[0])


def _insert_generated_case(
    db: sqlite3.Connection,
    rows: list[tuple[str, str, int, bool, str]],
    sends: list[tuple[int, str, int]],
) -> None:
    for index, (conversation_key, status, age, has_terminal, receipt_format) in enumerate(rows):
        seq = index + 1
        _insert_inbound(
            db,
            seq=seq,
            received_at=(_PROGRESS_NOW - timedelta(seconds=age)).strftime(receipt_format),
            status=status,
            conversation_key=conversation_key,
            chat_jid=f"{conversation_key}@s.whatsapp.net",
        )
        if has_terminal:
            db.execute(
                """
                INSERT INTO turn_terminal_records (
                  id, inbound_seq, inbound_seq_key, inbound_disposition,
                  delivery_kind, delivery_op_id, reply_guarantee_disarmed
                ) VALUES (?, ?, ?, 'transferred_to_recovery_owner', 'enqueued', NULL, 0)
                """,
                (100 + seq, seq, seq),
            )
    for index, (target, status, ago) in enumerate(sends):
        tied = target <= len(rows)
        _insert_send(
            db,
            op_id=200 + index,
            seq=target if tied else None,
            status=status,
            submitted_ago=ago,
            echoed_ago=ago if status == "echoed" else None,
            echo_message_ago=ago,
            conversation_key=rows[target - 1][0] if tied else _CHAT_KEY,
        )


def test_diagnostic_statement_copies_the_base_stale_predicate() -> None:
    predicate = _BASE_STALE_OPEN_INBOUNDS_SQL.split("SELECT COUNT(*)\n", 1)[1].rstrip()

    assert predicate.lstrip().startswith("FROM inbound_events i")
    assert predicate in _load_module()._PROGRESS_DIAGNOSTICS_SQL


@properties
@given(
    rows=st.lists(_GENERATED_ROW, min_size=1, max_size=6),
    sends=st.lists(_GENERATED_SEND, max_size=6),
)
# A recent untied echo in the stale row's chat.
@example(rows=[(_CHAT_KEY, "processing", 1500, False, _CANONICAL)], sends=[(8, "echoed", 300)])
# An open row with a terminal record ahead of a stale row in its chat.
@example(
    rows=[(_CHAT_KEY, "processing", 1500, True, _CANONICAL), (_CHAT_KEY, "pending", 1000, False, _CANONICAL)],
    sends=[],
)
# A row an hour old, written in ISO form: base's text comparison leaves it out.
@example(rows=[(_CHAT_KEY, "processing", 3600, False, _ISO)], sends=[])
def test_observation_matches_base_sql_for_generated_rows(
    rows: list[tuple[str, str, int, bool, str]],
    sends: list[tuple[int, str, int]],
) -> None:
    with private_case() as (root, _patch):
        path = _progress_db(root)
        with sqlite3.connect(path) as db:
            _insert_generated_case(db, rows, sends)
        base_count = _base_stale_open_count(path)
        result = _observe_progress(path)
    latches = _load_module()._desired_latches(result, _NO_LATCHES)
    diagnostics = result["progressDiagnostics"]

    assert result["counts"]["staleOpenInbounds"] == base_count
    assert result["state"] == _BASE_STATE[base_count > 0]
    assert latches["reply-guarantee-active-breach"] is (base_count > 0)
    assert diagnostics["available"] is True
    assert diagnostics["staleRows"] == base_count
    assert (diagnostics["staleChats"] > 0) is (base_count > 0)
    assert diagnostics["staleChats"] <= diagnostics["staleRows"]
    assert diagnostics["staleRowsWithRecentSend"] <= diagnostics["staleRows"]


def test_active_breach_is_a_successful_observation_not_a_process_failure(
    db_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(db, seq=1, received_at="2026-08-01 00:00:00", status="processing")

    status = mod.main([
        "--data-root", str(db_path.parents[1]),
        "--instance", "agent-a",
        "--json",
    ])

    assert status == 0
    assert json.loads(capsys.readouterr().out)["state"] == "active-breach"


def test_any_inconclusive_instance_makes_fleet_result_inconclusive(tmp_path: Path) -> None:
    mod = _load_module()
    data_root = tmp_path / "instances"
    active_path = data_root / "agent-a" / "bot.db"
    unknown_path = data_root / "agent-b" / "bot.db"
    active_path.parent.mkdir(parents=True)
    unknown_path.parent.mkdir(parents=True)
    with sqlite3.connect(active_path) as db:
        _create_schema(db)
        _insert_inbound(db, seq=1, received_at="2026-08-01 00:00:00", status="processing")
    sqlite3.connect(unknown_path).close()

    result = mod.observe_instances(
        data_root,
        instance=None,
        now=datetime(2026, 8, 15, 22, 0, tzinfo=UTC),
        stale_seconds=900,
    )

    assert result["state"] == "inconclusive"
    assert {item["state"] for item in result["instances"]} == {"active-breach", "inconclusive"}


def _find_python39() -> str | None:
    candidates = ["/usr/bin/python3", "python3.9"]
    for cand in candidates:
        path = cand if cand.startswith("/") else shutil.which(cand)
        if not path or not os.path.exists(path):
            continue
        out = subprocess.run([path, "--version"], capture_output=True, text=True, check=False)
        if (out.stdout + out.stderr).strip().startswith("Python 3.9"):
            return path
    return None


def test_observer_avoids_python_311_only_utc_symbol() -> None:
    # The observer runs under whatever interpreter a host provides. It must use the
    # 3.9-compatible `timezone.utc` idiom, not the 3.11+ `datetime.UTC` symbol, so an
    # older-but-present interpreter does not crash it on import.
    src = _SCRIPT.read_text(encoding="utf-8")
    assert "import UTC" not in src, "observer must not use the 3.11+ datetime.UTC symbol"


@pytest.mark.skipif(_find_python39() is None, reason="no Python 3.9 interpreter available")
def test_observer_imports_under_python39() -> None:
    py39 = _find_python39()
    assert py39 is not None
    completed = subprocess.run(
        [py39, str(_SCRIPT), "--help"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr


def _fake_executable(path: Path, status_env: str) -> Path:
    path.write_text(f"#!/bin/bash\nexit \"${{{status_env}:-0}}\"\n", encoding="utf-8")
    path.chmod(0o700)
    return path


def _fake_python(path: Path, version: str, *, body: str = "exit 0") -> Path:
    # Fake interpreter for the capability contract: `--version` prints the given
    # version string (consumed by whatsoup_probe_python); any other invocation
    # (the observer run) executes `body`. Mirrors how the wrapper gates via the
    # canonical host-capabilities resolver rather than a bespoke probe.
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "#!/bin/bash\n"
        f'if [ "$1" = "--version" ]; then echo "Python {version}"; exit 0; fi\n'
        f"{body}\n",
        encoding="utf-8",
    )
    path.chmod(0o700)
    return path


def _fake_capable_python(path: Path, status_env: str) -> Path:
    # A capability-satisfying interpreter (>= 3.12); the observer invocation
    # carries the injected status so the exit-code-composition tests stay honest
    # under a capable interpreter, independent of the capability gate.
    return _fake_python(path, "3.12.9", body=f'exit "${{{status_env}:-0}}"')


def _fake_incapable_python(path: Path) -> Path:
    # Emulates Apple Python 3.9: below the declared >= 3.12 baseline. The observer
    # must never be run against it.
    return _fake_python(
        path,
        "3.9.6",
        body='echo "OBSERVER_SHOULD_NOT_RUN" >&2\nexit 1',
    )


def _wrapper_status(
    tmp_path: Path,
    drain_status: int,
    observer_status: int,
) -> int:
    fake_node = _fake_executable(tmp_path / "node", "FAKE_DRAIN_STATUS")
    fake_python = _fake_capable_python(tmp_path / "python3", "FAKE_OBSERVER_STATUS")
    env = {
        **os.environ,
        "WHATSOUP_NODE": str(fake_node),
        "WHATSOUP_PYTHON": str(fake_python),
        "FAKE_DRAIN_STATUS": str(drain_status),
        "FAKE_OBSERVER_STATUS": str(observer_status),
    }

    completed = subprocess.run(
        ["bash", str(_WRAPPER)],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )

    return completed.returncode


def test_wrapper_classifies_incapable_pinned_interpreter_as_inconclusive(tmp_path: Path) -> None:
    # A pinned interpreter below the declared >= 3.12 baseline (e.g. Apple Python
    # 3.9) is an execution-context capability problem, not a reply-drain workload
    # breach. The wrapper must report inconclusive (exit 2), not workload failure
    # (exit 1), must not run the observer against it, and must surface structured
    # capability evidence (status/version) rather than a bare verdict.
    fake_node = _fake_executable(tmp_path / "node", "FAKE_DRAIN_STATUS")
    fake_python = _fake_incapable_python(tmp_path / "python3")
    completed = subprocess.run(
        ["bash", str(_WRAPPER)],
        env={
            **os.environ,
            "WHATSOUP_NODE": str(fake_node),
            "WHATSOUP_PYTHON": str(fake_python),
            "FAKE_DRAIN_STATUS": "0",
        },
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 2, completed.stderr
    assert "OBSERVER_SHOULD_NOT_RUN" not in completed.stderr
    assert "status=incompatible" in completed.stderr
    assert "3.9.6" in completed.stderr


def test_wrapper_discovers_capable_interpreter_via_managed_venv(tmp_path: Path) -> None:
    # With no WHATSOUP_PYTHON pin, the wrapper must resolve through the canonical
    # host-capabilities contract (managed quality-venv first), not trust whatever
    # `python3` an ambient launchd PATH yields. A capable managed-venv interpreter
    # must be selected and the observer run against it.
    record = tmp_path / "which_ran_observer"
    venv_python = _fake_python(
        tmp_path / "venv" / "bin" / "python",
        "3.12.9",
        body=f'echo VENV_OBSERVER_RAN >> "{record}"\nexit 0',
    )
    assert venv_python.exists()
    fake_node = _fake_executable(tmp_path / "node", "FAKE_DRAIN_STATUS")
    env = {
        **os.environ,
        "WHATSOUP_NODE": str(fake_node),
        "FAKE_DRAIN_STATUS": "0",
        "WHATSOUP_QUALITY_VENV": str(tmp_path / "venv"),
    }
    env.pop("WHATSOUP_PYTHON", None)

    completed = subprocess.run(
        ["bash", str(_WRAPPER)],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )

    ran = record.read_text(encoding="utf-8") if record.exists() else ""
    assert "VENV_OBSERVER_RAN" in ran, (completed.stderr, ran)
    assert completed.returncode == 0, completed.stderr


def test_wrapper_disables_bytecode_writes_for_observer(tmp_path: Path) -> None:
    # The observer runs from an immutable release tree. Python must not write
    # __pycache__/.pyc files there (that pollution later trips the release-drift
    # check), so the wrapper must run the observer with PYTHONDONTWRITEBYTECODE=1.
    record = tmp_path / "observer_env"
    fake_python = _fake_python(
        tmp_path / "python3",
        "3.12.9",
        body=f'echo "PYTHONDONTWRITEBYTECODE=${{PYTHONDONTWRITEBYTECODE:-UNSET}}" > "{record}"\nexit 0',
    )
    fake_node = _fake_executable(tmp_path / "node", "FAKE_DRAIN_STATUS")
    env = {
        **os.environ,
        "WHATSOUP_NODE": str(fake_node),
        "WHATSOUP_PYTHON": str(fake_python),
        "FAKE_DRAIN_STATUS": "0",
    }
    env.pop("PYTHONDONTWRITEBYTECODE", None)

    subprocess.run(
        ["bash", str(_WRAPPER)],
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )

    assert record.read_text(encoding="utf-8").strip() == "PYTHONDONTWRITEBYTECODE=1"


def test_wrapper_succeeds_when_both_lanes_succeed(tmp_path: Path) -> None:
    assert _wrapper_status(tmp_path, 0, 0) == 0


def test_wrapper_preserves_drain_failure(tmp_path: Path) -> None:
    assert _wrapper_status(tmp_path, 1, 0) == 1


def test_wrapper_accepts_a_completed_observer_lane(tmp_path: Path) -> None:
    assert _wrapper_status(tmp_path, 0, 0) == 0


def test_wrapper_gives_inconclusive_precedence_over_drain_failure(tmp_path: Path) -> None:
    assert _wrapper_status(tmp_path, 1, 2) == 2


def test_wrapper_preserves_observer_inconclusive(tmp_path: Path) -> None:
    assert _wrapper_status(tmp_path, 0, 2) == 2


def test_wrapper_integrates_observer_without_masking_failures() -> None:
    wrapper = _WRAPPER.read_text(encoding="utf-8")

    assert "reply-guarantee-observer.py" in wrapper
    assert "WHATSOUP_PYTHON" in wrapper
    assert "WHATSOUP_REPLY_GUARANTEE_DATA_ROOT" in wrapper
    assert re.search(r"reply-guarantee-observer\.py[^\n]*\|\|\s*(true|:)", wrapper) is None


def test_wrapper_runs_observer_when_node_lane_is_unavailable(tmp_path: Path) -> None:
    fake_python = _fake_python(tmp_path / "python3", "3.12.9", body="echo OBSERVER_RAN\nexit 0")

    completed = subprocess.run(
        ["bash", str(_WRAPPER)],
        env={
            **os.environ,
            "WHATSOUP_NODE": str(tmp_path / "missing-node"),
            "WHATSOUP_PYTHON": str(fake_python),
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 2
    assert "OBSERVER_RAN" in completed.stdout


def test_wrapper_runs_drain_when_python_lane_is_unavailable(tmp_path: Path) -> None:
    fake_node = tmp_path / "node"
    fake_node.write_text("#!/bin/bash\necho DRAIN_RAN\nexit 0\n", encoding="utf-8")
    fake_node.chmod(0o700)

    completed = subprocess.run(
        ["bash", str(_WRAPPER)],
        env={
            **os.environ,
            "WHATSOUP_NODE": str(fake_node),
            "WHATSOUP_PYTHON": str(tmp_path / "missing-python"),
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 2
    assert "DRAIN_RAN" in completed.stdout


def test_emission_keeps_sources_and_instances_separate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    mod = _load_module()
    commands: list[list[str]] = []
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))

    class _Completed:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(command, **_kwargs):
        commands.append(command)
        return _Completed()

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    result = {
        "state": "active-breach",
        "instances": [
            {
                "instance": "agent-a",
                "state": "active-breach",
                "counts": {"staleOpenInbounds": 1, "unresolvedContinuityCandidates": 1},
            },
            {"instance": "agent-b", "state": "recovery-debt", "counts": {"failedTerminalDebt": 2}},
        ],
    }

    assert mod._emit(tmp_path, result) is True

    projected = [
        (
            command[command.index("--instance") + 1],
            command[command.index("--source") + 1],
            "--clear" in command,
        )
        for command in commands
    ]
    assert ("agent-a", "reply-guarantee-active-breach", False) in projected
    assert ("agent-a", "reply-guarantee-recovery-debt", False) in projected
    assert ("agent-b", "reply-guarantee-recovery-debt", False) in projected
    assert not any(clear for _instance, _source, clear in projected)

    command_count = len(commands)
    assert mod._emit(tmp_path, result) is True
    assert len(commands) == command_count

    clear_result = {
        "state": "clear",
        "instances": [
            {"instance": "agent-a", "state": "clear", "counts": {}},
            {"instance": "agent-b", "state": "clear", "counts": {}},
        ],
    }
    assert mod._emit(tmp_path, clear_result) is True
    clear_projection = [
        (
            command[command.index("--instance") + 1],
            command[command.index("--source") + 1],
            "--clear" in command,
        )
        for command in commands[command_count:]
    ]
    assert ("agent-a", "reply-guarantee-active-breach", True) in clear_projection
    assert ("agent-a", "reply-guarantee-recovery-debt", True) in clear_projection
    assert ("agent-b", "reply-guarantee-recovery-debt", True) in clear_projection
    assert all(clear for _instance, _source, clear in clear_projection)


def test_rejected_emission_does_not_arm_latch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    mod = _load_module()
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    commands: list[list[str]] = []

    class _Rejected:
        returncode = 1
        stdout = ""
        stderr = "rejected"

    def fake_run(command, **_kwargs):
        commands.append(command)
        return _Rejected()

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    result = {
        "state": "recovery-debt",
        "instances": [
            {"instance": "agent-a", "state": "recovery-debt", "counts": {"failedTerminalDebt": 1}},
        ],
    }

    assert mod._emit(tmp_path, result) is False
    assert mod._emit(tmp_path, result) is False
    assert len(commands) == 2
    assert all(command[command.index("--source") + 1] == "reply-guarantee-recovery-debt" for command in commands)


def test_invalid_latch_state_emits_observer_failure_and_remains_inconclusive(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    mod = _load_module()
    state_root = tmp_path / "state"
    state_root.mkdir(mode=0o700)
    (state_root / "reply-guarantee-observer-state.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state_root))
    commands: list[list[str]] = []

    class _Completed:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(command, **_kwargs):
        commands.append(command)
        return _Completed()

    monkeypatch.setattr(mod.subprocess, "run", fake_run)

    assert mod._emit(tmp_path, {"state": "clear", "instances": []}) is False
    assert len(commands) == 1
    command = commands[0]
    assert command[command.index("--instance") + 1] == "reply-guarantee-fleet"
    assert command[command.index("--source") + 1] == "reply-guarantee-observer"
    assert command[command.index("--severity") + 1] == "error"
    assert "--clear" not in command


def test_cli_emits_recovery_debt_through_existing_bot_errors_outbox(
    db_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    mod = _load_module()
    with sqlite3.connect(db_path) as db:
        _insert_inbound(
            db,
            seq=1,
            received_at="2026-08-01 00:00:00",
            status="failed",
            failure_class="crash_recovery",
            continuity="crash_reclaim_no_terminal_outbound",
        )
    outbox = tmp_path / "outbox"
    state = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))

    status = mod.main(
        [
            "--data-root",
            str(db_path.parents[1]),
            "--instance",
            "agent-a",
            "--emit",
            "--json",
            "--repo-root",
            str(_SCRIPT.parents[2]),
        ]
    )

    assert status == 0
    result = json.loads(capsys.readouterr().out)
    assert result["state"] == "recovery-debt"
    events = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(outbox.glob("*.json"))]
    assert any(
        event["instance"] == "agent-a"
        and event["source"] == "reply-guarantee-recovery-debt"
        and event["eventType"] == "alert"
        for event in events
    )
    assert all("private-conversation" not in json.dumps(event) for event in events)
