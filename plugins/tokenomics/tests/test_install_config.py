import importlib.util
import json
import pathlib

INSTALL_CONFIG_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "lib" / "install_config.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("install_config", INSTALL_CONFIG_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_load_install_config_valid(tmp_path):
    module = _load_module()
    cfg_path = tmp_path / "cfg.json"
    cfg_path.write_text(json.dumps({
        "bot": "ml-bot",
        "instance_path": str(tmp_path / "instance"),
        "ceiling": 103000000,
        "cooldown_seconds": 1800,
        "whatsoup_repo": str(tmp_path / "WhatSoup"),
        "plugin_root": str(tmp_path / "plugins/tokenomics"),
    }), encoding="utf-8")

    cfg = module.load_install_config(cfg_path)

    assert isinstance(cfg, module.InstallConfig)
    assert cfg.bot == "ml-bot"
    assert cfg.ceiling == 103000000
    assert cfg.cooldown_seconds == 1800
    assert cfg.instance_path == pathlib.Path(str(tmp_path / "instance")).resolve()


def test_load_install_config_rejects_missing_bot(tmp_path):
    module = _load_module()
    cfg_path = tmp_path / "cfg.json"
    cfg_path.write_text(json.dumps({"ceiling": 100}), encoding="utf-8")

    try:
        module.load_install_config(cfg_path)
    except module.InstallConfigError as err:
        assert "bot" in str(err)
    else:
        raise AssertionError("missing bot should raise InstallConfigError")


def test_load_install_config_rejects_path_injection_in_bot_name(tmp_path):
    module = _load_module()
    cfg_path = tmp_path / "cfg.json"
    cfg_path.write_text(json.dumps({
        "bot": "../../etc/passwd",
        "instance_path": "/tmp/i",
        "ceiling": 100,
        "cooldown_seconds": 60,
        "whatsoup_repo": "/tmp/w",
        "plugin_root": "/tmp/p",
    }), encoding="utf-8")

    try:
        module.load_install_config(cfg_path)
    except module.InstallConfigError as err:
        assert "bot" in str(err).lower()
    else:
        raise AssertionError("path-injection bot name should fail validation")


def test_load_install_config_rejects_non_object_root(tmp_path):
    module = _load_module()
    cfg_path = tmp_path / "cfg.json"
    cfg_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")

    try:
        module.load_install_config(cfg_path)
    except module.InstallConfigError as err:
        assert "object" in str(err).lower()
    else:
        raise AssertionError("array root should fail validation")


def test_load_install_config_coerces_paths_to_resolved(tmp_path):
    module = _load_module()
    cfg_path = tmp_path / "cfg.json"
    cfg_path.write_text(json.dumps({
        "bot": "ml-bot",
        "instance_path": str(tmp_path / "instance" / ".." / "instance"),
        "ceiling": 100,
        "cooldown_seconds": 60,
        "whatsoup_repo": str(tmp_path / "WhatSoup"),
        "plugin_root": str(tmp_path / "p"),
    }), encoding="utf-8")

    cfg = module.load_install_config(cfg_path)

    # Resolved paths normalize the .. segment
    assert ".." not in str(cfg.instance_path)
