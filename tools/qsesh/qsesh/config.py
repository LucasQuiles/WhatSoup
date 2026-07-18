"""Strict, deterministic qSesh configuration loading."""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from .errors import QseshError
from .paths import QseshPaths

CONFIG_ERROR_CODE = "QS-E-CONFIG"
DEFAULT_LIVE_WINDOW_US = 600_000_000
_HOST_ID = re.compile(r"[a-z][a-z0-9._-]{0,63}").fullmatch
_HARNESS_ORDER = {"claude": 0, "codex": 1, "opencode": 2}
_TOP_LEVEL_KEYS = frozenset({"host_id", "sources", "live_window_us", "opencode_bin"})
_SOURCE_KEYS = frozenset({"harness", "root"})


class ConfigError(QseshError):
    """Safe configuration failure with no raw value disclosure."""

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(CONFIG_ERROR_CODE, phase=field)


@dataclass(frozen=True)
class SourceConfig:
    harness: str
    root: Path


@dataclass(frozen=True)
class QseshConfig:
    host_id: str
    sources: tuple[SourceConfig, ...]
    opencode_bin: Path
    live_window_us: int = DEFAULT_LIVE_WINDOW_US


def _reject(field: str) -> None:
    raise ConfigError(field)


def _absolute_path(value: object, field: str) -> Path:
    if not isinstance(value, str) or not value:
        _reject(field)
    candidate = Path(value)
    if not candidate.is_absolute() or ".." in candidate.parts:
        _reject(field)
    return candidate


def _validate_owned_paths(paths: QseshPaths) -> None:
    for field, value in (
        ("data_root", paths.data_dir),
        ("config_file", paths.config_file),
    ):
        if not value.is_absolute() or ".." in value.parts:
            _reject(field)
    if paths.config_file != paths.config_dir / "config.json":
        _reject("config_file")


def _open_json_file(paths: QseshPaths) -> TextIO:
    target = paths.config_file
    try:
        before = target.lstat()
    except OSError:
        _reject("config_file")
    mode = stat.S_IMODE(before.st_mode)
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or mode & 0o177
        or not mode & 0o400
    ):
        _reject("config_mode" if stat.S_ISREG(before.st_mode) else "config_file")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(target, flags)
    except OSError:
        _reject("config_file")
    try:
        after = os.fstat(descriptor)
        if not stat.S_ISREG(after.st_mode) or (after.st_dev, after.st_ino) != (
            before.st_dev,
            before.st_ino,
        ):
            _reject("config_file")
        return os.fdopen(descriptor, "r", encoding="utf-8")
    except BaseException:
        os.close(descriptor)
        raise


def _load_payload(paths: QseshPaths) -> dict[str, Any]:
    try:
        with _open_json_file(paths) as handle:
            payload = json.load(handle)
    except ConfigError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        _reject("config_json")
    if not isinstance(payload, dict):
        _reject("config")
    if set(payload) - _TOP_LEVEL_KEYS:
        _reject("config.unknown_key")
    for required in ("host_id", "sources", "opencode_bin"):
        if required not in payload:
            _reject(required)
    return payload


def _parse_sources(value: object) -> tuple[SourceConfig, ...]:
    if not isinstance(value, list):
        _reject("sources")
    parsed: list[SourceConfig] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            _reject("sources")
        if set(item) - _SOURCE_KEYS:
            _reject("sources.unknown_key")
        harness = item.get("harness")
        if not isinstance(harness, str) or harness not in _HARNESS_ORDER:
            _reject("sources.harness")
        if harness in seen:
            _reject("sources.duplicate")
        seen.add(harness)
        if "root" not in item:
            _reject("sources.root")
        root = _absolute_path(item["root"], "sources.root")
        if harness == "opencode" and root.name != "opencode.db":
            _reject("sources.root")
        parsed.append(SourceConfig(harness=harness, root=root))

    if seen != set(_HARNESS_ORDER):
        _reject("sources.required")
    return tuple(sorted(parsed, key=lambda source: _HARNESS_ORDER[source.harness]))


def _parse_live_window(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _reject("live_window_us")
    return value


def load_config(paths: QseshPaths) -> QseshConfig:
    _validate_owned_paths(paths)
    payload = _load_payload(paths)
    host_id = payload["host_id"]
    if not isinstance(host_id, str) or _HOST_ID(host_id) is None:
        _reject("host_id")
    live_window_us = _parse_live_window(
        payload.get("live_window_us", DEFAULT_LIVE_WINDOW_US)
    )
    return QseshConfig(
        host_id=host_id,
        sources=_parse_sources(payload["sources"]),
        opencode_bin=_absolute_path(payload["opencode_bin"], "opencode_bin"),
        live_window_us=live_window_us,
    )


def canonical_config_bytes(config: QseshConfig) -> bytes:
    sources: list[dict[str, str]] = []
    for source in config.sources:
        sources.append({"harness": source.harness, "root": str(source.root)})
    return json.dumps(
        {
            "host_id": config.host_id,
            "live_window_us": config.live_window_us,
            "opencode_bin": str(config.opencode_bin),
            "sources": sources,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
