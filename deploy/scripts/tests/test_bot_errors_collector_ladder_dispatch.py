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
- with relay-flap coalescing off, tier 3 pages critical at entry;
- the critical lands within the dispatcher's promote window plus 900 s for
  any window, since the collector no longer reads that setting;
- re-assertions queued while the dispatcher is down open no flap storm when
  its real ``flap_scan_outbox`` pass runs over them;
- a record held at warning before deploy promotes at critical.

Both modules share one simulated clock, which also drives every event
timestamp. Neutral fixtures only: host-a, host-b.
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
    "BOT_ERRORS_FLAP_TRIP_THRESHOLD",
    "BOT_ERRORS_FLAP_WINDOW_SECONDS",
    "BOT_ERRORS_FLAP_STABLE_SECONDS",
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
    """The real time module, except time() and gmtime() follow the scenario clock."""

    def __init__(self, clock: FakeCollectorClock) -> None:
        self._clock = clock

    def time(self) -> float:
        return float(self._clock.now)

    def gmtime(self, seconds: float | None = None) -> time.struct_time:
        return time.gmtime(self._clock.now if seconds is None else seconds)

    def __getattr__(self, name: str):
        return getattr(time, name)


class _InMemoryIncidentCycle:
    """The ``incident`` argument flap_scan_outbox takes: a payload and a commit."""

    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def commit(self) -> None:
        pass


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_ladder_dispatcher", _DISPATCHER_SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


class _Ladder:
    """One remote, the real collector, and the dispatcher's decision path."""

    def __init__(self, tmp_path: Path, monkeypatch, *, policy: dict[str, str] | None = None,
                 diagnostics: dict[str, str] | None = None, flap_scan: bool = False) -> None:
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
        self.clock = FakeCollectorClock(int(time.time()))
        self.start = self.clock.now
        monkeypatch.setattr(self.dispatcher, "time", _SimulatedTime(self.clock))
        # Storm alerts from the flap scan are sent directly, not queued.
        self.storm_sends: list[str] = []
        monkeypatch.setattr(self.dispatcher, "send_whatsapp",
                            lambda text, *args, **kwargs: self.storm_sends.append(text))
        self.incident_state: dict = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
        self.delivered: list[dict] = []
        self.failing = True
        self.diagnostics = dict(diagnostics or {})
        # With flap_scan on, each dispatcher pass first runs the real
        # flap_scan_outbox over the outbox, then dispatches and removes the
        # new events, as run_once does. While paused (the dispatcher is down)
        # new events stay queued in the outbox.
        self.flap_scan = flap_scan
        self.paused = False
        self.queued: list[Path] = []
        self.dispatched_dir = tmp_path / "dispatched"
        self.dispatched_dir.mkdir(mode=0o700)

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

    def _process(self, new_paths: list[Path]) -> None:
        """One dispatcher pass over `new_paths`, in outbox filename order."""
        if self.flap_scan:
            # In-memory incident state stands in for the session cycle, so
            # the scan reads and updates the same state _dispatch uses.
            cycle = _InMemoryIncidentCycle(self.incident_state)
            self.dispatcher.flap_scan_outbox(self.dispatcher.setup_dirs(), cycle)
        for path in sorted(new_paths):
            self._dispatch(json.loads(path.read_text()))
            if self.flap_scan:
                path.rename(self.dispatched_dir / path.name)

    def resume(self) -> None:
        """The dispatcher comes back and processes the queue in one pass."""
        self.paused = False
        queued, self.queued = self.queued, []
        with _env(self.state_dir, self.outbox_dir):
            self._process(queued)

    def poll_until(self, offset: int) -> None:
        """Poll every 30 s while the scenario offset is below `offset`."""
        with _env(self.state_dir, self.outbox_dir), \
             patch.object(self.collector, "ssh_json_lines", side_effect=self._ssh), \
             patch.object(self.collector, "remote_failure_context", side_effect=self._failure_context), \
             _patched_collector_clock(self.collector, self.clock):
            while self.clock.now - self.start < offset:
                before = {p.name for p in self.outbox_dir.glob("*.json")}
                _run_once_defaults(self.collector, [REMOTE])
                new_paths = [p for p in self.outbox_dir.glob("*.json") if p.name not in before]
                if self.paused:
                    self.queued.extend(new_paths)
                else:
                    self._process(new_paths)
                self.clock.advance(POLL_SECONDS)

    def shape(self) -> list[tuple[str, str, str]]:
        # Sorted: events of one cycle share a createdAt second, and the
        # outbox filename then orders them by source name, not by emission.
        return sorted((d["source"], d["eventType"], d["severity"]) for d in self.delivered)

    def relay_down_events(self, directory: Path) -> list[dict]:
        return [event for event in (json.loads(p.read_text()) for p in sorted(directory.glob("*.json")))
                if event["source"] == "relay_host_down" and event["eventType"] == "alert"]

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
    # its re-assertions at +360 s and +1260 s, then promotes at +2160 s: with
    # retries capped at 900 s from tier-3 entry, the third re-assertion is
    # the first at or past the 1800 s window.
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

    # Retries are capped at 900 s from tier-3 entry, so the next attempt is
    # PROMOTED_AT + 900; it and the poll after it succeed, which meets
    # recovery_successes (2). Without the cap the next attempt would come an
    # hour after the promoting one.
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
# The critical lands within one 900 s cap of the dispatcher's promote window,
# whatever value the collector's own environment holds.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(("dispatcher_window", "collector_env", "expected_offset"), [
    pytest.param("600", "7200", TIER3_ENTRY + 1200, id="dispatcher-600s"),
    pytest.param("1800", "7200", TIER3_ENTRY + 2100, id="dispatcher-1800s-collector-env-7200s"),
    pytest.param("7200", "14400", TIER3_ENTRY + 7500, id="dispatcher-7200s-collector-env-14400s"),
])
def test_critical_lands_within_one_cap_of_the_dispatcher_promote_window(
    tmp_path, monkeypatch, dispatcher_window, collector_env, expected_offset,
):
    # The dispatcher fixes its window at import. The collector process can
    # hold a different value of the same setting (one service restarted after
    # an edit, the other not); the schedule must not depend on it. Retries
    # from tier-3 entry are +300, +1200, +2100, then every 900 s, so the
    # first re-assertion at or past the window comes at most 900 s after it.
    ladder = _Ladder(tmp_path, monkeypatch, policy={"BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS": dispatcher_window},
                     diagnostics=TIMEOUT_DIAGNOSIS)
    assert ladder.dispatcher.TRANSIENT_PROMOTE_SECONDS == int(dispatcher_window)
    monkeypatch.setenv("BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS", collector_env)
    bound = TIER3_ENTRY + int(dispatcher_window) + 900
    ladder.poll_until(bound + POLL_SECONDS)

    assert [(d["offset"], d["severity"]) for d in ladder.delivered] == [(expected_offset, "critical")]
    assert expected_offset <= bound


