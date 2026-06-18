#!/usr/bin/env python3
"""mutation_proof_chain — the plane-AGNOSTIC attestation spine of the CAPE proof chain.

For each transform step in a prompt-optimization pipeline this builds a deterministic, tamper-
evident, self-describing PROOF record and links it to the prior step. It proves, per step:
  - PROVENANCE: a linear hash chain — step N's input_hash == step N-1's output_hash, and each
    record back-points to the prior record's record_hash (no insert/drop/reorder). The genesis
    link is BOUND to the chain_id (a bare sentinel first link is forgeable).
  - DETERMINISM: run-twice-compare PLUS a perturbation check — the transform must be byte-identical
    across runs AND change its output when its input is meaningfully perturbed (so a transform that
    ignores its input / latches cloned state cannot pass as "deterministic").
  - DECLARED PURPOSE + STRUCTURAL DELTA: a typed purpose {mask, canonicalize, inject, compress} and a
    stateless structural delta-type, with PURPOSE<->DELTA constraints enforced fail-closed. mask must
    be a placeholder substitution; compress/canonicalize must be DELETION-shaped (introduce no new
    content); inject must be a contiguous edge addition.
  - BENEFIT (recorded, structurally validated here; measurement-backing is a later slice).

HONEST SCOPE (do not over-claim — see proof-chain/RED-TEAM-FINDINGS.md):
  * The purpose<->delta defense REDUCES "structural != semantic" poisoning (it blocks free-text
    masking, middle insertions, appended instructions, and from-scratch compress/canonicalize
    rewrites) but does NOT ELIMINATE it: `inject` adds attacker-chosen CONTENT at an edge — structure
    cannot certify that content is safe (that is the injection-fence's job, a separate layer).
  * `verify_chain` is keyless: it proves INTERNAL CONSISTENCY + edit-detection for a GIVEN chain, NOT
    AUTHENTICITY. Anyone can mint a self-consistent chain (genesis is a public hash of a public
    chain_id). Forgery-resistance requires a keyed producer MAC — a later slice.

CRITICAL SEPARATION RULE: this module is plane-AGNOSTIC. It must NEVER name a verdict/plane/gate
concept. Adoption (routing a step to the reducer paired-trial gate or the enricher lift gate) lives in
a separate tier and is enforced by `tools/attestation_purity_guard.py`.

Reports are metadata-only: hashes (truncated for display), enums, counts, booleans — never raw text.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402

SCHEMA = "agent-runtime-mutation-proof-chain"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# Domain separation tag (CT/Sigstore second-preimage discipline): every record/genesis hash is
# computed over DOMAIN_TAG + canonical bytes, so a record hash can never be confused with a raw
# content hash or a hash from another protocol.
DOMAIN_TAG = b"CAPE-MPC-v0\x00"

PURPOSES = ("mask", "canonicalize", "inject", "compress")
PROOF_CLASSES = ("measured", "heuristic", "unknown")
DIRECTIONS = ("decrease", "increase")

MIN_COMPRESS_RATIO = 0.10  # a `compress` step must remove at least this fraction of length

# Placeholder shapes a `mask` step may introduce (CAPE masker nonce form + generic [REDACTED]).
# The CAPE type field is BOUNDED ([A-Z]{1,16}) so the placeholder can't smuggle attacker text
# (red-team A3: an unbounded [A-Z]+ let `IGNOREALLRULES` ride inside a "redaction").
_PLACEHOLDER = re.compile(r"__CAPE_[0-9a-f]{16}_[A-Z]{1,16}_\d+__|\[REDACTED(?:_\d+)?\]")

# Dangerous invisible / control characters that survive NFC and can obfuscate a payload (red-team
# A6): zero-width, bidi overrides/isolates, BOM, and C0 controls other than \t \n \r.
_DANGEROUS_RANGES = [
    (0x200B, 0x200F),  # zero-width space..right-to-left mark
    (0x202A, 0x202E),  # bidi embeddings / overrides
    (0x2066, 0x2069),  # bidi isolates
    (0xFEFF, 0xFEFF),  # BOM / zero-width no-break space
    (0x0000, 0x0008), (0x000B, 0x000C), (0x000E, 0x001F),  # C0 controls except 	 
 
]
_DANGEROUS_UNICODE = re.compile("[" + "".join(f"{chr(a)}-{chr(b)}" for a, b in _DANGEROUS_RANGES) + "]")

DELTA_TYPES = (
    "identity", "deletion", "prefix_changed", "suffix_appended", "middle_insertion",
    "length_reduction", "length_expansion", "full_rewrite", "mask_substitution",
)


class ChainError(ValueError):
    """Typed, fail-closed proof-chain error: never green a step on uncertainty."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


