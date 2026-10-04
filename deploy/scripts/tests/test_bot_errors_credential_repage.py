"""Dead-credential re-page: behaviour cases through the dispatcher's own cycle.

A dead provider credential used to reach the owner once, and then not again for
hours: the watchdog pages once per episode, an open incident re-notifies only on
a new event, and the owner route has a 6 h floor. These cases pin the class that
replaces that for auth-caused sources: one condition per bot, paged every 4 h by
a timer until its members clear or the owner acknowledges it.

Every case drives `run_once` and reads only surfaces that exist before the
change: the outbox, the incident state, the dispatch log and the injected send
functions. Nothing here imports a name the change adds, so on the unchanged code
each case fails at an assertion, never at collection. The cases that need a new
name are in test_bot_errors_credential_repage_unit.py.

How the cases are written:
- one function per variant, named test_t<case>_...; a function named
  test_t<case>_pin_... passes on the unchanged code by design;
- a stub records and the test body asserts: the dispatcher catches broadly, so an
  assertion inside a stub would be swallowed;
- `Rig.cycle` returns what `run_once` raised, and the case asserts on it;
- state is read through helpers that return an empty mapping, so a missing
  section fails the assertion that follows instead of raising KeyError;
- the fake clock is an object placed on `dispatcher.time` and `owner_route.time`
  only. The real `time` module is untouched: two cases start a child process.

Neutral fixtures only: hosts `hosta`, `hostb`, `hostc`, `probehost`, `aliasx`;
bots `bot-one`, `bot-two`, `dup-bot`. No real host name, number or chat id.
"""
from __future__ import annotations

import calendar
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time as real_time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPTS_DIR = _TESTS_DIR.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from lib import owner_route  # noqa: E402

_DISPATCHER = _SCRIPTS_DIR / "bot-errors-dispatcher.py"
_EMITTER = _SCRIPTS_DIR / "bot-errors-emit.py"

# ---------------------------------------------------------------------------
# The contract these cases pin. Every literal the change must honour is here.
# ---------------------------------------------------------------------------

# Stored state, inside the dispatcher's incident state.
SECTION = "credentialConditions"
QUARANTINE = "credentialConditionsQuarantine"
LOSS = "credentialConditionsLoss"
# {"<meta-alert source>": "<UTC day it was last sent>"}, for the daily group meta-alerts.
ALERT_DAYS = "credentialConditionsAlertDays"
# {"<meta-alert source>": {"day": "<UTC day it is owed for>", "at": <epoch seconds it was first owed>}}.
ALERTS_OWED = "credentialConditionsAlertsOwed"
PAGE_FIELDS = ("lastPageAt", "prevPageAt", "lastAttemptAt", "lastAcceptedAt", "count", "failedAttempts")

# The acknowledge file, under the dispatcher state root, keyed by class scope:
# {"<host>|<instance>": {"ackedAt": <epoch seconds>, "by": "<login name>"}}.
ACK_FILE = "credential-ack.json"

# Owner messages.
PAGE_DEAD = "provider credential dead — human action required"
PAGE_UNVERIFIED = "provider credential state unverified since"
PAGE_STILL_UNUSABLE = "primary still unusable"
PAGE_ACK_UNREADABLE = "acknowledge file unreadable"
PAGE_STATE_LOST = "BOT ERRORS: credential re-page state was lost for"

# The action sentence of a group text, and of a storm digest.
HUMAN_ACTION = (
    "Human action required: restore this bot's provider credential "
    "(owner). No automated remediation."
)
HUMAN_ACTION_DIGEST = (
    "Human action required: restore the provider credential of each bot named here "
    "(owner). No automated remediation."
)
Q_INVESTIGATE = "Q investigate"

# Group meta-alerts raised by the class, by source.
META_STATE_LOST = "credential-repage-state-lost"
META_PASS_ERROR = "credential-repage-pass-error"
META_ROSTER_UNREADABLE = "credential-repage-roster-unreadable"

# Dispatch-log records of the class: every type starts with this prefix and
# carries booleans and integers only. The fields the cases read:
#   count, failedAttempts            on a page record
#   ackUnreadable                    true when the acknowledge file could not be used
#   unusableEvents, ties, unmatchedScopes   integer counts, one record per cycle
#   rosterUnreadable                 true, one record per cycle
#   ownerRouteDisabled               true, one record per condition per interval
#   passFault                        true when a pass absorbed an exception
LOG_PREFIX = "credential_repage_"

# Timing (seconds).
INTERVAL = 4 * 3600
PROMOTION = 30 * 60
GRACE = 10 * 60
ACK_HOLD = 24 * 3600
MAINTENANCE_HOLD = 24 * 3600
RETENTION = 7 * 24 * 3600
RETRY_CAP = 3
CLASS_BUDGET = 20

# Sources.
DEAD = "provider_credential_dead"
MANUAL = "reauth-observe:reauth_needed_manual"
UNUSABLE_30 = "reauth-observe:credential_present_runtime_unusable"
INDETERMINATE = "reauth-observe:indeterminate_investigate"
NON_MEMBER = "reauth-observe:health_degraded_non_fallback"
MISMATCH_OVER_30 = "reauth-observe:account_identity_mismatch:credential_present_runtime_unusable"
MISMATCH_OVER_SUSTAIN = "reauth-observe:account_identity_mismatch:indeterminate_investigate"
MISMATCH_OVER_NON_MEMBER = "reauth-observe:account_identity_mismatch:health_degraded_non_fallback"
PRIMARY = "primary_model_unusable"
NO_FALLBACK = "provider_auth_required_no_fallback"
OTHER_CRITICAL = "agent_respawn_failed"  # routed by the legacy owner route, not a member

HOUR = 3600
DAY = 24 * HOUR
BASE = calendar.timegm((2026, 10, 1, 0, 0, 0))  # 2026-10-01T00:00:00Z
OWNER_JID = "owner-chat.invalid"


def probe_source(host: str, bot: str, *, unverified: bool = False) -> str:
    """The fleet probe's source name: the bot's host and name are inside it."""
    tail = "_unverified" if unverified else ""
    return f"agent365-reliability-fleet_{host}_{bot.replace('-', '_')}_primary_model_usable{tail}"


def clock_at(hour: int, minute: int = 0, second: int = 0, *, day: int = 0) -> int:
    return BASE + day * DAY + hour * HOUR + minute * 60 + second


def iso(epoch: float) -> str:
    """Whole seconds render as the emitters write them; a fraction keeps its microseconds."""
    whole = int(epoch)
    micro = int(round((epoch - whole) * 1_000_000))
    stamp = datetime.fromtimestamp(whole, tz=timezone.utc)
    if micro:
        return stamp.replace(microsecond=micro).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return stamp.strftime("%Y-%m-%dT%H:%M:%SZ")


def micros(epoch: float) -> int:
    """The dispatcher's microsecond order for an epoch time."""
    return int(round(epoch * 1_000_000))


class FakeTime:
    """Stands in for the `time` module on the dispatcher and the owner route.

    One epoch drives the wall clock and the monotonic clock, so a send stub that
    "takes" its timeout moves both.
    """

    def __init__(self, start: float) -> None:
        self.now = float(start)
        self._origin = float(start)

    def time(self) -> float:
        return self.now

    def time_ns(self) -> int:
        return int(self.now * 1_000_000_000)

    def monotonic(self) -> float:
        return 1000.0 + (self.now - self._origin)

    def gmtime(self, secs: float | None = None):
        return real_time.gmtime(self.now if secs is None else secs)

    def localtime(self, secs: float | None = None):
        return real_time.gmtime(self.now if secs is None else secs)

    def strftime(self, fmt: str, when=None) -> str:
        return real_time.strftime(fmt, self.gmtime() if when is None else when)

    def strptime(self, text: str, fmt: str):
        return real_time.strptime(text, fmt)

    def sleep(self, seconds: float) -> None:
        self.now += max(0.0, float(seconds))

    def set(self, epoch: float) -> None:
        self.now = float(epoch)

    def advance(self, seconds: float) -> None:
        self.now += float(seconds)


class Crash(BaseException):
    """A process death in the middle of a send: no wrapper in the code absorbs it."""


# A fixture event the dispatcher would discard as a test artefact fails its case
# with this marker first in the message, so a case can never pass by absence
# because its own event was thrown away.
FIXTURE_DROPPED = "FIXTURE EVENT DROPPED"


_ids = iter(range(1, 1_000_000))
_loads = iter(range(1, 1_000_000))


def new_id() -> str:
    return str(uuid.UUID(int=next(_ids)))


# ---------------------------------------------------------------------------
# Events, each in the shape its real emitter writes.
# ---------------------------------------------------------------------------

_CONFINED = {"failureClass": "unknown", "length": 48, "correlationDigest": "ab" * 32}
_QUEUED = {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None}


def runtime_event(source: str, bot: str, at: float, *, relay_host: str | None, clear: bool = False,
                  severity: str = "warning", event_id: str | None = None) -> dict[str, Any]:
    """The instance's TypeScript emitter: no `machine`, confined summary and evidence.

    A relayed event carries the collector's relay block; `relay_host=None` is an
    event produced on the dispatcher's own host.
    """
    event: dict[str, Any] = {
        "schemaVersion": 2,
        "eventKind": "incident_recovery" if clear else "incident_alert",
        "eventType": "clear" if clear else "alert",
        "severity": "info" if clear else severity,
        "id": event_id or new_id(),
        "createdAt": iso(at),
        "instance": bot,
        "source": source,
        "summary": dict(_CONFINED),
        "evidence": dict(_CONFINED),
        "process": {"pid": 4242, "ppid": 1, "argvCount": 2, "node": "v24.15.0"},
        "runtime": {
            "invocationId": None,
            "systemdExecPid": None,
            "provenance": {
                "producer": "typescript-outbox",
                "test": False,
                "signals": [],
                "strongSignals": [],
                "outboxPolicy": "default",
                "liveOutboxRedirected": False,
                "resolvedOutbox": "/srv/bot/state/bot-errors/outbox",
            },
        },
        "diagnostics": {"queue": "/srv/bot/state/bot-errors/outbox"},
        "delivery": dict(_QUEUED),
    }
    if relay_host is not None:
        event["diagnostics"]["relay"] = {
            "remoteHost": relay_host,
            "remoteRoot": "/srv/bot/state/bot-errors",
            "remoteClaim": "claim-1",
            "remoteName": "event.json",
            "collectorHost": "collector",
            "collectedAt": iso(at),
        }
    return event


def observer_event(source: str, host: str, bot: str, at: float, *, clear: bool = False,
                   severity: str | None = None, event_id: str | None = None) -> dict[str, Any]:
    """The re-auth observer's event: its inventory host as `machine`, a mapping as evidence."""
    if severity is None:
        severity = "critical" if source == MANUAL else "warning"
    diagnosis = source.split(":", 1)[1] if ":" in source else source
    return {
        "schemaVersion": 1,
        "id": event_id or f"reauth-{int(at * 1_000_000_000)}-{next(_ids):08x}",
        "eventType": "clear" if clear else "alert",
        "severity": "info" if clear else severity,
        "createdAt": iso(int(at)) if not (at - int(at)) else iso(at),
        "source": source,
        "instance": bot,
        "machine": host,
        "attemptId": "attempt-1",
        "summary": (f"cleared ({diagnosis}): {host}/{bot} {source}" if clear
                    else f"{diagnosis}: follow the re-auth runbook"),
        "evidence": {"transition": "clear"} if clear else {"diagnosis": diagnosis, "usability": "unusable"},
        "delivery": {"status": "queued", "attempts": 0},
        "diagnostics": {"forceNotify": False},
    }


def watchdog_event(source: str, host: str, bot: str, at: float, *, clear: bool = False,
                   severity: str = "critical", event_id: str | None = None) -> dict[str, Any]:
    """The Python emitter (the instance's watchdog): the emitting host's own name as `machine`."""
    return {
        "schemaVersion": 2,
        "eventKind": "incident_recovery" if clear else "incident_alert",
        "eventType": "clear" if clear else "alert",
        "severity": "info" if clear else severity,
        "id": event_id or new_id(),
        "createdAt": iso(at),
        "machine": host,
        "platform": "Linux 6.8",
        "instance": bot,
        "source": source,
        "summary": f"alert source cleared: {source}" if clear else "provider credential rejected",
        "evidence": "" if clear else "auth_required=true",
        "process": {"pid": 5151, "ppid": 1, "cwd": "/srv/bot", "argv": ["bot-errors-emit.py"],
                    "execPath": "/usr/bin/python3", "python": "3.12.3"},
        "runtime": {
            "envKeys": [],
            "invocationId": None,
            "systemdExecPid": None,
            "provenance": {
                "producer": "python-emit",
                "test": False,
                "signals": [],
                "strongSignals": [],
                "outboxPolicy": "default",
                "liveOutboxRedirected": False,
                "resolvedOutbox": "/srv/bot/state/bot-errors/outbox",
            },
        },
        "diagnostics": {"logHints": [], "queue": "/srv/bot/state/bot-errors/outbox"},
        "delivery": dict(_QUEUED),
    }


def probe_event(host: str, bot: str, at: float, *, unverified: bool = False, clear: bool = False,
                probing_host: str = "probehost", event_id: str | None = None) -> dict[str, Any]:
    """The external fleet probe: `machine` is the probing host; the bot's host is in the source."""
    return {
        "schemaVersion": 1,
        "id": event_id or new_id(),
        "eventType": "clear" if clear else "alert",
        "severity": "info" if clear else ("warning" if unverified else "critical"),
        "createdAt": iso(at),
        "source": probe_source(host, bot, unverified=unverified),
        "instance": bot,
        "machine": probing_host,
        "summary": "primary model check failed",
        "evidence": "probe=primary_model_usable result=fail",
        "delivery": {"status": "queued", "attempts": 0},
        "diagnostics": {"forceNotify": False},
    }


def plain_event(source: str, host: str, bot: str, at: float, *, severity: str = "critical",
                clear: bool = False, event_id: str | None = None) -> dict[str, Any]:
    """An event of a source outside the class, in the legacy shape."""
    return {
        "schemaVersion": 1,
        "id": event_id or new_id(),
        "eventType": "clear" if clear else "alert",
        "severity": "info" if clear else severity,
        "createdAt": iso(at),
        "source": source,
        "instance": bot,
        "machine": host,
        "summary": "sample alert",
        "evidence": "",
        "delivery": {"status": "queued", "attempts": 0},
    }


def roster(*rows: tuple[str, str] | tuple[str, str, str]) -> dict[str, Any]:
    """A fleet file from (host, bot) or (host, bot, expected) rows."""
    hosts: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        host, bot = row[0], row[1]
        expected = row[2] if len(row) > 2 else "active"
        hosts.setdefault(host, []).append({"name": bot, "service": f"{bot}.service", "expected": expected})
    return {
        "schemaVersion": 1,
        "hosts": [{"host": host, "role": "bot-host", "collectorRemote": False, "instances": instances}
                  for host, instances in hosts.items()],
    }


ROSTER_ONE = roster(("hosta", "bot-one"), ("hostb", "bot-two"))
ROSTER_DUP = roster(("hosta", "dup-bot"), ("hostb", "dup-bot"), ("hosta", "bot-one"))
ROSTER_THREE = roster(("hosta", "bot-one"), ("hostb", "bot-two"), ("hostc", "bot-three"))
THREE_BOTS = (("hosta", "bot-one"), ("hostb", "bot-two"), ("hostc", "bot-three"))
THREE_SCOPES = ["hosta|bot-one", "hostb|bot-two", "hostc|bot-three"]
UNREADABLE = None


# ---------------------------------------------------------------------------
# The rig: one dispatcher module, one state root, recorded sends, a fake clock.
# ---------------------------------------------------------------------------


def is_class_page(text: str) -> bool:
    return PAGE_DEAD in text or PAGE_UNVERIFIED in text


def is_loss_page(text: str) -> bool:
    return text.startswith(PAGE_STATE_LOST)


def phase(entry: dict[str, Any]) -> str:
    """open, pending or latent; "absent" for no entry and for a scope that keeps only its `clearedAt` map."""
    if not entry:
        return "absent"
    if entry.get("openedAt") is not None:
        return "open"
    if entry.get("pendingSince") is not None:
        return "pending"
    return "latent" if entry.get("members") else "absent"


def page_fields_set(entry: dict[str, Any]) -> list[str]:
    return [name for name in PAGE_FIELDS if entry.get(name) is not None]


class Rig:
    def __init__(self, base: Path, monkeypatch: pytest.MonkeyPatch, *,
                 fleet: dict[str, Any] | None = ROSTER_ONE, start: float | None = None,
                 env: dict[str, str] | None = None, email: bool = True, owner_route_on: bool = True) -> None:
        # `base` is the test's own directory under /tmp (the make_rig fixture). Everything the rig
        # writes is inside it. Under pytest's tmp_path on macOS every path holds /var/folders/…/T/,
        # which the dispatcher's test-leak check drops: an event that carries a state path (a storm
        # digest's queue, the real emitter's log hints) would vanish on one host and be sent on another.
        self.base = base
        self.monkeypatch = monkeypatch
        # A `pytest-of-…` directory above the state root, as tmp_path has on Linux: the dispatcher's
        # e-mail fallback gate reads it as a test root, so the fallback stays closed.
        self.root = base / "pytest-of-repage" / "state"
        self.roster_path = base / "fleet" / "expected-fleet.json"
        self.declared_drops: set[str] = set()
        self.max_events = 25
        self.clock = FakeTime(clock_at(3) if start is None else start)
        self.group: list[dict[str, Any]] = []
        # Every group send that was started, taken or not, with where it stood in the timeline.
        self.group_attempts: list[dict[str, Any]] = []
        # The clock at each completion stamp.
        self.stamp_times: list[int] = []
        self.owner: list[dict[str, Any]] = []
        self.emails: list[dict[str, Any]] = []
        self.timeline: list[tuple[str, str]] = []
        self.group_rule: Callable[[str], str] = lambda text: "ok"
        self.owner_rule: Callable[[str], str] = lambda text: "ok"
        self.email_rule: Callable[[str, str], str] = lambda subject, body: "ok"
        self.owner_probe: Callable[[str], Any] | None = None
        self.notes: dict[str, Any] = {}
        self._written = 0

        for key in list(os.environ):
            if key.startswith("BOT_ERRORS_") or key == "WHATSOUP_ALERT_SINK":
                monkeypatch.delenv(key, raising=False)
        self.root.parent.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(self.root))
        monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(self.root / "outbox"))
        # Never the default script under the home folder, for the dispatcher or for a child: a path
        # inside the test's own directory, where no file exists. The mails a case reads are recorded
        # by the stub that replaces the dispatcher's email_fallback function (_load).
        monkeypatch.setenv("BOT_ERRORS_EMAIL_FALLBACK", str(base / "no-email-fallback"))
        monkeypatch.setenv("BOT_ERRORS_JID", "group.invalid")
        # Always set, never empty: an unset or empty value would read the
        # developer's private roster or the tracked one.
        monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", str(self.roster_path))
        if fleet is not None:
            self.write_roster(fleet)
        if owner_route_on:
            monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_JID", OWNER_JID)
            monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_SOCKET", str(base / "owner-line.sock"))
            monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_EMAIL", "1" if email else "0")
        for key, value in (env or {}).items():
            monkeypatch.setenv(key, value)
        self.d = self._load()
        self.paths = self.d.setup_dirs()

    # -- loading -----------------------------------------------------------

    def _load(self):
        module = dispatcher_fixtures.load_module_from_path(
            f"bot_errors_dispatcher_credential_repage_{next(_loads)}", _DISPATCHER
        )
        patch = self.monkeypatch.setattr
        patch(module, "time", self.clock)
        patch(owner_route, "time", self.clock)
        patch(module, "send_whatsapp", self._group_send)
        patch(module, "json_rpc_call", self._owner_send)
        patch(module, "email_fallback", self._email)
        patch(owner_route, "validate_send_acceptance", lambda result, jid: {"audit_receipt": "owner"})
        real_record_state = module.record_state

        def stamped(paths, **updates):
            real_record_state(paths, **updates)
            if "cycleCompletedAt" in updates:
                self.timeline.append(("stamp", ""))
                self.stamp_times.append(int(self.clock.now))

        patch(module, "record_state", stamped)
        return module

    def restart(self) -> None:
        """A new process: a freshly loaded module, so nothing held in memory survives."""
        self.d = self._load()
        self.paths = self.d.setup_dirs()

    # -- stubs: they record, the test body asserts ---------------------------

    def _group_send(self, text, socket_path="", *, require_acceptance=False, deadline=None):
        self.group_attempts.append({"text": text, "at": int(self.clock.now), "monotonic": self.clock.monotonic(),
                                    "deadline": deadline, "position": len(self.timeline)})
        verdict = self.group_rule(text)
        if verdict == "timeout":
            # json_rpc_call's bound: 15 s, or the time left before the caller's deadline.
            left = 15.0 if deadline is None else deadline - self.clock.monotonic()
            self.clock.advance(max(0.0, min(15.0, left)))
            raise TimeoutError("group send timed out")
        if verdict == "fail":
            raise RuntimeError("group line unavailable")
        if verdict == "ambiguous-handshake":
            # The handshake got no answer: the request never left.
            raise self.d.AmbiguousSendOutcome("handshake lost", phase=self.d.JSON_RPC_HANDSHAKE_PHASE)
        self.group.append({"text": text, "at": int(self.clock.now)})
        self.timeline.append(("group", text))
        if verdict == "ambiguous":
            # The request left and reached the group; its answer was lost (#2424).
            raise self.d.AmbiguousSendOutcome("reply lost", phase=self.d.JSON_RPC_POST_REQUEST_PHASE)
        return {"audit_receipt": f"g{len(self.group)}"} if require_acceptance else None

    def _owner_send(self, socket_path, method, params, timeout=15.0, *, deadline=None):
        arguments = params.get("arguments") if isinstance(params, dict) else None
        text = str((arguments or {}).get("text") or "")
        record = {"text": text, "timeout": timeout, "at": int(self.clock.now)}
        if self.owner_probe is not None:
            record["probe"] = self.owner_probe(text)
        self.owner.append(record)
        self.timeline.append(("owner", text))
        verdict = self.owner_rule(text)
        if verdict == "crash":
            raise Crash("the process died inside a send")
        if verdict == "timeout":
            self.clock.advance(timeout)
            raise TimeoutError("owner send timed out")
        if verdict == "fail":
            raise OSError("owner socket unavailable")
        return {"ok": True}

    def _email(self, subject, body, timeout=20):
        self.emails.append({"subject": subject, "body": body, "timeout": timeout, "at": int(self.clock.now)})
        self.timeline.append(("email", subject))
        verdict = self.email_rule(subject, body)
        if verdict == "timeout":
            self.clock.advance(timeout)
            return False
        return verdict == "ok"

    # -- driving -------------------------------------------------------------

    def cycle(self) -> BaseException | None:
        """Run one cycle and return what it raised, or None.

        BaseException on purpose: a crash inside a send is one, and a case must
        fail at its assertion when a containment is removed, not error out.
        """
        self.timeline.append(("cycle", ""))
        try:
            self.d.run_once(max_events=self.max_events)
        except KeyboardInterrupt:
            raise
        except BaseException as raised:  # noqa: BLE001
            return raised
        return None

    def cycle_at(self, epoch: float) -> BaseException | None:
        self.clock.set(epoch)
        return self.cycle()

    def before_pass(self, name: str, action: Callable[[], Any]) -> None:
        """Run `action` once, directly before the dispatcher's existing function `name` is first called."""
        real = getattr(self.d, name)
        pending = [action]

        def wrapped(*args, **kwargs):
            if pending:
                pending.pop()()
            return real(*args, **kwargs)

        self.monkeypatch.setattr(self.d, name, wrapped)

    def after_pass(self, name: str, action: Callable[[], Any]) -> None:
        """Run `action` once, directly after the dispatcher's existing function `name` first returns."""
        real = getattr(self.d, name)
        pending = [action]

        def wrapped(*args, **kwargs):
            result = real(*args, **kwargs)
            if pending:
                pending.pop()()
            return result

        self.monkeypatch.setattr(self.d, name, wrapped)

    def crash_before(self, name: str) -> None:
        """The process dies once, as the dispatcher's existing function `name` is entered."""

        def die() -> None:
            raise Crash(f"the process died entering {name}")

        self.before_pass(name, die)

    def crash_after(self, name: str) -> None:
        """The process dies once, directly after the dispatcher's existing function `name` first returns."""

        def die() -> None:
            raise Crash(f"the process died after {name}")

        self.after_pass(name, die)

    def put(self, event: dict[str, Any], *, name: str | None = None, dropped_on_purpose: bool = False) -> str:
        """Write an event to the outbox and return its id."""
        if not dropped_on_purpose:
            leak = self.d.matched_test_leak_pattern(event)
            if leak is not None or self.d.is_test_provenance_event(event):
                raise AssertionError(
                    f"{FIXTURE_DROPPED}: event {event.get('id')} would be discarded ({leak or 'test provenance'})"
                )
        self._written += 1
        created = event.get("createdAt") or iso(self.clock.now)
        stamp = str(created).replace("-", "").replace(":", "")
        filename = name or f"{stamp}.{self._written:05d}.{event['id']}.json"
        if dropped_on_purpose:
            self.declared_drops.add(filename)
        dispatcher_fixtures.write_outbox_event(self.paths, filename, event)
        return str(event["id"])

    def write_roster(self, fleet: dict[str, Any]) -> None:
        self.roster_path.parent.mkdir(parents=True, exist_ok=True)
        self.roster_path.write_text(json.dumps(fleet), encoding="utf-8")

    def acknowledge(self, scope: str, at: float | None = None, *, raw: Any = None) -> None:
        """Write the acknowledge file as the operator's tool would, or `raw` bytes/values."""
        path = self.root / ACK_FILE
        if isinstance(raw, (bytes, str)):
            path.write_text(raw if isinstance(raw, str) else raw.decode("utf-8", "replace"), encoding="utf-8")
        else:
            entry = raw if raw is not None else {"ackedAt": int(self.clock.now if at is None else at), "by": "operator"}
            path.write_text(json.dumps({scope: entry}), encoding="utf-8")
        path.chmod(0o600)

    def maintenance(self, scope: str, until: float) -> None:
        path = self.root / "maintenance.json"
        current: dict[str, Any] = {}
        if path.exists():
            current = json.loads(path.read_text(encoding="utf-8"))
        # The record the maintenance tool writes (bot-errors-maintenance.py, cmd_open).
        current[scope] = {"openedAt": int(self.clock.now), "expiresAt": int(until), "reason": "planned work"}
        path.write_text(json.dumps(current), encoding="utf-8")
        path.chmod(0o600)

    def edit_state(self, change: Callable[[dict[str, Any]], None]) -> None:
        """Change the stored incident state between two cycles, through the state session."""
        with self.d.open_dispatcher_state_session() as session:
            loaded = session.load()
            payload = dict(loaded.payload or {})
            change(payload)
            session.save(payload, loaded.capability)

    # -- reading -------------------------------------------------------------

    def state(self) -> dict[str, Any]:
        return self.d.load_incident_state(self.paths)

    def conditions(self) -> dict[str, Any]:
        section = self.state().get(SECTION)
        return section if isinstance(section, dict) else {}

    def entry(self, scope: str) -> dict[str, Any]:
        found = self.conditions().get(scope)
        return found if isinstance(found, dict) else {}

    def phase(self, scope: str) -> str:
        return phase(self.entry(scope))

    def members(self, scope: str) -> list[str]:
        held = self.entry(scope).get("members")
        return sorted(held) if isinstance(held, dict) else []

    def cleared(self, scope: str) -> list[str]:
        held = self.entry(scope).get("clearedAt")
        return sorted(held) if isinstance(held, dict) else []

    def open_scopes(self) -> list[str]:
        return sorted(scope for scope, entry in self.conditions().items()
                      if isinstance(entry, dict) and phase(entry) == "open")

    def open_incident_sources(self) -> list[str]:
        records = self.state().get("openIncidents")
        return sorted(str(key).rsplit("|", 1)[-1] for key in records) if isinstance(records, dict) else []

    def pages(self, needle: str = "") -> list[dict[str, Any]]:
        return [send for send in self.owner if is_class_page(send["text"]) and needle in send["text"]]

    def page_times(self, needle: str = "") -> list[int]:
        return [send["at"] for send in self.pages(needle)]

    def page_texts(self, needle: str = "") -> list[str]:
        return [send["text"] for send in self.pages(needle)]

    def loss_pages(self) -> list[dict[str, Any]]:
        return [send for send in self.owner if is_loss_page(send["text"])]

    def legacy_copies(self, needle: str = "") -> list[dict[str, Any]]:
        return [send for send in self.owner
                if not is_class_page(send["text"]) and not is_loss_page(send["text"]) and needle in send["text"]]

    def page_emails(self, needle: str = "") -> list[dict[str, Any]]:
        return [mail for mail in self.emails if is_class_page(mail["subject"]) and needle in mail["subject"]]

    def copy_emails(self, needle: str = "") -> list[dict[str, Any]]:
        return [mail for mail in self.emails
                if not is_class_page(mail["subject"]) and not is_loss_page(mail["subject"]) and needle in mail["body"]]

    def group_texts(self, needle: str = "") -> list[str]:
        return [send["text"] for send in self.group if needle in send["text"]]

    def group_for(self, event_id: str) -> list[str]:
        return self.group_texts(f"event: {event_id}")

    def meta_alerts(self, source: str) -> list[dict[str, Any]]:
        return [send for send in self.group if f"source: {source}" in send["text"]]

    def meta_attempts(self, source: str) -> list[dict[str, Any]]:
        """Every started group send of the meta-alert `source`, taken or not."""
        return [send for send in self.group_attempts if f"source: {source}" in send["text"]]

    def log(self) -> list[dict[str, Any]]:
        return dispatcher_fixtures.dispatch_log_records(self.paths)

    def class_records(self) -> list[dict[str, Any]]:
        """The class's own dispatch-log records, each as {"type": ..., **details}."""
        found = []
        for record in self.log():
            kind = str(record.get("type") or "")
            if kind.startswith(LOG_PREFIX):
                details = record.get("details") if isinstance(record.get("details"), dict) else {}
                found.append({"type": kind, **details})
        return found

    def logged(self, field: str) -> list[Any]:
        """Every non-empty value the class logged under `field`, in order."""
        return [record[field] for record in self.class_records() if record.get(field)]

    def outbox_names(self) -> list[str]:
        """The queued event files, by the glob the dispatcher itself uses (a writer's lock file is not one)."""
        return sorted(path.name for path in self.paths["outbox"].glob("*.json"))

    def disposition(self, event_id: str) -> list[str]:
        """Where the dispatcher left the event's file: the names of the queue directories that hold it."""
        found = []
        for label in ("outbox", "processing", "sent", "suppressed", "storm_collapsed", "testleak",
                      "quarantine", "dead_letter"):
            directory = self.paths[label]
            if directory.is_dir() and any(event_id in path.name for path in directory.iterdir()):
                found.append(label)
        return found

    def owner_route_state(self) -> bytes:
        path = self.root / "owner-route-state.json"
        return path.read_bytes() if path.exists() else b""


