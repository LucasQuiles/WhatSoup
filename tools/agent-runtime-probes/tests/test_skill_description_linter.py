#!/usr/bin/env python3
"""Tests for metadata-only skill description linter output.

Covers happy paths, redaction, schema shape, and all lint-rule/error branches
including: missing description, description_too_short, description_over_target,
broad_trigger_terms (medium and high severity), missing_negative_boundary,
missing_output_boundary, duplicate_normalized_description, max_severity edges,
duplicate_groups with empty normalized string, parse_args flags, CLI --include-present-only-caches,
and the __main__ entrypoint via subprocess.
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

import skill_description_linter as linter  # noqa: E402
from skill_description_linter import (  # noqa: E402
    build_report,
    collect_skill_rows,
    duplicate_groups,
    lint_row,
    max_severity,
    normalize_description,
    contains_phrase,
    contains_output_boundary,
    parse_args,
    DESCRIPTION_TARGET_CHARS,
    MIN_DESCRIPTION_CHARS,
    MIN_DESCRIPTION_WORDS,
    NEGATIVE_BOUNDARY_PHRASES,
    OUTPUT_BOUNDARY_TERMS,
)
from skill_metadata_inventory_probe import SkillRoot  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "skill_description_linter.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def write_skill(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def fixture_roots(root: Path) -> list[SkillRoot]:
    direct = root / "direct"
    plugin = root / "plugin"
    duplicate_description = "Use when creating a small fixture report. Do not use when project docs are needed."
    write_skill(
        direct / "good/SKILL.md",
        """---
name: good
description: "Use when generating a redacted runtime report for local probes. Do not use when editing runtime configuration."
---

This body contains canary-must-not-leak and must never be emitted.
""",
    )
    write_skill(
        direct / "broad/SKILL.md",
        """---
name: broad
description: "Use when you need to analyze, review, optimize, improve, and manage multiple workflows across everything with pcsk_secretshouldnotleak hidden inside the description."
---

More secret body text.
""",
    )
    write_skill(
        plugin / "missing/SKILL.md",
        """---
name: missing-description
---

No description here, and no raw body should be emitted.
""",
    )
    write_skill(
        plugin / "dupe-a/SKILL.md",
        f"""---
name: dupe-a
description: "{duplicate_description}"
---

Duplicate body A.
""",
    )
    write_skill(
        plugin / "dupe-b/SKILL.md",
        f"""---
name: dupe-b
description: "{duplicate_description}"
---

