#!/usr/bin/env python3
"""prompt_sanitizer.py — Bead 2.2: the SECURITY-CRITICAL privacy boundary (masker).

This is the enricher-plane masker. It takes prompt/memory/retrieved text that may
carry sensitive material (provider tokens, secrets, filesystem paths, $USER,
hostnames, repo/branch tokens, long IDs) and replaces every match with a
deterministic, session-keyed placeholder so the text can be safely delegated. The
inverse `rehydrate` restores the original BYTE-IDENTICALLY.

SSOT (PATTERN-SSOT): patterns come ONLY from `sensitive_pattern_loader.load_patterns()`
(Bead 2.1). This module defines NO patterns of its own, so the masker and the residual
scan can NEVER diverge — divergence is a documented leak risk.

Placeholder format (MASK-NONCE):
    __CAPE_<16hex-session-nonce>_<TYPE>_<N>__
where TYPE ∈ {TOKEN,SECRET,PATH,USER,HOST,REPO,ID} (from the loader's pattern TYPE) and
N is a per-(TYPE) counter that is STABLE per distinct normalized entity (same entity →
same placeholder = coreference; distinct entities → distinct N). The nonce is >=16 hex.

Load-bearing rules (do not relax):
  1. NFKC normalization (NORMALIZATION/F7): both find_spans and residual_scan
     NFKC-normalize at the START, else a full-width '/' (U+FF0F) or NFD path bypasses
     matching and LEAKS. NFKC (not plain NFC) is required: NFC does NOT fold fullwidth
     confusables to ASCII, so a fullwidth-separator path would evade span detection.
  2. Longest-match-first, single pass, non-overlapping (MASK-BIJECTION): masking
     `/Users/testuser` vs `/Users/testuser/agent-runtime-probes` in one text leaves NO residual
     repo-name substring leak. Tie-break for equal (start,length) spans is DETERMINISTIC:
     by TYPE order (loader pattern order: TOKEN/SECRET providers, then structural
     PATH/USER/HOST/REPO/ID), then by pattern index within that order, then the matched
     text. This is the load-bearing stable tie-break.
  3. Adjacent non-overlapping spans (R11): two sensitive spans touching with no
     separator → BOTH masked, residual clean.
  4. Injective image: distinct entities → distinct placeholders; the swapmap is a
     bijection so rehydrate(mask(p)) == p byte-identical (against the NFKC-normalized
     input — normalization is the canonical form the masker operates on).
  5. Collision rejection: if a generated placeholder string already appears in the
     input, fail closed (raise PlaceholderCollisionError) — never an ambiguous swapmap.
  6. Residual threshold ZERO: after mask(), residual_scan(masked) MUST be empty. A
     surviving sensitive shape REJECTS the masked artifact (report.accepted=False),
     marking it for B1 verbatim fallback (Bead 2.3 wires the actual store/retrieve).
  7. session_key empty/invalid → typed session_key_status="invalid"; do NOT mask.

R1 cross-session collision guard: the swapmap is an IN-MEMORY return value ONLY. It is
NEVER persisted, logged, or shared across sessions/calls. Each call derives its own
session nonce; reusing a swapmap across sessions would let a placeholder from one
session collide with a different entity in another, so callers MUST treat it as
ephemeral and per-call.

Reports are metadata-only: counts, type histogram, nonce_present_in_input,
roundtrip_ok, residual_leaks (TYPE labels / hashes only), placeholder_collision. NEVER
raw spans/values. The two count fields are deliberately DISTINCT measures: `entity_count`
is the number of distinct masked entities (== swapmap size; coreference collapses repeats),
while `placeholder_count` is the number of placeholder OCCURRENCES emitted into the masked
output. A coreferenced entity appearing N times contributes 1 to entity_count and N to
placeholder_count, so placeholder_count >= entity_count and is strictly greater whenever
any entity repeats — they are NOT two names for one number.

CLI: python3 prompt_sanitizer.py --text-artifact <file> --session-key <str> [--pretty]
Output: metadata-only JSON report to stdout.
"""
from __future__ import annotations

import argparse
import hmac
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

from probelib import redact, sha256_16
import sensitive_pattern_loader as spl

