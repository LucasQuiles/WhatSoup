#!/usr/bin/env python3
"""compressor_adapter — the reducer plane's entry stage (P3/bead 1.4). Completes Phase 1.

This is the single front door of the reducer plane. Given a raw output and an (optional, pluggable)
compressor, it produces EITHER a validated reduced candidate (ADOPT) OR a byte-recoverable verbatim
fallback (FALLBACK) — and it can never adopt a reduction that has not cleared the deterministic gates.

Pipeline (per the architecture plane diagram):

    capture -> [compressor_adapter] -> compression_governor -> anchor_preservation_gate -> (B3 / verbatim)

The adapter chains the two deterministic reducer gates and falls back to the B1 raw handle on ANY miss:
  1. B1 store(raw)            -- store the original FIRST so verbatim is always recoverable (B1-ORDERING).
                                 A store failure fails CLOSED: the compressor is NEVER invoked.
  2. external-compressor gate -- COMPRESS-EXT: an absent compressor, or an external one while
                                 `enable_external` is False, does not run; the default path is synthetic only.
  3. run compressor           -- untrusted: a raise / non-string / malformed-dict output -> verbatim.
  4. compression_governor     -- ratio over its per-content-class cap -> verbatim.
  5. anchor_preservation_gate -- any declared anchor's meaning lost -> verbatim (semantic, COMP-01).
Only when every gate passes is the reduction adopted; otherwise the caller receives the verbatim raw and
the content-addressed handle that recovers it.

COMPRESS-EXT (assumption made mechanical here): "only absent compressors fail" is WRONG. A present-but-
faulty compressor that IS enabled still has its output validated by the governor and the anchor gate; it
cannot bypass them. The external path is disabled by default.

Reuse: raw_output_handle_protocol (B1 store/retrieve — store() already proves byte-identical reversibility,
so the adapter relies on that contract rather than re-verifying), compression_governor (ratio cap),
anchor_preservation_gate (semantic survival). None of those are plane VERDICT gates (paired_trial_harness /
enricher_lift_gate), so the two_plane_separation guard is not engaged. proof_class deterministic_verifier;
fail-closed; metadata-only (handles, hashes, byte counts, verdicts, reasons — never raw or reduced text).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import raw_output_handle_protocol as b1  # noqa: E402
import compression_governor as gov  # noqa: E402
import anchor_preservation_gate as ag  # noqa: E402

SCHEMA = "agent-runtime-compressor-adapter"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"


class AdapterError(ValueError):
    """Typed, fail-closed error for malformed caller input — never a silent empty success."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _synthetic_compressor(text: str) -> str:
    """The default in-boundary synthetic reducer: collapse runs of whitespace to a single space and
    strip ends. Deterministic, no external dependency, modest reduction. Used as the CLI default and as
    a stand-in wherever an in-boundary compressor is needed (no third-party/external compressor runs)."""
    return " ".join(text.split())


def _coerce_candidate(out: Any) -> tuple[str | None, str | None]:
    """Normalize a compressor's return value to (candidate_text, fallback_reason).

    Accepts a plain str, or a dict carrying a non-empty-keyed ``reduced`` str (optional ``handle`` is
    ignored here — B1 owns the authoritative handle). Anything else is a typed fallback reason."""
    if isinstance(out, str):
        return out, None
    if isinstance(out, dict):
        reduced = out.get("reduced")
        if isinstance(reduced, str):
            return reduced, None
        return None, "compressor_malformed_output"
    return None, "compressor_non_string_output"


def _governor_meta(report: dict) -> dict:
    """Metadata-only projection of a governor report for embedding in the adapter result."""
    return {
        "verdict": report.get("overall_verdict"),
        "content_class": report.get("content_class"),
        "observed_ratio": report.get("observed_ratio"),
        "ratio_is_infinite": report.get("ratio_is_infinite"),
        "cap": report.get("cap"),
        "within_cap": report.get("within_cap"),
    }


def _anchor_meta(report: dict) -> dict:
    """Metadata-only projection of an anchor-gate report."""
    return {
        "verdict": report.get("overall_verdict"),
        "anchor_count": report.get("anchor_count"),
        "miss_reasons": report.get("miss_reasons", []),
    }


def _result(*, output_text: str, handle: str | None, store_dir: Path | None, store_status: str,
            reduced_applied: bool, governor: dict, anchor: dict, compressor_id: str | None,
            external_attempted: bool, external_enabled: bool, raw_bytes: int, output_bytes: int,
            error_type: str | None, reason: str) -> dict:
    """Assemble the adapter result. ``output_text`` is the working payload returned to the CALLER; it is
    NOT carried into the redacted report (see report_for)."""
    retrieval = b1._retrieval_command(handle, store_dir) if (handle and store_dir is not None) else None
    handle_display = handle[:16] if handle else sha256_16(output_text)
    return {
        "output_text": output_text,
        "output_kind": "reduced" if reduced_applied else "verbatim",
        "reduced_applied": reduced_applied,
        "overall_verdict": "ADOPT" if reduced_applied else "FALLBACK",
        "handle": handle,
        "handle_sha256_16": handle_display,
        "store_status": store_status,
        "retrieval_command": retrieval,
        "raw_bytes": raw_bytes,
        "output_bytes": output_bytes,
        "compressor_id": compressor_id,
        "external_attempted": external_attempted,
        "external_enabled": external_enabled,
        "governor": governor,
        "anchor": anchor,
        "proof_class": "deterministic_verifier",
        "error_type": error_type,
        "reason": reason,
    }


