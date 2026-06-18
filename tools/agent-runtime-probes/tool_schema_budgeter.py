#!/usr/bin/env python3
"""tool_schema_budgeter — metadata-only MCP tool / skill schema budget auditor.

Task A2 (Headroom++ pre-reducer gate, corpus priority #2). Honors the A2-SCHEMA
correction: NO schema-byte reclaim claim is made from static local config alone.
The default path is OFFLINE — it inventories local MCP/skill config and never
spawns an MCP server or `--probe-tools` live process.

Schema bytes are counted ONLY when an actual schema object is supplied via a
caller-provided `--schema-artifact` (an MCP `tools/list` / init-tool capture).
Tools known only from static config get `schema_source_class="static_config_only"`
and `schema_bytes=null`; their bytes are never collapsed to zero and never enter
the reclaimable total. `--tool-artifact` (an init / tool-table capture) supplies
observed active-vs-deferred state and last-use evidence.

Defer-eligibility is a deterministic advisory rule over side-effect class, a
configured hot-tool allowlist, and observed active/deferred state. It REQUIRES an
observed state from a `--tool-artifact`: with no observed state a tool is
`defer_eligible="unproven_no_observed_state"` (never True) and contributes nothing
to reclaimable bytes, because a name heuristic is not a measurement. The reused
side-effect name heuristic returns `likely_read_or_compute` as a catch-all default;
when that default fires for an ambiguous/mutation-capable verb (no corroborating
signal) A2 downgrades the effective class to `unknown_review_required` and excludes
the tool from reclaimable bytes regardless of observed state. Because changing
always-loaded tools can be a cache-reset boundary, the report emits a
`cache_mutation_risk` recommendation instead of treating reclaimable bytes as
automatically safe.

Redaction: metadata only — names (plus name hashes), counts, byte sizes, class
labels, and pass/fail. No argument values, auth material, raw schemas, or tool
descriptions are emitted.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from probelib import load_json, redact, sha256_16
from mcp_schema_inventory_probe import (
    collect_claude_plugin_mcp,
    collect_codex,
    collect_opencode,
    schema_shape,
    side_effect_class_for_tool,
    summarize_tools,
)
from skill_metadata_inventory_probe import build_report as build_skill_report

SCHEMA = "agent-runtime-tool-schema-budgeter"
SCHEMA_VERSION = "0.1"

# Hot tools that are commonly load-bearing on every turn. Deferring these is a
# cache-reset boundary, so they are never advised as safely deferrable.
HOT_TOOL_ALLOWLIST = {
    "read",
    "edit",
    "write",
    "bash",
    "grep",
    "glob",
    "ls",
    "task",
    "todowrite",
    "notebookedit",
}

# Source-class labels for the schema-byte provenance dimension.
STATIC_ONLY = "static_config_only"
OFFLINE_ARTIFACT = "offline_schema_artifact"

# Effective side-effect class emitted by A2 when the reused name heuristic returns
# its catch-all read/compute default with NO corroborating signal. We do NOT
# collapse "unknown" to "safe/read": such a tool may still mutate, so it is review-
# required and is excluded from reclaimable bytes regardless of observed state.
UNKNOWN_SIDE_EFFECT = "unknown_review_required"
READ_OR_COMPUTE = "likely_read_or_compute"

# Ambiguous/mutation-capable verbs the base heuristic's destructive list does NOT
# catch, but which can perform writes/external effects despite landing in the
# read/compute default (e.g. `query_records`/`query_database` may mutate). Their
# presence is the "no corroborating signal" trigger: the read/compute verdict is
# downgraded to unknown_review_required rather than trusted as safe.
AMBIGUOUS_SIDE_EFFECT_VERBS = (
    "query",
    "exec",
    "invoke",
    "call",
    "apply",
    "sync",
    "import",
    "export",
    "upload",
    "submit",
    "process",
    "modify",
    "mutate",
    "publish",
    "trigger",
    "enrich",
    "drop",
    "truncate",
    "merge",
    "set-",
    "set_",
)


def effective_side_effect_class(name: str, base_class: str) -> str:
    """A2's effective side-effect class over the reused name heuristic.

    The base heuristic (`side_effect_class_for_tool`) returns READ_OR_COMPUTE as a
    catch-all DEFAULT whenever no destructive/browser/stateful substring matched —
    that is the *absence* of a write signal, NOT positive evidence of read-only
    behavior. When that default fires for a name carrying an ambiguous/mutation-
    capable verb (no corroborating signal), A2 records UNKNOWN_SIDE_EFFECT so the
    tool is review-required and never silently treated as safely deferrable.
    """
    if base_class != READ_OR_COMPUTE:
        return base_class
    lowered = name.lower()
    if any(verb in lowered for verb in AMBIGUOUS_SIDE_EFFECT_VERBS):
        return UNKNOWN_SIDE_EFFECT
    return READ_OR_COMPUTE


def canonical_schema_bytes(schema: dict[str, Any]) -> int:
    """Per-tool schema byte count over a canonicalized JSON encoding."""
    return len(json.dumps(schema, sort_keys=True, separators=(",", ":"), default=str))


def collect_config_tools() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Collect configured MCP servers from every harness, fail-closed per source.

    Returns (servers, errors). A malformed source contributes a typed `_error`
    row to errors rather than silently dropping the source.
    """
    servers: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    collectors = (
        ("codex", collect_codex),
        ("opencode", collect_opencode),
        ("claude_plugin", collect_claude_plugin_mcp),
    )
    for source_name, collector in collectors:
        try:
            entries = collector()
        except Exception as exc:  # fail-closed: never silently drop a source
            errors.append({
                "source": source_name,
                "_error": f"{type(exc).__name__}: {exc}",
                "status": "collector_error",
            })
            continue
        if not isinstance(entries, list):
            errors.append({
                "source": source_name,
                "_error": "collector_returned_non_list",
                "status": "collector_error",
            })
            continue
        servers.extend(entries)
    return servers, errors