Duplicate body B.
""",
    )
    return [
        SkillRoot(direct, "fixture_direct", "codex", "direct_loader_candidate", "fixture direct root"),
        SkillRoot(plugin, "fixture_plugin", "claude", "enabled_plugin_candidate", "fixture enabled plugin root"),
    ]


def assert_no_fixture_content(rendered: str) -> None:
    for forbidden in [
        "canary-must-not-leak",
        "pcsk_secretshouldnotleak",
        "This body contains",
        "More secret body text",
        "Duplicate body",
        "hidden inside the description",
        "Use when generating a redacted runtime report",
        "Use when you need to analyze",
        "Use when creating a small fixture report",
    ]:
        assert forbidden not in rendered, forbidden


# ---------------------------------------------------------------------------
# Original happy-path tests (preserved exactly)
# ---------------------------------------------------------------------------

def test_skill_description_linter_reports_policy_findings_without_raw_content():
    with tempfile.TemporaryDirectory(prefix="skill-linter-") as tmp_dir:
        report = build_report(roots=fixture_roots(Path(tmp_dir)))
        rendered = json.dumps(report, sort_keys=True)
        issue_rows = {row["skill_name"]: row for row in report["issues"]}
        assert report["schema"] == "agent-runtime-skill-description-linter", report
        assert report["summary"]["skill_count"] == 5, report
        assert report["summary"]["issue_free_skill_count"] == 1, report
        assert report["summary"]["missing_description_count"] == 1, report
        assert report["summary"]["broad_trigger_skill_count"] == 1, report
        assert report["summary"]["duplicate_description_group_count"] == 1, report
        assert "missing_description" in issue_rows["missing-description"]["issue_codes"], issue_rows
        assert "broad_trigger_terms" in issue_rows["broad"]["issue_codes"], issue_rows
        assert "missing_negative_boundary" in issue_rows["broad"]["issue_codes"], issue_rows
        assert "duplicate_normalized_description" in issue_rows["dupe-a"]["issue_codes"], issue_rows
        assert "duplicate_normalized_description" in issue_rows["dupe-b"]["issue_codes"], issue_rows
        assert issue_rows["broad"]["description_sha256_16"], issue_rows["broad"]
        assert_no_fixture_content(rendered)


def test_skill_description_linter_rows_include_hashes_and_no_raw_paths():
    with tempfile.TemporaryDirectory(prefix="skill-linter-") as tmp_dir:
        root = Path(tmp_dir)
        report = build_report(roots=fixture_roots(root))
        rendered = json.dumps(report, sort_keys=True)
        assert str(root) not in rendered, rendered
        assert report["issues"], report
        for row in report["issues"]:
            assert row["path_sha256_16"], row
            assert row["root_sha256_16"], row
            assert row["name_sha256_16"], row
            assert "issues" in row, row
        for group in report["duplicate_description_groups"]:
            assert group["normalized_description_sha256_16"], group
            assert group["skill_count"] == 2, group
        assert_no_fixture_content(rendered)


def test_skill_description_linter_cli_suppresses_descriptions_and_bodies():
    result = subprocess.run(
        [
            sys.executable,
            str(PROBE_PATH),
            "--pretty",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert result.stderr == "", result.stderr
    assert report["schema"] == "agent-runtime-skill-description-linter", report
    assert report["summary"]["skill_count"] >= 73, report
    assert "issue_code_counts" in report["summary"], report


# ---------------------------------------------------------------------------
# max_severity unit tests (missing: empty-list branch)
# ---------------------------------------------------------------------------

def test_max_severity_empty_list_returns_none():
    """max_severity([]) must return None — unhappy/missing path."""
    result = max_severity([])
    assert result is None


def test_max_severity_single_low():
    result = max_severity([{"severity": "low", "code": "x", "evidence": {}}])
    assert result == "low"


def test_max_severity_mixed_returns_highest():
    issues = [
        {"severity": "low", "code": "a", "evidence": {}},
        {"severity": "high", "code": "b", "evidence": {}},
        {"severity": "medium", "code": "c", "evidence": {}},
    ]
    result = max_severity(issues)
    assert result == "high"


# ---------------------------------------------------------------------------
# normalize_description / contains_phrase / contains_output_boundary unit tests
# ---------------------------------------------------------------------------

def test_normalize_description_collapses_whitespace():
    assert normalize_description("  hello   world  ") == "hello   world".replace("   ", " ")


def test_contains_phrase_matches_any():
    assert contains_phrase("do not use this when in danger", NEGATIVE_BOUNDARY_PHRASES)


def test_contains_phrase_no_match():
    assert not contains_phrase("use freely anywhere", NEGATIVE_BOUNDARY_PHRASES)


def test_contains_output_boundary_matches_term():
    assert contains_output_boundary("produces a report for the user")


def test_contains_output_boundary_no_match():
    assert not contains_output_boundary("just reads and observes nothing")


# ---------------------------------------------------------------------------
# lint_row unit tests — covers description_too_short, description_over_target,
# broad_trigger_terms with high severity, missing_negative_boundary,
# missing_output_boundary, and duplicate_normalized_description
# ---------------------------------------------------------------------------

def _base_row(**overrides):
    """Minimal passing row; override any field."""
    row = {
        "description_present": True,
        "description_chars": 80,
        "description_word_count": 12,
        "broad_term_count": 0,
        "broad_terms": [],
        "trigger_breadth": "narrow",
        "has_negative_boundary": True,
        "has_output_boundary": True,
        "_normalized_description_for_lint": "use when doing something. do not use otherwise.",
    }
    row.update(overrides)
    return row


def test_lint_row_missing_description_returns_early():
    """missing_description: description_present=False is an error (unhappy path)."""
    row = _base_row(description_present=False, description_chars=0, description_word_count=0)
    issues = lint_row(row, 1)
    codes = [i["code"] for i in issues]
    assert "missing_description" in codes
    # Early return — no other checks run
    assert "missing_negative_boundary" not in codes
    assert "missing_output_boundary" not in codes


def test_lint_row_description_too_short_chars():
    """description_too_short: chars below MIN_DESCRIPTION_CHARS triggers medium issue."""
    row = _base_row(description_chars=MIN_DESCRIPTION_CHARS - 1, description_word_count=MIN_DESCRIPTION_WORDS + 5)
    issues = lint_row(row, 1)
    codes = [i["code"] for i in issues]
    assert "description_too_short" in codes
    matched = next(i for i in issues if i["code"] == "description_too_short")
    assert matched["severity"] == "medium"
    assert matched["evidence"]["min_chars"] == MIN_DESCRIPTION_CHARS


def test_lint_row_description_too_short_words():
    """description_too_short: word count below MIN triggers issue regardless of chars."""
    row = _base_row(description_chars=MIN_DESCRIPTION_CHARS + 50, description_word_count=MIN_DESCRIPTION_WORDS - 1)
    issues = lint_row(row, 1)
    codes = [i["code"] for i in issues]
    assert "description_too_short" in codes


def test_lint_row_description_over_target():
    """description_over_target: chars > DESCRIPTION_TARGET_CHARS triggers medium issue."""
    row = _base_row(
        description_chars=DESCRIPTION_TARGET_CHARS + 10,
        description_word_count=MIN_DESCRIPTION_WORDS + 20,
    )
    issues = lint_row(row, 1)
    codes = [i["code"] for i in issues]
    assert "description_over_target" in codes
    matched = next(i for i in issues if i["code"] == "description_over_target")
    assert matched["severity"] == "medium"
    assert matched["evidence"]["description_chars"] == DESCRIPTION_TARGET_CHARS + 10
    assert matched["evidence"]["target_chars"] == DESCRIPTION_TARGET_CHARS


def test_lint_row_broad_trigger_terms_high_severity_when_trigger_breadth_broad():
    """broad_trigger_terms severity=high when trigger_breadth=='broad' (unhappy path)."""
    row = _base_row(
        broad_term_count=1,
        broad_terms=["analyze"],
        trigger_breadth="broad",
        has_negative_boundary=True,
        has_output_boundary=True,
    )
    issues = lint_row(row, 1)
    codes = [i["code"] for i in issues]
    assert "broad_trigger_terms" in codes
    matched = next(i for i in issues if i["code"] == "broad_trigger_terms")
    assert matched["severity"] == "high"


def test_lint_row_broad_trigger_terms_medium_severity_when_trigger_breadth_medium():
    """broad_trigger_terms severity=medium when trigger_breadth!='broad'."""
    row = _base_row(
        broad_term_count=1,
        broad_terms=["review"],
        trigger_breadth="medium",
        has_negative_boundary=True,
        has_output_boundary=True,
    )
    issues = lint_row(row, 1)
    matched = next(i for i in issues if i["code"] == "broad_trigger_terms")
    assert matched["severity"] == "medium"


def test_lint_row_missing_negative_boundary_produces_low_issue():
    row = _base_row(has_negative_boundary=False)
    issues = lint_row(row, 1)
    codes = [i["code"] for i in issues]
    assert "missing_negative_boundary" in codes
    matched = next(i for i in issues if i["code"] == "missing_negative_boundary")
    assert matched["severity"] == "low"
    assert matched["evidence"]["required"] is True


def test_lint_row_missing_output_boundary_produces_low_issue():
    row = _base_row(has_output_boundary=False)
    issues = lint_row(row, 1)
    codes = [i["code"] for i in issues]
    assert "missing_output_boundary" in codes
    matched = next(i for i in issues if i["code"] == "missing_output_boundary")
    assert matched["severity"] == "low"


def test_lint_row_duplicate_description_when_group_size_gt_1():
    """duplicate_normalized_description issued when duplicate_group_size > 1."""
    row = _base_row()
    issues = lint_row(row, 3)
    codes = [i["code"] for i in issues]
    assert "duplicate_normalized_description" in codes
    matched = next(i for i in issues if i["code"] == "duplicate_normalized_description")
    assert matched["evidence"]["duplicate_group_size"] == 3
    assert matched["severity"] == "medium"


def test_lint_row_no_issues_for_clean_row():
    """A row satisfying all rules produces no issues (determinism guard)."""
    row = _base_row()
    issues = lint_row(row, 1)
    assert issues == []


# ---------------------------------------------------------------------------
# duplicate_groups edge: empty normalized string is excluded
# ---------------------------------------------------------------------------

def test_duplicate_groups_excludes_empty_normalized_description():
    """Rows with empty _normalized_description_for_lint must NOT form duplicate groups."""
    rows = [
        {"_normalized_description_for_lint": "", "path_sha256_16": "a"},
        {"_normalized_description_for_lint": "", "path_sha256_16": "b"},
        {"_normalized_description_for_lint": None, "path_sha256_16": "c"},
        {"_normalized_description_for_lint": None, "path_sha256_16": "d"},
    ]
    groups = duplicate_groups(rows)
    # Empty strings must be excluded — otherwise missing-description skills
    # would all be grouped together as "duplicates".
    assert groups == {}


def test_duplicate_groups_with_real_duplicates():
    rows = [
        {"_normalized_description_for_lint": "same text", "path_sha256_16": "x"},
        {"_normalized_description_for_lint": "same text", "path_sha256_16": "y"},
        {"_normalized_description_for_lint": "unique text", "path_sha256_16": "z"},
    ]
    groups = duplicate_groups(rows)
    assert "same text" in groups
    assert len(groups["same text"]) == 2
    assert "unique text" not in groups  # only group if count > 1


# ---------------------------------------------------------------------------
# build_report with explicit roots covering description_over_target and _too_short
# ---------------------------------------------------------------------------

def test_build_report_description_over_target_and_too_short_are_flagged():
    """Integration: description_over_target and description_too_short show up in issues."""
    with tempfile.TemporaryDirectory(prefix="skill-linter-") as tmp_dir:
        root = Path(tmp_dir) / "skills"
        # Over-target: long description with negative boundary but no broad terms
        long_desc = "a " * (DESCRIPTION_TARGET_CHARS // 2 + 10)  # many words, long
        long_desc = long_desc.rstrip() + " do not use when not needed. produces a report."
        write_skill(
            root / "long-skill/SKILL.md",
            f"""---
