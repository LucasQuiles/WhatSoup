"""Shared queue-age and threshold logic for BOT ERRORS consumers.

Single source of truth (SSOT) for:
- Event file age computation (createdAt with mtime fallback) — #2460
- Directory stats (file count + oldest age from the correct clock)
- Threshold parsing (fail-closed: rejects negative / non-finite / non-integral)
- Threshold comparison (>= semantics; zero means explicitly disabled)

Both the daily health-check and the heartbeat watchdog import from this module
so they agree on event age for the same queue snapshot.  Before #2460 the
watchdog derived age from file mtime while health-check read the immutable
``createdAt`` field; dispatcher retries refreshed mtime without changing
``createdAt``, so a repeatedly failing old event appeared brand-new to the
watchdog on every retry.

Acceptance criteria addressed (see #2460):
- Daily health and watchdog return the same event age for the same snapshot.
- Rewriting/retrying an event cannot reduce its immutable event age.
- Threshold comparison semantics (>=, zero-means-disabled) are shared and tested.
"""

from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Event file age — the canonical clock for *.json queue entries
# ---------------------------------------------------------------------------


def event_file_age_seconds(path: Path, now: float) -> float:
    """Return the age in seconds for a JSON event file.

    For ``*.json`` event files, reads the event's ``createdAt`` ISO-8601 field
    as the true creation time (age = now - createdAt).  Falls back to
    ``st_mtime`` on any error (missing field, unparseable timestamp, unreadable
    file, invalid JSON).  Never raises.
    """
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
        data = json.loads(raw)
        if isinstance(data, dict):
            created_at = data.get("createdAt")
            if isinstance(created_at, str) and created_at.strip():
                text = created_at.strip()
                if text.endswith("Z"):
                    text = text[:-1] + "+00:00"
                parsed = datetime.fromisoformat(text)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return max(0.0, now - parsed.timestamp())
    except Exception:  # noqa: BLE001 — health path must never crash on malformed files
        pass
    try:
        return max(0.0, now - path.stat().st_mtime)
    except OSError:
        return 0.0


# ---------------------------------------------------------------------------
# Durable internal entry exclusion — see #2727
# ---------------------------------------------------------------------------


def is_durable_internal_entry(path: Path) -> bool:
    """Return True for durable-json internal artifacts (e.g. ``.durable-json.lock``).

    These are never data entries and must be excluded from queue-depth counts
    and age calculations.  See #2727.
    """
    return path.name == ".durable-json.lock"


# ---------------------------------------------------------------------------
# Directory stats — shared count + oldest-age computation
# ---------------------------------------------------------------------------


def scan_directory(path: Path, pattern: str, now: float) -> tuple[int, int]:
    """Count files and return the oldest age (seconds) in a queue directory.

    For ``*.json`` patterns, uses the event ``createdAt`` field with mtime
    fallback (see :func:`event_file_age_seconds`).  For non-JSON patterns,
    uses file ``st_mtime``.  Durable internal entries (``.durable-json.lock``)
    are always excluded.

    Returns ``(count, oldest_seconds)``.  Never raises — unreadable files
    contribute age 0.0 via :func:`event_file_age_seconds`.
    """
    if not path.exists():
        return 0, 0
    files = [
        item
        for item in path.glob(pattern)
        if item.is_file() and not is_durable_internal_entry(item)
    ]
    if not files:
        return 0, 0
    is_json_pattern = pattern.endswith(".json") or pattern == "*.json"
    if is_json_pattern:
        oldest = max(event_file_age_seconds(item, now) for item in files)
    else:
        oldest = max(0.0, now - min(item.stat().st_mtime for item in files))
    return len(files), max(0, int(oldest))


# ---------------------------------------------------------------------------
# Threshold parsing — fail-closed (#2460 threshold blind spot)
# ---------------------------------------------------------------------------


def parse_queue_threshold(env_name: str, default: int) -> int:
    """Parse a queue threshold from an environment variable.

    - Unset or empty → returns *default*.
    - Zero → explicitly disabled (returned as-is).
    - Negative, non-finite, or non-integral → raises ``ValueError``.

    This replaces the old ``env_int`` silent-fallback for queue thresholds so
    that invalid configuration produces a distinct configuration-health error
    instead of silently weakening monitoring.  See #2460.
    """
    raw = os.environ.get(env_name)
    if raw is None or raw.strip() == "":
        return default
    text = raw.strip()
    try:
        value = float(text)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"queue threshold {env_name}={text!r}: not a number")
    if not math.isfinite(value):
        raise ValueError(f"queue threshold {env_name}={text!r}: not finite")
    if value < 0:
        raise ValueError(
            f"queue threshold {env_name}={text!r}: negative thresholds are invalid"
        )
    integral = int(value)
    if integral != value:
        raise ValueError(f"queue threshold {env_name}={text!r}: must be integral")
    return integral


# ---------------------------------------------------------------------------
# Threshold comparison — shared >= semantics with zero-means-disabled
# ---------------------------------------------------------------------------


def threshold_met(value: int, threshold: int) -> bool:
    """Return True if *value* meets or exceeds *threshold*.

    A threshold of zero means the dimension is explicitly disabled (always
    returns False).  This replaces the ad-hoc ``threshold > 0 and x >= threshold``
    pattern that was duplicated across both consumers.
    """
    return threshold > 0 and value >= threshold
