#!/usr/bin/env python3
"""Metadata-only canary for handoff and compaction fidelity.

The canary checks whether a compacted handoff preserves required evidence/state
anchors, keeps uncertainty qualifiers, and suppresses forbidden raw payloads.
It reads only synthetic defaults unless a caller supplies a local JSON artifact.
Reports never emit source text, compacted text, regex bodies, raw paths, prompt
bodies, transcript bodies, provider payloads, or secret-shaped values.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from probelib import SECRET_VALUE, sha256_16

SCHEMA = "agent-runtime-compaction-survival-canary"
SCHEMA_VERSION = "0.1"
SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
VALID_PLANES = {"evidence", "state", "safety", "memory", "policy", "narrative", "unknown"}


@dataclass(frozen=True)
class Anchor:
    anchor_id: str
    plane: str
    patterns: tuple[str, ...]


@dataclass(frozen=True)
class ForbiddenPattern:
    forbidden_id: str
    pattern: str


@dataclass(frozen=True)
class ClaimGuard:
    claim_id: str
    claim_pattern: str
    required_qualifier_pattern: str


@dataclass(frozen=True)
class CanaryCase:
    canary_id: str
    source_kind: str
    compacted_kind: str
    source_text: str
    compacted_text: str
    required_anchors: tuple[Anchor, ...]
    forbidden_patterns: tuple[ForbiddenPattern, ...] = ()
    claim_guards: tuple[ClaimGuard, ...] = ()


def safe_ref(identifier: str) -> str:
    text = str(identifier)
    if SAFE_ID.match(text) and not SECRET_VALUE.search(text):
        return text
    return f"sha256:{sha256_16(text)}"


def safe_kind(value: Any, default: str) -> str:
    text = str(value or default)
    return text if SAFE_ID.match(text) and not SECRET_VALUE.search(text) else default


def pattern_matches(pattern: str, text: str) -> tuple[bool, str | None]:
    try:
        return re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE) is not None, None
    except re.error as exc:
        return False, type(exc).__name__


def anchor_status(anchor: Anchor, source_text: str, compacted_text: str) -> dict[str, Any]:
    source_ok = True
    compacted_ok = True
    invalid_patterns = []
    for index, pattern in enumerate(anchor.patterns):
        source_match, source_error = pattern_matches(pattern, source_text)
        compacted_match, compacted_error = pattern_matches(pattern, compacted_text)
        if source_error or compacted_error:
            invalid_patterns.append({
                "pattern_index": index,
                "error_class": source_error or compacted_error,
            })
        if not source_match:
            source_ok = False
        if not compacted_match:
            compacted_ok = False
    return {
        "anchor_ref": safe_ref(anchor.anchor_id),
        "anchor_sha256_16": sha256_16(anchor.anchor_id),
        "plane": anchor.plane if anchor.plane in VALID_PLANES else "unknown",
        "pattern_count": len(anchor.patterns),
        "source_present": source_ok,
        "compacted_present": compacted_ok,
        "invalid_patterns": invalid_patterns,
    }


def forbidden_status(forbidden: ForbiddenPattern, source_text: str, compacted_text: str) -> dict[str, Any]:
    source_match, source_error = pattern_matches(forbidden.pattern, source_text)
    compacted_match, compacted_error = pattern_matches(forbidden.pattern, compacted_text)
    return {
        "forbidden_ref": safe_ref(forbidden.forbidden_id),
        "forbidden_sha256_16": sha256_16(forbidden.forbidden_id),
        "source_present": source_match,
        "compacted_present": compacted_match,
        "invalid_pattern": source_error or compacted_error,
    }


def claim_guard_status(guard: ClaimGuard, compacted_text: str) -> dict[str, Any]:
    claim_match, claim_error = pattern_matches(guard.claim_pattern, compacted_text)
    qualifier_match, qualifier_error = pattern_matches(guard.required_qualifier_pattern, compacted_text)
    return {
        "claim_ref": safe_ref(guard.claim_id),
        "claim_sha256_16": sha256_16(guard.claim_id),
        "claim_present": claim_match,
        "qualifier_present": qualifier_match,
        "unsupported": bool(claim_match and not qualifier_match),
        "invalid_pattern": claim_error or qualifier_error,
    }


def evaluate_case(case: CanaryCase) -> dict[str, Any]:
    anchor_rows = [anchor_status(anchor, case.source_text, case.compacted_text) for anchor in case.required_anchors]
    forbidden_rows = [forbidden_status(item, case.source_text, case.compacted_text) for item in case.forbidden_patterns]
    claim_rows = [claim_guard_status(item, case.compacted_text) for item in case.claim_guards]

    source_missing = [row for row in anchor_rows if not row["source_present"]]
    missing_required = [row for row in anchor_rows if row["source_present"] and not row["compacted_present"]]
    observed_required = [row for row in anchor_rows if row["source_present"] and row["compacted_present"]]
    forbidden_hits = [row for row in forbidden_rows if row["compacted_present"]]
    invalid_anchor_patterns = [
        {"anchor_ref": row["anchor_ref"], "plane": row["plane"], "pattern_count": len(row["invalid_patterns"])}
        for row in anchor_rows
        if row["invalid_patterns"]
    ]
    invalid_forbidden_patterns = [
        {"forbidden_ref": row["forbidden_ref"]}
        for row in forbidden_rows
        if row["invalid_pattern"]
    ]
    invalid_claim_patterns = [
        {"claim_ref": row["claim_ref"]}
        for row in claim_rows
        if row["invalid_pattern"]
    ]
    unsupported_claims = [row for row in claim_rows if row["unsupported"]]

    plane_counts = Counter(row["plane"] for row in anchor_rows)
    observed_plane_counts = Counter(row["plane"] for row in observed_required)
    invalid_pattern_count = (
        sum(len(row["invalid_patterns"]) for row in anchor_rows)
        + len(invalid_forbidden_patterns)
        + len(invalid_claim_patterns)
    )
    fail_reasons = []
    if source_missing:
        fail_reasons.append("source_missing_required_anchor")
    if missing_required:
        fail_reasons.append("compacted_missing_required_anchor")
    if forbidden_hits:
        fail_reasons.append("forbidden_payload_present")
    if unsupported_claims:
        fail_reasons.append("unsupported_claim")
    if invalid_pattern_count:
        fail_reasons.append("invalid_pattern")
    verdict = "fail" if fail_reasons else "pass"

    return {
        "canary_id": safe_ref(case.canary_id),
        "canary_id_sha256_16": sha256_16(case.canary_id),
        "source_kind": safe_kind(case.source_kind, "source"),
        "compacted_kind": safe_kind(case.compacted_kind, "compacted"),
        "source_bytes": len(case.source_text.encode("utf-8", errors="replace")),
        "compacted_bytes": len(case.compacted_text.encode("utf-8", errors="replace")),
        "source_sha256_16": sha256_16(case.source_text),
        "compacted_sha256_16": sha256_16(case.compacted_text),
        "required_anchor_count": len(anchor_rows),
        "source_anchor_present_count": len(anchor_rows) - len(source_missing),
        "observed_required_anchor_count": len(observed_required),
        "missing_required_anchor_count": len(missing_required),
        "source_missing_anchor_count": len(source_missing),
        "forbidden_pattern_count": len(forbidden_rows),
        "source_forbidden_reference_count": sum(1 for row in forbidden_rows if row["source_present"]),
        "forbidden_payload_hit_count": len(forbidden_hits),
        "claim_guard_count": len(claim_rows),
        "unsupported_claim_count": len(unsupported_claims),
        "invalid_pattern_count": invalid_pattern_count,
        "plane_counts": dict(sorted(plane_counts.items())),
        "observed_plane_counts": dict(sorted(observed_plane_counts.items())),
        "missing_required_anchor_refs": [
            {"anchor_ref": row["anchor_ref"], "plane": row["plane"], "pattern_count": row["pattern_count"]}
            for row in missing_required
        ],
        "source_missing_anchor_refs": [
            {"anchor_ref": row["anchor_ref"], "plane": row["plane"], "pattern_count": row["pattern_count"]}
            for row in source_missing
        ],
        "forbidden_payload_hit_refs": [
            {"forbidden_ref": row["forbidden_ref"]}
            for row in forbidden_hits
        ],
        "unsupported_claim_refs": [
            {"claim_ref": row["claim_ref"]}
            for row in unsupported_claims
        ],
        "invalid_pattern_refs": invalid_anchor_patterns + invalid_forbidden_patterns + invalid_claim_patterns,
        "fail_reasons": fail_reasons,
        "verdict": verdict,
    }


def default_canaries() -> tuple[CanaryCase, ...]:
    return (
        CanaryCase(
            canary_id="r10_handoff_state_survives",
            source_kind="synthetic_session_handoff",
            compacted_kind="synthetic_compacted_handoff",
            source_text=(
                "R10 evidence: branch fix/agent-config-root-isolation-20260615 at 66616c60 "
                "is pushed but not merged. Full suite: 9,846 tests passed / 11 skipped. "
                "corpus_guard PASS. Raw credential canary sk-syntheticsecret9999 should be suppressed."
            ),
            compacted_text=(
                "R10 is on pushed branch fix/agent-config-root-isolation-20260615 at 66616c60, "
                "not merged. Evidence preserved: full suite 9,846 tests passed / 11 skipped and "
                "corpus_guard PASS. Raw credential values were suppressed."
            ),
            required_anchors=(
                Anchor("r10_branch_and_head", "evidence", (r"fix/agent-config-root-isolation-20260615", r"66616c60")),
                Anchor("r10_not_merged_state", "state", (r"not merged",)),
                Anchor("r10_full_suite_counts", "evidence", (r"9,846 tests passed", r"11 skipped")),
                Anchor("guard_pass", "evidence", (r"corpus_guard", r"PASS")),
            ),
            forbidden_patterns=(ForbiddenPattern("raw_secret_shape", r"sk-syntheticsecret9999"),),
            claim_guards=(ClaimGuard("r10_complete_requires_merge_qualifier", r"\bR10\b.*\b(complete|done|landed)\b", r"not merged|pushed branch"),),
        ),
        CanaryCase(
            canary_id="runtime_uncertainty_survives",
            source_kind="synthetic_research_note",
            compacted_kind="synthetic_compacted_note",
            source_text=(
                "Current-turn tool table is unproven. Runtime activation is unproven. "
                "Never dump raw hidden system prompts. RAW HIDDEN SYSTEM PROMPT: private body."
            ),
            compacted_text=(
                "Keep the uncertainty: current-turn tool table unproven and runtime activation unproven. "
                "Safety boundary preserved: never dump raw hidden system prompts; raw body suppressed."
            ),
            required_anchors=(
                Anchor("current_turn_tool_table_unproven", "state", (r"current-turn tool table (is )?unproven",)),
                Anchor("runtime_activation_unproven", "state", (r"runtime activation (is )?unproven",)),
                Anchor("hidden_prompt_boundary", "safety", (r"never dump raw hidden system prompts",)),
            ),
            forbidden_patterns=(ForbiddenPattern("raw_hidden_prompt_body", r"RAW HIDDEN SYSTEM PROMPT:\s*private body"),),
        ),
        CanaryCase(
            canary_id="reducer_raw_ref_survives",
            source_kind="synthetic_tool_output_reducer",
            compacted_kind="synthetic_reduced_output",
            source_text=(
                "Command fixture: exit_code=1, failing_test=test_compaction_survival_canary.py, "
                "omitted_line_count=1400, raw_ref=sha256:abc123def456, stderr had pcsk_synthetic_secret9999."
            ),
            compacted_text=(
                "Reducer digest: exit_code=1, failing_test=test_compaction_survival_canary.py, "
                "omitted_line_count=1400, raw_ref=sha256:abc123def456, sensitive stderr content suppressed."
            ),
            required_anchors=(
                Anchor("exit_code_preserved", "evidence", (r"exit_code=1",)),
                Anchor("failing_test_preserved", "evidence", (r"test_compaction_survival_canary\.py",)),
                Anchor("omission_count_preserved", "evidence", (r"omitted_line_count=1400",)),
                Anchor("raw_ref_preserved", "evidence", (r"raw_ref=sha256:abc123def456",)),
            ),
            forbidden_patterns=(ForbiddenPattern("raw_pinecone_secret_shape", r"pcsk_synthetic_secret9999"),),
        ),
    )


def anchor_from_dict(data: dict[str, Any], index: int) -> Anchor:
    raw_patterns = data.get("patterns", [])
    if isinstance(raw_patterns, str):
        patterns = (raw_patterns,)
    elif isinstance(raw_patterns, list):
        patterns = tuple(str(item) for item in raw_patterns if isinstance(item, (str, int, float)))
    else:
        patterns = ()
    return Anchor(
        anchor_id=str(data.get("anchor_id") or data.get("id") or f"anchor_{index}"),
        plane=safe_kind(data.get("plane"), "unknown") if str(data.get("plane") or "unknown") in VALID_PLANES else "unknown",
        patterns=patterns,
    )


def forbidden_from_dict(data: dict[str, Any], index: int) -> ForbiddenPattern:
    return ForbiddenPattern(
        forbidden_id=str(data.get("forbidden_id") or data.get("id") or f"forbidden_{index}"),
        pattern=str(data.get("pattern") or ""),
    )


def claim_guard_from_dict(data: dict[str, Any], index: int) -> ClaimGuard:
    return ClaimGuard(
        claim_id=str(data.get("claim_id") or data.get("id") or f"claim_{index}"),
        claim_pattern=str(data.get("claim_pattern") or ""),
        required_qualifier_pattern=str(data.get("required_qualifier_pattern") or ""),
    )


def case_from_dict(data: dict[str, Any], index: int) -> CanaryCase:
    anchors = data.get("required_anchors", data.get("anchors", []))
    forbidden = data.get("forbidden_patterns", [])
    claim_guards = data.get("claim_guards", [])
    return CanaryCase(
        canary_id=str(data.get("canary_id") or data.get("id") or f"canary_{index}"),
        source_kind=safe_kind(data.get("source_kind"), "artifact_source"),
        compacted_kind=safe_kind(data.get("compacted_kind"), "artifact_compacted"),
        source_text=str(data.get("source_text") or data.get("source") or ""),
        compacted_text=str(data.get("compacted_text") or data.get("compacted") or data.get("summary") or ""),
        required_anchors=tuple(anchor_from_dict(item, i) for i, item in enumerate(anchors) if isinstance(item, dict)),
        forbidden_patterns=tuple(forbidden_from_dict(item, i) for i, item in enumerate(forbidden) if isinstance(item, dict)),
        claim_guards=tuple(claim_guard_from_dict(item, i) for i, item in enumerate(claim_guards) if isinstance(item, dict)),
    )


def load_artifact(path: Path) -> tuple[tuple[CanaryCase, ...], dict[str, Any]]:
    meta = {
        "status": "not_loaded",
        "path_sha256_16": sha256_16(str(path)),
        "byte_count": 0,
        "case_count": 0,
    }
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        meta["byte_count"] = len(text.encode("utf-8", errors="replace"))
        data = json.loads(text)
    except FileNotFoundError:
        meta["status"] = "missing"
        return (), meta
    except json.JSONDecodeError as exc:
        meta.update({"status": "invalid_json", "error_class": type(exc).__name__})
        return (), meta
    if isinstance(data, dict):
        raw_cases = data.get("canaries", data.get("cases", []))
    elif isinstance(data, list):
        raw_cases = data
    else:
        raw_cases = []
    cases = tuple(case_from_dict(item, index) for index, item in enumerate(raw_cases) if isinstance(item, dict))
    meta.update({"status": "loaded", "case_count": len(cases)})
    return cases, meta


def build_report(cases: tuple[CanaryCase, ...] | None = None, artifact_path: Path | None = None) -> dict[str, Any]:
    artifact = {"status": "synthetic_defaults", "case_count": len(default_canaries())}
    if artifact_path is not None:
        cases, artifact = load_artifact(artifact_path)
    elif cases is None:
        cases = default_canaries()
    case_rows = [evaluate_case(case) for case in cases]
    verdict_counts = Counter(row["verdict"] for row in case_rows)
    fail_reason_counts = Counter(reason for row in case_rows for reason in row["fail_reasons"])
    plane_counts = Counter(plane for row in case_rows for plane, count in row["plane_counts"].items() for _ in range(count))
    fail_count = verdict_counts.get("fail", 0)
    if artifact.get("status") in {"missing", "invalid_json"}:
        fail_count += 1
        fail_reason_counts[f"artifact_{artifact['status']}"] += 1
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "synthetic_or_caller_supplied_compaction_fixture",
        "redaction": (
            "metadata-only compaction canary; emits canary ids or hashes, source/summary byte counts, "
            "content hashes, required-anchor counts, plane counts, missing-anchor refs, forbidden-payload refs, "
            "unsupported-claim refs, and verdicts; never emits raw source text, compacted text, regex bodies, "
            "artifact paths, prompt bodies, transcript bodies, provider payloads, auth values, or secrets"
        ),
        "artifact": artifact,
        "policy": {
            "required_planes": ["evidence", "state", "safety"],
            "forbidden_payload_policy": "raw secrets, raw hidden prompts, raw transcript/provider payloads, and raw tool bodies must be suppressed",
            "unsupported_claim_policy": "claim guards require qualifying evidence/state phrases when a risky completion claim appears",
        },
        "summary": {
            "canary_count": len(case_rows),
            "pass_count": verdict_counts.get("pass", 0),
            "fail_count": fail_count,
            "verdict_counts": dict(sorted(verdict_counts.items())),
            "fail_reason_counts": dict(sorted(fail_reason_counts.items())),
            "required_anchor_count": sum(row["required_anchor_count"] for row in case_rows),
            "observed_required_anchor_count": sum(row["observed_required_anchor_count"] for row in case_rows),
            "missing_required_anchor_count": sum(row["missing_required_anchor_count"] for row in case_rows),
            "source_missing_anchor_count": sum(row["source_missing_anchor_count"] for row in case_rows),
            "forbidden_payload_hit_count": sum(row["forbidden_payload_hit_count"] for row in case_rows),
            "unsupported_claim_count": sum(row["unsupported_claim_count"] for row in case_rows),
            "invalid_pattern_count": sum(row["invalid_pattern_count"] for row in case_rows),
            "plane_counts": dict(sorted(plane_counts.items())),
            "verdict": "fail" if fail_count else "pass",
        },
        "canaries": case_rows,
        "limitations": [
            "Default mode uses synthetic fixtures only; it does not run a provider, trigger real compaction, or parse live transcripts.",
            "Caller-supplied artifacts are reduced to metadata and hashes; artifact freshness and completeness remain caller responsibilities.",
            "Regex anchors prove phrase preservation for known fields, not semantic equivalence of arbitrary summaries.",
            "Content hashes are included for correlation; raw source and compacted bodies are intentionally suppressed.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check compaction/handoff survival through metadata-only canaries.")
    parser.add_argument("--artifact", type=Path, help="Optional JSON fixture with canaries/cases.")
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(artifact_path=args.artifact)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 2 if report["summary"]["verdict"] == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
