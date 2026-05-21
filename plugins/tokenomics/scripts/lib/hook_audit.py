import dataclasses
import json
import pathlib
import re
from typing import Iterable, Optional, Sequence


BROWSER_MATCHER = "mcp__superpowers-chrome_chrome__use_browser"


@dataclasses.dataclass(frozen=True)
class ConflictRecord:
    path: str
    surface: str  # "settings" | "hookify" | "plugin"
    detail: str


class HookConflict(RuntimeError):
    def __init__(self, conflicts: Sequence[ConflictRecord]) -> None:
        self.conflicts = list(conflicts)
        paths = ", ".join(c.path for c in self.conflicts)
        super().__init__(
            f"PreToolUse matcher for {BROWSER_MATCHER} already registered in: {paths}"
        )


def _matcher_targets_browser(matcher: object) -> bool:
    if not isinstance(matcher, str) or not matcher:
        return False
    try:
        if re.search(matcher, BROWSER_MATCHER) is not None:
            return True
    except re.error:
        pass
    return BROWSER_MATCHER in matcher


def _scan_json_hooks(path: pathlib.Path, surface: str) -> list[ConflictRecord]:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(payload, dict):
        return []
    hooks_block = payload.get("hooks")
    if not isinstance(hooks_block, dict):
        return []
    entries = hooks_block.get("PreToolUse")
    if not isinstance(entries, list):
        return []
    records: list[ConflictRecord] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if _matcher_targets_browser(entry.get("matcher")):
            records.append(ConflictRecord(
                path=str(path),
                surface=surface,
                detail=f"PreToolUse matcher={entry.get('matcher')!r} matches {BROWSER_MATCHER}",
            ))
    return records


def scan_settings_json(path: pathlib.Path) -> list[ConflictRecord]:
    return _scan_json_hooks(path, surface="settings")


def scan_plugin_hooks_json(path: pathlib.Path) -> list[ConflictRecord]:
    return _scan_json_hooks(path, surface="plugin")


def scan_hookify_file(path: pathlib.Path) -> list[ConflictRecord]:
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    if BROWSER_MATCHER not in text:
        return []
    return [ConflictRecord(
        path=str(path),
        surface="hookify",
        detail=f"file references {BROWSER_MATCHER}",
    )]


def audit_hook_surfaces(
    *,
    settings_paths: Iterable[pathlib.Path],
    hookify_paths: Iterable[pathlib.Path],
    plugin_hooks_paths: Iterable[pathlib.Path],
    exclude_paths: Iterable[pathlib.Path] = (),
) -> list[ConflictRecord]:
    excluded = {pathlib.Path(p).resolve() for p in exclude_paths}

    def _included(p: pathlib.Path) -> bool:
        try:
            return p.resolve() not in excluded
        except OSError:
            return True

    records: list[ConflictRecord] = []
    for p in settings_paths:
        if _included(p):
            records.extend(scan_settings_json(p))
    for p in hookify_paths:
        if _included(p):
            records.extend(scan_hookify_file(p))
    for p in plugin_hooks_paths:
        if _included(p):
            records.extend(scan_plugin_hooks_json(p))
    return records


def require_no_conflict(records: Sequence[ConflictRecord]) -> None:
    if records:
        raise HookConflict(records)
    return None
