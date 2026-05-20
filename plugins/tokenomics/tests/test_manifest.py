import json
import pathlib


PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
MANIFEST_PATH = PLUGIN_ROOT / ".claude-plugin" / "plugin.json"


def test_manifest_declares_tokenomics_source():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert manifest["name"] == "tokenomics"
    assert manifest["version"] == "0.1.0"
    assert (
        manifest["description"]
        == "Token budget watchdog, browser-loop interrupt, instruction-surface gates, and observability for WhatSoup bot instances."
    )
    assert manifest["sourceRepo"] == "LAB/WhatSoup/plugins/tokenomics"
    assert "hooks" not in manifest


def test_v1_scaffold_directories_are_empty_placeholders():
    for dirname in ("lib", "launchd"):
        directory = PLUGIN_ROOT / dirname
        assert directory.is_dir()
        assert sorted(path.name for path in directory.iterdir()) == [".gitkeep"]
