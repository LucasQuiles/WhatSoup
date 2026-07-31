#!/usr/bin/env python3
"""Fail-closed retirement for a reviewed outbound quarantine.

This tool never replays an operation and never clears an alert source. A
runtime recovery proof remains the only authority that can clear a delivery
incident. The command's only mutation is a reviewed quarantine -> terminal
non-replay transition, while preserving the versioned failure evidence exactly.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any


MAX_EVIDENCE_BYTES = 2_048
MAX_SAFE_INTEGER = 9_007_199_254_740_991
V1_KEYS = {
    "schema",
    "failure_code",
    "stage",
    "mutation_state",
    "retryable",
    "retry_decision",
    "retry_not_before",
    "retry_owner",
    "attempt_budget_disposition",
    "logical_attempt_count",
    "provider_submission_count",
    "first_failure_at",
    "last_failure_at",
    "evidence_coverage",
}
REQUIRED_COLUMNS = {
    "id",
    "status",
    "error",
    "is_terminal",
    "quarantine_disposition",
    "quarantine_evidence_coverage",
    "quarantine_evidence_sha256",
    "quarantined_at",
}
REQUIRED_TABLES = {"outbound_ops", "outbound_quarantine_retirements"}
KNOWN_DISPOSITIONS = {
    "delivery_ambiguous_unsafe",
    "delivery_not_attempted",
    "record_unreconstructable",
    "stale_status_discarded",
    "legacy_unclassified",
}
KNOWN_FAILURE_CODES = {
    "transport.unsupported_capability",
    "transport.payload_too_large",
    "transport.conversation_not_found",
    "transport.auth_required",
    "transport.rate_limited",
    "transport.transient_provider",
    "transport.permanent_provider",
    "transport.send_ambiguous",
    "outbound.unknown_failure",
    "outbound.shutdown_before_send",
    "outbound.shutdown_deadline",
    "outbound.crash_in_flight",
    "outbound.echo_timeout",
    "outbound.superseded",
    "outbound.pending_replay_unreconstructable",
    "outbound.status_ping_expired",
    "outbound.unsafe_delivery_unconfirmed",
    "outbound.governor_shed",
    "outbound.identity_blocked",
    "outbound.replay_failed",
    "outbound.deferral_limit_exceeded",
}
RETIRABLE_POLICIES = {
    "delivery_ambiguous_unsafe": {
        "acknowledgement": "delivery-risk-reviewed",
        "failure_code": "outbound.unsafe_delivery_unconfirmed",
        "mutation_state": "ambiguous",
        "provider_submissions": "possible",
    },
    "delivery_not_attempted": {
        "acknowledgement": "none",
        "failure_code": "outbound.deferral_limit_exceeded",
        "mutation_state": "not_started",
        "provider_submissions": "zero",
    },
    "record_unreconstructable": {
        "acknowledgement": "record-reconstruction-reviewed",
        "failure_code": "outbound.pending_replay_unreconstructable",
        "mutation_state": "not_started",
        "provider_submissions": "zero",
    },
    "stale_status_discarded": {
        "acknowledgement": "none",
        "failure_code": "outbound.status_ping_expired",
        "mutation_state": "not_started",
        "provider_submissions": "zero",
    },
}
ISO_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class RetirementError(RuntimeError):
    """A stable, non-sensitive machine error kind."""


class SafeArgumentParser(argparse.ArgumentParser):
    """Reject invalid arguments without echoing their potentially sensitive values."""

    def error(self, _message: str) -> None:
        raise RetirementError("invalid_arguments")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def db_connect(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path)


def read_only_db_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro"


def validate_db(path: Path) -> None:
    if not path.exists() or not path.is_file():
        raise RetirementError("db_invalid")
    try:
        with sqlite3.connect(read_only_db_uri(path), uri=True) as con:
            tables = {
                row[0]
                for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
            }
            columns = {row[1] for row in con.execute("PRAGMA table_info(outbound_ops)").fetchall()}
    except RetirementError:
        raise
    except sqlite3.Error as exc:
        raise RetirementError("db_invalid") from exc
    if not REQUIRED_TABLES.issubset(tables) or not REQUIRED_COLUMNS.issubset(columns):
        raise RetirementError("db_schema_unsupported")


def backup_db(path: Path) -> None:
    target = path.with_name(f"{path.name}.pre-outbound-quarantine-retire-{stamp()}")
    suffix = 0
    while target.exists():
        suffix += 1
        target = path.with_name(f"{path.name}.pre-outbound-quarantine-retire-{stamp()}.{suffix}")
    created = False
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        created = True
        target.chmod(0o600)
        if target.stat().st_mode & 0o777 != 0o600:
            raise OSError("backup_mode_insecure")
        with sqlite3.connect(read_only_db_uri(path), uri=True) as source:
            with sqlite3.connect(target) as dest:
                source.backup(dest)
        if target.stat().st_mode & 0o777 != 0o600:
            raise OSError("backup_mode_insecure")
    except (OSError, sqlite3.Error) as exc:
        if created:
            try:
                target.unlink()
            except OSError:
                pass
        raise RetirementError("backup_failed") from exc


def fetch_op(con: sqlite3.Connection, op_id: int) -> dict[str, Any] | None:
    con.row_factory = sqlite3.Row
    row = con.execute(
        """
        SELECT id, status, error, is_terminal, quarantine_disposition,
               quarantine_evidence_coverage, quarantine_evidence_sha256
          FROM outbound_ops
         WHERE id = ?
        """,
        (op_id,),
    ).fetchone()
    return dict(row) if row else None


def quarantine_count(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT COUNT(*) FROM outbound_ops WHERE status = 'quarantined'").fetchone()
    return int(row[0] if row else 0)


def disposition_count(con: sqlite3.Connection, disposition: str) -> int:
    row = con.execute(
        """SELECT COUNT(*) FROM outbound_ops
             WHERE status = 'quarantined'
               AND CASE quarantine_disposition
                 WHEN 'delivery_ambiguous_unsafe' THEN 'delivery_ambiguous_unsafe'
                 WHEN 'delivery_not_attempted' THEN 'delivery_not_attempted'
                 WHEN 'record_unreconstructable' THEN 'record_unreconstructable'
                 WHEN 'stale_status_discarded' THEN 'stale_status_discarded'
                 ELSE 'legacy_unclassified'
               END = ?""",
        (disposition,),
    ).fetchone()
    return int(row[0] if row else 0)


def is_safe_nonnegative_integer(value: object) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def is_known_string(value: object, allowed: set[str]) -> bool:
    return isinstance(value, str) and value in allowed


def is_iso_timestamp(value: object) -> bool:
    if not isinstance(value, str) or not ISO_TIMESTAMP_RE.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return False
    return True


def decode_v1(stored: object) -> dict[str, Any] | None:
    if not isinstance(stored, str) or len(stored.encode("utf-8")) > MAX_EVIDENCE_BYTES:
        return None
    try:
        value = json.loads(stored)
    except (TypeError, ValueError):
        return None
    if not isinstance(value, dict) or set(value) != V1_KEYS:
        return None
    if value["schema"] != "whatsoup-outbound-failure-v1":
        return None
    if not is_known_string(
        value["stage"],
        {"admission", "provider_request", "provider_response", "acknowledgement", "runtime"},
    ):
        return None
    if not is_known_string(
        value["mutation_state"],
        {"not_started", "rejected", "ambiguous", "submitted"},
    ):
        return None
    if value["retry_decision"] != "stop" or value["retry_not_before"] is not None:
        return None
    if value["retry_owner"] != "none" or value["attempt_budget_disposition"] != "stop":
        return None
    if not is_known_string(value["evidence_coverage"], {"complete", "partial"}):
        return None
    if type(value["retryable"]) is not bool:
        return None
    if not is_safe_nonnegative_integer(value["logical_attempt_count"]):
        return None
    if not is_safe_nonnegative_integer(value["provider_submission_count"]):
        return None
    if value["provider_submission_count"] > value["logical_attempt_count"]:
        return None
    if not is_iso_timestamp(value["first_failure_at"]) or not is_iso_timestamp(value["last_failure_at"]):
        return None
    if value["first_failure_at"] > value["last_failure_at"]:
        return None
    if not is_known_string(value["failure_code"], KNOWN_FAILURE_CODES):
        return None
    return value


def normalized_disposition(value: object) -> str:
    return value if is_known_string(value, KNOWN_DISPOSITIONS) else "legacy_unclassified"


def evidence_disposition(evidence: dict[str, Any]) -> str | None:
    if (
        evidence["failure_code"] == "outbound.unsafe_delivery_unconfirmed"
        and evidence["mutation_state"] == "ambiguous"
    ):
        return "delivery_ambiguous_unsafe"
    if evidence["mutation_state"] == "not_started" and evidence["provider_submission_count"] == 0:
        if evidence["failure_code"] == "outbound.deferral_limit_exceeded":
            return "delivery_not_attempted"
        if evidence["failure_code"] == "outbound.pending_replay_unreconstructable":
            return "record_unreconstructable"
        if evidence["failure_code"] == "outbound.status_ping_expired":
            return "stale_status_discarded"
    return None


def eligible_disposition(op: dict[str, Any]) -> str | None:
    if op.get("status") != "quarantined":
        return None
    evidence = decode_v1(op.get("error"))
    if evidence is None:
        return None
    disposition = evidence_disposition(evidence)
    if disposition not in RETIRABLE_POLICIES:
        return None
    policy = RETIRABLE_POLICIES[disposition]
    if normalized_disposition(op.get("quarantine_disposition")) != disposition:
        return None
    if evidence["failure_code"] != policy["failure_code"]:
        return None
    if evidence["mutation_state"] != policy["mutation_state"]:
        return None
    if policy["provider_submissions"] == "zero" and evidence["provider_submission_count"] != 0:
        return None
    return disposition


def evidence_digest(op: dict[str, Any]) -> str | None:
    stored = op.get("error")
    if decode_v1(stored) is None or not isinstance(stored, str):
        return None
    return sha256(stored.encode("utf-8")).hexdigest()


def inspect_payload(con: sqlite3.Connection, op: dict[str, Any]) -> dict[str, Any]:
    disposition = normalized_disposition(op.get("quarantine_disposition"))
    eligible = eligible_disposition(op)
    digest = evidence_digest(op)
    payload_op: dict[str, Any] = {
        "id": int(op["id"]),
        "status": "quarantined" if op.get("status") == "quarantined" else "not_quarantined",
        "disposition": disposition,
        "evidenceDigestAvailable": digest is not None,
        "eligibility": "retirable" if eligible is not None else "not_retirable",
        "contributors": {
            "total": quarantine_count(con),
            "sameDisposition": disposition_count(con, disposition),
        },
    }
    if digest is not None:
        payload_op["evidenceSha256"] = digest
    return {
        "schemaVersion": 1,
        "action": "inspect",
        "op": payload_op,
        "clear": {"candidate": False, "requiresRecoveryProof": True},
    }


def require_apply_preconditions(args: argparse.Namespace, op: dict[str, Any]) -> str:
    if args.confirm_op_id != args.op_id:
        raise RetirementError("retirement_precondition_failed")
    if not isinstance(args.expected_disposition, str) or args.expected_disposition not in RETIRABLE_POLICIES:
        raise RetirementError("retirement_precondition_failed")
    policy = RETIRABLE_POLICIES[args.expected_disposition]
    if args.acknowledgement != policy["acknowledgement"]:
        raise RetirementError("retirement_precondition_failed")
    if not isinstance(args.expect_evidence_sha256, str) or not SHA256_RE.fullmatch(args.expect_evidence_sha256):
        raise RetirementError("retirement_precondition_failed")
    eligible = eligible_disposition(op)
    if eligible is None:
        raise RetirementError("retirement_not_eligible")
    digest = evidence_digest(op)
    if digest is None:
        raise RetirementError("retirement_not_eligible")
    canonical_digest = op.get("quarantine_evidence_sha256")
    if canonical_digest is not None and (
        not isinstance(canonical_digest, str) or canonical_digest != digest
    ):
        raise RetirementError("retirement_precondition_failed")
    if eligible != args.expected_disposition or digest != args.expect_evidence_sha256:
        raise RetirementError("retirement_precondition_failed")
    return eligible


def retire(args: argparse.Namespace) -> dict[str, Any]:
    db_path = Path(args.db).expanduser()
    validate_db(db_path)
    try:
        with db_connect(db_path) as con:
            op = fetch_op(con, args.op_id)
            if op is None:
                raise RetirementError("op_not_found")
            if not args.apply:
                return inspect_payload(con, op)
            disposition = require_apply_preconditions(args, op)
    except RetirementError:
        raise
    except sqlite3.Error as exc:
        raise RetirementError("db_read_failed") from exc

    backup_db(db_path)
    try:
        with db_connect(db_path) as con:
            con.execute("BEGIN IMMEDIATE")
            try:
                op = fetch_op(con, args.op_id)
                if op is None:
                    raise RetirementError("op_not_found")
                disposition = require_apply_preconditions(args, op)
                digest = evidence_digest(op)
                if digest is None:
                    raise RetirementError("retirement_not_eligible")
                updated = con.execute(
                    """
                    UPDATE outbound_ops
                       SET status = 'failed_permanent',
                           is_terminal = 1,
                           quarantine_evidence_sha256 = ?
                     WHERE id = ?
                       AND status = 'quarantined'
                       AND (
                         quarantine_evidence_sha256 IS NULL
                         OR quarantine_evidence_sha256 = ?
                       )
                    """,
                    (digest, args.op_id, digest),
                )
                if updated.rowcount != 1:
                    raise RetirementError("retirement_precondition_failed")
                con.execute(
                    """
                    INSERT INTO outbound_quarantine_retirements (
                      outbound_op_id, quarantine_disposition, acknowledgement, evidence_sha256
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (args.op_id, disposition, args.acknowledgement, digest),
                )
                remaining = quarantine_count(con)
                con.commit()
            except Exception:
                con.rollback()
                raise
    except RetirementError:
        raise
    except sqlite3.Error as exc:
        raise RetirementError("db_write_failed") from exc

    return {
        "schemaVersion": 1,
        "action": "retired",
        "op": {
            "id": args.op_id,
            "disposition": disposition,
            "remainingQuarantined": remaining,
        },
        "backupCreated": True,
        "retirementRecorded": True,
        "clear": {"candidate": False, "requiresRecoveryProof": True},
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = SafeArgumentParser(
        description="Inspect or retire one reviewed outbound quarantine without replay or alert clear",
    )
    parser.add_argument("--db", required=True)
    parser.add_argument("--op-id", type=int, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-op-id", type=int)
    parser.add_argument("--expected-disposition", choices=sorted(RETIRABLE_POLICIES))
    parser.add_argument("--acknowledgement")
    parser.add_argument("--expect-evidence-sha256")
    parser.add_argument("--dry-run", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.apply and args.dry_run:
        parser.error("--apply and --dry-run cannot be combined")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv or sys.argv[1:])
        result = retire(args)
    except RetirementError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1
    except Exception:  # noqa: BLE001 - command output must not expose database contents.
        print(json.dumps({"ok": False, "error": "internal_error"}, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
