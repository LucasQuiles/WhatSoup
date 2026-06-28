#!/usr/bin/env python3
"""Tests for metadata-only instruction budget auditor output."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import instruction_budget_auditor as aud  # noqa: E402
from instruction_budget_auditor import (  # noqa: E402
    InstructionSurface,
    build_findings,
    build_report,
    codex_config_status_rows,
    default_codex_config_paths,
    default_instruction_surfaces,
    embedded_codex_instruction_rows,
    estimate_tokens,
    instruction_file_rows,
    parse_args,
    path_class,
)
from skill_metadata_inventory_probe import SkillRoot  # noqa: E402


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def fixture_surfaces(root: Path) -> tuple[list[InstructionSurface], list[Path], list[SkillRoot]]:
    instructions = root / "instructions"
    codex = root / ".codex"
    skills = root / "skills"
    write(
        instructions / "AGENTS.md",
        "# Fixture Instructions\n\nUse canary-must-not-leak for nothing. Unique instruction phrase must never leak.\n",
    )
    write(
        instructions / "CLAUDE.md",
        "# Fixture Claude\n\nKeep output short and never print pcsk_secretshouldnotleak.\n",
    )
    write(
        codex / "config.toml",
        'model_context_window = 100000\n'
        'developer_instructions = """\n'
        "Never dump ghp_abcdefghijklmnopqrstuvwxyz1234567890 or this developer phrase.\n"
        '"""\n',
    )
    write(
        skills / "narrow/SKILL.md",
        """---
name: narrow-budget
description: "Use when creating a small budget report. Do not use when runtime activation proof is needed."
---

Body says sk-bodysecretshouldnotleak and should be suppressed.
""",
    )
    write(
        skills / "wide/SKILL.md",
        """---
name: wide-budget
description: "Use when you need to analyze, review, optimize, and improve multiple workflows across everything."
---

Another body.
""",
    )
    surfaces = [
        InstructionSurface(
            path=instructions / "AGENTS.md",
            harness="codex",
            surface="instruction",
            load_mode="always_on_candidate",
            loaded_by="fixture loader",
            evidence="fixture",
        ),
        InstructionSurface(
            path=instructions / "CLAUDE.md",
            harness="claude",
            surface="instruction",
            load_mode="always_on_candidate",
            loaded_by="fixture loader",
            evidence="fixture",
        ),
    ]
    return surfaces, [codex / "config.toml"], [
        SkillRoot(skills, "fixture_skills", "codex", "direct_loader_candidate", "fixture skill root"),
    ]


def assert_no_fixture_content(rendered: str, root: Path) -> None:
    for forbidden in [
        str(root),
        "canary-must-not-leak",
        "pcsk_secretshouldnotleak",
        "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        "sk-bodysecretshouldnotleak",
        "Unique instruction phrase",
        "developer phrase",
        "Use when creating a small budget report",
        "Use when you need to analyze",
        "Body says",
    ]:
        assert forbidden not in rendered, forbidden


def test_instruction_budget_auditor_counts_instruction_and_skill_metadata_without_raw_content():
    with tempfile.TemporaryDirectory(prefix="instruction-budget-") as tmp_dir:
        root = Path(tmp_dir)
        surfaces, codex_paths, skill_roots = fixture_surfaces(root)
        report = build_report(
            instruction_surfaces=surfaces,
            codex_config_paths=codex_paths,
            skill_roots=skill_roots,
        )
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "agent-runtime-instruction-budget-auditor", report
        assert report["summary"]["instruction_file_count"] == 2, report
        assert report["summary"]["embedded_config_instruction_count"] == 1, report
        assert report["summary"]["skill_description_count"] == 2, report
        assert report["summary"]["total_candidate_estimated_tokens"] > 0, report
        assert report["skill_description_summary"]["by_trigger_breadth"]["broad"]["count"] == 1, report
        assert report["skill_description_summary"]["by_trigger_breadth"]["narrow"]["count"] == 1, report
        assert_no_fixture_content(rendered, root)