def load_schema_artifact(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Parse a caller-supplied schema artifact into {tool_name: shape_with_bytes}.

    Accepted shapes: a top-level {"tools": [...]} object, or a bare list of tool
    objects. Each tool object should carry `name` and an `inputSchema`/`schema`
    object. Returns ({name: schema_meta}, status).
    """
    raw = load_json(path)
    if raw is None:
        return {}, {"schema_artifact_status": "missing", "error_type": "missing_input"}
    if isinstance(raw, dict) and "_error" in raw:
        return {}, {"schema_artifact_status": "invalid", "error_type": "malformed_input",
                    "_error": raw["_error"]}
    if isinstance(raw, dict):
        tools = raw.get("tools")
    elif isinstance(raw, list):
        tools = raw
    else:
        tools = None
    if not isinstance(tools, list):
        return {}, {"schema_artifact_status": "unsupported_shape",
                    "error_type": "unsupported_shape",
                    "_error": "no_tools_list_in_schema_artifact"}
    by_name: dict[str, dict[str, Any]] = {}
    non_dict_schema = 0
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "")
        if not name:
            continue
        schema = tool.get("inputSchema")
        if schema is None:
            schema = tool.get("schema")
        if not isinstance(schema, dict):
            # Non-dict schema is excluded from byte totals but still recorded.
            non_dict_schema += 1
            by_name[name] = {
                "schema_status": "non_dict_schema",
                "schema_bytes": None,
                "arg_field_count": None,
            }
            continue
        shape = schema_shape(schema)
        by_name[name] = {
            "schema_status": "ok",
            "schema_bytes": canonical_schema_bytes(schema),
            "arg_field_count": shape.get("property_count", 0),
        }
    return by_name, {
        "schema_artifact_status": "ok",
        "tool_count_in_artifact": len(by_name),
        "non_dict_schema_count": non_dict_schema,
    }


def _iter_artifact_lines(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Read a tool-artifact as either JSON (object/list) or JSONL. Fail-closed."""
    try:
        text = path.read_text()
    except OSError as exc:
        return [], {"tool_artifact_status": "missing", "error_type": "missing_input",
                    "_error": f"{type(exc).__name__}: {exc}"}
    text = text.strip()
    if not text:
        return [], {"tool_artifact_status": "unsupported_shape",
                    "error_type": "unsupported_shape", "_error": "empty"}
    objs: list[dict[str, Any]] = []
    # Try whole-document JSON first.
    try:
        doc = json.loads(text)
    except json.JSONDecodeError:
        doc = None
    if doc is not None:
        if isinstance(doc, list):
            objs = [o for o in doc if isinstance(o, dict)]
        elif isinstance(doc, dict):
            objs = [doc]
        return objs, {"tool_artifact_status": "ok"}
    # Fall back to JSONL.
    bad = 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            bad += 1
            continue
        if isinstance(obj, dict):
            objs.append(obj)
    if not objs:
        return [], {"tool_artifact_status": "invalid", "error_type": "malformed_input",
                    "invalid_json_lines": bad}
    return objs, {"tool_artifact_status": "ok", "invalid_json_lines": bad}


def _names_from_tool_obj(obj: dict[str, Any]) -> list[str]:
    """Extract tool names from an init/tool-table-style object."""
    names: list[str] = []
    tools = obj.get("tools")
    if isinstance(tools, list):
        for t in tools:
            if isinstance(t, dict) and t.get("name"):
                names.append(str(t["name"]))
            elif isinstance(t, str):
                names.append(t)
    # init envelope sometimes nests under result.tools
    result = obj.get("result")
    if isinstance(result, dict) and isinstance(result.get("tools"), list):
        for t in result["tools"]:
            if isinstance(t, dict) and t.get("name"):
                names.append(str(t["name"]))
            elif isinstance(t, str):
                names.append(t)
    return names


def load_tool_artifact(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Parse active-vs-deferred + last-use evidence keyed by tool name.

    Recognized per-tool fields when objects carry them: `active`/`deferred`,
    `last_use`/`last_used`/`last_use_ts`. Otherwise, any tool NAME observed in
    the artifact is treated as `active` (it was advertised in the captured turn).
    """
    objs, status = _iter_artifact_lines(path)
    if status.get("tool_artifact_status") != "ok":
        return {}, status
    by_name: dict[str, dict[str, Any]] = {}
    for obj in objs:
        # Explicit per-tool state objects.
        name = obj.get("name")
        if name and ("active" in obj or "deferred" in obj or "last_use" in obj
                     or "last_used" in obj):
            active = obj.get("active")
            deferred = obj.get("deferred")
            if active is None and deferred is not None:
                active = not bool(deferred)
            state = "active" if active else "deferred"
            last = obj.get("last_use") or obj.get("last_used") or obj.get("last_use_ts")
            by_name[str(name)] = {
                "observed_state": state,
                "last_use_evidence": "observed" if last else "none_recorded",
            }
            continue
        # Tool-table / init envelope: presence == active.
        for tname in _names_from_tool_obj(obj):
            by_name.setdefault(tname, {
                "observed_state": "active",
                "last_use_evidence": "present_in_capture",
            })
    return by_name, {
        "tool_artifact_status": "ok",
        "observed_tool_count": len(by_name),
        "invalid_json_lines": status.get("invalid_json_lines", 0),
    }


def defer_eligibility(
    name: str,
    side_effect_class: str,
    observed_state: str | None,
) -> dict[str, Any]:
    """Deterministic advisory defer rule. Never auto-marks reclaim as safe.

    Returns {defer_eligible, defer_reason, cache_mutation_risk}. Hot-allowlist
    tools and tools observed active are flagged with a cache-reset boundary
    warning; deferring them is advisory-only, not automatically reclaimable.

    Invariant 2 (no verdict from non-measured data): defer-eligibility REQUIRES an
    observed active/deferred state from a caller-supplied tool artifact. Without it,
    `defer_eligible="unproven_no_observed_state"` (never True) — a name heuristic is
    not a measurement. Tools whose effective side-effect class is unknown
    (UNKNOWN_SIDE_EFFECT) are never defer-eligible regardless of observed state.
    """
    lowered = name.lower()
    is_hot = lowered in HOT_TOOL_ALLOWLIST
    # Read/compute tools with no side effects are the safest defer candidates.
    low_side_effect = side_effect_class == READ_OR_COMPUTE
    if is_hot:
        return {
            "defer_eligible": False,
            "defer_reason": "hot_tool_allowlist",
            "cache_mutation_risk": "high_changing_always_loaded_tool_resets_cache",
        }
    # No observed state -> cannot prove the tool is deferrable from measured data.
    # A name heuristic alone is advisory-only and must not yield defer_eligible=True.
    if observed_state not in ("active", "deferred"):
        return {
            "defer_eligible": "unproven_no_observed_state",
            "defer_reason": "no_observed_state_requires_tool_artifact",
            "cache_mutation_risk": "unknown_tool_state_not_measured",
        }
    if observed_state == "active":
        # It is loaded this turn; deferring it mutates the active set -> cache reset.
        return {
            "defer_eligible": True if low_side_effect else False,
            "defer_reason": "observed_active_advisory" if low_side_effect
            else "observed_active_with_side_effect",
            "cache_mutation_risk": "medium_deferring_active_tool_may_reset_cache",
        }
    # observed_state == "deferred": advisory eligible if low-side-effect.
    return {
        "defer_eligible": bool(low_side_effect),
        "defer_reason": "low_side_effect_not_active" if low_side_effect
        else "side_effecting_tool_review_required",
        "cache_mutation_risk": "low_tool_not_in_observed_active_set",
    }


def server_tool_names(server: dict[str, Any]) -> list[str]:
    """Tool names a config entry contributes.

    Static MCP config does not enumerate per-tool schemas; the server itself is
    the only deterministic config-level tool unit. We key by server name so
    schema-artifact / tool-artifact overlays can attach real per-tool rows.
    """
    name = str(server.get("server") or "")
    return [name] if name else []


def build_tool_rows(
    servers: list[dict[str, Any]],
    schema_by_name: dict[str, dict[str, Any]],
    observed_by_name: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build the per-tool budget rows, merging config + artifacts deterministically."""
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    # 1) One row per configured server (static_config_only unless artifact upgrades it).
    for server in servers:
        harness = str(server.get("harness") or "")
        for tname in server_tool_names(server):
            key = (harness, tname)
            if key in seen:
                continue
            seen.add(key)
            rows.append(_make_row(tname, "configured_server", harness,
                                  schema_by_name, observed_by_name))

    # 2) Rows for tools present only in a schema artifact (no matching config server).
    for tname in sorted(schema_by_name):
        if any(k[1] == tname for k in seen):
            continue
        seen.add(("schema_artifact", tname))
        rows.append(_make_row(tname, "schema_artifact_only", "unknown",
                              schema_by_name, observed_by_name))

    # 3) Rows for tools observed in a tool artifact but absent from config + schema.
    for tname in sorted(observed_by_name):
        if any(k[1] == tname for k in seen):
            continue
        seen.add(("tool_artifact", tname))
        rows.append(_make_row(tname, "tool_artifact_only", "unknown",
                              schema_by_name, observed_by_name))

    return sorted(rows, key=lambda r: (r["source_class"], r["name"]))


def _make_row(
    name: str,
    source_class: str,
    harness: str,
    schema_by_name: dict[str, dict[str, Any]],
    observed_by_name: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    sec = effective_side_effect_class(name, side_effect_class_for_tool(name))
    schema_meta = schema_by_name.get(name)
    if schema_meta is None:
        schema_source_class = STATIC_ONLY
        schema_bytes: int | None = None
        arg_field_count: int | None = None
        schema_status = "no_schema_artifact"
    elif schema_meta.get("schema_status") == "non_dict_schema":
        schema_source_class = OFFLINE_ARTIFACT
        schema_bytes = None
        arg_field_count = None
        schema_status = "non_dict_schema"
    else:
        schema_source_class = OFFLINE_ARTIFACT
        schema_bytes = schema_meta.get("schema_bytes")
        arg_field_count = schema_meta.get("arg_field_count")
        schema_status = "ok"

    observed = observed_by_name.get(name) or {}
    observed_state = observed.get("observed_state")
    last_use = observed.get("last_use_evidence", "unknown")
    if observed_state == "active":
        loaded = "always_loaded"
    elif observed_state == "deferred":
        loaded = "deferred"
    else:
        loaded = "unknown"

    elig = defer_eligibility(name, sec, observed_state)
    # false_trigger_risk: side-effecting tools that could fire on a stray model
    # decision are higher false-trigger risk; read/compute tools are low.
    false_trigger_risk = (
        "low" if sec == "likely_read_or_compute"
        else "elevated_side_effecting_tool"
    )
    return {
        "name": name,
        "name_sha256_16": sha256_16(name),
        "harness": harness,
        "source_class": source_class,
        "schema_source_class": schema_source_class,
        "schema_status": schema_status,
        "schema_bytes": schema_bytes,
        "arg_field_count": arg_field_count,
        "side_effect_class": sec,
        "always_loaded_vs_deferred": loaded,
        "defer_eligible": elig["defer_eligible"],
        "defer_reason": elig["defer_reason"],
        "cache_mutation_risk": elig["cache_mutation_risk"],
        "false_trigger_risk": false_trigger_risk,
        "last_use_evidence": last_use,
    }


def skill_metadata_summary() -> dict[str, Any]:
    """Reuse skill_metadata_inventory_probe for skill count + byte estimates."""
    try:
        report = build_skill_report()
    except Exception as exc:  # fail-closed: typed error, no silent empty
        return {"status": "skill_inventory_error", "_error": f"{type(exc).__name__}: {exc}"}
    skills = report.get("skills") if isinstance(report.get("skills"), list) else []
    total_body_bytes = 0
    total_desc_chars = 0
    for row in skills:
        if not isinstance(row, dict):
            continue
        total_body_bytes += int(row.get("body_bytes") or 0)
        total_desc_chars += int(row.get("description_chars") or 0)
    return {
        "status": "ok",
        "skill_count": len(skills),
        "skill_body_bytes_total": total_body_bytes,
        "skill_description_chars_total": total_desc_chars,
    }


def build_report(
    schema_artifact: Path | None = None,
    tool_artifact: Path | None = None,
) -> dict[str, Any]:
    servers, config_errors = collect_config_tools()

    schema_by_name: dict[str, dict[str, Any]] = {}
    schema_status: dict[str, Any] = {"schema_artifact_status": "not_provided"}
    if schema_artifact is not None:
        schema_by_name, schema_status = load_schema_artifact(schema_artifact)

    observed_by_name: dict[str, dict[str, Any]] = {}
    tool_status: dict[str, Any] = {"tool_artifact_status": "not_provided"}
    if tool_artifact is not None:
        observed_by_name, tool_status = load_tool_artifact(tool_artifact)

    rows = build_tool_rows(servers, schema_by_name, observed_by_name)

    # Byte totals BY SOURCE CLASS. Static-only tools never contribute bytes and
    # are counted as unknown instead (never collapsed to zero).
    known_bytes_by_class: dict[str, int] = {}
    unknown_schema_count = 0
    non_dict_schema_count = 0
    reclaimable_bytes = 0
    for row in rows:
        sb = row["schema_bytes"]
        if row["schema_status"] == "non_dict_schema":
            non_dict_schema_count += 1
            unknown_schema_count += 1
            continue
        if sb is None:
            unknown_schema_count += 1
            continue
        cls = row["schema_source_class"]
        known_bytes_by_class[cls] = known_bytes_by_class.get(cls, 0) + int(sb)
        # Reclaimable ONLY when bytes are known AND defer-eligibility is a proven
        # True (from observed state) — NOT the "unproven_no_observed_state" sentinel
        # and NOT an unknown_review_required side-effect class (excluded regardless
        # of observed state). `defer_eligible is True` rejects the truthy string.
        if (row["defer_eligible"] is True
                and row["side_effect_class"] != UNKNOWN_SIDE_EFFECT):
            reclaimable_bytes += int(sb)

    skill_meta = skill_metadata_summary()

    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": (
            "metadata-only tool/skill schema budget; emits tool names + name hashes, "
            "schema byte counts (only from a supplied schema artifact), arg field counts, "
            "source/side-effect/defer classes, cache-mutation-risk labels, and skill byte "
            "estimates; does NOT emit argument values, auth material, raw schemas, or "
            "tool/skill descriptions"
        ),
        "proof_class": (
            "static_config_only" if schema_artifact is None
            else "static_config_plus_offline_schema_artifact"
        ),
        "summary": {
            "configured_server_count": len(servers),
            "tool_row_count": len(rows),
            "skill_count": skill_meta.get("skill_count"),
            "known_schema_bytes_by_source_class": dict(sorted(known_bytes_by_class.items())),
            "known_schema_bytes_total": sum(known_bytes_by_class.values()),
            "unknown_schema_count": unknown_schema_count,
            "non_dict_schema_count": non_dict_schema_count,
            "defer_eligible_count": sum(1 for r in rows if r["defer_eligible"] is True),
            "defer_unproven_no_observed_state_count": sum(
                1 for r in rows if r["defer_eligible"] == "unproven_no_observed_state"),
            "unknown_side_effect_count": sum(
                1 for r in rows if r["side_effect_class"] == UNKNOWN_SIDE_EFFECT),
            "reclaimable_bytes_if_deferred_known_only": reclaimable_bytes,
        },
        "schema_artifact_status": schema_status,
        "tool_artifact_status": tool_status,
        "config_source_errors": config_errors,
        "skill_metadata": skill_meta,
        "hot_tool_allowlist": sorted(HOT_TOOL_ALLOWLIST),
        "tools": rows,
        "limitations": [
            "No schema-byte reclaim claim is made from static local config alone; "
            "static-config tools carry schema_source_class=static_config_only and schema_bytes=null.",
            "Schema bytes are counted only from a caller-supplied schema artifact "
            "(MCP tools/list or init-tool capture), never inferred.",
            "Active-vs-deferred and last-use evidence require a caller-supplied tool artifact; "
            "without it, observed state is unknown and defer-eligibility is advisory.",
            "Deferring an always-loaded/hot tool is a cache-reset boundary; reclaimable bytes "
            "are advisory, not automatically safe (see cache_mutation_risk per tool).",
            "defer_eligible REQUIRES an observed active/deferred state from a tool artifact; "
            "without one it is 'unproven_no_observed_state' (never True) and the tool contributes "
            "0 to reclaimable bytes — a name heuristic is not a measurement (invariant 2).",
            "The reused name heuristic returns likely_read_or_compute as a catch-all DEFAULT; "
            "when it fires for an ambiguous/mutation-capable verb (e.g. query_*), A2 records "
            "unknown_review_required and excludes the tool from reclaimable bytes regardless of "
            "observed state (unknown is never collapsed to safe/read).",
            "unknown_schema_count is never collapsed to zero.",
        ],
        "verdict": (
            "static_inventory_only" if schema_artifact is None
            else "schema_byte_budget_landed_from_artifact"
        ),
    }
    return redact(report)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--schema-artifact", default=None,
                        help="Caller-supplied MCP tools/list or init-tool schema artifact (offline).")
    parser.add_argument("--tool-artifact", default=None,
                        help="Caller-supplied init/tool-table capture for active-vs-deferred + last-use.")
    args = parser.parse_args()
    schema_artifact = Path(args.schema_artifact) if args.schema_artifact else None
    tool_artifact = Path(args.tool_artifact) if args.tool_artifact else None
    report = build_report(schema_artifact=schema_artifact, tool_artifact=tool_artifact)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
