#!/usr/bin/env python3
"""prompt_rehydration_gate.py — Bead 2.3: the SECURITY-CRITICAL masked-delegation gate.

This is the enricher-plane safe round-trip. It wraps a (possibly remote/untrusted)
delegate so sensitive prompt/memory/retrieved text can be delegated WITHOUT leaking the
raw original, and so a faithful result is rehydrated only when we can PROVE the delegate
neither mutated, dropped, nor hallucinated a placeholder and left no residual leak. On any
doubt it discards the delegate output and recovers the byte-identical original.

The safe round-trip:

    store(original) -> mask -> delegate(masked) -> integrity check -> rehydrate
                                                              (else) B1 verbatim fallback

Load-bearing assumptions (do not relax):

  B1-ORDERING (F8): the verbatim ORIGINAL is stored to a B1 handle (caller-supplied
    --store-dir, 0700 dir / 0600 file) BEFORE masking/delegation. If store() raises, the
    gate returns a verbatim-passthrough verdict and the delegate is NEVER invoked — the
    worker must not see anything if we cannot guarantee recovery. Likewise an invalid
    session key or a sanitizer-rejected artifact short-circuits BEFORE delegation.

  MASK-BIJECTION: masking/rehydration is delegated to prompt_sanitizer (Bead 2.2), which
    performs single-pass longest-first span replacement with exact rehydration. This gate
    does NOT re-implement masking; it only verifies the delegate preserved the placeholder
    set and that rehydration is clean.

Integrity check (ALL must hold, else integrity="violated"):
  - the placeholders present in the delegate's RETURN are a SUBSET of the placeholders
    SENT (exact-token match — no fuzzy). Any mutation or hallucination breaks the subset.
  - rehydrate(returned) succeeds and equals the (NFKC-normalized) original byte-identical.
    A dropped placeholder passes the subset test but breaks this equality.
  - residual_scan(rehydrated) is empty (a delegate that injects a fresh sensitive shape
    leaks even with matched placeholders).
  - the B1 handle is present and retrieve() reconstructs the original byte-identical.

On violation the gate retrieves the byte-identical original from B1 (fallback="verbatim_b1")
or, when the original was never stored (store error / invalid key / mask rejected), returns
the in-memory original (fallback="verbatim_passthrough"). The delegate output is discarded.

Reports are metadata-only: integrity, fallback, placeholder counts, handle/store status,
residual_clean. NEVER the raw prompt, original, delegate text, or any CAPE placeholder
string (placeholders embed the session nonce).

CLI: python3 prompt_rehydration_gate.py --text-artifact <file> --session-key <str>
         --store-dir <dir> [--pretty]
Output: metadata-only JSON report to stdout. Nonzero exit on any non-ok verdict.
"""
from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path
from typing import Callable

from probelib import redact
import sensitive_pattern_loader as spl
from prompt_sanitizer import (
    PlaceholderCollisionError,
    _PLACEHOLDER_RX,
    rehydrate,
    residual_scan,
    sanitize,
)
from raw_output_handle_protocol import StoreError, retrieve, store

SCHEMA = "agent-runtime-prompt-rehydration-gate"
SCHEMA_VERSION = "0.1"

# A delegate maps masked text -> processed text (placeholders preserved verbatim).
Delegate = Callable[[str], str]


def identity_delegate(masked: str) -> str:
    """Default delegate stub: returns the masked text unchanged (a faithful worker)."""
    return masked


def _placeholders(text: str) -> list[str]:
    """Extract every CAPE placeholder token from text (exact-token, no fuzzy match)."""
    return _PLACEHOLDER_RX.findall(text)


def _report(
    *,
    integrity: str,
    fallback: str | None,
    sent_placeholder_count: int,
    returned_placeholder_count: int,
    handle_present: bool,
    store_status: str,
    residual_clean: bool,
    session_key_status: str,
    mask_status: str,
    recovery_status: str,
    violation_reason: str | None,
) -> dict:
    """Assemble the metadata-only verdict report. NEVER carries raw/original/delegate text
    or placeholder strings (placeholders embed the session nonce)."""
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "integrity": integrity,
        "fallback": fallback,
        "sent_placeholder_count": sent_placeholder_count,
        "returned_placeholder_count": returned_placeholder_count,
        "handle_present": handle_present,
        "store_status": store_status,
        "residual_clean": residual_clean,
        "session_key_status": session_key_status,
        "mask_status": mask_status,
        "recovery_status": recovery_status,
        "violation_reason": violation_reason,
    }


