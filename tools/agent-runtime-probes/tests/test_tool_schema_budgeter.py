#!/usr/bin/env python3
"""Tests for tool_schema_budgeter: schema-byte provenance, defer rule, artifacts,
redaction, determinism, and CLI e2e.

No pytest fixtures. Helpers are monkeypatched via manual setattr + try/finally so
the probe never reads live local config or spawns an MCP server. The CLI test runs
the probe as a real subprocess to cover the __main__ entrypoint.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tool_schema_budgeter as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "tool_schema_budgeter.py"

# A deterministic configured-server fixture (shape from mcp_schema_inventory_probe).
SERVERS = [
    {"harness": "codex", "server": "pinecone"},
    {"harness": "claude", "server": "read"},          # hot tool
    {"harness": "claude", "server": "delete-thing"},  # side-effecting
]

# A schema artifact carrying a real inputSchema -> bytes countable.
SCHEMA_ARTIFACT = {
    "tools": [
        {"name": "pinecone", "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "topK": {"type": "integer"}},
            "required": ["query"],
        }},
        {"name": "non_dict_tool", "inputSchema": "not-a-dict"},
    ]
}

TOOL_ARTIFACT_LINES = [
    {"name": "pinecone", "active": True, "last_use": "2026-06-15T00:00:00Z"},
    {"name": "delete-thing", "deferred": True},
]

SKILL_REPORT = {"skills": [
    {"body_bytes": 100, "description_chars": 50},
    {"body_bytes": 200, "description_chars": 60},
]}


def _patch_collectors():
    """Return a restore() closure after patching all live-touching helpers."""
    orig = (probe.collect_codex, probe.collect_opencode,
            probe.collect_claude_plugin_mcp, probe.build_skill_report)
    probe.collect_codex = lambda: [s for s in SERVERS if s["harness"] == "codex"]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: [s for s in SERVERS if s["harness"] == "claude"]
    probe.build_skill_report = lambda: SKILL_REPORT

    def restore():
        (probe.collect_codex, probe.collect_opencode,
         probe.collect_claude_plugin_mcp, probe.build_skill_report) = orig
    return restore


def _write(tmp, name, obj, jsonl=False):
    p = Path(tmp) / name
    if jsonl:
        p.write_text("\n".join(json.dumps(o) for o in obj))
    else:
        p.write_text(json.dumps(obj))
    return p


def test_static_config_only_has_null_schema_bytes():
    restore = _patch_collectors()
    try:
        report = probe.build_report()
    finally:
        restore()
    assert report["schema"] == "agent-runtime-tool-schema-budgeter"
    assert report["proof_class"] == "static_config_only"
    by_name = {r["name"]: r for r in report["tools"]}
    # Every static-config tool: null bytes + static_config_only class.
    for name in ("pinecone", "read", "delete-thing"):
        assert by_name[name]["schema_bytes"] is None
        assert by_name[name]["schema_source_class"] == "static_config_only"
    # unknown count must equal the static tool count, never collapsed to zero.
    assert report["summary"]["unknown_schema_count"] == 3
    assert report["summary"]["known_schema_bytes_total"] == 0
    assert report["summary"]["reclaimable_bytes_if_deferred_known_only"] == 0


def test_hot_tool_never_defer_eligible_and_cache_risk_flagged():
    restore = _patch_collectors()
    try:
        report = probe.build_report()
    finally:
        restore()
    read_row = next(r for r in report["tools"] if r["name"] == "read")
    assert read_row["defer_eligible"] is False
    assert read_row["defer_reason"] == "hot_tool_allowlist"
    assert "cache" in read_row["cache_mutation_risk"]


def test_schema_artifact_counts_bytes_and_excludes_non_dict():
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", SCHEMA_ARTIFACT)
            report = probe.build_report(schema_artifact=sa)
    finally:
        restore()
    by_name = {r["name"]: r for r in report["tools"]}
    pine = by_name["pinecone"]
    assert pine["schema_source_class"] == "offline_schema_artifact"
    assert isinstance(pine["schema_bytes"], int) and pine["schema_bytes"] > 0
    assert pine["arg_field_count"] == 2
    # non-dict schema excluded from byte totals, counted as unknown.
    nd = by_name["non_dict_tool"]
    assert nd["schema_status"] == "non_dict_schema"
    assert nd["schema_bytes"] is None
    assert report["summary"]["non_dict_schema_count"] == 1
    assert report["summary"]["known_schema_bytes_by_source_class"].get(
        "offline_schema_artifact", 0) == pine["schema_bytes"]
    assert report["proof_class"] == "static_config_plus_offline_schema_artifact"


def test_tool_artifact_sets_active_deferred_and_last_use():
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = _write(tmp, "tools.jsonl", TOOL_ARTIFACT_LINES, jsonl=True)
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    by_name = {r["name"]: r for r in report["tools"]}
    assert by_name["pinecone"]["always_loaded_vs_deferred"] == "always_loaded"
    assert by_name["pinecone"]["last_use_evidence"] == "observed"
    assert by_name["delete-thing"]["always_loaded_vs_deferred"] == "deferred"


def test_reclaimable_only_from_known_bytes_and_deferrable():
    # A low-side-effect, deferred, known-bytes tool should be reclaimable.
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"tools": [
                {"name": "pinecone", "inputSchema": {"type": "object", "properties": {}}},
            ]})
            ta = _write(tmp, "tools.jsonl", [
                {"name": "pinecone", "deferred": True},
            ], jsonl=True)
            report = probe.build_report(schema_artifact=sa, tool_artifact=ta)
    finally:
        restore()
    pine = next(r for r in report["tools"] if r["name"] == "pinecone")
    assert pine["defer_eligible"] is True
    assert pine["schema_bytes"] is not None
    assert report["summary"]["reclaimable_bytes_if_deferred_known_only"] == pine["schema_bytes"]


def test_malformed_schema_artifact_yields_typed_error():
    # UNHAPPY: malformed schema artifact -> typed _error, no byte claims.
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text("{not valid json")
            report = probe.build_report(schema_artifact=bad)
    finally:
        restore()
    status = report["schema_artifact_status"]
    assert status["schema_artifact_status"] == "invalid"
    assert status["error_type"] == "malformed_input"
    assert report["summary"]["known_schema_bytes_total"] == 0


def test_missing_tool_artifact_reports_missing_error():
    # UNHAPPY: missing tool artifact path -> typed missing/input_error marker.
    restore = _patch_collectors()
    try:
        report = probe.build_report(tool_artifact=Path("/nonexistent-xyz/tools.jsonl"))
    finally:
        restore()
    status = report["tool_artifact_status"]
    assert status["tool_artifact_status"] == "missing"
    assert status["error_type"] == "missing_input"


def test_collector_error_is_typed_not_silent():
    # UNHAPPY: a collector raising must surface a typed config_source_error.
    orig = probe.collect_codex
    probe.collect_codex = lambda: (_ for _ in ()).throw(ValueError("boom"))
    restore = _patch_collectors()
    # _patch_collectors overrode collect_codex; re-break it after patching.
    probe.collect_codex = lambda: (_ for _ in ()).throw(ValueError("boom"))
    try:
        report = probe.build_report()
    finally:
        restore()
        probe.collect_codex = orig
    errs = report["config_source_errors"]
    assert any(e["source"] == "codex" and "ValueError" in e["_error"] for e in errs)


def test_secret_shaped_value_is_suppressed_in_report():
    # Redaction: a secret-shaped tool name must not survive verbatim in the report.
    secret = "sk-ABCDEF0123456789ABCDEF"
    restore = _patch_collectors()
    probe.collect_claude_plugin_mcp = lambda: [{"harness": "claude", "server": secret}]
    try:
        report = probe.build_report()
    finally:
        restore()
    blob = json.dumps(report)
    assert secret not in blob


def test_determinism_two_builds_identical():
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", SCHEMA_ARTIFACT)
            ta = _write(tmp, "tools.jsonl", TOOL_ARTIFACT_LINES, jsonl=True)
            r1 = probe.build_report(schema_artifact=sa, tool_artifact=ta)
            r2 = probe.build_report(schema_artifact=sa, tool_artifact=ta)
    finally:
        restore()
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


def test_skill_metadata_error_is_typed():
    # UNHAPPY: skill inventory raising -> typed error, not silent empty.
    restore = _patch_collectors()
    probe.build_skill_report = lambda: (_ for _ in ()).throw(RuntimeError("skill boom"))
    try:
        report = probe.build_report()
    finally:
        restore()
    assert report["skill_metadata"]["status"] == "skill_inventory_error"
    assert "RuntimeError" in report["skill_metadata"]["_error"]


def test_collector_returns_non_list_is_typed_error():
    # UNHAPPY: a collector returning a non-list -> typed collector_error, not silent.
    restore = _patch_collectors()
    probe.collect_opencode = lambda: {"not": "a list"}  # type: ignore
    try:
        report = probe.build_report()
    finally:
        restore()
    errs = report["config_source_errors"]
    assert any(e["source"] == "opencode" and e["_error"] == "collector_returned_non_list"
               for e in errs)


def test_schema_artifact_bare_list_and_schema_key_fallback():
    # Bare-list artifact + a tool using the `schema` key (not inputSchema).
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "alpha"}]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", [
                {"name": "alpha", "schema": {"type": "object", "properties": {"x": {}}}},
            ])
            report = probe.build_report(schema_artifact=sa)
    finally:
        restore()
    alpha = next(r for r in report["tools"] if r["name"] == "alpha")
    assert alpha["schema_source_class"] == "offline_schema_artifact"
    assert alpha["arg_field_count"] == 1


def test_schema_artifact_unsupported_shape_is_typed():
    # UNHAPPY: a schema artifact whose JSON has no tools list -> unsupported_shape.
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"no_tools_here": True})
            report = probe.build_report(schema_artifact=sa)
    finally:
        restore()
    status = report["schema_artifact_status"]
    assert status["schema_artifact_status"] == "unsupported_shape"
    assert status["error_type"] == "unsupported_shape"


def test_missing_schema_artifact_path_is_typed_missing():
    # UNHAPPY: schema artifact path absent -> typed missing marker.
    restore = _patch_collectors()
    try:
        report = probe.build_report(schema_artifact=Path("/nonexistent-xyz/schema.json"))
    finally:
        restore()
    status = report["schema_artifact_status"]
    assert status["schema_artifact_status"] == "missing"
    assert status["error_type"] == "missing_input"


def test_tool_artifact_init_envelope_and_result_tools():
    # Init-envelope tool tables: top-level tools list AND nested result.tools.
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = _write(tmp, "init.json", {
                "tools": ["bare_tool", {"name": "obj_tool"}],
                "result": {"tools": [{"name": "nested_tool"}, "nested_bare"]},
            })
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    names = {r["name"] for r in report["tools"]}
    # These come ONLY from the tool artifact (tool_artifact_only source class).
    assert {"bare_tool", "obj_tool", "nested_tool", "nested_bare"} <= names
    to = next(r for r in report["tools"] if r["name"] == "obj_tool")
    assert to["source_class"] == "tool_artifact_only"
    assert to["always_loaded_vs_deferred"] == "always_loaded"
    assert to["last_use_evidence"] == "present_in_capture"


def test_empty_tool_artifact_is_typed_unsupported():
    # UNHAPPY: empty tool artifact -> unsupported_shape, not silent ok.
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = Path(tmp) / "empty.jsonl"
            ta.write_text("   \n")
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    status = report["tool_artifact_status"]
    assert status["tool_artifact_status"] == "unsupported_shape"


def test_all_bad_jsonl_tool_artifact_is_typed_invalid():
    # UNHAPPY: tool artifact with only malformed JSONL lines -> invalid marker.
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = Path(tmp) / "bad.jsonl"
            ta.write_text("{nope\n{also bad\n")
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    status = report["tool_artifact_status"]
    assert status["tool_artifact_status"] == "invalid"
    assert status["error_type"] == "malformed_input"
    assert status["invalid_json_lines"] == 2


def test_active_side_effecting_tool_not_defer_eligible():
    # An observed-active side-effecting tool is advisory NOT eligible (line 292 path).
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: [{"harness": "claude", "server": "send-mail"}]
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = _write(tmp, "tools.jsonl", [{"name": "send-mail", "active": True}], jsonl=True)
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    row = next(r for r in report["tools"] if r["name"] == "send-mail")
    assert row["defer_eligible"] is False
    assert row["defer_reason"] == "observed_active_with_side_effect"
    assert row["side_effect_class"] != "likely_read_or_compute"


def test_schema_artifact_non_object_raw_is_unsupported():
    # UNHAPPY: schema artifact JSON is a scalar (not dict/list) -> unsupported_shape.
    restore = _patch_collectors()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = Path(tmp) / "scalar.json"
            sa.write_text("42")
            report = probe.build_report(schema_artifact=sa)
    finally:
        restore()
    assert report["schema_artifact_status"]["schema_artifact_status"] == "unsupported_shape"


def test_schema_artifact_skips_non_dict_and_nameless_tools():
    # Tools that are non-dict or lack a name are skipped from the schema map.
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "real"}]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"tools": [
                "not-a-dict-tool",
                {"inputSchema": {"type": "object"}},  # no name
                {"name": "real", "inputSchema": {"type": "object", "properties": {}}},
            ]})
            report = probe.build_report(schema_artifact=sa)
    finally:
        restore()
    real = next(r for r in report["tools"] if r["name"] == "real")
    assert real["schema_source_class"] == "offline_schema_artifact"
    assert report["schema_artifact_status"]["tool_count_in_artifact"] == 1


def test_tool_artifact_json_list_and_blank_jsonl_lines():
    # Whole-doc JSON list form + blank-line skipping in the JSONL fallback.
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = _write(tmp, "list.json", [{"name": "listed", "active": True}])
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    assert any(r["name"] == "listed" for r in report["tools"])


def test_tool_artifact_last_used_key_variant_and_blank_lines():
    # The `last_used`-only key variant registers last-use evidence (state-keying
    # short-circuit), and blank JSONL lines between records are skipped.
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = Path(tmp) / "tools.jsonl"
            ta.write_text(
                json.dumps({"name": "lu", "last_used": "2026-06-15"}) + "\n"
                + "\n"  # blank line between records -> must be skipped
                + json.dumps({"name": "other", "active": False}) + "\n"
            )
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    row = next(r for r in report["tools"] if r["name"] == "lu")
    assert row["last_use_evidence"] == "observed"
    assert row["always_loaded_vs_deferred"] == "deferred"  # active absent -> not active


def test_duplicate_server_across_harness_deduped():
    # Two config sources advertising the same (harness, name) dedupe to one row.
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "dup"}]
    probe.collect_opencode = lambda: [{"harness": "codex", "server": "dup"}]
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        report = probe.build_report()
    finally:
        restore()
    dup_rows = [r for r in report["tools"] if r["name"] == "dup"]
    assert len(dup_rows) == 1


def test_skill_metadata_skips_non_dict_rows():
    # A skill report with a non-dict row must be skipped, not crash.
    restore = _patch_collectors()
    probe.build_skill_report = lambda: {"skills": ["not-a-dict", {"body_bytes": 10, "description_chars": 5}]}
    try:
        report = probe.build_report()
    finally:
        restore()
    assert report["skill_metadata"]["skill_count"] == 2
    assert report["skill_metadata"]["skill_body_bytes_total"] == 10


def test_cli_entrypoint_emits_valid_json():
    # e2e: covers __main__ + json.dump path. Real config read is fine (offline).
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--pretty"],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-tool-schema-budgeter"
    assert "tools" in report and "summary" in report
    assert report["summary"]["unknown_schema_count"] >= 0


def test_cli_with_artifacts_subprocess():
    # e2e with both artifacts through the CLI flags.
    with tempfile.TemporaryDirectory() as tmp:
        sa = _write(tmp, "schema.json", SCHEMA_ARTIFACT)
        ta = _write(tmp, "tools.jsonl", TOOL_ARTIFACT_LINES, jsonl=True)
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH),
             "--schema-artifact", str(sa), "--tool-artifact", str(ta)],
            capture_output=True, text=True, timeout=60,
        )
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report["proof_class"] == "static_config_plus_offline_schema_artifact"
    assert report["schema_artifact_status"]["schema_artifact_status"] == "ok"


def test_main_function_direct_invocation():
    # Cover main() with mocked argv via sys.argv swap (offline default path).
    orig_argv = sys.argv
    sys.argv = [str(PROBE_PATH)]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-tool-schema-budgeter"


def test_no_observed_state_blocks_defer_and_reclaimable():
    # F4 regression (a): schema artifact present but NO tool artifact -> every tool
    # with observed_state None must be defer_eligible "unproven_no_observed_state"
    # (never True) and contribute 0 to reclaimable bytes (invariant 2: no verdict
    # from non-measured data; a name heuristic is not an observed state).
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "pinecone"}]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            # pinecone has known, countable schema bytes...
            sa = _write(tmp, "schema.json", {"tools": [
                {"name": "pinecone", "inputSchema": {"type": "object", "properties": {}}},
            ]})
            # ...but NO --tool-artifact, so observed_state stays None.
            report = probe.build_report(schema_artifact=sa)
    finally:
        restore()
    pine = next(r for r in report["tools"] if r["name"] == "pinecone")
    assert pine["always_loaded_vs_deferred"] == "unknown"
    assert pine["defer_eligible"] == "unproven_no_observed_state"
    assert pine["defer_eligible"] is not True
    assert pine["schema_bytes"] is not None and pine["schema_bytes"] > 0
    # Despite known bytes, no observed state => excluded from reclaimable.
    assert report["summary"]["reclaimable_bytes_if_deferred_known_only"] == 0
    assert report["summary"]["defer_eligible_count"] == 0
    # Every no-observed-state tool is accounted as unproven, never as eligible.
    for r in report["tools"]:
        if r["always_loaded_vs_deferred"] == "unknown":
            assert r["defer_eligible"] is not True
    assert report["summary"]["defer_unproven_no_observed_state_count"] >= 1


def test_ambiguous_verb_tool_is_unknown_side_effect_not_read():
    # F4 regression (b): a tool named `query_records` lands in the base heuristic's
    # read/compute DEFAULT (no destructive substring), but query-tools may mutate.
    # A2 must record unknown_review_required (NOT likely_read_or_compute) and
    # exclude it from reclaimable bytes even WITH an observed deferred state.
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "query_records"}]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"tools": [
                {"name": "query_records", "inputSchema": {"type": "object", "properties": {}}},
            ]})
            # Provide an observed deferred state to prove the exclusion holds
            # REGARDLESS of observed state (not just because state is missing).
            ta = _write(tmp, "tools.jsonl", [
                {"name": "query_records", "deferred": True},
            ], jsonl=True)
            report = probe.build_report(schema_artifact=sa, tool_artifact=ta)
    finally:
        restore()
    # Base heuristic alone would call this read/compute; A2 must not trust it.
    from mcp_schema_inventory_probe import side_effect_class_for_tool
    assert side_effect_class_for_tool("query_records") == "likely_read_or_compute"
    qr = next(r for r in report["tools"] if r["name"] == "query_records")
    assert qr["side_effect_class"] == "unknown_review_required"
    assert qr["side_effect_class"] != "likely_read_or_compute"
    assert qr["defer_eligible"] is False
    assert qr["false_trigger_risk"] != "low"
    # Excluded from reclaimable despite known bytes AND an observed deferred state.
    assert qr["schema_bytes"] is not None and qr["schema_bytes"] > 0
    assert report["summary"]["reclaimable_bytes_if_deferred_known_only"] == 0
    assert report["summary"]["unknown_side_effect_count"] == 1


def test_jsonl_valid_non_dict_lines_skipped_not_error():
    # UNHAPPY: a JSONL artifact where some valid-JSON lines are non-dict scalars
    # (e.g. 42 or "string") must be silently skipped — only dict objects count.
    # Exercises _iter_artifact_lines L258: `if isinstance(obj, dict)` being False
    # for a parsed-but-non-dict value in the JSONL fallback path.
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = Path(tmp) / "mixed.jsonl"
            # Three lines: one valid dict, two valid-JSON non-dicts (scalar + list)
            ta.write_text(
                json.dumps({"name": "real_tool", "active": True}) + "\n"
                + "42\n"
                + json.dumps(["not", "a", "dict"]) + "\n"
            )
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    # The only real tool row from the artifact should be "real_tool"
    names = {r["name"] for r in report["tools"]}
    assert "real_tool" in names
    # Artifact was processed successfully despite non-dict lines
    assert report["tool_artifact_status"]["tool_artifact_status"] == "ok"
    assert report["tool_artifact_status"]["observed_tool_count"] == 1


def test_tool_artifact_last_use_ts_key_variant():
    # Exercises the `last_use_ts` fallback key in load_tool_artifact L308.
    # The or-chain is: last_use or last_used or last_use_ts; this tests the
    # third variant reaching observed last-use evidence.
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = _write(tmp, "tools.jsonl", [
                {"name": "ts_tool", "active": True, "last_use_ts": "2026-06-16T00:00:00Z"},
            ], jsonl=True)
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    row = next(r for r in report["tools"] if r["name"] == "ts_tool")
    assert row["last_use_evidence"] == "observed"
    assert row["always_loaded_vs_deferred"] == "always_loaded"


def test_tool_artifact_deferred_false_marks_active():
    # UNHAPPY edge: `deferred=False` with active absent means active=not(False)=True.
    # Exercises load_tool_artifact L305-306 branch where active is None and
    # deferred is not None; deferred=False flips to active=True.
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ta = _write(tmp, "tools.jsonl", [
                {"name": "flip_tool", "deferred": False},  # active=None => active=not(False)=True
            ], jsonl=True)
            report = probe.build_report(tool_artifact=ta)
    finally:
        restore()
    row = next(r for r in report["tools"] if r["name"] == "flip_tool")
    assert row["always_loaded_vs_deferred"] == "always_loaded"


def test_defer_eligibility_active_low_side_effect_is_advisory_eligible():
    # Exercises defer_eligibility L365-368 path: observed_state=="active" AND
    # low_side_effect → defer_eligible=True, reason=observed_active_advisory,
    # cache_mutation_risk warns about resetting cache (medium risk).
    # This is distinct from the side-effecting active path (which gives False).
    result = probe.defer_eligibility("some_reader", probe.READ_OR_COMPUTE, "active")
    assert result["defer_eligible"] is True
    assert result["defer_reason"] == "observed_active_advisory"
    assert "cache" in result["cache_mutation_risk"]
    assert "medium" in result["cache_mutation_risk"]


def test_defer_eligibility_deferred_side_effecting_is_not_eligible():
    # Exercises defer_eligibility L374-376: observed_state=="deferred" AND
    # side_effect_class != READ_OR_COMPUTE → defer_eligible=False,
    # reason=side_effecting_tool_review_required, low cache risk.
    result = probe.defer_eligibility("send_mail", "browser_or_stateful", "deferred")
    assert result["defer_eligible"] is False
    assert result["defer_reason"] == "side_effecting_tool_review_required"
    assert "low" in result["cache_mutation_risk"]


def test_skill_metadata_non_list_skills_treated_as_empty():
    # UNHAPPY: build_skill_report returns a dict whose "skills" key is not a list
    # → skill_metadata_summary treats it as empty; skill_count=0, bytes=0.
    # Exercises skill_metadata_summary L498: not isinstance(skills, list) → skills=[].
    restore = _patch_collectors()
    probe.build_skill_report = lambda: {"skills": "not-a-list"}
    try:
        report = probe.build_report()
    finally:
        restore()
    assert report["skill_metadata"]["status"] == "ok"
    assert report["skill_metadata"]["skill_count"] == 0
    assert report["skill_metadata"]["skill_body_bytes_total"] == 0


def test_skill_metadata_missing_skills_key_treated_as_empty():
    # UNHAPPY: build_skill_report returns a dict with no "skills" key at all
    # → skill_metadata_summary treats it as empty (report.get("skills") is None).
    restore = _patch_collectors()
    probe.build_skill_report = lambda: {}
    try:
        report = probe.build_report()
    finally:
        restore()
    assert report["skill_metadata"]["status"] == "ok"
    assert report["skill_metadata"]["skill_count"] == 0


def test_build_tool_rows_schema_artifact_only_source_class():
    # A tool present in schema artifact but absent from any configured server
    # must get source_class="schema_artifact_only" (build_tool_rows L411-416).
    restore = _patch_collectors()
    probe.collect_codex = lambda: []
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"tools": [
                {"name": "artifact_only_tool",
                 "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}}},
            ]})
            report = probe.build_report(schema_artifact=sa)
    finally:
        restore()
    row = next(r for r in report["tools"] if r["name"] == "artifact_only_tool")
    assert row["source_class"] == "schema_artifact_only"
    assert row["schema_source_class"] == "offline_schema_artifact"
    assert isinstance(row["schema_bytes"], int) and row["schema_bytes"] > 0


def test_active_low_side_effect_tool_reclaimable_from_report():
    # Integration: low-side-effect + observed active + known bytes → defer_eligible=True,
    # advisory reason; bytes enter reclaimable pool (medium cache risk noted).
    # Covers build_report aggregation path when defer_eligible is True via active state.
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "fetch_data"}]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"tools": [
                {"name": "fetch_data",
                 "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}}},
            ]})
            ta = _write(tmp, "tools.jsonl", [
                {"name": "fetch_data", "active": True},
            ], jsonl=True)
            report = probe.build_report(schema_artifact=sa, tool_artifact=ta)
    finally:
        restore()
    row = next(r for r in report["tools"] if r["name"] == "fetch_data")
    assert row["defer_eligible"] is True
    assert row["defer_reason"] == "observed_active_advisory"
    assert row["schema_bytes"] is not None and row["schema_bytes"] > 0
    # Reclaimable bytes are counted because defer_eligible is True
    assert report["summary"]["reclaimable_bytes_if_deferred_known_only"] == row["schema_bytes"]
    assert report["summary"]["defer_eligible_count"] == 1


def test_deferred_side_effecting_tool_not_in_reclaimable():
    # Integration: side-effecting + observed deferred + known bytes → defer_eligible=False,
    # side_effecting_tool_review_required; bytes NOT in reclaimable pool.
    # Covers the deferred+side-effecting branch of defer_eligibility in a full report.
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "drop_table"}]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"tools": [
                {"name": "drop_table",
                 "inputSchema": {"type": "object", "properties": {"table": {"type": "string"}}}},
            ]})
            ta = _write(tmp, "tools.jsonl", [
                {"name": "drop_table", "deferred": True},
            ], jsonl=True)
            report = probe.build_report(schema_artifact=sa, tool_artifact=ta)
    finally:
        restore()
    row = next(r for r in report["tools"] if r["name"] == "drop_table")
    assert row["defer_eligible"] is False
    assert row["defer_reason"] == "side_effecting_tool_review_required"
    assert row["schema_bytes"] is not None and row["schema_bytes"] > 0
    # Not reclaimable despite known bytes, because side-effecting
    assert report["summary"]["reclaimable_bytes_if_deferred_known_only"] == 0


def test_cli_missing_schema_artifact_flag_yields_missing_status():
    # e2e UNHAPPY: pass a nonexistent path via --schema-artifact; expect missing status
    # in the JSON output (not a crash). Covers CLI parse + error propagation path.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH),
         "--schema-artifact", "/nonexistent-xyz/schema.json"],
        capture_output=True, text=True, timeout=30,
        stdin=subprocess.DEVNULL,
    )
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report["schema_artifact_status"]["schema_artifact_status"] == "missing"
    assert report["schema_artifact_status"]["error_type"] == "missing_input"


def test_determinism_active_low_side_effect_path():
    # Determinism test for the active+low-side-effect reclaimable path specifically.
    restore = _patch_collectors()
    probe.collect_codex = lambda: [{"harness": "codex", "server": "get_data"}]
    probe.collect_opencode = lambda: []
    probe.collect_claude_plugin_mcp = lambda: []
    try:
        with tempfile.TemporaryDirectory() as tmp:
            sa = _write(tmp, "schema.json", {"tools": [
                {"name": "get_data",
                 "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}}},
            ]})
            ta = _write(tmp, "tools.jsonl", [
                {"name": "get_data", "active": True, "last_use_ts": "2026-06-16T00:00:00Z"},
            ], jsonl=True)
            r1 = probe.build_report(schema_artifact=sa, tool_artifact=ta)
            r2 = probe.build_report(schema_artifact=sa, tool_artifact=ta)
    finally:
        restore()
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} tool_schema_budgeter tests passed")
