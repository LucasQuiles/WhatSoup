"""T04 strict, private configuration loading contracts."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from typing import Any

import pytest
from qsesh.config import (
    ConfigError,
    QseshConfig,
    SourceConfig,
    canonical_config_bytes,
    load_config,
)
from qsesh.paths import QseshPaths, ensure_private_dir

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _paths(tmp_path: Path) -> QseshPaths:
    return QseshPaths.from_env(
        {
            "XDG_CONFIG_HOME": str(tmp_path / "config-root"),
            "XDG_DATA_HOME": str(tmp_path / "data-root"),
            "XDG_CACHE_HOME": str(tmp_path / "cache-root"),
        },
        tmp_path / "home",
    )


def _valid_payload(tmp_path: Path) -> dict[str, Any]:
    return {
        "host_id": "host-test-001",
        "sources": [
            {"harness": "claude", "root": str(tmp_path / "sources/claude")},
            {"harness": "codex", "root": str(tmp_path / "sources/codex")},
            {
                "harness": "opencode",
                "root": str(tmp_path / "sources/opencode/opencode.db"),
            },
        ],
        "live_window_us": 600_000_000,
        "opencode_bin": str(tmp_path / "bin/opencode"),
    }


def _write_config(paths: QseshPaths, payload: object, *, mode: int = 0o600) -> None:
    ensure_private_dir(paths.config_file.parent)
    paths.config_file.write_text(json.dumps(payload), encoding="utf-8")
    paths.config_file.chmod(mode)


def _expect_config_error(
    paths: QseshPaths,
    payload: object,
    *,
    field: str,
    mode: int = 0o600,
) -> ConfigError:
    _write_config(paths, payload, mode=mode)
    with pytest.raises(ConfigError) as caught:
        load_config(paths)
    assert caught.value.code == "QS-E-CONFIG"
    assert caught.value.field == field
    assert str(caught.value) == f"qSesh configuration failed validation at {field}"
    return caught.value


def test_exact_valid_config_loads_frozen_normalized_values(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    _write_config(paths, payload)

    config = load_config(paths)

    assert config == QseshConfig(
        host_id="host-test-001",
        sources=(
            SourceConfig("claude", (tmp_path / "sources/claude").resolve()),
            SourceConfig("codex", (tmp_path / "sources/codex").resolve()),
            SourceConfig(
                "opencode", (tmp_path / "sources/opencode/opencode.db").resolve()
            ),
        ),
        live_window_us=600_000_000,
        opencode_bin=(tmp_path / "bin/opencode").resolve(),
    )
    with pytest.raises(FrozenInstanceError):
        config.host_id = "changed"  # type: ignore[misc]


def test_live_window_uses_the_documented_default(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    del payload["live_window_us"]
    _write_config(paths, payload)

    assert load_config(paths).live_window_us == 600_000_000


def test_config_file_is_derived_beneath_the_injected_config_root(
    tmp_path: Path,
) -> None:
    paths = _paths(tmp_path)

    assert paths.config_file == (tmp_path / "config-root/qsesh/config.json").resolve()
    assert paths.config_file.parent == paths.config_dir


def test_missing_host_fails_without_hostname_fallback(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    del payload["host_id"]

    error = _expect_config_error(paths, payload, field="host_id")
    assert error.field == "host_id"


def test_missing_config_fails_without_hostname_fallback(tmp_path: Path) -> None:
    paths = _paths(tmp_path)

    with pytest.raises(ConfigError) as caught:
        load_config(paths)

    assert caught.value.code == "QS-E-CONFIG"
    assert caught.value.field == "config_file"
    assert str(tmp_path) not in str(caught.value)


def test_mixed_case_mutable_hostname_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["host_id"] = "Mutable-MDNS-Host"

    error = _expect_config_error(paths, payload, field="host_id")
    assert "Mutable-MDNS-Host" not in str(error)


def test_private_label_canary_never_appears_in_the_error(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    canary = "PRIVATE-LABEL-CANARY-9X"
    payload["host_id"] = canary

    error = _expect_config_error(paths, payload, field="host_id")
    assert canary not in str(error)


def test_unknown_harness_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"][0]["harness"] = "future-harness"

    error = _expect_config_error(paths, payload, field="sources.harness")
    assert error.field == "sources.harness"


def test_duplicate_source_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"][1]["harness"] = "claude"

    error = _expect_config_error(paths, payload, field="sources.duplicate")
    assert error.field == "sources.duplicate"


def test_nonabsolute_source_root_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"][0]["root"] = "relative/source"

    error = _expect_config_error(paths, payload, field="sources.root")
    assert error.field == "sources.root"


def test_wrong_top_level_type_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)

    error = _expect_config_error(paths, [], field="config")
    assert error.field == "config"


def test_wrong_field_type_is_rejected_without_boolean_integer_coercion(
    tmp_path: Path,
) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["live_window_us"] = True

    error = _expect_config_error(paths, payload, field="live_window_us")
    assert error.field == "live_window_us"


def test_unknown_top_level_key_is_rejected_without_echoing_it(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["SECRET_UNKNOWN_CANARY"] = "must-not-leak"

    error = _expect_config_error(paths, payload, field="config.unknown_key")
    assert "SECRET_UNKNOWN_CANARY" not in str(error)
    assert "must-not-leak" not in str(error)


def test_unknown_source_key_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"][0]["extra"] = "must-not-leak"

    error = _expect_config_error(paths, payload, field="sources.unknown_key")
    assert "must-not-leak" not in str(error)


def test_missing_required_source_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"].pop()

    error = _expect_config_error(paths, payload, field="sources.required")
    assert error.field == "sources.required"


def test_opencode_source_requires_an_explicit_root(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    del payload["sources"][2]["root"]

    error = _expect_config_error(paths, payload, field="sources.root")
    assert error.field == "sources.root"


@pytest.mark.parametrize(
    "root",
    [
        "opencode.db",
        "~/.local/share/opencode/opencode.db",
    ],
)
def test_opencode_source_root_must_be_absolute(tmp_path: Path, root: str) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"][2]["root"] = root

    error = _expect_config_error(paths, payload, field="sources.root")
    assert error.field == "sources.root"


@pytest.mark.parametrize("basename", ["opencode", "opencode.sqlite", "OpenCode.db"])
def test_opencode_source_root_must_end_in_exact_database_name(
    tmp_path: Path, basename: str
) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"][2]["root"] = str(tmp_path / "sources/opencode" / basename)

    error = _expect_config_error(paths, payload, field="sources.root")
    assert error.field == "sources.root"


def test_missing_opencode_root_does_not_invoke_cli_discovery(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    del payload["sources"][2]["root"]
    sentinel = tmp_path / "cli-was-invoked"
    binary = Path(payload["opencode_bin"])
    binary.parent.mkdir(parents=True)
    binary.write_text(f"#!/bin/sh\ntouch {sentinel}\n", encoding="utf-8")
    binary.chmod(0o700)

    _expect_config_error(paths, payload, field="sources.root")

    assert not sentinel.exists()


def test_config_does_not_resolve_or_probe_source_roots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    _write_config(paths, payload)
    source_prefix = str(tmp_path / "sources")
    original_resolve = Path.resolve

    def reject_source_resolve(path: Path, *args: object, **kwargs: object) -> Path:
        if str(path).startswith(source_prefix):
            raise AssertionError("config parsing probed a source path")
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", reject_source_resolve)

    config = load_config(paths)

    assert config.sources[2].root == tmp_path / "sources/opencode/opencode.db"


def test_relative_opencode_binary_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["opencode_bin"] = "opencode"

    error = _expect_config_error(paths, payload, field="opencode_bin")
    assert error.field == "opencode_bin"


def test_relative_data_root_is_rejected_before_reading_config(tmp_path: Path) -> None:
    paths = replace(_paths(tmp_path), data_dir=Path("relative/data"))

    with pytest.raises(ConfigError) as caught:
        load_config(paths)

    assert caught.value.field == "data_root"
    assert not paths.config_file.exists()


def test_mode_broader_than_0600_is_rejected(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)

    error = _expect_config_error(paths, payload, field="config_mode", mode=0o640)
    assert error.field == "config_mode"


def test_symlinked_config_is_rejected_without_reading_referent(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    ensure_private_dir(paths.config_file.parent)
    referent = tmp_path / "outside.json"
    referent.write_text(json.dumps(_valid_payload(tmp_path)), encoding="utf-8")
    referent.chmod(0o600)
    paths.config_file.symlink_to(referent)

    with pytest.raises(ConfigError) as caught:
        load_config(paths)

    assert caught.value.field == "config_file"
    assert referent.read_text(encoding="utf-8") == json.dumps(_valid_payload(tmp_path))


def test_normalized_config_bytes_match_across_two_processes(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    payload = _valid_payload(tmp_path)
    payload["sources"] = list(reversed(payload["sources"]))
    _write_config(paths, payload)
    expected = canonical_config_bytes(load_config(paths))
    config_root = str(tmp_path / "config-root")
    data_root = str(tmp_path / "data-root")
    cache_root = str(tmp_path / "cache-root")
    code = (
        "from pathlib import Path; "
        "from qsesh.config import canonical_config_bytes, load_config; "
        "from qsesh.paths import QseshPaths; "
        f"p=QseshPaths.from_env({{'XDG_CONFIG_HOME': {config_root!r}, "
        f"'XDG_DATA_HOME': {data_root!r}, "
        f"'XDG_CACHE_HOME': {cache_root!r}}}, "
        f"Path({str(tmp_path / 'home')!r})); "
        "import sys; sys.stdout.buffer.write(canonical_config_bytes(load_config(p)))"
    )
    env = dict(
        os.environ,
        PYTHONPATH=str(PACKAGE_ROOT),
        PYTHONDONTWRITEBYTECODE="1",
    )

    first = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        check=False,
        env=env,
    )
    second = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        check=False,
        env=env,
    )

    assert first.returncode == second.returncode == 0
    assert first.stderr == second.stderr == b""
    assert first.stdout == second.stdout == expected
    assert json.loads(expected) == {
        "host_id": "host-test-001",
        "live_window_us": 600_000_000,
        "opencode_bin": str((tmp_path / "bin/opencode").resolve()),
        "sources": [
            {"harness": "claude", "root": str((tmp_path / "sources/claude").resolve())},
            {"harness": "codex", "root": str((tmp_path / "sources/codex").resolve())},
            {
                "harness": "opencode",
                "root": str((tmp_path / "sources/opencode/opencode.db").resolve()),
            },
        ],
    }


def test_config_file_mode_is_exactly_0600_in_fixture(tmp_path: Path) -> None:
    paths = _paths(tmp_path)
    _write_config(paths, _valid_payload(tmp_path))

    assert stat.S_IMODE(paths.config_file.lstat().st_mode) == 0o600