def test_instruction_budget_auditor_rows_emit_hashes_classes_and_top_surfaces():
    with tempfile.TemporaryDirectory(prefix="instruction-budget-") as tmp_dir:
        root = Path(tmp_dir)
        surfaces, codex_paths, skill_roots = fixture_surfaces(root)
        report = build_report(
            instruction_surfaces=surfaces,
            codex_config_paths=codex_paths,
            skill_roots=skill_roots,
        )
        rendered = json.dumps(report, sort_keys=True)
        for row in report["instruction_files"]:
            assert row["path_sha256_16"], row
            assert row["path_basename"] in {"AGENTS.md", "CLAUDE.md"}, row
            assert "path_class" in row, row
            assert row["estimated_tokens"] == estimate_tokens(row["chars"]), row
        assert report["embedded_config_instructions"][0]["config_key"] == "developer_instructions", report
        assert report["top_context_surfaces"], report
        assert_no_fixture_content(rendered, root)


def test_instruction_budget_auditor_marks_malformed_codex_config():
    with tempfile.TemporaryDirectory(prefix="instruction-budget-") as tmp_dir:
        root = Path(tmp_dir)
        config = root / ".codex/config.toml"
        write(config, "[broken")

        report = build_report(
            instruction_surfaces=[],
            codex_config_paths=[config],
            skill_roots=[],
        )

    assert report["summary"]["embedded_config_instruction_count"] == 0, report
    assert report["summary"]["codex_config_status_counts"] == {"error": 1}, report["summary"]
    assert report["codex_config_sources"] == [
        {
            "surface_kind": "codex_config_source",
            "harness": "codex",
            "path_basename": "config.toml",
            "path_class": "outside_home",
            "path_sha256_16": report["codex_config_sources"][0]["path_sha256_16"],
            "status": "error",
            "error_type": "TOMLDecodeError",
            "shape": "error",
        }
    ], report["codex_config_sources"]


def test_instruction_budget_auditor_cli_suppresses_text_and_reports_local_summary():
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "instruction_budget_auditor.py"),
            "--pretty",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert result.stderr == "", result.stderr
    assert report["schema"] == "agent-runtime-instruction-budget-auditor", report
    assert report["summary"]["surface_count"] >= 1, report
    assert "token_estimator" in report, report


# ---------------------------------------------------------------------------
# estimate_tokens edge cases
# ---------------------------------------------------------------------------

def test_estimate_tokens_zero_for_nonpositive():
    assert estimate_tokens(0) == 0
    assert estimate_tokens(-1) == 0
    assert estimate_tokens(-999) == 0


def test_estimate_tokens_ceil_division():
    assert estimate_tokens(1) == 1
    assert estimate_tokens(4) == 1
    assert estimate_tokens(5) == 2
    assert estimate_tokens(8000) == 2000
    assert estimate_tokens(8001) == 2001


# ---------------------------------------------------------------------------
# path_class branches
# ---------------------------------------------------------------------------

def test_path_class_macos_managed_application_support():
    p = Path("/Library/Application Support/ClaudeCode/managed-settings.json")
    assert path_class(p) == "macos_managed_application_support"


def test_path_class_system_etc():
    p = Path("/etc/claude-code/managed-settings.json")
    assert path_class(p) == "system_etc"


def test_path_class_outside_home():
    p = Path("/tmp/some-random-file.txt")
    assert path_class(p) == "outside_home"


def test_path_class_home_root():
    # Path.home() itself has empty rel.parts after relative_to(HOME)
    assert path_class(Path.home()) == "home_root"


def test_path_class_claude_home():
    home = Path.home()
    p = home / ".claude" / "settings.json"
    assert path_class(p) == "claude_home"


def test_path_class_codex_home():
    home = Path.home()
    p = home / ".codex" / "config.toml"
    assert path_class(p) == "codex_home"


def test_path_class_opencode_home():
    home = Path.home()
    p = home / ".config" / "opencode" / "opencode.json"
    assert path_class(p) == "opencode_home"


def test_path_class_whatsoup_project():
    home = Path.home()
    p = home / "LAB" / "WhatSoup" / "src" / "foo.py"
    assert path_class(p) == "whatsoup_project"


def test_path_class_lab_project():
    home = Path.home()
    p = home / "LAB" / "OtherProject" / "foo.py"
    assert path_class(p) == "lab_project"


def test_path_class_home_other():
    home = Path.home()
    p = home / "Documents" / "notes.txt"
    assert path_class(p) == "home_other"


# ---------------------------------------------------------------------------
# default_instruction_surfaces and default_codex_config_paths (live)
# ---------------------------------------------------------------------------