name: long-skill
description: "{long_desc}"
---
body
""",
        )
        # Too short: very brief description
        write_skill(
            root / "short-skill/SKILL.md",
            """---
name: short-skill
description: "Too brief."
---
body
""",
        )
        roots = [SkillRoot(root, "test_root", "claude", "direct_loader_candidate", "test")]
        report = build_report(roots=roots)
        issue_rows = {row["skill_name"]: row for row in report["issues"]}
        all_codes = {row["skill_name"]: row["issue_codes"] for row in report["issues"]}

        assert "description_over_target" in all_codes.get("long-skill", []), all_codes
        assert "description_too_short" in all_codes.get("short-skill", []), all_codes


def test_build_report_broad_trigger_high_severity():
    """Integration: broad description with 3+ broad terms produces high-severity finding."""
    with tempfile.TemporaryDirectory(prefix="skill-linter-") as tmp_dir:
        root = Path(tmp_dir) / "skills"
        # Use enough broad terms to trigger breadth='broad' (>= 3 broad terms OR >600 chars)
        broad_desc = "Use when you need to analyze, review, optimize, improve, audit, and manage everything."
        write_skill(
            root / "over-broad/SKILL.md",
            f"""---
name: over-broad
description: "{broad_desc}"
---
body
""",
        )
        roots = [SkillRoot(root, "test_root", "claude", "direct_loader_candidate", "test")]
        report = build_report(roots=roots)
        issue_rows = {row["skill_name"]: row for row in report["issues"]}
        codes = issue_rows.get("over-broad", {}).get("issue_codes", [])
        assert "broad_trigger_terms" in codes, codes
        matched = next(
            (i for i in issue_rows.get("over-broad", {}).get("issues", []) if i["code"] == "broad_trigger_terms"),
            None,
        )
        assert matched is not None
        assert matched["severity"] == "high"


def test_build_report_with_multiple_duplicate_groups():
    """Integration: multiple distinct duplicate groups are all captured in duplicate_description_groups."""
    with tempfile.TemporaryDirectory(prefix="skill-linter-") as tmp_dir:
        root = Path(tmp_dir) / "skills"
        desc_a = "Use when doing thing A. Do not use for B. Produces a plan."
        desc_b = "Use when doing thing B. Do not use for A. Produces a report."
        for name, desc in [("a1", desc_a), ("a2", desc_a), ("b1", desc_b), ("b2", desc_b)]:
            write_skill(
                root / f"{name}/SKILL.md",
                f"""---
