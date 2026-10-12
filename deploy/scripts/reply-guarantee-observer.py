#!/usr/bin/env python3
"""Observe durable reply obligations without replaying or mutating them."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

DEFAULT_STALE_SECONDS = 15 * 60
INSTANCE_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,29}$")
STATE_PRECEDENCE = {
    "clear": 0,
    "recovery-debt": 1,
    "active-breach": 2,
    "inconclusive": 3,
}
# A scheduled agent job runs as a synthetic inbound whose message id carries
# this case-sensitive prefix (src/core/synthetic-turn-source.ts). It owes no
# user a reply, so its continuity mark is not reply-guarantee debt (#3754).
SYNTHETIC_SOURCE_MESSAGE_ID_GLOB = "agentjob-*"
REQUIRED_COLUMNS = {
    "inbound_events": {
        "seq",
        "message_id",
        "received_at",
        "processing_status",
        "continuity_candidate_reason",
        "failure_class",
    },
    "turn_terminal_records": {
        "id",
        "inbound_seq",
        "attempt_failure_class",
        "inbound_disposition",
        "delivery_kind",
        "delivery_op_id",
        "reply_guarantee_disarmed",
    },
    "outbound_ops": {"id", "source_inbound_seq", "status", "is_terminal"},
    "turn_recovery_jobs": {
        "id",
        "terminal_record_id",
        "source_inbound_seq",
        "state",
        "next_attempt_at",
        "claim_expires_at",
    },
}
# R46: columns read only by the progress diagnostics. They are deliberately not
# REQUIRED_COLUMNS: without them the observation is unchanged and
# progressDiagnostics reports DIAGNOSTIC_COLUMNS_MISSING.
DIAGNOSTIC_COLUMNS = {
    "inbound_events": {"conversation_key"},
    "outbound_ops": {"submitted_at", "echoed_at"},
}
CONTEXT_HINTS = [
    "Verify the probe is running as the target user; direct SSH, GUI Terminal, launchd, and wrappers can expose different HOME and credential contexts.",
    "On macOS inspect the GUI launchd domain with launchctl print gui/$(id -u) and confirm the service WorkingDirectory and effective user.",
    "Resolve instance databases through WHATSOUP_DATA_DIR or XDG_DATA_HOME, falling back to the target user's ~/.local/share/whatsoup/instances directory; absence in another profile is not proof that the instance is unconfigured.",
]
DEBT_HINTS = [
    "Preserve bot.db together with bot.db-wal and bot.db-shm before any repair or restart that could alter recovery evidence.",
    "Audit the exact inbound, terminal, outbound, and recovery ownership chain before retrying; broad failed-row replay is unsafe.",
]
ACTIVE_HINTS = [
    "Inspect runtime and recovery-worker logs for the affected instance before restarting it.",
    *DEBT_HINTS,
]
SOURCE_LATCH_KEYS = {
    "reply-guarantee-active-breach": "activeAlerted",
    "reply-guarantee-recovery-debt": "debtAlerted",
    "reply-guarantee-observer": "observerAlerted",
}
SOURCE_SEVERITIES = {
    "reply-guarantee-active-breach": "critical",
    "reply-guarantee-recovery-debt": "warning",
    "reply-guarantee-observer": "error",
}


_UNRESOLVED_CONTINUITY_CANDIDATES_SQL = """
                SELECT COUNT(*)
                FROM inbound_events i
                WHERE i.continuity_candidate_reason IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq = i.seq
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM outbound_ops o WHERE o.source_inbound_seq = i.seq
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM turn_recovery_jobs j WHERE j.source_inbound_seq = i.seq
                  )"""

# R46 progress diagnostics. They are additions only: staleOpenInbounds, the
# state, every alert latch and the exit code come from the pre-R46 queries
# below and never read these values.
DIAGNOSTIC_COLUMNS_MISSING = "diagnostic_columns_missing"
DIAGNOSTIC_FAILED = "diagnostic_failed"
DIAGNOSTIC_COUNT_CHANGED = "diagnostic_count_changed"
DIAGNOSTIC_BUDGET_EXCEEDED = "diagnostic_budget_exceeded"
# Wall-clock budget for the diagnostics of one instance, counted from before
# their first read, so lock waits count against it. A healthy run costs one
# indexed probe per stale row, a few milliseconds. The diagnostics run after
# every instance's base observation and before anything is printed or
# emitted. Each conclusive instance adds up to about the budget plus one
# progress-check interval, about 2 s, and instances run one after another.
# Every emission waits for all of them, so a host with ten conclusive
# instances can hold its alerts back by about 20 s of the 60 s observer
# cadence (whatsoup-reply-guarantee.timer).
DIAGNOSTIC_BUDGET_SECONDS = 2.0
# SQLite VM instructions between budget checks.
DIAGNOSTIC_BUDGET_CHECK_OPCODES = 1000

# One statement, so one read snapshot. The stale CTE is the staleOpenInbounds
# predicate copied verbatim. staleRowsWithRecentSend counts stale rows with an
# accepted send tied to them through outbound_ops.source_inbound_seq whose send
# time is after receipt, no later than now and within the stale threshold. The
# send time is the first of echoed_at and submitted_at that parses as a time,
# so a malformed echoed_at does not hide a valid submitted_at. Untied sends
# (the queued-task receipt, startup, admin and health notices) never count.
# outbound_ops records no message role, so a command reply sent through the
# chat queue while a turn is active is tied to that turn and counts; that is
# one reason these values never page.
# The EXISTS probe stops at the first match on idx_outbound_ops_source; the
# unary + keeps the planner off idx_outbound_ops_status.
# Parameters: now, modifier, now, now, modifier.
_PROGRESS_DIAGNOSTICS_SQL = """
                WITH stale AS (
                SELECT i.seq, i.conversation_key, i.received_at
                FROM inbound_events i
                WHERE i.processing_status IN ('pending', 'processing', 'turn_done')
                  AND i.received_at < datetime(?, ?)
                  AND NOT EXISTS (
                    SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq = i.seq
                  )
                )
                SELECT
                  COUNT(*),
                  COUNT(DISTINCT s.conversation_key),
                  COUNT(CASE WHEN EXISTS (
                    SELECT 1 FROM outbound_ops o
                    WHERE o.source_inbound_seq = s.seq
                      AND +o.status IN ('submitted', 'echoed')
                      AND COALESCE(datetime(o.echoed_at), datetime(o.submitted_at)) > datetime(s.received_at)
                      AND COALESCE(datetime(o.echoed_at), datetime(o.submitted_at)) <= datetime(?)
                      AND COALESCE(datetime(o.echoed_at), datetime(o.submitted_at)) >= datetime(?, ?)
                  ) THEN 1 END)
                FROM stale s"""


def _progress_diagnostics(
    db: sqlite3.Connection,
    *,
    now_text: str,
    modifier: str,
    stale_open_inbounds: int,
) -> dict[str, Any]:
    """Describe the staleOpenInbounds set; never affects paging.

    staleRows must equal staleOpenInbounds, which the base observation read
    earlier; otherwise the stale set changed between the two reads and the
    diagnostics are withheld. That is a count check only: a write that leaves
    the count unchanged is not detected. staleChats is the number of distinct
    chats with a stale row. It makes no claim about queue position: in single
    and shared scope one queue serves every chat.
    """
    deadline = time.monotonic() + DIAGNOSTIC_BUDGET_SECONDS

    def over_budget() -> bool:
        # True makes SQLite interrupt the running statement. The handler only
        # reads the clock. CPython's sqlite3 clears any exception raised inside
        # a progress handler and ends the statement as interrupted, so a
        # KeyboardInterrupt that arrives while the handler runs is not
        # re-raised; the diagnostics report unavailable and the run goes on.
        # OUT-OF-MODEL: the service stops the observer with SIGTERM, which
        # Python does not turn into an exception.
        return time.monotonic() > deadline

    def wait_for_locks_only_within_the_budget() -> None:
        # A lock wait is not VM work, so the progress handler cannot end it;
        # a busy timeout of the remaining budget does.
        remaining_ms = math.ceil((deadline - time.monotonic()) * 1000)
        db.execute(f"PRAGMA busy_timeout={max(remaining_ms, 0)}")

    # The catch is deliberately broad: whatever goes wrong here, the caller
    # keeps the observation it already built, so a diagnostic can never turn an
    # observation inconclusive, raise, or change the exit code.
    columns_missing = False
    try:
        (saved_busy_timeout,) = db.execute("PRAGMA busy_timeout").fetchone()
        db.set_progress_handler(over_budget, DIAGNOSTIC_BUDGET_CHECK_OPCODES)
        try:
            for table, required in DIAGNOSTIC_COLUMNS.items():
                wait_for_locks_only_within_the_budget()
                if required - _columns(db, table):
                    columns_missing = True
                    break
            if not columns_missing:
                wait_for_locks_only_within_the_budget()
                stale_rows, stale_chats, recent = db.execute(
                    _PROGRESS_DIAGNOSTICS_SQL,
                    (now_text, modifier, now_text, now_text, modifier),
                ).fetchone()
        finally:
            db.set_progress_handler(None, 0)
            db.execute(f"PRAGMA busy_timeout={int(saved_busy_timeout)}")
    except Exception:  # noqa: BLE001 - see the comment above the try
        over = time.monotonic() > deadline
        return {"available": False, "reason": DIAGNOSTIC_BUDGET_EXCEEDED if over else DIAGNOSTIC_FAILED}
    # Checked first: anything that ends after the budget is spent, a missing
    # column included, reports the budget, and values read late are discarded.
    if time.monotonic() > deadline:
        return {"available": False, "reason": DIAGNOSTIC_BUDGET_EXCEEDED}
    if columns_missing:
        return {"available": False, "reason": DIAGNOSTIC_COLUMNS_MISSING}
    if stale_rows != stale_open_inbounds:
        return {"available": False, "reason": DIAGNOSTIC_COUNT_CHANGED}
    return {
        "available": True,
        "staleRows": stale_rows,
        "staleChats": stale_chats,
        "staleRowsWithRecentSend": recent,
    }


def _diagnose_instance(
    db_path: Path,
    *,
    now_text: str,
    modifier: str,
    stale_open_inbounds: int,
) -> dict[str, Any]:
    """Diagnose one instance on a connection of its own, opened as base opens its.

    Base's connection is closed by now. This one is read-only with the same URI
    flags, path checks and query_only setting, and it closes before return.
    """
    try:
        if db_path.is_symlink() or not db_path.is_file():
            return {"available": False, "reason": DIAGNOSTIC_FAILED}
        db = sqlite3.connect(_readonly_uri(db_path), uri=True, timeout=5)
        try:
            db.execute("PRAGMA query_only=ON")
            return _progress_diagnostics(
                db,
                now_text=now_text,
                modifier=modifier,
                stale_open_inbounds=stale_open_inbounds,
            )
        finally:
            db.close()
    except Exception:  # noqa: BLE001 - diagnostics never raise; see _progress_diagnostics
        return {"available": False, "reason": DIAGNOSTIC_FAILED}


def _attach_progress_diagnostics(
    observations: list[dict[str, Any]],
    candidates: list[tuple[str, Path]],
    *,
    now: datetime,
    stale_seconds: int,
) -> None:
    """Add progressDiagnostics to each conclusive observation, in base's order."""
    # The same values observe_database computes, so the stale predicate
    # matches the count it read.
    now_text = _utc_sqlite(now)
    modifier = f"-{stale_seconds} seconds"
    for observation, (_name, db_path) in zip(observations, candidates):
        if observation["state"] == "inconclusive":
            continue
        observation["progressDiagnostics"] = _diagnose_instance(
            db_path,
            now_text=now_text,
            modifier=modifier,
            stale_open_inbounds=observation["counts"]["staleOpenInbounds"],
        )