SCHEMA = "agent-runtime-cape-prompt-sanitizer"
SCHEMA_VERSION = "0.1"

# Valid placeholder TYPE labels (from the loader's pattern TYPE column).
_VALID_TYPES = ("TOKEN", "SECRET", "PATH", "USER", "HOST", "REPO", "ID")

# Matches any well-formed CAPE placeholder (used for collision detection).
_PLACEHOLDER_RX = re.compile(r"__CAPE_[0-9a-f]{16,}_(?:%s)_\d+__" % "|".join(_VALID_TYPES))

_MASK_INFO = b"cape-mask"


class SessionKeyError(ValueError):
    """Raised when the caller-supplied session_key is empty/invalid (do NOT mask)."""


class PlaceholderCollisionError(ValueError):
    """Raised when a generated placeholder already appears in the input (fail closed)."""


def session_nonce(session_key: str) -> str:
    """Derive the 16-hex session nonce: hmac_sha256(session_key, b"cape-mask")[:16].

    The session_key MUST be a caller-supplied, non-empty string. An empty/invalid key
    raises SessionKeyError — never a silent default nonce (that would make placeholders
    forgeable / cross-session ambiguous).
    """
    if not isinstance(session_key, str) or not session_key.strip():
        raise SessionKeyError("session_key must be a non-empty string")
    digest = hmac.new(session_key.encode("utf-8"), _MASK_INFO, hashlib.sha256)
    return digest.hexdigest()[:16]


def _normalize(text: str) -> str:
    """NFKC-normalize. Load-bearing: a full-width '/' (U+FF0F) or NFD path must fold to
    its canonical ASCII form BEFORE matching, else it bypasses the scan and LEAKS. NFKC
    (compatibility decomposition) is REQUIRED here: plain NFC does NOT fold fullwidth
    look-alikes (e.g. U+FF0F '／' → '/'), so a path written with fullwidth separators would
    slip past span detection. NFKC folds those confusables to canonical ASCII."""
    return unicodedata.normalize("NFKC", text)


def _ordered_patterns(patterns: "spl.PatternSet") -> list[tuple[int, str, "re.Pattern[str]"]]:
    """Flatten the SSOT into a single ordered list with a stable rank index.

    Order = provider patterns (TOKEN/SECRET) first, then structural patterns
    (PATH/USER/HOST/REPO/ID) in loader-declared order. The rank index is the
    load-bearing deterministic tie-break key for equal (start,length) spans.
    """
    ordered: list[tuple[int, str, "re.Pattern[str]"]] = []
    rank = 0
    for typ, rx in list(patterns.provider_patterns) + list(patterns.structural_patterns):
        ordered.append((rank, typ, rx))
        rank += 1
    return ordered


def find_spans(text: str, patterns: "spl.PatternSet") -> list[tuple[int, int, str]]:
    """Return non-overlapping (start, end, TYPE) spans over the NFKC-normalized text.

    NFKC-normalizes FIRST (rule 1). Collects every match from every pattern, then
    resolves overlaps longest-match-first with a DETERMINISTIC stable tie-break:
    primary sort key (start asc, length desc); for equal (start,length) the lower
    (rank, matched_text) wins (rule 2). A greedy sweep then keeps the winning span and
    drops anything overlapping it, yielding non-overlapping spans sorted by start.
    """
    norm = _normalize(text)
    raw: list[tuple[int, int, int, str, str]] = []  # (start, -length, rank, typ, matched)
    for rank, typ, rx in _ordered_patterns(patterns):
        for m in rx.finditer(norm):
            start, end = m.start(), m.end()
            if end <= start:  # zero-width match: never a span (recorded as skipped)
                continue
            raw.append((start, -(end - start), rank, typ, norm[start:end]))
    # Deterministic order: earliest start, then longest, then lowest rank, then text.
    raw.sort(key=lambda t: (t[0], t[1], t[2], t[4]))
    chosen: list[tuple[int, int, str]] = []
    cursor = 0
    for start, neg_len, _rank, typ, _matched in raw:
        length = -neg_len
        end = start + length
        if start < cursor:
            continue  # overlaps an already-chosen (longer/earlier) span — drop it
        chosen.append((start, end, typ))
        cursor = end
    return chosen


