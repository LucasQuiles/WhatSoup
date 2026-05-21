import importlib.util
import json
import os
import pathlib
import subprocess
import sys


PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT_PATH = PLUGIN_ROOT / "scripts" / "fix-playwright-config.py"


def config_path(home: pathlib.Path) -> pathlib.Path:
    return home / ".config" / "playwright-mcp" / "config.json"


def run_script(home: pathlib.Path):
    env = os.environ.copy()
    env["HOME"] = str(home)
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH)],
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def write_config(home: pathlib.Path, data: dict) -> pathlib.Path:
    path = config_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def read_stdout(result: subprocess.CompletedProcess[str]) -> dict:
    assert result.stdout
    return json.loads(result.stdout)


def assert_intended_values(data: dict) -> None:
    assert data["snapshot"]["mode"] == "full"
    assert data["output"]["mode"] == "file"
    assert data["console"]["level"] == "warning"


def test_absent_config_is_noop_and_does_not_create_file(tmp_path):
    result = run_script(tmp_path)

    assert result.returncode == 0
    assert read_stdout(result) == {
        "changed": False,
        "reason": "no playwright-mcp config found",
    }
    assert not config_path(tmp_path).exists()


def test_stale_snapshot_only_rewrites_all_three_values_and_preserves_unrelated_keys(tmp_path):
    path = write_config(
        tmp_path,
        {
            "snapshot": {"mode": "incremental", "keep": True},
            "output": {"mode": "file"},
            "console": {"level": "warning"},
            "browser": {"channel": "chrome"},
        },
    )

    result = run_script(tmp_path)

    assert result.returncode == 0
    assert read_stdout(result) == {"changed": True}
    data = json.loads(path.read_text(encoding="utf-8"))
    assert_intended_values(data)
    assert data["snapshot"]["keep"] is True
    assert data["browser"] == {"channel": "chrome"}


def test_wrong_output_only_rewrites_all_three_values(tmp_path):
    path = write_config(
        tmp_path,
        {
            "snapshot": {"mode": "full"},
            "output": {"mode": "inline"},
            "console": {"level": "warning"},
        },
    )

    result = run_script(tmp_path)

    assert result.returncode == 0
    assert read_stdout(result) == {"changed": True}
    assert_intended_values(json.loads(path.read_text(encoding="utf-8")))


def test_wrong_console_only_rewrites_all_three_values(tmp_path):
    path = write_config(
        tmp_path,
        {
            "snapshot": {"mode": "full"},
            "output": {"mode": "file"},
            "console": {"level": "info"},
        },
    )

    result = run_script(tmp_path)

    assert result.returncode == 0
    assert read_stdout(result) == {"changed": True}
    assert_intended_values(json.loads(path.read_text(encoding="utf-8")))


def test_all_three_stale_rewrites_all_three_values(tmp_path):
    path = write_config(
        tmp_path,
        {
            "snapshot": {"mode": "incremental"},
            "output": {"mode": "inline"},
            "console": {"level": "debug"},
        },
    )

    result = run_script(tmp_path)

    assert result.returncode == 0
    assert read_stdout(result) == {"changed": True}
    assert_intended_values(json.loads(path.read_text(encoding="utf-8")))


def test_already_correct_config_is_noop_and_preserves_file_bytes(tmp_path):
    path = write_config(
        tmp_path,
        {
            "snapshot": {"mode": "full"},
            "output": {"mode": "file"},
            "console": {"level": "warning"},
            "unrelated": {"kept": True},
        },
    )
    before = path.read_bytes()

    result = run_script(tmp_path)

    assert result.returncode == 0
    assert read_stdout(result) == {"changed": False}
    assert path.read_bytes() == before


def test_invalid_json_reports_noop_and_leaves_file_unchanged(tmp_path):
    path = config_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json}\n", encoding="utf-8")

    result = run_script(tmp_path)

    assert result.returncode == 0
    assert read_stdout(result)["changed"] is False
    assert read_stdout(result)["reason"].startswith("invalid playwright-mcp config JSON")
    assert path.read_text(encoding="utf-8") == "{not json}\n"


def test_present_but_unwritable_config_fails_only_when_write_is_needed(tmp_path):
    path = write_config(
        tmp_path,
        {
            "snapshot": {"mode": "incremental"},
            "output": {"mode": "file"},
            "console": {"level": "warning"},
        },
    )
    path.parent.chmod(0o500)
    try:
        result = run_script(tmp_path)
    finally:
        path.parent.chmod(0o700)

    assert result.returncode != 0
    assert read_stdout(result)["changed"] is False
    assert read_stdout(result)["reason"].startswith("failed to write playwright-mcp config")


def test_atomic_write_uses_tempfile_in_target_directory(tmp_path):
    spec = importlib.util.spec_from_file_location("fix_playwright_config", SCRIPT_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    path = write_config(tmp_path, {"snapshot": {"mode": "incremental"}})
    seen_dirs = []
    real_named_temporary_file = module.tempfile.NamedTemporaryFile

    def tracking_named_temporary_file(*args, **kwargs):
        seen_dirs.append(kwargs.get("dir"))
        return real_named_temporary_file(*args, **kwargs)

    module.tempfile.NamedTemporaryFile = tracking_named_temporary_file
    try:
        module.write_atomic(path, {"snapshot": {"mode": "full"}})
    finally:
        module.tempfile.NamedTemporaryFile = real_named_temporary_file

    assert seen_dirs == [str(path.parent)]