def _utc_sqlite(now: datetime) -> str:
    normalized = now.astimezone(timezone.utc)
    return normalized.strftime("%Y-%m-%d %H:%M:%S")


def _readonly_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


def _columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in db.execute(f'PRAGMA table_info("{table}")')}


def _schema_gap(db: sqlite3.Connection) -> dict[str, list[str]]:
    gaps: dict[str, list[str]] = {}
    for table, required in REQUIRED_COLUMNS.items():
        observed = _columns(db, table)
        missing = sorted(required - observed)
        if missing:
            gaps[table] = missing
    return gaps


def _scalar(db: sqlite3.Connection, sql: str, params: tuple[Any, ...]) -> int:
    row = db.execute(sql, params).fetchone()
    return int(row[0]) if row else 0


def _inconclusive(instance: str, db_path: Path, reason: str) -> dict[str, Any]:
    return {
        "instance": instance,
        "state": "inconclusive",
        "healthImpact": "unknown",
        "reason": reason,
        "database": {
            "name": db_path.name,
            "walSidecarPresent": Path(f"{db_path}-wal").is_file(),
            "readMode": "sqlite-uri-mode-ro",
        },
        "counts": None,
        "resolutionHints": [*CONTEXT_HINTS, *DEBT_HINTS],
    }