# --- canonicalization + hashing ------------------------------------------------

def _normalize(text: str) -> str:
    """NFC-normalize so visually identical text hashes identically (the masker uses NFC too)."""
    return unicodedata.normalize("NFC", text)


def _hash_text(text: str) -> str:
    """Full sha256 hex of the NFC-normalized text (content hash; full width resists collision)."""
    return hashlib.sha256(_normalize(text).encode("utf-8")).hexdigest()


def canonical_bytes(payload: dict) -> bytes:
    """The single pinned canonical serialization for a record payload (sorted keys, compact, UTF-8).

    The verifier re-derives a record hash from THIS function over the stored payload and never
    re-normalizes elsewhere, so two verifiers cannot disagree on field order/whitespace and produce
    a false tamper positive.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def record_hash(payload: dict) -> str:
    """Full sha256 hex over DOMAIN_TAG + canonical payload bytes (the payload excludes record_hash)."""
    return hashlib.sha256(DOMAIN_TAG + canonical_bytes(payload)).hexdigest()


def genesis_anchor(chain_id: str) -> str:
    """The bound genesis back-pointer for a chain. Bound to chain_id so a sentinel first link can't
    be substituted across chains."""
    return hashlib.sha256(DOMAIN_TAG + b"GENESIS:" + chain_id.encode("utf-8")).hexdigest()


# --- structural delta classification (purpose != semantic defense) -------------

def _mask_ok(prev: str, new: str) -> bool:
    """True iff `new` is `prev` with one-or-more sensitive spans replaced by placeholder-shaped
    tokens and NOTHING else changed (no free-text inserted, every masked span non-empty).

    Robust by construction (not difflib, which fragments when a placeholder's bytes — e.g. the hex
    of a CAPE nonce — coincidentally match characters of the masked value): split `new` on the
    placeholder pattern into literal segments, then require those segments to appear in `prev` in
    order, left-to-right, with a non-empty gap (the masked span) for each placeholder, consuming all
    of `prev`. An empty gap would mean a placeholder replaced nothing — i.e. an injection.
    """
    if prev == new:
        return True
    if _PLACEHOLDER.search(new) is None:
        return False
    segs = _PLACEHOLDER.split(new)  # len == (#placeholders) + 1
    n = len(segs)
    if not prev.startswith(segs[0]):
        return False
    pos = len(segs[0])
    for i in range(1, n):  # each placeholder precedes segs[i]; the gap it masked is in prev
        seg = segs[i]
        if i == n - 1:  # final (suffix) segment: prev must END with it
            if seg and not prev.endswith(seg):
                return False
            gap_end = len(prev) - len(seg)
        else:
            idx = prev.find(seg, pos) if seg else pos
            if idx == -1:
                return False
            gap_end = idx
        gap = prev[pos:gap_end]
        # a real masked span is non-empty raw text — never empty (injection) and never itself a
        # placeholder (that would be re-masking / a non-mask edit around an existing placeholder).
        if gap == "" or _PLACEHOLDER.search(gap) is not None:
            return False
        pos = gap_end + len(seg)
    return pos == len(prev)


def _is_subsequence(sub: str, sup: str) -> bool:
    """True iff `sub` can be obtained from `sup` by DELETING characters only (sub is a subsequence of
    sup). A deletion-shaped delta introduces NO new content — the safe shape for compress/canonicalize
    (red-team A1/A4: `full_rewrite` let those purposes carry an arbitrary payload)."""
    it = iter(sup)
    return all(ch in it for ch in sub)


def classify_delta(prev: str, new: str) -> str:
    """Classify the structural change from prev->new into one DELTA_TYPES value. Deterministic;
    mask substitution takes priority so a masking step reads as `mask_substitution`, then deletion."""
    prev = _normalize(prev)
    new = _normalize(new)
    if prev == new:
        return "identity"
    if _mask_ok(prev, new):
        return "mask_substitution"
    if len(new) < len(prev) and _is_subsequence(new, prev):
        return "deletion"  # new introduces NO new content — pure removal
    # longest common prefix
    p = 0
    while p < len(prev) and p < len(new) and prev[p] == new[p]:
        p += 1
    # longest common suffix that does not overlap the matched prefix
    s = 0
    while s < (len(prev) - p) and s < (len(new) - p) and prev[len(prev) - 1 - s] == new[len(new) - 1 - s]:
        s += 1
    prev_mid = prev[p:len(prev) - s]
    new_mid = new[p:len(new) - s]
    if prev_mid == "" and new_mid != "":  # pure insertion at position p
        if p == 0:
            return "prefix_changed"
        if p == len(prev):
            return "suffix_appended"
        return "middle_insertion"
    if new_mid == "" and prev_mid != "":  # pure deletion
        return "length_reduction"
    # substitution region (both sides changed)
    if p == 0 and s == 0:
        return "full_rewrite"
    if len(new) > len(prev):
        return "length_expansion"
    if len(new) < len(prev):
        return "length_reduction"
    return "full_rewrite"


def check_purpose_delta(purpose: str, prev: str, new: str) -> tuple[bool, str]:
    """Enforce the PURPOSE<->DELTA constraint. Returns (ok, reason). Fail-closed caller raises."""
    if purpose not in PURPOSES:
        return False, f"unknown_purpose:{purpose}"
    prev_n = _normalize(prev)
    new_n = _normalize(new)
    dt = classify_delta(prev, new)
    if purpose == "mask":
        if dt != "mask_substitution":
            return False, f"mask_requires_placeholder_substitution_got:{dt}"
        return True, "ok"
    if purpose == "compress":
        if len(new_n) >= len(prev_n):
            return False, "compress_must_shorten"
        # DELETION-shaped only: a compressor may remove content, never introduce it (red-team A1).
        if not _is_subsequence(new_n, prev_n):
            return False, f"compress_must_be_deletion_shaped_got:{dt}"
        ratio = (len(prev_n) - len(new_n)) / len(prev_n) if prev_n else 0.0
        if ratio < MIN_COMPRESS_RATIO:
            return False, f"compress_below_min_ratio:{ratio:.3f}"
        return True, "ok"
    if purpose == "inject":
        if len(new_n) <= len(prev_n):
            return False, "inject_must_grow"
        if dt not in ("prefix_changed", "suffix_appended"):
            return False, f"inject_must_be_contiguous_edge_got:{dt}"
        # NOTE (honest scope): this proves the injection is a contiguous edge ADDITION; it does NOT
        # certify the injected CONTENT is safe — that is the injection-fence's job (separate layer).
        return True, "ok"
    # canonicalize: identity or DELETION-shaped only — never introduce content (red-team A4: a
    # `full_rewrite` could invert meaning in place). Semantic-preserving rewrites are out of scope.
    if prev_n == new_n:
        return True, "ok"
    if not _is_subsequence(new_n, prev_n):
        return False, f"canonicalize_must_not_add_content_got:{dt}"
    return True, "ok"


# --- determinism gate (run-twice + perturbation) -------------------------------

def _perturb(text: str, marker: str) -> str:
    """Insert `marker` at the interior midpoint, so a transform that merely echoes/ignores its input
    is exposed by producing an unchanged output. The marker is supplied (randomized per gate run) so
    the transform cannot recognise a fixed probe (red-team B1)."""
    if not text:
        return marker
    mid = len(text) // 2
    return text[:mid] + marker + text[mid:]


def prove_determinism(transform, text: str, n: int = 2) -> tuple[bool, dict]:
    """Run-twice-compare PLUS perturbation. ok requires BOTH: byte-identical across n runs
    (repeatable) AND a perturbed input yields a different output (input-sensitive). The perturbation
    marker is UNPREDICTABLE per invocation (os.urandom) so a marker-sniffing transform can't pass."""
    if n < 2:
        raise ChainError("determinism_arity", "determinism gate requires n>=2 runs")
    outs = [transform(text) for _ in range(n)]
    repeatable = all(o == outs[0] for o in outs[1:])
    marker = "Z" + os.urandom(8).hex()  # ascii, unpredictable, survives normalization
    perturbed_out = transform(_perturb(text, marker))
    input_sensitive = perturbed_out != outs[0]
    ok = bool(repeatable and input_sensitive)
    return ok, {"repeatable": repeatable, "input_sensitive": input_sensitive, "runs": n}


