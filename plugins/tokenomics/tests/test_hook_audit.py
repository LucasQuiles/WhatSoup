import importlib.util
import json
import pathlib
import pytest

HOOK_AUDIT_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "lib" / "hook_audit.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("hook_audit", HOOK_AUDIT_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


# ---- scan_settings_json ----------------------------------------------------

def test_scan_settings_json_missing_file_returns_empty(tmp_path):
    module = _load_module()
    assert module.scan_settings_json(tmp_path / "absent.json") == []


def test_scan_settings_json_no_hooks_section_returns_empty(tmp_path):
    module = _load_module()
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"unrelated": True}), encoding="utf-8")
    assert module.scan_settings_json(p) == []


def test_scan_settings_json_no_browser_matcher_returns_empty(tmp_path):
    module = _load_module()
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({
        "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "x"}]}]}
    }), encoding="utf-8")
    assert module.scan_settings_json(p) == []


def test_scan_settings_json_literal_browser_matcher_is_conflict(tmp_path):
    module = _load_module()
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__use_browser",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")
    records = module.scan_settings_json(p)
    assert len(records) == 1
    assert records[0].surface == "settings"
    assert records[0].path == str(p)


def test_scan_settings_json_regex_matcher_matching_browser_is_conflict(tmp_path):
    module = _load_module()
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__.*",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")
    records = module.scan_settings_json(p)
    assert len(records) == 1


def test_scan_settings_json_invalid_regex_falls_back_to_substring(tmp_path):
    module = _load_module()
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__use_browser[",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")
    records = module.scan_settings_json(p)
    assert len(records) == 1


def test_scan_settings_json_only_inspects_pretooluse(tmp_path):
    module = _load_module()
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({
        "hooks": {"PostToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__use_browser",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")
    assert module.scan_settings_json(p) == []


def test_scan_settings_json_malformed_json_fails_closed(tmp_path):
    module = _load_module()
    p = tmp_path / "settings.json"
    p.write_text("not json", encoding="utf-8")
    with pytest.raises(module.HookAuditError) as exc_info:
        module.scan_settings_json(p)
    assert exc_info.value.path == str(p)
    assert exc_info.value.surface == "settings"
    assert "malformed JSON" in str(exc_info.value)


# ---- scan_hookify_file -----------------------------------------------------

def test_scan_hookify_file_missing_returns_empty(tmp_path):
    module = _load_module()
    assert module.scan_hookify_file(tmp_path / "absent.local.md") == []


def test_scan_hookify_file_no_browser_mention_returns_empty(tmp_path):
    module = _load_module()
    p = tmp_path / "rule.local.md"
    p.write_text("---\nname: x\nevent: bash\npattern: rm\naction: warn\n---\nbody\n", encoding="utf-8")
    assert module.scan_hookify_file(p) == []


def test_scan_hookify_file_mentions_browser_tool_is_conflict(tmp_path):
    module = _load_module()
    p = tmp_path / "rule.local.md"
    p.write_text(
        "---\nname: x\nevent: tool_use:mcp__superpowers-chrome_chrome__use_browser\n"
        "pattern: .\naction: warn\n---\nbody\n",
        encoding="utf-8",
    )
    records = module.scan_hookify_file(p)
    assert len(records) == 1
    assert records[0].surface == "hookify"
    assert records[0].path == str(p)


# ---- scan_plugin_hooks_json -----------------------------------------------

def test_scan_plugin_hooks_json_browser_matcher_tagged_plugin(tmp_path):
    module = _load_module()
    p = tmp_path / "other-plugin" / "hooks" / "hooks.json"
    p.parent.mkdir(parents=True)
    p.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__use_browser",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")
    records = module.scan_plugin_hooks_json(p)
    assert len(records) == 1
    assert records[0].surface == "plugin"


def test_scan_plugin_hooks_json_malformed_json_fails_closed(tmp_path):
    module = _load_module()
    p = tmp_path / "other-plugin" / "hooks" / "hooks.json"
    p.parent.mkdir(parents=True)
    p.write_text("{", encoding="utf-8")
    with pytest.raises(module.HookAuditError) as exc_info:
        module.scan_plugin_hooks_json(p)
    assert exc_info.value.path == str(p)
    assert exc_info.value.surface == "plugin"


# ---- audit_hook_surfaces ---------------------------------------------------

def test_audit_excludes_own_plugin_hooks_json(tmp_path):
    module = _load_module()
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"hooks": {}}), encoding="utf-8")

    own_hooks = tmp_path / "tokenomics" / "hooks" / "hooks.json"
    own_hooks.parent.mkdir(parents=True)
    own_hooks.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__use_browser",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")

    records = module.audit_hook_surfaces(
        settings_paths=[settings],
        hookify_paths=[],
        plugin_hooks_paths=[own_hooks],
        exclude_paths=[own_hooks],
    )
    assert records == []


def test_audit_aggregates_conflicts_from_all_three_surfaces(tmp_path):
    module = _load_module()
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__use_browser",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")

    hookify = tmp_path / "hookify.x.local.md"
    hookify.write_text(
        "---\nname: x\nevent: tool_use:mcp__superpowers-chrome_chrome__use_browser\n"
        "pattern: .\naction: warn\n---\n",
        encoding="utf-8",
    )

    other = tmp_path / "other" / "hooks" / "hooks.json"
    other.parent.mkdir(parents=True)
    other.write_text(json.dumps({
        "hooks": {"PreToolUse": [{
            "matcher": "mcp__superpowers-chrome_chrome__use_browser",
            "hooks": [{"type": "command", "command": "x"}],
        }]}
    }), encoding="utf-8")

    records = module.audit_hook_surfaces(
        settings_paths=[settings],
        hookify_paths=[hookify],
        plugin_hooks_paths=[other],
        exclude_paths=[],
    )
    surfaces = sorted(r.surface for r in records)
    assert surfaces == ["hookify", "plugin", "settings"]


# ---- require_no_conflict ---------------------------------------------------

def test_require_no_conflict_empty_returns_none():
    module = _load_module()
    result = module.require_no_conflict([])
    assert result is None


def test_require_no_conflict_raises_with_records_attached():
    module = _load_module()
    rec = module.ConflictRecord(path="/p", surface="settings", detail="d")
    with pytest.raises(module.HookConflict) as exc_info:
        module.require_no_conflict([rec])
    assert exc_info.value.conflicts == [rec]
    assert "/p" in str(exc_info.value)