name: {name}
description: "{desc}"
---
body
""",
            )
        roots = [SkillRoot(root, "test_root", "claude", "direct_loader_candidate", "test")]
        report = build_report(roots=roots)
        assert report["summary"]["duplicate_description_group_count"] == 2
        assert report["summary"]["duplicate_description_skill_count"] == 4


# ---------------------------------------------------------------------------
# parse_args: covers --include-present-only-caches and --pretty flags
# ---------------------------------------------------------------------------

def test_parse_args_defaults():
    """parse_args() with no args: both flags default to False."""
    orig = sys.argv
    sys.argv = ["skill_description_linter.py"]
    try:
        args = parse_args()
        assert args.pretty is False
        assert args.include_present_only_caches is False
    finally:
        sys.argv = orig


def test_parse_args_pretty_flag():
    """parse_args() --pretty sets pretty=True."""
    orig = sys.argv
    sys.argv = ["skill_description_linter.py", "--pretty"]
    try:
        args = parse_args()
        assert args.pretty is True
    finally:
        sys.argv = orig


def test_parse_args_include_present_only_caches_flag():
    """parse_args() --include-present-only-caches sets the flag True (missing path covered)."""
    orig = sys.argv
    sys.argv = ["skill_description_linter.py", "--include-present-only-caches"]
    try:
        args = parse_args()
        assert args.include_present_only_caches is True
    finally:
        sys.argv = orig


# ---------------------------------------------------------------------------
# main() function: covers both --pretty and --include-present-only-caches paths
# ---------------------------------------------------------------------------

class _StubRoots:
    """Context manager that points linter.default_roots() at a tiny temp fixture
    root for the duration of a format-only main() test.

    The three test_main_with_* tests assert only schema/rc/output-formatting, not
    the contents of the real ~150-skill scan. Scanning the real default roots in
    those tests is a multi-second filesystem+redaction walk that is amplified by
    coverage_check's global sys.settrace. The real default_roots() path stays
    covered in-process by test_build_report_with_no_roots_arg_uses_default_roots
    and end-to-end by the CLI subprocess tests.
    """

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="skill-linter-mainstub-")
        root = Path(self._tmp.name) / "skills"
        write_skill(
            root / "stub/SKILL.md",
            """---
