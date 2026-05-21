import json
import pathlib


PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
HOOKS_PATH = PLUGIN_ROOT / "hooks" / "hooks.json"
MANIFEST_PATH = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"


def test_hooks_json_registers_only_browser_loop_interrupt():
    config = json.loads(HOOKS_PATH.read_text(encoding="utf-8"))

    assert sorted(config.keys()) == ["hooks"]
    assert sorted(config["hooks"].keys()) == ["PreToolUse"]

    entries = config["hooks"]["PreToolUse"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["matcher"] == "mcp__superpowers-chrome_chrome__use_browser"
    assert "playwright" not in entry["matcher"]

    hooks = entry["hooks"]
    assert len(hooks) == 1
    command = hooks[0]["command"]
    assert hooks[0]["type"] == "command"
    assert hooks[0]["timeout"] == 5
    assert "TOKENOMICS_BOT" not in command
    assert "target bot" not in command
    assert "${CLAUDE_PLUGIN_ROOT}" in command
    assert "browser-loop-interrupt.py" in command


def test_plugin_manifest_does_not_duplicate_hook_registration():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert "hooks" not in manifest
