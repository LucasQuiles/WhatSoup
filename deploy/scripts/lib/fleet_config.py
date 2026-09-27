"""Single resolver for the per-host health profile and the fleet roster.

Every bot-errors loader of ``deploy/health-profiles/<host>.json`` or
``deploy/bot-errors-expected-fleet.json`` resolves its file here, in one order:

  1. the env var the loader already honours (``BOT_ERRORS_HEALTH_PROFILE``,
     ``BOT_ERRORS_FLEET_SENTINEL_HOSTS`` or ``BOT_ERRORS_EXPECTED_FLEET``);
  2. the private per-host file under ``~/.config/whatsoup/``;
  3. the tracked repo copy (transitional; a later change removes it).

A set env var is authoritative: if its file is missing or unreadable the load
fails, it never falls through to a later source. A private file that exists
but cannot be read also fails rather than falling through. When no source
exists the load fails too. Every failure raises :class:`FleetConfigError`
whose message is one line naming the path, the problem and the order tried,
so callers can exit non-zero instead of watching nothing or defaulting to
role=central.

:func:`profile_missing_due` is the pure daily-suppression decision for the
profile-missing alert those exits raise. Each producer builds and writes its
own event and marker; this module only judges a marker it has read.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

HEALTH_PROFILE_ENV = "BOT_ERRORS_HEALTH_PROFILE"
HEALTH_PROFILE_JSON_ENV = "BOT_ERRORS_HEALTH_PROFILE_JSON"
ROSTER_ENV = "BOT_ERRORS_FLEET_SENTINEL_HOSTS"
GUI_ROSTER_ENV = "BOT_ERRORS_EXPECTED_FLEET"

PRIVATE_HEALTH_PROFILE_NAME = "health-profile.json"
ROSTER_NAME = "bot-errors-expected-fleet.json"

SOURCE_ENV = "env"
SOURCE_PRIVATE = "private"
SOURCE_TRACKED = "tracked-legacy"


class FleetConfigError(RuntimeError):
    """A health profile or roster could not be resolved or read.

    ``path`` is the file the failure is about (for a nothing-found failure,
    the private path an operator should seed).
    """

    def __init__(self, message: str, path: Path) -> None:
        super().__init__(message)
        self.path = path


def private_config_dir() -> Path:
    # Resolved per call so a caller (or test) that changes HOME sees it.
    return Path.home() / ".config" / "whatsoup"


def private_health_profile_path() -> Path:
    return private_config_dir() / PRIVATE_HEALTH_PROFILE_NAME


def private_roster_path() -> Path:
    return private_config_dir() / ROSTER_NAME


def tracked_health_profile_path(repo_root: Path, host: str) -> Path:
    return repo_root / "deploy" / "health-profiles" / f"{host}.json"


def tracked_roster_path(repo_root: Path) -> Path:
    return repo_root / "deploy" / ROSTER_NAME


@dataclass(frozen=True)
class ResolvedConfig:
    what: str
    path: Path
    source: str
    env_name: str
    env_raw: str
    private: Path
    tracked: Path

    def order(self) -> str:
        return describe_order(self.env_name, self.private, self.tracked)

    def failure(self, problem: str) -> FleetConfigError:
        if self.source == SOURCE_ENV:
            note = f"{self.env_name} is set, so later sources were not tried"
        elif self.source == SOURCE_PRIVATE:
            note = "the private file exists, so the tracked copy was not tried"
        else:
            note = f"{self.env_name} is unset and the private file is absent"
        return FleetConfigError(
            f"{self.what} {problem}: {self.path} (source={self.source}; {note}); "
            f"resolver order: {self.order()}",
            self.path,
        )


def describe_order(env_name: str, private: Path, tracked: Path) -> str:
    return f"1) env {env_name} 2) private {private} 3) tracked {tracked}"


def resolve(what: str, env_name: str, private: Path, tracked: Path) -> ResolvedConfig:
    """Pick the source for ``what``; raise when no source exists at all.

    Only absence moves resolution to the next source. ``lexists`` keeps a
    dangling or unreadable private file selected so the read fails loudly.
    """
    raw = os.environ.get(env_name, "").strip()
    if raw:
        return ResolvedConfig(what, Path(raw).expanduser(), SOURCE_ENV, env_name, raw, private, tracked)
    if os.path.lexists(private):
        return ResolvedConfig(what, private, SOURCE_PRIVATE, env_name, raw, private, tracked)
    if os.path.lexists(tracked):
        return ResolvedConfig(what, tracked, SOURCE_TRACKED, env_name, raw, private, tracked)
    raise FleetConfigError(
        f"{what} missing: {env_name} is unset, {private} is absent and {tracked} is absent; "
        f"resolver order: {describe_order(env_name, private, tracked)}",
        private,
    )


def read_json_object(resolved: ResolvedConfig) -> dict[str, Any]:
    """Read ``resolved.path`` as a JSON object or raise :class:`FleetConfigError`."""
    try:
        text = resolved.path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise resolved.failure("missing") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise resolved.failure(f"unreadable ({type(exc).__name__})") from exc
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError as exc:
        raise resolved.failure(f"is not valid JSON ({exc})") from exc
    if not isinstance(loaded, dict):
        raise resolved.failure("is not a JSON object")
    return loaded


def resolve_health_profile(tracked: Path) -> ResolvedConfig:
    return resolve("health profile", HEALTH_PROFILE_ENV, private_health_profile_path(), tracked)


def resolve_roster(repo_root: Path, env_name: str = ROSTER_ENV) -> ResolvedConfig:
    return resolve("fleet roster", env_name, private_roster_path(), tracked_roster_path(repo_root))


PROFILE_MISSING_MARKER_KIND = "profile-missing-marker"
PROFILE_MISSING_MARKER_SCHEMA = 1

_UTC_DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def utc_day(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d")


def _valid_utc_day(value: Any) -> bool:
    if not isinstance(value, str) or not _UTC_DAY_RE.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class ProfileMissingDecision:
    """Whether a profile-missing alert is due, and why.

    ``anomaly`` marks a marker that exists but cannot prove suppression; the
    caller prints ``reason`` (a fixed token, never marker content) on stderr.
    """

    due: bool
    reason: str
    anomaly: bool = False


def profile_missing_due(
    marker: Mapping[str, Any] | None, *, producer: str, host: str, day: str
) -> ProfileMissingDecision:
    """Decide whether ``producer`` on ``host`` must alert for UTC ``day``.

    Only a well-formed marker for the same producer, host and day suppresses.
    Anything else is due: a marker that is absent or from an earlier day
    normally, and a wrong-schema, wrong-host, wrong-producer, malformed-day or
    future-day marker as an anomaly. A future day means the clock went back; it
    must not silence every day until the clock catches up.
    """
    if marker is None:
        return ProfileMissingDecision(True, "absent")
    if (
        not isinstance(marker, Mapping)
        or type(marker.get("schemaVersion")) is not int
        or marker.get("schemaVersion") != PROFILE_MISSING_MARKER_SCHEMA
        or marker.get("kind") != PROFILE_MISSING_MARKER_KIND
    ):
        return ProfileMissingDecision(True, "wrong-schema", anomaly=True)
    if marker.get("producer") != producer:
        return ProfileMissingDecision(True, "wrong-producer", anomaly=True)
    if marker.get("host") != host:
        return ProfileMissingDecision(True, "wrong-host", anomaly=True)
    recorded = marker.get("utcDay")
    if not _valid_utc_day(recorded):
        return ProfileMissingDecision(True, "malformed-day", anomaly=True)
    if recorded > day:
        return ProfileMissingDecision(True, "future-day", anomaly=True)
    if recorded < day:
        return ProfileMissingDecision(True, "earlier-day")
    return ProfileMissingDecision(False, "same-day")
