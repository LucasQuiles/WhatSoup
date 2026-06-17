#!/usr/bin/env python3
"""Safety tests for tmup_policy_runtime_diff metadata and redaction."""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tmup_policy_runtime_diff as probe  # noqa: E402
from tmup_policy_runtime_diff import (  # noqa: E402
    build_report,
    build_findings,
    compare_scalar,
    executable_versions,
    model_mentions,
    parse_frontmatter,
    parse_scalar,
    parse_simple_yaml,
    read_toml,
    source_ref,
    strip_inline_comment,
    summarize_codex_config,
    summarize_opencode_agent,
    summarize_opencode_config,
    summarize_tmup_policy,
    summarize_toml_agent,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "tmup_policy_runtime_diff.py"


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def write_fixture_roots(root: Path) -> tuple[Path, Path, Path]:
    plugin = root / "plugin"
    codex = root / "codex"
    opencode = root / "opencode"
    (plugin / "config").mkdir(parents=True)
    (plugin / "agents/codex").mkdir(parents=True)
    (plugin / "scripts/lib").mkdir(parents=True)
    (plugin / "scripts").mkdir(parents=True, exist_ok=True)
    (plugin / "commands").mkdir(parents=True)
    (plugin / "skills/tmup").mkdir(parents=True)
    (codex / "agents").mkdir(parents=True)
    (opencode / "agents").mkdir(parents=True)
    (plugin / "config/policy.yaml").write_text(
        """
codex:
  model: "auto"
  model_preference: ["gpt-5.5", "gpt-5.3-codex"]
  context_window: 1050000
  auto_compact_token_limit: 750000
  approval_policy: "never"
  sandbox: "danger-full-access"
  reasoning_effort: "high"
  reasoning_summary: "concise"
  plan_mode_reasoning_effort: "xhigh"
  verbosity: "low"
  service_tier: "fast"
  tool_output_token_limit: 50000
  web_search: "live"
  history_persistence: "save-all"
  shell_env_inherit: "all"
  shell_snapshot: true
  enable_request_compression: true
  background_terminal_max_timeout: 600000
  subagents:
    max_threads: 6
    max_depth: 2
    job_max_runtime_seconds: 3600
""",
        encoding="utf-8",
    )
    for name, model in [("tmup-tier1", "gpt-5.3-codex"), ("tmup-tier2", "gpt-5.2-codex")]:
        (plugin / f"agents/codex/{name}.toml").write_text(
            f'''name = "{name}"
description = "Fixture {name}"
model = "{model}"
model_reasoning_effort = "high"
sandbox_mode = "danger-full-access"
developer_instructions = """
SECRET-INSTRUCTION-BODY should never appear.
Contact person@example.com with sk-THISSHOULDREDACT.
"""
''',
            encoding="utf-8",
        )
    (plugin / "scripts/lib/config.sh").write_text('echo "gpt-5.3-codex"\n', encoding="utf-8")
    (plugin / "scripts/dispatch-agent.sh").write_text('echo "gpt-5.2-codex"\n', encoding="utf-8")
    (plugin / "commands/tmup.md").write_text("mentions gpt-5.4 and gpt-5.3-codex\n", encoding="utf-8")
    (plugin / "skills/tmup/SKILL.md").write_text("skill mentions gpt-5.2-codex\n", encoding="utf-8")
    (plugin / "skills/tmup/REFERENCE.md").write_text("reference mentions gpt-5.5\n", encoding="utf-8")
    (codex / "config.toml").write_text(
        """
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
model_reasoning_summary = "concise"
approval_policy = "never"
sandbox_mode = "danger-full-access"
model_context_window = 1050000
model_auto_compact_token_limit = 630000
tool_output_token_limit = 25000
web_search = "live"
[agents]
max_threads = 6
max_depth = 2
job_max_runtime_seconds = 3600
[notice.model_migrations]
"gpt-5.3-codex" = "gpt-5.5"
""",
        encoding="utf-8",
    )
    for name in ["tmup-tier1", "tmup-tier2"]:
        (codex / f"agents/{name}.toml").write_text(
            f'''name = "{name}"
description = "Installed {name}"
model = "gpt-5.5"
model_reasoning_effort = "high"
sandbox_mode = "danger-full-access"
developer_instructions = """
INSTALLED-SECRET-INSTRUCTIONS should never appear.
"""
''',
            encoding="utf-8",
        )
    (opencode / "opencode.json").write_text(
        json.dumps(
            {
                "model": "minimax/MiniMax-M2.7-highspeed",
                "small_model": "deepseek/deepseek-chat",
                "default_agent": "fullstack-lead",
                "mcp": {
                    "secret-server": {
                        "enabled": True,
                        "environment": {
                            "SERVICE_URL": "https://secret.example.invalid",
                            "TOKEN": "Bearer abcdefghijklmnopqrstuvwxyz",
                        },
                    }
                },
                "plugin": ["sdlc-os"],
            }
        ),
        encoding="utf-8",
    )
    for name in ["tmup-tier1", "tmup-tier2"]:
        (opencode / f"agents/{name}.md").write_text(
            f"""---
description: "{name} fixture"
mode: subagent
permission:
  edit: deny
  bash: ask
---

# {name}

SECRET-OPENCODE-BODY should be hashed, not emitted.
""",
            encoding="utf-8",
        )
    return plugin, codex, opencode


# ---------------------------------------------------------------------------
# Original tests (preserved)
# ---------------------------------------------------------------------------

def test_tmup_policy_runtime_diff_detects_agent_model_drift_without_instruction_text():
    with tempfile.TemporaryDirectory(prefix="tmup-policy-diff-secret-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))
        report = build_report(plugin, codex, opencode, skip_versions=True)
        rendered = json.dumps(report, sort_keys=True)
        kinds = {item["kind"] for item in report["findings"]}
        assert "policy_model_auto_tracks_codex_config" in kinds, report
        assert "plugin_codex_agent_model_mismatch_with_installed_agents" in kinds, report
        assert "installed_codex_tmup_agents_align_current_base_model" in kinds, report
        assert "plugin_codex_agent_legacy_model_mentions" in kinds, report
        assert "codex.context_window_matches_codex_base" in kinds, report
        assert "codex.auto_compact_token_limit_tmup_override_or_drift" in kinds, report
        assert "SECRET-INSTRUCTION-BODY" not in rendered, report
        assert "INSTALLED-SECRET-INSTRUCTIONS" not in rendered, report
        assert "SECRET-OPENCODE-BODY" not in rendered, report
        assert "person@example.com" not in rendered, report
        assert "sk-THISSHOULDREDACT" not in rendered, report
        assert tmp_dir not in rendered, report


def test_tmup_policy_runtime_diff_cli_suppresses_secret_shapes_and_paths():
    with tempfile.TemporaryDirectory(prefix="tmup-policy-diff-secret-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))
        result = subprocess.run(
            [
                sys.executable,
                str(PROBE_PATH),
                "--plugin-root",
                str(plugin),
                "--codex-root",
                str(codex),
                "--opencode-root",
                str(opencode),
                "--skip-version-commands",
                "--pretty",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        assert result.stderr == "", result.stderr
        assert report["schema"] == "agent-runtime-tmup-policy-runtime-diff", report
        assert report["proof_class"] == "static-local-config-policy-diff", report
        assert report["opencode"]["mcp_count"] == 1, report
        assert report["tmup_selected_file_model_mentions"]["totals"]["gpt-5.3-codex"] >= 1, report
        for forbidden in [
            "SECRET-INSTRUCTION-BODY",
            "INSTALLED-SECRET-INSTRUCTIONS",
            "SECRET-OPENCODE-BODY",
            "person@example.com",
            "sk-THISSHOULDREDACT",
            "https://secret.example.invalid",
            "Bearer abcdefghijklmnopqrstuvwxyz",
            tmp_dir,
        ]:
            assert forbidden not in result.stdout, forbidden


# ---------------------------------------------------------------------------
# strip_inline_comment — escape sequences inside quoted strings
# ---------------------------------------------------------------------------

def test_strip_inline_comment_plain_line_unchanged():
    assert strip_inline_comment("key: value") == "key: value"


def test_strip_inline_comment_truncates_at_hash():
    assert strip_inline_comment("key: value # comment") == "key: value"


def test_strip_inline_comment_hash_inside_double_quotes_preserved():
    # hash inside a quoted string must NOT be treated as a comment
    assert strip_inline_comment('key: "val#ue"') == 'key: "val#ue"'


def test_strip_inline_comment_hash_inside_single_quotes_preserved():
    assert strip_inline_comment("key: 'val#ue'") == "key: 'val#ue'"


def test_strip_inline_comment_backslash_escape_inside_double_quotes():
    # backslash inside a quoted context sets escaped flag; next char is literal
    result = strip_inline_comment(r'"a\"b"')
    assert result == r'"a\"b"'


def test_strip_inline_comment_backslash_escape_sets_escaped_then_continues():
    # Verify the escaped=True branch: backslash inside quote, then escaped char
    line = '"hello\\"world"'
    result = strip_inline_comment(line)
    # The escaped double-quote should not close the string; entire line kept
    assert '"hello' in result


def test_strip_inline_comment_empty_line():
    assert strip_inline_comment("") == ""


# ---------------------------------------------------------------------------
# parse_scalar — all value branches
# ---------------------------------------------------------------------------

def test_parse_scalar_empty_string_returns_none():
    assert parse_scalar("") is None


def test_parse_scalar_whitespace_only_returns_none():
    assert parse_scalar("   ") is None


def test_parse_scalar_true():
    assert parse_scalar("true") is True


def test_parse_scalar_false():
    assert parse_scalar("false") is False


def test_parse_scalar_integer():
    assert parse_scalar("42") == 42


def test_parse_scalar_negative_integer():
    assert parse_scalar("-7") == -7


def test_parse_scalar_empty_list():
    assert parse_scalar("[]") == []


def test_parse_scalar_list_of_strings():
    result = parse_scalar('["a", "b"]')
    assert result == ["a", "b"]


def test_parse_scalar_list_of_ints():
    assert parse_scalar("[1, 2, 3]") == [1, 2, 3]


def test_parse_scalar_double_quoted_string():
    assert parse_scalar('"hello"') == "hello"


def test_parse_scalar_single_quoted_string():
    assert parse_scalar("'world'") == "world"


def test_parse_scalar_bare_word():
    assert parse_scalar("danger-full-access") == "danger-full-access"


# ---------------------------------------------------------------------------
# parse_simple_yaml — missing file, comment stripping, list items, nesting
# ---------------------------------------------------------------------------

def test_parse_simple_yaml_missing_file_returns_empty():
    result = parse_simple_yaml(Path("/nonexistent/no/such/file.yaml"))
    assert result == {}


def test_parse_simple_yaml_comment_only_lines_skipped():
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("# just a comment\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result == {}
    finally:
        os.unlink(name)


def test_parse_simple_yaml_inline_comment_stripped():
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("key: value # this is a comment\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result.get("key") == "value"
    finally:
        os.unlink(name)


def test_parse_simple_yaml_list_items_collected():
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("models:\n  - gpt-5.5\n  - gpt-5.3-codex\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result.get("models") == ["gpt-5.5", "gpt-5.3-codex"]
    finally:
        os.unlink(name)


def test_parse_simple_yaml_nested_keys():
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("codex:\n  model: gpt-5.5\n  subagents:\n    max_threads: 6\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result.get("codex.model") == "gpt-5.5"
        assert result.get("codex.subagents.max_threads") == 6
    finally:
        os.unlink(name)


def test_parse_simple_yaml_non_matching_line_skipped():
    # A line with only a hash that is inline-comment-stripped to empty should be skipped
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        # The line "  # pure comment" is skipped before reaching the inline stripper
        # but a line that STRIPS to empty via inline comment should also be skipped
        f.write("  # pure comment\nkey: val\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result.get("key") == "val"
    finally:
        os.unlink(name)


def test_parse_simple_yaml_stack_pop_on_dedent():
    # Verify that dedenting pops the stack (covers stack[-1][0] >= indent branch)
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("a:\n  b: 1\nc: 2\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result.get("a.b") == 1
        assert result.get("c") == 2
    finally:
        os.unlink(name)


def test_parse_simple_yaml_non_key_value_line_skipped():
    # A line like '---' passes blank/comment check and strip_inline_comment,
    # but matches neither the list-item nor key:value pattern -> hits `continue` at line 110
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("---\nkey: val\n---\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result.get("key") == "val"
    finally:
        os.unlink(name)


def test_parse_simple_yaml_orphan_list_item_without_stack_skipped():
    # A list item line ('- foo') when stack is empty: item matches but `item and stack`
    # is False -> falls through to key:value regex which also fails -> line 110 continue
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("- orphan_item\nkey: val\n")
        name = f.name
    try:
        result = parse_simple_yaml(Path(name))
        assert result.get("key") == "val"
        # orphan list item produces no entry
        assert "orphan_item" not in str(result)
    finally:
        os.unlink(name)


# ---------------------------------------------------------------------------
# read_toml — missing file and malformed TOML
# ---------------------------------------------------------------------------

def test_read_toml_missing_file_returns_empty():
    result = read_toml(Path("/nonexistent/config.toml"))
    assert result == {}


def test_read_toml_malformed_returns_error_dict():
    with tempfile.NamedTemporaryFile(suffix=".toml", mode="wb", delete=False) as f:
        f.write(b"[broken\nkey = oops\n")
        name = f.name
    try:
        result = read_toml(Path(name))
        assert "_error" in result
        assert "TOMLDecodeError" in result["_error"] or "Error" in result["_error"]
    finally:
        os.unlink(name)


# ---------------------------------------------------------------------------
# source_ref — path not relative to root (ValueError branch)
# ---------------------------------------------------------------------------

def test_source_ref_path_outside_root_uses_name():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        other_root = td_path / "other_root"
        other_root.mkdir()
        target = td_path / "somefile.toml"
        target.write_text("exists=true")
        result = source_ref(target, other_root)
        # When relative_to raises ValueError, falls back to path.name
        assert result["relative_path"] == "somefile.toml"
        assert result["exists"] is True


def test_source_ref_missing_file_has_zero_line_count():
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        missing = td_path / "missing.toml"
        result = source_ref(missing, td_path)
        assert result["exists"] is False
        assert result["line_count"] == 0
        assert result["sha256_16"] is None


# ---------------------------------------------------------------------------
# parse_frontmatter — missing file, no frontmatter, list items in frontmatter
# ---------------------------------------------------------------------------

def test_parse_frontmatter_missing_file_returns_empty():
    result = parse_frontmatter(Path("/nonexistent/agent.md"))
    assert result == {}


def test_parse_frontmatter_no_leading_dashes_returns_empty():
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("# Just a heading\nno frontmatter here\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result == {}
    finally:
        os.unlink(name)


def test_parse_frontmatter_empty_file_returns_empty():
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result == {}
    finally:
        os.unlink(name)


def test_parse_frontmatter_with_valid_yaml_block():
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("---\ndescription: my agent\nmode: subagent\n---\nbody text\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result.get("description") == "my agent"
        assert result.get("mode") == "subagent"
        assert result.get("_source_parser") == "__frontmatter__.yaml"
    finally:
        os.unlink(name)


def test_parse_frontmatter_list_items_in_block():
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("---\nmodels:\n  - gpt-5.5\n  - gpt-5.3-codex\n---\nbody\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert "models" in result
        assert "gpt-5.5" in result["models"]
    finally:
        os.unlink(name)


def test_parse_frontmatter_inline_comment_in_block():
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("---\nkey: val # inline comment\n---\nbody\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result.get("key") == "val"
    finally:
        os.unlink(name)


def test_parse_frontmatter_stack_pop_on_dedent():
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("---\npermission:\n  edit: deny\ntop: ok\n---\nbody\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result.get("permission.edit") == "deny"
        assert result.get("top") == "ok"
    finally:
        os.unlink(name)


def test_parse_frontmatter_blank_and_comment_lines_skipped():
    # Blank lines and # comment lines inside frontmatter -> hit line 188 `continue`
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("---\n\n# a comment line\nkey: val\n---\nbody\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result.get("key") == "val"
    finally:
        os.unlink(name)


def test_parse_frontmatter_non_key_value_line_skipped():
    # A line without ':' that doesn't match either pattern -> line 199 `continue`
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("---\nsome-free-text\nkey: val\n---\nbody\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result.get("key") == "val"
        assert "some-free-text" not in str(result)
    finally:
        os.unlink(name)


def test_parse_frontmatter_orphan_list_item_skipped():
    # List item without a preceding key (empty stack) falls through to no-match -> line 199
    with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
        f.write("---\n- orphan_item\nkey: val\n---\nbody\n")
        name = f.name
    try:
        result = parse_frontmatter(Path(name))
        assert result.get("key") == "val"
    finally:
        os.unlink(name)


# ---------------------------------------------------------------------------
# summarize_codex_config — *.config.toml profiles branch
# ---------------------------------------------------------------------------

def test_summarize_codex_config_includes_profiles():
    with tempfile.TemporaryDirectory() as td:
        codex_root = Path(td)
        (codex_root / "agents").mkdir()
        (codex_root / "config.toml").write_text(
            'model = "gpt-5.5"\n[agents]\nmax_threads = 4\n',
            encoding="utf-8",
        )
        # Write a *.config.toml profile
        (codex_root / "fast.config.toml").write_text(
            'model = "gpt-5.3-codex"\nsandbox_mode = "workspace-write"\n',
            encoding="utf-8",
        )
        result = summarize_codex_config(codex_root)
        assert "fast" in result["profiles"]
        profile = result["profiles"]["fast"]
        assert profile["model"] == "gpt-5.3-codex"
        assert "model" in profile["keys"]


# ---------------------------------------------------------------------------
# model_mentions — EXCLUDED_MODEL_TOKENS branch and missing files
# ---------------------------------------------------------------------------

def test_model_mentions_excludes_claude_native_token():
    with tempfile.TemporaryDirectory() as td:
        plugin_root = Path(td)
        # Create minimal directory structure
        (plugin_root / "config").mkdir()
        (plugin_root / "agents/codex").mkdir(parents=True)
        (plugin_root / "scripts/lib").mkdir(parents=True)
        (plugin_root / "scripts").mkdir(exist_ok=True)
        (plugin_root / "commands").mkdir()
        (plugin_root / "skills/tmup").mkdir(parents=True)
        # Write a selected file containing claude-native (should be excluded) and gpt-5.5
        (plugin_root / "commands/tmup.md").write_text(
            "uses claude-native and gpt-5.5 models\n",
            encoding="utf-8",
        )
        result = model_mentions(plugin_root)
        totals = result["totals"]
        assert "claude-native" not in totals, "claude-native should be excluded"
        assert "gpt-5.5" in totals


def test_model_mentions_missing_files_reported_as_absent():
    with tempfile.TemporaryDirectory() as td:
        plugin_root = Path(td)
        # No subdirectories at all — all selected files missing
        result = model_mentions(plugin_root)
        files = result["files"]
        missing = [f for f in files if not f.get("exists", True)]
        assert len(missing) > 0, "Expected at least some missing file entries"
        for entry in missing:
            assert entry["exists"] is False


# ---------------------------------------------------------------------------
# executable_versions — skip=False path, with mocked shutil.which and run
# ---------------------------------------------------------------------------

def test_executable_versions_skip_true_returns_skipped():
    result = executable_versions(skip=True)
    assert result["skipped"] is True
    assert result["codex"]["present"] is None
    assert result["opencode"]["present"] is None
    assert "yq" in result


def test_executable_versions_skip_false_tool_absent():
    orig_which = probe.shutil.which
    probe.shutil.which = lambda name: None
    try:
        result = executable_versions(skip=False)
        assert result["skipped"] is False
        assert result["codex"]["present"] is False
        assert result["opencode"]["present"] is False
        assert result["yq"]["present"] is False
    finally:
        probe.shutil.which = orig_which


def test_executable_versions_skip_false_tool_present_runs_version():
    orig_which = probe.shutil.which
    orig_run = probe.run
    probe.shutil.which = lambda name: f"/usr/local/bin/{name}"
    probe.run = lambda cmd, timeout=10: {"rc": 0, "stdout": "codex 1.2.3", "stderr": ""}
    try:
        result = executable_versions(skip=False)
        assert result["skipped"] is False
        assert result["codex"]["present"] is True
        assert result["codex"]["rc"] == 0
        assert "codex" in result["codex"]["version_text"]
        assert result["opencode"]["present"] is True
        assert result["yq"]["present"] is True
    finally:
        probe.shutil.which = orig_which
        probe.run = orig_run


def test_executable_versions_version_text_uses_stderr_when_stdout_empty():
    orig_which = probe.shutil.which
    orig_run = probe.run
    probe.shutil.which = lambda name: f"/usr/bin/{name}"
    probe.run = lambda cmd, timeout=10: {"rc": 0, "stdout": "", "stderr": "opencode 0.9.0"}
    try:
        result = executable_versions(skip=False)
        # Should pick up stderr when stdout is empty
        assert "opencode 0.9.0" in result["opencode"]["version_text"]
    finally:
        probe.shutil.which = orig_which
        probe.run = orig_run


# ---------------------------------------------------------------------------
# compare_scalar — both None, one None, equal, differs
# ---------------------------------------------------------------------------

def test_compare_scalar_both_none_adds_nothing():
    findings: list = []
    compare_scalar(findings, "mykey", None, "other", None)
    assert findings == []


def test_compare_scalar_tmup_none_adds_nothing():
    findings: list = []
    compare_scalar(findings, "mykey", None, "other", "somevalue")
    assert findings == []


def test_compare_scalar_codex_none_adds_nothing():
    findings: list = []
    compare_scalar(findings, "mykey", "somevalue", "other", None)
    assert findings == []


def test_compare_scalar_equal_values_adds_matches_finding():
    findings: list = []
    compare_scalar(findings, "codex.context_window", 1050000, "model_context_window", 1050000)
    assert len(findings) == 1
    assert findings[0]["kind"] == "codex.context_window_matches_codex_base"
    assert findings[0]["severity"] == "ok"


def test_compare_scalar_differing_values_adds_drift_finding():
    findings: list = []
    compare_scalar(findings, "codex.context_window", 750000, "model_context_window", 1050000)
    assert len(findings) == 1
    assert findings[0]["kind"] == "codex.context_window_tmup_override_or_drift"
    assert findings[0]["severity"] == "info"
    assert findings[0]["tmup_value"] == 750000
    assert findings[0]["codex_value"] == 1050000


# ---------------------------------------------------------------------------
# build_findings — policy_model_pin_differs branch (policy_model != "auto")
# ---------------------------------------------------------------------------

def test_build_findings_policy_model_pin_differs_from_codex():
    tmup = {
        "values": {
            "codex.model": "gpt-5.3-codex",  # not "auto" and != codex base
            "codex.model_preference": None,
            "codex.context_window": None,
            "codex.auto_compact_token_limit": None,
            "codex.approval_policy": None,
            "codex.sandbox": None,
            "codex.reasoning_effort": None,
            "codex.tool_output_token_limit": None,
            "codex.web_search": None,
            "codex.subagents.max_threads": None,
            "codex.subagents.max_depth": None,
            "codex.subagents.job_max_runtime_seconds": None,
        },
        "plugin_codex_agents": [],
    }
    codex = {
        "base": {
            "model": "gpt-5.5",
            "model_context_window": None,
            "model_auto_compact_token_limit": None,
            "approval_policy": None,
            "sandbox_mode": None,
            "model_reasoning_effort": None,
            "tool_output_token_limit": None,
            "web_search": None,
        },
        "agents_config": {},
        "tmup_agents": [],
        "model_migrations": {},
    }
    opencode = {"tmup_agents": []}
    mentions = {"totals": {}, "files": []}
    findings = build_findings(tmup, codex, opencode, mentions, yq_present=True)
    kinds = {f["kind"] for f in findings}
    assert "policy_model_pin_differs_from_codex_base" in kinds
    pin_finding = next(f for f in findings if f["kind"] == "policy_model_pin_differs_from_codex_base")
    assert pin_finding["severity"] == "warn"
    assert pin_finding["tmup_value"] == "gpt-5.3-codex"
    assert pin_finding["codex_value"] == "gpt-5.5"


def test_build_findings_yq_absent_produces_warn():
    tmup = {
        "values": {
            "codex.model": None,
            "codex.model_preference": None,
            "codex.context_window": None,
            "codex.auto_compact_token_limit": None,
            "codex.approval_policy": None,
            "codex.sandbox": None,
            "codex.reasoning_effort": None,
            "codex.tool_output_token_limit": None,
            "codex.web_search": None,
            "codex.subagents.max_threads": None,
            "codex.subagents.max_depth": None,
            "codex.subagents.job_max_runtime_seconds": None,
        },
        "plugin_codex_agents": [],
    }
    codex = {
        "base": {
            "model": None,
            "model_context_window": None,
            "model_auto_compact_token_limit": None,
            "approval_policy": None,
            "sandbox_mode": None,
            "model_reasoning_effort": None,
            "tool_output_token_limit": None,
            "web_search": None,
        },
        "agents_config": {},
        "tmup_agents": [],
        "model_migrations": {},
    }
    opencode = {"tmup_agents": []}
    mentions = {"totals": {}, "files": []}
    findings = build_findings(tmup, codex, opencode, mentions, yq_present=False)
    yq_finding = next(f for f in findings if f["kind"] == "tmup_policy_yaml_loader_state")
    assert yq_finding["severity"] == "warn"
    assert yq_finding["yq_present"] is False


def test_build_findings_opencode_tmup_agents_present():
    tmup = {
        "values": {k: None for k in [
            "codex.model", "codex.model_preference", "codex.context_window",
            "codex.auto_compact_token_limit", "codex.approval_policy", "codex.sandbox",
            "codex.reasoning_effort", "codex.tool_output_token_limit", "codex.web_search",
            "codex.subagents.max_threads", "codex.subagents.max_depth",
            "codex.subagents.job_max_runtime_seconds",
        ]},
        "plugin_codex_agents": [],
    }
    codex = {
        "base": {k: None for k in [
            "model", "model_context_window", "model_auto_compact_token_limit",
            "approval_policy", "sandbox_mode", "model_reasoning_effort",
            "tool_output_token_limit", "web_search",
        ]},
        "agents_config": {},
        "tmup_agents": [],
        "model_migrations": {},
    }
    opencode = {
        "tmup_agents": [
            {"has_model_pin": True, "permission_edit": "deny", "permission_bash": "ask"},
            {"has_model_pin": False, "permission_edit": "allow", "permission_bash": "deny"},
        ]
    }
    mentions = {"totals": {}, "files": []}
    findings = build_findings(tmup, codex, opencode, mentions, yq_present=None)
    kinds = {f["kind"] for f in findings}
    assert "opencode_tmup_agents_present" in kinds
    oc_finding = next(f for f in findings if f["kind"] == "opencode_tmup_agents_present")
    assert oc_finding["count"] == 2
    assert oc_finding["model_pin_count"] == 1


def test_build_findings_legacy_doc_models_in_mentions():
    # gpt-* mentions in selected files when codex base model differs produce legacy finding
    tmup = {
        "values": {k: None for k in [
            "codex.model", "codex.model_preference", "codex.context_window",
            "codex.auto_compact_token_limit", "codex.approval_policy", "codex.sandbox",
            "codex.reasoning_effort", "codex.tool_output_token_limit", "codex.web_search",
            "codex.subagents.max_threads", "codex.subagents.max_depth",
            "codex.subagents.job_max_runtime_seconds",
        ]},
        "plugin_codex_agents": [],
    }
    codex = {
        "base": {
            "model": "gpt-5.5",
            **{k: None for k in [
                "model_context_window", "model_auto_compact_token_limit",
                "approval_policy", "sandbox_mode", "model_reasoning_effort",
                "tool_output_token_limit", "web_search",
            ]},
        },
        "agents_config": {},
        "tmup_agents": [],
        "model_migrations": {},
    }
    opencode = {"tmup_agents": []}
    mentions = {"totals": {"gpt-4": 3, "gpt-5.5": 1}, "files": []}
    findings = build_findings(tmup, codex, opencode, mentions, yq_present=True)
    kinds = {f["kind"] for f in findings}
    assert "tmup_selected_files_legacy_model_mentions" in kinds
    leg = next(f for f in findings if f["kind"] == "tmup_selected_files_legacy_model_mentions")
    assert "gpt-4" in leg["models"]
    assert leg["mention_counts"]["gpt-4"] == 3


def test_build_findings_policy_model_preference_contains_codex_base():
    tmup = {
        "values": {
            "codex.model": "auto",
            "codex.model_preference": ["gpt-5.5", "gpt-5.3-codex"],
            **{k: None for k in [
                "codex.context_window", "codex.auto_compact_token_limit",
                "codex.approval_policy", "codex.sandbox", "codex.reasoning_effort",
                "codex.tool_output_token_limit", "codex.web_search",
                "codex.subagents.max_threads", "codex.subagents.max_depth",
                "codex.subagents.job_max_runtime_seconds",
            ]},
        },
        "plugin_codex_agents": [],
    }
    codex = {
        "base": {
            "model": "gpt-5.5",
            **{k: None for k in [
                "model_context_window", "model_auto_compact_token_limit",
                "approval_policy", "sandbox_mode", "model_reasoning_effort",
                "tool_output_token_limit", "web_search",
            ]},
        },
        "agents_config": {},
        "tmup_agents": [],
        "model_migrations": {},
    }
    opencode = {"tmup_agents": []}
    mentions = {"totals": {}, "files": []}
    findings = build_findings(tmup, codex, opencode, mentions, yq_present=True)
    kinds = {f["kind"] for f in findings}
    assert "policy_model_auto_tracks_codex_config" in kinds
    assert "policy_model_preference_contains_codex_base" in kinds


# ---------------------------------------------------------------------------
# summarize_tmup_policy — all-absent case (plugin root missing)
# ---------------------------------------------------------------------------

def test_summarize_tmup_policy_missing_plugin_root():
    missing = Path("/nonexistent/tmup-plugin-root")
    result = summarize_tmup_policy(missing)
    assert result["policy"]["exists"] is False
    assert result["plugin_codex_agents"] == []
    # All values should be None because policy.yaml doesn't exist
    for v in result["values"].values():
        assert v is None


# ---------------------------------------------------------------------------
# summarize_opencode_config — missing opencode.json and missing agents dir
# ---------------------------------------------------------------------------

def test_summarize_opencode_config_missing_root():
    missing = Path("/nonexistent/opencode")
    result = summarize_opencode_config(missing)
    assert result["config"]["exists"] is False
    assert result["mcp_count"] == 0
    assert result["mcp_names"] == []
    assert result["plugin_count"] == 0
    assert result["tmup_agents"] == []


def test_summarize_opencode_config_malformed_json():
    with tempfile.TemporaryDirectory() as td:
        opencode_root = Path(td)
        (opencode_root / "opencode.json").write_text("{broken json", encoding="utf-8")
        result = summarize_opencode_config(opencode_root)
        # load_json returns {"_error": ...} on parse failure; model etc. will be None
        assert result["model"] is None
        assert result["mcp_count"] == 0


# ---------------------------------------------------------------------------
# summarize_opencode_agent — model pin detection
# ---------------------------------------------------------------------------

def test_summarize_opencode_agent_with_model_pin():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        agent_path = root / "tmup-tier1.md"
        agent_path.write_text(
            "---\nmodel: gpt-5.5\ndescription: pinned agent\nmode: subagent\n---\nbody\n",
            encoding="utf-8",
        )
        result = summarize_opencode_agent(agent_path, root)
        assert result["has_model_pin"] is True
        assert result["agent_id"] == "tmup-tier1"


def test_summarize_opencode_agent_without_model_pin():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        agent_path = root / "tmup-tier2.md"
        agent_path.write_text(
            "---\ndescription: no pin\nmode: subagent\n---\nbody\n",
            encoding="utf-8",
        )
        result = summarize_opencode_agent(agent_path, root)
        assert result["has_model_pin"] is False


# ---------------------------------------------------------------------------
# summarize_toml_agent — parse error is passed through, missing file
# ---------------------------------------------------------------------------

def test_summarize_toml_agent_malformed_toml_captures_error():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        bad = root / "bad.toml"
        bad.write_bytes(b"[broken\nkey=oops\n")
        result = summarize_toml_agent(bad, root)
        assert result["parse_error"] is not None
        assert "Error" in result["parse_error"]


def test_summarize_toml_agent_missing_file():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        missing = root / "missing.toml"
        result = summarize_toml_agent(missing, root)
        assert result["exists"] is False
        assert result["parse_error"] is None


# ---------------------------------------------------------------------------
# CLI e2e — no --skip-version-commands (runs version detection path)
# But we can't actually call codex/opencode so we mock with absent tools.
# We test this via subprocess with the real probe — coverage captured by the
# existing CLI test. Additional: test --pretty vs non-pretty output shape.
# ---------------------------------------------------------------------------

def test_cli_non_pretty_output_is_compact_json():
    with tempfile.TemporaryDirectory(prefix="tmup-policy-diff-secret-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))
        result = subprocess.run(
            [
                sys.executable,
                str(PROBE_PATH),
                "--plugin-root", str(plugin),
                "--codex-root", str(codex),
                "--opencode-root", str(opencode),
                "--skip-version-commands",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        # compact: no leading indent spaces
        lines = result.stdout.strip().splitlines()
        assert len(lines) == 1, "Non-pretty output should be a single line"
        report = json.loads(result.stdout)
        assert report["schema"] == "agent-runtime-tmup-policy-runtime-diff"


def test_cli_broken_pipe_exits_cleanly():
    """Pipe output through `head -c 1` to trigger BrokenPipeError in the probe."""
    with tempfile.TemporaryDirectory(prefix="tmup-brokenpipe-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))
        proc = subprocess.run(
            "python3 {} --plugin-root {} --codex-root {} --opencode-root {} "
            "--skip-version-commands | head -c 1".format(
                str(PROBE_PATH), str(plugin), str(codex), str(opencode)
            ),
            shell=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        # The probe should not crash with a traceback — rc 0 or 1 are both ok
        # (head exits 0, the probe may get SIGPIPE or BrokenPipeError)
        assert proc.returncode in (0, 1, 141), f"Unexpected rc={proc.returncode}"
        assert "Traceback" not in proc.stderr


# ---------------------------------------------------------------------------
# build_report — empty/missing roots produce valid schema
# ---------------------------------------------------------------------------

def test_build_report_all_missing_roots_still_valid_schema():
    missing_plugin = Path("/nonexistent/plugin")
    missing_codex = Path("/nonexistent/codex")
    missing_opencode = Path("/nonexistent/opencode")
    report = build_report(missing_plugin, missing_codex, missing_opencode, skip_versions=True)
    assert report["schema"] == "agent-runtime-tmup-policy-runtime-diff"
    assert report["schema_version"] == "0.1"
    assert "findings" in report
    assert "verdict" in report
    assert isinstance(report["findings"], list)


# ---------------------------------------------------------------------------
# main() via redirect_stdout (covers the main() body not hit by CLI subprocess)
# ---------------------------------------------------------------------------

def test_main_emits_valid_json_to_stdout():
    with tempfile.TemporaryDirectory(prefix="tmup-main-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))
        orig_argv = sys.argv[:]
        sys.argv = [
            "tmup_policy_runtime_diff.py",
            "--plugin-root", str(plugin),
            "--codex-root", str(codex),
            "--opencode-root", str(opencode),
            "--skip-version-commands",
        ]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig_argv
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["schema"] == "agent-runtime-tmup-policy-runtime-diff"


def test_main_pretty_flag_produces_indented_output():
    with tempfile.TemporaryDirectory(prefix="tmup-main-pretty-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))
        orig_argv = sys.argv[:]
        sys.argv = [
            "tmup_policy_runtime_diff.py",
            "--plugin-root", str(plugin),
            "--codex-root", str(codex),
            "--opencode-root", str(opencode),
            "--skip-version-commands",
            "--pretty",
        ]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig_argv
        assert rc == 0
        output = buf.getvalue()
        # Pretty output should have newlines with indentation
        assert "\n  " in output
        report = json.loads(output)
        assert report["schema"] == "agent-runtime-tmup-policy-runtime-diff"


def test_main_broken_pipe_on_write_exits_cleanly():
    """Simulate BrokenPipeError from json.dump -> main() catches and returns 0."""
    with tempfile.TemporaryDirectory(prefix="tmup-brokenpipe-main-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))

        class _BrokenStdout:
            def write(self, data):
                raise BrokenPipeError("simulated broken pipe")
            def flush(self):
                pass
            def close(self):
                pass  # close succeeds

        orig_stdout = sys.stdout
        orig_argv = sys.argv[:]
        sys.argv = [
            "tmup_policy_runtime_diff.py",
            "--plugin-root", str(plugin),
            "--codex-root", str(codex),
            "--opencode-root", str(opencode),
            "--skip-version-commands",
        ]
        sys.stdout = _BrokenStdout()
        try:
            rc = probe.main()
        finally:
            sys.stdout = orig_stdout
            sys.argv = orig_argv
        assert rc == 0


def test_main_broken_pipe_with_os_error_on_close_returns_1():
    """Simulate BrokenPipeError + OSError on close -> main() returns 1."""
    with tempfile.TemporaryDirectory(prefix="tmup-brokenpipe-oserror-") as tmp_dir:
        plugin, codex, opencode = write_fixture_roots(Path(tmp_dir))

        class _FailCloseStdout:
            def write(self, data):
                raise BrokenPipeError("simulated broken pipe")
            def flush(self):
                pass
            def close(self):
                raise OSError("cannot close stdout")

        orig_stdout = sys.stdout
        orig_argv = sys.argv[:]
        sys.argv = [
            "tmup_policy_runtime_diff.py",
            "--plugin-root", str(plugin),
            "--codex-root", str(codex),
            "--opencode-root", str(opencode),
            "--skip-version-commands",
        ]
        sys.stdout = _FailCloseStdout()
        try:
            rc = probe.main()
        finally:
            sys.stdout = orig_stdout
            sys.argv = orig_argv
        assert rc == 1


# ---------------------------------------------------------------------------
# __main__ runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} tmup policy/runtime diff tests passed")
