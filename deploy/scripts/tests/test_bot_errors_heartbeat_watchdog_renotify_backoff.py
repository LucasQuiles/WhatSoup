"""Renotify backoff for escalated watchdog incidents whose evidence is unchanged.

Observed on the alert host: ``session_collision:<instance>`` and ``supervision_deadman`` stayed
open for days and were re-sent as escalated criticals every 6 h
(BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS) with forceNotify, forever. Nothing new
was said after the first notice, so each re-send was noise.

Contract under test:
  * An escalated incident whose evidence fingerprint is unchanged since the
    last notice backs off: 6 h -> 12 h -> 24 h, capped by
    BOT_ERRORS_WATCHDOG_RENOTIFY_MAX_SECONDS (default 86400).
  * The fingerprint ignores values that move by themselves (``age_seconds=``
    and similar ages, ISO timestamps) but not counts.
  * Changed evidence resets the backoff and notifies on the first cycle at or
    past the base interval, so it can never exceed the old 6 h cadence.
  * ``renotifyCount`` and ``lastNotifiedEvidence`` persist on the incident;
    state files written before these fields existed still load.
  * ``session_collision:`` opens critical once; later renotifies are warnings.
  * Capacity and browser_debug keys stay warnings.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]

HOUR = 3600
CYCLE = 300
T0 = 1_790_000_000
DEADMAN_KEY = "supervision_deadman"
COLLISION_KEY = "session_collision:q"
CAPACITY_KEY = "q_loop:supervisor:capacity"
BROWSER_KEY = "browser_debug:581ff9733a39"
POINTER = "/srv/bot-errors/supervision/CURRENT.json"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog_renotify_backoff",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _write_private_json(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)
    return path


class _Session:
    """File-backed stand-in for the controller-state session."""

    def __init__(self, state_file: Path) -> None:
        self.state_file = state_file

    def load(self) -> SimpleNamespace:
        payload = json.loads(self.state_file.read_text(encoding="utf-8"))
        return SimpleNamespace(
            mode="valid",
            payload=payload,
            capability=SimpleNamespace(version=SimpleNamespace(generation=1, operation_epoch=0)),
            diagnostic=SimpleNamespace(reason=None),
        )

    def save(self, payload: Any, capability: Any) -> SimpleNamespace:
        self.state_file.write_text(json.dumps(payload, default=str), encoding="utf-8")
        self.state_file.chmod(0o600)
        return SimpleNamespace(
            capability=SimpleNamespace(version=SimpleNamespace(generation=2, operation_epoch=1)),
        )


@pytest.fixture
def env(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    outbox = tmp_path / "outbox"
    for name in (
        "BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS",
        "BOT_ERRORS_WATCHDOG_RENOTIFY_MAX_SECONDS",
        "BOT_ERRORS_WATCHDOG_ESCALATE_SECONDS",
        "BOT_ERRORS_WATCHDOG_ESCALATE_SUPPRESSED",
        "BOT_ERRORS_WATCHDOG_STALE_CONFIRMATIONS",
        "BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    monkeypatch.setenv("BOT_ERRORS_DRY_NOW", str(T0))
    state_file = _write_private_json(state / "watchdog-test-state.json", {"version": 1, "open": {}})
    return SimpleNamespace(
        mod=_load_module(),
        monkeypatch=monkeypatch,
        outbox=outbox,
        state_file=state_file,
        session=_Session(state_file),
    )


def _cycle(env, now: int, problems: dict[str, str], prefixes: list[str]) -> list[Path]:
    env.monkeypatch.setenv("BOT_ERRORS_DRY_NOW", str(now))
    loaded = env.session.load()
    return env.mod.reconcile(problems, prefixes, loaded.payload, env.session, loaded.capability)


def _events(outbox: Path) -> list[dict]:
    if not outbox.is_dir():
        return []
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(outbox.glob("*.json"))]


def _deadman_evidence(now: int) -> str:
    # The deadman's real evidence shape: age_seconds rises every cycle.
    age = now - (T0 - 3 * HOUR)
    return f"supervision checkpoint stale: age_seconds={age} max=7200 pointer={POINTER}"


COLLISION_EVIDENCE = (
    "session-sharing collision: instance=q affected_chats=1 "
    "ck=[REDACTED CONVERSATION] shared_session_id=[REDACTED SESSION]"
)


def _run_hours(env, hours: int, key: str, evidence_for, prefixes: list[str]) -> list[int]:
    """Drive 5-minute cycles for ``hours`` and return the epoch of each notice."""
    notice_times: list[int] = []
    for step in range(hours * HOUR // CYCLE + 1):
        now = T0 + step * CYCLE
        written = _cycle(env, now, {key: evidence_for(now)}, prefixes)
        if written:
            notice_times.append(now)
    return notice_times


# ---------------------------------------------------------------------------
# fingerprint
# ---------------------------------------------------------------------------

def test_fingerprint_ignores_ages_and_timestamps_but_not_counts(env):
    fp = env.mod.evidence_fingerprint
    assert fp(_deadman_evidence(T0)) == fp(_deadman_evidence(T0 + 9 * HOUR))
    assert fp("x first_seen=2026-09-20T01:02:03Z age=12") == fp("x first_seen=2026-09-25T09:08:07Z age=99")
    assert fp(COLLISION_EVIDENCE) != fp(COLLISION_EVIDENCE.replace("affected_chats=1", "affected_chats=2"))
    assert fp(_deadman_evidence(T0)) != fp(_deadman_evidence(T0).replace("max=7200", "max=3600"))


# ---------------------------------------------------------------------------
# backoff over 48 h of 5-minute cycles
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("key", "evidence_for", "prefixes"),
    [
        (DEADMAN_KEY, _deadman_evidence, ["supervision_deadman"]),
        (COLLISION_KEY, lambda _now: COLLISION_EVIDENCE, ["session_collision:"]),
    ],
    ids=["supervision_deadman", "session_collision"],
)
def test_identical_evidence_backs_off_to_at_most_four_notices_in_48h(env, key, evidence_for, prefixes):
    notice_times = _run_hours(env, 48, key, evidence_for, prefixes)

    # Today: open + a renotify every 6 h = 9 notices. With backoff: open, +6 h,
    # +12 h, +24 h -> hours 0, 6, 18, 42.
    assert len(notice_times) <= 4, [(t - T0) / HOUR for t in notice_times]
    assert [(t - T0) // HOUR for t in notice_times] == [0, 6, 18, 42]
    incident = json.loads(env.state_file.read_text())["open"][key]
    assert incident["renotifyCount"] == 3
    assert env.mod.evidence_fingerprint(incident["lastNotifiedEvidence"]) == env.mod.evidence_fingerprint(
        evidence_for(T0)
    )


def test_backoff_interval_is_capped_by_max_env(env):
    env.monkeypatch.setenv("BOT_ERRORS_WATCHDOG_RENOTIFY_MAX_SECONDS", str(12 * HOUR))
    notice_times = _run_hours(env, 48, COLLISION_KEY, lambda _now: COLLISION_EVIDENCE, ["session_collision:"])
    # 0, 6, then 12 h steps: 18, 30, 42.
    assert [(t - T0) // HOUR for t in notice_times] == [0, 6, 18, 30, 42]


def test_max_below_base_never_speeds_up_renotify(env):
    env.monkeypatch.setenv("BOT_ERRORS_WATCHDOG_RENOTIFY_MAX_SECONDS", "60")
    notice_times = _run_hours(env, 24, COLLISION_KEY, lambda _now: COLLISION_EVIDENCE, ["session_collision:"])
    assert [(t - T0) // HOUR for t in notice_times] == [0, 6, 12, 18, 24]


def _run_with_change(env, hours: int, change_hour: int) -> list[float]:
    prefixes = ["session_collision:"]
    changed = COLLISION_EVIDENCE.replace("affected_chats=1", "affected_chats=2")
    notices: list[float] = []
    for step in range(hours * HOUR // CYCLE + 1):
        now = T0 + step * CYCLE
        evidence = COLLISION_EVIDENCE if now < T0 + change_hour * HOUR else changed
        if _cycle(env, now, {COLLISION_KEY: evidence}, prefixes):
            notices.append((now - T0) / HOUR)
    return notices


def test_changed_evidence_during_backoff_renotifies_immediately(env):
    # After the 6 h notice the next unchanged notice is due at hour 18. The
    # change at hour 14 is announced on that very cycle; the backoff restarts
    # from base (20), then doubles (32).
    assert _run_with_change(env, 26, 14) == [0, 6, 14, 20]
    incident = json.loads(env.state_file.read_text())["open"][COLLISION_KEY]
    assert incident["lastNotifiedEvidence"] == COLLISION_EVIDENCE.replace("affected_chats=1", "affected_chats=2")
    assert incident["renotifyCount"] == 1


def test_changed_evidence_inside_base_interval_waits_only_for_base(env):
    # A change 2 h after a notice is announced at the base interval (hour 12),
    # not at the backed-off hour 18, and never sooner than the base: the base
    # interval is the floor so moving evidence cannot become a 5-minute storm.
    assert _run_with_change(env, 20, 8) == [0, 6, 12, 18]


def test_unchanged_control_waits_for_backoff(env):
    notice_times = _run_hours(env, 17, COLLISION_KEY, lambda _now: COLLISION_EVIDENCE, ["session_collision:"])
    assert [(t - T0) // HOUR for t in notice_times] == [0, 6]


def test_evidence_changing_every_cycle_never_exceeds_base_cadence(env):
    """A count that moves every cycle must not turn the change rule into a
    5-minute storm: the base interval is the floor."""
    key = "queue_backlog:outbox"
    notice_times = _run_hours(
        env, 24, key, lambda now: f"outbox backlog count={(now - T0) // CYCLE}", ["queue_backlog"]
    )
    assert [(t - T0) // HOUR for t in notice_times] == [0, 6, 12, 18, 24]


# ---------------------------------------------------------------------------
# severity
# ---------------------------------------------------------------------------

def test_session_collision_opens_critical_then_renotifies_as_warning(env):
    _run_hours(env, 48, COLLISION_KEY, lambda _now: COLLISION_EVIDENCE, ["session_collision:"])
    events = _events(env.outbox)
    assert [e["severity"] for e in events] == ["critical", "warning", "warning", "warning"]


def test_genuine_failure_still_escalates_critical(env):
    _run_hours(env, 24, DEADMAN_KEY, _deadman_evidence, ["supervision_deadman"])
    events = _events(env.outbox)
    assert events[0]["severity"] == "critical"
    assert all(e["severity"] == "critical" for e in events[1:])
    assert events[1]["diagnostics"]["forceNotify"] is True


@pytest.mark.parametrize(
    ("key", "prefixes", "evidence"),
    [
        (CAPACITY_KEY, ["q_loop"], "q-loop at usage-window capacity; self-recovers when window resets reason=session_limit"),
        (BROWSER_KEY, ["browser_debug:"], "browser debug session unattended: profile_hash=581ff9733a39 age_seconds=100"),
    ],
    ids=["capacity", "browser_debug"],
)
def test_nonpaging_keys_stay_warnings(env, key, prefixes, evidence):
    assert env.mod.is_nonpaging_incident_key(key)
    _run_hours(env, 24, key, lambda _now: evidence, prefixes)
    events = _events(env.outbox)
    assert len(events) >= 2
    assert {e["severity"] for e in events} == {"warning"}
    assert all("forceNotify" not in e["diagnostics"] for e in events)


# ---------------------------------------------------------------------------
# state compatibility
# ---------------------------------------------------------------------------

def test_state_without_new_fields_loads_and_renotifies(env):
    _write_private_json(
        env.state_file,
        {
            "version": 1,
            "open": {
                COLLISION_KEY: {
                    "firstSeenAt": "2026-09-20T00:00:00Z",
                    "lastSeenAt": "2026-09-20T00:00:00Z",
                    "lastNotifiedAt": "2026-09-20T00:00:00Z",
                    "lastEvidence": COLLISION_EVIDENCE,
                    "suppressed": 500,
                    "ageSeconds": 99999,
                }
            },
        },
    )
    written = _cycle(env, T0, {COLLISION_KEY: COLLISION_EVIDENCE}, ["session_collision:"])
    assert len(written) == 1
    incident = json.loads(env.state_file.read_text())["open"][COLLISION_KEY]
    assert incident["renotifyCount"] == 1
    assert incident["lastNotifiedEvidence"] == COLLISION_EVIDENCE
    # The next unchanged renotify is 12 h out, not 6 h.
    assert not _cycle(env, T0 + 6 * HOUR, {COLLISION_KEY: COLLISION_EVIDENCE}, ["session_collision:"])
    assert _cycle(env, T0 + 12 * HOUR, {COLLISION_KEY: COLLISION_EVIDENCE}, ["session_collision:"])


def test_state_with_malformed_new_fields_falls_back_to_base(env):
    _write_private_json(
        env.state_file,
        {
            "version": 1,
            "open": {
                COLLISION_KEY: {
                    "firstSeenAt": "2026-09-20T00:00:00Z",
                    "lastNotifiedAt": now_iso_for(T0 - 6 * HOUR),
                    "lastEvidence": COLLISION_EVIDENCE,
                    "suppressed": 500,
                    "renotifyCount": "garbage",
                    "lastNotifiedEvidence": {"not": "text"},
                }
            },
        },
    )
    assert len(_cycle(env, T0, {COLLISION_KEY: COLLISION_EVIDENCE}, ["session_collision:"])) == 1


def now_iso_for(epoch: int) -> str:
    import time

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def test_renotify_max_env_is_validated(env):
    env.monkeypatch.setenv("BOT_ERRORS_WATCHDOG_RENOTIFY_MAX_SECONDS", "0")
    with pytest.raises(ValueError, match="BOT_ERRORS_WATCHDOG_RENOTIFY_MAX_SECONDS"):
        env.mod.validate_thresholds()