def leak_drop_faults(rigs: list[Rig]) -> list[str]:
    """What is wrong with the events the dispatcher dropped as test leaks; empty when nothing is.

    A dropped file is read from the archive directory, not from the dispatch log: the log keeps no
    event id (a record's strings are projected away, lib/controller_log.py
    metadata_only_controller_details), while the archived file keeps its outbox name (archive_path:
    "<name>.<epoch>.testleak"). The log's record count must still equal the number of archived
    files, so a listing of the wrong directory cannot pass as "nothing dropped".
    The rigs of one test share one state root, so the last one built reads for all.
    """
    if not rigs:
        return []
    rig = rigs[-1]
    declared = {name for built in rigs for name in built.declared_drops}
    directory = rig.paths["testleak"]
    archived = sorted(path.name for path in directory.iterdir()) if directory.is_dir() else []
    faults = [f"{name} was dropped as a test leak and no case put it on purpose" for name in archived
              if not any(name.startswith(f"{put_name}.") for put_name in declared)]
    logged = sum(1 for record in rig.log() if record.get("type") == "test_leak_dropped")
    if logged != len(archived):
        faults.append(f"the dispatch log holds {logged} test_leak_dropped records, the archive {len(archived)} files")
    return faults


@pytest.fixture()
def make_rig(monkeypatch):
    """Build rigs in one directory per test under /tmp, removed when the test ends."""
    base = Path(tempfile.mkdtemp(prefix="repage-", dir="/tmp"))
    rigs: list[Rig] = []

    def build(**options) -> Rig:
        rigs.append(Rig(base, monkeypatch, **options))
        return rigs[-1]

    yield build
    try:
        faults = leak_drop_faults(rigs)
    finally:
        shutil.rmtree(base, ignore_errors=True)
    if faults:
        # put() refuses a fixture event the leak check would drop, but the dispatcher also makes
        # events itself. One of those dropped is a fault of the fixture, never the class's behaviour.
        raise AssertionError(f"{FIXTURE_DROPPED}: {'; '.join(faults)}")


def open_now(rig: Rig, at: float, *, host: str = "hosta", bot: str = "bot-one", source: str = MANUAL) -> str:
    """Put an opener that needs no delay and run the cycle that reads it. Returns the event id."""
    rig.clock.set(at)
    event_id = rig.put(observer_event(source, host, bot, at))
    rig.cycle()
    return event_id


def page_line(where: str, hours: int, page: int) -> str:
    return f"{where}: {PAGE_DEAD}; dead for {hours} h, page {page}"


def every_four_hours(first: int, count: int) -> list[int]:
    return [first + step * INTERVAL for step in range(count)]


# ---------------------------------------------------------------------------
# Scenario: a multi-hour credential incident, replayed on the fake clock.
# ---------------------------------------------------------------------------

T_RUNTIME = clock_at(3, 40, 35)
T_OBSERVER = clock_at(3, 52, 32)
T_PROBE = clock_at(4, 7, 42)
T_OPEN = clock_at(4, 22, 32)
T_UNVERIFIED = clock_at(5, 23, 0)
T_RUNTIME_AGAIN = clock_at(11, 4, 0)


def replay_until_the_probe(rig: Rig, *, relay_host: str, probe_host: str, primary: bool = True) -> str:
    """The first three events of the incident. Returns the fleet probe's event id."""
    if primary:
        rig.clock.set(T_RUNTIME)
        rig.put(runtime_event(PRIMARY, "bot-one", T_RUNTIME, relay_host=relay_host))
        rig.cycle()
    rig.clock.set(T_OBSERVER)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T_OBSERVER))
    rig.cycle()
    rig.clock.set(T_PROBE)
    probe_id = rig.put(probe_event(probe_host, "bot-one", T_PROBE))
    rig.cycle()
    return probe_id


def replay_the_day(rig: Rig, *, relay_host: str, probe_host: str) -> None:
    """The rest of the table: the opening cycle, the two later warnings, and a cycle at each page time."""
    rig.cycle_at(T_OPEN)
    rig.clock.set(T_UNVERIFIED)
    rig.put(probe_event(probe_host, "bot-one", T_UNVERIFIED, unverified=True))
    rig.cycle()
    rig.cycle_at(T_OPEN + INTERVAL)
    rig.clock.set(T_RUNTIME_AGAIN)
    rig.put(runtime_event(PRIMARY, "bot-one", T_RUNTIME_AGAIN, relay_host=relay_host))
    rig.cycle()
    rig.cycle_at(T_OPEN + 2 * INTERVAL)
    rig.cycle_at(T_OPEN + 3 * INTERVAL)


def test_t0b_the_incident_is_paged_every_four_hours_with_a_readable_roster(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    rig.clock.set(T_RUNTIME)
    rig.put(runtime_event(PRIMARY, "bot-one", T_RUNTIME, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "latent"

    probe_id = replay_until_the_probe(rig, relay_host="hosta.example", probe_host="hosta", primary=False)
    assert rig.phase("hosta|bot-one") == "pending"
    assert rig.entry("hosta|bot-one").get("pendingSince") == micros(T_OBSERVER)
    assert rig.pages() == []
    # The fleet probe's copy is still sent, and while the condition is pending
    # its e-mail asks for a human, not for Q.
    assert [send["at"] for send in rig.legacy_copies("primary model check failed")] == [T_PROBE]
    probe_mail = rig.copy_emails(f"event: {probe_id}")
    assert len(probe_mail) == 1
    assert HUMAN_ACTION in probe_mail[0]["body"]
    assert Q_INVESTIGATE not in probe_mail[0]["body"]

    replay_the_day(rig, relay_host="hosta.example", probe_host="hosta")
    assert rig.page_times() == every_four_hours(T_OPEN, 4)
    assert rig.page_texts() == [page_line("hosta/bot-one", hours, page)
                                for hours, page in ((0, 1), (4, 2), (8, 3), (12, 4))]
    assert rig.open_scopes() == ["hosta|bot-one"]


def test_t0b_the_incident_is_paged_the_same_with_the_roster_unreadable(make_rig):
    # Three host strings for one bot: the relay host of its runtime event,
    # the re-auth observer's machine, and the host in the fleet probe's source name.
    rig = make_rig(fleet=UNREADABLE)
    probe_id = replay_until_the_probe(rig, relay_host="hosta.example", probe_host="hostalias")
    assert rig.phase("hosta.example|bot-one") == "latent"
    assert rig.phase("hosta|bot-one") == "pending"
    assert rig.phase("hostalias|bot-one") == "latent"
    assert [send["at"] for send in rig.legacy_copies("primary model check failed")] == [T_PROBE]
    probe_mail = rig.copy_emails(f"event: {probe_id}")
    assert len(probe_mail) == 1
    assert HUMAN_ACTION in probe_mail[0]["body"]
    assert Q_INVESTIGATE not in probe_mail[0]["body"]

    replay_the_day(rig, relay_host="hosta.example", probe_host="hostalias")
    assert rig.page_times() == every_four_hours(T_OPEN, 4)
    assert rig.page_texts() == [page_line("hosta/bot-one", hours, page)
                                for hours, page in ((0, 1), (4, 2), (8, 3), (12, 4))]
    assert rig.open_scopes() == ["hosta|bot-one"]


def observer_moves_to(rig: Rig, source: str, at: int) -> None:
    """The re-auth observer changes its diagnosis: a clear of the old source, then an alert of the new one."""
    rig.clock.set(at)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", at, clear=True))
    rig.put(observer_event(source, "hosta", "bot-one", at))
    rig.cycle()


def test_t0c_a_change_to_a_sustain_only_diagnosis_keeps_the_four_pages(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    replay_until_the_probe(rig, relay_host="hosta.example", probe_host="hosta")
    assert rig.cycle_at(T_OPEN) is None
    assert rig.page_times() == [T_OPEN]

    observer_moves_to(rig, INDETERMINATE, T_UNVERIFIED)
    assert rig.members("hosta|bot-one") == sorted([INDETERMINATE, PRIMARY, probe_source("hosta", "bot-one")])
    for step in (1, 2, 3):
        rig.cycle_at(T_OPEN + step * INTERVAL)
    assert rig.page_times() == every_four_hours(T_OPEN, 4)
    # No opener is left, so from the second page on the line says what is known.
    later = rig.page_texts()[1:]
    assert [PAGE_UNVERIFIED in text and PAGE_STILL_UNUSABLE in text for text in later] == [True, True, True]
    assert ["the re-auth observer now reports indeterminate_investigate" in text for text in later] == [
        True, True, True]


def test_t0c_a_change_to_a_non_member_diagnosis_is_held_by_the_runtime_signal(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    replay_until_the_probe(rig, relay_host="hosta.example", probe_host="hosta")
    assert rig.cycle_at(T_OPEN) is None
    assert rig.page_times() == [T_OPEN]

    observer_moves_to(rig, NON_MEMBER, T_UNVERIFIED)
    assert rig.members("hosta|bot-one") == sorted([PRIMARY, probe_source("hosta", "bot-one")])
    for step in (1, 2, 3):
        rig.cycle_at(T_OPEN + step * INTERVAL)
    assert rig.page_times() == every_four_hours(T_OPEN, 4)
    later = rig.page_texts()[1:]
    assert [PAGE_UNVERIFIED in text and PAGE_STILL_UNUSABLE in text for text in later] == [True, True, True]

    # The runtime's clear then ends the condition, after the grace.
    cleared_at = clock_at(17)
    rig.clock.set(cleared_at)
    rig.put(runtime_event(PRIMARY, "bot-one", cleared_at, relay_host="hosta.example", clear=True))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "open"
    rig.cycle_at(cleared_at + GRACE - 1)
    assert rig.phase("hosta|bot-one") == "open"
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(T_OPEN + 4 * INTERVAL)
    assert rig.page_times() == every_four_hours(T_OPEN, 4)


def test_t0c_a_change_to_a_non_member_diagnosis_with_no_runtime_signal_ends_the_condition(make_rig):
    # The residual silent case: only the re-auth observer held the condition, and it moved on.
    rig = make_rig(fleet=ROSTER_ONE)
    replay_until_the_probe(rig, relay_host="hosta.example", probe_host="hosta", primary=False)
    assert rig.cycle_at(T_OPEN) is None
    assert rig.page_times() == [T_OPEN]

    observer_moves_to(rig, NON_MEMBER, T_UNVERIFIED)
    rig.cycle_at(T_UNVERIFIED + GRACE - 1)
    assert rig.phase("hosta|bot-one") == "open"
    rig.cycle_at(T_UNVERIFIED + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(T_OPEN + INTERVAL)
    assert rig.page_times() == [T_OPEN]


def test_t0d_no_fallback_beside_the_runtime_signal_opens_at_once(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    rig.clock.set(T_RUNTIME)
    rig.put(runtime_event(PRIMARY, "bot-one", T_RUNTIME, relay_host="hosta.example"))
    rig.cycle()
    opened = clock_at(3, 45)
    rig.clock.set(opened)
    rig.put(runtime_event(NO_FALLBACK, "bot-one", opened, relay_host="hosta.example", severity="critical"))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [opened]

    replay_until_the_probe(rig, relay_host="hosta.example", probe_host="hosta", primary=False)
    for step in (1, 2, 3):
        rig.cycle_at(opened + step * INTERVAL)
    assert rig.page_times() == every_four_hours(opened, 4)
    assert rig.open_scopes() == ["hosta|bot-one"]


# ---------------------------------------------------------------------------
# Cadence and the boundary of the class.
# ---------------------------------------------------------------------------

T0 = clock_at(3)


def test_t1_an_unrouted_opener_is_paged_every_four_hours_with_no_new_event(make_rig):
    # The opener is a warning the legacy route never takes, so nothing but the
    # timer can produce these pages.
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    opened = T0 + PROMOTION
    for step in range(4):
        rig.cycle_at(opened + step * INTERVAL)
    assert rig.page_times() == every_four_hours(opened, 4)
    assert rig.page_texts() == [page_line("hosta/bot-one", hours, page)
                                for hours, page in ((0, 1), (4, 2), (8, 3), (12, 4))]
    assert rig.legacy_copies() == []


def test_t2_a_page_at_opening_and_none_before_four_hours(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    assert rig.cycle_at(T0 + INTERVAL - 60) is None
    assert rig.page_times() == [T0]


def test_t3_pin_a_non_member_incident_keeps_the_ladder_and_the_route_floor(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert [send["at"] for send in rig.legacy_copies()] == [T0]

    # The timer never pages it: cycles with no event send nothing to the owner.
    rig.cycle_at(T0 + 2 * HOUR)
    rig.cycle_at(T0 + INTERVAL)
    assert [send["at"] for send in rig.owner] == [T0]

    # The ladder: a repeat inside 6 h is absorbed, one after 6 h re-notifies the
    # group, and a plain re-notification is not copied to the owner.
    early_at = T0 + 5 * HOUR
    rig.clock.set(early_at)
    early = rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", early_at))
    rig.cycle()
    late_at = T0 + 6 * HOUR + 60
    rig.clock.set(late_at)
    late = rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", late_at))
    rig.cycle()
    assert rig.group_for(early) == []
    assert len(rig.group_for(late)) == 1
    assert [send["at"] for send in rig.owner] == [T0]
    assert rig.pages() == []
    assert rig.open_scopes() == []


def test_t3_pin_the_route_floor_holds_back_a_second_opening_inside_six_hours(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0))
    rig.cycle()
    rig.clock.set(T0 + HOUR)
    rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0 + HOUR, clear=True))
    rig.cycle()
    again_at = T0 + 3 * HOUR
    rig.clock.set(again_at)
    again = rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", again_at))
    assert rig.cycle() is None
    # A new incident opened and the group was told, but the owner's 6 h floor
    # for that incident key had not passed.
    assert len(rig.group_for(again)) == 1
    assert [send["at"] for send in rig.owner] == [T0]

    rig.clock.set(T0 + 4 * HOUR)
    rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0 + 4 * HOUR, clear=True))
    rig.cycle()
    third_at = T0 + 7 * HOUR
    rig.clock.set(third_at)
    rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", third_at))
    rig.cycle()
    assert [send["at"] for send in rig.legacy_copies()] == [T0, third_at]
    assert rig.pages() == []


def test_t4_the_runtime_signal_alone_is_latent_and_never_pages(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    alert = rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [PRIMARY]
    assert rig.phase("hosta|bot-one") == "latent"
    assert page_fields_set(rig.entry("hosta|bot-one")) == []
    assert len(rig.group_for(alert)) == 1

    # It never starts the 30 minutes, and five hours later nothing was paged.
    rig.cycle_at(T0 + PROMOTION)
    rig.cycle_at(T0 + 5 * HOUR)
    assert rig.phase("hosta|bot-one") == "latent"
    assert rig.pages() == []

    # Its clear deletes the entry in that cycle, with no grace.
    rig.put(runtime_event(PRIMARY, "bot-one", T0 + 5 * HOUR, relay_host="hosta.example", clear=True))
    rig.cycle()
    assert rig.members("hosta|bot-one") == []
    assert rig.phase("hosta|bot-one") == "absent"


def test_t5_pin_the_fleet_probe_alone_keeps_its_copy_and_todays_sentence(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    probe_id = rig.put(probe_event("hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert [send["at"] for send in rig.legacy_copies("primary model check failed")] == [T0]
    mail = rig.copy_emails(f"event: {probe_id}")
    assert len(mail) == 1
    assert Q_INVESTIGATE in mail[0]["body"]
    assert "Human action required" not in mail[0]["body"]
    rig.cycle_at(T0 + INTERVAL)
    assert rig.pages() == []
    assert rig.open_scopes() == []


def test_t5_the_fleet_probe_beside_an_opener_joins_and_its_copy_asks_for_a_human(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.phase("hosta|bot-one") == "open"
    rig.clock.set(T0 + 60)
    probe_id = rig.put(probe_event("hosta", "bot-one", T0 + 60))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == sorted([MANUAL, probe_source("hosta", "bot-one")])
    # It keeps its own owner copy, with the human sentence.
    assert [send["at"] for send in rig.legacy_copies("primary model check failed")] == [T0 + 60]
    mail = rig.copy_emails(f"event: {probe_id}")
    assert len(mail) == 1
    assert HUMAN_ACTION in mail[0]["body"]
    assert Q_INVESTIGATE not in mail[0]["body"]
    # And the next page's e-mail names it among the members.
    rig.cycle_at(T0 + INTERVAL)
    page_mail = rig.page_emails("page 2")
    assert len(page_mail) == 1
    assert probe_source("hosta", "bot-one") in page_mail[0]["body"]


def test_t5_with_the_roster_unreadable_the_probe_sits_in_its_own_latent_entry(make_rig):
    rig = make_rig(fleet=UNREADABLE)
    open_now(rig, T0)
    rig.clock.set(T0 + 60)
    probe_id = rig.put(probe_event("hostalias", "bot-one", T0 + 60))
    assert rig.cycle() is None
    assert rig.members("hostalias|bot-one") == [probe_source("hostalias", "bot-one")]
    assert rig.phase("hostalias|bot-one") == "latent"
    assert rig.members("hosta|bot-one") == [MANUAL]
    mail = rig.copy_emails(f"event: {probe_id}")
    assert len(mail) == 1
    assert HUMAN_ACTION in mail[0]["body"]
    assert Q_INVESTIGATE not in mail[0]["body"]
    rig.cycle_at(T0 + INTERVAL)
    page_mail = rig.page_emails("page 2")
    assert len(page_mail) == 1
    assert probe_source("hostalias", "bot-one") in page_mail[0]["body"]


def test_t5_the_unverified_form_joins_the_same_way_and_has_no_owner_copy(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.clock.set(T0 + 60)
    unverified = probe_source("hosta", "bot-one", unverified=True)
    warning_id = rig.put(probe_event("hosta", "bot-one", T0 + 60, unverified=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == sorted([MANUAL, unverified])
    group = rig.group_for(warning_id)
    assert len(group) == 1
    assert HUMAN_ACTION in group[0]
    assert Q_INVESTIGATE not in group[0]
    # Its owner copy is what the legacy route gives it today: none. The verified
    # form, beside it, has one.
    assert rig.legacy_copies("health unverified") == []
    rig.clock.set(T0 + 120)
    rig.put(probe_event("hosta", "bot-one", T0 + 120))
    rig.cycle()
    assert [send["at"] for send in rig.legacy_copies("primary model check failed")] == [T0 + 120]
    rig.cycle_at(T0 + INTERVAL)
    page_mail = rig.page_emails("page 2")
    assert len(page_mail) == 1
    assert unverified in page_mail[0]["body"]


def test_t6_the_fleet_probe_does_not_keep_a_condition_alive(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.clock.set(T0 + 60)
    rig.put(probe_event("hosta", "bot-one", T0 + 60))
    rig.cycle()
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0]

    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    # The probe still fires inside the grace.
    rig.clock.set(cleared_at + 300)
    rig.put(probe_event("hosta", "bot-one", cleared_at + 300))
    rig.cycle()
    assert rig.phase("hosta|bot-one") == "open"
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0]


def test_t7_an_event_held_by_transient_tiering_still_refreshes_its_member(make_rig):
    rig = make_rig(env={"BOT_ERRORS_TRANSIENT_SOURCES": PRIMARY})
    rig.clock.set(T0)
    first = rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.group_for(first) == []  # held: the group was not told
    assert rig.members("hosta|bot-one") == [PRIMARY]
    rig.clock.set(T0 + 600)
    second = rig.put(runtime_event(PRIMARY, "bot-one", T0 + 600, relay_host="hosta.example"))
    rig.cycle()
    assert rig.group_for(second) == []
    assert seen(rig, "hosta|bot-one", PRIMARY) == (micros(T0), micros(T0 + 600))


def test_t7_an_event_suppressed_as_a_duplicate_still_refreshes_its_member(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.clock.set(T0 + HOUR)
    repeat = rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + HOUR))
    assert rig.cycle() is None
    assert rig.group_for(repeat) == []  # the incident is already open: absorbed
    assert seen(rig, "hosta|bot-one", MANUAL) == (micros(T0), micros(T0 + HOUR))


def test_t48_a_new_death_599_seconds_after_the_clear_is_the_same_episode(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.clock.set(cleared_at + GRACE - 1)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at + GRACE - 1))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(T0)
    assert rig.page_times() == [T0]  # no immediate page: the floor is kept
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_texts() == [page_line("hosta/bot-one", 0, 1), page_line("hosta/bot-one", 4, 2)]


def test_t48_a_new_death_600_seconds_after_the_clear_is_a_new_condition(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.clock.set(cleared_at + GRACE)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at + GRACE))
    assert rig.cycle() is None
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(cleared_at + GRACE)
    assert rig.page_times() == [T0, cleared_at + GRACE]
    assert rig.page_texts() == [page_line("hosta/bot-one", 0, 1), page_line("hosta/bot-one", 0, 1)]


def test_t49_a_condition_open_for_eight_days_is_paged_49_times(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    for step in range(1, 49):
        rig.cycle_at(T0 + step * INTERVAL)
    assert rig.page_times() == every_four_hours(T0, 49)
    assert rig.phase("hosta|bot-one") == "open"


def test_t49_a_latent_sustain_still_holds_the_condition_on_day_eight(make_rig):
    # The roster is unreadable. The re-auth observer's blind diagnosis was reported once, under
    # another host string, and never again: its entry must not age out while it
    # is what keeps the condition open.
    rig = make_rig(fleet=UNREADABLE)
    rig.clock.set(T0 - 60)
    rig.put(observer_event(INDETERMINATE, "hostz", "bot-one", T0 - 60))
    rig.cycle()
    open_now(rig, T0)
    assert rig.phase("hostz|bot-one") == "latent"
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + HOUR)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + HOUR, clear=True))
    rig.cycle()
    for step in range(1, 49):
        rig.cycle_at(T0 + step * INTERVAL)
    assert rig.members("hostz|bot-one") == [INDETERMINATE]
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == every_four_hours(T0, 49)
    assert PAGE_UNVERIFIED in rig.page_texts()[-1]


def test_t82_a_latent_entry_is_kept_for_seven_days_after_it_was_last_seen(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    rig.cycle_at(T0 + RETENTION - HOUR)
    assert rig.members("hosta|bot-one") == [PRIMARY]
    rig.cycle_at(T0 + RETENTION + 60)
    assert rig.members("hosta|bot-one") == []


def test_t82_a_deleted_conditions_cleared_map_is_applied_for_seven_days(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    deleted_at = cleared_at + GRACE
    rig.cycle_at(deleted_at)
    assert rig.cleared("hosta|bot-one") == [MANUAL]
    assert rig.phase("hosta|bot-one") == "absent"

    # An alert created before that clear comes back six days and 23 hours later:
    # it is ignored.
    rig.clock.set(deleted_at + RETENTION - HOUR)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 1800))
    rig.cycle()
    assert rig.cleared("hosta|bot-one") == [MANUAL]
    assert rig.phase("hosta|bot-one") == "absent"
    assert rig.page_times() == [T0]

    # After seven days the map is gone, and the same old alert is a new one.
    rig.cycle_at(deleted_at + RETENTION + 60)
    assert rig.cleared("hosta|bot-one") == []
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 1800))
    rig.cycle()
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0, deleted_at + RETENTION + 60]


# ---------------------------------------------------------------------------
# Scope: one bot, one condition, whatever host string each emitter writes.
# ---------------------------------------------------------------------------


def test_t75_four_emitters_of_a_uniquely_named_bot_join_one_condition(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    # The watchdog's event is the first opener, with its own host string.
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    rig.clock.set(T0 + 30)
    rig.put(runtime_event(PRIMARY, "bot-one", T0 + 10, relay_host="hosta.example"))
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 20))
    rig.put(probe_event("hosta", "bot-one", T0 + 30))
    assert rig.cycle() is None
    assert sorted(rig.conditions()) == ["hosta|bot-one"]
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL, PRIMARY, probe_source("hosta", "bot-one")])
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]
    # The page names the opener's own host string, not the roster's label.
    assert rig.page_texts() == [page_line("hosta.local/bot-one", 0, 1), page_line("hosta.local/bot-one", 4, 2)]
    page_mail = rig.page_emails("page 2")
    assert len(page_mail) == 1
    assert probe_source("hosta", "bot-one") in page_mail[0]["body"]


def test_t75_a_roster_row_that_expects_no_bot_does_not_make_the_name_a_duplicate(make_rig):
    rig = make_rig(fleet=roster(("hosta", "bot-one"), ("hostc", "bot-one", "none"), ("hostb", "bot-two")))
    open_now(rig, T0)
    assert rig.open_scopes() == ["hosta|bot-one"]
    # None of this event's strings matches a roster host. The name is still on
    # one host only, so it joins the same condition.
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "aliasx", "bot-one", T0 + 60))
    assert rig.cycle() is None
    assert sorted(rig.conditions()) == ["hosta|bot-one"]
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]


def open_both_dup_bots(rig: Rig) -> None:
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "dup-bot", T0))
    rig.put(observer_event(MANUAL, "hostb", "dup-bot", T0))
    rig.cycle()


def test_t76_two_bots_of_one_name_have_two_conditions_and_separate_acknowledgements(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    open_both_dup_bots(rig)
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]
    assert sorted(rig.page_texts()) == [page_line("hosta/dup-bot", 0, 1), page_line("hostb/dup-bot", 0, 1)]
    rig.clock.set(T0 + HOUR)
    rig.acknowledge("hosta|dup-bot")
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_texts()[2:] == [page_line("hostb/dup-bot", 4, 2)]


