#!/usr/bin/env python3
"""PreToolUse browser-loop guard.

State root:
- TOKENOMICS_STATE_DIR set: use that directory. Tests use this to avoid touching
  operator state.
- TOKENOMICS_STATE_DIR unset, darwin: use
  ~/Library/Application Support/<TOKENOMICS_BOT>-tokenomics.
- TOKENOMICS_STATE_DIR unset, non-darwin: use XDG_STATE_HOME (or
  ~/.local/state) /<TOKENOMICS_BOT>-tokenomics.

The hook fails open on infrastructure errors: it exits 0 with no stdout so the
tool call proceeds. Diagnostics go to stderr.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


WINDOW_SECONDS = 60.0
THRESHOLD = 8
MAX_REASON_BYTES = 2000
TOOL_NAME = "mcp__superpowers-chrome_chrome__use_browser"


def state_dir_name(bot: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", bot).strip("._-")
    return f"{(slug or 'bot')[:80]}-tokenomics"


def fail_open(message: str) -> int:
    print(f"browser-loop-interrupt: {message}", file=sys.stderr)
    return 0


def truncate_utf8(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    if max_bytes <= 3:
        return encoded[:max_bytes].decode("utf-8", errors="ignore")
    return encoded[: max_bytes - 3].decode("utf-8", errors="ignore") + "..."


def build_deny_reason(extra: str = "") -> str:
    reason = (
        "Browser-loop guard: this session made 8 browser calls within 60 seconds. "
        "Stop repeating the same browser strategy. summarize what you learned, "
        "choose a different strategy or alternative tool, and continue only if "
        "the next browser action has a new concrete reason."
    )
    if extra:
        reason = f"{reason} {extra}"
    return truncate_utf8(reason, MAX_REASON_BYTES)


def hashed_session_id(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]


def state_root(bot: str) -> Path:
    override = os.environ.get("TOKENOMICS_STATE_DIR")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / state_dir_name(bot)
    xdg_state = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg_state) if xdg_state else Path.home() / ".local" / "state"
    return base / state_dir_name(bot)


def state_path(root: Path, session_id: str) -> Path:
    return root / "browser-loop" / f"{hashed_session_id(session_id)}.jsonl"


def event_record(now: float, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "ts": now,
        "tool_name": payload.get("tool_name", TOOL_NAME),
        "action": (payload.get("tool_input") or {}).get("action"),
    }


def recent_records(path: Path, now: float) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    records: list[dict[str, Any]] = []
    cutoff = now - WINDOW_SECONDS
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            ts = float(record["ts"])
            if ts >= cutoff:
                records.append(record)
    return records


def append_record(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")


def reset_state(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(record, separators=(",", ":")) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def deny() -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": build_deny_reason(),
                }
            },
            separators=(",", ":"),
        )
    )


def main() -> int:
    bot = os.environ.get("TOKENOMICS_BOT")
    if not bot:
        return fail_open("missing TOKENOMICS_BOT; allowing tool call")

    raw = sys.stdin.read()
    if not raw.strip():
        return fail_open("empty stdin; allowing tool call")

    try:
        payload = json.loads(raw)
    except Exception as err:
        return fail_open(f"invalid stdin JSON: {err}; allowing tool call")

    session_id = payload.get("session_id") or payload.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        return fail_open("missing session_id; allowing tool call")

    now = time.time()
    record = event_record(now, payload)
    path = state_path(state_root(bot), session_id)

    try:
        recent = recent_records(path, now)
    except Exception as err:
        try:
            reset_state(path, record)
        except Exception as reset_err:
            return fail_open(f"corrupt state and reset failed: {err}; {reset_err}; allowing tool call")
        return fail_open(f"corrupt state reset: {err}; allowing tool call")

    try:
        append_record(path, record)
    except Exception as err:
        return fail_open(f"state append failed: {err}; allowing tool call")

    if len(recent) + 1 >= THRESHOLD:
        deny()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