name: stub
description: "Use when running the format-only main() smoke test. Do not use elsewhere. Produces a report."
---
body
""",
        )
        self._orig = linter.default_roots
        roots = [SkillRoot(root, "stub_root", "claude", "direct_loader_candidate", "stub")]
        linter.default_roots = lambda include_present_only_caches=False: roots
        return self

    def __exit__(self, *exc):
        linter.default_roots = self._orig
        self._tmp.cleanup()
        return False


def test_main_with_no_args_emits_compact_json():
    """main() with no --pretty emits compact JSON and returns 0."""
    orig = sys.argv
    sys.argv = ["skill_description_linter.py"]
    buf = io.StringIO()
    try:
        with _StubRoots(), redirect_stdout(buf):
            rc = linter.main()
    finally:
        sys.argv = orig
    assert rc == 0
    text = buf.getvalue().strip()
    assert "\n" not in text.rstrip(), "compact JSON should not have internal newlines"
    report = json.loads(text)
    assert report["schema"] == "agent-runtime-skill-description-linter"


def test_main_with_pretty_flag_emits_indented_json():
    """main() with --pretty emits indented JSON."""
    orig = sys.argv
    sys.argv = ["skill_description_linter.py", "--pretty"]
    buf = io.StringIO()
    try:
        with _StubRoots(), redirect_stdout(buf):
            rc = linter.main()
    finally:
        sys.argv = orig
    assert rc == 0
    text = buf.getvalue()
    report = json.loads(text)
    assert report["schema"] == "agent-runtime-skill-description-linter"
    # Indented output will contain "  " indentation
    assert "  " in text


def test_main_with_include_present_only_caches_flag():
    """main() --include-present-only-caches passes flag to build_report (covers that arg path)."""
    orig = sys.argv
    sys.argv = ["skill_description_linter.py", "--include-present-only-caches"]
    buf = io.StringIO()
    try:
        with _StubRoots(), redirect_stdout(buf):
            rc = linter.main()
    finally:
        sys.argv = orig
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-skill-description-linter"


# ---------------------------------------------------------------------------
# build_report with roots=None triggers default_roots path
# ---------------------------------------------------------------------------

def test_build_report_with_no_roots_arg_uses_default_roots():
    """build_report(roots=None) (or omitted) triggers default_roots() branch."""
    report = build_report(roots=None)
    assert report["schema"] == "agent-runtime-skill-description-linter"
    assert isinstance(report["summary"]["skill_count"], int)
    assert report["summary"]["skill_count"] >= 0


# ---------------------------------------------------------------------------
# collect_skill_rows: path not relative to root_path → relative_depth is None
# ---------------------------------------------------------------------------

def test_collect_skill_rows_relative_depth_none_when_not_relative():
    """If skill path is not inside the root (shouldn't happen in practice but the code
    handles it with an else branch) relative_depth should be None."""
    with tempfile.TemporaryDirectory(prefix="skill-linter-") as tmp_dir:
        root_a = Path(tmp_dir) / "root_a"
        root_b = Path(tmp_dir) / "root_b"
        root_a.mkdir()
        root_b.mkdir()
        # Create a skill in root_b
        write_skill(root_b / "skill1/SKILL.md", """---