def test_t76_a_sustain_never_holds_the_other_bots_condition_when_both_are_open(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    open_both_dup_bots(rig)
    rig.clock.set(T0 + 60)
    rig.put(observer_event(INDETERMINATE, "hostb", "dup-bot", T0 + 60))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == sorted([INDETERMINATE, MANUAL])
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "dup-bot", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == ["hostb|dup-bot"]


def test_t76_a_sustain_never_holds_the_other_bots_condition_when_only_one_is_open(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    rig.clock.set(T0 - 60)
    rig.put(observer_event(INDETERMINATE, "hostb", "dup-bot", T0 - 60))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == [INDETERMINATE]
    open_now(rig, T0, bot="dup-bot")
    assert rig.open_scopes() == ["hosta|dup-bot"]
    assert rig.page_times() == [T0]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "dup-bot", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    assert rig.phase("hostb|dup-bot") == "latent"
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0]


def test_t76_a_fleet_probe_event_joins_by_the_host_in_its_source_name(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    open_both_dup_bots(rig)
    rig.clock.set(T0 + 60)
    # Its `machine` field is the probing host, which is no roster host.
    rig.put(probe_event("hostb", "dup-bot", T0 + 60, probing_host="probehost"))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == sorted([MANUAL, probe_source("hostb", "dup-bot")])
    assert rig.members("hosta|dup-bot") == [MANUAL]
    assert sorted(rig.conditions()) == ["hosta|dup-bot", "hostb|dup-bot"]
    rig.cycle_at(T0 + INTERVAL)
    mail_a = rig.page_emails(page_line("hosta/dup-bot", 4, 2))
    mail_b = rig.page_emails(page_line("hostb/dup-bot", 4, 2))
    assert (len(mail_a), len(mail_b)) == (1, 1)
    assert probe_source("hostb", "dup-bot") in mail_b[0]["body"]
    assert probe_source("hostb", "dup-bot") not in mail_a[0]["body"]


def test_t52_a_sustain_matches_its_roster_host_by_the_first_label_of_its_machine(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    open_now(rig, T0, bot="dup-bot")
    rig.clock.set(T0 + 60)
    rig.put(observer_event(INDETERMINATE, "hosta.local", "dup-bot", T0 + 60))
    assert rig.cycle() is None
    assert rig.members("hosta|dup-bot") == sorted([INDETERMINATE, MANUAL])
    # It holds that condition after the opener clears.
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "dup-bot", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == ["hosta|dup-bot"]
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert PAGE_UNVERIFIED in rig.page_texts()[-1]


def test_t52_a_sustain_with_no_machine_matches_by_its_relay_host(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "dup-bot", T0, relay_host="hostb"))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == [PRIMARY]
    assert sorted(rig.conditions()) == ["hostb|dup-bot"]


def test_t52_a_sustain_with_no_machine_matches_by_the_first_label_of_its_relay_host(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "dup-bot", T0, relay_host="hostb.example"))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == [PRIMARY]
    assert sorted(rig.conditions()) == ["hostb|dup-bot"]


def test_t52_a_sustain_whose_machine_matches_nothing_falls_back_to_its_relay_host(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    rig.clock.set(T0)
    relayed = observer_event(INDETERMINATE, "otherbox", "dup-bot", T0)
    relayed["diagnostics"]["relay"] = {"remoteHost": "hosta.example", "collectorHost": "collector"}
    rig.put(relayed)
    assert rig.cycle() is None
    assert rig.members("hosta|dup-bot") == [INDETERMINATE]
    assert sorted(rig.conditions()) == ["hosta|dup-bot"]


def test_t52_an_unmatched_sustain_is_counted_and_does_not_hold_the_condition(make_rig):
    # The stated limit for a name the roster lists on several hosts.
    rig = make_rig(fleet=ROSTER_DUP)
    open_now(rig, T0, bot="dup-bot")
    assert rig.open_scopes() == ["hosta|dup-bot"]
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + 60)
    rig.put(observer_event(INDETERMINATE, "strayhost", "dup-bot", T0 + 60))
    assert rig.cycle() is None
    assert rig.members("strayhost|dup-bot") == [INDETERMINATE]
    assert rig.phase("strayhost|dup-bot") == "latent"
    assert rig.logged("unmatchedScopes") == [1]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "dup-bot", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0]


def sustain_then_opener(rig: Rig, *, sustain_first: bool) -> None:
    """The order for `bot-one` (or its reverse): a runtime sustain and a re-auth observer opener,
    under two host strings."""
    first, second = (T0 - 60, T0) if sustain_first else (T0, T0 - 60)
    for at in sorted((first, second)):
        rig.clock.set(at)
        if at == first:
            rig.put(runtime_event(PRIMARY, "bot-one", at, relay_host="hosta.example"))
        else:
            rig.put(observer_event(MANUAL, "hosta", "bot-one", at))
        rig.cycle()