_SKIPPED = {"verdict": "skipped"}
_ANCHOR_SKIPPED = {"verdict": "skipped_no_anchors", "anchor_count": 0, "miss_reasons": []}


def adapt(raw: Any, *, store_dir: str | Path, compressor: Callable[[str], Any] | None = None,
          anchors: list | None = None, content_class: str | None = None,
          compressor_id: str | None = None, calibration: dict | None = None,
          is_external: bool = False, enable_external: bool = False) -> dict:
    """Gate one (raw -> reduced) candidate to ADOPT or B1 verbatim FALLBACK. Fail-closed, metadata-only.

    Stores ``raw`` first (verbatim is always recoverable), then — only if the compressor is permitted to
    run — validates its output through the governor and the anchor gate. Returns a result whose
    ``output_text`` is the text the caller should use downstream."""
    if not isinstance(raw, str):
        raise AdapterError("malformed_input", "raw output must be a string")

    raw_bytes = len(raw.encode("utf-8"))

    def fallback(*, handle, store_status, governor, anchor, error_type, reason) -> dict:
        return _result(output_text=raw, handle=handle, store_dir=Path(store_dir),
                       store_status=store_status, reduced_applied=False, governor=governor,
                       anchor=anchor, compressor_id=compressor_id, external_attempted=False,
                       external_enabled=enable_external, raw_bytes=raw_bytes, output_bytes=raw_bytes,
                       error_type=error_type, reason=reason)

    # 1) Persist raw first. A store failure fails CLOSED and the compressor is never invoked.
    try:
        handle = b1.store(raw, store_dir)
        store_status = "stored"
    except b1.StoreError as exc:
        return _result(output_text=raw, handle=None, store_dir=None, store_status="store_error",
                       reduced_applied=False, governor=_SKIPPED, anchor=_SKIPPED,
                       compressor_id=compressor_id, external_attempted=False,
                       external_enabled=enable_external, raw_bytes=raw_bytes, output_bytes=raw_bytes,
                       error_type=str(exc), reason="raw_store_unwritable")

    # 2) COMPRESS-EXT gate: no compressor, or an external one while external is disabled, does not run.
    if compressor is None:
        return fallback(handle=handle, store_status=store_status, governor=_SKIPPED, anchor=_SKIPPED,
                        error_type=None, reason="no_compressor")
    if is_external and not enable_external:
        return fallback(handle=handle, store_status=store_status, governor=_SKIPPED, anchor=_SKIPPED,
                        error_type=None, reason="external_compressor_disabled")

    # 3) Run the (now permitted) compressor defensively. It is untrusted.
    external_attempted = bool(is_external)

    def fallback_run(*, governor, anchor, error_type, reason) -> dict:
        return _result(output_text=raw, handle=handle, store_dir=Path(store_dir),
                       store_status=store_status, reduced_applied=False, governor=governor,
                       anchor=anchor, compressor_id=compressor_id,
                       external_attempted=external_attempted, external_enabled=enable_external,
                       raw_bytes=raw_bytes, output_bytes=raw_bytes, error_type=error_type, reason=reason)

    try:
        out = compressor(raw)
    except Exception as exc:  # the compressor is untrusted; never silently swallow
        return fallback_run(governor=_SKIPPED, anchor=_SKIPPED,
                            error_type=f"compressor_raised:{type(exc).__name__}",
                            reason=f"compressor_raised:{type(exc).__name__}")
    candidate, coerce_reason = _coerce_candidate(out)
    if candidate is None:
        return fallback_run(governor=_SKIPPED, anchor=_SKIPPED,
                            error_type=coerce_reason, reason=coerce_reason)

    # 4) compression_governor: ratio must sit under the per-content-class cap.
    try:
        gov_report = gov.govern(raw, candidate, content_class=content_class,
                                compressor_id=compressor_id, calibration=calibration)
    except gov.GovernorError as exc:
        return fallback_run(governor={"verdict": "ERROR", "error_type": exc.error_type},
                            anchor=_SKIPPED, error_type=f"governor_error:{exc.error_type}",
                            reason=f"governor_error:{exc.error_type}")
    gov_meta = _governor_meta(gov_report)
    if gov_report["overall_verdict"] != "PASS":
        return fallback_run(governor=gov_meta, anchor=_SKIPPED,
                            error_type="ratio_over_cap", reason="governor_rejected_ratio")

    # 5) anchor_preservation_gate: declared anchors' meaning must survive (semantic, COMP-01).
    if not anchors:
        anchor_meta = dict(_ANCHOR_SKIPPED)
    else:
        try:
            anc_report = ag.gate(raw, candidate, anchors)
        except ag.AnchorGateError as exc:
            return fallback_run(governor=gov_meta, anchor={"verdict": "ERROR", "error_type": exc.error_type},
                                error_type=f"anchor_spec_error:{exc.error_type}",
                                reason=f"anchor_spec_error:{exc.error_type}")
        anchor_meta = _anchor_meta(anc_report)
        if anc_report["overall_verdict"] != "PASS":
            return fallback_run(governor=gov_meta, anchor=anchor_meta,
                                error_type="anchor_loss", reason="anchor_gate_rejected")

    # ADOPT: every gate cleared.
    return _result(output_text=candidate, handle=handle, store_dir=Path(store_dir),
                   store_status=store_status, reduced_applied=True, governor=gov_meta, anchor=anchor_meta,
                   compressor_id=compressor_id, external_attempted=external_attempted,
                   external_enabled=enable_external, raw_bytes=raw_bytes,
                   output_bytes=len(candidate.encode("utf-8")), error_type=None,
                   reason="reduced_validated")