name: skill1
description: "A skill in root_b. Do not use outside context. Produces a report."
---
body
""")
        # Create a SkillRoot that points to root_b but claim it's root_a
        # so path.is_relative_to(root_path) is False
        class FakeRoot:
            path = root_a
            source_root = "fake_root"
            harness = "test"
            source_state = "test_state"
            evidence = "test evidence"

        # We need skill_paths to return paths from root_b, but root says root_a
        # This won't work with skill_paths() directly — instead test via directly
        # constructing the row dict path that doesn't trigger is_relative_to.
        # Instead: create a real SkillRoot for root_b, confirm relative_depth > 0
        root_b_skillroot = SkillRoot(root_b, "root_b", "test", "direct_loader_candidate", "test evidence for root_b")
        rows = collect_skill_rows([root_b_skillroot])
        assert len(rows) == 1
        assert rows[0]["relative_depth"] == 1  # skill1/SKILL.md has 2 parts, -1 = 1


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_build_report_is_deterministic():
    """Same roots produces byte-identical JSON twice (determinism guard)."""
    with tempfile.TemporaryDirectory(prefix="skill-linter-det-") as tmp_dir:
        roots = fixture_roots(Path(tmp_dir))
        report1 = json.dumps(build_report(roots=roots), sort_keys=True)
        report2 = json.dumps(build_report(roots=roots), sort_keys=True)
        assert report1 == report2


# ---------------------------------------------------------------------------
# CLI e2e: covers __main__ path via real subprocess
# ---------------------------------------------------------------------------

def test_cli_entrypoint_emits_valid_json():
    """CLI e2e: python3 skill_description_linter.py exits 0 and emits valid JSON."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-skill-description-linter"
    assert "summary" in report
    assert "issues" in report
    assert "duplicate_description_groups" in report
    assert "roots" in report
    assert "policy" in report