def observe_database(
    db_path: Path,
    *,
    instance: str,
    now: datetime,
    stale_seconds: int,
) -> dict[str, Any]:
    if stale_seconds <= 0:
        return _inconclusive(instance, db_path, "stale threshold must be positive")
    if db_path.is_symlink() or not db_path.is_file():
        return _inconclusive(instance, db_path, "database path is missing, non-regular, or symlinked")

    try:
        db = sqlite3.connect(_readonly_uri(db_path), uri=True, timeout=5)
    except sqlite3.Error as error:
        return _inconclusive(instance, db_path, f"read-only database open failed: {type(error).__name__}")

    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA busy_timeout=5000")
        schema_gap = _schema_gap(db)
        if schema_gap:
            return _inconclusive(
                instance,
                db_path,
                "required reply-guarantee schema is missing or incompatible: "
                + ", ".join(f"{table}({','.join(columns)})" for table, columns in sorted(schema_gap.items())),
            )

        now_text = _utc_sqlite(now)
        invalid_timestamps = _scalar(
            db,
            """
            SELECT
              (SELECT COUNT(*) FROM inbound_events
               WHERE processing_status IN ('pending', 'processing', 'turn_done')
                 AND (datetime(received_at) IS NULL
                      OR datetime(received_at) > datetime(?, '+5 minutes')))
              +
              (SELECT COUNT(*) FROM turn_recovery_jobs
               WHERE (state = 'pending' AND datetime(next_attempt_at) IS NULL)
                  OR (state = 'pending' AND datetime(next_attempt_at) > datetime(?, '+5 minutes'))
                  OR (state = 'claimed' AND datetime(claim_expires_at) IS NULL)
                  OR (state = 'claimed' AND datetime(claim_expires_at) > datetime(?, '+5 minutes')))
            """,
            (now_text, now_text, now_text),
        )
        if invalid_timestamps > 0:
            return _inconclusive(instance, db_path, "active reply-obligation timestamp evidence is invalid")
        modifier = f"-{stale_seconds} seconds"
        counts = {
            "staleOpenInbounds": _scalar(
                db,
                """
                SELECT COUNT(*)
                FROM inbound_events i
                WHERE i.processing_status IN ('pending', 'processing', 'turn_done')
                  AND i.received_at < datetime(?, ?)
                  AND NOT EXISTS (
                    SELECT 1 FROM turn_terminal_records t WHERE t.inbound_seq = i.seq
                  )
                """,
                (now_text, modifier),
            ),
            "staleRecoveryJobs": _scalar(
                db,
                """
                SELECT COUNT(*)
                FROM turn_recovery_jobs j
                WHERE (
                    j.state = 'pending'
                    AND j.next_attempt_at < datetime(?, ?)
                  ) OR (
                    j.state = 'claimed'
                    AND j.claim_expires_at IS NOT NULL
                    AND j.claim_expires_at < ?
                  ) OR (
                    j.state IN ('blocked_unsafe', 'exhausted')
                    AND EXISTS (
                      SELECT 1
                      FROM inbound_events i
                      WHERE i.seq = j.source_inbound_seq
                        AND i.processing_status IN ('pending', 'processing', 'turn_done')
                        AND i.received_at < datetime(?, ?)
                    )
                  )
                """,
                (now_text, modifier, now_text, now_text, modifier),
            ),
            "unresolvedContinuityCandidates": _scalar(
                db,
                f"""
                {_UNRESOLVED_CONTINUITY_CANDIDATES_SQL}
                  AND NOT (i.message_id GLOB ?)
                """,
                (SYNTHETIC_SOURCE_MESSAGE_ID_GLOB,),
            ),
            # Diagnostic only: never part of debt_count or an alert latch.
            "syntheticContinuityCandidates": _scalar(
                db,
                f"""
                {_UNRESOLVED_CONTINUITY_CANDIDATES_SQL}
                  AND i.message_id GLOB ?
                """,
                (SYNTHETIC_SOURCE_MESSAGE_ID_GLOB,),
            ),
            "failedTerminalDebt": _scalar(
                db,
                """
                SELECT COUNT(DISTINCT i.seq)
                FROM inbound_events i
                JOIN turn_terminal_records t ON t.inbound_seq = i.seq
                WHERE i.processing_status = 'failed'
                  AND t.inbound_disposition = 'failed_terminal'
                  AND t.reply_guarantee_disarmed = 0
                  AND t.delivery_kind <> 'echoed'
                  AND COALESCE(t.attempt_failure_class, '') <> 'operator_cancelled'
                """,
                (),
            ),
            "failedTerminalWithEchoEvidence": _scalar(
                db,
                """
                SELECT COUNT(DISTINCT i.seq)
                FROM inbound_events i
                JOIN turn_terminal_records t ON t.inbound_seq = i.seq
                WHERE i.processing_status = 'failed'
                  AND t.inbound_disposition = 'failed_terminal'
                  AND t.reply_guarantee_disarmed = 0
                  AND t.delivery_kind <> 'echoed'
                  AND COALESCE(t.attempt_failure_class, '') <> 'operator_cancelled'
                  AND EXISTS (
                    SELECT 1
                    FROM outbound_ops o
                    WHERE o.source_inbound_seq = i.seq
                      AND o.status = 'echoed'
                  )
                """,
                (),
            ),
            "blockedOrExhaustedRecoveryJobs": _scalar(
                db,
                """
                SELECT COUNT(*)
                FROM turn_recovery_jobs
                WHERE state IN ('blocked_unsafe', 'exhausted')
                """,
                (),
            ),
        }
        active_count = counts["staleOpenInbounds"] + counts["staleRecoveryJobs"]
        debt_count = (
            counts["unresolvedContinuityCandidates"]
            + counts["failedTerminalDebt"]
            + counts["blockedOrExhaustedRecoveryJobs"]
        )
        if active_count > 0:
            state = "active-breach"
            health_impact = "operational"
            reason = "stale open inbound or recovery work exceeds the observation threshold"
            hints = ACTIVE_HINTS
        elif debt_count > 0:
            state = "recovery-debt"
            health_impact = "none"
            reason = "historical reply recovery obligations remain unresolved"
            hints = DEBT_HINTS
        else:
            state = "clear"
            health_impact = "none"
            reason = "no active breach or recovery debt observed"
            hints = []
        return {
            "instance": instance,
            "state": state,
            "healthImpact": health_impact,
            "reason": reason,
            "database": {
                "name": db_path.name,
                "walSidecarPresent": Path(f"{db_path}-wal").is_file(),
                "readMode": "sqlite-uri-mode-ro",
            },
            "thresholdSeconds": stale_seconds,
            "counts": counts,
            "resolutionHints": hints,
        }
    except sqlite3.Error as error:
        return _inconclusive(instance, db_path, f"read-only database query failed: {type(error).__name__}")
    finally:
        db.close()


