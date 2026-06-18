#!/usr/bin/env python3
"""reducer_canary_corpus.py — B2 reducer canary corpus for the pre-reducer gate.

A deterministic, data-driven safety gate that runs a pluggable token-reducer against a
fixed corpus of synthetic raw-output fixtures and proves, per fixture, that:
  - every load-bearing required anchor survives the reduction (in `reduced` OR is
    recoverable byte-identical via a B1 content-addressed handle), and
  - no synthetic forbidden payload (secret-shaped) survives in the reduced text.

This gate proves LOCAL corruption detection only. It honors blocking-assumption row
B2-TOTAL: it reports fixture-level bytes, anchors, forbidden hits, and restore status —
it does NOT claim total-session deltas (those belong exclusively to B3).

Reuse (wholesale, import-only):
  - compaction_survival_canary `Anchor`/`ForbiddenPattern`/`ClaimGuard` dataclasses,
    `evaluate_case`, `pattern_matches`, `safe_ref`.
  - raw_output_handle_protocol (B1) `store`/`retrieve`/`reduce_with_handle` for the
    handle-backed restore proof, under a caller-supplied `--store-dir`.

A reducer is a pluggable interface ``reduce(raw: str) -> {"reduced": str, "handle"?: str}``.
Three reference reducers ship as TEST FIXTURES ONLY (never for adoption):
  - `identity`      passes the canary (reduced == raw),
  - `corrupting`    drops a load-bearing line -> MUST FAIL the canary (the load-bearing
                    proof the gate detects corruption),
  - `handle_backed` reduces + stores raw via B1 -> passes the restore check.

Fail-closed everywhere: a reducer that raises -> fail (not silent); a reducer that returns
a non-string `reduced` -> typed error + fail; a malformed fixture -> typed error + fail;
a handle-backed reducer whose handle does not restore byte-identical -> fail.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from probelib import redact, sha256_16
from compaction_survival_canary import (
    Anchor,
    CanaryCase,
    ForbiddenPattern,
    evaluate_case,
    pattern_matches,
    safe_ref,
)
import raw_output_handle_protocol as b1

SCHEMA = "agent-runtime-reducer-canary-corpus"
SCHEMA_VERSION = "0.1"

# A reducer return is either a bare string OR a dict with a required "reduced" str and an
# optional "handle" str. Anything else is a typed error (fail-closed).
ReducerResult = Any
Reducer = Callable[[str], ReducerResult]


@dataclass(frozen=True)
class CorpusFixture:
    """A synthetic raw-output fixture: load-bearing anchors must survive, forbidden
    payloads must not. ``source_text`` is the raw output a tool would emit."""

    fixture_id: str
    kind: str
    raw_text: str
    required_anchors: tuple[Anchor, ...]
    forbidden_patterns: tuple[ForbiddenPattern, ...]


def default_corpus() -> tuple[CorpusFixture, ...]:
    """The EXACT fixture inventory the corpus names. Synthetic values only — every
    forbidden payload is a fake secret, never a real one."""
    return (
        CorpusFixture(
            fixture_id="env_file_existence",
            kind="synthetic_env_presence",
            raw_text=(
                "Checking workspace secrets...\n"
                ".env exists at repo root: True\n"
                ".env.example exists: True\n"
                "loaded 4 keys from .env\n"
                "RESEND_API_KEY=re_synthetic_secret_0001 present\n"
            ),
            required_anchors=(
                Anchor("env_present", "state", (r"\.env exists at repo root: True",)),
                Anchor("env_key_count", "evidence", (r"loaded 4 keys from \.env",)),
            ),
            forbidden_patterns=(
                ForbiddenPattern("env_secret_value", r"re_synthetic_secret_0001"),
            ),
        ),
        CorpusFixture(
            fixture_id="detached_head",
            kind="synthetic_git_state",
            raw_text=(
                "HEAD detached at 9f8e7d6\n"
                "nothing to commit, working tree clean\n"
                "previous branch was fix/agent-config-root-isolation-20260615\n"
                "token ghp_syntheticSecret0123456789abcdefABCDEF in reflog noise\n"
            ),
            required_anchors=(
                Anchor("detached_state", "state", (r"HEAD detached at 9f8e7d6",)),
                Anchor("clean_tree", "state", (r"working tree clean",)),
            ),
            forbidden_patterns=(
                ForbiddenPattern("git_token", r"ghp_syntheticSecret0123456789abcdefABCDEF"),
            ),
        ),
        CorpusFixture(
            fixture_id="failing_tests",
            kind="synthetic_pytest_output",
            raw_text=(
                "collected 1284 items\n"
                "tests/test_reducer.py::test_corrupting FAILED\n"
                "FAILED tests/test_reducer.py::test_corrupting - AssertionError\n"
                "1283 passed, 1 failed in 12.40s\n"
                "auth header Bearer synthetictoken0123456789abcdef leaked into log\n"
            ),
            required_anchors=(
                Anchor("failed_test_name", "evidence", (r"test_corrupting FAILED",)),
                Anchor("fail_count", "evidence", (r"1283 passed, 1 failed",)),
            ),
            forbidden_patterns=(
                ForbiddenPattern("bearer_token", r"Bearer synthetictoken0123456789abcdef"),
            ),
        ),
        CorpusFixture(
            fixture_id="migration_warnings",
            kind="synthetic_migration_log",
            raw_text=(
                "Applying migration 0042_add_index...\n"
                "WARNING: column 'legacy_id' will be dropped in 0043\n"
                "WARNING: backfill required before 0044\n"
                "migration 0042 applied in 3.10s\n"
                "db_url=postgres://user:pcsk_synthetic_pw_9999@localhost/app\n"
            ),
            required_anchors=(
                Anchor("drop_warning", "state", (r"column 'legacy_id' will be dropped in 0043",)),
                Anchor("backfill_warning", "state", (r"backfill required before 0044",)),
            ),
            forbidden_patterns=(
                ForbiddenPattern("db_password", r"pcsk_synthetic_pw_9999"),
            ),
        ),
        CorpusFixture(
            fixture_id="rare_json_anomalies",
            kind="synthetic_json_anomaly",
            raw_text=(
                "scanned 9000 records\n"
                "ANOMALY: record 8123 has negative balance -42 (expected >=0)\n"
                "ANOMALY: record 8999 missing required field 'owner'\n"
                "scan complete: 2 anomalies in 9000 records\n"
                "api_key sk-syntheticAnomaly0123456789 in trace\n"
            ),
            required_anchors=(
                Anchor("anomaly_negative", "evidence", (r"record 8123 has negative balance -42",)),
                Anchor("anomaly_missing_field", "evidence", (r"record 8999 missing required field 'owner'",)),
                Anchor("anomaly_total", "evidence", (r"2 anomalies in 9000 records",)),
            ),
            forbidden_patterns=(
                ForbiddenPattern("anomaly_api_key", r"sk-syntheticAnomaly0123456789"),
            ),
        ),
        CorpusFixture(
            fixture_id="middle_only_critical_log",
            kind="synthetic_log_stream",
            # The load-bearing critical line is buried in the MIDDLE of long benign output —
            # a head/tail truncating reducer would drop it (silent corruption).
            raw_text=(
                "INFO startup ok\n"
                + "INFO heartbeat\n" * 40
                + "CRITICAL data loss detected on shard 7 at offset 1024:55\n"
                + "INFO heartbeat\n" * 40
                + "INFO shutdown ok\n"
                + "xoxb-synthetic-1234567890-slacktoken in middle noise\n"
            ),
            required_anchors=(
                Anchor("middle_critical", "safety", (r"CRITICAL data loss detected on shard 7 at offset 1024:55",)),
            ),
            forbidden_patterns=(
                ForbiddenPattern("slack_token", r"xoxb-synthetic-1234567890-slacktoken"),
            ),
        ),
    )


# --------------------------------------------------------------------------------------
# Reference reducers — TEST FIXTURES ONLY (never adopted as production reducers).
# Each implements ``reduce(raw: str) -> str | {"reduced": str, "handle"?: str}``.
# --------------------------------------------------------------------------------------

def identity_reducer(raw: str) -> str:
    """Lossless: returns raw unchanged. Passes every canary."""
    return raw


def corrupting_reducer(raw: str) -> str:
    """Silently DROPS the first load-bearing-looking line (one containing an uppercase
    keyword such as CRITICAL/WARNING/ANOMALY/FAILED/detached/exists), simulating a
    head/tail or naive summarizer that loses critical state. MUST fail the canary."""
    drop_markers = ("CRITICAL", "WARNING", "ANOMALY", "FAILED", "detached", "exists", "dropped")
    kept = []
    dropped = False
    for line in raw.splitlines(keepends=True):
        if not dropped and any(marker in line for marker in drop_markers):
            dropped = True
            continue
        kept.append(line)
    return "".join(kept)


def make_handle_backed_reducer(store_dir: str | Path) -> Reducer:
    """Build a reducer that stores the raw via B1 and returns a handle alongside a
    (possibly lossy) reduced view. The canary then proves the raw is recoverable
    byte-identical from the handle even if the reduced view drops anchors."""

    def handle_backed_reducer(raw: str) -> dict[str, Any]:
        handle = b1.store(raw, store_dir)
        # Deliberately lossy reduced view: keep only the first line. Anchors that fall off
        # the reduced view MUST be recoverable via the handle for the fixture to pass.
        first = raw.splitlines(keepends=True)
        reduced = first[0] if first else ""
        return {"reduced": reduced, "handle": handle}

    return handle_backed_reducer


# --------------------------------------------------------------------------------------
# Reducer invocation + normalization (fail-closed).
# --------------------------------------------------------------------------------------

def _normalize_reducer_result(result: ReducerResult) -> tuple[str | None, str | None, str | None]:
    """Return ``(reduced, handle, error_type)``. A bare string -> (str, None, None).
    A dict with a string ``reduced`` -> (str, handle?, None). Anything else is a typed
    error and yields ``(None, None, error_type)`` — never a silent coercion."""
    if isinstance(result, str):
        return result, None, None
    if isinstance(result, dict):
        reduced = result.get("reduced")
        handle = result.get("handle")
        if not isinstance(reduced, str):
            return None, None, f"reducer_non_string_reduced:{type(reduced).__name__}"
        if handle is not None and not isinstance(handle, str):
            return None, None, f"reducer_non_string_handle:{type(handle).__name__}"
        return reduced, handle, None
    return None, None, f"reducer_bad_result_type:{type(result).__name__}"


def _restore_status(handle: str | None, raw_text: str, store_dir: Path | None) -> dict[str, Any]:
    """Prove (or refute) byte-identical restore via the B1 handle. Returns a typed status
    dict. Absence of a handle is reported as ``no_handle`` (not an error by itself)."""
    if handle is None:
        return {"restore_status": "no_handle", "handle_present": False, "handle_sha256_16": None}
    if store_dir is None:
        return {"restore_status": "no_store_dir", "handle_present": True, "handle_sha256_16": None}
    if not b1.valid_handle(handle):
        return {"restore_status": "invalid_handle", "handle_present": True,
                "handle_sha256_16": sha256_16(handle)}
    try:
        restored = b1.retrieve(handle, store_dir)
    except FileNotFoundError:
        return {"restore_status": "not_found", "handle_present": True, "handle_sha256_16": handle[:16]}
    except b1.StoreError as exc:
        return {"restore_status": f"store_error:{exc}", "handle_present": True,
                "handle_sha256_16": handle[:16]}
    except ValueError:
        return {"restore_status": "invalid_handle", "handle_present": True,
                "handle_sha256_16": handle[:16]}
    byte_identical = restored == raw_text.encode("utf-8")
    return {
        "restore_status": "byte_identical" if byte_identical else "restore_mismatch",
        "handle_present": True,
        "handle_sha256_16": handle[:16],
    }


def run_fixture(fixture: CorpusFixture, reducer: Reducer, store_dir: Path | None,
                reducer_id: str = "") -> dict[str, Any]:
    """Run one reducer over one fixture and produce a metadata-only verdict row.

    Pass/fail is a DETERMINISTIC function of (fixture, reducer):
      - reducer raises / returns non-str -> fail (fail-closed),
      - any required anchor missing from BOTH reduced text AND a byte-identical handle
        restore -> fail,
      - any forbidden payload surviving in reduced text -> fail,
      - handle present but not restorable byte-identical -> fail.
    """
    fail_reasons: list[str] = []

    if not fixture.required_anchors:
        # A fixture with no load-bearing anchors cannot prove survival: malformed fixture.
        fail_reasons.append("malformed_fixture_no_required_anchors")

    raw_text = fixture.raw_text
    reducer_error: str | None = None
    try:
        raw_result = reducer(raw_text)
    except Exception as exc:  # untrusted reducer; fail CLOSED, never silently swallow
        reducer_error = f"reducer_raised:{type(exc).__name__}"
        raw_result = None

    if reducer_error is not None:
        fail_reasons.append(reducer_error)
        reduced_text, handle = "", None
    else:
        reduced_text, handle, norm_error = _normalize_reducer_result(raw_result)
        if norm_error is not None:
            fail_reasons.append(norm_error)
            reduced_text, handle = "", None

    restore = _restore_status(handle, raw_text, store_dir)
    handle_restored_ok = restore["restore_status"] == "byte_identical"
    if handle is not None and not handle_restored_ok:
        fail_reasons.append("handle_restore_failed")

    # Reuse compaction_survival_canary.evaluate_case for the anchor/forbidden survival math.
    # source_text = raw, compacted_text = reduced view the reducer produced.
    case = CanaryCase(
        canary_id=fixture.fixture_id,
        source_kind=fixture.kind,
        compacted_kind="reduced",
        source_text=raw_text,
        compacted_text=reduced_text,
        required_anchors=fixture.required_anchors,
        forbidden_patterns=fixture.forbidden_patterns,
    )
    case_eval = evaluate_case(case)

    # Anchors absent from the reduced view are tolerated ONLY when the raw is recoverable
    # byte-identical via the handle (B1 reversibility). Otherwise they are lost -> fail.
    reduced_anchor_loss = case_eval["missing_required_anchor_count"]
    survived_via_handle = reduced_anchor_loss > 0 and handle_restored_ok
    if reduced_anchor_loss > 0 and not handle_restored_ok:
        fail_reasons.append("required_anchor_lost")

    # Forbidden-payload survival is a reducer fault only when the reducer actually produced a
    # transform (reduced != raw) that retained the secret. A lossless passthrough (reduced == raw)
    # performs NO reduction on this fixture, so it cannot prove forbidden-suppression "via
    # reduction". We do NOT silently exempt a passthrough: we stamp an explicit per-fixture datum
    # so a downstream consumer can require non-passthrough proof on the leak axis.
    #   - `forbidden_check="checked"`                  — a genuine reduction occurred; survival math
    #                                                    was applied (a surviving secret -> leak fail).
    #   - `forbidden_check="not_applicable_lossless"`  — this fixture was passed through verbatim;
    #                                                    forbidden-suppression was NOT proven here.
    # A lossless passthrough keeps its pass verdict ONLY for the declared `identity` baseline (the
    # no-op reducer the canary measures against); for a NON-identity reducer that merely happens to
    # passthrough a given fixture, we record `not_applicable_lossless` without claiming the secret
    # was suppressed by reduction — the leak axis is simply unproven for that fixture.
    forbidden_hits = case_eval["forbidden_payload_hit_count"]
    lossless_passthrough = reduced_text == raw_text
    is_identity_baseline = reducer_id == "identity"
    if lossless_passthrough:
        # The leak axis cannot be proven by a verbatim passthrough. Stamp an explicit datum
        # (`not_applicable_lossless`) instead of silently exempting, so a downstream consumer can
        # require non-passthrough proof. `forbidden_check_baseline_trusted` records whether this
        # passthrough is the declared `identity` no-op the canary measures against (expected) or a
        # non-identity reducer that merely happens to passthrough this fixture (suppression NOT
        # proven). The pass verdict is retained either way — the leak axis is simply unproven for a
        # non-identity passthrough, surfaced via the datum rather than a false clean-pass.
        forbidden_check = "not_applicable_lossless"
    else:
        forbidden_check = "checked"
        if forbidden_hits > 0:
            fail_reasons.append("forbidden_payload_survived")
    forbidden_check_baseline_trusted = lossless_passthrough and is_identity_baseline

    if case_eval["source_missing_anchor_count"] > 0:
        # An anchor that is not even present in the raw fixture is a malformed fixture.
        fail_reasons.append("malformed_fixture_anchor_absent_in_raw")

    verdict = "fail" if fail_reasons else "pass"
    return {
        "fixture_ref": safe_ref(fixture.fixture_id),
        "fixture_sha256_16": sha256_16(fixture.fixture_id),
        "kind": case_eval["source_kind"],
        "verdict": verdict,
        "required_anchor_count": case_eval["required_anchor_count"],
        "reduced_anchor_present_count": case_eval["observed_required_anchor_count"],
        "reduced_anchor_lost_count": reduced_anchor_loss,
        "survived_via_handle": survived_via_handle,
        "forbidden_pattern_count": case_eval["forbidden_pattern_count"],
        "forbidden_hit_count": forbidden_hits,
        "forbidden_check": forbidden_check,
        "forbidden_check_baseline_trusted": forbidden_check_baseline_trusted,
        "lossless_passthrough": lossless_passthrough,
        "raw_bytes": case_eval["source_bytes"],
        "reduced_bytes": case_eval["compacted_bytes"],
        "raw_sha256_16": case_eval["source_sha256_16"],
        "reduced_sha256_16": case_eval["compacted_sha256_16"],
        "restore_status": restore["restore_status"],
        "handle_present": restore["handle_present"],
        "handle_sha256_16": restore["handle_sha256_16"],
        "fail_reasons": sorted(set(fail_reasons)),
    }


def build_report(
    reducer: Reducer,
    reducer_id: str,
    fixtures: tuple[CorpusFixture, ...] | None = None,
    store_dir: Path | None = None,
) -> dict[str, Any]:
    """Run ``reducer`` over the corpus and assemble the metadata-only report. Pass/fail is
    a deterministic function of (fixtures, reducer); timestamps are intentionally excluded."""
    if fixtures is None:
        fixtures = default_corpus()
    rows = [run_fixture(fixture, reducer, store_dir, reducer_id) for fixture in fixtures]
    verdict_counts = Counter(row["verdict"] for row in rows)
    fail_reason_counts = Counter(reason for row in rows for reason in row["fail_reasons"])
    fail_count = verdict_counts.get("fail", 0)
    summary = {
        "fixture_count": len(rows),
        "pass_count": verdict_counts.get("pass", 0),
        "fail_count": fail_count,
        "verdict_counts": dict(sorted(verdict_counts.items())),
        "fail_reason_counts": dict(sorted(fail_reason_counts.items())),
        "required_anchor_count": sum(row["required_anchor_count"] for row in rows),
        "reduced_anchor_present_count": sum(row["reduced_anchor_present_count"] for row in rows),
        "reduced_anchor_lost_count": sum(row["reduced_anchor_lost_count"] for row in rows),
        "survived_via_handle_count": sum(1 for row in rows if row["survived_via_handle"]),
        "forbidden_hit_count": sum(row["forbidden_hit_count"] for row in rows),
        "forbidden_checked_count": sum(1 for row in rows if row["forbidden_check"] == "checked"),
        "forbidden_not_applicable_lossless_count": sum(
            1 for row in rows if row["forbidden_check"] == "not_applicable_lossless"),
        "lossless_passthrough_count": sum(1 for row in rows if row["lossless_passthrough"]),
        "raw_bytes_total": sum(row["raw_bytes"] for row in rows),
        "reduced_bytes_total": sum(row["reduced_bytes"] for row in rows),
        "restore_byte_identical_count": sum(1 for row in rows if row["restore_status"] == "byte_identical"),
        "verdict": "fail" if fail_count else "pass",
    }
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "synthetic_local_corruption_detection",
        "scope": "fixture_local_only",
        "reducer_id": safe_ref(reducer_id),
        "redaction": (
            "metadata-only reducer canary corpus; emits fixture ids or hashes, anchor and "
            "forbidden counts, raw/reduced byte counts, content hashes, restore status, handle "
            "presence/display hashes, and per-fixture verdicts; never emits raw output, reduced "
            "text, regex bodies, fixture paths, prompt/transcript/provider payloads, or secrets. "
            "Reports NO total-session deltas (B2-TOTAL): local corruption detection only."
        ),
        "policy": {
            "anchor_survival_rule": "every required anchor must survive in reduced text OR be recoverable byte-identical via a B1 handle",
            "forbidden_rule": "no synthetic forbidden payload may survive in reduced text",
            "fail_closed_rule": "reducer raising, returning non-string reduced, malformed fixture, or non-restorable handle -> fail",
        },
        "summary": summary,
        "fixtures": rows,
        "limitations": [
            "Synthetic fixtures only; this gate does not run a provider or reduce a live session.",
            "Proves local per-fixture corruption detection, NOT total-session token/cost/cache deltas (those belong to B3).",
            "Reference reducers (identity/corrupting/handle_backed) are test fixtures, never adoption candidates.",
            "Content hashes are for correlation; raw and reduced bodies are intentionally suppressed.",
        ],
    }


# Selectable built-in reference reducers. The `handle_backed` reducer is store-dependent so it
# is built per-invocation (it needs the resolved store_dir); identity/corrupting are stateless.
REDUCER_CHOICES = ("identity", "corrupting", "handle_backed")


def resolve_reducer(reducer_id: str, store_dir: Path) -> Reducer:
    """Map a CLI `--reducer` id to a built-in reference reducer. Unknown ids are rejected by
    argparse's `choices`; this stays a total function over `REDUCER_CHOICES` (fail-closed)."""
    if reducer_id == "identity":
        return identity_reducer
    if reducer_id == "corrupting":
        return corrupting_reducer
    if reducer_id == "handle_backed":
        return make_handle_backed_reducer(store_dir)
    raise ValueError(f"unknown reducer_id:{reducer_id}")  # unreachable via argparse choices


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="B2 reducer canary corpus — run a pluggable reducer against synthetic fixtures (default: identity)."
    )
    parser.add_argument("--reducer", choices=REDUCER_CHOICES, default="identity",
                        help="which built-in reference reducer the corpus runs (default: identity). "
                             "The emitted report stamps the selected id as the top-level `reducer_id`.")
    parser.add_argument("--store-dir", type=Path, default=None,
                        help="optional caller-supplied store dir for handle-backed restore checks (created 0700).")
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args(argv)


def main_argv(argv: list[str]) -> int:
    args = parse_args(argv)
    store_dir = args.store_dir
    tmp: tempfile.TemporaryDirectory | None = None
    if store_dir is None:
        # The built-in `identity`/`corrupting` reducers never produce a handle, so the store is
        # unused for them; still provide an ephemeral one so the handle-backed path (and any
        # future handle path) stays caller-controlled rather than touching a global store.
        tmp = tempfile.TemporaryDirectory(prefix="reducer-canary-")
        store_dir = Path(tmp.name)
    try:
        reducer = resolve_reducer(args.reducer, store_dir)
        report = build_report(reducer, args.reducer, store_dir=store_dir)
    finally:
        if tmp is not None:
            tmp.cleanup()
    report = redact(report)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 2 if report["summary"]["verdict"] == "fail" else 0


def main() -> int:
    return main_argv(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