def test_default_instruction_surfaces_returns_only_instruction_surfaces():
    surfaces = default_instruction_surfaces()
    assert isinstance(surfaces, list)
    for s in surfaces:
        assert isinstance(s, InstructionSurface)
        assert s.surface == "instruction"
        assert s.load_mode == "always_on_candidate"


def test_default_codex_config_paths_returns_toml_settings():
    paths = default_codex_config_paths()
    assert isinstance(paths, list)
    # All returned paths should be Path objects (even if they don't exist)
    for p in paths:
        assert isinstance(p, Path)
    # Verify sorted + deduped (no duplicates)
    assert paths == sorted(set(paths))


# ---------------------------------------------------------------------------
# instruction_file_rows: missing file is skipped
# ---------------------------------------------------------------------------

def test_instruction_file_rows_skips_missing_files():
    surface = InstructionSurface(
        path=Path("/nonexistent/does_not_exist.md"),
        harness="test",
        surface="instruction",
        load_mode="always_on_candidate",
        loaded_by="test loader",
        evidence="test",
    )
    rows = instruction_file_rows([surface])
    assert rows == [], "missing file should be silently skipped"


# ---------------------------------------------------------------------------
# embedded_codex_instruction_rows: missing/malformed/absent-key branches
# ---------------------------------------------------------------------------

def test_embedded_codex_instruction_rows_skips_missing_file():
    rows = embedded_codex_instruction_rows([Path("/nonexistent/config.toml")])
    assert rows == []


def test_embedded_codex_instruction_rows_skips_when_key_absent():
    with tempfile.TemporaryDirectory(prefix="iba-") as tmp:
        config = Path(tmp) / "config.toml"
        config.write_text('model_context_window = 100000\n', encoding="utf-8")
        rows = embedded_codex_instruction_rows([config])
    assert rows == [], "no developer_instructions key => no embedded row"


def test_embedded_codex_instruction_rows_skips_when_key_empty_string():
    with tempfile.TemporaryDirectory(prefix="iba-") as tmp:
        config = Path(tmp) / "config.toml"
        config.write_text('developer_instructions = ""\n', encoding="utf-8")
        rows = embedded_codex_instruction_rows([config])
    assert rows == [], "empty developer_instructions => no embedded row"


def test_embedded_codex_instruction_rows_skips_malformed_toml():
    with tempfile.TemporaryDirectory(prefix="iba-") as tmp:
        config = Path(tmp) / "config.toml"
        config.write_text("[broken", encoding="utf-8")
        rows = embedded_codex_instruction_rows([config])
    assert rows == [], "malformed TOML => skipped (not crash)"


def test_embedded_codex_instruction_rows_skips_non_dict_load_toml_return():
    """When load_toml returns a non-dict (e.g. None), the row is skipped (line 146 continue)."""
    orig_load_toml = aud.load_toml
    with tempfile.TemporaryDirectory(prefix="iba-") as tmp:
        config = Path(tmp) / "config.toml"
        config.write_text("# placeholder\n", encoding="utf-8")
        # Patch to return None (non-dict) for an existing file
        aud.load_toml = lambda path: None
        try:
            rows = embedded_codex_instruction_rows([config])
        finally:
            aud.load_toml = orig_load_toml
    assert rows == [], "non-dict load_toml result => skipped"


# ---------------------------------------------------------------------------
# codex_config_status_rows: invalid_shape branch
# ---------------------------------------------------------------------------

def test_codex_config_status_rows_skips_missing_file():
    rows = codex_config_status_rows([Path("/nonexistent/config.toml")])
    assert rows == []


def test_codex_config_status_rows_invalid_shape_when_toml_yields_non_dict():
    # load_toml returns None for missing files, but our coverage target is when
    # load_toml returns a non-dict non-error value. We monkeypatch load_toml.
    import probelib
    orig_load_toml = aud.load_toml

    with tempfile.TemporaryDirectory(prefix="iba-") as tmp:
        config = Path(tmp) / "config.toml"
        config.write_text("# valid file but we intercept\n", encoding="utf-8")

        # Patch load_toml on the auditor module to return a list (invalid shape)
        aud.load_toml = lambda path: [1, 2, 3]
        try:
            rows = codex_config_status_rows([config])
        finally:
            aud.load_toml = orig_load_toml

    assert len(rows) == 1
    assert rows[0]["status"] == "invalid_shape"
    assert rows[0]["error_type"] == "list"
    assert rows[0]["shape"] == "list"