def held_only_by_the_latent_sustain(rig: Rig) -> int:
    """The re-auth observer moves to a diagnosis outside the class. Returns the time of that change."""
    moved_at = T0 + HOUR
    rig.clock.set(moved_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", moved_at, clear=True))
    rig.put(observer_event(NON_MEMBER, "hosta", "bot-one", moved_at))
    rig.cycle()
    return moved_at


def check_t83_sequence(rig: Rig, opened: int) -> None:
    assert rig.phase("hosta.example|bot-one") == "latent"
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [opened]
    moved_at = held_only_by_the_latent_sustain(rig)
    rig.cycle_at(moved_at + GRACE)
    assert rig.open_scopes() == ["hosta|bot-one"]
    rig.cycle_at(opened + INTERVAL)
    assert rig.page_times() == [opened, opened + INTERVAL]
    assert PAGE_UNVERIFIED in rig.page_texts()[-1]
    # The sustain's clear ends it, after the grace.
    cleared_at = opened + INTERVAL + HOUR
    rig.clock.set(cleared_at)
    rig.put(runtime_event(PRIMARY, "bot-one", cleared_at, relay_host="hosta.example", clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE - 1)
    assert rig.open_scopes() == ["hosta|bot-one"]
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(opened + 2 * INTERVAL)
    assert rig.page_times() == [opened, opened + INTERVAL]


def test_t83_a_sustain_that_arrived_first_holds_the_condition_by_name(make_rig):
    rig = make_rig(fleet=UNREADABLE)
    sustain_then_opener(rig, sustain_first=True)
    assert sorted(rig.conditions()) == ["hosta.example|bot-one", "hosta|bot-one"]
    check_t83_sequence(rig, opened=T0)


def test_t83_the_opposite_arrival_order_gives_the_same_pages(make_rig):
    rig = make_rig(fleet=UNREADABLE)
    sustain_then_opener(rig, sustain_first=False)
    assert sorted(rig.conditions()) == ["hosta.example|bot-one", "hosta|bot-one"]
    check_t83_sequence(rig, opened=T0 - 60)


def test_t83_a_roster_repaired_while_a_latent_sustain_holds_the_condition(make_rig):
    rig = make_rig(fleet=UNREADABLE)
    sustain_then_opener(rig, sustain_first=True)
    assert rig.page_times() == [T0]
    moved_at = held_only_by_the_latent_sustain(rig)
    rig.cycle_at(moved_at + GRACE)
    assert rig.open_scopes() == ["hosta|bot-one"]

    # The roster becomes readable between two cycles, with the bot on one host.
    rig.write_roster(ROSTER_ONE)
    rig.cycle_at(T0 + INTERVAL)
    # The stored entries keep their keys, and the condition is still held by name.
    assert sorted(rig.conditions()) == ["hosta.example|bot-one", "hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert PAGE_UNVERIFIED in rig.page_texts()[-1]

    # The sustain's clear now maps to the roster's key. It still removes the
    # member from the entry stored under the older key.
    cleared_at = T0 + INTERVAL + HOUR
    rig.clock.set(cleared_at)
    rig.put(runtime_event(PRIMARY, "bot-one", cleared_at, relay_host="hosta.example", clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta.example|bot-one") == []
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(T0 + 2 * INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]


def emitter_environment() -> dict[str, str]:
    """The test's own environment without the emitter's strong test signals, so the
    child writes a production-shaped event."""
    blocked = {"PYTEST_CURRENT_TEST", "VITEST", "VITEST_WORKER_ID", "JEST_WORKER_ID"}
    return {key: value for key, value in os.environ.items() if key not in blocked}


def emit_clear_with_the_real_emitter(rig: Rig, bot: str, source: str) -> dict[str, Any]:
    """Run bot-errors-emit.py --clear as a child and return the event it wrote to the outbox."""
    before = set(rig.outbox_names())
    subprocess.run(
        [sys.executable, str(_EMITTER), "--clear", "--instance", bot, "--source", source],
        env=emitter_environment(), check=True, capture_output=True, timeout=60,
    )
    written = sorted(set(rig.outbox_names()) - before)
    events = [json.loads((rig.paths["outbox"] / name).read_text(encoding="utf-8")) for name in written]
    if len(events) != 1:
        raise AssertionError(f"{FIXTURE_DROPPED}: the emitter wrote {len(events)} events, expected 1")
    leak = rig.d.matched_test_leak_pattern(events[0])
    if leak is not None or rig.d.is_test_provenance_event(events[0]):
        raise AssertionError(f"{FIXTURE_DROPPED}: the emitter's clear would be discarded ({leak or 'test provenance'})")
    return events[0]


def test_t83_a_roster_that_gains_the_name_while_its_opener_is_stored_under_another_key(make_rig):
    # The emitter stamps the real clock, so this case runs at the real time. The whole sequence
    # runs before the first assertion about the class, so that on the unchanged code the case
    # fails with the emitter's clear already processed.
    now = int(real_time.time())
    rig = make_rig(fleet=roster(("hostb", "bot-two")), start=now - 120)
    opener_at = now - 120
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", opener_at))
    rig.cycle()
    rig.write_roster(ROSTER_ONE)
    clear = emit_clear_with_the_real_emitter(rig, "bot-one", DEAD)
    cleared_at = calendar.timegm(real_time.strptime(clear["createdAt"], "%Y-%m-%dT%H:%M:%SZ"))
    rig.clock.set(cleared_at + 5)
    raised = rig.cycle()
    processed = rig.disposition(str(clear["id"]))
    # A late copy of the opener: created before the clear, read after it.
    rig.clock.set(cleared_at + 30)
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", opener_at + 30))
    rig.cycle()
    class_state_before_the_grace_ends = (
        rig.open_scopes(), rig.members("hosta.local|bot-one"), rig.phase("hosta|bot-one"))
    rig.cycle_at(cleared_at + GRACE)
    class_state_after_the_grace = rig.open_scopes()
    rig.cycle_at(opener_at + INTERVAL)

    # The emitter's clear was a real event to the dispatcher: read and archived,
    # not thrown away as a test artefact.
    assert raised is None
    assert processed in (["sent"], ["suppressed"])
    # It mapped to the roster's key and still removed the member stored under
    # the opener's own host string; the late copy opened nothing at either key.
    assert class_state_before_the_grace_ends == (["hosta.local|bot-one"], [], "absent")
    assert class_state_after_the_grace == []
    assert rig.page_times() == [opener_at]


def test_t95_a_clear_read_while_the_roster_is_unreadable_reaches_the_entry_its_opener_named(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    # The roster holds the name on one host, so the opener's own host string maps to the roster's key.
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0]
    # The roster cannot be read when the recovery arrives, so the clear keys by its own host string.
    rig.roster_path.unlink()
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", cleared_at, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    # Restoring the roster brings nothing back.
    rig.write_roster(ROSTER_ONE)
    assert rig.cycle_at(cleared_at + GRACE) is None
    assert rig.open_scopes() == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0]
    assert rig.logged("passFault") == []


def test_t95_with_the_roster_unreadable_a_clear_from_another_host_string_leaves_the_entry(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    rig.roster_path.unlink()
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    # The same name from another host string: without the roster, nothing says it is the same bot.
    rig.put(watchdog_event(DEAD, "hostb.local", "bot-one", cleared_at, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_with_the_roster_unreadable_a_clear_from_another_machine_string_of_the_key_host_leaves_the_entry(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    rig.roster_path.unlink()
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    # Another machine string whose first label is the entry's key host. The entry's opener wrote hosta.local, and
    # without the roster only the opener's own machine string names the bot.
    rig.put(watchdog_event(DEAD, "hosta.lan", "bot-one", cleared_at, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def shared_machine_death(host: str, at: float, *, clear: bool = False, bot: str = "dup-bot") -> dict[str, Any]:
    """The Python emitter's event of `bot`, written on a machine whose name two bot hosts share
    and relayed from `host` by the collector."""
    event = watchdog_event(DEAD, "sharedbox", bot, at, clear=clear)
    event["diagnostics"]["relay"] = {
        "remoteHost": host,
        "remoteRoot": "/srv/bot/state/bot-errors",
        "remoteClaim": "claim-1",
        "remoteName": "event.json",
        "collectorHost": "collector",
        "collectedAt": iso(at),
    }
    return event


def test_t95_a_machine_string_two_entries_share_does_not_carry_a_clear_to_the_other_bot(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    # The roster lists dup-bot on two hosts; each death maps to its key by its relay host, and both
    # entries keep the opener's own machine string. One cycle each, so the storm pass takes neither.
    rig.clock.set(T0)
    rig.put(shared_machine_death("hosta", T0))
    assert rig.cycle() is None
    rig.clock.set(T0 + 60)
    rig.put(shared_machine_death("hostb", T0 + 60))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]
    assert [rig.entry(key).get("machine") for key in rig.open_scopes()] == ["sharedbox", "sharedbox"]
    assert rig.page_times() == [T0, T0 + 60]
    # The bot on hosta recovers. The machine string names two entries, so it tells neither bot apart.
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(shared_machine_death("hosta", cleared_at, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|dup-bot") == []
    assert rig.members("hostb|dup-bot") == [DEAD]
    assert rig.cycle_at(cleared_at + GRACE) is None
    assert rig.open_scopes() == ["hostb|dup-bot"]
    assert rig.cycle_at(T0 + 60 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + 60, T0 + 60 + INTERVAL]
    assert rig.logged("passFault") == []


def both_shared_machine_bots_open(rig: Rig) -> None:
    """dup-bot dies on hosta at T0 and on hostb at T0 + 60; both entries keep the machine string `sharedbox`."""
    rig.clock.set(T0)
    rig.put(shared_machine_death("hosta", T0))
    assert rig.cycle() is None
    rig.clock.set(T0 + 60)
    rig.put(shared_machine_death("hostb", T0 + 60))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]


def test_t95_a_queued_clear_read_after_its_own_bots_condition_ended_leaves_the_other_bot(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    both_shared_machine_bots_open(rig)
    # The bot on hostb recovers. The group send of its clear keeps failing, so the clear stays queued.
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    clear = rig.put(shared_machine_death("hostb", cleared_at, clear=True))
    fail_group_sends_of(rig, clear)
    assert rig.cycle() is None
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hostb|dup-bot") == []
    # Past the grace hostb's condition ends; the next scan reads the queued clear again.
    assert rig.cycle_at(cleared_at + GRACE) is None
    assert rig.open_scopes() == ["hosta|dup-bot"]
    assert rig.cycle_at(cleared_at + GRACE + 60) is None
    assert rig.members("hosta|dup-bot") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + 60, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_with_the_roster_unreadable_a_queued_clear_still_leaves_the_other_bot(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    both_shared_machine_bots_open(rig)
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    clear = rig.put(shared_machine_death("hostb", cleared_at, clear=True))
    fail_group_sends_of(rig, clear)
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == []
    # From here the roster cannot be read, so the queued clear keys by its own machine string.
    rig.roster_path.unlink()
    assert rig.cycle_at(cleared_at + GRACE) is None
    assert rig.open_scopes() == ["hosta|dup-bot"]
    assert rig.cycle_at(cleared_at + GRACE + 60) is None
    assert rig.members("hosta|dup-bot") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + 60, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_a_second_clear_after_its_own_bots_condition_ended_leaves_the_other_bot(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    both_shared_machine_bots_open(rig)
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(shared_machine_death("hostb", cleared_at, clear=True))
    assert rig.cycle() is None
    assert rig.cycle_at(cleared_at + GRACE) is None
    assert rig.open_scopes() == ["hosta|dup-bot"]
    # The watchdog on hostb writes a second clear after its condition ended.
    again_at = cleared_at + GRACE + 60
    rig.clock.set(again_at)
    rig.put(shared_machine_death("hostb", again_at, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|dup-bot") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + 60, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_a_clear_from_the_bot_with_no_condition_leaves_the_other_bot(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    # Only the bot on hostb dies: the bot on hosta has no scope in the state, so hostb's entry is the
    # only scope of the name, and only the roster tells the two bots apart.
    rig.clock.set(T0)
    rig.put(shared_machine_death("hostb", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hostb|dup-bot"]
    # A clear from the bot on hosta (one emitted by hand, for example), with the same machine string.
    rig.clock.set(T0 + HOUR)
    rig.put(shared_machine_death("hosta", T0 + HOUR, clear=True))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_a_clear_read_with_the_roster_lost_from_the_bot_with_no_condition_leaves_the_other_bot(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    rig.clock.set(T0)
    rig.put(shared_machine_death("hostb", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hostb|dup-bot"]
    # The roster cannot be read when the bot on hosta writes its first clear, so the clear keys by the machine
    # string, and hostb's entry is the only stored scope of the name. Its key names hostb, which is none of
    # the clear's own host strings.
    rig.roster_path.unlink()
    rig.clock.set(T0 + HOUR)
    rig.put(shared_machine_death("hosta", T0 + HOUR, clear=True))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def relayed_death(machine: str, host: str, at: float, *, clear: bool = False, bot: str = "dup-bot") -> dict[str, Any]:
    """`shared_machine_death` with the machine string `machine`: the Python emitter's event of `bot`, relayed from
    `host` by the collector."""
    event = shared_machine_death(host, at, clear=clear, bot=bot)
    event["machine"] = machine
    return event


def test_t95_a_clear_a_changed_roster_maps_to_another_host_leaves_the_entry_its_relay_host_names(make_rig):
    rig = make_rig(fleet=roster(("hostb", "dup-bot")))
    # The roster lists dup-bot on hostb only, so the death maps to hostb's key whatever its strings: its machine
    # string names hosta, its relay host hostb. The entry keeps the machine string.
    rig.clock.set(T0)
    rig.put(relayed_death("hosta.local", "hostb", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hostb|dup-bot"]
    assert rig.entry("hostb|dup-bot").get("machine") == "hosta.local"
    # The roster now lists the name on hosta too, and a clear with the same strings maps to hosta's key. hostb's
    # entry carries the clear's machine string, is the only stored scope of the name, and its key names the
    # clear's relay host: only the roster's two hosts keep the clear off an entry the roster now places on another host.
    rig.write_roster(ROSTER_DUP)
    rig.clock.set(T0 + HOUR)
    rig.put(relayed_death("hosta.local", "hostb", T0 + HOUR, clear=True))
    assert rig.cycle() is None
    assert rig.members("hostb|dup-bot") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_a_clear_its_relay_host_maps_to_one_bot_leaves_an_unmatched_entry_of_its_machine_string(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    # A death of dup-bot from a machine string no roster host has, with no relay block: it matches neither of the
    # name's two hosts, so it keys by its machine string. Either bot may have written it.
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "sharedbox", "dup-bot", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["sharedbox|dup-bot"]
    # A clear from the same machine string, relayed from hostb, maps to hostb's key. The unmatched entry carries the
    # clear's machine string, is the only stored scope of the name, and its key names one of the clear's strings:
    # only the roster's two hosts keep the clear off it.
    rig.clock.set(T0 + HOUR)
    rig.put(shared_machine_death("hostb", T0 + HOUR, clear=True))
    assert rig.cycle() is None
    assert rig.members("sharedbox|dup-bot") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_with_the_roster_unreadable_a_clear_reaches_the_entry_its_relay_host_names(make_rig):
    rig = make_rig()
    # The roster holds bot-one on hosta only, so the death maps to hosta's key whatever its machine string.
    rig.clock.set(T0)
    rig.put(shared_machine_death("hosta.example", T0, bot="bot-one"))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    # The roster cannot be read when the recovery arrives. The entry's key names no machine string of the
    # clear, but it names the first label of the clear's relay host.
    rig.roster_path.unlink()
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(shared_machine_death("hosta.example", cleared_at, clear=True, bot="bot-one"))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(cleared_at + GRACE) is None
    assert rig.open_scopes() == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0]
    assert rig.logged("passFault") == []


def test_t95_with_the_roster_unreadable_a_clear_reaches_an_entry_whose_host_label_the_segment_rule_rewrote(make_rig):
    # The roster's host label holds a character the scope key's segment rule replaces.
    rig = make_rig(fleet=roster(("hosta+lab", "bot-one")))
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta+lab.local", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta_lab|bot-one"]
    # The first label of the clear's machine string is the roster's label, written as the key writes it.
    rig.roster_path.unlink()
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(watchdog_event(DEAD, "hosta+lab.local", "bot-one", cleared_at, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta_lab|bot-one") == []
    assert rig.cycle_at(cleared_at + GRACE) is None
    assert rig.open_scopes() == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0]
    assert rig.logged("passFault") == []


def test_t95_with_the_roster_unreadable_only_the_first_clear_reaches_the_entry_its_opener_named(make_rig):
    rig = make_rig()
    # Two member sources of the bot on hosta, both written with the host string hosta.local, which the roster
    # maps to hosta's key. One cycle each, so the storm pass takes neither.
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", T0))
    assert rig.cycle() is None
    rig.clock.set(T0 + 60)
    rig.put(observer_event(MANUAL, "hosta.local", "bot-one", T0 + 60))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    rig.roster_path.unlink()
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", cleared_at, clear=True))
    assert rig.cycle() is None
    # The first clear reaches the entry, and also records itself under its own key.
    assert rig.cleared("hosta|bot-one") == [DEAD]
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.cleared("hosta.local|bot-one") == [DEAD]
    # That record is a second scope of the name, so the next clear of the bot reaches its own scope only.
    rig.clock.set(cleared_at + 60)
    rig.put(observer_event(MANUAL, "hosta.local", "bot-one", cleared_at + 60, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def scope_written_another_way_beside_the_entry(rig: Rig, bot: str, other: str) -> None:
    """`bot` dies on hosta.local, which the roster maps to hosta's key. The roster is then lost, and a bot of
    the name written `other`, on hostc.local, writes a clear by hand, so that it has a scope that keeps only
    `clearedAt`. Then the bot on hosta recovers."""
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta.local", bot, T0))
    assert rig.cycle() is None
    rig.roster_path.unlink()
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hostc.local", other, T0 + 60, clear=True))
    assert rig.cycle() is None
    rig.clock.set(T0 + HOUR)
    rig.put(watchdog_event(DEAD, "hosta.local", bot, T0 + HOUR, clear=True))
    assert rig.cycle() is None


def test_t95_with_the_roster_unreadable_a_scope_of_the_name_in_other_case_stops_the_fan_out(make_rig):
    rig = make_rig()
    scope_written_another_way_beside_the_entry(rig, "bot-one", "Bot-One")
    # The other scope may be another bot of the name, so the clear reaches its own scope only: the page runs on.
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t95_with_the_roster_unreadable_a_scope_of_the_name_with_a_rewritten_character_stops_the_fan_out(make_rig):
    # The name holds a character the scope key's segment rule replaces, so no key holds the name as written.
    rig = make_rig(fleet=roster(("hosta", "bot one")))
    scope_written_another_way_beside_the_entry(rig, "bot one", "bot one")
    assert rig.members("hosta|bot_one") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t87_two_openers_and_one_latent_sustain_under_three_host_strings(make_rig):
    rig = make_rig(fleet=UNREADABLE)
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", T0))
    rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta.local|bot-one", "hosta|bot-one"]
    assert rig.phase("hosta.example|bot-one") == "latent"
    assert sorted(rig.page_texts()) == [page_line("hosta.local/bot-one", 0, 1), page_line("hosta/bot-one", 0, 1)]

    # Both openers clear: the latent sustain holds both conditions.
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.put(watchdog_event(DEAD, "hosta.local", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == ["hosta.local|bot-one", "hosta|bot-one"]
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0, T0 + INTERVAL, T0 + INTERVAL]
    assert [PAGE_UNVERIFIED in text for text in rig.page_texts()[2:]] == [True, True]

    # The sustain clears: both end after the grace.
    ended_at = T0 + INTERVAL + HOUR
    rig.clock.set(ended_at)
    rig.put(runtime_event(PRIMARY, "bot-one", ended_at, relay_host="hosta.example", clear=True))
    rig.cycle()
    rig.cycle_at(ended_at + GRACE)
    assert rig.open_scopes() == []


def test_t84_each_bots_own_sustain_holds_its_own_condition_only(make_rig):
    # Roster unreadable, one name on two bots, both with an open condition.
    rig = make_rig(fleet=UNREADABLE)
    open_both_dup_bots(rig)
    rig.clock.set(T0 + 60)
    rig.put(observer_event(INDETERMINATE, "hosta", "dup-bot", T0 + 60))
    rig.put(observer_event(INDETERMINATE, "hostb", "dup-bot", T0 + 60))
    assert rig.cycle() is None
    assert rig.members("hosta|dup-bot") == sorted([INDETERMINATE, MANUAL])
    assert rig.members("hostb|dup-bot") == sorted([INDETERMINATE, MANUAL])
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]
    # One bot's opener and sustain clear. The other bot's sustain is a member of
    # its own open condition, so it does not hold this one.
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "dup-bot", cleared_at, clear=True))
    rig.put(observer_event(INDETERMINATE, "hosta", "dup-bot", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == ["hostb|dup-bot"]


def one_open_and_one_latent_dup_bot(rig: Rig) -> int:
    """`hosta`'s bot has an open condition; `hostb`'s bot has only a sustain. Then the opener clears."""
    rig.clock.set(T0 - 60)
    rig.put(observer_event(INDETERMINATE, "hostb", "dup-bot", T0 - 60))
    rig.cycle()
    open_now(rig, T0, bot="dup-bot")
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "dup-bot", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    return cleared_at


def test_t84_without_a_roster_a_latent_sustain_of_the_other_bot_holds_the_condition(make_rig):
    # The stated cost of the same-name rule: it fails toward a page.
    rig = make_rig(fleet=UNREADABLE)
    one_open_and_one_latent_dup_bot(rig)
    assert rig.phase("hostb|dup-bot") == "latent"
    assert rig.open_scopes() == ["hosta|dup-bot"]
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert PAGE_UNVERIFIED in rig.page_texts()[-1]
    # An opener from the other bot opens its own condition; it never joins by name.
    rig.clock.set(T0 + INTERVAL + 60)
    rig.put(observer_event(MANUAL, "hostb", "dup-bot", T0 + INTERVAL + 60))
    rig.cycle()
    assert rig.open_scopes() == ["hosta|dup-bot", "hostb|dup-bot"]
    assert rig.members("hosta|dup-bot") == []
    assert rig.page_texts()[-1] == page_line("hostb/dup-bot", 0, 1)


def test_t84_the_condition_ends_when_that_latent_sustain_clears(make_rig):
    rig = make_rig(fleet=UNREADABLE)
    one_open_and_one_latent_dup_bot(rig)
    assert rig.open_scopes() == ["hosta|dup-bot"]
    assert rig.page_times() == [T0]
    ended_at = T0 + 2 * HOUR
    rig.clock.set(ended_at)
    rig.put(observer_event(INDETERMINATE, "hostb", "dup-bot", ended_at, clear=True))
    assert rig.cycle() is None
    rig.cycle_at(ended_at + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0]
    # An opener from the other bot still opens its own condition and pages.
    rig.clock.set(T0 + INTERVAL + 60)
    rig.put(observer_event(MANUAL, "hostb", "dup-bot", T0 + INTERVAL + 60))
    rig.cycle()
    assert rig.open_scopes() == ["hostb|dup-bot"]
    assert rig.page_texts() == [page_line("hosta/dup-bot", 0, 1), page_line("hostb/dup-bot", 0, 1)]


def test_t77_a_bot_the_roster_does_not_hold_is_held_by_name(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    rig.clock.set(T0 - 60)
    rig.put(runtime_event(PRIMARY, "bot-nine", T0 - 60, relay_host="hostq.example"))
    rig.cycle()
    open_now(rig, T0, host="hostq", bot="bot-nine")
    assert rig.open_scopes() == ["hostq|bot-nine"]
    assert rig.phase("hostq.example|bot-nine") == "latent"
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hostq", "bot-nine", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == ["hostq|bot-nine"]
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert PAGE_UNVERIFIED in rig.page_texts()[-1]


def test_t85_an_unreadable_roster_is_logged_each_cycle_and_alerted_once_a_day(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    for offset in (0, 60, 120):
        assert rig.cycle_at(clock_at(10) + offset) is None
    assert rig.logged("rosterUnreadable") == [True, True, True]
    assert [send["at"] for send in rig.meta_alerts(META_ROSTER_UNREADABLE)] == [clock_at(10)]
    rig.cycle_at(clock_at(10, day=1))
    assert [send["at"] for send in rig.meta_alerts(META_ROSTER_UNREADABLE)] == [clock_at(10), clock_at(10, day=1)]


def test_t85_pin_a_readable_roster_raises_no_roster_alert(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    rig.clock.set(T0)
    alert = rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert len(rig.group_for(alert)) == 1
    assert rig.meta_alerts(META_ROSTER_UNREADABLE) == []
    assert rig.logged("rosterUnreadable") == []


def test_t85_pin_the_poison_quarantine_alert_is_unchanged(make_rig):
    rig = make_rig(fleet=ROSTER_ONE)
    rig.clock.set(T0)
    poison = rig.paths["outbox"] / "20261001T030000Z.unreadable-fixture.json"
    poison.write_text("{ this is not JSON", encoding="utf-8")
    poison.chmod(0o600)
    assert rig.cycle() is None
    alerts = rig.meta_alerts("poison-event-quarantine")
    assert len(alerts) == 1
    assert "BOT ERRORS dispatcher quarantined an unreadable event" in alerts[0]["text"]
    assert rig.disposition("unreadable-fixture") == ["quarantine"]


# The class sends its group meta-alerts itself, after the stamp, the class pages and the legacy
# drain, inside a budget of its own. They are not queued: a queued meta-alert is an incident alert,
# and the incident renotify policy would absorb a repeat that the class's cadence promises. These
# cases hold the order and the budget, so that the two paths are not merged by accident. The group
# send of one alert gets at most META_GROUP of the budget, the owner route's default WhatsApp cap,
# so its e-mail keeps the rest, as a class page's does (8 s, then 12 s).
META_BUDGET = 20
META_GROUP = 8


def meta_down(rig: Rig, source: str, verdict: str) -> None:
    """Both channels of the class's meta-alert `source` refuse it ("fail") or time out ("timeout")."""
    rig.group_rule = lambda text: verdict if f"source: {source}" in text else "ok"
    rig.email_rule = lambda subject, body: verdict if source in subject else "ok"


def test_t96_with_the_group_line_slow_the_stamp_and_the_drain_come_before_the_class_meta_alert(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    meta_down(rig, META_ROSTER_UNREADABLE, "timeout")
    # A routed source of another class: its owner copy goes out in the legacy drain.
    rig.put(plain_event(OTHER_CRITICAL, "hostb", "bot-two", clock_at(10) - 1))
    assert rig.cycle() is None
    # The stamp carries the cycle's own time: no meta-alert send ran before it.
    assert rig.stamp_times == [clock_at(10)]
    attempts = rig.meta_attempts(META_ROSTER_UNREADABLE)
    assert len(attempts) == 1
    stamp = rig.timeline.index(("stamp", ""))
    drained = [index for index, (kind, text) in enumerate(rig.timeline)
               if kind == "owner" and text.startswith(f"hostb/bot-two: {OTHER_TITLE}")]
    assert len(drained) == 1
    assert stamp < drained[0] < attempts[0]["position"]
    # Its own budget: the stuck group send was given 8 s and took them, and the e-mail had the 12 s left.
    assert [attempt["deadline"] - attempt["monotonic"] for attempt in attempts] == [META_GROUP]
    assert [mail["timeout"] for mail in rig.emails if META_ROSTER_UNREADABLE in mail["subject"]] == [
        META_BUDGET - META_GROUP]


def test_t96_a_refused_class_meta_alert_is_tried_once_in_each_cycle_and_only_after_the_stamp(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    meta_down(rig, META_ROSTER_UNREADABLE, "fail")
    for offset in (0, 60, 120):
        before = len(rig.meta_attempts(META_ROSTER_UNREADABLE))
        assert rig.cycle_at(clock_at(10) + offset) is None
        made = rig.meta_attempts(META_ROSTER_UNREADABLE)[before:]
        stamp = max(index for index, entry in enumerate(rig.timeline) if entry == ("stamp", ""))
        assert [attempt["position"] > stamp for attempt in made] == [True]
    assert rig.meta_alerts(META_ROSTER_UNREADABLE) == []


def test_t96_a_class_meta_alert_refused_while_the_line_was_down_goes_out_once_when_it_returns(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    meta_down(rig, META_ROSTER_UNREADABLE, "fail")
    for offset in (0, 60):
        assert rig.cycle_at(clock_at(10) + offset) is None
    assert rig.meta_alerts(META_ROSTER_UNREADABLE) == []
    meta_down(rig, META_ROSTER_UNREADABLE, "ok")
    for offset in (120, 180, 240):
        assert rig.cycle_at(clock_at(10) + offset) is None
    assert [send["at"] for send in rig.meta_alerts(META_ROSTER_UNREADABLE)] == [clock_at(10) + 120]


def test_t96_a_restart_between_the_send_and_its_mark_sends_the_class_meta_alert_at_most_once_more(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    assert rig.cycle() is None
    rig.restart()
    for offset in (60, 120, 180):
        assert rig.cycle_at(clock_at(10) + offset) is None
    times = [send["at"] for send in rig.meta_alerts(META_ROSTER_UNREADABLE)]
    assert times[:1] == [clock_at(10)]
    # A taken alert is marked by the next timer pass, from memory: only the first cycle after a restart
    # can send it once more.
    assert [at for at in times[1:] if at != clock_at(10) + 60] == []
    assert len(times) <= 2


def test_t96_an_owed_page_keeps_its_whole_budget_and_the_class_meta_alert_has_its_own(make_rig):
    rig = make_rig(fleet=UNREADABLE)
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    rig.owner_rule = lambda text: "timeout" if is_class_page(text) else "ok"
    rig.email_rule = lambda subject, body: (
        "timeout" if is_class_page(subject) or META_ROSTER_UNREADABLE in subject else "ok")
    rig.group_rule = lambda text: "timeout" if f"source: {META_ROSTER_UNREADABLE}" in text else "ok"
    assert rig.cycle() is None
    # The page's attempt is the one the class's 20 s give it: 8 s, then the 12 s left for its e-mail.
    assert [send["timeout"] for send in rig.owner if is_class_page(send["text"])] == [8]
    assert [mail["timeout"] for mail in rig.page_emails()] == [12]
    attempts = rig.meta_attempts(META_ROSTER_UNREADABLE)
    assert len(attempts) == 1
    page_sends = [index for index, (kind, text) in enumerate(rig.timeline)
                  if kind in ("owner", "email") and is_class_page(text)]
    assert len(page_sends) == 2
    assert page_sends[-1] < attempts[0]["position"]
    assert [attempt["deadline"] - attempt["monotonic"] for attempt in attempts] == [META_GROUP]


# An owed class meta-alert is kept until a channel takes it or its window ends, through a budget cut,
# a refusal and a restart; a lost group reply counts as taken; a daily alert counts for the UTC day
# it went out.
CLASS_META_SOURCES = (META_STATE_LOST, META_ROSTER_UNREADABLE, META_PASS_ERROR)


def alert_days(rig: Rig) -> dict[str, Any]:
    held = rig.state().get(ALERT_DAYS)
    return held if isinstance(held, dict) else {}


def meta_emails(rig: Rig, source: str) -> list[dict[str, Any]]:
    return [mail for mail in rig.emails if source in mail["subject"]]


def test_t97_a_pass_error_alert_the_budget_cut_is_sent_in_a_later_cycle_without_a_new_fault(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    # A send step of the cycle before absorbed an error, so this cycle owes the pass-error alert.
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    # The roster alert is listed first and spends the whole budget: the pass-error alert is cut.
    meta_down(rig, META_ROSTER_UNREADABLE, "timeout")
    assert rig.cycle() is None
    assert rig.meta_attempts(META_PASS_ERROR) == []
    meta_down(rig, META_ROSTER_UNREADABLE, "ok")
    assert rig.cycle_at(clock_at(10) + 60) is None
    assert [send["at"] for send in rig.meta_alerts(META_PASS_ERROR)] == [clock_at(10) + 60]


def test_t97_a_pass_error_alert_both_channels_refused_is_sent_when_they_return(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    meta_down(rig, META_PASS_ERROR, "fail")
    assert rig.cycle() is None
    assert len(rig.meta_attempts(META_PASS_ERROR)) == 1
    meta_down(rig, META_PASS_ERROR, "ok")
    assert rig.cycle_at(clock_at(10) + 60) is None
    assert [send["at"] for send in rig.meta_alerts(META_PASS_ERROR)] == [clock_at(10) + 60]


def test_t97_an_owed_pass_error_alert_is_kept_across_a_restart(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    meta_down(rig, META_PASS_ERROR, "fail")
    assert rig.cycle() is None
    # A new process: the fault it was owed for is gone with the old one, the owed alert is not.
    rig.restart()
    meta_down(rig, META_PASS_ERROR, "ok")
    assert rig.cycle_at(clock_at(10) + 60) is None
    assert [send["at"] for send in rig.meta_alerts(META_PASS_ERROR)] == [clock_at(10) + 60]


def test_t97_a_refused_roster_alert_goes_out_after_the_roster_reads_again_and_says_when_it_could_not(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    meta_down(rig, META_ROSTER_UNREADABLE, "fail")
    assert rig.cycle() is None
    rig.write_roster(ROSTER_ONE)
    meta_down(rig, META_ROSTER_UNREADABLE, "ok")
    assert rig.cycle_at(clock_at(10) + 60) is None
    alerts = rig.meta_alerts(META_ROSTER_UNREADABLE)
    assert [send["at"] for send in alerts] == [clock_at(10) + 60]
    # Delivered once the roster reads, it names a past condition and the time it was seen.
    assert f"the fleet roster could not be read at {iso(clock_at(10))};" in alerts[0]["text"]


def test_t97_pin_an_owed_pass_error_alert_ends_with_its_utc_day(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(23, 59, 0))
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    meta_down(rig, META_PASS_ERROR, "fail")
    assert rig.cycle() is None
    assert len(rig.meta_attempts(META_PASS_ERROR)) == 1
    meta_down(rig, META_PASS_ERROR, "ok")
    assert rig.cycle_at(clock_at(0, 0, 30, day=1)) is None
    assert rig.meta_alerts(META_PASS_ERROR) == []


def test_t97_a_stuck_group_line_leaves_the_class_meta_alert_its_email(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    rig.group_rule = lambda text: "timeout" if f"source: {META_ROSTER_UNREADABLE}" in text else "ok"
    assert rig.cycle() is None
    # The group send stops at its cap, and the e-mail takes the alert in the time left.
    assert [mail["timeout"] for mail in meta_emails(rig, META_ROSTER_UNREADABLE)] == [META_BUDGET - META_GROUP]
    assert rig.cycle_at(clock_at(10) + 60) is None
    assert len(rig.meta_attempts(META_ROSTER_UNREADABLE)) == 1


def test_t97_a_class_meta_alert_whose_group_reply_is_lost_is_taken_once(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    rig.group_rule = lambda text: "ambiguous" if f"source: {META_ROSTER_UNREADABLE}" in text else "ok"
    rig.email_rule = lambda subject, body: "fail" if META_ROSTER_UNREADABLE in subject else "ok"
    for offset in (0, 60, 120):
        assert rig.cycle_at(clock_at(10) + offset) is None
    # The request reached the group (#2424): taken whatever its e-mail did, and never sent again.
    assert len(rig.meta_attempts(META_ROSTER_UNREADABLE)) == 1
    mails = meta_emails(rig, META_ROSTER_UNREADABLE)
    assert len(mails) == 1
    assert f"the fleet roster could not be read at {iso(clock_at(10))};" in mails[0]["body"]
    # Logged with its kind, past the shared log projection.
    assert rig.logged("ambiguous") == [True]
    assert rig.logged("metaRosterUnreadable") == [True]


def test_t97_pin_a_class_meta_alert_whose_handshake_failed_is_tried_again(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    rig.group_rule = lambda text: (
        "ambiguous-handshake" if f"source: {META_ROSTER_UNREADABLE}" in text else "ok")
    rig.email_rule = lambda subject, body: "fail" if META_ROSTER_UNREADABLE in subject else "ok"
    for offset in (0, 60):
        assert rig.cycle_at(clock_at(10) + offset) is None
    # The request never left, so nothing was taken: the next cycle tries both channels again.
    assert len(rig.meta_attempts(META_ROSTER_UNREADABLE)) == 2
    assert len(meta_emails(rig, META_ROSTER_UNREADABLE)) == 2


def test_t97_a_class_meta_alert_delivered_after_midnight_counts_for_the_new_day(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(23, 59, 55))
    # A routed source of another class whose owner copy times out in the legacy drain: its 8 s carry
    # the roster alert, listed before midnight, past it.
    rig.put(plain_event(OTHER_CRITICAL, "hostb", "bot-two", clock_at(23, 59, 55) - 1))
    rig.owner_rule = lambda text: "timeout" if text.startswith(f"hostb/bot-two: {OTHER_TITLE}") else "ok"
    assert rig.cycle() is None
    assert rig.cycle_at(clock_at(0, 1, 30, day=1)) is None
    sent = [send["at"] for send in rig.meta_alerts(META_ROSTER_UNREADABLE)]
    # The case's own premise: the first send landed after midnight.
    assert sent and sent[0] >= clock_at(0, day=1)
    assert len([at for at in sent if at >= clock_at(0, day=1)]) == 1


def test_t97_pin_the_owed_class_meta_alerts_share_one_budget(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    rig.group_rule = lambda text: "timeout" if "source: credential-repage-" in text else "ok"
    rig.email_rule = lambda subject, body: "timeout" if "credential-repage-" in subject else "ok"
    assert rig.cycle() is None
    assert len(rig.meta_attempts(META_ROSTER_UNREADABLE)) == 1
    assert rig.meta_attempts(META_PASS_ERROR) == []


def test_t97_pin_a_taken_class_meta_alert_is_marked_by_the_next_pass(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    assert rig.cycle() is None
    assert len(rig.meta_alerts(META_ROSTER_UNREADABLE)) == 1
    # Sent after the stamp, the alert is written to the state only by the next timer pass.
    assert alert_days(rig).get(META_ROSTER_UNREADABLE) is None
    assert rig.cycle_at(clock_at(10) + 60) is None
    assert alert_days(rig).get(META_ROSTER_UNREADABLE) == iso(clock_at(10))[:10]


def test_t97_pin_a_class_meta_alert_the_email_took_is_not_sent_again(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    rig.group_rule = lambda text: "fail" if f"source: {META_ROSTER_UNREADABLE}" in text else "ok"
    for offset in (0, 60):
        assert rig.cycle_at(clock_at(10) + offset) is None
    assert len(meta_emails(rig, META_ROSTER_UNREADABLE)) == 1
    assert len(rig.meta_attempts(META_ROSTER_UNREADABLE)) == 1


def test_t97_pin_a_new_loss_after_a_late_state_lost_alert_is_alerted_too(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.cycle_at(T0 + 60)
    meta_down(rig, META_STATE_LOST, "fail")
    rig.edit_state(lambda payload: payload.update({SECTION: [LOST]}))
    lost_at = T0 + 120
    assert rig.cycle_at(lost_at) is None
    assert rig.meta_alerts(META_STATE_LOST) == []
    # Hours later the group line is back, and the first announcement's alert goes out ...
    meta_down(rig, META_STATE_LOST, "ok")
    assert rig.cycle_at(lost_at + INTERVAL + 60) is None
    assert len(rig.meta_alerts(META_STATE_LOST)) == 1
    # ... and a loss in the very next cycle starts a new announcement before that alert is marked.
    rig.edit_state(lambda payload: payload.update({SECTION: [LOST]}))
    assert rig.cycle_at(lost_at + INTERVAL + 120) is None
    alerts = rig.meta_alerts(META_STATE_LOST)
    assert len(alerts) == 2
    # Each names its own announcement, not the first one again.
    assert alerts[0]["text"] != alerts[1]["text"]


def test_t97_pin_every_owed_kind_of_class_meta_alert_is_sent_in_one_cycle_in_order(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    rig.group_rule = lambda text: "fail" if "source: credential-repage-" in text else "ok"
    rig.email_rule = lambda subject, body: "fail" if "credential-repage-" in subject else "ok"
    assert rig.cycle() is None
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    rig.edit_state(lambda payload: payload.update({SECTION: [LOST]}))
    rig.group_rule = lambda text: "ok"
    rig.email_rule = lambda subject, body: "ok"
    assert rig.cycle_at(clock_at(10) + 60) is None
    sent = [source for send in rig.group for source in CLASS_META_SOURCES if f"source: {source}" in send["text"]]
    assert sent == [META_STATE_LOST, META_ROSTER_UNREADABLE, META_PASS_ERROR]


# A malformed owed alert (only a manual edit makes one) is dropped; one alert whose line cannot be made
# holds back no other, and is reported as a fault of the pass; a take counts for the UTC day a channel
# first took it; each lost group reply is logged with the kind of its alert.
DAY_ONE = iso(clock_at(10))[:10]


def owed(rig: Rig) -> dict[str, Any]:
    held = rig.state().get(ALERTS_OWED)
    return held if isinstance(held, dict) else {}


def owe_by_hand(rig: Rig, owed_map: Any) -> None:
    """Write the owed map between two cycles, as a manual edit of the state would."""
    rig.edit_state(lambda payload: payload.update({ALERTS_OWED: owed_map}))


def line_fails_for(rig: Rig, source: str) -> None:
    """The dispatcher cannot make the line of the meta-alert `source`; every other line is made as before."""
    real = rig.d._credential_meta_line

    def line(name: str, at: int) -> str:
        if name == source:
            raise RuntimeError("the line cannot be made")
        return real(name, at)

    rig.monkeypatch.setattr(rig.d, "_credential_meta_line", line)


def test_t98_an_owed_time_out_of_range_is_dropped_and_the_other_alert_still_goes_out(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    assert rig.cycle() is None
    # A time no clock gives, listed first, beside a sound owed alert.
    owe_by_hand(rig, {META_ROSTER_UNREADABLE: {"day": DAY_ONE, "at": 10**100},
                      META_PASS_ERROR: {"day": DAY_ONE, "at": clock_at(10)}})
    assert rig.cycle_at(clock_at(10) + 60) is None
    assert [send["at"] for send in rig.meta_alerts(META_PASS_ERROR)] == [clock_at(10) + 60]
    assert rig.meta_alerts(META_ROSTER_UNREADABLE) == []
    # The malformed one is gone from the state; the sound one waits for its mark in the next pass.
    assert sorted(owed(rig)) == [META_PASS_ERROR]


def test_t98_one_alert_whose_line_cannot_be_made_does_not_hold_back_the_others(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    # The roster alert is listed first, and its line fails.
    line_fails_for(rig, META_ROSTER_UNREADABLE)
    assert rig.cycle() is None
    assert [send["at"] for send in rig.meta_alerts(META_PASS_ERROR)] == [clock_at(10)]


def test_t98_a_fault_while_the_owed_alerts_are_listed_is_owed_as_a_pass_error(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    # The only fault is in the last step of the timer pass, after the step that reports faults.
    line_fails_for(rig, META_ROSTER_UNREADABLE)
    for offset in (0, 60):
        assert rig.cycle_at(clock_at(10) + offset) is None
    assert [send["at"] for send in rig.meta_alerts(META_PASS_ERROR)] == [clock_at(10) + 60]


def test_t98_a_group_take_before_midnight_keeps_its_day_when_the_email_ends_after_it(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(23, 59, 58))
    # The group's answer is lost at 23:59:58, so the group took it (#2424); its e-mail then runs its
    # 20 s past midnight.
    rig.group_rule = lambda text: "ambiguous" if f"source: {META_ROSTER_UNREADABLE}" in text else "ok"
    rig.email_rule = lambda subject, body: "timeout" if META_ROSTER_UNREADABLE in subject else "ok"
    assert rig.cycle() is None
    assert rig.cycle_at(clock_at(0, 0, 30, day=1)) is None
    # Marked for the day the group took it, so the new day's alert is still owed, and goes out.
    assert alert_days(rig).get(META_ROSTER_UNREADABLE) == DAY_ONE
    assert [attempt["at"] for attempt in rig.meta_attempts(META_ROSTER_UNREADABLE)] == [
        clock_at(23, 59, 58), clock_at(0, 0, 30, day=1)]


def test_t98_an_owed_map_stored_as_null_is_removed(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    assert rig.cycle() is None
    owe_by_hand(rig, None)
    assert rig.cycle_at(clock_at(10) + 60) is None
    held = ALERTS_OWED in rig.state()
    assert held is False


def test_t98_an_owed_entry_that_names_no_daily_alert_is_dropped(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    assert rig.cycle() is None
    owe_by_hand(rig, {"credential-repage-unknown": {"day": DAY_ONE, "at": clock_at(10)}})
    assert rig.cycle_at(clock_at(10) + 60) is None
    held = ALERTS_OWED in rig.state()
    assert held is False


def test_t98_pin_an_owed_time_within_a_day_of_its_own_day_is_kept(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    assert rig.cycle() is None
    # Owed for this UTC day at a time just before it: the clock stepped between the two readings.
    owe_by_hand(rig, {META_ROSTER_UNREADABLE: {"day": DAY_ONE, "at": clock_at(23, 59, 0, day=-1)}})
    assert rig.cycle_at(clock_at(10) + 60) is None
    assert [f"could not be read at {iso(clock_at(23, 59, 0, day=-1))};" in send["text"]
            for send in rig.meta_alerts(META_ROSTER_UNREADABLE)] == [True]


def test_t98_pin_an_owed_map_left_empty_is_removed(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    assert rig.cycle() is None
    yesterday = clock_at(10, day=-1)
    owe_by_hand(rig, {META_ROSTER_UNREADABLE: {"day": iso(yesterday)[:10], "at": yesterday}})
    assert rig.cycle_at(clock_at(10) + 60) is None
    held = ALERTS_OWED in rig.state()
    assert held is False


def test_t98_pin_an_owed_roster_alert_keeps_the_time_it_was_first_owed(make_rig):
    rig = make_rig(fleet=UNREADABLE, start=clock_at(10))
    meta_down(rig, META_ROSTER_UNREADABLE, "fail")
    for offset in (0, 60):
        assert rig.cycle_at(clock_at(10) + offset) is None
    rig.write_roster(ROSTER_ONE)
    meta_down(rig, META_ROSTER_UNREADABLE, "ok")
    assert rig.cycle_at(clock_at(10) + 120) is None
    # Owed again in the second cycle, it keeps the time of the first.
    assert [f"could not be read at {iso(clock_at(10))};" in send["text"]
            for send in rig.meta_alerts(META_ROSTER_UNREADABLE)] == [True]


def test_t98_pin_a_lost_group_reply_of_a_pass_error_alert_is_logged_with_its_kind(make_rig):
    rig = make_rig(fleet=ROSTER_ONE, start=clock_at(10))
    rig.monkeypatch.setattr(rig.d, "_credential_send_fault", True)
    rig.group_rule = lambda text: "ambiguous" if f"source: {META_PASS_ERROR}" in text else "ok"
    rig.email_rule = lambda subject, body: "fail" if META_PASS_ERROR in subject else "ok"
    assert rig.cycle() is None
    assert len(rig.meta_attempts(META_PASS_ERROR)) == 1
    assert (rig.logged("ambiguous"), rig.logged("metaPassFault")) == ([True], [True])


def test_t98_pin_a_lost_group_reply_of_a_state_lost_alert_is_logged_with_its_kind(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.cycle_at(T0 + 60)
    rig.group_rule = lambda text: "ambiguous" if f"source: {META_STATE_LOST}" in text else "ok"
    rig.email_rule = lambda subject, body: "fail" if META_STATE_LOST in subject else "ok"
    rig.edit_state(lambda payload: payload.update({SECTION: [LOST]}))
    assert rig.cycle_at(T0 + 120) is None
    assert len(rig.meta_attempts(META_STATE_LOST)) == 1
    assert (rig.logged("ambiguous"), rig.logged("metaStateLost")) == ([True], [True])


def test_t99_the_class_messages_use_the_public_wording(make_rig):
    # The group alert asks the owner by role; the keep-alive page names the re-auth observer by its public
    # source prefix (`reauth-observe:`).
    rig = make_rig(fleet=ROSTER_ONE)
    replay_until_the_probe(rig, relay_host="hosta.example", probe_host="hosta")
    assert rig.cycle_at(T_OPEN) is None
    observer_moves_to(rig, INDETERMINATE, T_UNVERIFIED)
    for step in (1, 2, 3):
        rig.cycle_at(T_OPEN + step * INTERVAL)
    action = ("requested_action: Human action required: restore this bot's provider credential (owner). "
              "No automated remediation.")
    observer = "; the re-auth observer now reports indeterminate_investigate — human action required;"
    assert (any(action in text for text in rig.group_texts()),
            any(observer in text for text in rig.page_texts())) == (True, True)


# ---------------------------------------------------------------------------
# The observer: every member event that reaches the outbox counts.
# ---------------------------------------------------------------------------


def not_ready(event: dict[str, Any], until: float) -> dict[str, Any]:
    """The event as it sits in the outbox after a failed send: waiting for its next attempt."""
    event["delivery"] = {"attempts": 1, "status": "queued", "nextAttemptAtEpoch": int(until), "lastError": "timed out"}
    return event


def member(rig: Rig, scope: str, source: str) -> dict[str, Any]:
    held = rig.entry(scope).get("members")
    found = held.get(source) if isinstance(held, dict) else None
    return found if isinstance(found, dict) else {}


def seen(rig: Rig, scope: str, source: str) -> tuple[Any, Any]:
    found = member(rig, scope, source)
    return found.get("firstSeenAt"), found.get("lastSeenAt")


def test_t37_openers_collapsed_by_the_storm_pass_still_open_their_conditions(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0 + 30)
    ids = [rig.put(watchdog_event(DEAD, host, bot, T0 + 10 * index))
           for index, (host, bot) in enumerate(THREE_BOTS)]
    assert rig.cycle() is None
    # The storm pass took all three before the send loop saw them.
    assert [rig.disposition(event_id) for event_id in ids] == [["storm_collapsed"]] * 3
    assert len(rig.group_texts("storm collapse: 3 hosts")) == 1
    assert rig.open_scopes() == THREE_SCOPES
    assert sorted(rig.page_texts()) == sorted(page_line(f"{host}/{bot}", 0, 1) for host, bot in THREE_BOTS)


def test_t38_an_event_read_in_three_cycles_is_one_member_and_one_page(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    # An alert that waits for its next send attempt stays in the outbox, and every cycle reads it.
    alert = rig.put(not_ready(observer_event(MANUAL, "hosta", "bot-one", T0), T0 + DAY))
    for offset in (0, 30, 60):
        assert rig.cycle_at(T0 + offset) is None
        assert rig.disposition(alert) == ["outbox"]
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert seen(rig, "hosta|bot-one", MANUAL) == (micros(T0), micros(T0))
    assert rig.page_times() == [T0]
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]


def test_t38_a_clear_read_again_after_a_newer_alert_does_not_remove_the_member(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.members("hosta|bot-one") == [MANUAL]
    # A clear that waits for its next send attempt stays in the outbox, and every cycle reads it.
    rig.clock.set(T0 + 100)
    clear = rig.put(not_ready(observer_event(MANUAL, "hosta", "bot-one", T0 + 100, clear=True), T0 + DAY))
    rig.cycle()
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hosta|bot-one") == []
    rig.clock.set(T0 + 200)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 200))
    assert rig.cycle() is None
    assert rig.cycle_at(T0 + 230) is None
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert seen(rig, "hosta|bot-one", MANUAL)[1] == micros(T0 + 200)


def recovered_before_delivery(rig: Rig, alert_at: int, clear_at: int, now: int) -> tuple[str, str]:
    """Scope `hosta|bot-one`: an undelivered alert and its later clear in one cycle, beside a
    fresh opener of a second scope. Returns the two event ids of the first scope."""
    rig.clock.set(now)
    alert = rig.put(not_ready(observer_event(MANUAL, "hosta", "bot-one", alert_at), now + HOUR))
    clear = rig.put(observer_event(MANUAL, "hosta", "bot-one", clear_at, clear=True))
    rig.put(observer_event(MANUAL, "hostc", "bot-three", now))
    rig.cycle()
    return alert, clear


def test_t39_an_alert_retired_with_its_clear_is_not_paged_and_ends_after_the_grace(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    # Control: the same alert alone, with no clear, opens a condition and pages.
    open_now(rig, T0, host="hostb", bot="bot-two")
    assert rig.open_scopes() == ["hostb|bot-two"]
    assert rig.page_texts() == [page_line("hostb/bot-two", 0, 1)]

    alert, clear = recovered_before_delivery(rig, alert_at=T0 + 10, clear_at=T0 + 40, now=T0 + 60)
    assert (rig.disposition(alert), rig.disposition(clear)) == (["suppressed"], ["suppressed"])
    # No page for it; the entry stands in its grace.
    assert rig.entry("hosta|bot-one").get("emptySince") == micros(T0 + 40)
    assert rig.page_texts("hosta/bot-one") == []
    # The second scope of that cycle opened and paged.
    assert rig.page_texts("hostc/bot-three") == [page_line("hostc/bot-three", 0, 1)]
    rig.cycle_at(T0 + 40 + GRACE)
    assert rig.phase("hosta|bot-one") == "absent"
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_texts("hosta/bot-one") == []


def test_t39_with_a_clear_older_than_the_grace_no_condition_remains(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    open_now(rig, T0, host="hostb", bot="bot-two")
    assert rig.open_scopes() == ["hostb|bot-two"]
    assert rig.page_texts() == [page_line("hostb/bot-two", 0, 1)]

    now = T0 + 2 * HOUR
    alert, clear = recovered_before_delivery(rig, alert_at=now - 1000, clear_at=now - 700, now=now)
    assert (rig.disposition(alert), rig.disposition(clear)) == (["suppressed"], ["suppressed"])
    assert rig.open_scopes() == ["hostb|bot-two", "hostc|bot-three"]
    assert rig.phase("hosta|bot-one") == "absent"
    assert rig.page_texts("hosta/bot-one") == []
    assert rig.page_texts("hostc/bot-three") == [page_line("hostc/bot-three", 0, 1)]


def leak_event(at: float) -> dict[str, Any]:
    """A member-source event that names a fixture path: the dispatcher drops it as a test leak."""
    event = observer_event(MANUAL, "hostb", "bot-two", at)
    event["evidence"] = {"diagnosis": "reauth_needed_manual", "authDir": "/tmp/wa-test-auth/creds.json"}
    return event


def provenance_event(at: float) -> dict[str, Any]:
    """A member-source event whose producer marked it as written under a test runner."""
    event = watchdog_event(DEAD, "hostc", "bot-three", at)
    event["runtime"]["provenance"]["test"] = True
    event["runtime"]["provenance"]["strongSignals"] = ["PYTEST_CURRENT_TEST"]
    return event


def test_t40_fixture_events_met_by_the_scan_open_nothing(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0)
    leak = rig.put(leak_event(T0), dropped_on_purpose=True)
    provenance = rig.put(provenance_event(T0), dropped_on_purpose=True)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert (rig.disposition(leak), rig.disposition(provenance)) == (["testleak"], ["suppressed"])
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert sorted(rig.conditions()) == ["hosta|bot-one"]


def test_t40_fixture_events_met_by_an_exit_point_open_nothing(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0)
    late: dict[str, str] = {}

    def arrive_after_the_scan() -> None:
        late["leak"] = rig.put(leak_event(T0), dropped_on_purpose=True)
        late["provenance"] = rig.put(provenance_event(T0), dropped_on_purpose=True)
        late["normal"] = rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))

    rig.before_pass("suppress_ready_recovery_duplicates", arrive_after_the_scan)
    assert rig.cycle() is None
    assert rig.disposition(late.get("leak", "?")) == ["testleak"]
    # The test-provenance pass had already run, so this one went through the send loop.
    assert rig.disposition(late.get("provenance", "?")) == ["sent"]
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert sorted(rig.conditions()) == ["hosta|bot-one"]


def test_t56a_three_openers_among_two_thousand_files_are_all_seen_in_one_cycle(make_rig):
    # Three bots on one host: alerts of one source from three hosts would be a storm, which is T37.
    bots = ["bot-1", "bot-2", "bot-3"]
    rig = make_rig(fleet=roster(*[("hosta", bot) for bot in bots]))
    rig.clock.set(T0)
    for index in range(1997):
        rig.put(plain_event("routine_note", "hostb", f"filler-{index:04d}", T0 - 100, severity="warning"))
    ids = [rig.put(observer_event(MANUAL, "hosta", bot, T0)) for bot in bots]
    assert len(rig.outbox_names()) == 2000
    assert rig.cycle() is None
    # The send loop stops at its limit long before it reaches them.
    assert [rig.disposition(event_id) for event_id in ids] == [["outbox"]] * 3
    assert rig.open_scopes() == [f"hosta|{bot}" for bot in bots]
    assert sorted(rig.page_texts()) == [page_line(f"hosta/{bot}", 0, 1) for bot in bots]


def test_t57_a_member_event_with_no_instance_name_is_counted_and_skipped(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0)
    # Two sources for the three alerts: one source from three hosts would be collapsed as a storm.
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0))
    nameless_event = observer_event(MANUAL, "hostb", "bot-two", T0)
    del nameless_event["instance"]
    nameless = rig.put(nameless_event)
    rig.put(observer_event(MANUAL, "hostc", "bot-three", T0))
    assert rig.cycle() is None
    assert ("stamp", "") in rig.timeline
    assert len(rig.group_for(nameless)) == 1  # its own group alert, as today
    assert rig.open_scopes() == ["hosta|bot-one", "hostc|bot-three"]
    assert sorted(rig.conditions()) == ["hosta|bot-one", "hostc|bot-three"]
    assert rig.logged("unusableEvents") == [1]


def test_t57_an_unreadable_file_met_by_the_scan_is_counted_and_left_in_place(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    rig.put(observer_event(MANUAL, "hostc", "bot-three", T0))
    unreadable = rig.paths["outbox"] / "20261001T030000Z.00000.unreadable-fixture.json"

    def arrive_before_the_scan() -> None:
        unreadable.write_text("{ this is not JSON", encoding="utf-8")
        unreadable.chmod(0o600)

    rig.after_pass("suppress_test_provenance_events", arrive_before_the_scan)
    rig.before_pass("suppress_ready_recovery_duplicates",
                    lambda: rig.notes.update(still_queued=unreadable.exists()))
    assert rig.cycle() is None
    assert rig.notes.get("still_queued") is True
    assert rig.open_scopes() == ["hosta|bot-one", "hostc|bot-three"]
    assert rig.logged("unusableEvents") == [1]


def test_t64_an_opener_that_arrives_after_the_scan_and_is_collapsed_is_recorded(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0 + 30)
    ids: list[str] = []
    rig.before_pass("suppress_ready_recovery_duplicates", lambda: ids.extend(
        rig.put(watchdog_event(DEAD, host, bot, T0 + 10 * index)) for index, (host, bot) in enumerate(THREE_BOTS)))
    assert rig.cycle() is None
    assert [rig.disposition(event_id) for event_id in ids] == [["storm_collapsed"]] * 3
    assert rig.open_scopes() == THREE_SCOPES


def test_t64_a_duplicate_that_arrives_after_the_scan_and_is_retired_is_recorded(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert seen(rig, "hosta|bot-one", MANUAL) == (micros(T0), micros(T0))
    rig.clock.set(T0 + 300)
    late: dict[str, str] = {}

    def arrive_after_the_scan() -> None:
        late["duplicate"] = rig.put(not_ready(observer_event(MANUAL, "hosta", "bot-one", T0 + 100), T0 + HOUR))
        late["clear"] = rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 200, clear=True))

    rig.before_pass("suppress_ready_recovery_duplicates", arrive_after_the_scan)
    # Read from disk at the entry of the next existing pass, directly after the duplicate was retired.
    rig.before_pass("collapse_ready_storms",
                    lambda: rig.notes.update(member=member(rig, "hosta|bot-one", MANUAL),
                                             retired=rig.disposition(late.get("duplicate", "?"))))
    assert rig.cycle() is None
    assert rig.notes.get("retired") == ["suppressed"]
    recorded = rig.notes.get("member") or {}
    assert (recorded.get("lastSeenAt"), recorded.get("lastEventId")) == (micros(T0 + 100), late.get("duplicate"))
    # Its clear was then sent in the same cycle and removed the member.
    assert rig.disposition(late.get("clear", "?")) == ["sent"]
    assert rig.members("hosta|bot-one") == []
    assert rig.cleared("hosta|bot-one") == [MANUAL]


def test_t64_an_opener_that_arrives_after_the_scan_and_is_sent_is_recorded(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    late: dict[str, str] = {}
    rig.before_pass("suppress_ready_recovery_duplicates",
                    lambda: late.update(opener=rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))))
    assert rig.cycle() is None
    assert rig.disposition(late.get("opener", "?")) == ["sent"]
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0]


def test_t67_a_member_seen_by_the_scan_survives_a_crash_later_in_the_cycle(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    alert = rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    # The first existing pass after the observer's place in the cycle.
    rig.crash_before("suppress_ready_recovery_duplicates")
    raised = rig.cycle()
    assert type(raised).__name__ == "Crash"
    assert rig.disposition(alert) == ["outbox"]
    rig.restart()
    # Reloaded from disk: the scan had saved the member before any later pass ran.
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.pages() == []
    assert rig.cycle_at(T0 + 30) is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0 + 30]


def test_t67_a_member_seen_at_an_exit_point_survives_a_crash_directly_after_the_move(make_rig):
    rig = make_rig()
    rig.clock.set(T0 + 60)
    late: dict[str, str] = {}

    def arrive_after_the_scan() -> None:
        late["alert"] = rig.put(not_ready(observer_event(MANUAL, "hosta", "bot-one", T0 + 10), T0 + HOUR))
        late["clear"] = rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 40, clear=True))

    rig.before_pass("suppress_ready_recovery_duplicates", arrive_after_the_scan)
    # The recovered-before-delivery pass retires the alert first; the process dies as that move returns.
    rig.crash_after("move_suppressed_event")
    raised = rig.cycle()
    assert type(raised).__name__ == "Crash"
    assert rig.disposition(late.get("alert", "?")) == ["suppressed"]
    assert rig.disposition(late.get("clear", "?")) == ["outbox"]
    rig.restart()
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert member(rig, "hosta|bot-one", MANUAL).get("lastEventId") == late.get("alert")


def test_t68_equal_stamps_keep_the_member_and_count_a_tie(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.logged("ties") == [1]


def test_t68_a_clear_with_the_alerts_own_stamp_read_in_a_later_cycle_keeps_the_member_and_counts_a_tie(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    # The alert has left the outbox, so no later read of it can re-add a member the clear removed.
    rig.clock.set(T0 + 60)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.logged("ties") == [1]


def test_t68_a_clear_later_inside_the_same_second_removes_the_member(make_rig):
    rig = make_rig()
    rig.clock.set(T0 + 1)
    rig.put(runtime_event(PRIMARY, "bot-one", T0 + 0.1, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [PRIMARY]
    rig.put(runtime_event(PRIMARY, "bot-one", T0 + 0.9, relay_host="hosta.example", clear=True))
    rig.cycle()
    assert rig.members("hosta|bot-one") == []
    assert rig.cleared("hosta|bot-one") == [PRIMARY]
    assert rig.logged("ties") == []


def test_t68_a_new_death_later_inside_the_second_of_a_clear_is_kept(make_rig):
    rig = make_rig()
    rig.clock.set(T0 - 10)
    rig.put(runtime_event(PRIMARY, "bot-one", T0 - 10, relay_host="hosta.example"))
    rig.cycle()
    assert seen(rig, "hosta|bot-one", PRIMARY)[1] == micros(T0 - 10)
    rig.clock.set(T0 + 1)
    rig.put(runtime_event(PRIMARY, "bot-one", T0 + 0.1, relay_host="hosta.example", clear=True))
    rig.put(runtime_event(PRIMARY, "bot-one", T0 + 0.9, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [PRIMARY]
    assert seen(rig, "hosta|bot-one", PRIMARY)[1] == micros(T0 + 0.9)


def test_t68_an_alert_with_the_clears_stamp_read_a_cycle_later_is_a_tie(make_rig):
    rig = make_rig()
    open_now(rig, T0 - 100)
    assert rig.members("hosta|bot-one") == [MANUAL]
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0, clear=True))
    assert rig.cycle() is None
    assert rig.cleared("hosta|bot-one") == [MANUAL]
    assert rig.members("hosta|bot-one") == []
    rig.clock.set(T0 + 30)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    rig.cycle()
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.logged("ties") == [1]


def test_t69_an_alert_with_no_creation_time_is_read_once(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    # It waits for its next send attempt, so the file stays in the outbox as its emitter wrote it.
    event = not_ready(observer_event(MANUAL, "hosta", "bot-one", T0), T0 + DAY)
    del event["createdAt"]
    alert = rig.put(event)
    assert rig.cycle() is None
    assert rig.disposition(alert) == ["outbox"]
    assert member(rig, "hosta|bot-one", MANUAL).get("lastEventId") == alert
    assert seen(rig, "hosta|bot-one", MANUAL) == (micros(T0), micros(T0))
    # A second read of the same file changes nothing: it is not a newer alert.
    rig.cycle_at(T0 + 30)
    assert rig.disposition(alert) == ["outbox"]
    assert seen(rig, "hosta|bot-one", MANUAL) == (micros(T0), micros(T0))


def test_t69_a_clear_with_no_creation_time_is_applied_once(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.members("hosta|bot-one") == [MANUAL]
    rig.clock.set(T0 + 100)
    event = not_ready(observer_event(MANUAL, "hosta", "bot-one", T0 + 100, clear=True), T0 + DAY)
    del event["createdAt"]
    clear = rig.put(event)
    assert rig.cycle() is None
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hosta|bot-one") == []
    assert clear in json.dumps(rig.entry("hosta|bot-one").get("clearedAt"))
    # A newer alert, then the same clear file read again: the newer member stays.
    rig.clock.set(T0 + 200)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 150))
    rig.cycle()
    rig.cycle_at(T0 + 230)
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hosta|bot-one") == [MANUAL]


def test_t70_an_older_alert_whose_file_sorts_after_a_newer_clear_is_still_removed(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [PRIMARY]
    # One scan: the companion alert is older than the runtime's clear, but its
    # file name sorts after the clear's.
    rig.clock.set(T0 + 60)
    clear = runtime_event(PRIMARY, "bot-one", T0 + 20, relay_host="hosta.example", clear=True)
    alert = runtime_event(NO_FALLBACK, "bot-one", T0 + 10, relay_host="hosta.example", severity="critical")
    rig.put(clear, name=f"a-sorts-first.{clear['id']}.json")
    rig.put(alert, name=f"b-sorts-second.{alert['id']}.json")
    assert rig.outbox_names() == [f"a-sorts-first.{clear['id']}.json", f"b-sorts-second.{alert['id']}.json"]
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cleared("hosta|bot-one") == sorted([NO_FALLBACK, PRIMARY])


def test_t70_an_older_alert_whose_file_sorts_after_a_waiting_clear_is_removed_by_the_scan(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [PRIMARY]
    # The runtime's clear waits for its next send attempt, so in this cycle only the scan reads it:
    # no later observation of the clear repairs what the scan's order left.
    rig.clock.set(T0 + 60)
    clear = not_ready(runtime_event(PRIMARY, "bot-one", T0 + 20, relay_host="hosta.example", clear=True), T0 + DAY)
    alert = runtime_event(NO_FALLBACK, "bot-one", T0 + 10, relay_host="hosta.example", severity="critical")
    rig.put(clear, name=f"a-sorts-first.{clear['id']}.json")
    rig.put(alert, name=f"b-sorts-second.{alert['id']}.json")
    assert rig.cycle() is None
    assert rig.disposition(clear["id"]) == ["outbox"]
    assert rig.members("hosta|bot-one") == []
    assert rig.cleared("hosta|bot-one") == sorted([NO_FALLBACK, PRIMARY])
    assert rig.logged("passFault") == []


def test_t71_an_alert_older_than_its_sources_clear_is_ignored_while_the_entry_exists(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60))
    rig.cycle()
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])
    rig.clock.set(T0 + HOUR)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + HOUR, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    # An alert of the cleared source, created before that clear, returns to the outbox.
    rig.clock.set(T0 + 2 * HOUR)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 1800))
    rig.cycle()
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cleared("hosta|bot-one") == [MANUAL]


def deleted_condition(rig: Rig) -> int:
    """A condition that opened at T0, cleared an hour later and was deleted after its grace."""
    open_now(rig, T0)
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    return cleared_at


def test_t71_an_alert_older_than_its_sources_clear_is_ignored_after_the_condition_was_deleted(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.page_times() == [T0]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.cleared("hosta|bot-one") == [MANUAL]
    rig.clock.set(T0 + 2 * HOUR)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 1800))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "absent"
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0]


def test_t86_an_alert_created_after_the_clear_opens_a_new_condition(make_rig):
    rig = make_rig()
    deleted_condition(rig)
    assert rig.cleared("hosta|bot-one") == [MANUAL]
    assert rig.page_times() == [T0]
    again = T0 + 2 * HOUR
    rig.clock.set(again)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", again))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, again]
    assert rig.page_texts()[-1] == page_line("hosta/bot-one", 0, 1)


def test_t86_an_opener_of_a_source_that_never_cleared_opens_a_new_condition(make_rig):
    rig = make_rig()
    deleted_condition(rig)
    assert rig.cleared("hosta|bot-one") == [MANUAL]
    assert rig.page_times() == [T0]
    # Created before the deletion, relayed after it. Its own source never cleared.
    relayed = T0 + 2 * HOUR
    rig.clock.set(relayed)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 1800))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.page_times() == [T0, relayed]


def test_t72_a_creation_time_in_the_future_is_capped_at_the_read_time(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0 + HOUR))
    assert rig.cycle() is None
    assert rig.entry("hosta|bot-one").get("pendingSince") == micros(T0)
    # The promotion is not delayed by the event's clock.
    rig.cycle_at(T0 + PROMOTION)
    assert rig.page_times() == [T0 + PROMOTION]
    # An acknowledgement written after the opening holds.
    rig.clock.set(T0 + PROMOTION + 60)
    rig.acknowledge("hosta|bot-one")
    rig.cycle_at(T0 + PROMOTION + INTERVAL)
    assert rig.page_times() == [T0 + PROMOTION]
    assert rig.phase("hosta|bot-one") == "open"


# The watchdog stamps its own host's clock (bot-errors-emit.py), here ten minutes ahead.
SKEW = 600


def clock_runs_on(rig: Rig) -> None:
    """Each read of the clock moves it 10 µs on, as the real clock moves between two reads in one cycle.

    The rig's clock otherwise stands still inside a cycle: two events read in one scan get equal read
    times, which the class takes as a tie, and a tie keeps the member.
    """

    def read() -> float:
        rig.clock.now += 0.00001
        return rig.clock.now

    rig.monkeypatch.setattr(rig.clock, "time", read)


def fail_group_sends_of(rig: Rig, *event_ids: str) -> None:
    rig.group_rule = lambda text: "fail" if any(f"event: {event_id}" in text for event_id in event_ids) else "ok"


def untimed(event: dict[str, Any]) -> dict[str, Any]:
    del event["createdAt"]
    return event


def test_t94_a_future_dated_alert_whose_send_failed_stays_cleared_when_read_again(make_rig):
    rig = make_rig()
    clock_runs_on(rig)
    rig.clock.set(T0)
    alert = rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW))
    clear = rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 30, clear=True))
    # One cycle reads both. The alert's group send fails and it is requeued; its clear is sent.
    fail_group_sends_of(rig, alert)
    assert rig.cycle() is None
    assert rig.disposition(alert) == ["outbox"]
    assert rig.disposition(clear) in (["sent"], ["suppressed"])
    rig.group_rule = lambda text: "ok"
    # The next scan reads the requeued alert again, at a later read time.
    assert rig.cycle_at(T0 + 60) is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + GRACE + 60) is None
    assert rig.open_scopes() == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_texts("hosta/bot-one") == []
    assert rig.logged("passFault") == []


@pytest.mark.parametrize("alert_file_first", [True, False], ids=["alert-file-first", "clear-file-first"])
def test_t94_an_untimed_alert_and_its_untimed_clear_in_one_cycle_leave_no_member(make_rig, alert_file_first):
    rig = make_rig()
    clock_runs_on(rig)
    rig.clock.set(T0)
    alert = untimed(watchdog_event(DEAD, "hosta", "bot-one", T0))
    clear = untimed(watchdog_event(DEAD, "hosta", "bot-one", T0, clear=True))
    first, second = (alert, clear) if alert_file_first else (clear, alert)
    rig.put(first, name=f"a-sorts-first.{first['id']}.json")
    rig.put(second, name=f"b-sorts-second.{second['id']}.json")
    # The scan reads the alert, then the clear; each then leaves the outbox and is read again.
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + GRACE + 60) is None
    assert rig.open_scopes() == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_texts("hosta/bot-one") == []
    assert rig.logged("passFault") == []


def test_t94_a_new_untimed_alert_after_an_untimed_clear_opens_and_pages(make_rig):
    rig = make_rig()
    clock_runs_on(rig)
    rig.clock.set(T0)
    rig.put(untimed(watchdog_event(DEAD, "hosta", "bot-one", T0)))
    rig.put(untimed(watchdog_event(DEAD, "hosta", "bot-one", T0, clear=True)))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    # Another event id: a new death, read inside the grace.
    rig.clock.set(T0 + 120)
    rig.put(untimed(watchdog_event(DEAD, "hosta", "bot-one", T0 + 120)))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.page_times("hosta/bot-one") == [T0 + 120]
    assert rig.logged("passFault") == []


def test_t94_a_second_clear_keeps_the_removed_untimed_alert_removed(make_rig):
    rig = make_rig()
    clock_runs_on(rig)
    rig.clock.set(T0)
    alert = untimed(watchdog_event(DEAD, "hosta", "bot-one", T0))
    clear = untimed(watchdog_event(DEAD, "hosta", "bot-one", T0, clear=True))
    # A second clear of the source, read after the first, removes nothing and rewrites the record.
    again = untimed(watchdog_event(DEAD, "hosta", "bot-one", T0, clear=True))
    rig.put(clear, name=f"a-clear.{clear['id']}.json")
    rig.put(again, name=f"b-clear-again.{again['id']}.json")
    # The alert leaves the outbox last, so no clear is read after its last observation.
    rig.put(alert, name=f"c-alert.{alert['id']}.json")
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_texts("hosta/bot-one") == []
    assert rig.logged("passFault") == []


def test_t94_two_future_dated_copies_of_one_death_stay_cleared_when_read_again(make_rig):
    rig = make_rig()
    clock_runs_on(rig)
    rig.clock.set(T0)
    # The group line is down: both copies are requeued. The clear removes the member, whose last
    # event is the second copy.
    first = rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW))
    second = rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 20))
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 30, clear=True))
    fail_group_sends_of(rig, first, second)
    assert rig.cycle() is None
    assert rig.disposition(first) == ["outbox"]
    assert rig.cycle_at(T0 + 60) is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_texts("hosta/bot-one") == []
    assert rig.logged("passFault") == []


def test_t94_a_requeued_future_dated_clear_read_after_a_new_death_does_not_remove_it(make_rig):
    rig = make_rig()
    clock_runs_on(rig)
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # The clear removes the member; its own group send fails, so it is read again in later cycles.
    rig.clock.set(T0 + 60)
    clear = rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 30, clear=True))
    fail_group_sends_of(rig, clear)
    assert rig.cycle() is None
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hosta|bot-one") == []
    # A new death, created after the clear on the same clock; the scan reads it, then the clear again.
    rig.clock.set(T0 + 120)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 90))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t94_a_new_death_after_a_future_dated_clear_still_opens_and_pages(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW))
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 30, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    # Created after the clear on the same clock: a new death, read inside the grace.
    rig.clock.set(T0 + 120)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 90))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.page_times("hosta/bot-one") == [T0 + 120]
    assert rig.logged("passFault") == []


def test_t94_a_clear_relayed_after_a_newer_future_dated_alert_does_not_remove_the_member(make_rig):
    rig = make_rig()
    open_at = T0
    rig.clock.set(open_at)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW))
    assert rig.cycle() is None
    assert rig.page_times() == [open_at]
    # A clear created before that alert, relayed after it.
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW - 30, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    # A newer alert replaces the member's last event; a clear created between the two is relayed after it.
    rig.clock.set(T0 + 120)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 60))
    assert rig.cycle() is None
    rig.clock.set(T0 + 180)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 30, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(open_at + INTERVAL) is None
    assert rig.page_times() == [open_at, open_at + INTERVAL]
    assert rig.logged("passFault") == []


def test_t94_a_clear_with_no_creation_time_removes_a_future_dated_alert(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # Only the clear's read time is known: it is compared with the alert's read time, never its creation time.
    rig.clock.set(T0 + 60)
    event = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60, clear=True), T0 + DAY)
    del event["createdAt"]
    rig.put(event)
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0]
    assert rig.logged("passFault") == []


def test_t94_an_alert_with_no_creation_time_after_a_future_dated_clear_is_a_new_death(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW))
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + SKEW + 30, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    # Only the alert's read time is known: it is compared with the clear's read time, never its creation time.
    rig.clock.set(T0 + 60)
    event = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60), T0 + DAY)
    del event["createdAt"]
    rig.put(event)
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.page_times("hosta/bot-one") == [T0 + 60]
    assert rig.logged("passFault") == []


def test_t94_a_death_after_a_clear_stamped_two_days_ahead_and_a_clock_correction_opens_and_pages(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # The bot host's clock jumps two days ahead as the bot recovers: beyond the allowance, so its
    # stamp orders nothing and the clear is placed at its read time.
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 2 * DAY, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    # The clock is set right, and the bot dies again an hour after it first did.
    rig.clock.set(T0 + HOUR)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + HOUR))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + HOUR]
    assert rig.logged("passFault") == []


def test_t94_an_alert_stamped_two_days_ahead_is_removed_by_a_timed_clear(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 2 * DAY))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # The recovery is stamped by a clock that is right (the README's clear by hand): the alert's
    # stamp is beyond the allowance, so the two are ordered by their read times.
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0]
    assert rig.logged("passFault") == []


def test_t94_a_stamp_thirty_minutes_ahead_still_orders_by_the_producer_clock(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 1800))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # A clear created before that alert on the same clock, read after it: inside the allowance,
    # so the stamps decide, and the alert is the later event.
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 1700, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t94_a_later_timed_death_with_no_id_after_a_clear_of_an_alert_with_no_id_opens_and_pages(make_rig):
    rig = make_rig()
    # Each event waits for its next send attempt, so only the scan reads them, in every cycle.
    rig.clock.set(T0)
    alert = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0), T0 + DAY)
    alert["id"] = ""
    rig.put(alert)
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    rig.clock.set(T0 + 60)
    clear = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60, clear=True), T0 + DAY)
    clear["id"] = ""
    rig.put(clear)
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    # A later death, also with no id: an empty id is no identity, so nothing takes it for the removed alert.
    rig.clock.set(T0 + HOUR)
    death = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + HOUR), T0 + DAY)
    death["id"] = ""
    rig.put(death)
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + HOUR]
    assert rig.logged("passFault") == []


def test_t94_a_death_after_a_queued_clear_with_no_id_stamped_two_hours_ahead_opens_pages_and_stays(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # The recovery has no id and is stamped by a clock two hours ahead. It waits for its next send attempt,
    # so every cycle reads it again. At its first read the stamp is beyond the allowance.
    rig.clock.set(T0 + 60)
    clear = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60 + 2 * HOUR, clear=True), T0 + DAY)
    clear["id"] = ""
    rig.put(clear)
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    # Read again once its stamp is inside the hour: it is still the clear already decided.
    assert rig.cycle_at(T0 + HOUR + 100) is None
    # A new death, on a clock that is right.
    rig.clock.set(T0 + HOUR + 160)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + HOUR + 160))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + HOUR + 160]
    # The queued clear, read again, does not remove it.
    assert rig.cycle_at(T0 + HOUR + 220) is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.logged("passFault") == []


