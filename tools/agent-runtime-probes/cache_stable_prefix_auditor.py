#!/usr/bin/env python3
"""cache_stable_prefix_auditor — measure init/tool-surface churn across caller-supplied
Claude stream-json captures, the cache-stability risk indicator that drives whether a
token reducer can safely touch the always-loaded prefix (HR-1, corpus priority #1).

HONEST SCOPE: the default stream-json mode measures only the init/tool envelope that
`tool_surface_diff.parse_stream_json` exposes (model, permission_mode, normalized tool
names) plus cache-risk indicators. It does NOT prove raw provider prefix byte layout,
hidden prompt content, or section offsets. Prefix-section findings are emitted ONLY from a
caller-supplied, redacted `--section-artifact` and are gated behind
`section_artifact_provided=true`.

Pure function of caller-supplied offline captures/fixtures: no live provider calls, no host
state touch. Composes existing probe helpers (DRY) rather than re-implementing parsing.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from probelib import redact, sha256_16
from runtime_budget_rail import parse_opencode_stats_output
from tool_surface_diff import find_init, normalize_tool, parse_stream_json

SCHEMA = "agent-runtime-cache-stable-prefix-auditor"
SCHEMA_VERSION = "0.1"
REDACTION = (
    "metadata-only; no prompt bodies, provider payloads, transcripts, tool arg values, "
    "raw schemas, raw section bytes, or auth material — only names, counts, byte sizes, "
    "hashes, class labels, and pass/fail verdicts"
)

VOLATILE_CLASSES = {"volatile", "high_volatility", "dynamic"}


def _ordered_init_tools(text: str) -> tuple[list[str], int]:
    """Recover the tools in their ORIGINAL provider order from the capture text.

    ``tool_surface_diff.parse_stream_json`` sorts tool names, which destroys the
    provider ordering the breakpoint invariant must observe. We re-derive the raw
    order here by locating the same init envelope via the shared ``find_init`` helper
    and normalizing ``init["tools"]`` in place (no sort), reusing the shared
    ``normalize_tool``. This composes the existing helpers (DRY) without mutating any
    shared component.

    Returns ``(ordered_tools, malformed_line_count)``. Skipping a non-JSON line in
    the JSONL stream is intentional, but it is NOT silent: each invalid/unparseable
    line is counted into ``malformed_line_count`` so the caller can surface how many
    lines were unreadable rather than fail open and discard the signal."""
    init = None
    malformed_line_count = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            # invalid / unparseable JSONL line: count it as a degraded/skipped line
            # (typed signal, surfaced to the caller) rather than silently failing open.
            malformed_line_count += 1
            continue
        init = find_init(obj)
        if init:
            break
    if not init:
        return [], malformed_line_count
    ordered = [t for t in (normalize_tool(t) for t in init.get("tools", [])) if t is not None]
    return ordered, malformed_line_count


def _capture_envelope(text: str) -> dict[str, Any]:
    """Per-capture init/tool envelope reusing tool_surface_diff.parse_stream_json.

    Adds the per-tool name hashes the cross-capture diff needs, without emitting raw tool
    names beyond the hashes (the parse helper already emits counts/names; we keep only the
    metadata the auditor reports).

    ``tool_name_hashes`` is the sorted (set-membership) signal. ``ordered_tool_name_hashes``
    preserves the provider ordering so the breakpoint invariant can detect a re-template /
    reorder of an otherwise-identical tool set (sorted hashes alone hide that event)."""
    parsed = parse_stream_json(text, source_class="caller_supplied_capture")
    tools = parsed.get("tools") or []
    tool_name_hashes = sorted(sha256_16(name) for name in tools)
    ordered_tools, ordered_scan_malformed_lines = _ordered_init_tools(text)
    ordered_tool_name_hashes = [sha256_16(name) for name in ordered_tools]
    return {
        "input_bytes": parsed["input_bytes"],
        "input_sha256_16": parsed["input_sha256_16"],
        "parsed_json_lines_until_init": parsed["parsed_json_lines_until_init"],
        "invalid_json_lines_until_init": parsed["invalid_json_lines_until_init"],
        "init_found": parsed["init_found"],
        "model": parsed["model"],
        "permission_mode": parsed["permission_mode"],
        "tool_count": parsed["tool_count"],
        "mcp_tool_count": parsed["mcp_tool_count"],
        "core_tool_count": parsed["core_tool_count"],
        "tool_name_hashes": tool_name_hashes,
        "ordered_tool_name_hashes": ordered_tool_name_hashes,
        "ordered_scan_malformed_lines": ordered_scan_malformed_lines,
    }


def build_capture_report(path: Path) -> dict[str, Any]:
    """One capture -> metadata envelope or a typed fail-closed status.

    parse_status semantics: ``ok`` (init found), ``no_init_found`` (parsed but no init
    envelope), ``invalid`` (capture unreadable / decode failure)."""
    path_sha = sha256_16(str(path))
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {
            "path_sha256_16": path_sha,
            "parse_status": "invalid",
            "error_type": type(exc).__name__,
        }
    try:
        envelope = _capture_envelope(text)
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        return {
            "path_sha256_16": path_sha,
            "parse_status": "invalid",
            "error_type": type(exc).__name__,
        }
    status = "ok" if envelope["init_found"] else "no_init_found"
    return {"path_sha256_16": path_sha, "parse_status": status, **envelope}


def _breakpoint_invariant(
    base_hashes: list[str], cap_hashes: list[str]
) -> tuple[bool, int | None]:
    """Return (breakpoint_moved, first_moved_block_index) for one capture pair.

    Operates over the PROVIDER-ORDERED hash lists (``ordered_tool_name_hashes``),
    not the sorted set-membership list — a sorted list would make a reorder of the
    same tool set invisible (the H1 false-negative).

    ``breakpoint_moved`` is True when ``cap_hashes`` is NOT a pure append of
    ``base_hashes`` — i.e. at least one position within the shared prefix region
    has a different hash, meaning the prefix region was re-templated, reordered,
    or shifted. A pure append means every element of ``base_hashes`` appears at the
    same index in ``cap_hashes`` (cap may have additional elements beyond that
    prefix). ``first_moved_block_index`` is the index of the first diverging
    element, else None. Both values are deterministic and metadata-only."""
    for i, h in enumerate(base_hashes):
        if i >= len(cap_hashes) or cap_hashes[i] != h:
            return True, i
    return False, None


def cross_capture_churn(captures: list[dict[str, Any]]) -> dict[str, Any]:
    """Diff usable (parse_status=ok) capture envelopes. Every churn flag carries the
    triggering datum (value / hash / capture index)."""
    usable = [(idx, cap) for idx, cap in enumerate(captures) if cap.get("parse_status") == "ok"]
    if len(usable) < 2:
        return {
            "comparable_capture_count": len(usable),
            "verdict": "need_two_captures_for_diff",
        }
    base_idx, base = usable[0]
    base_tools = set(base["tool_name_hashes"])
    # Breakpoint invariant runs over PROVIDER-ORDERED hashes (set/sorted hashes would
    # hide a same-set reorder — the H1 false-negative). tool_name_hashes (sorted) stays
    # the set-membership signal that drives tool_set_churn.
    base_ordered = base["ordered_tool_name_hashes"]
    model_churn = False
    permission_churn = False
    tool_set_churn = False
    first_differing_capture_index = None
    added_tool_hashes: list[str] = []
    removed_tool_hashes: list[str] = []
    model_values = [base["model"]]
    permission_values = [base["permission_mode"]]
    # Breakpoint positional invariant: evaluated across EVERY usable pair (vs base),
    # ORing the result and recording the EARLIEST moved index plus the FIRST capture
    # index that moved it (mirrors tool_set_churn / first_differing_capture_index).
    breakpoint_moved: bool = False
    first_moved_block_index: int | None = None
    breakpoint_capture_index: int | None = None
    for idx, cap in usable[1:]:
        cap_tools = set(cap["tool_name_hashes"])
        differed = False
        if cap["model"] != base["model"]:
            model_churn = True
            differed = True
        if cap["permission_mode"] != base["permission_mode"]:
            permission_churn = True
            differed = True
        added = sorted(cap_tools - base_tools)
        removed = sorted(base_tools - cap_tools)
        if added or removed:
            tool_set_churn = True
            differed = True
            added_tool_hashes.extend(h for h in added if h not in added_tool_hashes)
            removed_tool_hashes.extend(h for h in removed if h not in removed_tool_hashes)
        model_values.append(cap["model"])
        permission_values.append(cap["permission_mode"])
        if differed and first_differing_capture_index is None:
            first_differing_capture_index = idx
        # Breakpoint invariant over ordered hashes, accumulated across all pairs.
        moved, moved_index = _breakpoint_invariant(
            base_ordered, cap["ordered_tool_name_hashes"]
        )
        if moved:
            if not breakpoint_moved:
                breakpoint_moved = True
                breakpoint_capture_index = idx
            # keep the EARLIEST diverging position seen across any pair
            if first_moved_block_index is None or (
                moved_index is not None and moved_index < first_moved_block_index
            ):
                first_moved_block_index = moved_index
    # A moved breakpoint (same set, reordered prefix) is itself a cache-stability risk
    # even when membership is unchanged, so it counts toward the churn verdict.
    any_churn = model_churn or permission_churn or tool_set_churn or breakpoint_moved
    return {
        "comparable_capture_count": len(usable),
        "baseline_capture_index": base_idx,
        "model_churn": model_churn,
        "permission_churn": permission_churn,
        "tool_set_churn": tool_set_churn,
        "added_tool_hashes": sorted(added_tool_hashes),
        "removed_tool_hashes": sorted(removed_tool_hashes),
        "first_differing_capture_index": first_differing_capture_index,
        "observed_models": model_values,
        "observed_permission_modes": permission_values,
        "breakpoint_moved": breakpoint_moved,
        "first_moved_block_index": first_moved_block_index,
        "breakpoint_capture_index": breakpoint_capture_index,
        "cache_stability_risk": "churn_detected" if any_churn else "stable_across_captures",
        "verdict": "prefix_churn_detected" if any_churn else "init_surface_stable",
    }


def build_section_report(path: Path) -> dict[str, Any]:
    """Optional caller-supplied redacted prefix-section map.

    The offset reported by ``first_duplicate_section_offset`` is over the CALLER-SUPPLIED
    canonicalized section bytes, NOT an unobserved provider prefix. Each section row carries
    its declared name, byte count, content hash, volatility class, and provenance.

    INTRA-ARTIFACT SCOPE (do not confuse with a cross-capture diff): the
    ``first_duplicate_section`` / ``first_duplicate_section_offset`` fields fire ONLY when a
    section NAME is DUPLICATED *within this single artifact* and the duplicate's content
    hash differs from the earlier same-named section in the SAME file. They detect an
    intra-artifact same-name-different-content inconsistency — they are NOT a diff across
    captures or across separately-supplied artifacts."""
    path_sha = sha256_16(str(path))
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {
            "section_artifact_status": "invalid",
            "path_sha256_16": path_sha,
            "error_type": type(exc).__name__,
        }
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        return {
            "section_artifact_status": "invalid",
            "path_sha256_16": path_sha,
            "error_type": "JSONDecodeError",
            "error_line": exc.lineno,
        }
    sections = doc.get("sections") if isinstance(doc, dict) else None
    if not isinstance(sections, list) or not sections:
        return {
            "section_artifact_status": "unsupported_shape",
            "path_sha256_16": path_sha,
            "missing_field": "sections",
        }
    rows: list[dict[str, Any]] = []
    running_offset = 0
    first_duplicate_section = None
    first_duplicate_section_offset = None
    prior_hash_by_name: dict[str, str] = {}
    for entry in sections:
        if not isinstance(entry, dict):
            return {
                "section_artifact_status": "unsupported_shape",
                "path_sha256_16": path_sha,
                "missing_field": "section_object",
            }
        name = str(entry.get("name", ""))
        content = entry.get("content")
        if not isinstance(content, str):
            return {
                "section_artifact_status": "unsupported_shape",
                "path_sha256_16": path_sha,
                "missing_field": "content",
                "section_name": name,
            }
        content_bytes = content.encode("utf-8", errors="replace")
        byte_count = len(content_bytes)
        content_hash = sha256_16(content)
        volatility_class = str(entry.get("volatility_class", "unknown"))
        provenance = str(entry.get("source_provenance", "caller_supplied"))
        if name in prior_hash_by_name and prior_hash_by_name[name] != content_hash:
            if first_duplicate_section is None:
                first_duplicate_section = name
                first_duplicate_section_offset = running_offset
        prior_hash_by_name[name] = content_hash
        rows.append({
            "name": name,
            "byte_count": byte_count,
            "content_sha256_16": content_hash,
            "volatility_class": volatility_class,
            "source_provenance": provenance,
            "canonical_offset": running_offset,
        })
        running_offset += byte_count
    volatile_sections = sorted(
        r["name"] for r in rows if r["volatility_class"].lower() in VOLATILE_CLASSES
    )
    return {
        "section_artifact_status": "ok",
        "path_sha256_16": path_sha,
        "section_count": len(rows),
        "sections": rows,
        "first_duplicate_section": first_duplicate_section,
        "first_duplicate_section_offset": first_duplicate_section_offset,
        "volatile_section_names": volatile_sections,
        "offset_scope": "caller_supplied_canonicalized_section_bytes_not_provider_prefix",
    }


def build_cache_report(path: Path) -> dict[str, Any]:
    """Optional `opencode stats` text -> cache read/write counters reusing
    runtime_budget_rail.parse_opencode_stats_output. Only emitted when parse succeeds."""
    path_sha = sha256_16(str(path))
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {
            "cache_status": "invalid",
            "path_sha256_16": path_sha,
            "error_type": type(exc).__name__,
        }
    parsed = parse_opencode_stats_output(text, "", 0, 0)
    if parsed.get("status") != "parsed":
        return {
            "cache_status": "not_parsed",
            "path_sha256_16": path_sha,
            "parse_status": parsed.get("status"),
        }
    cost_tokens = parsed.get("cost_tokens") or {}
    read = cost_tokens.get("cache_read_tokens")
    write = cost_tokens.get("cache_write_tokens")
    return {
        "cache_status": "ok",
        "path_sha256_16": path_sha,
        "read": read,
        "write": write,
        "read_to_input_ratio": parsed.get("cache_read_to_input_ratio"),
    }


def build_report(
    capture_paths: list[Path],
    section_path: Path | None = None,
    stats_path: Path | None = None,
) -> dict[str, Any]:
    captures = [build_capture_report(path) for path in capture_paths]
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "capture_count": len(captures),
        "captures": captures,
        "cross_capture": cross_capture_churn(captures),
        "honest_scope": (
            "default mode proves init/tool churn and cache-risk indicators only; it does "
            "NOT prove raw provider prefix byte layout, hidden prompt content, or section "
            "offsets. Prefix-section findings require section_artifact_provided=true."
        ),
        "section_artifact_provided": section_path is not None,
        "stats_capture_provided": stats_path is not None,
    }
    if section_path is not None:
        report["section_artifact"] = build_section_report(section_path)
    if stats_path is not None:
        report["cache"] = build_cache_report(stats_path)
    return redact(report)


def main() -> int:
    parser = argparse.ArgumentParser(description="Cache-stable prefix / init-surface churn auditor.")
    parser.add_argument(
        "--captures", type=Path, nargs="+", required=True,
        help="caller-supplied offline Claude stream-json captures (>=2 for cross-capture diff)",
    )
    parser.add_argument(
        "--section-artifact", type=Path, default=None,
        help="optional caller-supplied redacted prefix-section map (JSON)",
    )
    parser.add_argument(
        "--stats-capture", type=Path, default=None,
        help="optional text of `opencode stats` for cache counters",
    )
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    report = build_report(args.captures, args.section_artifact, args.stats_capture)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