# ---------------------------------------------------------------------------
# Re-assertions queued while the dispatcher is down open no flap storm.
# ---------------------------------------------------------------------------

def test_queued_reassertions_open_no_flap_storm_and_the_critical_still_promotes(tmp_path, monkeypatch):
    # The dispatcher is down from the first failed poll until just after the
    # fifth re-assertion. Its first pass runs the real flap_scan_outbox over
    # tier-3 entry plus five re-assertions, all at one processing time. Only
    # entry is a new occurrence; the re-assertions are marked renotify, so
    # the scan records one trip for the key, not six, and opens no storm
    # that would consolidate the outage alert.
    ladder = _Ladder(tmp_path, monkeypatch, diagnostics=TIMEOUT_DIAGNOSIS, flap_scan=True)
    ladder.paused = True
    resume_at = TIER3_ENTRY + 3900 + POLL_SECONDS
    ladder.poll_until(resume_at)
    queued = ladder.relay_down_events(ladder.outbox_dir)
    ladder.resume()

    assert ladder.storm_sends == []
    flap_state = ladder.incident_state.get("flapState", {})
    assert [key for key, entry in flap_state.items() if entry.get("stormAt")] == []
    assert len(queued) == 6
    assert [event.get("renotify") is True for event in queued] == [False] + [True] * 5
    relay_key = ladder.dispatcher.incident_key(queued[0])
    assert flap_state[relay_key]["cumulativeCount"] == 1
    assert ladder.delivered == []

    # The hold clock starts at the dispatcher's first sight (resume_at), so
    # the first re-assertion past the 1800 s window promotes: retries keep
    # their 900 s cadence, at TIER3_ENTRY + 4800, + 5700 and + 6600.
    ladder.poll_until(resume_at + 1800 + 900 + POLL_SECONDS)

    assert [(d["offset"], d["severity"]) for d in ladder.delivered] == [(TIER3_ENTRY + 6600, "critical")]
    assert TIER3_ENTRY + 6600 <= resume_at + 1800 + 900
    assert ladder.storm_sends == []
    assert flap_state[relay_key]["cumulativeCount"] == 1


# ---------------------------------------------------------------------------
# A record held at warning before deploy promotes at critical.
# ---------------------------------------------------------------------------

def test_relay_record_held_at_warning_before_deploy_promotes_at_critical(tmp_path, monkeypatch):
    # Before the ladder change relay_host_down was emitted at warning, so a
    # record already held across the deploy carries firstSeverity "warning".
    # Promotion takes the stronger of that and the promoting event's own
    # severity, so the first critical re-assertion past the window pages.
    ladder = _Ladder(tmp_path, monkeypatch, diagnostics=TIMEOUT_DIAGNOSIS)
    ladder.poll_until(TIER3_ENTRY + POLL_SECONDS)
    relay_key = ladder.dispatcher.incident_key(ladder.relay_down_events(ladder.outbox_dir)[0])
    record = ladder.incident_state["transientState"][relay_key]
    assert record["firstSeverity"] == "critical"
    record["firstSeverity"] = "warning"
    ladder.poll_until(45 * 60)

    assert [(d["offset"], d["severity"]) for d in ladder.delivered] == [(PROMOTED_AT, "critical")]


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