def test_t94_pin_two_deaths_with_no_id_and_different_creation_times_are_two_events(make_rig):
    rig = make_rig()
    # Both wait for their next send attempt, so every cycle reads them again.
    rig.clock.set(T0 + 120)
    for at in (T0, T0 + 60):
        death = not_ready(watchdog_event(DEAD, "hosta", "bot-one", at), T0 + DAY)
        death["id"] = ""
        rig.put(death)
    assert rig.cycle() is None
    assert seen(rig, "hosta|bot-one", DEAD) == (micros(T0), micros(T0 + 60))
    # A clear created between the two deaths: the later death is the member's last event, so it stays.
    rig.clock.set(T0 + 180)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 30, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(T0 + 120 + INTERVAL) is None
    assert rig.page_times() == [T0 + 120, T0 + 120 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t94_a_death_whose_id_is_the_creation_text_of_a_removed_alert_with_no_id_opens_and_pages(make_rig):
    rig = make_rig()
    # The alert has no id and waits for its next send attempt, so every cycle reads it again.
    rig.clock.set(T0)
    alert = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0), T0 + DAY)
    alert["id"] = ""
    rig.put(alert)
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    # A later death whose id is "createdAt:" and the removed alert's creation text, as an id written by hand
    # can be: an id never names an event that has none.
    rig.clock.set(T0 + HOUR)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + HOUR, event_id="createdAt:" + alert["createdAt"]))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + HOUR]
    assert rig.logged("passFault") == []


def test_t94_an_alert_with_no_id_and_an_unreadable_creation_time_read_after_its_clear_opens_and_pages(make_rig):
    rig = make_rig()
    # The alert has no id, and its creation time is a text with no zone that no parser of the dispatcher reads
    # (a stamp with no zone would be read as local time by one of them), so it has no usable time and no
    # identity. It waits for its next send attempt, so every cycle reads it again.
    rig.clock.set(T0)
    alert = not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0), T0 + DAY)
    alert["id"] = ""
    alert["createdAt"] = "2026-10-01 at 03:00"
    rig.put(alert)
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    # Read again once the grace has run out: nothing tells it from a new death with the same text, so it is
    # one, and it opens a new condition.
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + 60 + GRACE]
    assert rig.logged("passFault") == []


# ---------------------------------------------------------------------------
# The paging path: the class's own list, its budget, and the legacy copy.
# ---------------------------------------------------------------------------