# ---------------------------------------------------------------------------
# build_findings: all finding codes
# ---------------------------------------------------------------------------

def _make_instruction_row(tokens: int, harness: str = "claude", sha: str = "abc123") -> dict:
    return {
        "surface_kind": "instruction_file",
        "harness": harness,
        "path_class": "claude_home",
        "path_basename": "CLAUDE.md",
        "estimated_tokens": tokens,
        "sha256_16": sha,
        "chars": tokens * 4,
    }


def test_build_findings_very_large_instruction_triggers_high_severity():
    row = _make_instruction_row(aud.VERY_LARGE_INSTRUCTION_TOKENS + 1)
    findings = build_findings([row], [], [])
    codes = [f["code"] for f in findings]
    assert "very_large_instruction_surface" in codes
    high_findings = [f for f in findings if f["code"] == "very_large_instruction_surface"]
    assert high_findings[0]["severity"] == "high"
    assert high_findings[0]["evidence"]["estimated_tokens"] == aud.VERY_LARGE_INSTRUCTION_TOKENS + 1
    assert high_findings[0]["evidence"]["threshold_tokens"] == aud.VERY_LARGE_INSTRUCTION_TOKENS


def test_build_findings_large_instruction_triggers_medium_severity():
    row = _make_instruction_row(aud.LARGE_INSTRUCTION_TOKENS + 1)
    findings = build_findings([row], [], [])
    codes = [f["code"] for f in findings]
    assert "large_instruction_surface" in codes
    assert "very_large_instruction_surface" not in codes
    med_findings = [f for f in findings if f["code"] == "large_instruction_surface"]
    assert med_findings[0]["severity"] == "medium"
    assert med_findings[0]["evidence"]["threshold_tokens"] == aud.LARGE_INSTRUCTION_TOKENS


def test_build_findings_small_instruction_triggers_no_finding():
    row = _make_instruction_row(aud.LARGE_INSTRUCTION_TOKENS)  # exactly at threshold, not over
    findings = build_findings([row], [], [])
    codes = [f["code"] for f in findings]
    assert "large_instruction_surface" not in codes
    assert "very_large_instruction_surface" not in codes


def test_build_findings_embedded_row_triggers_very_large():
    # embedded_rows are also checked in build_findings
    embedded = {
        "surface_kind": "embedded_config_instruction",
        "harness": "codex",
        "path_class": "codex_home",
        "path_basename": "config.toml",
        "estimated_tokens": aud.VERY_LARGE_INSTRUCTION_TOKENS + 1,
        "sha256_16": "deadbeef",
        "chars": (aud.VERY_LARGE_INSTRUCTION_TOKENS + 1) * 4,
    }
    findings = build_findings([], [embedded], [])
    codes = [f["code"] for f in findings]
    assert "very_large_instruction_surface" in codes


def test_build_findings_skill_bulk_triggers_when_over_threshold():
    # Build enough skill rows to exceed SKILL_METADATA_BULK_TOKENS
    skill_row = {
        "surface_kind": "skill_description",
        "harness": "claude",
        "estimated_tokens": aud.SKILL_METADATA_BULK_TOKENS + 1,
        "description_chars": (aud.SKILL_METADATA_BULK_TOKENS + 1) * 4,
    }
    findings = build_findings([], [], [skill_row])
    codes = [f["code"] for f in findings]
    assert "skill_description_metadata_bulk" in codes
    bulk_findings = [f for f in findings if f["code"] == "skill_description_metadata_bulk"]
    assert bulk_findings[0]["severity"] == "medium"
    assert bulk_findings[0]["evidence"]["threshold_tokens"] == aud.SKILL_METADATA_BULK_TOKENS


def test_build_findings_skill_bulk_absent_when_under_threshold():
    skill_row = {
        "surface_kind": "skill_description",
        "harness": "claude",
        "estimated_tokens": aud.SKILL_METADATA_BULK_TOKENS,
        "description_chars": aud.SKILL_METADATA_BULK_TOKENS * 4,
    }
    findings = build_findings([], [], [skill_row])
    codes = [f["code"] for f in findings]
    assert "skill_description_metadata_bulk" not in codes