def observe_instances(
    data_root: Path,
    *,
    instance: str | None,
    now: datetime,
    stale_seconds: int,
) -> dict[str, Any]:
    if not data_root.is_absolute() or data_root.is_symlink() or not data_root.is_dir():
        return {
            "check": "reply-guarantee-observer",
            "state": "inconclusive",
            "healthImpact": "unknown",
            "reason": "instance data root is missing, non-directory, or symlinked",
            "effectiveUser": os.environ.get("USER") or str(os.getuid()),
            "dataRootSuffix": ".local/share/whatsoup/instances",
            "instances": [],
            "resolutionHints": CONTEXT_HINTS,
        }

    if instance is not None and INSTANCE_NAME_RE.fullmatch(instance) is None:
        return {
            "check": "reply-guarantee-observer",
            "state": "inconclusive",
            "healthImpact": "unknown",
            "reason": "explicit instance name is invalid",
            "effectiveUser": os.environ.get("USER") or str(os.getuid()),
            "dataRootSuffix": ".local/share/whatsoup/instances",
            "instances": [],
            "resolutionHints": CONTEXT_HINTS,
        }

    if instance:
        instance_dir = data_root / instance
        if instance_dir.is_symlink():
            candidates = [(instance, instance_dir / "bot.db")]
            observations = [_inconclusive(instance, instance_dir / "bot.db", "instance directory is symlinked")]
        else:
            candidates = [(instance, instance_dir / "bot.db")]
            observations = []
    else:
        try:
            candidates = [
                (entry.name, entry / "bot.db")
                for entry in sorted(data_root.iterdir(), key=lambda path: path.name)
                if entry.is_dir() and not entry.is_symlink() and (entry / "bot.db").is_file()
            ]
        except OSError:
            return {
                "check": "reply-guarantee-observer",
                "state": "inconclusive",
                "healthImpact": "unknown",
                "reason": "instance data root could not be enumerated in the effective user context",
                "effectiveUser": os.environ.get("USER") or str(os.getuid()),
                "dataRootSuffix": ".local/share/whatsoup/instances",
                "instances": [],
                "resolutionHints": CONTEXT_HINTS,
            }
        observations = []
    if not candidates:
        return {
            "check": "reply-guarantee-observer",
            "state": "inconclusive",
            "healthImpact": "unknown",
            "reason": "no instance databases were discovered in the effective user context",
            "effectiveUser": os.environ.get("USER") or str(os.getuid()),
            "dataRootSuffix": ".local/share/whatsoup/instances",
            "instances": [],
            "resolutionHints": CONTEXT_HINTS,
        }

    if not observations:
        observations = [
            observe_database(path, instance=name, now=now, stale_seconds=stale_seconds)
            for name, path in candidates
        ]
        # R46: only after every instance's base observation, so the
        # diagnostics never delay a base read; observations follow candidates.
        _attach_progress_diagnostics(observations, candidates, now=now, stale_seconds=stale_seconds)
    state = max((item["state"] for item in observations), key=STATE_PRECEDENCE.__getitem__)
    return {
        "check": "reply-guarantee-observer",
        "state": state,
        "healthImpact": "operational" if state == "active-breach" else ("unknown" if state == "inconclusive" else "none"),
        "reason": "one or more instance observations require attention" if state != "clear" else "all observed instances are clear",
        "effectiveUser": os.environ.get("USER") or str(os.getuid()),
        "dataRootSuffix": ".local/share/whatsoup/instances",
        "instances": observations,
        "resolutionHints": (
            ACTIVE_HINTS if state == "active-breach"
            else [*CONTEXT_HINTS, *DEBT_HINTS] if state == "inconclusive"
            else DEBT_HINTS if state == "recovery-debt"
            else []
        ),
    }


