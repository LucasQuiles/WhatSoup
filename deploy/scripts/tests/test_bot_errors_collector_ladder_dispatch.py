"""The collector's remote-claim ladder, end to end through the dispatcher.

Each collection cycle's REAL outbox events are fed, in outbox filename order,
through the dispatcher's own decision function ``should_suppress_send``
(Pattern D transient tiering, Pattern H relay-flap hold, open-incident and
clear handling). When it returns no suppress reason the event counts as
delivered and ``mark_incident_sent`` applies the incident transition a real
delivery applies. The tests assert on what would reach the group:

- a host down past the promote window delivers exactly one critical, 36
  minutes after the first failed poll (the re-asserted relay_host_down
  promotes);
- a blip delivers no critical and no "recovered" line whose alert was never
  delivered;
- a host that recovers after promotion delivers its recovery within 15
  minutes, and a multi-hour outage stays one incident that only the
  dispatcher's normal renotify pages again;
- with relay-flap coalescing off, tier 3 pages critical at entry.

Both modules share one simulated clock. Neutral fixtures only: host-a, host-b.
"""
from __future__ import annotations

import importlib.util
import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
_CONFTEST_PATH = _TESTS_DIR / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_env = _conftest._env
_load_mod_with_dirs = _conftest._load_mod_with_dirs
_run_once_defaults = _conftest._run_once_defaults
FakeCollectorClock = _conftest.FakeCollectorClock
_patched_collector_clock = _conftest._patched_collector_clock_ns

_DISPATCHER_SCRIPT = _TESTS_DIR.parent / "bot-errors-dispatcher.py"

# Dispatcher policy that is read at import time or could reshape these
# scenarios. Each test starts from the defaults and sets only what it names.
_POLICY_ENV_KEYS = (
    "BOT_ERRORS_TRANSIENT_TIERING",
    "BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS",
    "BOT_ERRORS_TRANSIENT_SOURCES",
    "BOT_ERRORS_RELAY_FLAP_COALESCE",
    "BOT_ERRORS_MAINTENANCE_WINDOWS",
    "BOT_ERRORS_INHIBITION_ENABLED",
    "BOT_ERRORS_INHIBITION_MAP",
    "BOT_ERRORS_FLAP_DETECTION",
    "BOT_ERRORS_SEND_DAILY_HEALTH_INFO",
    "BOT_ERRORS_INCIDENT_RENOTIFY_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SUPPRESSED",
    "BOT_ERRORS_INCIDENT_COOLDOWN_SECONDS",
    "BOT_ERRORS_BEST_EFFORT_INFO_TIER",
    "BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD",
    "BOT_ERRORS_COLLECTOR_RECOVERY_SUCCESSES",
)

REMOTE = "host-a:/srv/whatsoup/bot-errors"
POLL_SECONDS = 30
# Tier 3 opens on the third failed poll.
TIER3_ENTRY = 2 * POLL_SECONDS
TIMEOUT_DIAGNOSIS = {"reachabilityDiagnosis": "tailscale_online_ssh_timeout"}


class _SimulatedTime:
    """The real time module, except time() follows the scenario clock."""

    def __init__(self, clock: FakeCollectorClock) -> None:
        self._clock = clock

    def time(self) -> float:
        return float(self._clock.now)

    def __getattr__(self, name: str):
        return getattr(time, name)


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_ladder_dispatcher", _DISPATCHER_SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