def test_build_findings_duplicate_hash_triggers_finding():
    sha = "deadbeef00000000"
    row1 = _make_instruction_row(100, harness="claude", sha=sha)
    row2 = _make_instruction_row(100, harness="codex", sha=sha)
    findings = build_findings([row1, row2], [], [])
    codes = [f["code"] for f in findings]
    assert "duplicate_instruction_file_hash" in codes
    dup = [f for f in findings if f["code"] == "duplicate_instruction_file_hash"][0]
    assert dup["severity"] == "medium"
    assert dup["evidence"]["surface_count"] == 2
    assert "claude" in dup["evidence"]["harnesses"]
    assert "codex" in dup["evidence"]["harnesses"]


def test_build_findings_no_duplicate_when_unique_hashes():
    row1 = _make_instruction_row(100, sha="aaaa")
    row2 = _make_instruction_row(100, sha="bbbb")
    findings = build_findings([row1, row2], [], [])
    codes = [f["code"] for f in findings]
    assert "duplicate_instruction_file_hash" not in codes


# ---------------------------------------------------------------------------
# parse_args: default flags
# ---------------------------------------------------------------------------

def test_parse_args_defaults():
    orig_argv = sys.argv
    sys.argv = ["instruction_budget_auditor.py"]
    try:
        args = parse_args()
    finally:
        sys.argv = orig_argv
    assert args.pretty is False
    assert args.include_present_only_caches is False


def test_parse_args_pretty_flag():
    orig_argv = sys.argv
    sys.argv = ["instruction_budget_auditor.py", "--pretty"]
    try:
        args = parse_args()
    finally:
        sys.argv = orig_argv
    assert args.pretty is True


def test_parse_args_include_present_only_caches_flag():
    orig_argv = sys.argv
    sys.argv = ["instruction_budget_auditor.py", "--include-present-only-caches"]
    try:
        args = parse_args()
    finally:
        sys.argv = orig_argv
    assert args.include_present_only_caches is True


# ---------------------------------------------------------------------------
# main() function: in-process (covers lines 396-400 and 390-393)
# ---------------------------------------------------------------------------