def _state_target_and_observation():
    from lib.durable_json import durable_json_target, observe_json
    from lib.state_files import REPLY_GUARANTEE_OBSERVER_STATE
    from lib.state_root import state_root

    root = state_root()
    try:
        root.lstat()
    except FileNotFoundError:
        root.mkdir(parents=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("reply guarantee observer state root is not a trusted directory")
    root.chmod(0o700)
    target = durable_json_target(
        trusted_root=root.resolve(strict=True),
        relative_path=REPLY_GUARANTEE_OBSERVER_STATE,
    )
    return target, observe_json(target)


def _load_latches(payload: Any) -> dict[str, dict[str, Any]]:
    if payload is None:
        return {}
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        raise RuntimeError("reply guarantee observer state schema is invalid")
    instances = payload.get("instances")
    if not isinstance(instances, dict):
        raise RuntimeError("reply guarantee observer instance latch state is invalid")
    validated: dict[str, dict[str, Any]] = {}
    for instance, entry in instances.items():
        if not isinstance(instance, str) or not instance or not isinstance(entry, dict):
            raise RuntimeError("reply guarantee observer latch identity is invalid")
        if any(not isinstance(entry.get(key, False), bool) for key in SOURCE_LATCH_KEYS.values()):
            raise RuntimeError("reply guarantee observer latch value is invalid")
        last_state = entry.get("lastState")
        if last_state is not None and last_state not in STATE_PRECEDENCE:
            raise RuntimeError("reply guarantee observer prior state is invalid")
        validated[instance] = {
            "activeAlerted": bool(entry.get("activeAlerted", False)),
            "debtAlerted": bool(entry.get("debtAlerted", False)),
            "observerAlerted": bool(entry.get("observerAlerted", False)),
            "lastState": last_state,
        }
    return validated


def _save_latches(target, prior_observation, latches: dict[str, dict[str, Any]]) -> None:
    from lib.durable_json import operation_id, publish_state_json, require_advance

    payload = {"schemaVersion": 1, "instances": latches}
    generation = (prior_observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        payload,
        component="reply_guarantee_observer.state",
        predecessor=prior_observation.version,
    )
    publication = publish_state_json(
        target,
        payload,
        component="reply_guarantee_observer.state",
        operation_id=publication_operation,
        expected=prior_observation.version,
        generation=generation,
    )
    require_advance(publication)


def _desired_latches(observation: dict[str, Any], prior: dict[str, Any]) -> dict[str, bool]:
    state = str(observation["state"])
    if state == "inconclusive":
        return {
            "reply-guarantee-active-breach": bool(prior["activeAlerted"]),
            "reply-guarantee-recovery-debt": bool(prior["debtAlerted"]),
            "reply-guarantee-observer": True,
        }
    counts = observation.get("counts") or {}
    debt_open = sum(
        int(counts.get(key, 0))
        for key in (
            "unresolvedContinuityCandidates",
            "failedTerminalDebt",
            "blockedOrExhaustedRecoveryJobs",
        )
    ) > 0
    return {
        "reply-guarantee-active-breach": state == "active-breach",
        "reply-guarantee-recovery-debt": debt_open,
        "reply-guarantee-observer": False,
    }


def _invoke_emitter(
    helper: Path,
    repo_root: Path,
    *,
    instance: str,
    source: str,
    state: str,
    evidence: str,
    clear: bool,
) -> bool:
    command = [
        sys.executable,
        str(helper),
        "--instance",
        instance,
        "--source",
        source,
        "--summary",
        f"reply guarantee observer: {state}",
        "--evidence",
        evidence,
    ]
    if clear:
        command.append("--clear")
    else:
        command.extend(["--severity", SOURCE_SEVERITIES[source]])
    try:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            env={key: value for key, value in os.environ.items() if key != "PYTHONPATH"},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def _emit(repo_root: Path, result: dict[str, Any]) -> bool:
    helper = repo_root / "deploy" / "scripts" / "bot-errors-emit.py"
    observations = result.get("instances") or [
        {
            "instance": "reply-guarantee-fleet",
            "state": result["state"],
            "reason": result.get("reason"),
            "resolutionHints": result.get("resolutionHints", []),
        }
    ]
    try:
        target, prior_observation = _state_target_and_observation()
        latches = _load_latches(prior_observation.payload)
    except (ImportError, OSError, RuntimeError) as error:
        failure = {
            "instance": "reply-guarantee-fleet",
            "state": "inconclusive",
            "healthImpact": "unknown",
            "reason": f"observer transition state is unavailable: {type(error).__name__}",
            "resolutionHints": CONTEXT_HINTS,
        }
        _invoke_emitter(
            helper,
            repo_root,
            instance="reply-guarantee-fleet",
            source="reply-guarantee-observer",
            state="inconclusive",
            evidence=json.dumps(failure, sort_keys=True, separators=(",", ":")),
            clear=False,
        )
        return False
    success = True
    for observation in observations:
        state = str(observation["state"])
        instance = str(observation["instance"])
        prior = latches.get(instance, {
            "activeAlerted": False,
            "debtAlerted": False,
            "observerAlerted": False,
            "lastState": None,
        })
        desired = _desired_latches(observation, prior)
        evidence = json.dumps(observation, sort_keys=True, separators=(",", ":"))
        for source, desired_alerted in desired.items():
            latch_key = SOURCE_LATCH_KEYS[source]
            if bool(prior[latch_key]) == desired_alerted:
                continue
            clear = not desired_alerted
            accepted = _invoke_emitter(
                helper,
                repo_root,
                instance=instance,
                source=source,
                state=state,
                evidence=evidence,
                clear=clear,
            )
            if accepted:
                prior[latch_key] = desired_alerted
            success = accepted and success
        prior["lastState"] = state
        latches[instance] = prior
    try:
        _save_latches(target, prior_observation, latches)
    except (OSError, RuntimeError):
        return False
    return success


def _default_data_root() -> Path:
    whatsoup_data = os.environ.get("WHATSOUP_DATA_DIR", "").strip()
    if whatsoup_data:
        return Path(whatsoup_data).expanduser() / "instances"
    xdg_data = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg_data:
        return Path(xdg_data).expanduser() / "whatsoup" / "instances"
    return Path.home() / ".local" / "share" / "whatsoup" / "instances"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=_default_data_root())
    parser.add_argument("--instance")
    parser.add_argument("--stale-seconds", type=int, default=DEFAULT_STALE_SECONDS)
    parser.add_argument("--emit", action="store_true")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = observe_instances(
        args.data_root,
        instance=args.instance,
        now=datetime.now(timezone.utc),
        stale_seconds=args.stale_seconds,
    )
    emitted = not args.emit or _emit(args.repo_root, result)
    if args.json:
        print(json.dumps({**result, "emissionSucceeded": emitted}, sort_keys=True))
    else:
        print(f"reply-guarantee-observer state={result['state']} instances={len(result['instances'])}")
    if not emitted:
        return 2
    # An active breach is an observed workload condition.  It is already
    # preserved in the JSON artifact and routed through the existing alert
    # outbox; the observer completed successfully, so do not make systemd
    # classify the oneshot as a crashed process.
    if result["state"] == "inconclusive":
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