def _passthrough_result(
    *,
    original: str,
    store_status: str,
    session_key_status: str,
    mask_status: str,
    violation_reason: str,
) -> dict:
    """Build a verbatim-passthrough result. Used BEFORE the original is stored to B1 (store
    error / invalid session key / sanitizer-rejected artifact): the worker was never invoked,
    so the only recoverable copy is the in-memory original we still hold."""
    report = _report(
        integrity="violated",
        fallback="verbatim_passthrough",
        sent_placeholder_count=0,
        returned_placeholder_count=0,
        handle_present=False,
        store_status=store_status,
        residual_clean=False,
        session_key_status=session_key_status,
        mask_status=mask_status,
        recovery_status="in_memory_original",
        violation_reason=violation_reason,
    )
    return {"restored": original, "report": report}


def run_gate(
    text: str,
    session_key: str,
    store_dir: str | Path,
    *,
    delegate: Delegate = identity_delegate,
    patterns: "spl.PatternSet | None" = None,
) -> dict:
    """Run the safe masked-delegation round-trip over ``text``.

    Returns ``{"restored": <str|None>, "report": <metadata-only dict>}``. ``restored`` is the
    caller-facing payload: the faithful rehydrated text on integrity="ok", or the
    byte-identical original on a verbatim fallback. It is None ONLY when recovery itself
    failed (e.g. a missing handle on retrieve), which is recorded as a typed recovery_status.

    Fail-closed ordering (B1-ORDERING): invalid session key, a sanitizer-rejected artifact,
    or a store() failure all short-circuit BEFORE the delegate is ever invoked.
    """
    if patterns is None:
        patterns = spl.load_patterns(None)

    # NFKC-normalize once: this is the canonical form the masker operates on, so byte-identity
    # comparisons downstream are against the normalized original (matching prompt_sanitizer).
    # MUST match prompt_sanitizer._normalize EXACTLY (NFKC, not plain NFC): if the gate
    # normalized with NFC while the masker uses NFKC, a fullwidth-confusable input would mask
    # to the NFKC form but be compared against an NFC original, breaking the byte-identity
    # check AND leaving the cleartext confusable path in the stored/passthrough original.
    original = unicodedata.normalize("NFKC", text)

    # 1) Mask FIRST (no side effects). An invalid session key or a rejected artifact means we
    #    cannot safely delegate -> verbatim passthrough, delegate NEVER invoked.
    try:
        masked_result = sanitize(original, session_key, patterns)
    except PlaceholderCollisionError:
        # sanitize() already catches collisions internally, but guard the import contract:
        # a raised collision is a rejected artifact, not a clean mask.
        return _passthrough_result(
            original=original,
            store_status="not_attempted",
            session_key_status="ok",
            mask_status="rejected",
            violation_reason="placeholder_collision",
        )

    session_key_status = masked_result.get("session_key_status", "invalid")
    if session_key_status != "ok":
        return _passthrough_result(
            original=original,
            store_status="not_attempted",
            session_key_status=session_key_status,
            mask_status="not_attempted",
            violation_reason="invalid_session_key",
        )

    masked = masked_result.get("masked")
    swapmap = masked_result.get("swapmap")
    if masked is None or swapmap is None or not masked_result.get("report", {}).get("accepted", False):
        # The masker rejected the artifact (residual/collision). Do not delegate.
        return _passthrough_result(
            original=original,
            store_status="not_attempted",
            session_key_status="ok",
            mask_status="rejected",
            violation_reason="mask_rejected",
        )

    # 2) Store the verbatim ORIGINAL to B1 BEFORE delegation (B1-ORDERING). A store failure
    #    is fail-closed: the delegate is NEVER invoked and we passthrough the in-memory original.
    try:
        handle = store(original, store_dir)
    except StoreError as exc:
        return _passthrough_result(
            original=original,
            store_status="store_error",
            session_key_status="ok",
            mask_status="masked",
            violation_reason=f"raw_store_error:{type(exc).__name__}",
        )

    sent_placeholders = _placeholders(masked)
    sent_set = set(sent_placeholders)

    # 3) Delegate the MASKED text. The delegate is untrusted; a raising delegate is a
    #    violation (we discard its output and fall back), never a silent pass.
    delegate_raised: str | None = None
    try:
        returned = delegate(masked)
        if not isinstance(returned, str):
            delegate_raised = f"delegate_non_string:{type(returned).__name__}"
            returned = ""
    except Exception as exc:  # untrusted delegate; fail closed to B1 fallback
        delegate_raised = f"delegate_raised:{type(exc).__name__}"
        returned = ""

    returned_placeholders = _placeholders(returned)
    returned_set = set(returned_placeholders)

    # 4) Integrity check. ALL conditions must hold for integrity="ok".
    #
    # The residual scan runs on the delegate's RETURNED (still-masked) output, NOT on the
    # rehydrated text: a faithful rehydration restores the sensitive original, which by
    # definition scans dirty, so scanning the restored text would reject every honest
    # round-trip. The real risk we guard is a delegate that injects a FRESH sensitive shape
    # in cleartext (outside the placeholder set) — that survives into the returned text and
    # into rehydration, and residual_scan over the returned masked text catches it.
    rehydrated: str | None = None
    violation_reason: str | None = None
    residual_clean = False
    if delegate_raised is not None:
        violation_reason = delegate_raised
    elif not returned_set.issubset(sent_set):
        # Mutation or hallucination: a returned placeholder was never sent.
        violation_reason = "placeholder_not_subset"
    else:
        # The returned text must still be a clean masked artifact (no fresh leak injected).
        residual = residual_scan(returned, patterns)
        residual_clean = not residual
        if residual:
            violation_reason = "residual_leak"
        else:
            # Subset holds and the returned text is residual-clean; now prove rehydration is
            # faithful (byte-identical to the original).
            try:
                rehydrated = rehydrate(returned, swapmap)
            except ValueError:
                # A placeholder present-but-unresolvable means the swapmap is not this text's
                # bijection (e.g. a mutated token slipped the subset check) -> violation.
                rehydrated = None
                violation_reason = "rehydrate_failed"
            if rehydrated is not None and rehydrated != original:
                # A dropped placeholder passes subset but loses an entity here.
                violation_reason = "rehydrated_not_identical"

    if violation_reason is None:
        # Faithful round-trip. Confirm the B1 anchor still reconstructs byte-identical so the
        # "ok" verdict carries a real reversibility guarantee, not just a delegate-trust claim.
        try:
            anchored = retrieve(handle, store_dir)
            anchor_ok = anchored.decode("utf-8") == original
        except (FileNotFoundError, StoreError, ValueError):
            anchor_ok = False
        if not anchor_ok:
            violation_reason = "handle_unverifiable"

    if violation_reason is None:
        report = _report(
            integrity="ok",
            fallback=None,
            sent_placeholder_count=len(sent_placeholders),
            returned_placeholder_count=len(returned_placeholders),
            handle_present=True,
            store_status="stored",
            residual_clean=True,
            session_key_status="ok",
            mask_status="masked",
            recovery_status="not_needed",
            violation_reason=None,
        )
        return {"restored": rehydrated, "report": report}

    # 5) Violation: discard the delegate output and recover the byte-identical original from B1.
    recovery_status = "recovered_from_b1"
    restored: str | None
    try:
        restored_bytes = retrieve(handle, store_dir)
        restored = restored_bytes.decode("utf-8")
        if restored != original:
            # Stored bytes do not reconstruct the original — a corrupt/mismatched handle.
            recovery_status = "recovered_mismatch"
            restored = None
    except FileNotFoundError:
        recovery_status = "retrieve_error"
        restored = None
    except (StoreError, ValueError):
        recovery_status = "retrieve_error"
        restored = None

    report = _report(
        integrity="violated",
        fallback="verbatim_b1",
        sent_placeholder_count=len(sent_placeholders),
        returned_placeholder_count=len(returned_placeholders),
        handle_present=True,
        store_status="stored",
        residual_clean=residual_clean,
        session_key_status="ok",
        mask_status="masked",
        recovery_status=recovery_status,
        violation_reason=violation_reason,
    )
    return {"restored": restored, "report": report}