def test_main_returns_zero_and_emits_valid_json():
    import io
    from contextlib import redirect_stdout
    orig_argv = sys.argv
    sys.argv = ["instruction_budget_auditor.py"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = aud.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-instruction-budget-auditor"
    assert "summary" in report


def test_main_pretty_flag_produces_indented_output():
    import io
    from contextlib import redirect_stdout
    orig_argv = sys.argv
    sys.argv = ["instruction_budget_auditor.py", "--pretty"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = aud.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    output = buf.getvalue()
    # Indented output has newlines + spaces
    assert "\n" in output
    report = json.loads(output)
    assert report["schema"] == "agent-runtime-instruction-budget-auditor"


# ---------------------------------------------------------------------------
# Redaction: raw instruction bodies must never appear in output
# ---------------------------------------------------------------------------

def test_instruction_bodies_never_in_report_output():
    """Verify that raw file content never leaks into the report JSON."""
    with tempfile.TemporaryDirectory(prefix="iba-redact-") as tmp:
        root = Path(tmp)
        sensitive_phrase = "SUPER_SENSITIVE_PHRASE_MUST_NOT_LEAK"
        inst_file = root / "instructions.md"
        inst_file.write_text(f"# Title\n\n{sensitive_phrase}\n", encoding="utf-8")
        surface = InstructionSurface(
            path=inst_file,
            harness="claude",
            surface="instruction",
            load_mode="always_on_candidate",
            loaded_by="test",
            evidence="test",
        )
        report = build_report(
            instruction_surfaces=[surface],
            codex_config_paths=[],
            skill_roots=[],
        )
        rendered = json.dumps(report)
    assert sensitive_phrase not in rendered, "raw instruction text must not appear in report"
    assert str(root) not in rendered, "raw file path must not appear in report"


# ---------------------------------------------------------------------------
# skill_description_rows: None vs [] distinction
# ---------------------------------------------------------------------------

def test_skill_description_rows_empty_list_returns_empty():
    """skill_roots=[] bypasses build_skill_inventory entirely."""
    report = build_report(
        instruction_surfaces=[],
        codex_config_paths=[],
        skill_roots=[],
    )
    assert report["summary"]["skill_description_count"] == 0
    assert report["skill_description_summary"]["count"] == 0


# ---------------------------------------------------------------------------
# Full report structure validation
# ---------------------------------------------------------------------------

def test_build_report_structure_has_all_required_keys():
    report = build_report(
        instruction_surfaces=[],
        codex_config_paths=[],
        skill_roots=[],
    )
    required_keys = {
        "schema", "schema_version", "proof_class", "redaction", "token_estimator",
        "thresholds", "summary", "instruction_files", "codex_config_sources",
        "embedded_config_instructions", "skill_description_summary",
        "top_context_surfaces", "findings", "limitations",
    }
    for key in required_keys:
        assert key in report, f"missing key: {key}"


def test_build_report_thresholds_match_module_constants():
    report = build_report(
        instruction_surfaces=[],
        codex_config_paths=[],
        skill_roots=[],
    )
    t = report["thresholds"]
    assert t["large_instruction_tokens"] == aud.LARGE_INSTRUCTION_TOKENS
    assert t["very_large_instruction_tokens"] == aud.VERY_LARGE_INSTRUCTION_TOKENS
    assert t["skill_metadata_bulk_tokens"] == aud.SKILL_METADATA_BULK_TOKENS


def test_build_report_findings_reflected_in_summary_counts():
    """Trigger a very_large finding and verify summary severity_counts is populated."""
    with tempfile.TemporaryDirectory(prefix="iba-findings-") as tmp:
        root = Path(tmp)
        # 8001 tokens * 4 chars each = 32004 chars
        big_content = "x" * (aud.VERY_LARGE_INSTRUCTION_TOKENS * 4 + 4)
        inst_file = root / "big.md"
        inst_file.write_text(big_content, encoding="utf-8")
        surface = InstructionSurface(
            path=inst_file,
            harness="claude",
            surface="instruction",
            load_mode="always_on_candidate",
            loaded_by="test",
            evidence="test",
        )
        report = build_report(
            instruction_surfaces=[surface],
            codex_config_paths=[],
            skill_roots=[],
        )
    assert report["summary"]["finding_count"] >= 1
    assert report["summary"]["severity_counts"].get("high", 0) >= 1
    assert report["summary"]["issue_code_counts"].get("very_large_instruction_surface", 0) >= 1
    assert report["findings"][0]["code"] == "very_large_instruction_surface"


def test_build_report_large_but_not_very_large_triggers_medium_finding():
    """LARGE_INSTRUCTION_TOKENS < tokens <= VERY_LARGE_INSTRUCTION_TOKENS => medium."""
    with tempfile.TemporaryDirectory(prefix="iba-medium-") as tmp:
        root = Path(tmp)
        # Exactly LARGE+1 tokens => medium severity
        chars = (aud.LARGE_INSTRUCTION_TOKENS + 1) * 4
        inst_file = root / "medium.md"
        inst_file.write_text("y" * chars, encoding="utf-8")
        surface = InstructionSurface(
            path=inst_file,
            harness="claude",
            surface="instruction",
            load_mode="always_on_candidate",
            loaded_by="test",
            evidence="test",
        )
        report = build_report(
            instruction_surfaces=[surface],
            codex_config_paths=[],
            skill_roots=[],
        )
    assert report["summary"]["severity_counts"].get("medium", 0) >= 1
    codes = [f["code"] for f in report["findings"]]
    assert "large_instruction_surface" in codes
    assert "very_large_instruction_surface" not in codes


def test_codex_config_ok_status_row():
    """A valid TOML config (no developer_instructions) => status=ok."""
    with tempfile.TemporaryDirectory(prefix="iba-ok-") as tmp:
        config = Path(tmp) / "config.toml"
        config.write_text("model_context_window = 200000\n", encoding="utf-8")
        report = build_report(
            instruction_surfaces=[],
            codex_config_paths=[config],
            skill_roots=[],
        )
    assert report["summary"]["codex_config_status_counts"] == {"ok": 1}
    row = report["codex_config_sources"][0]
    assert row["status"] == "ok"
    assert row["error_type"] is None
    assert row["shape"] == "object"


# ---------------------------------------------------------------------------
# CLI e2e: --include-present-only-caches flag
# ---------------------------------------------------------------------------

def test_cli_include_present_only_caches_flag_accepted():
    """CLI must accept --include-present-only-caches without error."""
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "instruction_budget_auditor.py"),
            "--include-present-only-caches",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["schema"] == "agent-runtime-instruction-budget-auditor"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} instruction budget auditor tests passed")
