"""Dead-credential re-page: one condition per bot, paged until it clears.

A dead provider credential used to reach the owner once: the watchdog pages
once per episode, an open incident re-notifies only on a new event, and the
owner route has a 6 h floor. This module keeps one *condition* per bot for the
auth-caused sources and says when its page is due again.

It holds the rules and no effect: it reads no clock, sends nothing and writes
no file. The dispatcher gives it the incident state, the roster and the time
through a :class:`Cycle`, calls it where an event is read or leaves the outbox
(``observe_event``) and once per stored condition before the cycle's state
record (``evaluate_entry``), and performs the sends itself.

Stored in the dispatcher's incident state:

``credentialConditions``
    Scope key ``<host>|<instance>`` to an entry. An entry is *latent* (members
    that can only sustain or join), *pending* (the 30-minute clock runs) or
    *open* (it pages). A scope whose condition ended keeps only ``clearedAt``.
``credentialConditionsQuarantine``
    At most five stored values that failed validation, for inspection.
``credentialConditionsLoss``
    What bounds a loss that repeats: per lost scope the rebuilt condition's
    page fields, and under ``announcement`` the state of the loss announcement.

Times taken from events (``openedAt``, ``pendingSince``, ``emptySince``, the
member and ``clearedAt`` times) are in the dispatcher's microsecond order.
Times the dispatcher's clock writes are whole epoch seconds.
An event time is capped at the read time. The uncapped producer time of a
member's last event and of a clear is also kept (``lastProducedAt``,
``producedAt``) when the event has one no more than an hour ahead of the read;
it decides only which of two events of one source came first, and it is decided
once, when it is stored. Event identities that decide anything are kept as
integer digests of the event id (for an event with no id and a usable,
timezone-aware creation time, of that time's raw text; each kind under its own
prefix), which the state write never redacts: a member's last event
(``lastEventDigest``), a clear (``eventDigest``) and the last alert a clear of
its source removed (``removedEventDigest``). That alert read again changes
nothing, and that clear read again changes nothing in its own source's record.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from lib.bot_errors_roster import _is_runtime_relevant, load_roster, roster_identity
from lib.durable_json import DurableWriteError, durable_json_target, observe_json
from lib.owner_route import _FLEET_MODEL, event_machine

SECTION = "credentialConditions"
QUARANTINE = "credentialConditionsQuarantine"
LOSS = "credentialConditionsLoss"
ALERT_DAYS = "credentialConditionsAlertDays"
# The daily group meta-alerts owed and not yet taken: name to {"day": <UTC day>, "at": <epoch s first owed>}.
ALERTS_OWED = "credentialConditionsAlertsOwed"
# The loss announcement's key in LOSS. It holds no "|", so it is never a scope key.
ANNOUNCEMENT = "announcement"

INTERVAL_SECONDS = 14_400
PROMOTION_SECONDS = 1_800
GRACE_SECONDS = 600
ACK_HOLD_SECONDS = 86_400
MAINTENANCE_HOLD_SECONDS = 86_400
RETRY_CAP = 3
CLASS_BUDGET_SECONDS = 20.0
RETENTION_SECONDS = 604_800
QUARANTINE_MAX = 5
QUARANTINE_VALUE_CHARS = 4_096
# How far ahead of the read a creation time may be and still order events: the dispatcher's allowance for a
# producer clock that runs ahead (CONNECTIVITY_LOSS_MAX_FUTURE_SECONDS). A stamp further out is a wrong clock.
MAX_AHEAD_SECONDS = 3_600

_MICRO = 1_000_000
_PROMOTION = PROMOTION_SECONDS * _MICRO
_GRACE = GRACE_SECONDS * _MICRO
_RETENTION = RETENTION_SECONDS * _MICRO
_MAX_AHEAD = MAX_AHEAD_SECONDS * _MICRO

# The class of a source.
OPENER = "opener"                  # opens a condition at once
OPENER_DELAYED = "opener_delayed"  # opens it after 30 minutes
SUSTAIN = "sustain"                # never opens; keeps a pending or open condition alive
JOIN = "join"                      # never opens, never sustains; named in the page
COMPANION = "companion"            # an opener only beside primary_model_unusable, else join-only
NOT_MEMBER = "not_member"

DEAD = "provider_credential_dead"
PRIMARY = "primary_model_unusable"
NO_FALLBACK = "provider_auth_required_no_fallback"
REAUTH_PREFIX = "reauth-observe:"
MANUAL = REAUTH_PREFIX + "reauth_needed_manual"
_MISMATCH_PREFIX = "account_identity_mismatch:"
STORM_SOURCE = "storm-collapse"

_FIXED_CLASS = {DEAD: OPENER, PRIMARY: SUSTAIN, NO_FALLBACK: COMPANION}
# The re-auth observer's catalog of diagnoses. A diagnosis the observer adds later is absent here
# and has no class until this table names it.
_REAUTH_CLASS = {
    "reauth_needed_manual": OPENER,
    "credential_present_runtime_unusable": OPENER_DELAYED,
    "indeterminate_investigate": SUSTAIN,
    "public_liveness_only": SUSTAIN,
    "public_liveness_degraded": SUSTAIN,
    "probe_unsupported_provider_stuck": NOT_MEMBER,
    "probe_diverges_from_turn_execution": NOT_MEMBER,
    "recovery_stuck_restart": NOT_MEMBER,
    "probe_gated_fallback_stuck": NOT_MEMBER,
    "non_auth_degraded_escalate": NOT_MEMBER,
    "health_degraded_non_fallback": NOT_MEMBER,
    "all_clear": NOT_MEMBER,
}
_OPENER_CLASSES = frozenset({OPENER, OPENER_DELAYED, COMPANION})
_MEMBER_CLASSES = frozenset({OPENER, OPENER_DELAYED, SUSTAIN, JOIN, COMPANION})
# The openers the legacy owner route copies to the owner today.
ROUTED_OPENERS = frozenset({DEAD, MANUAL})
# A clear of one of these also removes the companion, which has no clear of its own.
_CLOSES_COMPANION = frozenset({PRIMARY, DEAD})

ALERT = "alert"
CLEAR = "clear"

ACCEPTED = "accepted"
FAILED = "failed"
CUT = "cut"

HUMAN_ACTION = (
    "Human action required: restore this bot's provider credential "
    "(owner). No automated remediation."
)
HUMAN_ACTION_DIGEST = (
    "Human action required: restore the provider credential of each bot named here "
    "(owner). No automated remediation."
)
META_STATE_LOST = "credential-repage-state-lost"
META_PASS_ERROR = "credential-repage-pass-error"
META_ROSTER_UNREADABLE = "credential-repage-roster-unreadable"
# The daily group meta-alerts, in the order they are listed.
DAILY_META_ALERTS = (META_ROSTER_UNREADABLE, META_PASS_ERROR)
LOG_PREFIX = "credential_repage_"

_PAGE_FIELDS = ("lastPageAt", "prevPageAt", "lastAttemptAt", "failedAttempts")
_CLOCK_FIELDS = ("openedSeenAt", "lastPageAt", "prevPageAt", "lastAttemptAt", "lastAcceptedAt",
                 "maintenanceHoldStartedAt", "lastDisabledLogAt")
_EVENT_TIME_FIELDS = ("openedAt", "pendingSince", "emptySince")
_COUNT_FIELDS = ("count", "failedAttempts")


def source_class(source: str) -> str | None:
    """The class of a source, or None for a re-auth observer diagnosis the table does not hold."""
    fixed = _FIXED_CLASS.get(source)
    if fixed is not None:
        return fixed
    if _FLEET_MODEL.match(source):
        return JOIN
    if not source.startswith(REAUTH_PREFIX):
        return NOT_MEMBER
    diagnosis = source[len(REAUTH_PREFIX):]
    if diagnosis.startswith(_MISMATCH_PREFIX):
        # A mismatch takes the class of the diagnosis it stands over.
        diagnosis = diagnosis[len(_MISMATCH_PREFIX):]
    return _REAUTH_CLASS.get(diagnosis)


def is_member(source: str) -> bool:
    """Whether the class observes events of this source at all."""
    return source_class(source) in _MEMBER_CLASSES


def safe_segment(value: str) -> str:
    """One segment of a scope key, by the dispatcher's own segment rule.

    The dispatcher's `safe_segment` cannot be imported here (its file name is no module name);
    the acknowledge command needs the same rule, so the class has it once, in this module.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def first_label(host: str) -> str:
    return host.split(".", 1)[0]