# --- the frozen, closed-field records ------------------------------------------

@dataclass(frozen=True)
class Benefit:
    value: float
    unit: str
    direction: str
    proof_class: str
    evidence_ref: str

    def __post_init__(self) -> None:
        if self.proof_class not in PROOF_CLASSES:
            raise ChainError("benefit_proof_class", f"proof_class must be one of {PROOF_CLASSES}")
        if self.direction not in DIRECTIONS:
            raise ChainError("benefit_direction", f"direction must be one of {DIRECTIONS}")

    def as_dict(self) -> dict:
        return {
            "value": self.value, "unit": self.unit, "direction": self.direction,
            "proof_class": self.proof_class, "evidence_ref": self.evidence_ref,
        }


@dataclass(frozen=True)
class Attestation:
    # CLOSED field set — NO plane / verdict / gate / adopt field. Enforced by the purity guard.
    chain_id: str
    step_index: int
    declared_purpose: str
    delta_type: str
    input_hash: str
    output_hash: str
    prev_record_hash: str
    determinism_ok: bool
    benefit: Benefit
    record_hash: str

    def payload(self) -> dict:
        """The dict that record_hash is computed over (EXCLUDES record_hash itself)."""
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "chain_id": self.chain_id,
            "step_index": self.step_index,
            "declared_purpose": self.declared_purpose,
            "delta_type": self.delta_type,
            "input_hash": self.input_hash,
            "output_hash": self.output_hash,
            "prev_record_hash": self.prev_record_hash,
            "determinism_ok": self.determinism_ok,
            "benefit": self.benefit.as_dict(),
        }

    def as_dict(self) -> dict:
        d = self.payload()
        d["record_hash"] = self.record_hash
        return d


