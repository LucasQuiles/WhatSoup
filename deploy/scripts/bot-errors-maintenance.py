#!/usr/bin/env python3
"""Declare planned maintenance windows so BOT ERRORS silences alerts.

Pattern B (Part 2). An operator opening a maintenance window for an instance
tells the dispatcher to silence (not crash-alert) that instance's incident
alerts for the window's duration. This kills false-positive lifecycle alerts
during deliberate restarts and deploys.

State lives in ``maintenance.json`` under the same state directory the
dispatcher uses (``BOT_ERRORS_STATE_DIR`` override honored), keyed by
``"{machine}|{instance}"``. Mutations are predecessor-fenced and fail closed
on unreadable state; read-only suppression checks retain their fail-open
behavior until the separately owned recovery slice lands.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.durable_json import (
    DurableWriteError,
    durable_json_target,
    observe_json,
    operation_id,
    publish_state_json,
    require_advance,
)

# Hard ceiling on a window's length. A planned maintenance longer than this is
# almost certainly a forgotten "open" — clamp so a stale window cannot silence
# alerts indefinitely.
MAX_DURATION_SECONDS = 24 * 60 * 60  # 24h

_DURATION_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
_DURATION_RE = re.compile(r"^\s*(\d+)\s*([smhd])\s*$", re.IGNORECASE)


def parse_duration(text: str, *, max_seconds: int = MAX_DURATION_SECONDS) -> int:
    """Parse a duration like ``30m`` / ``2h`` / ``90s`` / ``1d`` into seconds.

    Non-positive or unparseable input raises ``ValueError``. The result is
    clamped to ``max_seconds``.
    """
    match = _DURATION_RE.match(text or "")
    if not match:
        raise ValueError(f"invalid duration: {text!r} (expected forms like 30m, 2h, 90s, 1d)")
    value = int(match.group(1))
    unit = match.group(2).lower()
    seconds = value * _DURATION_UNITS[unit]
    if seconds <= 0:
        raise ValueError(f"duration must be positive: {text!r}")
    return min(seconds, max_seconds)


def state_root() -> Path:
    """Resolve the BOT ERRORS state directory.

    MUST match the dispatcher's ``state_root()`` convention so both processes
    read and write the same ``maintenance.json``.
    """
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def maintenance_state_path() -> Path:
    return state_root() / "maintenance.json"


def safe_segment(value: str) -> str:
    """Normalize a scope segment identically to the dispatcher's ``safe_segment``.

    The dispatcher keys incidents (and maintenance lookups) on
    ``safe_segment(machine)|safe_segment(instance)``. The CLI MUST apply the
    same normalization or a window opened with a label containing a space or
    other special character would be written under a key the dispatcher never
    looks up — a silent suppression miss.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def window_key(machine: str, instance: str) -> str:
    return f"{safe_segment(machine)}|{safe_segment(instance)}"


def _private_state_target():
    path = maintenance_state_path()
    try:
        path.parent.lstat()
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.parent.is_symlink() or not path.parent.is_dir():
            raise DurableWriteError("identity_type")
    path.parent.chmod(0o700)
    target = durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )
    return target, observe_json(target)


def _windows_from_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {key: value for key, value in payload.items() if isinstance(value, dict)}


def load_windows() -> dict[str, Any]:
    """Read the maintenance windows. Missing/corrupt/non-dict -> empty (fail-open)."""
    path = maintenance_state_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {k: v for k, v in parsed.items() if isinstance(v, dict)}


def active_windows(now: int | None = None) -> dict[str, Any]:
    """Return only non-expired windows."""
    current = int(time.time()) if now is None else now
    out: dict[str, Any] = {}
    for key, win in load_windows().items():
        if not isinstance(win, dict):
            continue
        expires = win.get("expiresAt")
        try:
            if expires is not None and int(expires) > current:
                out[key] = win
        except (TypeError, ValueError):
            continue
    return out


def cmd_open(args: argparse.Namespace) -> int:
    try:
        seconds = parse_duration(args.duration)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    machine = args.machine or socket.gethostname()
    now = int(time.time())
    key = window_key(machine, args.instance)
    try:
        target, observation = _private_state_target()
    except DurableWriteError as exc:
        print(f"error: durable maintenance state unavailable: {exc}", file=sys.stderr)
        return 1
    windows = _windows_from_payload(observation.payload)
    record: dict[str, Any] = {
        "openedAt": now,
        "expiresAt": now + seconds,
    }
    if args.reason:
        record["reason"] = args.reason
    windows[key] = record
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        windows,
        component="maintenance.open_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        windows,
        component="maintenance.open_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    try:
        require_advance(publication)
    except DurableWriteError as exc:
        print(f"error: durable maintenance state not committed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({key: record}, indent=2, sort_keys=True))
    return 0


def cmd_close(args: argparse.Namespace) -> int:
    machine = args.machine or socket.gethostname()
    key = window_key(machine, args.instance)
    try:
        target, observation = _private_state_target()
    except DurableWriteError as exc:
        print(f"error: durable maintenance state unavailable: {exc}", file=sys.stderr)
        return 1
    windows = _windows_from_payload(observation.payload)
    existed = windows.pop(key, None) is not None
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        windows,
        component="maintenance.close_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        windows,
        component="maintenance.close_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    try:
        require_advance(publication)
    except DurableWriteError as exc:
        print(f"error: durable maintenance state not committed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"closed": key, "existed": existed}, indent=2, sort_keys=True))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    print(json.dumps(active_windows(), indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bot-errors-maintenance",
        description="Declare planned maintenance windows that silence BOT ERRORS alerts.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_open = sub.add_parser("open", help="open a maintenance window for an instance")
    p_open.add_argument("instance", help="instance label to silence")
    p_open.add_argument("duration", help="window length, e.g. 30m, 2h, 90s, 1d")
    p_open.add_argument("--machine", default=None, help="machine name (default: local hostname)")
    p_open.add_argument("--reason", default=None, help="optional human reason for the window")
    p_open.set_defaults(func=cmd_open)

    p_close = sub.add_parser("close", help="close (remove) a maintenance window")
    p_close.add_argument("instance", help="instance label to release")
    p_close.add_argument("--machine", default=None, help="machine name (default: local hostname)")
    p_close.set_defaults(func=cmd_close)

    p_list = sub.add_parser("list", help="list active (non-expired) windows as JSON")
    p_list.set_defaults(func=cmd_list)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