# The first words of the legacy route's own line for the two openers it copies
# to the owner today, and for the non-member critical source these cases use.
ROUTED_TITLE = {
    DEAD: "provider credential dead (re-login required)",
    MANUAL: "credential needs a manual re-login",
}
OTHER_TITLE = "agent failed to restart"

NINE_BOTS = [f"bot-{number}" for number in range(1, 10)]
ROSTER_NINE = roster(*[("hosta", bot) for bot in NINE_BOTS])


def routed_opener(source: str, host: str, bot: str, at: float) -> dict[str, Any]:
    """One of the two openers the legacy route copies to the owner, in its emitter's shape."""
    if source == DEAD:
        return watchdog_event(DEAD, host, bot, at)
    return observer_event(source, host, bot, at)


def last_cycle(rig: Rig) -> list[tuple[str, str]]:
    """What the last cycle did, in order: one (kind, text) per group send, stamp, owner send and e-mail."""
    starts = [index for index, (kind, _) in enumerate(rig.timeline) if kind == "cycle"]
    return rig.timeline[starts[-1] + 1:] if starts else []


def route_floors(rig: Rig) -> dict[str, Any]:
    """The legacy route's floors: incident key to the time of its last copy. Empty when the file is absent."""
    raw = rig.owner_route_state()
    data = json.loads(raw) if raw else {}
    return {key: entry.get("lastAt") for key, entry in data.items() if isinstance(entry, dict)}


def copy_heads(rig: Rig) -> list[str]:
    """`<host>/<bot>: <title>` of each legacy copy sent to the owner, in order."""
    return [send["text"].split(" — ")[0] for send in rig.legacy_copies()]


# A send stub recognises the class page by its text, never by call order: on the
# unchanged code there is no class send, and a stub keyed on order would fail
# the legacy copy's own first call.

def class_pages_fail(rig: Rig, needle: str = "") -> None:
    """Both owner channels refuse the class page; every other send is accepted."""
    rig.owner_rule = lambda text: "fail" if is_class_page(text) and needle in text else "ok"
    rig.email_rule = lambda subject, body: "fail" if is_class_page(subject) and needle in subject else "ok"


def class_pages_time_out(rig: Rig, needle: str = "") -> None:
    """Both owner channels time out on the class page; every other send is accepted."""
    rig.owner_rule = lambda text: "timeout" if is_class_page(text) and needle in text else "ok"
    rig.email_rule = lambda subject, body: "timeout" if is_class_page(subject) and needle in subject else "ok"


def every_send_times_out(rig: Rig) -> None:
    rig.owner_rule = lambda text: "timeout"
    rig.email_rule = lambda subject, body: "timeout"


def sends_work(rig: Rig) -> None:
    rig.owner_rule = lambda text: "ok"
    rig.email_rule = lambda subject, body: "ok"


def test_t8_owner_messages_wait_for_the_group_sends_and_the_stamp_and_the_page_goes_first(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    # The other class's event sorts first, so its copy is queued before the opener is read.
    rig.put(plain_event(OTHER_CRITICAL, "hostb", "bot-two", T0 - 1))
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    events = last_cycle(rig)
    kinds = [kind for kind, _ in events]
    assert kinds.count("stamp") == 1
    stamp = kinds.index("stamp")
    assert kinds[:stamp] == ["group", "group"]
    assert [kind for kind in kinds[stamp + 1:] if kind not in ("owner", "email")] == []
    owner_texts = [text for kind, text in events[stamp + 1:] if kind == "owner"]
    assert len(owner_texts) == 2
    assert owner_texts[0] == page_line("hosta/bot-one", 0, 1)
    assert owner_texts[1].startswith(f"hostb/bot-two: {OTHER_TITLE}")


def check_t9_an_accepted_page_replaces_the_openers_copy(rig: Rig, source: str) -> None:
    rig.clock.set(T0)
    opener = rig.put(routed_opener(source, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert len(rig.group_for(opener)) == 1
    # Exactly one owner message, the class page: the opener's own copy was dropped at the drain,
    # before the legacy route ran for it.
    assert [send["text"] for send in rig.owner] == [page_line("hosta/bot-one", 0, 1)]
    assert route_floors(rig) == {}
    # No group send carries the page, and the page is logged.
    assert rig.group_texts(PAGE_DEAD) == []
    assert [record.get("whatsappAccepted") for record in rig.class_records()
            if "whatsappAccepted" in record] == [True]


def test_t9_dead_an_accepted_page_replaces_the_openers_copy(make_rig):
    rig = make_rig()
    check_t9_an_accepted_page_replaces_the_openers_copy(rig, DEAD)
    assert rig.members("hosta|bot-one") == [DEAD]


def test_t9_manual_an_accepted_page_replaces_the_openers_copy(make_rig):
    rig = make_rig()
    check_t9_an_accepted_page_replaces_the_openers_copy(rig, MANUAL)
    assert rig.members("hosta|bot-one") == [MANUAL]


def check_t9_a_later_routed_opener_inside_the_interval_has_no_copy(rig: Rig, first: str, second: str) -> None:
    rig.clock.set(T0)
    rig.put(routed_opener(first, "hosta", "bot-one", T0))
    rig.cycle()
    assert rig.page_times() == [T0]
    rig.cycle_at(T0 + 60)
    assert rig.entry("hosta|bot-one").get("lastAcceptedAt") == T0
    # The other routed opener opens its own incident an hour later, inside the interval.
    later = T0 + HOUR
    rig.clock.set(later)
    second_id = rig.put(routed_opener(second, "hosta", "bot-one", later))
    assert rig.cycle() is None
    assert len(rig.group_for(second_id)) == 1
    assert [send["text"] for send in rig.owner] == [page_line("hosta/bot-one", 0, 1)]


def test_t9_dead_a_later_routed_opener_inside_the_interval_has_no_copy(make_rig):
    rig = make_rig()
    check_t9_a_later_routed_opener_inside_the_interval_has_no_copy(rig, MANUAL, DEAD)
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])


def test_t9_manual_a_later_routed_opener_inside_the_interval_has_no_copy(make_rig):
    rig = make_rig()
    check_t9_a_later_routed_opener_inside_the_interval_has_no_copy(rig, DEAD, MANUAL)
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])


def check_t9_a_refused_page_lets_the_copy_out(rig: Rig, source: str) -> None:
    class_pages_fail(rig)
    rig.clock.set(T0)
    rig.put(routed_opener(source, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    # The new state this stands beside: the condition is open, and its page was tried and refused.
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0]
    assert len(rig.page_emails()) == 1
    assert rig.entry("hosta|bot-one").get("lastAcceptedAt") is None
    # So the opener's own copy goes out in that cycle, and the legacy route writes its floor, as today.
    assert copy_heads(rig) == [f"hosta/bot-one: {ROUTED_TITLE[source]}"]
    assert list(route_floors(rig).values()) == [T0]


def test_t9_dead_a_refused_page_lets_the_copy_out(make_rig):
    rig = make_rig()
    check_t9_a_refused_page_lets_the_copy_out(rig, DEAD)
    assert [kind for kind, text in last_cycle(rig) if kind == "owner"] == ["owner", "owner"]


def test_t9_manual_a_refused_page_lets_the_copy_out(make_rig):
    rig = make_rig()
    check_t9_a_refused_page_lets_the_copy_out(rig, MANUAL)
    assert [kind for kind, text in last_cycle(rig) if kind == "owner"] == ["owner", "owner"]


def check_t9_a_cut_page_lets_the_copy_out(rig: Rig, source: str) -> None:
    # `hosta|bot-one` is open by an opener the legacy route does not take, and was paged once.
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    rig.cycle()
    first = T0 + PROMOTION
    rig.cycle_at(first)
    rig.cycle_at(first + 60)
    assert rig.page_times() == [first]
    # One interval later it is due again. In that cycle a second bot opens; its page was never
    # tried, so it goes first, and it uses the whole class budget: 8 s and then 12 s.
    due = first + INTERVAL
    class_pages_time_out(rig, "hostb/bot-two")
    rig.clock.set(due)
    rig.put(observer_event(MANUAL, "hostb", "bot-two", due))
    rig.put(routed_opener(source, "hosta", "bot-one", due))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two"]
    assert [send["timeout"] for send in rig.pages("hostb/bot-two")] == [8]
    # Listed and not started: the floor is written, and no second page went out.
    assert rig.entry("hosta|bot-one").get("lastPageAt") == due
    assert rig.page_times("hosta/bot-one") == [first]
    # So the routed opener's copy goes out in that cycle.
    assert copy_heads(rig).count(f"hosta/bot-one: {ROUTED_TITLE[source]}") == 1


def test_t9_dead_a_cut_page_lets_the_copy_out(make_rig):
    rig = make_rig()
    check_t9_a_cut_page_lets_the_copy_out(rig, DEAD)
    assert rig.members("hosta|bot-one") == sorted([DEAD, UNUSABLE_30])


def test_t9_manual_a_cut_page_lets_the_copy_out(make_rig):
    rig = make_rig()
    check_t9_a_cut_page_lets_the_copy_out(rig, MANUAL)
    assert rig.members("hosta|bot-one") == sorted([MANUAL, UNUSABLE_30])


def check_t9_three_refused_attempts_leave_no_accepted_page(rig: Rig, first: str, second: str) -> None:
    class_pages_fail(rig)
    rig.clock.set(T0)
    rig.put(routed_opener(first, "hosta", "bot-one", T0))
    for offset in (0, 60, 120, 180):
        rig.cycle_at(T0 + offset)
    # The new state: open, three attempts and no fourth, the floor kept, no page accepted.
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + 60, T0 + 120]
    entry = rig.entry("hosta|bot-one")
    assert (entry.get("lastPageAt"), entry.get("lastAcceptedAt")) == (T0 + 120, None)
    # The other routed opener then opens its incident for the first time: its copy goes out.
    later = T0 + HOUR
    rig.clock.set(later)
    rig.put(routed_opener(second, "hosta", "bot-one", later))
    assert rig.cycle() is None
    assert [send["at"] for send in rig.legacy_copies(f"hosta/bot-one: {ROUTED_TITLE[second]}")] == [later]
    assert rig.page_times() == [T0, T0 + 60, T0 + 120]


def test_t9_dead_after_three_refused_attempts_a_second_openers_copy_goes_out(make_rig):
    rig = make_rig()
    check_t9_three_refused_attempts_leave_no_accepted_page(rig, MANUAL, DEAD)
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])


def test_t9_manual_after_three_refused_attempts_a_second_openers_copy_goes_out(make_rig):
    rig = make_rig()
    check_t9_three_refused_attempts_leave_no_accepted_page(rig, DEAD, MANUAL)
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])


def check_t9_a_reloaded_floor_with_no_outcome_is_no_accepted_page(rig: Rig, first: str, second: str) -> None:
    rig.clock.set(T0)
    rig.put(routed_opener(first, "hosta", "bot-one", T0))
    rig.cycle()
    assert rig.page_times() == [T0]
    # The process restarts before the next pass could apply the outcome of that send.
    rig.restart()
    entry = rig.entry("hosta|bot-one")
    assert (entry.get("lastPageAt"), entry.get("lastAttemptAt"), entry.get("lastAcceptedAt")) == (T0, T0, None)
    later = T0 + HOUR
    rig.clock.set(later)
    rig.put(routed_opener(second, "hosta", "bot-one", later))
    assert rig.cycle() is None
    assert [send["at"] for send in rig.legacy_copies(f"hosta/bot-one: {ROUTED_TITLE[second]}")] == [later]
    assert rig.page_times() == [T0]


def test_t9_dead_after_a_reloaded_floor_with_no_outcome_a_second_openers_copy_goes_out(make_rig):
    rig = make_rig()
    check_t9_a_reloaded_floor_with_no_outcome_is_no_accepted_page(rig, MANUAL, DEAD)
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])


def test_t9_manual_after_a_reloaded_floor_with_no_outcome_a_second_openers_copy_goes_out(make_rig):
    rig = make_rig()
    check_t9_a_reloaded_floor_with_no_outcome_is_no_accepted_page(rig, DEAD, MANUAL)
    assert rig.members("hosta|bot-one") == sorted([DEAD, MANUAL])


def test_t10_a_crash_inside_the_send_finds_the_floor_already_on_disk(make_rig):
    rig = make_rig()
    # The stub records what the incident state on disk holds when the send is called, then the process dies.
    rig.owner_probe = lambda text: rig.entry("hosta|bot-one").get("lastPageAt")
    rig.owner_rule = lambda text: "crash" if is_class_page(text) else "ok"
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    rig.cycle()
    opened = T0 + PROMOTION
    raised = rig.cycle_at(opened)
    assert type(raised).__name__ == "Crash"
    assert [send.get("probe") for send in rig.pages()] == [opened]
    # A new process: one send was attempted, and the next cycle does not send it again.
    sends_work(rig)
    rig.restart()
    assert rig.cycle_at(opened + 30) is None
    assert rig.page_times() == [opened]
    rig.cycle_at(opened + INTERVAL)
    assert rig.page_times() == [opened, opened + INTERVAL]


def test_t10_an_exception_after_the_channels_costs_the_page_an_attempt_and_nothing_else(make_rig):
    rig = make_rig()
    real_append = rig.d.append_dispatch_log

    def failing_for_the_page_record(paths, record, *args, **kwargs):
        if str(record.get("type") or "").startswith(LOG_PREFIX) and "whatsappAccepted" in record:
            raise RuntimeError("dispatch log unavailable")
        return real_append(paths, record, *args, **kwargs)

    rig.monkeypatch.setattr(rig.d, "append_dispatch_log", failing_for_the_page_record)
    rig.clock.set(T0)
    rig.put(plain_event(OTHER_CRITICAL, "hostb", "bot-two", T0 - 1))
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    # Nothing leaves run_once: the class send step absorbs the exception.
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # The legacy drain still ran: the other class's copy, and the opener's own, because the
    # recorded outcome is a failure although a channel accepted the page.
    assert copy_heads(rig) == [f"hostb/bot-two: {OTHER_TITLE}", f"hosta/bot-one: {ROUTED_TITLE[MANUAL]}"]
    assert rig.cycle_at(T0 + 60) is None
    assert rig.entry("hosta|bot-one").get("failedAttempts") == 1
    assert rig.cycle_at(T0 + 120) is None
    assert rig.cycle_at(T0 + 180) is None
    # With the fault left in place: three consecutive cycles, and not a fourth.
    assert rig.page_times() == [T0, T0 + 60, T0 + 120]


def test_t11_a_refused_page_is_retried_next_cycle_and_after_three_waits_one_interval(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.cycle_at(T0 + 60)
    assert rig.page_times() == [T0]
    due = T0 + INTERVAL
    class_pages_fail(rig)
    for offset in (0, 60, 120, 180):
        assert rig.cycle_at(due + offset) is None
    assert rig.page_times() == [T0, due, due + 60, due + 120]
    assert rig.page_texts()[1:] == [page_line("hosta/bot-one", 4, 2)] * 3
    # The floor of the third attempt is kept: the next attempt is one interval after it.
    sends_work(rig)
    rig.cycle_at(due + INTERVAL)
    assert rig.page_times() == [T0, due, due + 60, due + 120]
    rig.cycle_at(due + 120 + INTERVAL)
    assert rig.page_times() == [T0, due, due + 60, due + 120, due + 120 + INTERVAL]
    assert rig.page_texts()[-1] == page_line("hosta/bot-one", 8, 2)


def test_t11_an_attempt_that_reached_only_whatsapp_counts_toward_the_three(make_rig):
    rig = make_rig()

    def refused_after_four_seconds(subject, body):
        if is_class_page(subject):
            rig.clock.advance(4)
            return "fail"
        return "ok"

    # Every class page times out on WhatsApp. The first page of each cycle also spends 4 s
    # on its e-mail, so the second page's 8 s of WhatsApp end the class budget: no e-mail for it.
    rig.owner_rule = lambda text: "timeout" if is_class_page(text) else "ok"
    rig.email_rule = refused_after_four_seconds
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    rig.put(observer_event(UNUSABLE_30, "hostb", "bot-two", T0))
    rig.cycle()
    opened = T0 + PROMOTION
    for offset in (0, 60, 120, 180):
        assert rig.cycle_at(opened + offset) is None
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two"]
    # Three attempts each and no fourth. One page had WhatsApp and e-mail every time; the other
    # had WhatsApp only every time, and those three attempts counted. (Which of the two went
    # first is not asserted.)
    attempts = {where: (len(rig.pages(where)), len(rig.page_emails(where)))
                for where in ("hosta/bot-one", "hostb/bot-two")}
    assert sorted(attempts.values()) == [(3, 0), (3, 3)]
    assert [send["timeout"] for send in rig.pages()] == [8] * 6


def test_t11_a_refused_first_page_is_due_again_and_leaves_the_owner_routes_file_alone(make_rig):
    rig = make_rig()
    # An earlier copy of another class, so the legacy route's state file exists.
    rig.clock.set(T0 - HOUR)
    rig.put(plain_event(OTHER_CRITICAL, "hostb", "bot-two", T0 - HOUR))
    rig.cycle()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    rig.cycle()
    before = rig.owner_route_state()
    assert list(route_floors(rig).values()) == [T0 - HOUR]
    class_pages_fail(rig)
    opened = T0 + PROMOTION
    assert rig.cycle_at(opened) is None
    assert rig.page_times() == [opened]
    assert rig.owner_route_state() == before
    # Due again at once; and a copy of another class in that next cycle is still sent.
    sends_work(rig)
    rig.clock.set(opened + 60)
    rig.put(plain_event(OTHER_CRITICAL, "hostb", "bot-three", opened + 60))
    assert rig.cycle() is None
    assert rig.page_times() == [opened, opened + 60]
    assert rig.page_texts()[-1] == page_line("hosta/bot-one", 0, 1)
    assert [send["at"] for send in rig.legacy_copies("hostb/bot-three")] == [opened + 60]


def test_t12_a_page_that_never_started_records_no_floor_and_no_failure(make_rig):
    rig = make_rig()
    tried: list[str] = []

    # Whichever class page is sent first times out on both channels; which one that is, is not asserted.
    def the_first_page_times_out(text):
        if not is_class_page(text):
            return "ok"
        if not tried:
            tried.append(text.split(":")[0])
        return "timeout" if text.startswith(tried[0]) else "ok"

    rig.owner_rule = the_first_page_times_out
    rig.email_rule = lambda subject, body: (
        "timeout" if tried and is_class_page(subject) and subject.startswith(tried[0]) else "ok")
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    rig.put(observer_event(UNUSABLE_30, "hostb", "bot-two", T0))
    rig.cycle()
    opened = T0 + PROMOTION
    assert rig.cycle_at(opened) is None
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two"]
    assert len(tried) == 1
    waiting = [where for where in ("hosta/bot-one", "hostb/bot-two") if where != tried[0]]
    assert len(waiting) == 1
    waiting_scope = waiting[0].replace("/", "|")
    # The first page used the whole class budget, so the other was listed and never started.
    assert [send["timeout"] for send in rig.pages(tried[0])] == [8]
    assert [mail["timeout"] for mail in rig.page_emails(tried[0])] == [12]
    assert rig.entry(waiting_scope).get("lastPageAt") == opened
    assert rig.pages(waiting[0]) == []
    # Next cycle it goes out: no floor held it back, and no failure was counted.
    sends_work(rig)
    rig.cycle_at(opened + 60)
    assert rig.page_times(waiting[0]) == [opened + 60]
    assert not rig.entry(waiting_scope).get("failedAttempts")
    rig.cycle_at(opened + 120)
    assert rig.entry(waiting_scope).get("count") == 1


def test_t90_a_page_listed_in_a_cycle_that_fails_before_the_drain_is_sent_next_cycle(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    rig.cycle()
    opened = T0 + PROMOTION

    def fail_the_state_write() -> None:
        raise RuntimeError("state write failed")

    rig.before_pass("record_state", fail_the_state_write)
    raised = rig.cycle_at(opened)
    assert type(raised).__name__ == "RuntimeError"
    assert ("stamp", "") not in last_cycle(rig)
    # The page was listed: the condition is open and its floor is written. The drain was skipped.
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.entry("hosta|bot-one").get("lastPageAt") == opened
    assert rig.pages() == []
    # The item survived: the next cycle sends it, and no failure is counted for it.
    assert rig.cycle_at(opened + 30) is None
    assert rig.page_times() == [opened + 30]
    assert not rig.entry("hosta|bot-one").get("failedAttempts")


def test_t13_with_budget_for_two_sends_the_two_oldest_attempts_go_first(make_rig):
    rig = make_rig(fleet=ROSTER_NINE)
    # Opened one a minute, the last name first, so the order by last attempt is not the order by name.
    for index, bot in enumerate(reversed(NINE_BOTS)):
        open_now(rig, T0 + 60 * index, bot=bot)
    rig.cycle_at(T0 + 540)
    assert len(rig.page_times()) == 9

    def accepted_after_two_seconds(subject, body):
        if is_class_page(subject):
            rig.clock.advance(2)
        return "ok"

    # All nine are due. Each send takes 10 s (8 s of WhatsApp, then an e-mail accepted after 2 s),
    # so the class budget allows two.
    due = T0 + 480 + INTERVAL
    rig.owner_rule = lambda text: "timeout" if is_class_page(text) else "ok"
    rig.email_rule = accepted_after_two_seconds
    mark = len(rig.owner)
    assert rig.cycle_at(due) is None
    assert [send["text"] for send in rig.owner[mark:]] == [
        page_line("hosta/bot-9", 4, 2), page_line("hosta/bot-8", 4, 2)]
    # The seven that waited go out next cycle, the oldest attempt first.
    sends_work(rig)
    mark = len(rig.owner)
    rig.cycle_at(due + 60)
    assert [send["text"] for send in rig.owner[mark:]] == [
        page_line(f"hosta/bot-{number}", 4, 2) for number in (7, 6, 5, 4, 3, 2, 1)]


def test_t14_with_the_owner_route_disabled_nothing_is_prepared_and_one_record_is_logged_per_interval(make_rig):
    rig = make_rig(owner_route_on=False)
    open_now(rig, T0)
    open_now(rig, T0, host="hostb", bot="bot-two")
    rig.cycle_at(T0 + 60)
    rig.cycle_at(T0 + 120)
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two"]
    # One record per condition in the interval, however many cycles ran.
    assert rig.logged("ownerRouteDisabled") == [True, True]
    entry = rig.entry("hosta|bot-one")
    assert (entry.get("lastPageAt"), entry.get("lastDisabledLogAt")) == (None, T0)
    rig.cycle_at(T0 + INTERVAL)
    assert rig.logged("ownerRouteDisabled") == [True, True, True, True]
    assert rig.entry("hosta|bot-one").get("lastDisabledLogAt") == T0 + INTERVAL
    assert (rig.owner, rig.emails) == ([], [])


def test_t15_the_class_log_records_keep_their_booleans_and_integers_and_carry_no_text(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0)
    # One cycle with a page, a tie, an event the class cannot use and an unreadable acknowledge file.
    # (Two sources: one source from three hosts would be collapsed as a storm.)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0))
    rig.put(watchdog_event(DEAD, "hostb", "bot-two", T0))
    rig.put(watchdog_event(DEAD, "hostb", "bot-two", T0, clear=True))
    nameless = observer_event(MANUAL, "hostc", "bot-three", T0)
    del nameless["instance"]
    rig.put(nameless)
    rig.acknowledge("hosta|bot-one", raw="{ this is not JSON")
    assert rig.cycle() is None
    rig.cycle_at(T0 + 60)
    records = rig.class_records()
    assert [type(value).__name__ for value in rig.logged("ties")] == ["int"]
    assert [type(value).__name__ for value in rig.logged("unusableEvents")] == ["int"]
    assert sorted({type(value).__name__ for value in rig.logged("ackUnreadable")}) == ["bool"]
    pages = [record for record in records if "whatsappAccepted" in record]
    assert [(type(record.get("count")).__name__, type(record.get("failedAttempts")).__name__,
             record.get("whatsappAccepted"), record.get("emailAccepted")) for record in pages] == [
        ("int", "int", True, True), ("int", "int", True, True)]
    # Nothing but the type is text.
    assert [(record["type"], key) for record in records for key, value in record.items()
            if key != "type" and isinstance(value, str)] == []


def test_t46_twenty_legacy_copies_in_every_cycle_do_not_hold_back_a_due_page(make_rig):
    rig = make_rig()
    for cycle in range(10):
        now = T0 + 60 * cycle
        rig.clock.set(now)
        # Twenty events of another class, read before the opener: they fill the legacy queue.
        for number in range(20):
            rig.put(plain_event(OTHER_CRITICAL, "hostb", f"filler-{cycle}-{number:02d}", now - 1))
        if cycle == 0:
            rig.put(observer_event(MANUAL, "hosta", "bot-one", now))
        assert rig.cycle() is None
        assert rig.page_times() == [T0]
    assert len(rig.legacy_copies()) == 200


def nine_pending(rig: Rig, at: int) -> None:
    """Nine bots, each with an opener the legacy route does not take: nine first pages fall due together.

    The events are put in the reverse order of their scope keys. That fixes no order of the stored
    entries: the state is written with sorted keys, and these pages fall due in a later cycle.
    """
    rig.clock.set(at)
    for bot in reversed(NINE_BOTS):
        rig.put(observer_event(UNUSABLE_30, "hosta", bot, at))
    rig.cycle()


def test_t47_the_class_list_and_the_legacy_drain_each_keep_their_own_budget(make_rig):
    rig = make_rig(fleet=ROSTER_NINE)
    nine_pending(rig, T0)
    every_send_times_out(rig)
    opened = T0 + PROMOTION
    attempted: list[str] = []
    for cycle in range(10):
        now = opened + 60 * cycle
        rig.clock.set(now)
        rig.put(plain_event(OTHER_CRITICAL, "hostb", f"other-{cycle}-a", now))
        rig.put(plain_event(OTHER_CRITICAL, "hostb", f"other-{cycle}-b", now))
        owner_mark, email_mark = len(rig.owner), len(rig.emails)
        assert rig.cycle() is None
        owner, emails = rig.owner[owner_mark:], rig.emails[email_mark:]
        # One class page: 8 s of WhatsApp and the 12 s that are left for its e-mail; no second
        # page starts. Then the legacy drain, with its own 30 s from its own start: 8 s and 20 s
        # for the first copy, the remaining 2 s of WhatsApp and no e-mail for the second, as today.
        assert [(is_class_page(send["text"]), send["timeout"]) for send in owner] == [
            (True, 8), (False, 8), (False, 2)]
        assert [(is_class_page(mail["subject"]), mail["timeout"]) for mail in emails] == [(True, 12), (False, 20)]
        attempted.append(owner[0]["text"].split(":")[0])
    # The nine rotate: each is tried once before any is tried a second time. None was tried
    # before, so the order among them is by scope key; a page that was cut is not
    # set behind the one that was tried.
    assert attempted[:9] == [f"hosta/{bot}" for bot in NINE_BOTS]
    assert attempted[9] == attempted[0]


def test_t47_with_e_mail_disabled_three_pages_fit_the_class_budget_and_the_copy_keeps_its_time(make_rig):
    rig = make_rig(fleet=ROSTER_NINE, email=False)
    nine_pending(rig, T0)
    every_send_times_out(rig)
    opened = T0 + PROMOTION
    rig.clock.set(opened)
    rig.put(plain_event(OTHER_CRITICAL, "hostb", "other-a", opened))
    mark = len(rig.owner)
    assert rig.cycle() is None
    assert [(is_class_page(send["text"]), send["timeout"]) for send in rig.owner[mark:]] == [
        (True, 8), (True, 8), (True, 4), (False, 8)]
    assert rig.emails == []


def test_t78_the_page_says_what_the_condition_holds(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.clock.set(T0 + 60)
    rig.put(runtime_event(PRIMARY, "bot-one", T0 + 60, relay_host="hosta.example"))
    rig.put(probe_event("hosta", "bot-one", T0 + 60))
    rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0 + 60))
    rig.cycle()
    members = [MANUAL, PRIMARY, probe_source("hosta", "bot-one")]
    assert rig.members("hosta|bot-one") == sorted(members)
    # The dispatcher ran late for the second page: the hours are those since the opening,
    # not four times the page number.
    rig.cycle_at(T0 + 5 * HOUR)
    rig.cycle_at(T0 + 9 * HOUR)
    assert rig.page_texts() == [page_line("hosta/bot-one", hours, page) for hours, page in ((0, 1), (5, 2), (9, 3))]
    mails = rig.page_emails()
    assert [mail["subject"] for mail in mails] == rig.page_texts()
    assert [[source in mail["body"] for source in members] for mail in mails] == [
        [True, False, False], [True, True, True], [True, True, True]]
    # An event of another class on the same bot is not in the list.
    assert [OTHER_CRITICAL in mail["body"] for mail in mails] == [False, False, False]


# ---------------------------------------------------------------------------
# Acknowledge. The cases write the file themselves, in its stored format.
# ---------------------------------------------------------------------------


def test_t16_an_acknowledgement_quiets_its_scope_and_the_copy_of_a_later_routed_opener(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + 600)
    rig.acknowledge("hosta|bot-one")
    for step in (1, 2):
        rig.cycle_at(T0 + step * INTERVAL)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0]
    # Inside the hold, more than one interval after the page, the other routed opener
    # opens its incident for the first time: the group is told, the owner is not.
    later = T0 + 2 * INTERVAL + 600
    rig.clock.set(later)
    second = rig.put(watchdog_event(DEAD, "hosta", "bot-one", later))
    assert rig.cycle() is None
    assert len(rig.group_for(second)) == 1
    assert [send["at"] for send in rig.owner] == [T0]