class _Ladder:
    """One remote, the real collector, and the dispatcher's decision path."""

    def __init__(self, tmp_path: Path, monkeypatch, *, policy: dict[str, str] | None = None,
                 diagnostics: dict[str, str] | None = None) -> None:
        self.state_dir = tmp_path / "bot-errors"
        self.outbox_dir = tmp_path / "outbox"
        self.state_dir.mkdir(mode=0o700)
        self.outbox_dir.mkdir(mode=0o700)
        for key in _POLICY_ENV_KEYS:
            monkeypatch.delenv(key, raising=False)
        for key, value in (policy or {}).items():
            monkeypatch.setenv(key, value)
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(self.state_dir))
        self.collector = _load_mod_with_dirs(self.state_dir, self.outbox_dir)
        self.dispatcher = _load_dispatcher()
        # Start at wall time so collector createdAt stamps and the dispatcher's
        # clock agree at the start; the scenario then advances simulated time.
        self.clock = FakeCollectorClock(int(time.time()))
        self.start = self.clock.now
        monkeypatch.setattr(self.dispatcher, "time", _SimulatedTime(self.clock))
        self.incident_state: dict = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        self.delivered: list[dict] = []
        self.failing = True
        self.diagnostics = dict(diagnostics or {})

    def _ssh(self, host, script, args, timeout):
        if self.failing:
            raise RuntimeError("ssh: connect to host host-a port 22: Connection timed out")
        return []

    def _failure_context(self, host, error=""):
        return [], dict(self.diagnostics)

    def _dispatch(self, event: dict) -> None:
        reason = self.dispatcher.should_suppress_send(event, self.incident_state)
        if reason is not None:
            return
        self.dispatcher.mark_incident_sent(event, self.incident_state)
        self.delivered.append({
            "offset": self.clock.now - self.start,
            "source": event["source"],
            "eventType": event["eventType"],
            "severity": event["severity"],
            "summary": event["summary"],
        })

    def poll_until(self, offset: int) -> None:
        """Poll every 30 s while the scenario offset is below `offset`."""
        with _env(self.state_dir, self.outbox_dir), \
             patch.object(self.collector, "ssh_json_lines", side_effect=self._ssh), \
             patch.object(self.collector, "remote_failure_context", side_effect=self._failure_context), \
             _patched_collector_clock(self.collector, self.clock):
            while self.clock.now - self.start < offset:
                before = {p.name for p in self.outbox_dir.glob("*.json")}
                _run_once_defaults(self.collector, [REMOTE])
                for path in sorted(self.outbox_dir.glob("*.json")):
                    if path.name not in before:
                        self._dispatch(json.loads(path.read_text()))
                self.clock.advance(POLL_SECONDS)

    def shape(self) -> list[tuple[str, str, str]]:
        # Sorted: two events of one cycle can land in either filename order
        # (createdAt is wall-clock seconds), and their keys are independent.
        return sorted((d["source"], d["eventType"], d["severity"]) for d in self.delivered)

    def criticals(self) -> list[dict]:
        return [d for d in self.delivered if d["severity"] == "critical"]

    def recovered_lines(self) -> list[str]:
        return [d["summary"] for d in self.delivered if "recovered" in d["summary"].lower()]


# ---------------------------------------------------------------------------
# A sustained outage pages critical, once, soon after the promote window.
# ---------------------------------------------------------------------------

def test_sustained_outage_delivers_one_critical_soon_after_the_promote_window(tmp_path, monkeypatch):
    ladder = _Ladder(tmp_path, monkeypatch)
    ladder.poll_until(45 * 60)

    # Tiers 1 and 2 (outage-class diagnosis) are delivered as warnings and
    # closed with "superseded" clears; tier 3 is held at entry (+60 s) and at
    # its re-assertions at +360 s and +1260 s, then promotes at +2160 s, the
    # attempt pulled forward to 300 s past the 1800 s window.
    assert ladder.shape() == [
        ("collector_remote_unreachable", "alert", "warning"),
        ("collector_remote_unreachable", "clear", "info"),
        ("relay_host_down", "alert", "critical"),
        ("remote-claim-failed", "alert", "warning"),
        ("remote-claim-failed", "clear", "info"),
    ]
    assert ladder.delivered[-1]["source"] == "relay_host_down"
    critical = ladder.criticals()[0]
    assert critical["offset"] == TIER3_ENTRY + 2100
    assert 30 * 60 < critical["offset"] <= 37 * 60
    assert ladder.recovered_lines() == []
    held = ladder.incident_state["transientState"]
    assert len(held) == 1 and next(iter(held.values()))["promoted"] is True


