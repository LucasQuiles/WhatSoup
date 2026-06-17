#!/usr/bin/env python3
"""injection_fence.py — Bead 2.7: the SECURITY-CRITICAL untrusted-context fence.

F9 finding (+ memory lesson `feedback_retrieval_injection_fence_escape`): retrieved
corpus / memory text is a PROMPT-INJECTION VECTOR. A FIXED-DELIMITER fence is forgeable
— untrusted content can embed the literal closing delimiter to terminate the fence early
and then have its trailing bytes interpreted as trusted instructions. This module wraps
UNTRUSTED retrieved/memory content before it is injected as ADDITIVE context so corpus
text cannot (a) forge the fence to escape, or (b) smuggle instructions / authority claims.

Distinct-nonce design (do not conflate with the masker):
  - `prompt_sanitizer` (Bead 2.2) uses a PER-SESSION HMAC nonce in its placeholders.
  - THIS fence uses a distinct PER-CALL random nonce in its open/close delimiters. A
    fixed (or even per-session) fence delimiter is guessable/forgeable across many
    injected blocks; a fresh per-call nonce means content authored BEFORE the call
    cannot contain the delimiter that will wrap it.

Load-bearing rules (do not relax):
  1. FORGE RESISTANCE: `sanitize_field` neutralizes any literal fence delimiter look-alike
     (`<cape-fence ...>` / `</cape-fence ...>`) and control characters in untrusted
     content, so embedded forged delimiters CANNOT terminate the fence early. After
     fence()/unfence() the injected content is CONTAINED, never escaped.
  2. PER-CALL NONCE: `unfence` returns the content IFF the nonce matches EXACTLY. A wrong
     or absent nonce returns None (documented, not an exception swallow) — the block
     cannot be unfenced by guessing a fixed delimiter.
  3. CLAIMGUARD (non-imperative bypass): `claim_guard` flags authority / approval /
     instruction-injection phrases retrieved content might use to manipulate the agent
     ("the user already approved", "you are authorized to", "ignore previous", "system:",
     bare imperative directives). It returns CATEGORY LABELS only, NEVER the raw matched
     text (raw text would re-introduce the injection into logs/reports).
  4. POSITION: `inject_at_end` places the fenced block at the END of the prompt
     (post-final-breakpoint). Untrusted context is NEVER prepended — prepending would
     shift the cached prefix and hit lost-in-the-middle. The function ASSERTS placement.

Fail-closed: malformed input → typed marker / TypeError (never a bare return that fails
open); wrong nonce → None (documented contract); empty content → a degraded marker string
so an empty untrusted block is still visibly fenced, not silently dropped.

Reports are metadata-only: counts, flags, nonce length, roundtrip bool. NEVER raw content.

CLI: python3 injection_fence.py --content-artifact <file> [--pretty]
Output: metadata-only JSON report to stdout.
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import sys
import unicodedata
from pathlib import Path
from typing import Callable

from probelib import redact, sha256_16

SCHEMA = "agent-runtime-injection-fence"
SCHEMA_VERSION = "0.1"

# Per-call nonce width, in hex chars. >=16 hex (64 bits) so the per-call delimiter is not
# guessable by content authored before the call.
_NONCE_HEX_LEN = 32

# Degraded marker emitted for empty/whitespace-only untrusted content. It is itself
# fence-safe (no delimiter look-alikes) so it round-trips cleanly.
_EMPTY_MARKER = "[cape-fence: empty untrusted content]"

# Fence delimiter shape. The nonce is embedded so a forged delimiter in the content (which
# cannot know the per-call nonce) does not match the real open/close pair.
_FENCE_TAG = "cape-fence"


class FenceNonceError(ValueError):
    """Raised when a supplied nonce is not a well-formed lowercase-hex per-call nonce."""


def _normalize(text: str) -> str:
    """NFKC-normalize so a confusable/decomposed delimiter look-alike folds to its
    canonical ASCII form BEFORE the forge-resistance scan (else it could slip past). NFKC
    (compatibility decomposition) is REQUIRED: plain NFC does NOT fold fullwidth look-alikes
    (e.g. U+FF1C '＜'/U+FF1E '＞' → '<'/'>', U+FF1A '：' → ':'), so a forged delimiter or a
    role-injection line written with fullwidth glyphs would evade the scan. NFKC folds them."""
    return unicodedata.normalize("NFKC", text)


def call_nonce(rng: Callable[[int], str] | None = None) -> str:
    """Return a fresh per-call random lowercase-hex nonce.

    `rng` is a caller-injectable seam: a callable taking a hex length and returning that
    many hex chars. Defaults to `secrets.token_hex`-backed CSPRNG. Tests inject a
    deterministic rng for reproducibility. The result is validated to be lowercase hex of
    the expected length; a misbehaving rng raises FenceNonceError (fail closed) rather
    than emit a weak/forgeable nonce.
    """
    if rng is None:
        nonce = secrets.token_hex(_NONCE_HEX_LEN // 2)
    else:
        nonce = rng(_NONCE_HEX_LEN)
    if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{%d,}" % _NONCE_HEX_LEN, nonce):
        raise FenceNonceError(
            f"rng produced a malformed nonce (need >={_NONCE_HEX_LEN} lowercase-hex chars)"
        )
    return nonce


def _validate_nonce(nonce: str) -> str:
    """Validate a caller-supplied nonce is well-formed lowercase hex of sufficient width.

    Fail closed: anything else raises FenceNonceError so a degenerate nonce can never
    produce a guessable delimiter.
    """
    if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{%d,}" % _NONCE_HEX_LEN, nonce):
        raise FenceNonceError(
            f"nonce must be >={_NONCE_HEX_LEN} lowercase-hex chars"
        )
    return nonce


# Any open/close fence-tag look-alike in untrusted content. Matched case-insensitively and
# tolerant of attribute junk so a forged `</cape-fence nonce="...">` cannot escape.
_FENCE_LOOKALIKE_RX = re.compile(r"</?\s*" + re.escape(_FENCE_TAG) + r"\b[^>]*>", re.IGNORECASE)
# Bare angle-bracket tag whose name starts with the fence tag, even without a closing '>'
# (a truncated forgery attempt). Also neutralized.
_FENCE_PARTIAL_RX = re.compile(r"</?\s*" + re.escape(_FENCE_TAG) + r"[^\s>]*", re.IGNORECASE)
# Control characters (except common whitespace \t \n \r) that could be used to smuggle
# terminal escapes / hidden directives into the injected block.
_CONTROL_RX = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# The inert token sanitize_field() substitutes in for a neutralized fence-delimiter
# forgery. SSOT'd so build_report can count REAL neutralizations off the token itself.
_NEUTRALIZED_TOKEN = "[neutralized-fence-delimiter]"


def sanitize_field(text: str) -> str:
    """Neutralize fence-delimiter look-alikes and control chars in UNTRUSTED content.

    Forge resistance (rule 1): any literal `<cape-fence ...>` / `</cape-fence ...>` (or a
    truncated variant) is rewritten to a visible, inert token so it cannot terminate the
    real fence early. Control characters are stripped. NFKC-normalizes first so a confusable
    delimiter cannot bypass the scan.

    TypeError (fail closed) on non-str input — never a silent coercion that could mask a
    bytes/None smuggling attempt.
    """
    if not isinstance(text, str):
        raise TypeError("sanitize_field requires str content")
    norm = _normalize(text)
    norm = _FENCE_LOOKALIKE_RX.sub(_NEUTRALIZED_TOKEN, norm)
    norm = _FENCE_PARTIAL_RX.sub(_NEUTRALIZED_TOKEN, norm)
    norm = _CONTROL_RX.sub("", norm)
    return norm


def count_neutralizations(text: str) -> int:
    """Return the REAL number of fence-delimiter neutralizations sanitize_field performs.

    M5 fix: the metadata figure must MIRROR the actual neutralization path, not sum two
    independent regex populations as if disjoint (which over/mis-counts). We replay the
    SAME subs in the SAME order sanitize_field uses, then count the occurrences of the
    single replacement token it introduces. This equals exactly how many forged delimiters
    sanitize_field actually neutralized — no double counting, no phantom hits.

    A pre-existing literal `[neutralized-fence-delimiter]` in the input would be
    indistinguishable from one we add, so we discount any tokens already present in the
    NFKC-normalized input before either sub runs.
    """
    if not isinstance(text, str):
        raise TypeError("count_neutralizations requires str content")
    norm = _normalize(text)
    pre_existing = norm.count(_NEUTRALIZED_TOKEN)
    norm = _FENCE_LOOKALIKE_RX.sub(_NEUTRALIZED_TOKEN, norm)
    norm = _FENCE_PARTIAL_RX.sub(_NEUTRALIZED_TOKEN, norm)
    return norm.count(_NEUTRALIZED_TOKEN) - pre_existing


def _open_delim(nonce: str) -> str:
    return f"<{_FENCE_TAG} nonce=\"{nonce}\" trust=\"untrusted\">"


def _close_delim(nonce: str) -> str:
    return f"</{_FENCE_TAG} nonce=\"{nonce}\">"


def fence(content: str, nonce: str) -> str:
    """Wrap (sanitized) untrusted `content` with nonce-bearing open/close delimiters.

    Sanitizes the content first (defense in depth even if the caller already sanitized),
    then validates the nonce and wraps. Empty/whitespace-only content becomes the degraded
    marker (rule: empty content → degraded marker, never a silently empty fence).
    """
    _validate_nonce(nonce)
    safe = sanitize_field(content)
    if not safe.strip():
        safe = _EMPTY_MARKER
    return f"{_open_delim(nonce)}\n{safe}\n{_close_delim(nonce)}"


def unfence(fenced: str, nonce: str) -> str | None:
    """Extract the fenced content IFF `nonce` matches the embedded nonce EXACTLY.

    Per-call-nonce contract (rule 2): a wrong or absent nonce returns None — this is a
    DOCUMENTED contract, not a swallowed exception. A malformed nonce raises FenceNonceError
    (fail closed). The match is anchored on the exact open/close delimiters bearing the
    supplied nonce, so guessing a fixed delimiter cannot unfence.

    TypeError (fail closed) on non-str `fenced`.
    """
    if not isinstance(fenced, str):
        raise TypeError("unfence requires str input")
    _validate_nonce(nonce)
    open_d = _open_delim(nonce)
    close_d = _close_delim(nonce)
    start = fenced.find(open_d)
    if start < 0:
        return None  # documented: nonce/open-delimiter absent -> cannot unfence
    body_start = start + len(open_d)
    end = fenced.find(close_d, body_start)
    if end < 0:
        return None  # documented: matching close delimiter absent -> cannot unfence
    inner = fenced[body_start:end]
    # Strip the single framing newlines fence() added, without touching inner content.
    if inner.startswith("\n"):
        inner = inner[1:]
    if inner.endswith("\n"):
        inner = inner[:-1]
    return inner


# --- ClaimGuard ------------------------------------------------------------
# Category -> phrase patterns. We return CATEGORY LABELS only (rule 3); the raw matched
# text never leaves this module (logging it would re-inject the manipulation).
_CLAIM_CATEGORIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("approval_claim", (
        r"\bthe user (?:has )?already approved\b",
        r"\buser (?:has )?(?:already )?(?:approved|authorized|confirmed)\b",
        r"\b(?:approval|authorization) (?:has been |is )?granted\b",
        r"\bpre[- ]?approved\b",
    )),
    ("authority_claim", (
        r"\byou are (?:now )?authorized to\b",
        r"\byou have permission to\b",
        r"\bas an? (?:admin|administrator|root|superuser)\b",
        r"\bon behalf of (?:the )?(?:user|owner|admin)\b",
    )),
    ("instruction_override", (
        r"\bignore (?:all )?(?:previous|prior|earlier|above)\b",
        r"\bdisregard (?:all )?(?:previous|prior|earlier|the above)\b",
        r"\boverride (?:the )?(?:previous|prior|system) (?:instructions?|prompt)\b",
        r"\bforget (?:all )?(?:previous|prior|earlier) (?:instructions?|context)\b",
    )),
    ("role_injection", (
        r"(?:^|\n)\s*system\s*:",
        r"(?:^|\n)\s*assistant\s*:",
        r"(?:^|\n)\s*developer\s*:",
        r"\bnew (?:system )?(?:prompt|instructions?)\s*:",
    )),
    ("imperative_directive", (
        r"\byou (?:must|should|shall|need to|have to) (?:now )?(?:run|execute|send|delete|disable|reveal|print|output|export|transfer|approve)\b",
        r"\b(?:please )?(?:run|execute|send|delete|disable|reveal|print|export|transfer) (?:the |this |all )?(?:command|secret|token|key|file|funds?)\b",
    )),
)

_COMPILED_CLAIM_CATEGORIES: tuple[tuple[str, tuple[re.Pattern[str], ...]], ...] = tuple(
    (cat, tuple(re.compile(p, re.IGNORECASE) for p in pats))
    for cat, pats in _CLAIM_CATEGORIES
)


def claim_guard(text: str) -> list[str]:
    """Flag authority/approval/instruction-injection phrases in untrusted content.

    Returns a sorted list of CATEGORY LABELS only (rule 3) — never the raw matched text.
    NFKC-normalizes first so a confusable bypass cannot evade the scan.

    TypeError (fail closed) on non-str input.
    """
    if not isinstance(text, str):
        raise TypeError("claim_guard requires str content")
    norm = _normalize(text)
    flagged: set[str] = set()
    for category, patterns in _COMPILED_CLAIM_CATEGORIES:
        for rx in patterns:
            if rx.search(norm):
                flagged.add(category)
                break
    return sorted(flagged)


def inject_at_end(prompt: str, fenced_block: str) -> str:
    """Place `fenced_block` at the END of `prompt` (post-final-breakpoint).

    Rule 4: untrusted context is NEVER prepended. Prepending would shift the cached prefix
    (cache-neutrality) and bury trusted instructions in the middle (lost-in-the-middle).
    This function ASSERTS the block lands at the end of the returned string.

    TypeError (fail closed) on non-str inputs.
    """
    if not isinstance(prompt, str) or not isinstance(fenced_block, str):
        raise TypeError("inject_at_end requires str prompt and fenced_block")
    sep = "" if (prompt == "" or prompt.endswith("\n")) else "\n"
    result = f"{prompt}{sep}{fenced_block}"
    # Mechanical placement interlock: the fenced block is the literal suffix.
    assert result.endswith(fenced_block), "fenced block must be placed at the END"
    return result


def build_report(content: str, nonce: str) -> dict:
    """Sanitize+fence+unfence `content` under `nonce` and produce a metadata-only report.

    Counts the neutralized delimiter look-alikes, runs ClaimGuard (category labels only),
    records the nonce length and the round-trip result. NEVER emits raw content.
    """
    norm = _normalize(content)
    # M5 fix: the reported figure equals the ACTUAL neutralizations sanitize_field applies
    # (count of the replacement token it introduces, same subs in the same order) — NOT a
    # sum of two independent regex populations treated as disjoint (which over/mis-counts).
    delimiter_hits = count_neutralizations(content)
    flags = claim_guard(content)
    fenced = fence(content, nonce)
    restored = unfence(fenced, nonce)
    # The fenced body equals the sanitized content (or the degraded marker for empty input).
    safe = sanitize_field(content)
    expected = safe if safe.strip() else _EMPTY_MARKER
    roundtrip_ok = restored == expected
    # Forge-containment proof: a wrong nonce must NOT unfence (returns None).
    wrong = nonce[:-1] + ("0" if nonce[-1] != "0" else "1")
    forge_contained = unfence(fenced, wrong) is None
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "sanitized_delimiter_hits": delimiter_hits,
        "claim_guard_flags": flags,
        "fence_nonce_len": len(nonce),
        "roundtrip_ok": roundtrip_ok,
        "forge_contained": forge_contained,
        "content_empty": not safe.strip(),
        "content_sha256_16": sha256_16(norm),
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Fence UNTRUSTED retrieved/memory content and emit a metadata-only report."
    )
    ap.add_argument("--content-artifact", required=True,
                    help="Path to a UTF-8 text file of untrusted content to fence.")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = ap.parse_args()

    path = Path(args.content_artifact)
    if not path.exists():
        rep = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "input_status": "missing",
        }
        json.dump(redact(rep), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        rep = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "input_status": "read_error",
            "error_type": type(exc).__name__,
        }
        json.dump(redact(rep), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    try:
        nonce = call_nonce()
        report = build_report(content, nonce)
    except (FenceNonceError, TypeError) as exc:
        rep = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "input_status": "invalid",
            "error_type": type(exc).__name__,
        }
        json.dump(redact(rep), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    report["input_status"] = "ok"
    # Defense-in-depth: the report is already metadata-only; redact() guards regression.
    report = redact(report)

    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    # Fail-closed exit: a broken round-trip or a failed forge-containment proof is a
    # nonzero exit so a caller/CI never mistakes a degraded fence for a clean one.
    if not report.get("roundtrip_ok") or not report.get("forge_contained"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
