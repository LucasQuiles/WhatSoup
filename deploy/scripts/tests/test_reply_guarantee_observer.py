from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "reply-guarantee-observer.py"
_WRAPPER = Path(__file__).resolve().parents[1] / "reply-guarantee-drain.sh"


def _load_module():
    spec = importlib.util.spec_from_file_location("reply_guarantee_observer", _SCRIPT)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _create_schema(db: sqlite3.Connection) -> None:
    db.executescript(
        """
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
          reply_guarantee_disarmed INTEGER NOT NULL
        );
        CREATE TABLE outbound_ops (
          id INTEGER PRIMARY KEY,
          source_inbound_seq INTEGER,
          status TEXT NOT NULL,
          is_terminal INTEGER NOT NULL,
          replay_policy TEXT NOT NULL
        );
        CREATE TABLE turn_recovery_jobs (
          id INTEGER PRIMARY KEY,
          terminal_record_id INTEGER NOT NULL,
          source_inbound_seq INTEGER NOT NULL,
          state TEXT NOT NULL,
          next_attempt_at TEXT NOT NULL,
          claim_expires_at TEXT
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
            f"message-{seq}",
            f"private-conversation-{seq}",
            f"private-jid-{seq}",
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


def test_wrapper_preserves_observer_active_breach(tmp_path: Path) -> None:
    assert _wrapper_status(tmp_path, 0, 1) == 1


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