def test_sustained_outage_with_timeout_diagnosis_delivers_only_the_critical(tmp_path, monkeypatch):
    # An SSH timeout to a peer Tailscale reports online classifies transient:
    # tiers 1 and 2 are held, and their superseded clears retire them silently.
    ladder = _Ladder(tmp_path, monkeypatch, diagnostics=TIMEOUT_DIAGNOSIS)
    ladder.poll_until(45 * 60)

    assert ladder.shape() == [("relay_host_down", "alert", "critical")]
    assert ladder.delivered[0]["offset"] == TIER3_ENTRY + 2100


# ---------------------------------------------------------------------------
# A blip pages no critical and no orphan "recovered".
# ---------------------------------------------------------------------------

def test_two_minute_blip_delivers_no_critical_and_no_recovered_line(tmp_path, monkeypatch):
    ladder = _Ladder(tmp_path, monkeypatch)
    ladder.poll_until(TIER3_ENTRY + POLL_SECONDS)  # three failed polls: tier 3 opens
    ladder.failing = False                        # back two minutes after the first failure
    ladder.poll_until(TIER3_ENTRY + 300 + 2 * POLL_SECONDS)  # two successes after backoff

    assert ladder.criticals() == []
    assert ladder.recovered_lines() == []
    # The held relay_host_down retired silently on its recovery clear, and the
    # superseded clears closed tiers 1 and 2: nothing is left open or held.
    assert ladder.incident_state["openIncidents"] == {}
    assert ladder.incident_state.get("transientState", {}) == {}


def test_held_tier2_recovery_clear_is_silent(tmp_path, monkeypatch):
    # Two failed polls open tier 2, held as a transient; the next successful
    # claim sends "capture recovered", which the dispatcher retires silently
    # because the group never saw the alert.
    ladder = _Ladder(tmp_path, monkeypatch, diagnostics=TIMEOUT_DIAGNOSIS)
    ladder.poll_until(2 * POLL_SECONDS)
    ladder.failing = False
    ladder.poll_until(3 * POLL_SECONDS)

    assert ladder.delivered == []
    assert ladder.incident_state["openIncidents"] == {}
    assert ladder.incident_state.get("transientState", {}) == {}


def test_delivered_tier2_recovery_clear_is_delivered(tmp_path, monkeypatch):
    # Control for the test above: when the tier-2 alert WAS delivered (an
    # outage-class failure), its "capture recovered" clear is delivered too.
    # A recovered line in the group therefore always follows a delivered
    # "cannot capture remote outbox" warning for the same remote.
    ladder = _Ladder(tmp_path, monkeypatch)
    ladder.poll_until(2 * POLL_SECONDS)
    ladder.failing = False
    ladder.poll_until(3 * POLL_SECONDS)

    assert ladder.shape() == [
        ("collector_remote_unreachable", "alert", "warning"),
        ("collector_remote_unreachable", "clear", "info"),
        ("remote-claim-failed", "alert", "warning"),
        ("remote-claim-failed", "clear", "info"),
    ]
    tier2_alert = [d for d in ladder.delivered
                   if d["source"] == "collector_remote_unreachable" and d["eventType"] == "alert"]
    assert tier2_alert[0]["summary"] == f"BOT ERRORS collector cannot capture remote outbox: {REMOTE}"
    assert ladder.recovered_lines() == [f"BOT ERRORS collector remote capture recovered: {REMOTE}"]


# ---------------------------------------------------------------------------
# A host that recovers after promotion sends its recovery, within 15 minutes.
# ---------------------------------------------------------------------------

PROMOTED_AT = TIER3_ENTRY + 2100  # offset of the delivered critical


def test_host_back_five_minutes_after_the_critical_clears_within_fifteen(tmp_path, monkeypatch):
    ladder = _Ladder(tmp_path, monkeypatch, diagnostics=TIMEOUT_DIAGNOSIS)
    back_at = PROMOTED_AT + 300
    ladder.poll_until(back_at)
    assert ladder.shape() == [("relay_host_down", "alert", "critical")]
    assert ladder.delivered[0]["offset"] == PROMOTED_AT

    # After the promoting attempt the retry interval is capped at 900 s, so
    # the next attempt is PROMOTED_AT + 900; it and the poll after it succeed,
    # which meets recovery_successes (2). Before the cap the next attempt was
    # an hour after the promoting one.
    ladder.failing = False
    ladder.poll_until(back_at + 15 * 60)

    assert ladder.shape() == [
        ("relay_host_down", "alert", "critical"),
        ("relay_host_down", "clear", "info"),
    ]
    recovery = ladder.delivered[-1]
    assert "recovered" in recovery["summary"]
    assert recovery["offset"] == PROMOTED_AT + 900 + POLL_SECONDS
    assert recovery["offset"] - back_at <= 15 * 60
    assert ladder.incident_state["openIncidents"] == {}
    assert ladder.incident_state.get("transientState", {}) == {}


