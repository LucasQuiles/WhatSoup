#!/usr/bin/env python3
"""Tests for metadata-only skill inventory output."""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import skill_metadata_inventory_probe as probe  # noqa: E402
from skill_metadata_inventory_probe import SkillRoot, build_report  # noqa: E402


def write_skill(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def fixture_roots(root: Path) -> list[SkillRoot]:
    direct = root / "direct"
    plugin = root / "plugin"
    write_skill(
        direct / "narrow/SKILL.md",
        """---
name: narrow
description: "Use when formatting a small local report."
allowed-tools: Read
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
    (direct / "narrow/scripts").mkdir(parents=True)
    (direct / "narrow/scripts/run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
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
        "must never be emitted",
        "hidden inside the description",
    ]:
        assert forbidden not in rendered, forbidden


def test_skill_inventory_summarizes_metadata_without_descriptions_or_bodies():
    with tempfile.TemporaryDirectory(prefix="skill-inventory-") as tmp_dir:
        report = build_report(roots=fixture_roots(Path(tmp_dir)))
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "agent-runtime-skill-metadata-inventory", report
        assert report["summary"]["skill_count"] == 3, report
        assert report["summary"]["source_state_counts"]["direct_loader_candidate"] == 2, report
        assert report["summary"]["source_state_counts"]["enabled_plugin_candidate"] == 1, report
        assert report["summary"]["missing_description_count"] == 1, report
        assert report["summary"]["description_over_target_count"] == 0, report
        assert report["summary"]["scripts_backed_skill_count"] == 1, report
        assert report["summary"]["trigger_breadth_counts"]["broad"] == 2, report
        assert report["summary"]["trigger_breadth_counts"]["narrow"] == 1, report
        assert_no_fixture_content(rendered)


def test_skill_inventory_rows_include_hashes_and_no_raw_paths():
    with tempfile.TemporaryDirectory(prefix="skill-inventory-") as tmp_dir:
        root = Path(tmp_dir)
        report = build_report(roots=fixture_roots(root))
        rendered = json.dumps(report, sort_keys=True)
        rows = {row["name"]: row for row in report["skills"]}
        assert rows["narrow"]["description_sha256_16"], rows["narrow"]
        assert rows["narrow"]["path_sha256_16"], rows["narrow"]
        assert rows["broad"]["broad_term_count"] >= 3, rows["broad"]
        assert rows["missing-description"]["description_present"] is False, rows["missing-description"]
        assert str(root) not in rendered, rendered
        assert_no_fixture_content(rendered)


def test_skill_inventory_cli_suppresses_descriptions_and_bodies():
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "skill_metadata_inventory_probe.py"),
            "--pretty",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert result.stderr == "", result.stderr
    assert report["schema"] == "agent-runtime-skill-metadata-inventory", report
    assert report["summary"]["skill_count"] >= 73, report
    assert "description_chars_p90" in report["summary"], report


# ---------------------------------------------------------------------------
# Unhappy-path unit tests for the parsing / classification helpers.
# ---------------------------------------------------------------------------


def test_parse_frontmatter_absent_fence_fails_closed_to_empty():
    # No leading "---" → must yield empty dict (skipped, not crash), even though
    # the body contains key:value-looking lines that must NOT be parsed.
    fm = probe.parse_frontmatter("name: leaky\ndescription: should not parse\n")
    assert fm == {}, fm
    # Empty input is also an absent fence.
    assert probe.parse_frontmatter("") == {}


def test_parse_frontmatter_skips_indented_and_colonless_lines():
    text = (
        "---\n"
        "name: realname\n"
        "  indented: ignored\n"          # leading space → continue (line 70/71)
        "nocolonhere\n"                    # no colon → continue
        ": emptykey\n"                     # empty key after strip → skipped (key falsy)
        "description: kept\n"
        "---\n"
        "trailing: after-fence-ignored\n"  # after closing fence → break already hit
    )
    fm = probe.parse_frontmatter(text)
    assert fm == {"name": "realname", "description": "kept"}, fm
    assert "indented" not in fm
    assert "nocolonhere" not in fm
    assert "trailing" not in fm


def test_strip_quotes_handles_quoted_and_bare_values():
    assert probe.strip_quotes('"quoted"') == "quoted"
    assert probe.strip_quotes("'single'") == "single"
    assert probe.strip_quotes("  bare  ") == "bare"
    # Mismatched / single-char must be left intact (not over-stripped).
    assert probe.strip_quotes('"') == '"'
    assert probe.strip_quotes("'mismatch\"") == "'mismatch\""


def test_bounded_file_count_missing_dir_is_zero():
    assert probe.bounded_file_count(Path("/nonexistent-skill-dir-xyz")) == 0


def test_bounded_file_count_hits_limit_and_short_circuits():
    with tempfile.TemporaryDirectory(prefix="bfc-") as tmp:
        root = Path(tmp)
        for i in range(7):
            (root / f"f{i}.txt").write_text("x", encoding="utf-8")
        # 7 real files, but limit=3 must stop and report exactly the cap.
        assert probe.bounded_file_count(root, limit=3) == 3
        # Without a cap below the count, returns the real total.
        assert probe.bounded_file_count(root, limit=500) == 7


def test_skill_paths_missing_root_returns_empty():
    missing = SkillRoot(Path("/nope-skill-root-xyz"), "x", "codex", "direct_loader_candidate", "e")
    assert probe.skill_paths(missing) == []


def test_percentile_zero_one_and_n_items():
    assert probe.percentile([], 50) is None        # 0 items → None (line 246)
    assert probe.percentile([42], 50) == 42         # 1 item
    assert probe.percentile([42], 99) == 42
    vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    assert probe.percentile(vals, 50) == 50         # ceil(0.5*10)-1 = idx 4
    assert probe.percentile(vals, 90) == 90         # ceil(0.9*10)-1 = idx 8
    assert probe.percentile(vals, 100) == 100       # clamps to last


def test_trigger_breadth_buckets_all_branches():
    # missing description → broad
    assert probe.trigger_breadth(0, True, []) == "broad"
    # zero chars but "present" → still broad
    assert probe.trigger_breadth(0, False, []) == "broad"
    # very long → broad
    assert probe.trigger_breadth(700, False, []) == "broad"
    # 3+ broad terms → broad
    assert probe.trigger_breadth(100, False, ["a", "b", "c"]) == "broad"
    # over target but not very long → medium (line 203)
    assert probe.trigger_breadth(probe.DESCRIPTION_TARGET_CHARS + 1, False, []) == "medium"
    # short but has a broad term → medium
    assert probe.trigger_breadth(50, False, ["audit"]) == "medium"
    # short, clean → narrow
    assert probe.trigger_breadth(50, False, []) == "narrow"


def test_broad_term_hits_word_boundary_only():
    hits = probe.broad_term_hits("Audit and review across MULTIPLE workflow steps")
    assert hits == sorted(["audit", "review", "across", "multiple", "workflow"]), hits
    # Plural "workflows" must NOT match the singular term (word-boundary anchored).
    assert probe.broad_term_hits("workflows") == []
    # substring inside a larger word must NOT match (word-boundary anchored).
    assert probe.broad_term_hits("reanalyzed manageable allover") == []


# ---------------------------------------------------------------------------
# Root-discovery tests driven by a synthetic HOME (no real ~/.claude scan).
# ---------------------------------------------------------------------------


def _patch_home(new_home: Path):
    """Repoint the probe's module-level HOME at a temp dir. Returns restorer."""
    orig = probe.HOME
    probe.HOME = new_home
    return lambda: setattr(probe, "HOME", orig)


def test_enabled_claude_plugin_roots_parses_settings_and_installed():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        home = Path(tmp)
        (home / ".claude/plugins").mkdir(parents=True)
        install = home / ".claude/plugins/acme"
        install.mkdir()
        (home / ".claude/settings.json").write_text(
            json.dumps({"enabledPlugins": {
                "acme@mkt": True,
                "off@mkt": False,
                "nolist@mkt": True,      # enabled but installed entry isn't a list
                "absent@mkt": True,      # enabled but missing from installed_plugins
            }}),
            encoding="utf-8",
        )
        (home / ".claude/plugins/installed_plugins.json").write_text(
            json.dumps({"plugins": {
                "acme@mkt": [{"installPath": str(install)}],
                "off@mkt": [{"installPath": str(install)}],
                "nolist@mkt": "not-a-list",   # → entries-not-a-list continue (line 103/104)
            }}),
            encoding="utf-8",
        )
        restore = _patch_home(home)
        try:
            roots = probe.enabled_claude_plugin_roots()
        finally:
            restore()
        # Only the enabled plugin with a list entry + installPath yields a root.
        assert len(roots) == 1, roots
        r = roots[0]
        assert r.source_root == "claude_enabled_plugin_skills"
        assert r.harness == "claude"
        assert r.source_state == "enabled_plugin_candidate"
        assert r.path == install / "skills"


def test_enabled_claude_plugin_roots_empty_when_no_settings():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        restore = _patch_home(Path(tmp))
        try:
            # No settings.json / installed_plugins.json → enabled/plugins not dicts.
            assert probe.enabled_claude_plugin_roots() == []
        finally:
            restore()


def test_enabled_claude_plugin_roots_skips_entry_without_install_path():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        home = Path(tmp)
        (home / ".claude").mkdir(parents=True)
        (home / ".claude/settings.json").write_text(
            json.dumps({"enabledPlugins": {"acme@mkt": True}}), encoding="utf-8")
        (home / ".claude/plugins").mkdir(parents=True)
        (home / ".claude/plugins/installed_plugins.json").write_text(
            json.dumps({"plugins": {"acme@mkt": [{"name": "no-path"}, "not-a-dict"]}}),
            encoding="utf-8")
        restore = _patch_home(home)
        try:
            assert probe.enabled_claude_plugin_roots() == []
        finally:
            restore()


def test_enabled_codex_plugin_roots_discovers_enabled_cache_skills():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        home = Path(tmp)
        (home / ".codex").mkdir(parents=True)
        # cache layout: ~/.codex/plugins/cache/<marketplace>/<name>/<version>/skills
        skills = home / ".codex/plugins/cache/mkt/acme/1.0/skills"
        skills.mkdir(parents=True)
        (home / ".codex/config.toml").write_text(
            "[plugins.\"acme@mkt\"]\nenabled = true\n"
            "[plugins.\"off@mkt\"]\nenabled = false\n"
            "[plugins.\"nomarketplace\"]\nenabled = true\n",
            encoding="utf-8",
        )
        restore = _patch_home(home)
        try:
            roots = probe.enabled_codex_plugin_roots()
        finally:
            restore()
        assert len(roots) == 1, roots
        assert roots[0].path == skills
        assert roots[0].source_state == "enabled_plugin_candidate"
        assert roots[0].harness == "codex"


def test_enabled_codex_plugin_roots_missing_config_is_empty():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        restore = _patch_home(Path(tmp))
        try:
            assert probe.enabled_codex_plugin_roots() == []
        finally:
            restore()


def test_enabled_codex_plugin_roots_malformed_toml_fails_typed_not_crash():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        home = Path(tmp)
        (home / ".codex").mkdir(parents=True)
        (home / ".codex/config.toml").write_text("this = = not valid toml\n", encoding="utf-8")
        restore = _patch_home(home)
        try:
            roots = probe.enabled_codex_plugin_roots()
        finally:
            restore()
        # Parse error must surface as a typed root, not an exception.
        assert len(roots) == 1, roots
        assert roots[0].source_state == "config_parse_error"
        assert roots[0].evidence.startswith("_error:")


def test_enabled_codex_plugin_roots_non_dict_plugins_is_empty():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        home = Path(tmp)
        (home / ".codex").mkdir(parents=True)
        (home / ".codex/config.toml").write_text("plugins = 5\n", encoding="utf-8")
        restore = _patch_home(home)
        try:
            assert probe.enabled_codex_plugin_roots() == []
        finally:
            restore()


def test_default_roots_dedupes_and_honors_present_only_flag():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        home = Path(tmp)
        restore = _patch_home(home)
        try:
            base = probe.default_roots(include_present_only_caches=False)
            with_cache = probe.default_roots(include_present_only_caches=True)
        finally:
            restore()
        base_sources = {r.source_root for r in base}
        assert "claude_personal_skills" in base_sources
        assert "codex_direct_skills" in base_sources
        assert "opencode_direct_skills" in base_sources
        assert "codex_tmp_plugin_cache_skills" not in base_sources
        # Present-only flag adds exactly the dormant cache root.
        cache_sources = {r.source_root for r in with_cache}
        assert "codex_tmp_plugin_cache_skills" in cache_sources
        assert len(with_cache) == len(base) + 1
        # Dedup: every (path, source_root, source_state) key is unique.
        keys = [(r.path.expanduser(), r.source_root, r.source_state) for r in with_cache]
        assert len(keys) == len(set(keys)), keys


def test_dedupe_roots_collapses_identical_keys():
    p = Path("/tmp/x/skills")
    a = SkillRoot(p, "src", "codex", "direct_loader_candidate", "first")
    b = SkillRoot(p, "src", "codex", "direct_loader_candidate", "second-wins-not")
    c = SkillRoot(p, "src", "codex", "present_only_cache", "different-state")
    out = probe.dedupe_roots([a, b, c])
    # a and b share a key → collapse to one; c has a distinct state → kept.
    assert len(out) == 2, out
    kept = next(r for r in out if r.source_state == "direct_loader_candidate")
    assert kept.evidence == "first", kept  # first occurrence wins (setdefault)


# ---------------------------------------------------------------------------
# Description-length / over-target & medium-bucket behavior on crafted fixtures.
# ---------------------------------------------------------------------------


def test_build_report_percentiles_and_over_target_on_crafted_lengths():
    with tempfile.TemporaryDirectory(prefix="skill-len-") as tmp:
        root_dir = Path(tmp) / "direct"
        # description lengths: 10, 60, and one well over the 350 target.
        long_desc = "x" * (probe.DESCRIPTION_TARGET_CHARS + 120)  # 470 chars, <600 → medium
        write_skill(root_dir / "a/SKILL.md", "---\nname: a\ndescription: " + "x" * 10 + "\n---\nbody\n")
        write_skill(root_dir / "b/SKILL.md", "---\nname: b\ndescription: " + "x" * 60 + "\n---\nbody\n")
        write_skill(root_dir / "c/SKILL.md", "---\nname: c\ndescription: " + long_desc + "\n---\nbody\n")
        roots = [SkillRoot(root_dir, "fixture_direct", "codex", "direct_loader_candidate", "e")]
        report = build_report(roots=roots)
        summ = report["summary"]
        assert summ["skill_count"] == 3, summ
        lengths = sorted(r["description_chars"] for r in report["skills"])
        assert lengths == [10, 60, len(long_desc)], lengths
        assert summ["description_chars_p50"] == probe.percentile(lengths, 50)
        assert summ["description_chars_p90"] == probe.percentile(lengths, 90)
        assert summ["description_over_target_count"] == 1, summ
        # The 470-char description sits in the medium bucket (over target, <600).
        c_row = next(r for r in report["skills"] if r["name"] == "c")
        assert c_row["trigger_breadth"] == "medium", c_row
        assert c_row["description_over_target"] is True


def test_build_report_duplicate_names_hashed_not_raw():
    with tempfile.TemporaryDirectory(prefix="skill-dup-") as tmp:
        root_dir = Path(tmp) / "direct"
        write_skill(root_dir / "one/SKILL.md", "---\nname: twin\ndescription: Use for one local task.\n---\nb\n")
        write_skill(root_dir / "two/SKILL.md", "---\nname: twin\ndescription: Use for another local task.\n---\nb\n")
        roots = [SkillRoot(root_dir, "fixture_direct", "codex", "direct_loader_candidate", "e")]
        report = build_report(roots=roots)
        rendered = json.dumps(report, sort_keys=True)
        assert report["summary"]["duplicate_name_count"] == 1, report["summary"]
        # The duplicate is reported only by hash, never the raw name string in summary.
        assert report["summary"]["duplicate_name_hashes"] == [probe.sha256_16("twin")]
        for row in report["skills"]:
            assert row["duplicate_name_count"] == 2, row


def test_build_report_empty_roots_yields_null_percentiles_and_zero_counts():
    # Note: roots=[] is falsy and falls through to default_roots(); patch HOME at
    # an empty dir so the default roots all resolve to zero skills.
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        restore = _patch_home(Path(tmp))
        try:
            report = build_report(roots=[])
        finally:
            restore()
    summ = report["summary"]
    assert summ["skill_count"] == 0
    assert summ["description_chars_p50"] is None
    assert summ["description_chars_p90"] is None
    assert summ["description_chars_p99"] is None
    assert summ["duplicate_name_count"] == 0
    assert report["skills"] == []


def test_build_report_default_roots_branch_on_empty_home():
    # Exercise build_report's default-roots path (roots=None) without scanning
    # the real HOME: point HOME at an empty dir so all roots resolve empty.
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        restore = _patch_home(Path(tmp))
        try:
            report = build_report(include_present_only_caches=True)
        finally:
            restore()
        assert report["schema"] == "agent-runtime-skill-metadata-inventory"
        assert report["summary"]["skill_count"] == 0
        # Every default root is present in the root table even when empty.
        srcs = {r["source_root"] for r in report["roots"]}
        assert "codex_tmp_plugin_cache_skills" in srcs
        for r in report["roots"]:
            assert r["root_exists"] is False, r
            assert r["skill_count"] == 0, r


# ---------------------------------------------------------------------------
# In-process main()/parse_args() coverage (traced; the subprocess test is not).
# ---------------------------------------------------------------------------


def test_main_in_process_emits_compact_json_over_empty_home():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        restore = _patch_home(Path(tmp))
        orig_argv = sys.argv
        sys.argv = ["skill_metadata_inventory_probe.py"]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig_argv
            restore()
        assert rc == 0
        out = buf.getvalue()
        report = json.loads(out)
        assert report["schema"] == "agent-runtime-skill-metadata-inventory"
        assert report["summary"]["skill_count"] == 0
        # Compact (no --pretty) → single-line JSON, no indentation newlines inside.
        assert "\n" not in out.strip()


def test_main_in_process_pretty_and_present_only_flags():
    with tempfile.TemporaryDirectory(prefix="home-") as tmp:
        restore = _patch_home(Path(tmp))
        orig_argv = sys.argv
        sys.argv = ["skill_metadata_inventory_probe.py", "--pretty", "--include-present-only-caches"]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig_argv
            restore()
        assert rc == 0
        out = buf.getvalue()
        report = json.loads(out)
        # --pretty → indented multi-line output.
        assert "\n" in out.strip()
        # --include-present-only-caches → dormant cache root present.
        srcs = {r["source_root"] for r in report["roots"]}
        assert "codex_tmp_plugin_cache_skills" in srcs


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} skill metadata inventory tests passed")