def _host_strings(event: Mapping[str, Any], machine: str) -> list[str]:
    """An event's own host strings: its machine and its relay host, each also by its first label.

    The roster's hosts are matched against this list, and a clear's string fan-out reaches only an
    entry whose key names one of its strings: one list, so that the two cannot differ.
    """
    strings = [machine, first_label(machine)]
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    relay = diagnostics.get("relay") if isinstance(diagnostics.get("relay"), dict) else {}
    relay_host = str(relay.get("remoteHost") or "").strip().lower()
    if relay_host:
        strings += [relay_host, first_label(relay_host)]
    return strings


def _host_segment(host: str) -> str:
    """A host string as the host segment of a scope key. The key is built with it, and the fan-out
    compares a clear's host strings through it, so a label the segment rule rewrites still matches."""
    return safe_segment(host.lower())


def outbox_files(outbox: Path) -> list[Path]:
    """The observer's one listing of the outbox."""
    return sorted(outbox.glob("*.json"))


def read_event(path: Path, reader: Callable[[Path], Any]) -> Any:
    """The observer's one read of an outbox file, through the dispatcher's own reader."""
    return reader(path)


def roster_names(data: Any) -> dict[str, frozenset[str]]:
    """Instance name to the hosts that run it, both lower-cased. A row that expects no bot is not counted."""
    names: dict[str, set[str]] = {}
    for host in roster_identity(data)["hosts"]:
        for instance in host["instances"]:
            name = instance["name"].lower()
            if name and _is_runtime_relevant(instance["expected"]):
                names.setdefault(name, set()).add(host["host"].lower())
    return {name: frozenset(hosts) for name, hosts in names.items()}


def load_roster_names() -> dict[str, frozenset[str]] | None:
    """The roster as `roster_names` gives it, or None when it cannot be read."""
    try:
        data, _inventory = load_roster()
        return roster_names(data)
    except Exception:  # noqa: BLE001 - an unreadable roster is a stated state of the class, not a fault
        return None


class Scope:
    """Where an event belongs: the scope key, and the event's own strings."""

    __slots__ = ("key", "machine", "instance", "name", "unmatched", "hosts")

    def __init__(self, key: str, machine: str, instance: str, name: str, unmatched: bool,
                 hosts: list[str]) -> None:
        self.key = key
        self.machine = machine      # the event's mapped machine, lower-cased
        self.instance = instance    # the event's instance name as written
        self.name = name            # the instance name, lower-cased, as the roster is asked
        self.unmatched = unmatched  # a duplicated name whose host strings match no roster host
        self.hosts = hosts          # the event's own host strings (`_host_strings`)


def same_name_applies(roster: Mapping[str, frozenset[str]] | None, name: str) -> bool:
    """Whether entries of one instance name may be read as one bot.

    Not when the roster lists the name on several hosts: a sustain from one such bot must not
    hold another one's condition.
    """
    return roster is None or len(roster.get(name, ())) <= 1


def class_scope(event: Mapping[str, Any], roster: Mapping[str, frozenset[str]] | None) -> Scope | None:
    """The class scope of an event, or None when it names no instance."""
    probe = _FLEET_MODEL.match(str(event.get("source") or ""))
    if probe:
        # The fleet probe's `machine` is the probing host; the bot's host and name are in its source.
        machine = probe.group(1)
        instance = probe.group(2).replace("_", "-")
    else:
        machine = event_machine(event).lower()
        instance = str(event.get("instance") or "").strip()
    if not instance or instance.lower() == "unknown":
        return None
    name = instance.lower()
    strings = _host_strings(event, machine)
    hosts = roster.get(name) if roster is not None else None
    host, unmatched = machine, False
    if hosts and len(hosts) == 1:
        host = next(iter(hosts))
    elif hosts:
        matched = next((candidate for candidate in strings if candidate in hosts), None)
        if matched is None:
            unmatched = True
        else:
            host = matched
    return Scope(f"{_host_segment(host)}|{safe_segment(instance)}", machine, instance, name, unmatched, strings)


def is_entry(value: Any) -> bool:
    """A stored condition, as against a scope that keeps only its `clearedAt` map."""
    return isinstance(value, dict) and isinstance(value.get("members"), dict)


def phase(entry: Any) -> str:
    if not is_entry(entry):
        return "absent"
    if entry.get("openedAt") is not None:
        return "open"
    if entry.get("pendingSince") is not None:
        return "pending"
    return "latent"


def _entry_name(entry: Mapping[str, Any]) -> str:
    return str(entry.get("instance") or "").lower()


def _has_opener(entry: Mapping[str, Any]) -> bool:
    members = entry["members"]
    for source in members:
        found = source_class(source)
        if found in (OPENER, OPENER_DELAYED) or (found == COMPANION and PRIMARY in members):
            return True
    return False


def _has_sustain(entry: Mapping[str, Any]) -> bool:
    return any(source_class(source) == SUSTAIN for source in entry["members"])