def main_argv(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Bead 2.3 masked-delegation rehydration gate (metadata-only report)."
    )
    ap.add_argument("--text-artifact", required=True,
                    help="Path to a UTF-8 text file to delegate safely.")
    ap.add_argument("--session-key", required=True,
                    help="Caller-supplied session key (HMAC keying material for the masker).")
    ap.add_argument("--store-dir", required=True,
                    help="Caller-supplied B1 store directory (created 0700; files 0600).")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = ap.parse_args(argv)

    path = Path(args.text_artifact)
    if not path.exists():
        rep = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "input_status": "missing",
            "session_key_status": "not_evaluated",
        }
        json.dump(redact(rep), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        rep = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "input_status": "read_error",
            "error_type": type(exc).__name__,
            "session_key_status": "not_evaluated",
        }
        json.dump(redact(rep), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    # Default CLI delegate is the identity stub: a clean round-trip proof without a worker.
    result = run_gate(text, args.session_key, args.store_dir)
    report = dict(result["report"])
    report["input_status"] = "ok"
    # Defense-in-depth: the report is already metadata-only; redact() guards regression.
    report = redact(report)

    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    # Fail-closed exit: any non-ok integrity verdict is a nonzero exit so a caller/CI never
    # mistakes a degraded (fallback) round-trip for a clean one.
    if report.get("integrity") != "ok":
        return 1
    return 0


def main() -> int:
    return main_argv(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