def _entity_key(typ: str, value: str) -> tuple[str, str]:
    return (typ, value)


def mask(text: str, nonce: str, patterns: "spl.PatternSet") -> tuple[str, dict]:
    """Single-pass, longest-first masking. Returns (masked, swapmap placeholder->original).

    Coreference: a distinct normalized (TYPE, value) entity gets ONE stable placeholder;
    the per-TYPE counter N advances only for distinct entities. Collision (rule 5): if a
    generated placeholder already appears in the input, fail closed.

    The swapmap is an IN-MEMORY bijection (placeholder -> original) and MUST NOT be
    persisted or shared across sessions (R1).
    """
    norm = _normalize(text)
    spans = find_spans(norm, patterns)

    swapmap: dict[str, str] = {}
    entity_to_placeholder: dict[tuple[str, str], str] = {}
    type_counters: dict[str, int] = {}

    out_parts: list[str] = []
    cursor = 0
    for start, end, typ in spans:
        out_parts.append(norm[cursor:start])
        original = norm[start:end]
        key = _entity_key(typ, original)
        placeholder = entity_to_placeholder.get(key)
        if placeholder is None:
            n = type_counters.get(typ, 0) + 1
            type_counters[typ] = n
            placeholder = f"__CAPE_{nonce}_{typ}_{n}__"
            # Collision guard (rule 5): the placeholder must not pre-exist in the input,
            # else rehydrate would be ambiguous. Fail closed rather than emit it.
            if placeholder in norm:
                raise PlaceholderCollisionError(
                    f"generated placeholder collides with input [{typ}_{n}]"
                )
            entity_to_placeholder[key] = placeholder
            swapmap[placeholder] = original
        out_parts.append(placeholder)
        cursor = end
    out_parts.append(norm[cursor:])
    return "".join(out_parts), swapmap


def rehydrate(masked: str, swapmap: dict) -> str:
    """Exact inverse of mask(). Replaces every CAPE placeholder with its original.

    RAISES ValueError on any placeholder present in the text but absent from swapmap
    (rule 4 / fail-closed): a placeholder we cannot resolve means the swapmap is not the
    bijection that produced this text, so we must not emit a silently-wrong restoration.
    """
    found = _PLACEHOLDER_RX.findall(masked)
    for ph in found:
        if ph not in swapmap:
            raise ValueError(f"placeholder not in swapmap: {sha256_16(ph)}")

    # Every placeholder in `found` is validated present above, so the substitution is
    # total (no missing-key branch can be reached here).
    return _PLACEHOLDER_RX.sub(lambda m: swapmap[m.group(0)], masked)


def residual_scan(masked: str, patterns: "spl.PatternSet") -> list[str]:
    """Zero-tolerance residual scan over the NFKC-normalized text.

    Returns a list of surviving sensitive shapes as TYPE labels with a salted-free
    sha256_16 hash of the matched value — NEVER the raw value (rule 8). NFKC-normalizes
    first (rule 1) so an NFD/confusable residual cannot slip past. An empty list means
    no residual leak; a non-empty list REJECTS the masked artifact.
    """
    spans = find_spans(masked, patterns)
    norm = _normalize(masked)
    hits: list[str] = []
    for start, end, typ in spans:
        # label + hash only; the raw matched value never enters the result
        hits.append(f"{typ}:{sha256_16(norm[start:end])}")
    return hits