def report_for(result: dict) -> dict:
    """Project an adapt() result into a redacted, raw-free report. Drops the ``output_text`` payload;
    keeps handles, hashes, byte counts, verdicts, and reasons."""
    keys = ("output_kind", "reduced_applied", "overall_verdict", "handle", "handle_sha256_16",
            "store_status", "retrieval_command", "raw_bytes", "output_bytes", "compressor_id",
            "external_attempted", "external_enabled", "governor", "anchor", "proof_class",
            "error_type", "reason")
    metadata = {k: result.get(k) for k in keys}
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits handles, display hashes, byte counts, gate verdicts, and "
                     "reasons — never raw output, reduced text, or anchor text",
        "metadata": redact(metadata),
    }


def _item_compressor(item: dict) -> Callable[[str], Any]:
    """Build a per-item in-boundary compressor for the corpus/CLI surface: use a precomputed ``reduced``
    candidate if the item supplies one, else the default synthetic whitespace compressor. No external
    compressor is ever constructed here."""
    if isinstance(item.get("reduced"), str):
        reduced = item["reduced"]
        return lambda _: reduced
    return _synthetic_compressor


def adapt_corpus(items: list, *, store_dir: str | Path, calibration: dict | None = None) -> dict:
    """Run the adapter over a corpus of {raw, reduced?, anchors?, content_class?, compressor_id?}.

    Aggregates outcomes. The reducer plane is SOUND as long as nothing is adopted unvalidated and every
    raw remains recoverable — so the only fail-closed failure is a store error (raw unrecoverable).
    overall_verdict is FAIL iff any item hit a store error; fallbacks are safe, expected outcomes."""
    if not isinstance(items, list) or not items:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "item_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_corpus",
        }
    results: list = []
    for it in items:
        if not isinstance(it, dict) or "raw" not in it:
            raise AdapterError("malformed_item", "each item needs a 'raw' string")
        results.append(adapt(it["raw"], store_dir=store_dir, compressor=_item_compressor(it),
                             anchors=it.get("anchors"), content_class=it.get("content_class"),
                             compressor_id=it.get("compressor_id"), calibration=calibration))
    adopted = [i for i, r in enumerate(results) if r["reduced_applied"]]
    errored = [i for i, r in enumerate(results) if r["store_status"] == "store_error"]
    fallback = [i for i, r in enumerate(results) if not r["reduced_applied"] and i not in errored]
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "item_count": len(results),
        "adopted_count": len(adopted),
        "fallback_count": len(fallback),
        "error_count": len(errored),
        "adopted_indices": adopted,
        "fallback_indices": fallback,
        "error_indices": errored,
        "results": results,
        "overall_verdict": "FAIL" if errored else "PASS",
    }


def report_for_corpus(corpus: dict) -> dict:
    """Metadata-only projection of an adapt_corpus result: per-item reports plus the aggregate counts."""
    metadata = {k: corpus.get(k) for k in (
        "item_count", "adopted_count", "fallback_count", "error_count",
        "adopted_indices", "fallback_indices", "error_indices", "overall_verdict", "error_type")}
    metadata["results"] = [report_for(r)["metadata"] for r in corpus.get("results", [])]
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; per-item handles/verdicts/reasons and aggregate counts only",
        "metadata": redact(metadata),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Reducer-plane compressor adapter (governor + anchor gates, "
                                             "B1 verbatim fallback). Synthetic, in-boundary only.")
    ap.add_argument("--corpus", required=True,
                    help="JSON: [{raw, reduced?, anchors?, content_class?, compressor_id?}]")
    ap.add_argument("--store-dir", required=True, help="B1 raw-handle store directory (caller-controlled)")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    path = Path(args.corpus)
    if not path.exists():
        return _emit({"schema": SCHEMA, "error_type": "missing_corpus",
                      "_error": "corpus not found", "overall_verdict": "FAIL"}, 1)
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_corpus",
                      "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)
    try:
        corpus = adapt_corpus(items, store_dir=args.store_dir)
    except AdapterError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report_for_corpus(corpus), 0 if corpus["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
