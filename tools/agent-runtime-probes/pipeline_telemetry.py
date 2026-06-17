#!/usr/bin/env python3
"""pipeline_telemetry.py — the per-mutation observability/telemetry layer for CAPE.

This is the instrumentation backbone for the CAPE pipeline. EVERY pipeline
transformation (sanitize/mask, injection-fence, enrich-inject, compress/reduce,
rehydrate, …) emits a METADATA-ONLY telemetry record capturing:

  - tokens-in → tokens-out, labeled by proof class (provider-truth `measured`,
    chars//4 `heuristic`, or `unknown` — NEVER a fabricated 0),
  - what changed (mutation_class + a VALIDATED metadata-only summary; NEVER raw
    before/after content),
  - the step's CLAIM and whether that claim is backed by evidence,
  - the reversibility handle.

`summarize()` then aggregates a pipeline OBSERVABILITY REPORT an operator reads to
understand exactly what the pipeline did: total tokens in/out, per-plane deltas,
which claims are UNBACKED (the load-bearing audit signal), reversibility coverage,
and what fraction of token figures are heuristic rather than provider-truth.

Load-bearing rules (do not relax):
  1. PROVIDER-TRUTH FIRST (token_account): if a usage dict carrying `input_tokens`
     is supplied, use it -> proof_class="measured". Else fall back to chars//4 of the
     text -> proof_class="heuristic" (LABELED — never presented as measured). If
     neither is available -> "unknown", NEVER 0. A fabricated 0 is a silent lie about
     a transformation that may have changed token count.
  2. METADATA-ONLY (record_mutation): NEVER emit before/after raw text in any field.
     Only `*_sha256_16` hashes + byte/token counts + the validated summary. The record
     is routed through `probelib.redact` as defense-in-depth.
  3. mutation_summary VALIDATION: the caller-supplied summary must be metadata-only.
     Any value that looks like raw content (a string longer than ~120 chars, or one
     that contains a newline, an absolute path shape, or a known secret shape) REJECTS
     the record with a typed RawContentInSummaryError — the telemetry layer must never
     become a raw-content leak.
  4. claim_backed is the audit field: a step that asserts a CLAIM but supplies no
     (non-empty) evidence_ref is `claim_backed=False` and is listed in `unbacked_claims`
     by summarize() — so an operator sees exactly which mutations are unproven.

CLI: python3 pipeline_telemetry.py --records <records.jsonl> [--pretty]
     reads one telemetry record per line, emits summarize() to stdout.
Output: metadata-only JSON to stdout.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from probelib import redact, sha256_16

SCHEMA = "agent-runtime-cape-pipeline-telemetry"
SCHEMA_VERSION = "0.1"

# The four CAPE planes a mutation can belong to. An out-of-vocabulary plane folds to
# "unknown" rather than silently widening the taxonomy.
VALID_PLANES = ("substrate", "reducer", "enricher", "governance")
_UNKNOWN_PLANE = "unknown"

# Proof-class labels for a token figure. "measured" is provider-truth; "heuristic" is
# the chars//4 estimate (LABELED, never presented as measured); "unknown" is the honest
# absence marker (NEVER collapsed to 0).
PROOF_MEASURED = "measured"
PROOF_HEURISTIC = "heuristic"
PROOF_UNKNOWN = "unknown"

# A mutation_summary VALUE longer than this is treated as raw content, not metadata.
_MAX_SUMMARY_STR_LEN = 120

# Raw-content shapes that must never appear in a metadata-only summary value.
_RAW_CONTENT_NEWLINE = re.compile(r"[\r\n]")
# An absolute-path shape (POSIX `/a/b` or Windows `C:\a`). A bare token like "reducer"
# is fine; "/Users/testuser/secret" is not.
_RAW_CONTENT_PATH = re.compile(r"(?:^|\s)(?:/[^/\s]+){2,}|[A-Za-z]:\\[^\\\s]")
# Known secret shapes (subset of probelib's SECRET_VALUE — the summary is operator-typed
# metadata, so any secret-looking value is a leak regardless of length).
_RAW_CONTENT_SECRET = re.compile(
    r"sk-[A-Za-z0-9]{8,}"
    r"|pcsk_[A-Za-z0-9_]{8,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|AKIA[0-9A-Z]{12,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|AIza[0-9A-Za-z_\-]{30,}"
    r"|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    r"|\b[Bb]earer\s+[A-Za-z0-9._\-]{12,}"
)


class RawContentInSummaryError(ValueError):
    """Raised when a mutation_summary value looks like raw content, not metadata.

    The telemetry layer is metadata-only; admitting a long string, a newline-bearing
    blob, a filesystem path, or a secret shape into the summary would turn the audit
    record itself into a content-leak channel. Fail closed instead.
    """


def _heuristic_tokens(text: str | None) -> int | None:
    """chars//4 token estimate for `text`. Returns None when text is absent.

    This is the LABELED heuristic — the caller must record proof_class="heuristic"
    so it is never mistaken for a provider-truth count.
    """
    if text is None:
        return None
    return len(text) // 4


def _usage_input_tokens(usage: dict | None) -> int | None:
    """Pull provider-truth `input_tokens` from a usage dict. None if absent/unusable.

    Mirrors usage_truth_probe semantics: a present-but-non-int value is treated as
    absent (None), never coerced into a misleading number.
    """
    if not isinstance(usage, dict):
        return None
    val = usage.get("input_tokens")
    if val is None:
        return None
    try:
        coerced = int(val)
    except (TypeError, ValueError):
        # A present-but-non-int input_tokens is unusable provider-truth: mark it absent
        # (a typed `coerced = None` signal, never a coerced/fabricated count) so a later
        # heuristic/unknown classification kicks in rather than a silent fail-open.
        coerced = None
    return coerced


def token_account(
    *,
    usage_before: dict | None,
    usage_after: dict | None,
    before_text: str | None,
    after_text: str | None,
) -> dict:
    """Account tokens-in -> tokens-out with an honest proof class.

    PROVIDER-TRUTH FIRST: if BOTH usage_before and usage_after carry an `input_tokens`
    field, use them and label proof_class="measured". Otherwise, if text is available,
    fall back to chars//4 and label proof_class="heuristic" (NEVER "measured"). If a
    side has neither usage nor text, that side is "unknown" (NEVER 0), and the overall
    proof_class degrades to "unknown".

    Returns {tokens_before, tokens_after, token_delta, proof_class}. token_delta is an
    int only when BOTH sides are numeric; otherwise it is "unknown".
    """
    measured_before = _usage_input_tokens(usage_before)
    measured_after = _usage_input_tokens(usage_after)

    if measured_before is not None and measured_after is not None:
        # Provider-truth on both sides -> measured.
        return {
            "tokens_before": measured_before,
            "tokens_after": measured_after,
            "token_delta": measured_after - measured_before,
            "proof_class": PROOF_MEASURED,
        }

    # No full provider-truth pair. Try the labeled heuristic per side, preferring any
    # provider-truth side we do have over its heuristic estimate.
    heur_before = _heuristic_tokens(before_text)
    heur_after = _heuristic_tokens(after_text)
    tokens_before = measured_before if measured_before is not None else heur_before
    tokens_after = measured_after if measured_after is not None else heur_after

    if tokens_before is None or tokens_after is None:
        # At least one side has neither usage nor text -> honest unknown, never 0.
        return {
            "tokens_before": tokens_before if tokens_before is not None else PROOF_UNKNOWN,
            "tokens_after": tokens_after if tokens_after is not None else PROOF_UNKNOWN,
            "token_delta": PROOF_UNKNOWN,
            "proof_class": PROOF_UNKNOWN,
        }

    # Both sides numeric but at least one came from the heuristic -> labeled heuristic.
    return {
        "tokens_before": tokens_before,
        "tokens_after": tokens_after,
        "token_delta": tokens_after - tokens_before,
        "proof_class": PROOF_HEURISTIC,
    }


def _validate_summary_value(value: object, path: str) -> None:
    """Reject a mutation_summary value that looks like raw content (rule 3).

    Recurses through dict/list containers. A scalar string is rejected if it is too
    long, carries a newline, matches an absolute-path shape, or matches a secret shape.
    `path` is a dotted key trail used only for the typed error message (no value leaks).
    """
    if isinstance(value, str):
        if len(value) > _MAX_SUMMARY_STR_LEN:
            raise RawContentInSummaryError(
                f"summary value too long at '{path}' "
                f"({len(value)} > {_MAX_SUMMARY_STR_LEN} chars): looks like raw content"
            )
        if _RAW_CONTENT_NEWLINE.search(value):
            raise RawContentInSummaryError(
                f"summary value at '{path}' contains a newline: looks like raw content"
            )
        if _RAW_CONTENT_PATH.search(value):
            raise RawContentInSummaryError(
                f"summary value at '{path}' contains a filesystem path shape"
            )
        if _RAW_CONTENT_SECRET.search(value):
            raise RawContentInSummaryError(
                f"summary value at '{path}' contains a secret shape"
            )
        return
    if isinstance(value, dict):
        for k, v in value.items():
            _validate_summary_value(v, f"{path}.{k}" if path else str(k))
        return
    if isinstance(value, list):
        for i, v in enumerate(value):
            _validate_summary_value(v, f"{path}[{i}]")
        return
    # ints/floats/bools/None are metadata-safe scalars.
    return


def validate_mutation_summary(summary: dict | None) -> dict:
    """Validate a caller-supplied mutation_summary is metadata-only.

    Returns a (shallow-copied) dict on success; raises RawContentInSummaryError on any
    raw-content-shaped value (rule 3). A None summary is treated as an empty dict.
    """
    if summary is None:
        return {}
    if not isinstance(summary, dict):
        raise RawContentInSummaryError(
            f"mutation_summary must be a dict, got {type(summary).__name__}"
        )
    _validate_summary_value(summary, "")
    return dict(summary)


def _byte_len(text: str | None) -> int | None:
    """UTF-8 byte length of `text`, or None when absent."""
    if text is None:
        return None
    return len(text.encode("utf-8", errors="replace"))


def record_mutation(
    *,
    step: str,
    plane: str,
    mutation_class: str,
    before_text: str | None = None,
    after_text: str | None = None,
    claim: str = "",
    mutation_summary: dict | None = None,
    usage_before: dict | None = None,
    usage_after: dict | None = None,
    reversible_handle: str | None = None,
    evidence_ref: str | None = None,
) -> dict:
    """Build a metadata-only telemetry record for a single pipeline mutation.

    NEVER emits before/after raw text — only sha256_16 hashes, byte/token counts, and a
    VALIDATED metadata-only summary (rule 2/3). `claim_backed` is True iff a non-empty
    `evidence_ref` accompanies the claim (rule 4). An out-of-vocabulary `plane` folds to
    "unknown". The record is routed through probelib.redact as defense-in-depth.

    Raises RawContentInSummaryError if mutation_summary carries raw content.
    """
    # Validate the summary FIRST — a raw-content leak must reject the whole record.
    summary = validate_mutation_summary(mutation_summary)

    safe_plane = plane if plane in VALID_PLANES else _UNKNOWN_PLANE

    accounting = token_account(
        usage_before=usage_before,
        usage_after=usage_after,
        before_text=before_text,
        after_text=after_text,
    )

    before_sha = sha256_16(before_text) if before_text is not None else None
    after_sha = sha256_16(after_text) if after_text is not None else None
    byte_before = _byte_len(before_text)
    byte_after = _byte_len(after_text)
    if byte_before is not None and byte_after is not None:
        byte_delta: object = byte_after - byte_before
    else:
        byte_delta = PROOF_UNKNOWN

    # claim_backed: a claim with a non-empty evidence_ref is backed; a claim with no
    # evidence is the load-bearing UNBACKED audit signal (rule 4).
    has_evidence = bool(evidence_ref and str(evidence_ref).strip())
    has_claim = bool(claim and str(claim).strip())
    claim_backed = has_claim and has_evidence

    # Defense-in-depth: route the CALLER-CONTROLLED, free-text-shaped fields (claim,
    # evidence_ref, reversible_handle, mutation_summary, step) through probelib.redact so
    # a stray secret/path shape in operator-supplied text cannot leak. The numeric
    # token/byte counts and the proof-class/plane LABELS are the load-bearing observability
    # payload — they are structurally metadata, so they are assembled AFTER redaction and
    # never key-name-masked (probelib's `token`-key rule would otherwise blank the counts an
    # operator must read). The summary is independently validated metadata-only above.
    redacted_inputs = redact(
        {
            "step": step,
            "claim": claim,
            "evidence_ref": evidence_ref,
            "reversible_handle": reversible_handle,
            "mutation_summary": summary,
        }
    )

    record = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; hashes/byte+token counts/validated summary only; no raw before/after text",
        "step": redacted_inputs["step"],
        "plane": safe_plane,
        "mutation_class": mutation_class,
        "tokens_before": accounting["tokens_before"],
        "tokens_after": accounting["tokens_after"],
        "token_delta": accounting["token_delta"],
        "token_proof_class": accounting["proof_class"],
        "before_sha256_16": before_sha,
        "after_sha256_16": after_sha,
        "byte_before": byte_before,
        "byte_after": byte_after,
        "byte_delta": byte_delta,
        "mutation_summary": redacted_inputs["mutation_summary"],
        "claim": redacted_inputs["claim"],
        "claim_backed": claim_backed,
        "evidence_ref": redacted_inputs["evidence_ref"],
        "reversible_handle": redacted_inputs["reversible_handle"],
        "reversible": reversible_handle is not None,
    }
    return record


def _is_int(value: object) -> bool:
    """True iff value is a usable integer token count (not 'unknown'/None/bool-as-int)."""
    return isinstance(value, int) and not isinstance(value, bool)


def summarize(records: list[dict]) -> dict:
    """Aggregate the pipeline OBSERVABILITY REPORT from per-mutation records.

    Sums measured-or-numeric tokens-in/out where available (an "unknown" side is COUNTED
    as an unknown step, never silently treated as 0). Computes per-plane token deltas, a
    compact per-step view, the list of UNBACKED claims (steps asserting a claim with no
    evidence_ref — the audit signal), reversibility coverage, the heuristic-token
    fraction, the count of unknown-token steps, and a proof-class rollup.
    """
    step_count = len(records)
    total_tokens_in = 0
    total_tokens_out = 0
    in_known = False
    out_known = False
    net_known = False
    net_delta = 0

    per_plane: dict[str, dict] = {}
    per_step: list[dict] = []
    unbacked_claims: list[dict] = []

    reversible_count = 0
    heuristic_count = 0
    unknown_token_steps = 0
    proof_class_rollup: dict[str, int] = {
        PROOF_MEASURED: 0,
        PROOF_HEURISTIC: 0,
        PROOF_UNKNOWN: 0,
    }

    for rec in records:
        step = rec.get("step")
        plane = rec.get("plane", _UNKNOWN_PLANE)
        if plane not in VALID_PLANES:
            plane = _UNKNOWN_PLANE
        proof = rec.get("token_proof_class", PROOF_UNKNOWN)
        proof_class_rollup[proof] = proof_class_rollup.get(proof, 0) + 1
        if proof == PROOF_HEURISTIC:
            heuristic_count += 1
        if proof == PROOF_UNKNOWN:
            unknown_token_steps += 1

        tb = rec.get("tokens_before")
        ta = rec.get("tokens_after")
        td = rec.get("token_delta")
        if _is_int(tb):
            total_tokens_in += tb
            in_known = True
        if _is_int(ta):
            total_tokens_out += ta
            out_known = True
        if _is_int(td):
            net_delta += td
            net_known = True

        # per-plane bucket
        bucket = per_plane.setdefault(
            plane, {"step_count": 0, "token_delta": 0, "token_delta_known": False}
        )
        bucket["step_count"] += 1
        if _is_int(td):
            bucket["token_delta"] += td
            bucket["token_delta_known"] = True

        if rec.get("reversible"):
            reversible_count += 1

        claim = rec.get("claim", "")
        has_claim = bool(claim and str(claim).strip())
        backed = bool(rec.get("claim_backed"))
        if has_claim and not backed:
            # The step/claim are caller-controlled free text -> redact defensively before
            # listing them in the audit signal (a stray path/secret shape cannot leak).
            unbacked_claims.append(
                redact({"step": step, "plane": plane, "claim": claim})
            )

        per_step.append(
            {
                # step is caller free text -> redact; the rest are metadata labels/counts.
                "step": redact({"step": step})["step"],
                "plane": plane,
                "mutation_class": rec.get("mutation_class"),
                "token_delta": td,
                "token_proof_class": proof,
                "byte_delta": rec.get("byte_delta"),
                "claim_backed": backed,
                "reversible": bool(rec.get("reversible")),
            }
        )

    # Finalize per-plane: collapse the unknown-only buckets to an explicit "unknown".
    for bucket in per_plane.values():
        if not bucket.pop("token_delta_known"):
            bucket["token_delta"] = PROOF_UNKNOWN

    reversibility_coverage = (reversible_count / step_count) if step_count else 0.0
    heuristic_token_fraction = (heuristic_count / step_count) if step_count else 0.0

    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; aggregate counts/deltas/claim+plane labels only; no raw content",
        "step_count": step_count,
        "total_tokens_in": total_tokens_in if in_known else PROOF_UNKNOWN,
        "total_tokens_out": total_tokens_out if out_known else PROOF_UNKNOWN,
        "net_token_delta": net_delta if net_known else PROOF_UNKNOWN,
        "per_plane": per_plane,
        "per_step": per_step,
        "unbacked_claims": unbacked_claims,
        "reversibility_coverage": round(reversibility_coverage, 6),
        "heuristic_token_fraction": round(heuristic_token_fraction, 6),
        "unknown_token_steps": unknown_token_steps,
        "proof_class_rollup": proof_class_rollup,
    }
    # NOTE: the numeric token/byte aggregates ARE the observability payload and must stay
    # readable, so the whole report is NOT key-name-masked (probelib's `token`-key rule
    # would blank `total_tokens_in`/`net_token_delta`). The only caller-controlled free
    # text (step/claim labels) was already routed through redact() above, per-row.
    return report


def _load_records(records_path: Path) -> tuple[list[dict] | None, dict | None]:
    """Load one telemetry record per JSONL line. Returns (records, error_or_None).

    On a missing/unreadable file or a malformed line, returns a typed error marker
    (never a silent empty list — that would fail open).
    """
    if not records_path.exists():
        return None, {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "_error": f"records file not found: path_sha256_16={sha256_16(str(records_path))}",
            "error_type": "missing_input",
        }
    try:
        raw = records_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return None, {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "_error": f"{type(exc).__name__}: path_sha256_16={sha256_16(str(records_path))}",
            "error_type": "read_error",
        }
    records: list[dict] = []
    for lineno, raw_line in enumerate(raw.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return None, {
                "schema": SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "redaction": "metadata-only",
                "_error": f"malformed JSONL at line {lineno}",
                "error_type": "malformed_input",
            }
        if not isinstance(obj, dict):
            return None, {
                "schema": SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "redaction": "metadata-only",
                "_error": f"non-object record at line {lineno}",
                "error_type": "malformed_input",
            }
        records.append(obj)
    return records, None


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Aggregate a CAPE pipeline observability report from a per-mutation telemetry JSONL."
    )
    ap.add_argument("--records", required=True, help="Path to a telemetry records JSONL file.")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = ap.parse_args()

    records_path = Path(args.records)
    records, load_error = _load_records(records_path)
    if load_error is not None:
        report = redact(load_error)
        json.dump(report, sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    assert records is not None  # guarded above
    report = summarize(records)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