def attest_step(
    *,
    chain_id: str,
    step_index: int,
    prev_record_hash: str,
    prev_text: str,
    new_text: str,
    declared_purpose: str,
    benefit: Benefit,
    determinism_ok: bool,
) -> Attestation:
    """Build a fail-closed attestation for one step. Raises ChainError on any violated invariant;
    never emits an optimistic/partial record."""
    if declared_purpose not in PURPOSES:
        raise ChainError("unknown_purpose", f"declared_purpose must be one of {PURPOSES}")
    if step_index < 0:
        raise ChainError("bad_step_index", "step_index must be >= 0")
    if step_index == 0 and prev_record_hash != genesis_anchor(chain_id):
        raise ChainError("genesis_unbound", "step 0 prev_record_hash must equal genesis_anchor(chain_id)")
    if not determinism_ok:
        raise ChainError("determinism_failed", "step did not pass the determinism gate")
    if _DANGEROUS_UNICODE.search(new_text) or _DANGEROUS_UNICODE.search(prev_text):
        raise ChainError("dangerous_unicode", "text contains zero-width/bidi/control characters")
    ok, reason = check_purpose_delta(declared_purpose, prev_text, new_text)
    if not ok:
        raise ChainError("purpose_delta", reason)
    delta_type = classify_delta(prev_text, new_text)
    payload = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "chain_id": chain_id,
        "step_index": step_index,
        "declared_purpose": declared_purpose,
        "delta_type": delta_type,
        "input_hash": _hash_text(prev_text),
        "output_hash": _hash_text(new_text),
        "prev_record_hash": prev_record_hash,
        "determinism_ok": determinism_ok,
        "benefit": benefit.as_dict(),
    }
    return Attestation(
        chain_id=chain_id,
        step_index=step_index,
        declared_purpose=declared_purpose,
        delta_type=delta_type,
        input_hash=payload["input_hash"],
        output_hash=payload["output_hash"],
        prev_record_hash=prev_record_hash,
        determinism_ok=determinism_ok,
        benefit=benefit,
        record_hash=record_hash(payload),
    )


# --- chain verification (metadata-only) ----------------------------------------

# purpose -> delta_types that are structurally consistent (used by verify, which has no raw text).
# compress/canonicalize accept only deletion-shaped (or identity) deltas — never full_rewrite (A1/A4).
_PURPOSE_DELTA_OK = {
    "mask": {"mask_substitution", "identity"},
    "compress": {"deletion"},
    "inject": {"prefix_changed", "suffix_appended", "length_expansion"},
    "canonicalize": {"identity", "deletion"},
}

# The exact closed key sets a loaded record must carry — no more, no less (red-team F7: an extra
# `plane`/`adopt` key must not ride through silently).
_RECORD_KEYS = frozenset({
    "schema", "schema_version", "chain_id", "step_index", "declared_purpose", "delta_type",
    "input_hash", "output_hash", "prev_record_hash", "determinism_ok", "benefit", "record_hash",
})
_BENEFIT_KEYS = frozenset({"value", "unit", "direction", "proof_class", "evidence_ref"})