def _iso(micros: int) -> str:
    return datetime.fromtimestamp(micros // _MICRO, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Cycle:
    """What one dispatcher cycle gives the class.

    `state` is the incident state the cycle will commit; `clock` is the dispatcher's clock.
    `outcomes` is the dispatcher's in-memory record of the class sends that await their
    entry's next evaluation; it outlives the cycle, so it is handed in.
    `stored_text` is what the dispatcher's state write makes of a text value (its redaction):
    an event id read back from the state is compared with it, not only with the id itself.
    """

    def __init__(self, state: dict[str, Any], *, clock: Callable[[], float],
                 roster: Mapping[str, frozenset[str]] | None,
                 created_order: Callable[[Mapping[str, Any]], int | None],
                 outcomes: dict[str, dict[str, Any]],
                 owner_route_enabled: bool = True,
                 stored_text: Callable[[str], str] | None = None) -> None:
        self.state = state
        self.clock = clock
        self.roster = roster
        self.created_order = created_order
        self.outcomes = outcomes
        self.owner_route_enabled = owner_route_enabled
        self.stored_text = stored_text
        self.changed = False
        self.acknowledgements: Mapping[str, Any] = {}
        self.ack_file_unreadable = False
        self.maintenance_scopes: frozenset[str] = frozenset()
        self.held: set[str] = set()
        self.unusable: set[str] = set()
        self.ties: set[tuple[str, str, int]] = set()
        self.unmatched: set[str] = set()
        self.ack_unreadable = False
        self.pass_error = False
        self.disabled_logs = 0

    def now_s(self) -> int:
        return int(self.clock())

    def now_us(self) -> int:
        return int(round(self.clock() * _MICRO))

    def section(self) -> dict[str, Any]:
        """The stored section, for reading. Not created here: a state the class never wrote stays as it was."""
        found = self.state.get(SECTION)
        return found if isinstance(found, dict) else {}

    def section_for_write(self) -> dict[str, Any]:
        found = self.state.get(SECTION)
        if not isinstance(found, dict):
            found = {}
            self.state[SECTION] = found
        return found

    def loss(self) -> dict[str, Any]:
        """The loss map. An unreadable one is empty, which errs toward announcing and paging."""
        found = self.state.get(LOSS)
        return found if isinstance(found, dict) else {}

    def same_event(self, stored: Any, event_id: str) -> bool:
        """Whether a stored event id is this event's: as written this cycle, or as the state write stored it."""
        if stored == event_id:
            return True
        return self.stored_text is not None and stored == self.stored_text(event_id)

    def take_changed(self) -> bool:
        """Whether the state changed since the last call. The caller commits when it did."""
        changed, self.changed = self.changed, False
        return changed

    def summary(self) -> dict[str, Any]:
        """The cycle's log record: only what is not empty. Booleans and integers only."""
        fields: dict[str, Any] = {
            "unusableEvents": len(self.unusable),
            "ties": len(self.ties),
            "unmatchedScopes": len(self.unmatched),
            "rosterUnreadable": self.roster is None,
            "ackUnreadable": self.ack_unreadable,
            # A strict boolean, never an error's text. Not named "...Error": the shared log
            # projection drops every detail key that contains "error"
            # (lib/controller_log.py:124-149 and :319-327, metadata_only_controller_details).
            "passFault": self.pass_error,
        }
        return {name: value for name, value in fields.items() if value}


# ---------------------------------------------------------------------------
# The observer: one member event, applied to its entry.
# ---------------------------------------------------------------------------


def observe_event(cycle: Cycle, event: Mapping[str, Any], kind: str) -> bool:
    """Apply one alert or clear of a member source. Returns whether the stored section changed.

    A second observation of the same event changes nothing, so the function is called for an
    event when the scan reads it and again wherever it leaves the outbox.
    """
    source = str(event.get("source") or "")
    found = source_class(source)
    if found not in _MEMBER_CLASSES:
        return False
    event_id = str(event.get("id") or "")
    scope = class_scope(event, cycle.roster)
    if scope is None:
        cycle.unusable.add(event_id or source)
        return False
    if scope.unmatched:
        cycle.unmatched.add(event_id or scope.key)
    now = cycle.now_us()
    created = cycle.created_order(event)
    # An event with no usable creation time is given the read time; one from the future is capped at it.
    at = now if created is None else min(created, now)
    # Beyond the allowance the creation time is no ordering evidence: the capped time decides.
    produced = created if created is not None and created - now <= _MAX_AHEAD else None
    digest = _event_digest(event_id, event.get("createdAt") if created is not None else None)
    before = cycle.changed
    cycle.changed = False
    try:
        if kind == CLEAR:
            _apply_clear(cycle, scope, source, at, created is not None, event_id, produced=produced, digest=digest)
        else:
            _apply_alert(cycle, scope, source, found, at, created is not None, event_id, produced=produced,
                         digest=digest)
    finally:
        # Also after a fault: what was changed before it must still be saved.
        changed = cycle.changed
        cycle.changed = before or changed
    return changed


def _cleared(holder: Any, source: str) -> Mapping[str, Any] | None:
    held = holder.get("clearedAt") if isinstance(holder, dict) else None
    found = held.get(source) if isinstance(held, dict) else None
    return found if isinstance(found, dict) else None


def _order(at: int, produced: int | None, record_at: int, record_produced: Any) -> int:
    """Whether an event is earlier than (-1), tied with (0) or later than (1) a stored record of its source.

    Producer times are compared when both carry one: a bot's alerts and clears are stamped by its
    host's clock, and the cap at the read time hides a future-dated event's place in that order.
    Otherwise the capped times are compared, never a producer time with a capped one.
    """
    if produced is not None and _event_time(record_produced):
        at, record_at = produced, record_produced
    return (at > record_at) - (at < record_at)


def _digest(text: str) -> int:
    """A text's identity as an integer, which the state write stores as it is."""
    return int.from_bytes(hashlib.sha256(text.encode("utf-8")).digest()[:6], "big")


def _event_digest(event_id: str, created_text: Any) -> int | None:
    """An event's identity: the digest of its id, or, for an event with no id, of its creation time's raw
    text, which the caller passes only when that time is usable. Each kind is hashed under its own prefix,
    and the two prefixes differ in their first character, so an id's digest equals a creation time's only
    by a collision of the 48-bit digests. None for neither."""
    if event_id:
        return _digest("id:" + event_id)
    if isinstance(created_text, str):
        return _digest("createdAt:" + created_text)
    return None


def _is_digest(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _same_digest(stored: Any, digest: int | None) -> bool:
    """Whether a stored digest names this event. A stored value of another type names no event."""
    return digest is not None and _is_digest(stored) and stored == digest


def _set_optional(record: dict[str, Any], name: str, value: int | None) -> None:
    """Store a value about the event the record now names; none when that event has none."""
    if value is None:
        record.pop(name, None)
    else:
        record[name] = value


def _end_condition(cycle: Cycle, key: str) -> None:
    """Delete an entry. Its scope keeps the `clearedAt` map and nothing else."""
    section = cycle.section_for_write()
    holder = section.get(key)
    kept = holder.get("clearedAt") if isinstance(holder, dict) else None
    if isinstance(kept, dict) and kept:
        section[key] = {"clearedAt": kept}
    else:
        section.pop(key, None)
    # The outcome of its last send belongs to the condition that ended, never to a later one of the scope.
    cycle.outcomes.pop(key, None)
    cycle.changed = True


def _apply_alert(cycle: Cycle, scope: Scope, source: str, found: str, at: int, timed: bool,
                 event_id: str, produced: int | None = None, digest: int | None = None) -> None:
    section = cycle.section()
    holder = section.get(scope.key)
    cleared = _cleared(holder, source)
    if cleared is not None:
        if _same_digest(cleared.get("removedEventDigest"), digest):
            return  # the alert a clear removed, read again: a later read does not make it newer
        order = _order(at, produced, cleared["at"], cleared.get("producedAt"))
        if order < 0:
            return  # created before its source's clear: an old alert that came back
        if order == 0:
            # The order of the two cannot be known. The member is kept: this fails toward a page.
            cycle.ties.add((scope.key, source, at))
    entry = holder if is_entry(holder) else None
    if entry is not None and entry.get("emptySince") is not None and at - entry["emptySince"] >= _GRACE:
        # The grace had run out, in event time, before this alert: it starts a new condition.
        _end_condition(cycle, scope.key)
        holder, entry = section.get(scope.key), None
    if entry is None:
        section = cycle.section_for_write()
        entry = {"instance": scope.instance, "members": {}}
        if isinstance(holder, dict) and isinstance(holder.get("clearedAt"), dict):
            entry["clearedAt"] = holder["clearedAt"]
        section[scope.key] = entry
        cycle.changed = True
    members = entry["members"]
    member = members.get(source)
    if member is None:
        members[source] = {"firstSeenAt": at, "lastSeenAt": at, "role": found, "lastEventId": event_id}
        _set_optional(members[source], "lastProducedAt", produced)
        _set_optional(members[source], "lastEventDigest", digest)
        cycle.changed = True
    elif timed or not cycle.same_event(member.get("lastEventId"), event_id):
        # The two times are capped at the read time; which event is the member's last goes by `_order`.
        # The member's own last event read again keeps what was stored about it.
        again = _same_digest(member.get("lastEventDigest"), digest)
        later = not again and _order(at, produced, member["lastSeenAt"], member.get("lastProducedAt")) > 0
        if at < member["firstSeenAt"]:
            member["firstSeenAt"] = at
            cycle.changed = True
        if at > member["lastSeenAt"]:
            member["lastSeenAt"] = at
            cycle.changed = True
        if later:
            member["lastEventId"] = event_id
            _set_optional(member, "lastProducedAt", produced)
            _set_optional(member, "lastEventDigest", digest)
            cycle.changed = True
    if entry.get("openedAt") is None:
        # The companion opens only beside the runtime signal, whichever of the two arrives second.
        opens = found == OPENER or (source in (NO_FALLBACK, PRIMARY) and NO_FALLBACK in members and PRIMARY in members)
        starts_clock = found == OPENER_DELAYED and entry.get("pendingSince") is None
        if opens:
            entry["openedAt"] = at
            entry["openedSeenAt"] = cycle.now_s()
            entry.pop("pendingSince", None)
        elif starts_clock:
            entry["pendingSince"] = at
        if opens or starts_clock:
            if "machine" not in entry:
                # The page names the first opener's own strings, never the roster's label.
                entry["machine"], entry["instance"] = scope.machine, scope.instance
            cycle.changed = True
    _resettle(cycle, scope.name, at)


def _clear_in(cycle: Cycle, key: str, source: str, at: int, timed: bool, event_id: str, *,
              record_without_member: bool, produced: int | None = None, digest: int | None = None) -> None:
    """One clear in one scope: remove the member it is strictly later than, and record `clearedAt`."""
    holder = cycle.section().get(key)
    cleared = _cleared(holder, source)
    if not timed and cleared is not None and cycle.same_event(cleared.get("eventId"), event_id):
        return  # the same clear, read again
    if cleared is not None and _same_digest(cleared.get("eventDigest"), digest):
        return  # the same clear, read again: what it removed and recorded is never decided again
    removed = False
    # The last alert a clear of this source removed. A later record keeps it until a clear removes another.
    gone = cleared.get("removedEventDigest") if cleared is not None else None
    if is_entry(holder):
        member = holder["members"].get(source)
        if isinstance(member, dict):
            order = _order(at, produced, member["lastSeenAt"], member.get("lastProducedAt"))
            if order > 0:
                gone = member.get("lastEventDigest")
                del holder["members"][source]
                removed = True
                cycle.changed = True
            elif order == 0:
                cycle.ties.add((key, source, at))
    if not (removed or record_without_member):
        return
    if cleared is not None and _order(at, produced, cleared["at"], cleared.get("producedAt")) <= 0:
        return
    section = cycle.section_for_write()
    holder = section.get(key)
    if not isinstance(holder, dict):
        holder = {}
        section[key] = holder
    if not isinstance(holder.get("clearedAt"), dict):
        holder["clearedAt"] = {}
    holder["clearedAt"][source] = {"at": at, "eventId": event_id}
    _set_optional(holder["clearedAt"][source], "producedAt", produced)
    _set_optional(holder["clearedAt"][source], "eventDigest", digest)
    _set_optional(holder["clearedAt"][source], "removedEventDigest", gone if _is_digest(gone) else None)
    cycle.changed = True


def _holds_name(key: str, holder: Any, scope: Scope) -> bool:
    """Whether a stored scope is of the event's instance name: an entry by its name, any scope by its key."""
    if is_entry(holder) and _entry_name(holder) == scope.name:
        return True
    return key.partition("|")[2].lower() == safe_segment(scope.instance).lower()


def _apply_clear(cycle: Cycle, scope: Scope, source: str, at: int, timed: bool, event_id: str,
                 produced: int | None = None, digest: int | None = None) -> None:
    targets = [scope.key]
    if cycle.roster is not None and len(cycle.roster.get(scope.name, ())) == 1:
        # The roster holds the name on exactly one host, so every entry of that name is the same
        # bot: the clear also removes its member from an entry stored under an older key.
        targets += [key for key, entry in cycle.section().items()
                    if key != scope.key and is_entry(entry) and _entry_name(entry) == scope.name]
    # The first opener's own machine and instance strings name the bot without the roster: a clear read while
    # the roster cannot be read, or mapped to another key, still reaches that entry. Only when nothing stored
    # can be another bot of the name: the roster does not list the name on two or more hosts, the one entry
    # that carries the machine string is the name's only stored scope, counting scopes that keep only
    # `clearedAt`, and that entry's key names one of the clear's own host strings (the key's host segment was
    # built by `_host_segment`, so the strings are compared through it). Otherwise the clear reaches its own
    # scope only: a missed clear leaves a page running, a wrong one silences another bot's death.
    if same_name_applies(cycle.roster, scope.name):
        section = cycle.section()
        named = [key for key, entry in section.items()
                 if is_entry(entry) and entry.get("machine") == scope.machine and _entry_name(entry) == scope.name]
        stored = [key for key, holder in section.items() if _holds_name(key, holder, scope)]
        own = {_host_segment(host) for host in scope.hosts}
        if (len(named) == 1 and stored == named and named[0] not in targets
                and named[0].partition("|")[0] in own):
            targets.append(named[0])
    for key in targets:
        _clear_in(cycle, key, source, at, timed, event_id, record_without_member=True, produced=produced,
                  digest=digest)
        if source in _CLOSES_COMPANION:
            _clear_in(cycle, key, NO_FALLBACK, at, timed, event_id, record_without_member=False,
                      produced=produced, digest=digest)
    for key in targets:
        entry = cycle.section().get(key)
        if is_entry(entry) and phase(entry) == "latent" and not entry["members"]:
            _end_condition(cycle, key)  # a latent entry ends with its last member, with no grace
    _resettle(cycle, scope.name, at)


def _lent_members(cycle: Cycle, key: str, entry: Mapping[str, Any]) -> dict[str, Any]:
    """The members of latent entries of the same instance name, where the same-name rule applies."""
    name = _entry_name(entry)
    if not same_name_applies(cycle.roster, name):
        return {}
    lent: dict[str, Any] = {}
    for other_key, other in cycle.section().items():
        if other_key != key and phase(other) == "latent" and _entry_name(other) == name:
            lent.update(other["members"])
    return lent


def _sustained(cycle: Cycle, key: str, entry: Mapping[str, Any]) -> bool:
    """Whether an opener or a sustain-only member holds the condition, its own or one lent by name."""
    if _has_opener(entry) or _has_sustain(entry):
        return True
    return any(source_class(source) == SUSTAIN for source in _lent_members(cycle, key, entry))


def _resettle(cycle: Cycle, name: str, at: int) -> None:
    """After an event at `at`: start or stop the grace of every condition of that instance name."""
    for key, entry in list(cycle.section().items()):
        if phase(entry) not in ("pending", "open") or _entry_name(entry) != name:
            continue
        empty = entry.get("emptySince")
        if _sustained(cycle, key, entry):
            if empty is None:
                continue
            if at - empty >= _GRACE:
                _end_condition(cycle, key)  # the member came back after the grace: not the same episode
            else:
                del entry["emptySince"]
                cycle.changed = True
        elif empty is None:
            entry["emptySince"] = at
            cycle.changed = True


# ---------------------------------------------------------------------------
# Acknowledge and maintenance.
# ---------------------------------------------------------------------------


def read_state_object(path: Path) -> Mapping[str, Any] | None:
    """Read regular state JSON without following the state directory or file as a symlink."""
    parent = path.absolute().parent
    try:
        parent.lstat()
    except FileNotFoundError:
        return None
    target = durable_json_target(
        trusted_root=parent.parent.resolve(strict=True) / parent.name,
        relative_path=path.name,
        owner_controlled_readable=True,
    )
    return observe_json(target).payload


def read_acknowledgements(path: Path) -> tuple[Mapping[str, Any], bool]:
    """(the acknowledge file's entries, whether the file exists and cannot be used)."""
    try:
        data = read_state_object(path)
    except (OSError, DurableWriteError):
        return {}, True
    return data or {}, False


def acknowledged_at(value: Any, now: int) -> int | None:
    """The time of one acknowledge entry, or None when the entry cannot be used."""
    acked = value.get("ackedAt") if isinstance(value, dict) else None
    if isinstance(acked, bool) or not isinstance(acked, int) or acked > now:
        return None
    return acked


def _acknowledgement_holds(cycle: Cycle, key: str, entry: Mapping[str, Any]) -> bool:
    """D8: written at or after the condition opened, by the dispatcher host's clock, and under 24 h old."""
    if cycle.ack_file_unreadable:
        cycle.ack_unreadable = True
        return False
    if key not in cycle.acknowledgements:
        return False
    now = cycle.now_s()
    acked = acknowledged_at(cycle.acknowledgements[key], now)
    if acked is None:
        cycle.ack_unreadable = True
        return False
    return acked >= entry["openedSeenAt"] and now - acked < ACK_HOLD_SECONDS


def _ack_note(cycle: Cycle, key: str) -> bool:
    if cycle.ack_file_unreadable:
        return True
    return key in cycle.acknowledgements and acknowledged_at(cycle.acknowledgements[key], cycle.now_s()) is None


def maintenance_scopes(windows: Iterable[str], roster: Mapping[str, frozenset[str]] | None) -> frozenset[str]:
    """The class scopes that the active maintenance windows cover. A window key is `machine|instance`."""
    covered = set()
    for window in windows:
        machine, _, instance = str(window).partition("|")
        scope = class_scope({"machine": machine, "instance": instance}, roster)
        if scope is not None:
            covered.add(scope.key)
    return frozenset(covered)


# ---------------------------------------------------------------------------
# The timer pass: one stored scope.
# ---------------------------------------------------------------------------


def _restore_floor(fields: dict[str, Any]) -> None:
    """`lastPageAt` goes back to `prevPageAt`; absent on a first page, which means "due now"."""
    if fields.get("prevPageAt") is None:
        fields.pop("lastPageAt", None)
    else:
        fields["lastPageAt"] = fields["prevPageAt"]


def _apply_outcome(fields: dict[str, Any], outcome: Mapping[str, Any]) -> None:
    """Apply the outcome of the last send to the page fields of a condition or of the announcement."""
    result = outcome.get("result")
    if result == ACCEPTED:
        fields["lastAcceptedAt"] = outcome["attemptAt"]
        fields["count"] = int(fields.get("count") or 0) + 1
        fields["failedAttempts"] = 0
    elif result == FAILED:
        failed = int(fields.get("failedAttempts") or 0) + 1
        if failed >= RETRY_CAP:
            # The floor is kept and the counter starts again: the next page waits one interval.
            fields["failedAttempts"] = 0
        else:
            fields["failedAttempts"] = failed
            _restore_floor(fields)
    elif result == CUT:
        # No channel was tried: the stored fields are those from before the listing.
        for name in ("lastPageAt", "prevPageAt", "lastAttemptAt"):
            earlier = outcome["before"].get(name)
            if earlier is None:
                fields.pop(name, None)
            else:
                fields[name] = earlier


def _mirror_loss(cycle: Cycle, key: str, entry: Mapping[str, Any]) -> None:
    """While a scope has a loss record, the condition's page fields are written there too."""
    record = cycle.loss().get(key)
    if not isinstance(record, dict):
        return
    for name in _PAGE_FIELDS:
        if entry.get(name) is None:
            record.pop(name, None)
        else:
            record[name] = entry[name]


def _write_floor(fields: dict[str, Any], now: int) -> dict[str, Any]:
    """Write the floor before a send. Returns the fields as they stood, for a page that is cut."""
    before = {name: fields.get(name) for name in ("lastPageAt", "prevPageAt", "lastAttemptAt")}
    if before["lastPageAt"] is None:
        fields.pop("prevPageAt", None)
    else:
        fields["prevPageAt"] = before["lastPageAt"]
    fields["lastPageAt"] = now
    fields["lastAttemptAt"] = now
    return before


def _page_due(fields: Mapping[str, Any], now: int) -> bool:
    last = fields.get("lastPageAt")
    return last is None or now - last >= INTERVAL_SECONDS


def page_text(cycle: Cycle, key: str, entry: Mapping[str, Any]) -> tuple[str, str]:
    """(the owner's line, the e-mail body) for a condition's page."""
    host = entry.get("machine") or key.partition("|")[0]
    where = f"{host}/{entry.get('instance') or key.partition('|')[2]}"
    number = int(entry.get("count") or 0) + 1
    members = dict(_lent_members(cycle, key, entry))
    members.update(entry["members"])
    if _has_opener(entry):
        hours = max(0, cycle.now_us() - entry["openedAt"]) // (3600 * _MICRO)
        line = f"{where}: provider credential dead — human action required; dead for {hours} h, page {number}"
    else:
        cleared = entry.get("clearedAt") if isinstance(entry.get("clearedAt"), dict) else {}
        since = max((record["at"] for source, record in cleared.items()
                     if source_class(source) in _OPENER_CLASSES), default=entry["openedAt"])
        line = f"{where}: provider credential state unverified since {_iso(since)}; primary still unusable"
        reauth = sorted((record["lastSeenAt"], source) for source, record in members.items()
                        if source.startswith(REAUTH_PREFIX))
        if reauth:
            line += f"; the re-auth observer now reports {reauth[-1][1][len(REAUTH_PREFIX):]}"
        line += f" — human action required; page {number}"
    if _ack_note(cycle, key):
        line += "; acknowledge file unreadable"
    body = "\n".join([line, "", "Members of this condition:", *[f"- {source}" for source in sorted(members)]])
    return line, body


def pass_order(cycle: Cycle) -> list[str]:
    """The stored scopes in the order the timer pass evaluates them: latent entries last, each group by scope key.

    A latent entry is deleted by age unless it holds a pending or open condition by name. Whether
    it does is read after every condition has been evaluated, so an entry that held a condition
    which ended in this pass goes in this pass, whatever its key, and cannot hold one that opens later.
    """
    section = cycle.section()
    keys = sorted(section)
    return [key for key in keys if phase(section[key]) != "latent"] + [
        key for key in keys if phase(section[key]) == "latent"]


def evaluate_entry(key: str, cycle: Cycle) -> dict[str, Any] | None:
    """The timer pass for one stored scope. Returns the page to list, or None.

    The outcome of the entry's last send is applied first. A returned page has its floor
    written in the entry; the caller commits the state and only then lists the page.
    """
    section = cycle.section()
    entry = section.get(key)
    if key in cycle.outcomes:
        if is_entry(entry):
            _apply_outcome(entry, cycle.outcomes[key])
            _mirror_loss(cycle, key, entry)
            cycle.changed = True
        del cycle.outcomes[key]
    now_s, now = cycle.now_s(), cycle.now_us()
    _prune_cleared(cycle, key, entry, now)
    if not is_entry(entry):
        return None
    state = phase(entry)
    if state == "latent":
        members = entry["members"]
        aged = all(now - record["lastSeenAt"] > _RETENTION for record in members.values())
        if not members or (aged and not _lends_sustain(cycle, key, entry)):
            _end_condition(cycle, key)
        return None
    sustained = _sustained(cycle, key, entry)
    empty = entry.get("emptySince")
    # The observer starts and stops the grace when an event changes what holds the condition.
    # What holds it can also change with no event (the roster, a latent entry that aged out),
    # so the pass evaluates it again in every cycle.
    if empty is None and not sustained:
        entry["emptySince"] = empty = now
        cycle.changed = True
    elif empty is not None and sustained and now - empty < _GRACE:
        del entry["emptySince"]
        empty = None
        cycle.changed = True
    if empty is not None:
        if now - empty >= _GRACE:
            _end_condition(cycle, key)
        return None  # no page while the grace is running
    if state == "pending":
        if now - entry["pendingSince"] < _PROMOTION:
            return None
        entry["openedAt"] = min(entry["pendingSince"] + _PROMOTION, now)
        entry["openedSeenAt"] = now_s
        del entry["pendingSince"]
        cycle.changed = True
    held = _acknowledgement_holds(cycle, key, entry)
    if key in cycle.maintenance_scopes:
        if entry.get("maintenanceHoldStartedAt") is None:
            entry["maintenanceHoldStartedAt"] = now_s
            cycle.changed = True
        # A window holds the page for at most 24 h in the condition's life, however many follow.
        held = held or now_s < entry["maintenanceHoldStartedAt"] + MAINTENANCE_HOLD_SECONDS
    if held:
        cycle.held.add(key)
        return None
    if not _page_due(entry, now_s):
        return None
    if not cycle.owner_route_enabled:
        logged = entry.get("lastDisabledLogAt")
        if logged is None or now_s - logged >= INTERVAL_SECONDS:
            entry["lastDisabledLogAt"] = now_s
            cycle.disabled_logs += 1
            cycle.changed = True
        return None
    # The text is built before the floor, so a failure to build it cannot leave a floor with no send.
    line, body = page_text(cycle, key, entry)
    before = _write_floor(entry, now_s)
    _mirror_loss(cycle, key, entry)
    cycle.changed = True
    return {
        "scope": key, "line": line, "body": body, "attemptAt": now_s, "before": before,
        "count": int(entry.get("count") or 0), "failedAttempts": int(entry.get("failedAttempts") or 0),
        "hours": max(0, now - entry["openedAt"]) // (3600 * _MICRO),
    }


def drop_orphan_outcomes(cycle: Cycle) -> None:
    """Forget the outcome of a send whose scope holds no condition any more.

    An outcome whose entry exists is kept, also when the entry's evaluation failed this cycle:
    it is applied by the next pass that works.
    """
    section = cycle.section()
    for key in [key for key in cycle.outcomes if key != ANNOUNCEMENT and not is_entry(section.get(key))]:
        del cycle.outcomes[key]


def _lends_sustain(cycle: Cycle, key: str, entry: Mapping[str, Any]) -> bool:
    """Whether a latent entry's sustain-only member holds a pending or open condition by name."""
    name = _entry_name(entry)
    if not _has_sustain(entry) or not same_name_applies(cycle.roster, name):
        return False
    return any(other_key != key and phase(other) in ("pending", "open") and _entry_name(other) == name
               for other_key, other in cycle.section().items())


def _prune_cleared(cycle: Cycle, key: str, holder: Any, now: int) -> None:
    """Drop `clearedAt` records older than the retention, and a scope that keeps nothing else."""
    cleared = holder.get("clearedAt") if isinstance(holder, dict) else None
    if isinstance(cleared, dict):
        for source in [source for source, record in cleared.items() if now - record["at"] > _RETENTION]:
            del cleared[source]
            cycle.changed = True
        if not cleared:
            del holder["clearedAt"]
            cycle.changed = True
    if key in cycle.section() and not is_entry(holder) and not (isinstance(holder, dict) and holder.get("clearedAt")):
        del cycle.section()[key]
        cycle.changed = True


def page_order(items: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The class list in sending order: the state-lost page, then the oldest earlier attempt first.

    The key is each page's `lastAttemptAt` as it stood before this cycle's listing. A page that
    was never attempted sorts first; a tie is broken by scope key.
    """
    def key(item: Mapping[str, Any]) -> tuple[int, int, int, str]:
        earlier = item["before"].get("lastAttemptAt")
        return (0 if item["scope"] == ANNOUNCEMENT else 1, 0 if earlier is None else 1, earlier or 0, item["scope"])

    return sorted(items, key=key)


def drops_legacy_copy(cycle: Cycle, event: Mapping[str, Any]) -> bool:
    """Whether a routed opener's legacy owner copy is dropped: only when the class has answered for its scope."""
    if str(event.get("source") or "") not in ROUTED_OPENERS:
        return False
    scope = class_scope(event, cycle.roster)
    if scope is None:
        return False
    waiting = cycle.outcomes.get(scope.key)
    if isinstance(waiting, dict) and waiting.get("result") == ACCEPTED:
        return True  # a channel accepted this cycle's page
    entry = cycle.section().get(scope.key)
    if is_entry(entry):
        accepted = entry.get("lastAcceptedAt")
        if accepted is not None and cycle.now_s() - accepted < INTERVAL_SECONDS:
            return True  # a channel accepted a page inside the interval
    return scope.key in cycle.held  # the class holds the page on purpose


def action_sentence(cycle: Cycle | None, event: Mapping[str, Any]) -> str | None:
    """The human-action sentence for an alert of this class, or None for today's wording."""
    source = str(event.get("source") or "")
    if source == STORM_SOURCE:
        storm = event.get("storm") if isinstance(event.get("storm"), dict) else {}
        inner = source_class(str(storm.get("source") or ""))
        return HUMAN_ACTION_DIGEST if inner in _OPENER_CLASSES else None
    found = source_class(source)
    if found in _OPENER_CLASSES:
        return HUMAN_ACTION
    if found not in (SUSTAIN, JOIN) or cycle is None:
        return None
    scope = class_scope(event, cycle.roster)
    if scope is None:
        return None
    # A pending or open condition answers for the event: its own scope's, or one of the same
    # instance name when its own entry is latent and the same-name rule applies.
    if phase(cycle.section().get(scope.key)) in ("pending", "open"):
        return HUMAN_ACTION
    if same_name_applies(cycle.roster, scope.name) and any(
            phase(entry) in ("pending", "open") and _entry_name(entry) == scope.name
            for entry in cycle.section().values()):
        return HUMAN_ACTION
    return None


# ---------------------------------------------------------------------------
# Stored state: validation, quarantine, rebuild, and the loss announcement.
# ---------------------------------------------------------------------------


def _event_time(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _clock_time(value: Any, now: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value <= now


def _valid_cleared(value: Any) -> bool:
    return isinstance(value, dict) and all(
        isinstance(record, dict) and _event_time(record.get("at")) and isinstance(record.get("eventId"), str)
        for record in value.values())


def valid_scope(value: Any, now: int) -> bool:
    """Whether a stored scope may be kept: a whole entry, or a scope that keeps only `clearedAt`."""
    if not isinstance(value, dict):
        return False
    if "clearedAt" in value and not _valid_cleared(value["clearedAt"]):
        return False
    if "members" not in value:
        return set(value) == {"clearedAt"} and bool(value["clearedAt"])
    members = value["members"]
    if not isinstance(members, dict) or not isinstance(value.get("instance"), str):
        return False
    for record in members.values():
        if not (isinstance(record, dict) and _event_time(record.get("firstSeenAt"))
                and _event_time(record.get("lastSeenAt")) and isinstance(record.get("role"), str)
                and isinstance(record.get("lastEventId"), str)):
            return False
    if "machine" in value and not isinstance(value["machine"], str):
        return False
    if any(name in value and not _event_time(value[name]) for name in (*_EVENT_TIME_FIELDS, *_COUNT_FIELDS)):
        return False
    if any(name in value and not _clock_time(value[name], now) for name in _CLOCK_FIELDS):
        return False
    return value.get("openedAt") is None or "openedSeenAt" in value


def _quarantine(cycle: Cycle, key: str | None, value: Any) -> None:
    """Copy what is dropped, first: at most five losses, each value cut to 4,096 characters of its JSON text."""
    held = cycle.state.get(QUARANTINE)
    held = list(held) if isinstance(held, list) else []
    try:
        text = json.dumps(value, sort_keys=True)
    except (TypeError, ValueError):
        text = repr(value)
    loss: dict[str, Any] = {"detectedAt": cycle.now_s(), "value": text[:QUARANTINE_VALUE_CHARS]}
    if key is not None:
        loss["scope"] = key[:200]
    cycle.state[QUARANTINE] = (held + [loss])[-QUARANTINE_MAX:]
    cycle.changed = True


def load_section(cycle: Cycle) -> None:
    """Validate the stored section entry by entry, at the start of a cycle.

    A valid entry is kept unchanged. A malformed one is quarantined and dropped, then rebuilt
    from the open incidents where that is possible, and the loss is announced.
    """
    stored = cycle.state.get(SECTION)
    if stored is None:
        return
    now = cycle.now_s()
    lost: list[str] | None
    if not isinstance(stored, dict):
        _quarantine(cycle, None, stored)
        cycle.state[SECTION] = {}
        lost = None  # the whole section
    else:
        lost = [key for key, value in stored.items() if not (isinstance(key, str) and valid_scope(value, now))]
        for key in lost:
            _quarantine(cycle, key if isinstance(key, str) else None, stored[key])
            del stored[key]
        if not lost:
            return
    rebuilt = _rebuild(cycle, lost)
    _note_loss(cycle, lost, rebuilt)
    if not cycle.state.get(SECTION):
        cycle.state.pop(SECTION, None)


def _rebuild(cycle: Cycle, lost: list[str] | None) -> set[str]:
    """Turn the open incidents of member sources back into members of the lost scopes."""
    incidents = cycle.state.get("openIncidents")
    rebuilt: set[str] = set()
    if not isinstance(incidents, dict):
        return rebuilt
    kept = set(cycle.section())
    now = cycle.now_us()
    found: list[tuple[int, Scope, str, str, str]] = []
    for incident_key, record in incidents.items():
        machine, _, rest = str(incident_key).partition("|")
        instance, _, source = rest.partition("|")
        member_class = source_class(source)
        if member_class not in _MEMBER_CLASSES or not isinstance(record, dict):
            continue
        scope = class_scope({"machine": machine, "instance": instance, "source": source}, cycle.roster)
        if scope is None or scope.key in kept or (lost is not None and scope.key not in lost):
            continue
        opened = record.get("openedAt")
        at = min(opened * _MICRO, now) if _event_time(opened) else now
        found.append((at, scope, source, member_class, str(record.get("eventId") or "")))
    for at, scope, source, member_class, event_id in sorted(found, key=lambda item: (item[0], item[1].key, item[2])):
        _apply_alert(cycle, scope, source, member_class, at, True, event_id, digest=_event_digest(event_id, None))
        rebuilt.add(scope.key)
    for key in rebuilt:
        # A condition rebuilt again inside the interval takes its page fields from the loss record,
        # so it is paged at most once per interval however often it is lost.
        record = cycle.loss().get(key)
        if isinstance(record, dict):
            for name in _PAGE_FIELDS:
                if _clock_time(record.get(name), cycle.now_s()):
                    cycle.section()[key][name] = record[name]
    return rebuilt


def _note_loss(cycle: Cycle, lost: list[str] | None, rebuilt: set[str]) -> None:
    now = cycle.now_s()
    loss = cycle.state.get(LOSS)
    if not isinstance(loss, dict):
        loss = {}
        cycle.state[LOSS] = loss
    for key in (rebuilt if lost is None else set(lost) | rebuilt):
        record = loss.get(key) if isinstance(loss.get(key), dict) else {}
        # Not yet announced. The page fields of an earlier rebuild of this scope stay.
        record.update({"lossAt": now, "announced": False, "rebuilt": key in rebuilt})
        loss[key] = record
    announcement = loss.get(ANNOUNCEMENT)
    if _announcement_active(announcement, now):
        # Inside the interval of an announcement: announced when that interval ends.
        if lost is None:
            announcement["waitingAll"] = True
    else:
        _announce(loss, now, whole=lost is None)
    cycle.changed = True


def _announcement_active(announcement: Any, now: int) -> bool:
    return (isinstance(announcement, dict) and _clock_time(announcement.get("at"), now)
            and now - announcement["at"] < INTERVAL_SECONDS)


def _announce(loss: dict[str, Any], now: int, *, whole: bool) -> None:
    """Start one announcement for every loss not yet announced."""
    waiting = [record for key, record in loss.items()
               if key != ANNOUNCEMENT and isinstance(record, dict) and record.get("announced") is False]
    for record in waiting:
        record["announced"] = True
    loss[ANNOUNCEMENT] = {
        "at": now,
        # The number of scopes is unknown when the whole section was lost.
        "lost": None if whole else len(waiting),
        "rebuilt": sum(1 for record in waiting if record.get("rebuilt") is True),
    }


def loss_line(announcement: Mapping[str, Any]) -> str:
    lost = announcement.get("lost")
    return (f"BOT ERRORS: credential re-page state was lost for {'all' if lost is None else lost} bot(s) at "
            f"{_iso(announcement['at'] * _MICRO)}; {int(announcement.get('rebuilt') or 0)} rebuilt from open "
            "incidents — human action required: check the fleet's credential state")


def evaluate_announcement(cycle: Cycle) -> tuple[str | None, dict[str, Any] | None]:
    """The loss announcement for this cycle: (the group meta-alert's line if it is owed, the page to list).

    Each loss is announced once on both paths, at most once per interval for the whole section.
    The owner page is retried like a condition's page until a channel accepts it.
    """
    loss = cycle.loss()
    now = cycle.now_s()
    announcement = loss.get(ANNOUNCEMENT)
    outcome = cycle.outcomes.pop(ANNOUNCEMENT, None)
    if not isinstance(announcement, dict) or not _clock_time(announcement.get("at"), now):
        if not _loss_waits(loss):
            _prune_loss(cycle, now)
            return None, None
        # A loss is recorded and its announcement cannot be read: announce it now.
        _announce(loss, now, whole=False)
        announcement = loss[ANNOUNCEMENT]
        cycle.changed = True
    elif outcome is not None:
        _apply_outcome(announcement, outcome)
        if outcome.get("result") == ACCEPTED:
            announcement["pagedAt"] = outcome["attemptAt"]
        cycle.changed = True
    if now - announcement["at"] >= INTERVAL_SECONDS and _loss_waits(loss):
        # The interval of the last announcement has ended: one announcement for what was lost inside it.
        _announce(loss, now, whole=announcement.get("waitingAll") is True)
        announcement = loss[ANNOUNCEMENT]
        cycle.changed = True
    line = loss_line(announcement)
    group_line = None if announcement.get("groupAlerted") else line
    page = None
    if announcement.get("pagedAt") is None and cycle.owner_route_enabled and _page_due(announcement, now):
        before = _write_floor(announcement, now)
        cycle.changed = True
        page = {"scope": ANNOUNCEMENT, "line": line, "body": line, "attemptAt": now, "before": before,
                "count": int(announcement.get("count") or 0),
                "failedAttempts": int(announcement.get("failedAttempts") or 0), "hours": 0}
    _prune_loss(cycle, now)
    return group_line, page


def mark_group_alerted(cycle: Cycle) -> None:
    announcement = cycle.loss().get(ANNOUNCEMENT)
    if isinstance(announcement, dict):
        announcement["groupAlerted"] = True
        cycle.changed = True


def _loss_waits(loss: Mapping[str, Any]) -> bool:
    """Whether a loss inside the last announcement's interval is still to be announced."""
    announcement = loss.get(ANNOUNCEMENT)
    if isinstance(announcement, dict) and announcement.get("waitingAll") is True:
        return True
    return any(key != ANNOUNCEMENT and isinstance(record, dict) and record.get("announced") is False
               for key, record in loss.items())


def _prune_loss(cycle: Cycle, now: int) -> None:
    """Drop loss records whose times are all older than one interval."""
    loss = cycle.state.get(LOSS)
    if not isinstance(loss, dict):
        return
    for key in list(loss):
        record = loss[key]
        if key == ANNOUNCEMENT:
            stale = not isinstance(record, dict) or not _clock_time(record.get("at"), now)
            # Kept until both paths have announced it and its interval has ended. With the owner
            # route off there is no page to wait for.
            done = not stale and record.get("groupAlerted") is True and (
                record.get("pagedAt") is not None or not cycle.owner_route_enabled)
            if stale or (done and now - record["at"] >= INTERVAL_SECONDS and not _loss_waits(loss)):
                del loss[key]
                cycle.changed = True
            continue
        times = [record.get(name) for name in ("lossAt", "lastPageAt", "prevPageAt", "lastAttemptAt")] \
            if isinstance(record, dict) else []
        if all(not _clock_time(value, now) or now - value >= INTERVAL_SECONDS for value in times):
            del loss[key]
            cycle.changed = True
    if not loss:
        del cycle.state[LOSS]
        cycle.changed = True


def meta_alert_due(cycle: Cycle, name: str, day: str) -> bool:
    """Whether the class's daily group meta-alert `name` is owed for UTC `day`."""
    days = cycle.state.get(ALERT_DAYS)
    return not isinstance(days, dict) or days.get(name) != day


def mark_meta_alerted(cycle: Cycle, name: str, day: str) -> None:
    days = cycle.state.get(ALERT_DAYS)
    if not isinstance(days, dict):
        days = {}
        cycle.state[ALERT_DAYS] = days
    days[name] = day
    cycle.changed = True


def owe_meta_alert(cycle: Cycle, name: str, day: str) -> None:
    """Owe the daily group meta-alert `name` for UTC `day`, unless a channel already took it that day.

    Stored in the state with the time it was first owed, so neither a budget cut, a refusal nor a
    restart drops it. It stays owed until a channel takes it or the day ends, whether or not its cause
    is still there.
    """
    if not meta_alert_due(cycle, name, day):
        return
    owed = cycle.state.get(ALERTS_OWED)
    if not isinstance(owed, dict):
        owed = cycle.state[ALERTS_OWED] = {}
    entry = owed.get(name)
    if not isinstance(entry, dict) or entry.get("day") != day:
        owed[name] = {"day": day, "at": cycle.now_s()}
        cycle.changed = True


# An owed alert's time is written in the pass that owes it, so it lies in its own UTC day. A day of
# slack on each side covers the moment between reading the day and the time, and a clock step; any
# other value is malformed, and one far outside it cannot even be formatted (time.gmtime raises).
_OWED_AT_SLACK_SECONDS = 86_400


def _owed_at_ok(at: Any, day: str) -> bool:
    """Whether `at` is a time an alert owed for UTC `day` can carry."""
    if not isinstance(at, int):
        return False
    start = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    return start - _OWED_AT_SLACK_SECONDS <= at < start + 86_400 + _OWED_AT_SLACK_SECONDS


def owed_meta_alerts(cycle: Cycle, day: str) -> list[tuple[str, int]]:
    """The daily group meta-alerts owed for UTC `day` and not yet taken, with the time each was first owed.

    In listing order. One owed for an earlier day has ended its window, one a channel took is done,
    and a malformed one (a time outside a day of its own day, or a name that is no daily alert; only a
    manual edit makes one) cannot be read: all three are dropped.
    """
    if ALERTS_OWED not in cycle.state:
        return []
    owed = cycle.state[ALERTS_OWED]
    if not isinstance(owed, dict):
        del cycle.state[ALERTS_OWED]
        cycle.changed = True
        return []
    for name in list(owed):
        entry = owed[name]
        if (not isinstance(entry, dict) or name not in DAILY_META_ALERTS or not _owed_at_ok(entry.get("at"), day)
                or entry.get("day") != day or not meta_alert_due(cycle, name, day)):
            del owed[name]
            cycle.changed = True
    if not owed:
        del cycle.state[ALERTS_OWED]
        cycle.changed = True
    return [(name, owed[name]["at"]) for name in DAILY_META_ALERTS if name in owed]