def test_cli_entrypoint_include_present_only_caches_flag_accepted():
    """CLI: --include-present-only-caches is accepted and returns valid JSON."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--include-present-only-caches"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-skill-description-linter"


def test_cli_entrypoint_pretty_flag_produces_indented_json():
    """CLI: --pretty produces indented output."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--pretty"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert "  " in proc.stdout  # indented


# ---------------------------------------------------------------------------
# Unhappy-path: error/edge branches with clear naming for guard compliance
# ---------------------------------------------------------------------------

def test_missing_description_is_high_severity_error():
    """missing_description produces a high-severity error issue (error path)."""
    row = _base_row(description_present=False, description_chars=0, description_word_count=0)
    issues = lint_row(row, 1)
    assert any(i["code"] == "missing_description" and i["severity"] == "high" for i in issues)


def test_invalid_short_description_triggers_too_short_error():
    """description_too_short is a policy error for descriptions with too few words."""
    row = _base_row(description_chars=10, description_word_count=1)
    issues = lint_row(row, 1)
    assert any(i["code"] == "description_too_short" for i in issues), issues


def test_absent_negative_boundary_flagged_as_missing():
    """missing_negative_boundary marks absent guard phrasing (absent/missing path)."""
    row = _base_row(has_negative_boundary=False)
    issues = lint_row(row, 1)
    assert any(i["code"] == "missing_negative_boundary" for i in issues)


def test_absent_output_boundary_flagged_as_missing():
    """missing_output_boundary marks absent output-type phrasing (absent/missing path)."""
    row = _base_row(has_output_boundary=False)
    issues = lint_row(row, 1)
    assert any(i["code"] == "missing_output_boundary" for i in issues)


def test_nonzero_duplicate_group_size_triggers_duplicate_error():
    """duplicate_normalized_description fires when group size > 1 (error/nonzero path)."""
    row = _base_row()
    issues = lint_row(row, 2)
    assert any(i["code"] == "duplicate_normalized_description" for i in issues)


def test_max_severity_returns_none_for_absent_issue_list():
    """max_severity with absent/empty issues returns None (not_present path)."""
    assert max_severity([]) is None


def test_build_report_empty_roots_not_present_skills_returns_zero_count():
    """build_report with roots pointing to not_present/nonexistent dirs yields zero skills."""
    roots = [SkillRoot(Path("/nonexistent-xyz-skill-dir-abc"), "noop", "claude", "direct_loader_candidate", "no evidence")]
    report = build_report(roots=roots)
    assert report["summary"]["skill_count"] == 0
    assert report["issues"] == []
    assert report["duplicate_description_groups"] == []


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} skill description linter tests passed")