def sanitize(
    text: str,
    session_key: str,
    patterns: "spl.PatternSet",
    *,
    _force_residual_leak: bool = False,
) -> dict:
    """Mask `text` and produce a metadata-only report.

    On an empty/invalid session_key, returns session_key_status="invalid" and does NOT
    mask (rule 7). Otherwise masks, verifies the roundtrip and a zero residual, and marks
    the artifact accepted=False if any sensitive shape survives (B1 fallback signal,
    rule 6). `_force_residual_leak` is a test hook to exercise the rejection path.

    The returned dict carries the in-memory `masked`/`swapmap` for the caller plus a
    metadata-only `report`. The swapmap must NOT be persisted (R1).
    """
    try:
        nonce = session_nonce(session_key)
    except SessionKeyError:
        return {
            "session_key_status": "invalid",
            "masked": None,
            "swapmap": None,
            "report": {
                "schema": SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "redaction": "metadata-only",
                "session_key_status": "invalid",
                "accepted": False,
                "type_histogram": {},
                "placeholder_count": 0,
                "entity_count": 0,
                "nonce_present_in_input": False,
                "roundtrip_ok": False,
                "residual_leaks": [],
                "placeholder_collision": False,
            },
        }

    norm = _normalize(text)
    # nonce_present_in_input: does a placeholder of THIS session's nonce already appear?
    nonce_present = (f"__CAPE_{nonce}_" in norm)

    collision = False
    try:
        masked, swapmap = mask(norm, nonce, patterns)
    except PlaceholderCollisionError:
        # Fail closed: do not emit an ambiguous swapmap. Mark rejection for B1 fallback.
        collision = True
        return {
            "session_key_status": "ok",
            "masked": None,
            "swapmap": None,
            "report": {
                "schema": SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "redaction": "metadata-only",
                "session_key_status": "ok",
                "accepted": False,
                "type_histogram": {},
                "placeholder_count": 0,
                "entity_count": 0,
                "nonce_present_in_input": nonce_present,
                "roundtrip_ok": False,
                "residual_leaks": [],
                "placeholder_collision": collision,
            },
        }

    residual = residual_scan(masked, patterns)
    if _force_residual_leak:
        # Test hook: simulate a surviving shape WITHOUT placing a raw value in the report.
        residual = [f"PATH:{sha256_16('forced-residual-test-hook')}"]
    roundtrip_ok = (rehydrate(masked, swapmap) == norm)

    histogram: dict[str, int] = {}
    for placeholder, original in swapmap.items():
        # derive TYPE from the placeholder shape (no raw value leaves this loop)
        m = re.search(r"_([A-Z]+)_\d+__$", placeholder)
        typ = m.group(1) if m else "UNKNOWN"
        histogram[typ] = histogram.get(typ, 0) + 1

    accepted = (not residual) and roundtrip_ok and (not collision)
    # entity_count = distinct masked entities (== swapmap size, since coreference collapses
    # repeats to one placeholder). placeholder_count = the number of placeholder
    # OCCURRENCES actually emitted into the masked output: a coreferenced entity that
    # appears N times contributes N occurrences but only 1 entity, so the two fields carry
    # genuinely DIFFERENT information (placeholder_count >= entity_count, strictly greater
    # whenever any entity repeats). They are deliberately NOT two names for one number.
    entity_count = len(swapmap)
    placeholder_count = len(_PLACEHOLDER_RX.findall(masked))
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "session_key_status": "ok",
        "accepted": accepted,
        "type_histogram": histogram,
        "placeholder_count": placeholder_count,
        "entity_count": entity_count,
        "nonce_present_in_input": nonce_present,
        "roundtrip_ok": roundtrip_ok,
        "residual_leaks": residual,
        "placeholder_collision": collision,
    }
    return {
        "session_key_status": "ok",
        "masked": masked,
        "swapmap": swapmap,
        "report": report,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Mask sensitive content in a caller-supplied text artifact (metadata-only report)."
    )
    ap.add_argument("--text-artifact", required=True,
                    help="Path to a UTF-8 text file to sanitize.")
    ap.add_argument("--session-key", required=True,
                    help="Caller-supplied non-empty session key (HMAC keying material).")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = ap.parse_args()

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

    patterns = spl.load_patterns(None)
    result = sanitize(text, args.session_key, patterns)
    report = dict(result["report"])
    report["input_status"] = "ok"
    report["pattern_source_status"] = patterns.status
    # Defense-in-depth: the report is already metadata-only; redact() guards regression.
    report = redact(report)

    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    # Fail-closed exit: invalid session key, or a rejected (residual/collision) artifact
    # is a nonzero exit so a caller/CI never mistakes a degraded mask for a clean one.
    if report.get("session_key_status") != "ok":
        return 1
    if not report.get("accepted"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