def _record_from_dict(d: dict) -> Attestation:
    if not isinstance(d, dict) or set(d) != set(_RECORD_KEYS):
        raise ChainError("malformed_record", "record key set does not match the closed schema")
    b = d["benefit"]
    if not isinstance(b, dict) or set(b) != set(_BENEFIT_KEYS):
        raise ChainError("malformed_record", "benefit key set does not match the closed schema")
    # Type validation — reject bool-as-int / float-as-index / non-str hashes (red-team F5/F6).
    if not isinstance(d["step_index"], int) or isinstance(d["step_index"], bool):
        raise ChainError("malformed_record", "step_index must be a non-bool int")
    if not isinstance(d["determinism_ok"], bool):
        raise ChainError("malformed_record", "determinism_ok must be a bool")
    for k in ("chain_id", "declared_purpose", "delta_type", "input_hash", "output_hash", "prev_record_hash", "record_hash"):
        if not isinstance(d[k], str):
            raise ChainError("malformed_record", f"{k} must be a str")
    # Benefit.__post_init__ fail-closes on a bad proof_class/direction (propagates as ChainError).
    benefit = Benefit(b["value"], b["unit"], b["direction"], b["proof_class"], b["evidence_ref"])
    return Attestation(
        chain_id=d["chain_id"], step_index=d["step_index"],
        declared_purpose=d["declared_purpose"], delta_type=d["delta_type"],
        input_hash=d["input_hash"], output_hash=d["output_hash"],
        prev_record_hash=d["prev_record_hash"], determinism_ok=d["determinism_ok"],
        benefit=benefit, record_hash=d["record_hash"],
    )


def verify_chain(records: list) -> dict:
    """Verify a list of Attestation (or attestation dicts). Fail-closed: any broken continuity,
    self-hash mismatch, purpose/delta inconsistency, or failed determinism flips the verdict to FAIL.
    Returns a metadata-only report (truncated hashes, enums, booleans)."""
    atts: list[Attestation] = []
    for r in records:
        atts.append(r if isinstance(r, Attestation) else _record_from_dict(r))

    links: list[dict] = []
    if not atts:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "link_count": 0, "links": [], "overall_verdict": "FAIL", "error_type": "empty_chain",
        }

    chain_id = atts[0].chain_id
    prev: Attestation | None = None
    for att in atts:
        reasons: list[str] = []
        # self-consistency: recompute the record hash from the stored payload.
        if record_hash(att.payload()) != att.record_hash:
            reasons.append("record_hash_mismatch")
        # continuity.
        if att.chain_id != chain_id:
            reasons.append("chain_id_drift")
        if prev is None:
            if att.step_index != 0:
                reasons.append("first_step_index_not_zero")
            if att.prev_record_hash != genesis_anchor(att.chain_id):
                reasons.append("genesis_unbound")
        else:
            if att.prev_record_hash != prev.record_hash:
                reasons.append("broken_back_pointer")
            if att.input_hash != prev.output_hash:
                reasons.append("input_output_discontinuity")
            if att.step_index != prev.step_index + 1:
                reasons.append("non_monotonic_step_index")
        # structural self-checks.
        if att.declared_purpose not in PURPOSES:
            reasons.append("unknown_purpose")
        elif att.delta_type not in _PURPOSE_DELTA_OK[att.declared_purpose]:
            reasons.append(f"purpose_delta_inconsistent:{att.declared_purpose}/{att.delta_type}")
        if att.delta_type not in DELTA_TYPES:
            reasons.append("unknown_delta_type")
        # an `identity` delta MUST have identical input/output hashes — else a content swap is
        # mislabelled as a no-op (red-team F4: the one cheap text-blind binding verify CAN enforce).
        if att.delta_type == "identity" and att.input_hash != att.output_hash:
            reasons.append("identity_hash_mismatch")
        # (benefit.proof_class is validated at Benefit construction, so it is always in range here.)
        if att.determinism_ok is not True:  # truthy non-bool must not pass (red-team F5)
            reasons.append("determinism_not_ok")
        links.append({
            "step_index": att.step_index,
            "declared_purpose": att.declared_purpose,
            "delta_type": att.delta_type,
            "determinism_ok": att.determinism_ok,
            "benefit_proof_class": att.benefit.proof_class,
            "record_hash_16": sha256_16(att.record_hash),
            "verdict": "PASS" if not reasons else "FAIL",
            "reasons": reasons,
        })
        prev = att

    overall = "PASS" if all(link["verdict"] == "PASS" for link in links) else "FAIL"
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "chain_id_16": sha256_16(chain_id),
        "link_count": len(links),
        "links": links,
        "overall_verdict": overall,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify a mutation proof chain (metadata-only report).")
    ap.add_argument("--chain", required=True, help="Path to a JSON file: list of attestation records")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    path = Path(args.chain)
    if not path.exists():
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": "missing_chain", "_error": f"chain not found: sha256_16={sha256_16(str(path))}",
            "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": "malformed_chain", "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1
    try:
        report = verify_chain(records)
    except ChainError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": exc.error_type, "_error": exc.message, "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if report["overall_verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