def test_t17_the_hold_ends_24_hours_after_the_acknowledgement_and_the_interval_restarts_there(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    acked = T0 + 600
    rig.clock.set(acked)
    rig.acknowledge("hosta|bot-one")
    rig.cycle_at(acked + ACK_HOLD - 30)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0]
    resumed = acked + ACK_HOLD
    rig.cycle_at(resumed)
    assert rig.page_times() == [T0, resumed]
    rig.cycle_at(resumed + INTERVAL - 30)
    assert rig.page_times() == [T0, resumed]
    rig.cycle_at(resumed + INTERVAL)
    assert rig.page_times() == [T0, resumed, resumed + INTERVAL]


def test_t18_one_bots_acknowledgement_does_not_quiet_another(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    open_now(rig, T0, host="hostb", bot="bot-two")
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two"]
    rig.clock.set(T0 + 600)
    rig.acknowledge("hosta|bot-one")
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times("hosta/bot-one") == [T0]
    assert rig.page_times("hostb/bot-two") == [T0, T0 + INTERVAL]


def check_t19_the_page_goes_out_and_says_the_file_is_unreadable(rig: Rig) -> None:
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]
    second = rig.page_texts()[-1]
    assert (PAGE_DEAD in second, PAGE_ACK_UNREADABLE in second, "page 2" in second) == (True, True, True)
    assert sorted(set(rig.logged("ackUnreadable"))) == [True]


def test_t19_a_malformed_acknowledge_file_is_no_acknowledgement(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    rig.acknowledge("hosta|bot-one", raw="{ this is not JSON")
    check_t19_the_page_goes_out_and_says_the_file_is_unreadable(rig)


def test_t19_an_unreadable_acknowledge_file_is_no_acknowledgement(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    # A directory in the file's place: a read fails for every user, the superuser included.
    (rig.root / ACK_FILE).mkdir()
    check_t19_the_page_goes_out_and_says_the_file_is_unreadable(rig)


def test_t19_a_boolean_time_is_no_acknowledgement(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    rig.acknowledge("hosta|bot-one", raw={"ackedAt": True, "by": "operator"})
    check_t19_the_page_goes_out_and_says_the_file_is_unreadable(rig)


def test_t19_a_time_in_the_future_is_no_acknowledgement(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    rig.acknowledge("hosta|bot-one", at=T0 + INTERVAL + HOUR)
    check_t19_the_page_goes_out_and_says_the_file_is_unreadable(rig)


def test_t61_an_acknowledgement_holds_although_the_events_clock_runs_ahead(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    # The emitter's clock is ten minutes ahead of the dispatcher's.
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 600))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # Written one minute after the condition opened, by the dispatcher host's clock.
    rig.clock.set(T0 + 60)
    rig.acknowledge("hosta|bot-one")
    rig.cycle_at(T0 + INTERVAL)
    rig.cycle_at(T0 + INTERVAL + 600)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0]


def test_t61_an_acknowledgement_of_an_earlier_condition_does_not_hold_for_a_delayed_opener(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + 1800)
    rig.acknowledge("hosta|bot-one")
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.cleared("hosta|bot-one") == [MANUAL]
    assert rig.open_scopes() == []
    # An opener of another source, created before that acknowledgement and relayed after the
    # condition was deleted. Its event time is older than the acknowledgement; the time the
    # dispatcher opened it is not.
    relayed = T0 + 2 * HOUR
    rig.clock.set(relayed)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 600))
    assert rig.cycle() is None
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(T0 + 600)
    assert rig.page_times() == [T0, relayed]


# ---------------------------------------------------------------------------
# Closing.
# ---------------------------------------------------------------------------


def cleared_and_dead_again(rig: Rig, gap: int) -> int:
    """The opener clears an hour after T0 and reports a new death `gap` seconds later. Returns that time."""
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    if gap > GRACE:
        rig.cycle_at(cleared_at + GRACE)
    again = cleared_at + gap
    rig.clock.set(again)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", again))
    rig.cycle()
    return again


def test_t21_a_new_death_nine_minutes_after_the_clear_is_the_same_episode(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    cleared_and_dead_again(rig, 540)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(T0)
    # No immediate page: the floor of the first page is kept, and the next page is the second.
    assert rig.page_times() == [T0]
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_texts() == [page_line("hosta/bot-one", 0, 1), page_line("hosta/bot-one", 4, 2)]


def test_t21_an_earlier_acknowledgement_still_holds_for_the_same_episode(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + 600)
    rig.acknowledge("hosta|bot-one")
    cleared_and_dead_again(rig, 540)
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(T0)
    rig.cycle_at(T0 + INTERVAL)
    rig.cycle_at(T0 + 2 * INTERVAL)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0]


def test_t22_a_new_death_eleven_minutes_after_the_clear_is_a_new_condition(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + 600)
    rig.acknowledge("hosta|bot-one")
    again = cleared_and_dead_again(rig, 660)
    # It pages at once: the acknowledgement was written before this condition opened.
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(again)
    assert rig.page_times() == [T0, again]
    assert rig.page_texts()[-1] == page_line("hosta/bot-one", 0, 1)


def test_t23_a_stale_auto_close_of_the_incident_record_does_not_end_the_condition(make_rig):
    # The stale sweep closes a quiet incident record after 24 h only for a source it holds
    # to be not actionable; the setting below makes the opener's source one.
    rig = make_rig(env={"BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES": MANUAL})
    open_now(rig, T0)
    assert rig.open_incident_sources() == [MANUAL]
    assert rig.page_times() == [T0]
    for step in range(1, 7):
        rig.cycle_at(T0 + step * INTERVAL)
    rig.cycle_at(T0 + DAY + 60)
    # The record is closed; the member and the condition are not.
    assert rig.open_incident_sources() == []
    assert rig.members("hosta|bot-one") == [MANUAL]
    rig.cycle_at(T0 + 7 * INTERVAL)
    assert rig.page_times() == every_four_hours(T0, 8)


def test_t25_a_clear_from_the_real_emitter_on_another_host_removes_its_member(make_rig):
    # The emitter stamps the real clock and writes its own host's name, so this case runs at
    # the real time and never reads that name. The whole sequence runs before the first assertion
    # about the class, so that on the unchanged code the case fails with the emitter's clear
    # already processed.
    now = int(real_time.time())
    rig = make_rig(fleet=ROSTER_ONE, start=now - 120)
    opener_at = now - 120
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", opener_at))
    rig.cycle()
    class_state_after_the_opener = (rig.members("hosta|bot-one"), rig.page_times())
    clear = emit_clear_with_the_real_emitter(rig, "bot-one", DEAD)
    cleared_at = calendar.timegm(real_time.strptime(clear["createdAt"], "%Y-%m-%dT%H:%M:%SZ"))
    rig.clock.set(cleared_at + 5)
    raised = rig.cycle()
    processed = rig.disposition(str(clear["id"]))
    class_state_after_the_clear = (rig.members("hosta|bot-one"), rig.cleared("hosta|bot-one"), rig.open_scopes())
    rig.cycle_at(cleared_at + GRACE)
    class_state_after_the_grace = rig.open_scopes()
    rig.cycle_at(opener_at + INTERVAL)

    # The emitter's clear was a real event to the dispatcher: read and archived.
    assert raised is None
    assert processed in (["sent"], ["suppressed"])
    assert class_state_after_the_opener == ([DEAD], [opener_at])
    # The bot's name is on one roster host, so the clear found its member whatever host wrote it.
    assert class_state_after_the_clear == ([], [DEAD], ["hosta|bot-one"])
    assert class_state_after_the_grace == []
    assert rig.page_times() == [opener_at]


def no_fallback(at: float) -> dict[str, Any]:
    return runtime_event(NO_FALLBACK, "bot-one", at, relay_host="hosta.example", severity="critical")