def test_multi_hour_outage_is_one_incident_paged_only_by_the_normal_renotify(tmp_path, monkeypatch):
    # Seven hours down. After promotion the host is re-asserted every 900 s;
    # each re-assertion is a duplicate of the one open incident. The only
    # further page is the dispatcher's own still-open renotify, due
    # BOT_ERRORS_INCIDENT_RENOTIFY_SECONDS (6 h) after the critical.
    ladder = _Ladder(tmp_path, monkeypatch, diagnostics=TIMEOUT_DIAGNOSIS)
    ladder.poll_until(7 * 3600)

    assert [(d["offset"], d["severity"]) for d in ladder.delivered] == [
        (PROMOTED_AT, "critical"),
        (PROMOTED_AT + 6 * 3600, "critical"),
    ]
    assert "still-open" in ladder.delivered[1]["summary"].lower()
    open_incidents = ladder.incident_state["openIncidents"]
    assert len(open_incidents) == 1
    (record,) = open_incidents.values()
    # Every re-assertion after promotion (each 900 s from PROMOTED_AT + 900
    # up to 7 h) counts as a duplicate, including the one delivered as the
    # renotify: 25 here, so the 72-duplicate escalation is about 18 h out.
    reassertions_after_promotion = (7 * 3600 - 1 - PROMOTED_AT) // 900
    assert reassertions_after_promotion == 25
    assert record["suppressedCount"] == reassertions_after_promotion


# ---------------------------------------------------------------------------
# Relay-flap coalescing off: tier 3 is an outage at entry.
# ---------------------------------------------------------------------------

def test_relay_flap_coalesce_off_pages_critical_at_tier3_entry(tmp_path, monkeypatch):
    ladder = _Ladder(tmp_path, monkeypatch, policy={"BOT_ERRORS_RELAY_FLAP_COALESCE": "0"},
                     diagnostics=TIMEOUT_DIAGNOSIS)
    ladder.poll_until(45 * 60)

    # Delivered once at entry; the re-assertions are duplicates of the open
    # incident and are suppressed.
    assert ladder.shape() == [("relay_host_down", "alert", "critical")]
    assert ladder.delivered[0]["offset"] == TIER3_ENTRY


# ---------------------------------------------------------------------------
# Recovery dedupe keeps per-remote identity.
# ---------------------------------------------------------------------------

def test_capture_recovered_clears_of_two_remotes_are_not_recovery_duplicates(tmp_path, monkeypatch):
    # suppress_ready_recovery_duplicates drops a clear whose duplicate
    # fingerprint matches one kept inside the window. Two remotes' clears in
    # the same window must not merge, or one remote's incident would stay open.
    ladder = _Ladder(tmp_path, monkeypatch)
    with _env(ladder.state_dir, ladder.outbox_dir), _patched_collector_clock(ladder.collector, ladder.clock):
        for remote in (REMOTE, "host-b:/srv/whatsoup/bot-errors"):
            ladder.collector.emit_collector_capture_escalation_event(
                remote, "clear", consecutive_failures=0, threshold=2, last_success_age_seconds=0,
            )
    clears = [json.loads(p.read_text()) for p in sorted(ladder.outbox_dir.glob("*.json"))]
    assert len(clears) == 2
    dispatcher = ladder.dispatcher
    assert all(dispatcher.is_recovery_dedupe_candidate(c) for c in clears)
    assert len({dispatcher.recovery_duplicate_fingerprint(c) for c in clears}) == 2
    assert len({dispatcher.incident_key(c) for c in clears}) == 2