def test_t73_no_fallback_alone_opens_nothing_and_opens_when_the_runtime_signal_arrives(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    alone = rig.put(no_fallback(T0))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [NO_FALLBACK]
    assert rig.phase("hosta|bot-one") == "latent"
    group = rig.group_for(alone)
    assert len(group) == 1
    assert action_sentence(group[0]) == HUMAN_ACTION
    rig.cycle_at(T0 + HOUR)
    assert rig.phase("hosta|bot-one") == "latent"
    assert rig.pages() == []
    opened = T0 + HOUR + 60
    rig.clock.set(opened)
    rig.put(runtime_event(PRIMARY, "bot-one", opened, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [opened]


def test_t73_the_reverse_order_opens_the_same_way(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "latent"
    opened = T0 + HOUR + 60
    rig.clock.set(opened)
    rig.put(no_fallback(opened))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [opened]


def test_t73_the_runtime_clear_removes_both_and_a_late_copy_does_not_come_back(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    rig.put(no_fallback(T0))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == sorted([NO_FALLBACK, PRIMARY])
    assert rig.page_times() == [T0]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(runtime_event(PRIMARY, "bot-one", cleared_at, relay_host="hosta.example", clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cleared("hosta|bot-one") == sorted([NO_FALLBACK, PRIMARY])
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    # A copy of the no-fallback alert, created before the clear, is read after it.
    rig.clock.set(cleared_at + GRACE + 60)
    rig.put(no_fallback(cleared_at - 60))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cleared("hosta|bot-one") == sorted([NO_FALLBACK, PRIMARY])
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0]


# ---------------------------------------------------------------------------
# Wording, promotion and the member list.
# ---------------------------------------------------------------------------

# Words a sentence of this class must not hold: it names no provider, and a re-login is not its action.
PROVIDER_WORDS = ("claude", "anthropic", "codex", "openai", "gemini", "re-login", "relogin")


def provider_words_in(text: str) -> list[str]:
    return [word for word in PROVIDER_WORDS if word in text.lower()]


def action_sentence(group_text: str) -> str:
    """The action sentence of a group text: what follows `requested_action:` on its one line."""
    found = [line.split("requested_action:", 1)[1].strip() for line in group_text.splitlines()
             if "requested_action:" in line]
    return found[0] if len(found) == 1 else ""


def test_t26_every_opener_source_asks_for_a_human_and_never_for_q(make_rig):
    rig = make_rig(fleet=ROSTER_NINE)
    rig.clock.set(T0)
    events = {
        DEAD: watchdog_event(DEAD, "hosta", "bot-1", T0),
        MANUAL: observer_event(MANUAL, "hosta", "bot-2", T0),
        UNUSABLE_30: observer_event(UNUSABLE_30, "hosta", "bot-3", T0),
        MISMATCH_OVER_30: observer_event(MISMATCH_OVER_30, "hosta", "bot-4", T0),
        NO_FALLBACK: runtime_event(NO_FALLBACK, "bot-5", T0, relay_host="hosta.example", severity="critical"),
    }
    ids = {source: rig.put(event) for source, event in events.items()}
    assert rig.cycle() is None
    # The action sentence of each group text, read from its own line and not from the event's evidence.
    sentences = {source: [action_sentence(text) for text in rig.group_for(event_id)]
                 for source, event_id in ids.items()}
    assert sentences == {source: [HUMAN_ACTION] for source in events}
    # The two that open at once are paged: the direct message and the e-mail body.
    assert sorted(rig.page_texts()) == [page_line("hosta/bot-1", 0, 1), page_line("hosta/bot-2", 0, 1)]
    written = rig.page_texts() + [mail["body"] for mail in rig.page_emails()]
    assert len(written) == 4
    assert [("human action required" in text.lower(), Q_INVESTIGATE in text) for text in written] == [
        (True, False)] * 4
    assert [provider_words_in(text) for text in written] == [[]] * 4
    assert [provider_words_in(sentence) for found in sentences.values() for sentence in found] == [[]] * 5


def test_t26_the_copy_of_a_routed_opener_carries_the_human_sentence_in_its_e_mail(make_rig):
    rig = make_rig()
    class_pages_fail(rig)
    rig.clock.set(T0)
    opener = rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # The page was refused, so the opener's own copy went out; its e-mail holds the group text.
    mails = rig.copy_emails(f"event: {opener}")
    assert len(mails) == 1
    assert (HUMAN_ACTION in mails[0]["body"], Q_INVESTIGATE in mails[0]["body"]) == (True, False)


def test_t26_pin_a_non_member_critical_event_keeps_todays_sentence(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    other = rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    group = rig.group_for(other)
    assert len(group) == 1
    assert action_sentence(group[0]) == rig.d.INVESTIGATE_ACTION
    mails = rig.copy_emails(f"event: {other}")
    assert len(mails) == 1
    assert (Q_INVESTIGATE in mails[0]["body"], HUMAN_ACTION in mails[0]["body"]) == (True, False)


def storm_of(rig: Rig, source: str) -> list[str]:
    """Three hosts report `source` inside the storm window. Returns the digests the group was sent.

    Today's behaviour, read from bot-errors-dispatcher.py at commit 0b2506a5: three hosts
    of one fingerprint inside 120 s collapse (storm_threshold and storm_window_seconds, :6735-6740;
    collapse_ready_storms, :8398), and the digest's summary is "BOT ERRORS storm collapse: <n> hosts
    - <summary>" (storm_digest_event, :7690). The digest holds the outbox path (:7692), so it is
    sent only when the rig's state root passes the test-leak check (:9908).
    """
    rig.clock.set(T0 + 30)
    for index, (host, bot) in enumerate(THREE_BOTS):
        at = T0 + 10 * index
        rig.put(observer_event(source, host, bot, at) if source == MANUAL else plain_event(source, host, bot, at))
    rig.cycle()
    return rig.group_texts("storm collapse: 3 hosts")


def test_t79_a_digest_of_an_opener_source_storm_asks_for_a_human(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    digests = storm_of(rig, MANUAL)
    assert len(digests) == 1
    assert action_sentence(digests[0]) == HUMAN_ACTION_DIGEST
    assert Q_INVESTIGATE not in digests[0]


def test_t79_pin_a_digest_of_a_non_member_storm_keeps_todays_sentence(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    digests = storm_of(rig, OTHER_CRITICAL)
    assert len(digests) == 1
    # Today's sentence, read from the code at commit 0b2506a5: a critical digest with no operator
    # action gets INVESTIGATE_ACTION (requested_action_text, bot-errors-dispatcher.py:4026-4047),
    # printed on the "  > requested_action: " line (:4246).
    assert action_sentence(digests[0]) == rig.d.INVESTIGATE_ACTION
    assert HUMAN_ACTION_DIGEST not in digests[0]


def test_t27_the_thirty_minute_opener_is_pending_at_29_minutes_and_opens_at_30(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    rig.cycle_at(T0 + PROMOTION - 60)
    assert rig.phase("hosta|bot-one") == "pending"
    assert rig.entry("hosta|bot-one").get("pendingSince") == micros(T0)
    assert rig.pages() == []
    rig.cycle_at(T0 + PROMOTION)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0 + PROMOTION]


def test_t27_a_flap_never_opens_the_condition(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.entry("hosta|bot-one").get("pendingSince") == micros(T0)
    # Cleared at 15 minutes; the grace ends at 25; alert again at 26, cleared again at 41.
    for minute, clear in ((15, True), (26, False), (41, True)):
        at = T0 + 60 * minute
        if minute == 26:
            rig.cycle_at(T0 + 25 * 60)
        rig.clock.set(at)
        rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", at, clear=clear))
        rig.cycle()
        if minute == 26:
            # A new pending entry: the first alert's clock did not carry over.
            assert rig.entry("hosta|bot-one").get("pendingSince") == micros(at)
            rig.cycle_at(T0 + PROMOTION)
            assert rig.phase("hosta|bot-one") == "pending"
    for minute in (51, 56, 90):
        rig.cycle_at(T0 + 60 * minute)
    assert rig.cleared("hosta|bot-one") == [UNUSABLE_30]
    assert rig.open_scopes() == []
    assert rig.pages() == []


def test_t28_the_manual_diagnosis_opens_at_once(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(T0)
    assert rig.page_times() == [T0]


def test_t28_a_sustain_only_source_alone_is_latent_and_opens_nothing(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(INDETERMINATE, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [INDETERMINATE]
    assert rig.phase("hosta|bot-one") == "latent"
    rig.cycle_at(T0 + PROMOTION)
    rig.cycle_at(T0 + 5 * HOUR)
    assert rig.phase("hosta|bot-one") == "latent"
    assert rig.pages() == []


# Every setting of the dispatcher that names sources or switches a feature, and every number it
# parses with a fallback, set to an empty or malformed value. A number parsed by
# `positive_env_int` is left alone: an empty or malformed value there stops the dispatcher at
# import, on the unchanged code as well. The settings that say where the state, the outbox and
# the roster are keep the values the rig gives them.
T30_SETTINGS = {
    "BOT_ERRORS_OWNER_ROUTE_SOURCES": "",
    "BOT_ERRORS_TRANSIENT_SOURCES": "",
    "BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES": "",
    "BOT_ERRORS_CONVERSATION_SCOPED_SOURCES": "",
    "BOT_ERRORS_INHIBITION_MAP": "",
    "BOT_ERRORS_SUPPRESS_STALE_INFO_RENOTIFY": "",
    "BOT_ERRORS_SUPPRESS_OPEN_NONACTIONABLE_RENOTIFY": "",
    "BOT_ERRORS_AUTOCLOSE_LIVENESS_GATE": "",
    "BOT_ERRORS_FLAP_DETECTION": "",
    "BOT_ERRORS_INHIBITION_ENABLED": "",
    "BOT_ERRORS_MAINTENANCE_WINDOWS": "",
    "BOT_ERRORS_TRANSIENT_TIERING": "",
    "BOT_ERRORS_RELAY_FLAP_COALESCE": "",
    "BOT_ERRORS_STORM_THRESHOLD": "many",
    "BOT_ERRORS_STORM_WINDOW_SECONDS": "long",
    "BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS": "long",
    "BOT_ERRORS_SUPPRESSED_MAX_FILES": "many",
    "BOT_ERRORS_TEST_PROVENANCE_META_WINDOW_SECONDS": "long",
    "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS": "long",
    "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_MAX_PENDING": "many",
    "BOT_ERRORS_OWNER_ROUTE_BUDGET_SECONDS": "soon",
}


def test_t30_no_setting_narrows_the_member_list(make_rig):
    # The roster variable names a path that does not exist: an empty value would count as unset.
    rig = make_rig(fleet=UNREADABLE, env=T30_SETTINGS)
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0))
    rig.put(probe_event("hosta", "bot-one", T0))
    rig.put(observer_event(MANUAL, "hostb", "bot-two", T0))
    rig.put(observer_event(INDETERMINATE, "hostb", "bot-two", T0))
    rig.put(observer_event(UNUSABLE_30, "hostc", "bot-three", T0))
    rig.put(runtime_event(PRIMARY, "bot-three", T0, relay_host="hostc"))
    assert rig.cycle() is None
    assert {scope: rig.members(scope) for scope in sorted(rig.conditions())} == {
        "hosta|bot-one": sorted([DEAD, probe_source("hosta", "bot-one")]),
        "hostb|bot-two": sorted([INDETERMINATE, MANUAL]),
        "hostc|bot-three": sorted([PRIMARY, UNUSABLE_30]),
    }
    assert [rig.phase(scope) for scope in sorted(rig.conditions())] == ["open", "open", "pending"]
    assert sorted(rig.page_texts()) == [page_line("hosta/bot-one", 0, 1), page_line("hostb/bot-two", 0, 1)]
    rig.cycle_at(T0 + PROMOTION)
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two", "hostc|bot-three"]


def test_t32_a_bot_on_another_provider_opens_a_condition_and_the_class_names_no_provider(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    event = observer_event(MANUAL, "hostb", "bot-two", T0)
    event["evidence"]["provider"] = "another-provider"
    opener = rig.put(event)
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hostb|bot-two"]
    assert rig.page_texts() == [page_line("hostb/bot-two", 0, 1)]
    group = rig.group_for(opener)
    mails = rig.page_emails()
    assert (len(group), len(mails)) == (1, 1)
    assert action_sentence(group[0]) == HUMAN_ACTION
    sentences = [rig.page_texts()[0], mails[0]["subject"], mails[0]["body"], action_sentence(group[0])]
    assert [provider_words_in(sentence) for sentence in sentences] == [[], [], [], []]


def test_t32_pin_a_fleet_probe_event_for_it_sends_its_alert_and_opens_nothing(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    probe = rig.put(probe_event("hostb", "bot-two", T0))
    assert rig.cycle() is None
    group = rig.group_for(probe)
    assert len(group) == 1
    assert action_sentence(group[0]) == rig.d.INVESTIGATE_ACTION
    assert copy_heads(rig) == ["hostb/bot-two: primary model check failed"]
    assert rig.open_scopes() == []
    assert rig.pages() == []


def test_t32_pin_a_non_member_diagnosis_for_it_sends_its_alert_and_opens_nothing(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    warning = rig.put(observer_event(NON_MEMBER, "hostb", "bot-two", T0))
    assert rig.cycle() is None
    group = rig.group_for(warning)
    assert len(group) == 1
    assert action_sentence(group[0]) == rig.d.INVESTIGATE_ACTION
    assert rig.conditions() == {}
    assert (rig.owner, rig.emails) == ([], [])


def held_by_a_sustain(rig: Rig) -> None:
    """Opened by the manual diagnosis at T0; an hour later the re-auth observer moves to a blind one."""
    open_now(rig, T0)
    moved_at = T0 + HOUR
    rig.clock.set(moved_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", moved_at, clear=True))
    rig.put(observer_event(INDETERMINATE, "hosta", "bot-one", moved_at))
    rig.cycle()


def test_t34_a_sustain_held_condition_pages_with_the_unverified_line_until_the_sustain_clears(make_rig):
    rig = make_rig()
    held_by_a_sustain(rig)
    assert rig.members("hosta|bot-one") == [INDETERMINATE]
    for step in (1, 2):
        rig.cycle_at(T0 + step * INTERVAL)
    assert rig.page_times() == every_four_hours(T0, 3)
    assert rig.page_texts()[0] == page_line("hosta/bot-one", 0, 1)
    later = rig.page_texts()[1:]
    assert [(PAGE_UNVERIFIED in text, PAGE_STILL_UNUSABLE in text, PAGE_DEAD in text) for text in later] == [
        (True, True, False)] * 2
    assert ["the re-auth observer now reports indeterminate_investigate" in text for text in later] == [True, True]
    assert [f"page {number}" in text for number, text in zip((2, 3), later)] == [True, True]
    # The sustain's clear ends it, after the grace.
    cleared_at = T0 + 9 * HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(INDETERMINATE, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE)
    assert rig.open_scopes() == []
    rig.cycle_at(T0 + 3 * INTERVAL)
    assert rig.page_times() == every_four_hours(T0, 3)


def test_t34_an_acknowledgement_quiets_a_sustain_held_condition(make_rig):
    rig = make_rig()
    held_by_a_sustain(rig)
    assert rig.page_times() == [T0]
    rig.clock.set(T0 + 2 * HOUR)
    rig.acknowledge("hosta|bot-one")
    for step in (1, 2):
        rig.cycle_at(T0 + step * INTERVAL)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.members("hosta|bot-one") == [INDETERMINATE]
    assert rig.page_times() == [T0]


def test_t35_latent_then_pending_then_open_on_one_scope(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example"))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "latent"
    assert page_fields_set(rig.entry("hosta|bot-one")) == []
    pending = T0 + 12 * 60
    rig.clock.set(pending)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", pending))
    assert rig.cycle() is None
    rig.cycle_at(pending + PROMOTION - 60)
    assert rig.phase("hosta|bot-one") == "pending"
    assert rig.entry("hosta|bot-one").get("pendingSince") == micros(pending)
    assert page_fields_set(rig.entry("hosta|bot-one")) == []
    assert rig.pages() == []
    rig.cycle_at(pending + PROMOTION)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [pending + PROMOTION]


def test_t35_an_acknowledgement_written_while_pending_does_not_hold_once_the_condition_opens(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "pending"
    rig.clock.set(T0 + 600)
    rig.acknowledge("hosta|bot-one")
    rig.cycle_at(T0 + PROMOTION)
    assert rig.page_times() == [T0 + PROMOTION]


def test_t36_pin_with_only_latent_entries_the_cycle_is_todays(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    ids = [
        rig.put(runtime_event(PRIMARY, "bot-one", T0, relay_host="hosta.example")),
        rig.put(observer_event(INDETERMINATE, "hosta", "bot-one", T0)),
        rig.put(probe_event("hosta", "bot-one", T0)),
    ]
    assert rig.cycle() is None
    # Three group alerts, each with today's sentence.
    assert len(rig.group) == 3
    assert [[action_sentence(text) for text in rig.group_for(event_id)] for event_id in ids] == [
        [rig.d.INVESTIGATE_ACTION]] * 3
    # One owner copy, the fleet probe's, saying what it says today.
    assert copy_heads(rig) == ["hosta/bot-one: primary model check failed"]
    assert [(Q_INVESTIGATE in mail["body"], HUMAN_ACTION in mail["body"]) for mail in rig.emails] == [(True, False)]
    assert rig.pages() == []
    assert rig.open_scopes() == []
    # The dispatch log holds today's record types and none of the class's. Read from the code at
    # commit 0b2506a5, one line per type:
    #   cycle_started, cycle_completed   lib/controller_log.py:608, :632 (every cycle)
    #   recovery_dedupe_barrier          bot-errors-dispatcher.py:8683: suppress_ready_recovery_duplicates
    #                                    writes one for each ready incident alert (:7617-7618)
    #   sent                             bot-errors-dispatcher.py:10373 (each group alert)
    #   owner_route_sent                 lib/owner_route.py:280 (the fleet probe's owner copy)
    assert sorted({str(record.get("type")) for record in rig.log()}) == [
        "cycle_completed", "cycle_started", "owner_route_sent", "recovery_dedupe_barrier", "sent"]


def test_t43_a_mismatch_over_the_thirty_minute_diagnosis_is_pending_at_once_and_opens_at_30(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(MISMATCH_OVER_30, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.phase("hosta|bot-one") == "pending"
    assert rig.entry("hosta|bot-one").get("pendingSince") == micros(T0)
    rig.cycle_at(T0 + PROMOTION - 60)
    assert rig.pages() == []
    rig.cycle_at(T0 + PROMOTION)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0 + PROMOTION]


def test_t44_a_mismatch_over_a_blind_diagnosis_alone_is_latent_and_opens_nothing(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(MISMATCH_OVER_SUSTAIN, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [MISMATCH_OVER_SUSTAIN]
    assert rig.phase("hosta|bot-one") == "latent"
    rig.cycle_at(T0 + PROMOTION)
    rig.cycle_at(T0 + 5 * HOUR)
    assert rig.phase("hosta|bot-one") == "latent"
    assert rig.pages() == []


def test_t44_a_mismatch_over_a_blind_diagnosis_keeps_an_opened_condition_paging(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    moved_at = T0 + HOUR
    rig.clock.set(moved_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", moved_at, clear=True))
    rig.put(observer_event(MISMATCH_OVER_SUSTAIN, "hosta", "bot-one", moved_at))
    rig.cycle()
    assert rig.members("hosta|bot-one") == [MISMATCH_OVER_SUSTAIN]
    rig.cycle_at(moved_at + GRACE)
    assert rig.phase("hosta|bot-one") == "open"
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert PAGE_UNVERIFIED in rig.page_texts()[-1]


def test_t74_a_mismatch_over_a_non_member_diagnosis_does_not_hold_the_condition(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.clock.set(T0 + 60)
    mismatch = rig.put(observer_event(MISMATCH_OVER_NON_MEMBER, "hosta", "bot-one", T0 + 60))
    assert rig.cycle() is None
    # First: the condition is open and paged with its opener present, and the mismatch's own
    # group alert went out.
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0]
    assert len(rig.group_for(mismatch)) == 1
    assert rig.members("hosta|bot-one") == [MANUAL]
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    rig.cycle_at(cleared_at + GRACE - 1)
    assert rig.phase("hosta|bot-one") == "open"
    rig.cycle_at(cleared_at + GRACE)
    # The mismatch incident is still open; the condition has ended.
    assert rig.open_incident_sources() == [MISMATCH_OVER_NON_MEMBER]
    assert rig.open_scopes() == []
    rig.cycle_at(T0 + INTERVAL)
    assert rig.page_times() == [T0]


def test_t45_a_change_to_the_mismatch_keeps_the_thirty_minute_clock_running(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    changed = T0 + 20 * 60
    rig.clock.set(changed)
    rig.put(observer_event(UNUSABLE_30, "hosta", "bot-one", changed, clear=True))
    rig.put(observer_event(MISMATCH_OVER_30, "hosta", "bot-one", changed))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [MISMATCH_OVER_30]
    assert rig.entry("hosta|bot-one").get("pendingSince") == micros(T0)
    rig.cycle_at(T0 + PROMOTION - 60)
    assert rig.phase("hosta|bot-one") == "pending"
    # Minute 30, not minute 50.
    rig.cycle_at(T0 + PROMOTION)
    assert rig.page_times() == [T0 + PROMOTION]
    # The clear names the mismatch source by its full string, and removes it.
    cleared_at = T0 + HOUR
    rig.clock.set(cleared_at)
    rig.put(observer_event(MISMATCH_OVER_30, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    assert rig.members("hosta|bot-one") == []
    assert rig.cleared("hosta|bot-one") == sorted([MISMATCH_OVER_30, UNUSABLE_30])


# ---------------------------------------------------------------------------
# Stored state: a malformed entry is never dropped silently.
# ---------------------------------------------------------------------------

LOST = "lost-marker"


def change_entry(rig: Rig, scope: str, change: Callable[[dict[str, Any]], None]) -> None:
    """Change one stored condition between two cycles. Does nothing when the entry is not there."""

    def apply(payload: dict[str, Any]) -> None:
        section = payload.get(SECTION)
        if isinstance(section, dict) and isinstance(section.get(scope), dict):
            change(section[scope])

    rig.edit_state(apply)


def member_of_the_wrong_type(entry: dict[str, Any]) -> None:
    if isinstance(entry.get("members"), dict):
        for source in list(entry["members"]):
            entry["members"][source] = LOST


def members_not_a_mapping(entry: dict[str, Any]) -> None:
    entry["members"] = [LOST]


def a_bad_time(entry: dict[str, Any]) -> None:
    if isinstance(entry.get("members"), dict):
        for record in entry["members"].values():
            if isinstance(record, dict):
                record["lastSeenAt"] = LOST


def corrupt_every_entry(rig: Rig) -> None:
    def apply(payload: dict[str, Any]) -> None:
        section = payload.get(SECTION)
        if isinstance(section, dict):
            for entry in section.values():
                if isinstance(entry, dict):
                    member_of_the_wrong_type(entry)

    rig.edit_state(apply)


def quarantined(rig: Rig) -> list[Any]:
    held = rig.state().get(QUARANTINE)
    return held if isinstance(held, list) else []


def longest_text(value: Any) -> int:
    """The length of the longest text anywhere inside a stored value."""
    if isinstance(value, str):
        return len(value)
    if isinstance(value, dict):
        return max([longest_text(item) for item in value.values()] or [0])
    if isinstance(value, list):
        return max([longest_text(item) for item in value] or [0])
    return 0


def announcements(rig: Rig) -> tuple[int, int]:
    """How often a loss was announced: group meta-alerts, and state-lost pages to the owner."""
    return len(rig.meta_alerts(META_STATE_LOST)), len(rig.loss_pages())


def test_t31_pin_a_state_file_without_the_section_loads_and_the_cycle_completes(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    rig.edit_state(lambda payload: payload.pop(SECTION, None))
    rig.clock.set(T0 + 60)
    second = rig.put(plain_event(OTHER_CRITICAL, "hostb", "bot-two", T0 + 60))
    assert rig.cycle() is None
    assert ("stamp", "") in last_cycle(rig)
    assert len(rig.group_for(second)) == 1


def check_t41_a_corrupted_entry_is_rebuilt_and_paged(rig: Rig, change: Callable[[dict[str, Any]], None]) -> None:
    open_now(rig, T0)
    open_now(rig, T0, host="hostb", bot="bot-two")
    rig.cycle_at(T0 + 60)
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two"]
    assert rig.page_times("hosta/bot-one") == [T0]
    untouched = rig.entry("hostb|bot-two")
    change_entry(rig, "hosta|bot-one", change)
    # No further event.
    assert rig.cycle_at(T0 + 120) is None
    # Rebuilt from its open incident, with no page fields: its page is due at once.
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.page_times("hosta/bot-one") == [T0, T0 + 120]
    assert rig.entry("hostb|bot-two") == untouched
    held = quarantined(rig)
    assert len(held) == 1
    assert LOST in json.dumps(held)


def test_t41_a_member_of_the_wrong_type_is_quarantined_and_the_condition_rebuilt(make_rig):
    rig = make_rig()
    check_t41_a_corrupted_entry_is_rebuilt_and_paged(rig, member_of_the_wrong_type)
    assert rig.phase("hosta|bot-one") == "open"


def test_t41_members_that_are_not_a_mapping_are_quarantined_and_the_condition_rebuilt(make_rig):
    rig = make_rig()
    check_t41_a_corrupted_entry_is_rebuilt_and_paged(rig, members_not_a_mapping)
    assert rig.phase("hosta|bot-one") == "open"


def test_t41_a_bad_time_is_quarantined_and_the_condition_rebuilt(make_rig):
    rig = make_rig()
    check_t41_a_corrupted_entry_is_rebuilt_and_paged(rig, a_bad_time)
    assert rig.phase("hosta|bot-one") == "open"


def test_t42_a_lost_section_is_rebuilt_and_announced_once_and_not_again_for_24_hours(make_rig):
    # The stale sweep closes the quiet incident record of the watchdog's source after 24 h
    # (the setting makes that source one the sweep holds to be not actionable).
    rig = make_rig(env={"BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES": DEAD})
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hostb", "bot-two", T0))
    rig.cycle()
    for step in range(1, 7):
        rig.cycle_at(T0 + step * INTERVAL)
    later = T0 + DAY + 60
    rig.cycle_at(later)
    assert rig.open_incident_sources() == []
    assert rig.open_scopes() == ["hostb|bot-two"]
    # A second condition, whose incident is open.
    open_now(rig, later + 60)
    rig.cycle_at(later + 120)
    assert rig.open_scopes() == ["hosta|bot-one", "hostb|bot-two"]
    assert rig.open_incident_sources() == [MANUAL]

    # The whole section is lost.
    rig.edit_state(lambda payload: payload.update({SECTION: LOST + " " + "x" * 6000}))
    lost_at = later + 180
    mark = len(rig.owner)
    assert rig.cycle_at(lost_at) is None
    # The condition with an open incident is rebuilt; the other cannot be.
    assert sorted(rig.conditions()) == ["hosta|bot-one"]
    assert rig.members("hosta|bot-one") == [MANUAL]
    # One state-lost page, before the rebuilt condition's page, and one group meta-alert.
    sent = [send["text"] for send in rig.owner[mark:]]
    assert [is_loss_page(text) for text in sent] == [True, False]
    assert sent[0].endswith("1 rebuilt from open incidents — human action required: "
                            "check the fleet's credential state")
    assert sent[1:] == [page_line("hosta/bot-one", 0, 1)]
    assert announcements(rig) == (1, 1)
    held = quarantined(rig)
    assert len(held) == 1
    assert LOST in json.dumps(held)
    assert longest_text(held) <= 4096
    # Neither announcement is sent again in the following 24 h.
    for step in range(1, 7):
        rig.cycle_at(lost_at + step * INTERVAL)
    assert announcements(rig) == (1, 1)
    assert len(rig.pages("hosta/bot-one")) == 8


def test_t42_the_state_lost_page_uses_the_class_budget_goes_first_and_is_retried(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.cycle_at(T0 + 60)
    assert rig.page_times() == [T0]
    rig.edit_state(lambda payload: payload.update({SECTION: [LOST]}))
    rig.owner_rule = lambda text: "timeout" if is_loss_page(text) else "ok"
    rig.email_rule = lambda subject, body: "timeout" if is_loss_page(subject) else "ok"
    lost_at = T0 + 120
    mark = len(rig.owner)
    assert rig.cycle_at(lost_at) is None
    # The state-lost page went first and used the class's 20 s: 8 s, then the 12 s left for its e-mail.
    assert [(is_loss_page(send["text"]), send["timeout"]) for send in rig.owner[mark:]] == [(True, 8)]
    assert [mail["timeout"] for mail in rig.emails if is_loss_page(mail["subject"])] == [12]
    # So the rebuilt condition's page was listed and did not start.
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.page_times() == [T0]
    # The refused page is retried, again before the condition's page, and then sent once.
    sends_work(rig)
    mark = len(rig.owner)
    rig.cycle_at(lost_at + 60)
    sent = [send["text"] for send in rig.owner[mark:]]
    assert [is_loss_page(text) for text in sent] == [True, False]
    assert sent[1:] == [page_line("hosta/bot-one", 0, 1)]
    rig.cycle_at(lost_at + 120)
    rig.cycle_at(lost_at + 180)
    assert len(rig.loss_pages()) == 2
    assert len(rig.meta_alerts(META_STATE_LOST)) == 1


def test_t88_a_loss_repeated_before_each_of_ten_cycles_is_paged_and_announced_once(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.cycle_at(T0 + 60)
    assert rig.page_times() == [T0]
    first_loss = T0 + 120
    for cycle in range(10):
        corrupt_every_entry(rig)
        assert rig.cycle_at(first_loss + 60 * cycle) is None
    assert rig.members("hosta|bot-one") == [MANUAL]
    assert rig.page_times() == [T0, first_loss]
    assert announcements(rig) == (1, 1)
    assert 1 <= len(quarantined(rig)) <= 5


def test_t88_nine_scopes_lost_before_each_of_ten_cycles_are_each_paged_once(make_rig):
    rig = make_rig(fleet=ROSTER_NINE)
    for bot in NINE_BOTS:
        open_now(rig, T0, bot=bot)
    rig.cycle_at(T0 + 60)
    assert len(rig.page_times()) == 9
    first_loss = T0 + 120
    for cycle in range(10):
        corrupt_every_entry(rig)
        assert rig.cycle_at(first_loss + 60 * cycle) is None
    assert rig.open_scopes() == sorted(f"hosta|{bot}" for bot in NINE_BOTS)
    # Nine pages for the rebuilt conditions, one per scope, however often each was lost.
    assert sorted(send["text"] for send in rig.pages() if send["at"] >= first_loss) == sorted(
        page_line(f"hosta/{bot}", 0, 1) for bot in NINE_BOTS)
    assert announcements(rig) == (1, 1)
    assert 1 <= len(quarantined(rig)) <= 5


def test_t88_a_loss_inside_the_interval_of_an_announcement_is_announced_when_it_ends(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    open_now(rig, T0, host="hostb", bot="bot-two")
    rig.cycle_at(T0 + 60)
    first_loss = T0 + 120
    change_entry(rig, "hosta|bot-one", member_of_the_wrong_type)
    rig.cycle_at(first_loss)
    rig.cycle_at(first_loss + 60)
    assert announcements(rig) == (1, 1)
    # A second scope is lost inside the interval: rebuilt and paged, and not announced yet.
    second_loss = first_loss + HOUR
    change_entry(rig, "hostb|bot-two", member_of_the_wrong_type)
    assert rig.cycle_at(second_loss) is None
    assert rig.page_times("hostb/bot-two") == [T0, second_loss]
    rig.cycle_at(first_loss + INTERVAL - 60)
    assert announcements(rig) == (1, 1)
    # The first cycle after the interval ends announces it; the cycle after that does not.
    rig.cycle_at(first_loss + INTERVAL)
    assert announcements(rig) == (2, 2)
    rig.cycle_at(first_loss + INTERVAL + 60)
    assert announcements(rig) == (2, 2)


def test_t88_a_rebuilt_conditions_refused_page_is_tried_three_times_across_rebuilds(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    rig.cycle_at(T0 + 60)
    assert rig.page_times() == [T0]
    class_pages_fail(rig)
    first_loss = T0 + 120
    for offset in (0, 60, 120, 180):
        corrupt_every_entry(rig)
        assert rig.cycle_at(first_loss + offset) is None
    # Three consecutive cycles and not a fourth, although each cycle rebuilt the condition anew.
    assert rig.page_times() == [T0, first_loss, first_loss + 60, first_loss + 120]
    corrupt_every_entry(rig)
    rig.cycle_at(first_loss + INTERVAL)
    assert rig.page_times() == [T0, first_loss, first_loss + 60, first_loss + 120]
    # The next attempt is one interval after the third.
    corrupt_every_entry(rig)
    rig.cycle_at(first_loss + 120 + INTERVAL)
    assert rig.page_times() == [T0, first_loss, first_loss + 60, first_loss + 120, first_loss + 120 + INTERVAL]


# ---------------------------------------------------------------------------
# Maintenance windows hold the page, for at most 24 h per condition.
# ---------------------------------------------------------------------------


def test_t50_a_maintenance_window_holds_the_page_and_keeps_the_condition_open(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    # A two-hour window that covers the time the second page is due.
    rig.clock.set(T0 + 3 * HOUR)
    rig.maintenance("hosta|bot-one", T0 + 5 * HOUR)
    rig.cycle_at(T0 + INTERVAL)
    rig.cycle_at(T0 + 5 * HOUR - 30)
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.entry("hosta|bot-one").get("maintenanceHoldStartedAt") == T0 + INTERVAL
    assert rig.page_times() == [T0]
    # The first cycle after the window ends pages, and the interval restarts there.
    rig.cycle_at(T0 + 5 * HOUR)
    assert rig.page_times() == [T0, T0 + 5 * HOUR]
    rig.cycle_at(T0 + 9 * HOUR - 30)
    assert rig.page_times() == [T0, T0 + 5 * HOUR]
    rig.cycle_at(T0 + 9 * HOUR)
    assert rig.page_times() == [T0, T0 + 5 * HOUR, T0 + 9 * HOUR]


def test_t51_windows_opened_one_after_another_hold_the_page_for_24_hours_and_no_longer(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    # Two windows, one after the other, cover T0 + 3 h to T0 + 34 h.
    rig.clock.set(T0 + 3 * HOUR)
    rig.maintenance("hosta|bot-one", T0 + 20 * HOUR)
    for hour in range(4, 34):
        if hour == 19:
            rig.maintenance("hosta|bot-one", T0 + 34 * HOUR)
        rig.cycle_at(T0 + hour * HOUR)
    held_from = T0 + INTERVAL
    assert rig.entry("hosta|bot-one").get("maintenanceHoldStartedAt") == held_from
    # The hold ends 24 h after it started: the page goes out inside the window, and the next 4 h later.
    assert rig.page_times() == [T0, held_from + MAINTENANCE_HOLD, held_from + MAINTENANCE_HOLD + INTERVAL]


# ---------------------------------------------------------------------------
# A page boundary inside the grace of a condition that was already paged.
# ---------------------------------------------------------------------------


def cleared_just_before_the_second_page(rig: Rig) -> int:
    """Open (and so page) at T0, then clear 300 s before the second page is due. Returns the clear's time."""
    open_now(rig, T0)
    cleared_at = T0 + INTERVAL - 300
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", cleared_at, clear=True))
    rig.cycle()
    return cleared_at


def test_t91_no_page_at_a_boundary_inside_the_grace_and_none_after_the_condition_ends(make_rig):
    rig = make_rig()
    cleared_at = cleared_just_before_the_second_page(rig)
    assert rig.page_times() == [T0]
    assert rig.entry("hosta|bot-one").get("emptySince") == micros(cleared_at)
    # The 4 h boundary falls inside the grace. The condition was paged before; it is not paged now.
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.phase("hosta|bot-one") == "open"
    assert rig.page_times() == [T0]
    # The grace runs out: the condition ends, and no page follows.
    rig.cycle_at(cleared_at + GRACE)
    assert rig.phase("hosta|bot-one") == "absent"
    rig.cycle_at(T0 + 2 * INTERVAL)
    assert rig.page_times() == [T0]


def test_t91_a_member_that_returns_inside_the_grace_when_a_page_is_due_is_paged_in_that_cycle(make_rig):
    rig = make_rig()
    cleared_at = cleared_just_before_the_second_page(rig)
    assert rig.entry("hosta|bot-one").get("emptySince") == micros(cleared_at)
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0]
    # A new death 360 s after the clear: the same episode, and the due check applies again in this cycle.
    returned_at = T0 + INTERVAL + 60
    rig.clock.set(returned_at)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", returned_at))
    assert rig.cycle() is None
    assert rig.entry("hosta|bot-one").get("openedAt") == micros(T0)
    assert rig.entry("hosta|bot-one").get("emptySince") is None
    assert rig.page_times() == [T0, returned_at]
    assert rig.page_texts() == [page_line("hosta/bot-one", 0, 1), page_line("hosta/bot-one", 4, 2)]


# ---------------------------------------------------------------------------
# First pages that fall due in the cycle that creates their entries.
# ---------------------------------------------------------------------------


def test_t92_first_pages_due_in_the_cycle_that_creates_their_entries_go_by_scope_key(make_rig):
    rig = make_rig(fleet=ROSTER_THREE)
    rig.clock.set(T0)
    # Read in the reverse order of their scope keys, so the entries are created in that order. None was
    # attempted before: the three tie, and no stored order exists yet that could settle it.
    for host, bot in reversed(THREE_BOTS):
        rig.put(observer_event(MANUAL, host, bot, T0))
    assert rig.cycle() is None
    assert rig.open_scopes() == THREE_SCOPES
    assert [text.split(":")[0] for text in rig.page_texts()] == ["hosta/bot-one", "hostb/bot-two", "hostc/bot-three"]


# ---------------------------------------------------------------------------
# An event id that the state write stores changed.
# ---------------------------------------------------------------------------

# The state write passes every text value through the dispatcher's redaction. Twelve digits in three
# groups of four are in its phone syntax, so an id that holds them is stored changed; the ids the
# emitters write are stored as written. Joined here so that this file holds no such run as a literal.
# It is nobody's number.
ODD_ID = "evt-" + "-".join(("1234", "5678", "9012")) + "-x"


def test_t69_an_alert_with_no_creation_time_whose_id_is_stored_changed_is_read_once(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    # It waits for its next send attempt, so the file stays in the outbox as its emitter wrote it.
    event = not_ready(observer_event(MANUAL, "hosta", "bot-one", T0, event_id=ODD_ID), T0 + DAY)
    del event["createdAt"]
    alert = rig.put(event)
    assert rig.cycle() is None
    assert rig.disposition(alert) == ["outbox"]
    # The premise of the case: the state holds the id as the redaction wrote it, not as the emitter did.
    assert member(rig, "hosta|bot-one", MANUAL).get("lastEventId") == rig.d.redact_dispatcher_text(alert)
    assert member(rig, "hosta|bot-one", MANUAL).get("lastEventId") != alert
    assert seen(rig, "hosta|bot-one", MANUAL) == (micros(T0), micros(T0))
    # A second read of the same file changes nothing: it is not a newer alert.
    rig.cycle_at(T0 + 30)
    assert rig.disposition(alert) == ["outbox"]
    assert seen(rig, "hosta|bot-one", MANUAL) == (micros(T0), micros(T0))


def test_t69_a_clear_with_no_creation_time_whose_id_is_stored_changed_is_applied_once(make_rig):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.members("hosta|bot-one") == [MANUAL]
    rig.clock.set(T0 + 100)
    event = not_ready(observer_event(MANUAL, "hosta", "bot-one", T0 + 100, clear=True, event_id=ODD_ID), T0 + DAY)
    del event["createdAt"]
    clear = rig.put(event)
    assert rig.cycle() is None
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hosta|bot-one") == []
    # The premise of the case: the cleared map holds the id as the redaction wrote it.
    cleared = json.dumps(rig.entry("hosta|bot-one").get("clearedAt"))
    assert rig.d.redact_dispatcher_text(clear) in cleared
    assert clear not in cleared
    # A newer alert, then the same clear file read again: the newer member stays.
    rig.clock.set(T0 + 200)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 150))
    rig.cycle()
    rig.cycle_at(T0 + 230)
    assert rig.disposition(clear) == ["outbox"]
    assert rig.members("hosta|bot-one") == [MANUAL]


# Another id the redaction stores as the same text as ODD_ID.
ODD_ID_NEXT = "evt-" + "-".join(("1234", "5678", "9013")) + "-x"


def test_t94_a_new_death_whose_id_is_stored_as_the_removed_alerts_id_opens_and_pages(make_rig):
    rig = make_rig()
    # The premise of the case: two ids the state write stores as one text.
    assert ODD_ID_NEXT != ODD_ID
    assert rig.d.redact_dispatcher_text(ODD_ID_NEXT) == rig.d.redact_dispatcher_text(ODD_ID)
    rig.clock.set(T0)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0, event_id=ODD_ID))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # A later cycle reads the stored member back and a clear removes it.
    rig.clock.set(T0 + 60)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 60, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    # A new death an hour later, with another id: it is not the alert the clear removed.
    rig.clock.set(T0 + HOUR)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + HOUR, event_id=ODD_ID_NEXT))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + HOUR]
    assert rig.logged("passFault") == []


def damage_digest(scope: str, *path: str) -> Callable[[dict[str, Any]], None]:
    """A state edit that turns the stored digest at `path` in `scope` into a float of the same value.

    The value is the one the class itself stored, so no case needs a name the change adds. A state with no
    integer there, as the unchanged code writes it, is left as it is. A state with no scope or record on the way
    there fails the case by assertion, not by an error: a change that drops them is a failure the case reports.
    """

    def damage(payload: dict[str, Any]) -> None:
        holder = (payload.get(SECTION) or {}).get(scope)
        assert holder is not None, f"the stored state holds no {scope} scope"
        for name in path[:-1]:
            holder = holder.get(name)
            assert holder is not None, f"the stored {scope} scope holds no {name}"
        if isinstance(holder.get(path[-1]), int):
            holder[path[-1]] = float(holder[path[-1]])

    return damage


def test_t94_a_stored_digest_that_is_not_an_integer_names_no_event(make_rig):
    rig = make_rig()
    removed_id = open_now(rig, T0)
    rig.clock.set(T0 + 60)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + 60, clear=True))
    assert rig.cycle() is None
    assert rig.cycle_at(T0 + 60 + GRACE) is None
    assert rig.open_scopes() == []
    # The stored digest of the removed alert is damaged into a float of the same value.
    rig.edit_state(damage_digest("hosta|bot-one", "clearedAt", MANUAL, "removedEventDigest"))
    # A later death that carries the removed alert's id (written by hand, for example): the damaged value
    # names no event, so the times decide, and the death is later than the clear.
    rig.clock.set(T0 + HOUR)
    rig.put(observer_event(MANUAL, "hosta", "bot-one", T0 + HOUR, event_id=removed_id))
    assert rig.cycle() is None
    assert rig.open_scopes() == ["hosta|bot-one"]
    assert rig.page_times() == [T0, T0 + HOUR]
    assert rig.logged("passFault") == []


def test_t94_a_members_stored_digest_that_is_not_an_integer_names_no_event(make_rig):
    rig = make_rig()
    # A death stamped by a clock two hours ahead: beyond the allowance at its first read, so the member keeps
    # no producer time. Its next send attempt is due at T0 + 75 min, so the scans read it until then.
    rig.clock.set(T0)
    rig.put(not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + 2 * HOUR), T0 + 75 * 60))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    rig.edit_state(damage_digest("hosta|bot-one", "members", DEAD, "lastEventDigest"))
    # Read again with its stamp inside the hour, then sent: the damaged value names no event, so the read
    # is decided again, and the member keeps its producer time.
    assert rig.cycle_at(T0 + 76 * 60) is None
    # A recovery on a clock that is right, created before that stamp: the member's event is the later one.
    rig.clock.set(T0 + 80 * 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 80 * 60, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == [DEAD]
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0, T0 + INTERVAL]
    assert rig.logged("passFault") == []


def test_t94_a_members_own_event_read_again_inside_the_hour_is_not_decided_again(make_rig):
    rig = make_rig()
    # The case above with the stored digest as the class wrote it.
    rig.clock.set(T0)
    rig.put(not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + 2 * HOUR), T0 + 75 * 60))
    assert rig.cycle() is None
    assert rig.page_times() == [T0]
    # Read again with its stamp inside the hour, then sent: it is the member's own last event, so nothing about it
    # is decided again, and the member keeps no producer time.
    assert rig.cycle_at(T0 + 76 * 60) is None
    # A recovery on a clock that is right, later than every time the member holds: it removes the member.
    rig.clock.set(T0 + 80 * 60)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0 + 80 * 60, clear=True))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    assert rig.cycle_at(T0 + INTERVAL) is None
    assert rig.page_times() == [T0]
    assert rig.logged("passFault") == []


def test_t94_a_clears_stored_digest_that_is_not_an_integer_names_no_clear(make_rig):
    rig = make_rig()
    rig.clock.set(T0)
    rig.put(watchdog_event(DEAD, "hosta", "bot-one", T0))
    assert rig.cycle() is None
    # The recovery is stamped by a clock two hours ahead and waits for its next send attempt, so every cycle
    # reads it again. At its first read the stamp is beyond the allowance: its record keeps no producer time.
    rig.clock.set(T0 + 60)
    rig.put(not_ready(watchdog_event(DEAD, "hosta", "bot-one", T0 + 60 + 2 * HOUR, clear=True), T0 + DAY))
    assert rig.cycle() is None
    assert rig.members("hosta|bot-one") == []
    rig.edit_state(damage_digest("hosta|bot-one", "clearedAt", DEAD, "eventDigest"))
    # Read again with its stamp inside the hour: the damaged value names no clear, so the clear is decided
    # again, and its record now keeps its producer time.
    assert rig.cycle_at(T0 + HOUR + 100) is None
    record = rig.entry("hosta|bot-one").get("clearedAt", {}).get(DEAD, {})
    assert record.get("producedAt") == micros(T0 + 60 + 2 * HOUR)
    assert rig.logged("passFault") == []


# ---------------------------------------------------------------------------
# A latent entry that is seven days old holds no condition that opens later.
# ---------------------------------------------------------------------------


def test_t93_an_aged_latent_sustain_does_not_hold_a_condition_that_opens_after_its_own_ended(make_rig):
    rig = make_rig(fleet=ROSTER_DUP)
    # A sustain-only event of the bot on hosta: a latent entry, whose key sorts before hostb's.
    rig.clock.set(T0)
    rig.put(observer_event(INDETERMINATE, "hosta", "dup-bot", T0))
    assert rig.cycle() is None
    assert rig.phase("hosta|dup-bot") == "latent"
    # 700 s before that entry is seven days old the other bot of the name dies and is paged; 50 s later it clears.
    opened = T0 + RETENTION - 700
    open_now(rig, opened, host="hostb", bot="dup-bot")
    assert rig.page_times("hostb/dup-bot") == [opened]
    cleared_at = opened + 50
    rig.clock.set(cleared_at)
    rig.put(observer_event(MANUAL, "hostb", "dup-bot", cleared_at, clear=True))
    assert rig.cycle() is None
    # The roster lists the name on two hosts: the latent sustain holds nothing, and the grace runs.
    assert rig.entry("hostb|dup-bot").get("emptySince") == micros(cleared_at)
    assert rig.phase("hosta|dup-bot") == "latent"
    # One cycle before the pass that matters: the grace is 591 s old, the latent entry 59 s short of seven days.
    assert rig.cycle_at(T0 + RETENTION - 59) is None
    assert rig.entry("hostb|dup-bot").get("emptySince") == micros(cleared_at)
    assert rig.phase("hosta|dup-bot") == "latent"
    # Sixty seconds later the grace has run out and the latent entry is seven days old. In between the
    # roster changed: the name is on one host now, so a latent sustain of that name would hold a
    # condition. This pass is the first to see all three, and it ends the condition.
    rig.clock.set(T0 + RETENTION + 1)
    rig.write_roster(roster(("hostb", "dup-bot"), ("hosta", "bot-one")))
    assert rig.cycle() is None
    assert rig.phase("hostb|dup-bot") == "absent"
    # A new death of that bot one minute later: a new condition, paged at once.
    again = T0 + RETENTION + 61
    open_now(rig, again, host="hostb", bot="dup-bot")
    assert rig.page_times("hostb/dup-bot") == [opened, again]
    # Its opener clears. The old sustain is gone with the condition it could last have held, so
    # nothing holds this one: it ends after the grace, and no page follows.
    cleared_again = again + 100
    rig.clock.set(cleared_again)
    rig.put(observer_event(MANUAL, "hostb", "dup-bot", cleared_again, clear=True))
    assert rig.cycle() is None
    rig.cycle_at(cleared_again + GRACE)
    assert rig.phase("hostb|dup-bot") == "absent"
    rig.cycle_at(again + INTERVAL)
    assert rig.page_times("hostb/dup-bot") == [opened, again]
    assert [text for text in rig.page_texts() if PAGE_UNVERIFIED in text] == []
