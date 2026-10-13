import importlib.util
import json
import sys
import time
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import pytest
from hypothesis import example, given, strategies as st


SCRIPT = Path(__file__).resolve().parents[1] / "fleet_reliability_observer.py"


def load_module():
    spec = importlib.util.spec_from_file_location("fleet_reliability_observer", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def observer():
    return load_module()


@pytest.fixture
def config(tmp_path):
    return {
        "state_dir": str(tmp_path / "state"),
        "instance": "fleet-test",
        "emitter_command": ["/bin/false"],
        "delivery_command": ["/bin/false"],
        "hosts": [
            {"host": "alpha", "instance": "alpha-i", "probe_command": ["/bin/true"]}
        ],
        "probe_timeout_seconds": 0.2,
        "freshness_seconds": 1200,
    }


def probe(checked_at, checks, instances=None, evidence=None, retired_checks=None):
    payload = {"checked_at": checked_at, "checks": checks, "codes": ["probe_code"]}
    if instances is not None:
        payload["instances"] = instances
    if evidence is not None:
        payload["evidence"] = evidence
    if retired_checks is not None:
        payload["retired_checks"] = retired_checks
    return payload


def run(observer, config, now, results, events):
    return observer.run_once(
        config,
        now=now,
        probe=lambda host, timeout: results[host["host"]],
        emit=lambda event: (
            events.append(event) or {"published": True, "file": "event.json"}
        ),
        resolve_delivery=lambda alerts: None,
    )


def test_recovery_never_clears_capability_incident_on_stale_missing_or_unreachable(
    observer, config
):
    events = []
    bad = {"alpha": probe(100, {"token": False})}
    run(observer, config, 100, bad, events)
    state = run(observer, config, 101, bad, events)
    assert [(x["kind"], x["reason"]) for x in events] == [
        ("alert", "fleet_alpha_token")
    ]
    for result in (
        {"alpha": probe(-2000, {"token": True})},
        {"alpha": {"checks": {"token": True}}},
        {"alpha": None},
    ):
        state = run(observer, config, 102, result, events)
        assert "token" in state["hosts"]["alpha"]["incidents"]
    state = run(observer, config, 103, {"alpha": probe(103, {"token": True})}, events)
    assert "token" not in state["hosts"]["alpha"]["incidents"]
    assert [x["kind"] for x in events if x["reason"] == "fleet_alpha_token"] == [
        "alert",
        "clear",
    ]


def test_initial_unreachable_alerts_and_retries_same_persisted_event_id(
    observer, config
):
    emitted = []
    for now in (1, 2):
        state = observer.run_once(
            config,
            now=now,
            probe=lambda *_: None,
            emit=lambda _: {"published": False},
            resolve_delivery=lambda _: None,
        )
    assert len(state["pending_events"]) == 1
    event_id = state["pending_events"][0]["event_id"]
    state = observer.run_once(
        config,
        now=3,
        probe=lambda *_: None,
        emit=lambda event: emitted.append(event) or {"published": True},
        resolve_delivery=lambda _: None,
    )
    assert emitted[0]["event_id"] == event_id
    assert state["pending_events"] == []


def test_probe_timeout_kills_a_sleeping_child_process_group(observer, tmp_path):
    sleeper = tmp_path / "sleeper.py"
    sleeper.write_text("import time; time.sleep(30)\n")
    started = time.monotonic()
    result = observer.run_probe([sys.executable, str(sleeper)], 0.15)
    assert result is None
    assert time.monotonic() - started < 1


def test_corrupt_state_fails_closed(observer, config):
    directory = Path(config["state_dir"])
    directory.mkdir(mode=0o700)
    path = directory / "fleet-observer.json"
    path.write_text("not json")
    path.chmod(0o600)
    with pytest.raises(observer.supervisor.StateError):
        observer.run_once(
            config,
            now=1,
            probe=lambda *_: None,
            emit=lambda _: {},
            resolve_delivery=lambda _: None,
        )
    assert path.read_text() == "not json"


def test_watchdog_alerts_on_staleness_and_recovers_only_after_completed_cycle(
    observer, config
):
    events = []
    state = observer.run_watchdog(
        config,
        now=1300,
        emit=lambda e: events.append(e) or {"published": True},
        resolve_delivery=lambda _: None,
    )
    assert "observer_stale" in state["incidents"]
    observer.run_once(
        config,
        now=1301,
        probe=lambda *_: probe(1301, {"token": True}),
        emit=lambda _: {"published": True},
        resolve_delivery=lambda _: None,
    )
    state = observer.run_watchdog(
        config,
        now=1302,
        emit=lambda e: events.append(e) or {"published": True},
        resolve_delivery=lambda _: None,
    )
    assert "observer_stale" not in state["incidents"]
    assert [event["kind"] for event in events] == ["alert", "clear"]


def test_delivery_outage_keeps_published_alerts_and_records_stale_delivery(
    observer, config
):
    events = []
    bad = {"alpha": probe(1, {"token": False})}
    run(observer, config, 1, bad, events)
    state = run(observer, config, 2, bad, events)
    assert state["alerts"][0]["delivery"] == "locally_persisted"
    state = run(observer, config, 1003, bad, events)
    assert state["alerts"][0]["delivery"] == "locally_persisted"
    assert "token" in state["hosts"]["alpha"]["incidents"]


def test_watchdog_detects_stalled_delivery_even_when_observer_is_fresh(
    observer, config
):
    events = []
    bad = {"alpha": probe(1, {"token": False})}
    run(observer, config, 1, bad, events)
    run(observer, config, 2, bad, events)
    run(observer, config, 1303, {"alpha": probe(1303, {"token": False})}, events)
    state = observer.run_watchdog(
        config,
        now=1304,
        emit=lambda e: events.append(e) or {"published": True},
        resolve_delivery=lambda _: None,
    )
    assert "alert_delivery_stale" in state["incidents"]
    assert "observer_stale" not in state["incidents"]

    def delivered(alerts):
        for alert in alerts:
            alert["delivery"] = "channel_delivered"

    state = observer.run_watchdog(
        config,
        now=1305,
        emit=lambda e: events.append(e) or {"published": True},
        resolve_delivery=delivered,
    )
    assert "alert_delivery_stale" not in state["incidents"]
    assert [(e["kind"], e["reason"]) for e in events[-2:]] == [
        ("alert", "fleet_alert_delivery_stale"),
        ("clear", "fleet_alert_delivery_stale"),
    ]


def test_unacknowledged_delivery_records_are_kept_within_the_undelivered_bound(
    observer, config
):
    directory = Path(config["state_dir"])
    directory.mkdir(mode=0o700)
    path = directory / "fleet-observer.json"
    state = {
        "alerts": [
            {"event_id": str(i), "delivery": "locally_persisted", "published_at": 1}
            for i in range(150)
        ],
        "pending_events": [],
    }
    observer._flush(config, state, path, 1300, lambda _: {}, lambda _: None)
    assert len(state["alerts"]) == 150


def test_live_probe_timestamp_is_compared_after_the_probe(
    observer, config, monkeypatch
):
    clock = [100.0]
    monkeypatch.setattr(observer.time, "time", lambda: clock[0])

    def live_probe(*_):
        clock[0] = 105.0
        return probe(105.0, {"token": True})

    state = observer.run_once(
        config, probe=live_probe, emit=lambda _: {}, resolve_delivery=lambda _: None
    )
    assert state["hosts"]["alpha"]["last_status"] == "fresh"
    assert state["completed_at"] == 105.0


def test_missing_check_opens_unverified_incident_without_clearing_original(
    observer, config
):
    events = []
    for now in (1, 2):
        run(observer, config, now, {"alpha": probe(now, {"token": False})}, events)
    for now in (3, 4):
        state = run(observer, config, now, {"alpha": probe(now, {})}, events)
    assert "token" in state["hosts"]["alpha"]["incidents"]
    assert any("unverified" in e["reason"] for e in events)
    assert state["hosts"]["alpha"]["checks"]["token"]["last_result"] is None


def test_unknown_breaks_consecutive_failure_streak(observer, config):
    events = []
    run(observer, config, 1, {"alpha": probe(1, {"token": False})}, events)
    run(observer, config, 2, {"alpha": None}, events)
    state = run(observer, config, 3, {"alpha": probe(3, {"token": False})}, events)
    assert "token" not in state["hosts"]["alpha"]["incidents"]


def published_severity(observer, monkeypatch, event):
    """Return the --severity argv value publish_event hands to the emitter."""
    captured = []

    class Result:
        returncode = 0
        stdout = b"/tmp/event.json\n"

    def fake_run_command(command, timeout):
        captured.append(command)
        return Result()

    monkeypatch.setattr(observer.supervisor, "run_command", fake_run_command)
    receipt = observer.supervisor.publish_event(
        {"emitter_command": ["/bin/emit"], "instance": "alpha-i"}, event
    )
    assert receipt["published"] is True
    argv = captured[0]
    return argv[argv.index("--severity") + 1]


def test_single_unknown_sample_then_recovery_emits_nothing(observer, config):
    # One stale-evidence sample (None) followed by True is the 15-minute flap
    # that produced alert/clear pairs; it must stay silent.
    events = []
    run(observer, config, 1, {"alpha": probe(1, {"model": True})}, events)
    state = run(observer, config, 2, {"alpha": probe(2, {"model": None})}, events)
    assert "model_unverified" not in state["hosts"]["alpha"]["incidents"]
    state = run(observer, config, 3, {"alpha": probe(3, {"model": True})}, events)
    assert events == []
    assert state["hosts"]["alpha"]["checks"]["model"]["none_count"] == 0
    assert state["hosts"]["alpha"]["checks"]["model"]["false_count"] == 0


def test_two_consecutive_unknown_samples_open_unverified_as_warning(
    observer, config, monkeypatch
):
    events = []
    run(observer, config, 1, {"alpha": probe(1, {"model": None})}, events)
    assert events == []
    state = run(observer, config, 2, {"alpha": probe(2, {"model": None})}, events)
    assert [(e["kind"], e["reason"]) for e in events] == [
        ("alert", "fleet_alpha_model_unverified")
    ]
    assert events[0]["severity"] == "warning"
    assert "model_unverified" in state["hosts"]["alpha"]["incidents"]
    assert published_severity(observer, monkeypatch, events[0]) == "warning"
    run(observer, config, 3, {"alpha": probe(3, {"model": True})}, events)
    assert [(e["kind"], e["reason"]) for e in events[1:]] == [
        ("clear", "fleet_alpha_model_unverified")
    ]
    assert published_severity(observer, monkeypatch, events[1]) == "info"


def test_two_consecutive_false_samples_still_open_critical(
    observer, config, monkeypatch
):
    events = []
    run(observer, config, 1, {"alpha": probe(1, {"model": False})}, events)
    assert events == []
    run(observer, config, 2, {"alpha": probe(2, {"model": False})}, events)
    assert [(e["kind"], e["reason"]) for e in events] == [
        ("alert", "fleet_alpha_model")
    ]
    assert events[0]["severity"] == "critical"
    assert published_severity(observer, monkeypatch, events[0]) == "critical"


def test_state_from_previous_schema_loads_and_keeps_open_incidents(
    observer, config, monkeypatch
):
    # Shape written by release 20260919-f165d55-model-health: no none_count on
    # check records and no severity on queued events.
    directory = Path(config["state_dir"])
    directory.mkdir(mode=0o700)
    path = directory / "fleet-observer.json"
    legacy_pending = {
        "event_id": "legacy-event",
        "incident_id": "legacy-incident",
        "kind": "alert",
        "reason": "fleet_alpha_model_unverified",
        "host": "alpha",
        "instance": "alpha-i",
        "created_at": 0,
    }
    path.write_text(
        observer.json.dumps(
            {
                "schema_version": 1,
                "started_at": 0,
                "completed_at": 0,
                "hosts": {
                    "alpha": {
                        "checks": {"model": {"false_count": 0, "last_result": None}},
                        "incidents": {"model_unverified": "legacy-incident"},
                        "unverified": None,
                        "last_status": "fresh",
                    }
                },
                "pending_events": [legacy_pending],
                "alerts": [],
            }
        )
    )
    path.chmod(0o600)
    events = []
    state = run(observer, config, 1, {"alpha": probe(1, {"model": None})}, events)
    assert [e["event_id"] for e in events] == ["legacy-event"]
    assert published_severity(observer, monkeypatch, legacy_pending) == "critical"
    record = state["hosts"]["alpha"]
    assert record["incidents"] == {"model_unverified": "legacy-incident"}
    assert record["checks"]["model"]["none_count"] == 1
    state = run(observer, config, 2, {"alpha": probe(2, {"model": True})}, events)
    assert [(e["kind"], e["incident_id"]) for e in events[1:]] == [
        ("clear", "legacy-incident")
    ]
    assert state["hosts"]["alpha"]["incidents"] == {}


def test_ssh_unreachable_stays_critical_and_other_checks_debounce(
    observer, config, monkeypatch
):
    events = []
    healthy = {"ssh_reachable": True, "model": True}
    run(observer, config, 1, {"alpha": probe(1, healthy)}, events)
    down = {"ssh_reachable": False}
    run(observer, config, 2, {"alpha": probe(2, down)}, events)
    assert events == []
    run(observer, config, 3, {"alpha": probe(3, down)}, events)
    by_reason = {e["reason"]: e for e in events}
    assert set(by_reason) == {
        "fleet_alpha_ssh_reachable",
        "fleet_alpha_model_unverified",
    }
    ssh_alert = by_reason["fleet_alpha_ssh_reachable"]
    assert ssh_alert["severity"] == "critical"
    assert published_severity(observer, monkeypatch, ssh_alert) == "critical"
    assert by_reason["fleet_alpha_model_unverified"]["severity"] == "warning"


def probe_events(events):
    return [
        (e["kind"], e["severity"])
        for e in events
        if e["reason"] == "fleet_alpha_probe_unverified"
    ]


def test_single_failed_probe_then_success_opens_no_host_incident(observer, config):
    events = []
    state = run(observer, config, 1, {"alpha": None}, events)
    assert state["hosts"]["alpha"]["unverified"] is None
    assert state["hosts"]["alpha"]["probe_failure_count"] == 1
    state = run(observer, config, 2, {"alpha": probe(2, {"token": True})}, events)
    assert probe_events(events) == []
    assert state["hosts"]["alpha"]["probe_failure_count"] == 0


def test_two_failed_or_stale_probes_open_critical_host_incident(
    observer, config, monkeypatch
):
    events = []
    run(observer, config, 1, {"alpha": None}, events)
    # A stale payload counts the same as a failed probe.
    state = run(observer, config, 2000, {"alpha": probe(1, {"token": True})}, events)
    assert probe_events(events) == [("alert", "critical")]
    incident_id = state["hosts"]["alpha"]["unverified"]
    assert incident_id
    alert = [e for e in events if e["reason"] == "fleet_alpha_probe_unverified"][0]
    assert published_severity(observer, monkeypatch, alert) == "critical"
    state = run(observer, config, 2001, {"alpha": None}, events)
    assert state["hosts"]["alpha"]["unverified"] == incident_id
    assert probe_events(events) == [("alert", "critical")]
    state = run(observer, config, 2002, {"alpha": probe(2002, {"token": True})}, events)
    assert probe_events(events) == [("alert", "critical"), ("clear", "info")]
    assert state["hosts"]["alpha"]["unverified"] is None


def test_failure_success_failure_opens_no_host_incident(observer, config):
    events = []
    run(observer, config, 1, {"alpha": None}, events)
    run(observer, config, 2, {"alpha": probe(2, {"token": True})}, events)
    state = run(observer, config, 3, {"alpha": None}, events)
    assert probe_events(events) == []
    assert state["hosts"]["alpha"]["unverified"] is None
    assert state["hosts"]["alpha"]["probe_failure_count"] == 1


def test_previous_schema_host_record_loads_and_keeps_open_probe_incident(
    observer, config
):
    # Release e786ead wrote host records without probe_failure_count.
    directory = Path(config["state_dir"])
    directory.mkdir(mode=0o700)
    path = directory / "fleet-observer.json"
    path.write_text(
        observer.json.dumps(
            {
                "schema_version": 1,
                "started_at": 0,
                "completed_at": 0,
                "hosts": {
                    "alpha": {
                        "checks": {},
                        "incidents": {},
                        "unverified": "legacy-probe-incident",
                        "last_status": "unverified",
                    },
                    "secondary": {
                        "checks": {},
                        "incidents": {},
                        "unverified": None,
                        "last_status": "fresh",
                    },
                },
                "pending_events": [],
                "alerts": [],
            }
        )
    )
    path.chmod(0o600)
    config["hosts"].append(
        {"host": "secondary", "instance": "secondary-i", "probe_command": ["/bin/true"]}
    )
    events = []
    state = run(observer, config, 1, {"alpha": None, "secondary": None}, events)
    assert events == []
    assert state["hosts"]["alpha"]["unverified"] == "legacy-probe-incident"
    assert state["hosts"]["secondary"]["unverified"] is None
    assert state["hosts"]["secondary"]["probe_failure_count"] == 1
    state = run(
        observer,
        config,
        2,
        {"alpha": probe(2, {"token": True}), "secondary": probe(2, {"token": True})},
        events,
    )
    assert [(e["kind"], e["reason"], e["incident_id"]) for e in events] == [
        ("clear", "fleet_alpha_probe_unverified", "legacy-probe-incident")
    ]


def test_retired_instance_clears_its_incidents_and_opens_nothing(observer, config):
    events = []
    live = {
        "ret_i_configured": True,
        "ret_i_persistent": True,
        "ret_i_health_readable": False,
        "ret_i_2_health_readable": False,
        "live_i_token": True,
        "live_i_gone": True,
        "dead_i_health_readable": False,
    }
    for now, connected in ((1, False), (2, False), (3, None), (4, None)):
        state = run(
            observer,
            config,
            now,
            {"alpha": probe(now, {**live, "ret_i_whatsapp_connected": connected})},
            events,
        )
    opened = {
        "ret_i_health_readable",
        "ret_i_whatsapp_connected",
        "ret_i_whatsapp_connected_unverified",
        "ret_i_2_health_readable",
        "dead_i_health_readable",
    }
    assert set(state["hosts"]["alpha"]["incidents"]) == opened
    assert state["hosts"]["alpha"]["incidents"]["dead_i_health_readable"]
    seeded = len(events)
    retired = {
        "ret_i_configured": True,
        "ret_i_retired": True,
        "ret_i_2_health_readable": False,
        "live_i_token": True,
        "dead_i_health_readable": False,
    }
    for now in (5, 6, 7):
        state = run(observer, config, now, {"alpha": probe(now, retired)}, events)
    after = [(e["kind"], e["reason"]) for e in events[seeded:]]
    # No retired check opens an _unverified warning; all three open keys clear.
    assert not [r for k, r in after if k == "alert" and "ret_i_" in r]
    assert sorted(after) == [
        ("alert", "fleet_alpha_live_i_gone_unverified"),
        ("clear", "fleet_alpha_ret_i_health_readable"),
        ("clear", "fleet_alpha_ret_i_whatsapp_connected"),
        ("clear", "fleet_alpha_ret_i_whatsapp_connected_unverified"),
    ]
    record = state["hosts"]["alpha"]
    # Positive control: an enabled instance with unreadable health stays paged.
    assert set(record["incidents"]) == {
        "ret_i_2_health_readable",
        "live_i_gone_unverified",
        "dead_i_health_readable",
    }
    dead = [e for e in events if e["reason"] == "fleet_alpha_dead_i_health_readable"]
    assert [(e["kind"], e["severity"]) for e in dead] == [("alert", "critical")]
    assert not {
        "ret_i_persistent",
        "ret_i_health_readable",
        "ret_i_whatsapp_connected",
    } & set(record["checks"])


RETIRED = {"ret_i_configured": True, "ret_i_retired": True, "live_i_token": True}


def ret_i_alerts(events):
    return [
        e["reason"] for e in events if e["kind"] == "alert" and "ret_i_" in e["reason"]
    ]


@pytest.mark.parametrize(
    "after",
    [
        # Re-enabled: the probe runs every check again, all healthy.
        {
            "ret_i_configured": True,
            "ret_i_persistent": True,
            "ret_i_health_readable": True,
            "ret_i_whatsapp_connected": True,
            "live_i_token": True,
        },
        # Probe rolled back: no retired marker; the old checks come back.
        {
            "ret_i_configured": True,
            "ret_i_persistent": True,
            "ret_i_health_readable": True,
            "ret_i_whatsapp_connected": True,
            "ret_i_primary_model_usable": True,
            "live_i_token": True,
        },
    ],
    ids=["re-enabled", "probe-rollback"],
)
def test_retired_marker_that_stops_arriving_opens_nothing(observer, config, after):
    events = []
    for now in (1, 2):
        run(observer, config, now, {"alpha": probe(now, RETIRED)}, events)
    for now in range(3, 14):
        state = run(observer, config, now, {"alpha": probe(now, after)}, events)
    assert ret_i_alerts(events) == []
    assert not [i for i in state["hosts"]["alpha"]["incidents"] if "ret_i_" in i]
    assert "ret_i_retired" not in state["hosts"]["alpha"]["checks"]


def test_instance_removed_from_targets_is_forgotten_and_its_incidents_clear(
    observer, config
):
    events = []
    gone = {
        "ssh_reachable": True,
        "gone_i_configured": True,
        "gone_i_health_readable": False,
        "gone_2_configured": True,
        "gone_2_health_readable": False,
    }
    listed = ["ret_i", "gone_i", "gone_2"]
    for now in (1, 2):
        run(
            observer,
            config,
            now,
            {"alpha": probe(now, {**RETIRED, **gone}, listed)},
            events,
        )
    assert (
        "gone_i_health_readable"
        in (
            run(
                observer,
                config,
                3,
                {"alpha": probe(3, {**RETIRED, **gone}, listed)},
                events,
            )["hosts"]["alpha"]["incidents"]
        )
    )
    seeded = len(events)
    # Neither instance is listed any more; gone_2 is a different instance.
    remaining = {
        "ssh_reachable": True,
        "live_i_token": True,
        "gone_2_configured": True,
        "gone_2_health_readable": False,
    }
    for now in range(4, 10):
        state = run(
            observer, config, now, {"alpha": probe(now, remaining, ["gone_2"])}, events
        )
    after = [(e["kind"], e["reason"]) for e in events[seeded:]]
    assert after == [("clear", "fleet_alpha_gone_i_health_readable")]
    record = state["hosts"]["alpha"]
    assert not [c for c in record["checks"] if c.startswith(("ret_i_", "gone_i_"))]
    assert set(record["incidents"]) == {"gone_2_health_readable"}


# fleet_probe.py prints exactly this, with a fresh checked_at, when SSH or the
# remote probe fails, including a probe that crashes on a malformed config.
def wrapper_failure(now):
    return {
        "checked_at": now,
        "checks": {"ssh_reachable": False},
        "codes": ["probe_transport_or_execution_failed"],
    }


HEALTHY_HOST = {"ssh_reachable": True, "bot_i_configured": True}


def test_wrapper_failure_payload_never_forgets_instances(observer, config):
    events = []
    down = {**HEALTHY_HOST, "bot_i_health_readable": False}
    for now in (1, 2):
        state = run(
            observer, config, now, {"alpha": probe(now, down, ["bot_i"])}, events
        )
    incident = state["hosts"]["alpha"]["incidents"]["bot_i_health_readable"]
    # A malformed config crashes the probe on every cycle.
    for now in range(3, 12):
        state = run(observer, config, now, {"alpha": wrapper_failure(now)}, events)
    assert state["hosts"]["alpha"]["incidents"]["bot_i_health_readable"] == incident
    assert not [e for e in events if e["kind"] == "clear"]
    assert "bot_i_configured" in state["hosts"]["alpha"]["checks"]


def test_bot_down_then_host_unreachable_then_back_keeps_the_same_incident(
    observer, config
):
    events = []
    down = {**HEALTHY_HOST, "bot_i_health_readable": False}
    for now in (1, 2):
        state = run(
            observer, config, now, {"alpha": probe(now, down, ["bot_i"])}, events
        )
    incident = state["hosts"]["alpha"]["incidents"]["bot_i_health_readable"]
    for now in (3, 4, 5):
        run(observer, config, now, {"alpha": wrapper_failure(now)}, events)
    for now in (6, 7):
        state = run(
            observer, config, now, {"alpha": probe(now, down, ["bot_i"])}, events
        )
    assert state["hosts"]["alpha"]["incidents"]["bot_i_health_readable"] == incident
    assert [
        e["kind"] for e in events if e["reason"] == "fleet_alpha_bot_i_health_readable"
    ] == ["alert"]


@pytest.mark.parametrize(
    ("checks", "instances"),
    [
        ({"ssh_reachable": True}, None),
        ({"ssh_reachable": False}, []),
        ({"ssh_reachable": None}, []),
    ],
    ids=["no-instance-list", "ssh-false", "ssh-unknown"],
)
def test_removal_needs_an_explicit_list_from_a_reachable_host(
    observer, config, checks, instances
):
    events = []
    down = {**HEALTHY_HOST, "bot_i_health_readable": False}
    for now in (1, 2):
        run(observer, config, now, {"alpha": probe(now, down, ["bot_i"])}, events)
    for now in range(3, 8):
        state = run(
            observer, config, now, {"alpha": probe(now, checks, instances)}, events
        )
    assert "bot_i_health_readable" in state["hosts"]["alpha"]["incidents"]
    assert not [e for e in events if e["kind"] == "clear"]


# The receipts script refuses more than 128 ids; this stub does the same, logs
# every batch it receives, and fails any batch containing a FAIL id.
DELIVERY_STUB = """
import json, pathlib, sys
ids = sys.argv[1:]
with pathlib.Path({log!r}).open("a") as log:
    log.write(json.dumps(ids) + "\\n")
if len(ids) > 128 or set(ids) & set({fail!r}):
    raise SystemExit(3)
print(json.dumps({{i: {{"status": {status!r}}} for i in ids}}))
"""


def delivery_stub(tmp_path, *, fail=(), status="sent"):
    log = tmp_path / "delivery-batches.log"
    stub = tmp_path / "delivery-stub.py"
    stub.write_text(DELIVERY_STUB.format(log=str(log), fail=list(fail), status=status))
    return [sys.executable, str(stub)], log


def batches(log):
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines()]


def alert(now, delivery="locally_persisted", age=100):
    return {
        "event_id": str(uuid4()),
        "incident_id": str(uuid4()),
        "kind": "alert",
        "reason": "fleet_alpha_token",
        "created_at": now - age,
        "published_at": now - age,
        "delivery": delivery,
    }


def seed_observer(observer, config, alerts):
    directory = Path(config["state_dir"])
    observer.supervisor.private_directory(directory)
    state = observer.initial_state(0)
    state["alerts"] = alerts
    observer.supervisor.write_private(directory / "fleet-observer.json", state)


def observe_once(observer, config, now):
    # No resolve_delivery override: the shared resolver runs the stub command.
    return observer.run_once(
        config,
        now=now,
        probe=lambda *_: probe(now, {"token": True}),
        emit=lambda _: {"published": True},
    )


def test_delivery_resolves_undelivered_alerts_past_retained_terminal_ones(
    observer, config, tmp_path
):
    config["delivery_command"], log = delivery_stub(tmp_path)
    terminal = [alert(5000, "channel_delivered") for _ in range(128)]
    waiting = [alert(5000) for _ in range(10)]
    seed_observer(observer, config, terminal + waiting)
    state = observe_once(observer, config, 5000)
    sent = [i for batch in batches(log) for i in batch]
    assert all(len(batch) <= 128 for batch in batches(log))
    assert not {a["event_id"] for a in terminal} & set(sent)
    resolved = {a["event_id"]: a["delivery"] for a in state["alerts"]}
    assert all(resolved[a["event_id"]] == "channel_delivered" for a in waiting)


def test_failing_delivery_batch_does_not_block_the_other_batches(
    observer, config, tmp_path
):
    waiting = [alert(5000) for _ in range(150)]
    config["delivery_command"], log = delivery_stub(
        tmp_path, fail=[waiting[0]["event_id"]]
    )
    seed_observer(observer, config, waiting)
    state = observe_once(observer, config, 5000)
    assert [len(batch) for batch in batches(log)] == [128, 22]
    delivery = {a["event_id"]: a["delivery"] for a in state["alerts"]}
    assert [delivery[a["event_id"]] for a in waiting[128:]] == [
        "channel_delivered"
    ] * 22
    assert {delivery[a["event_id"]] for a in waiting[:128]} == {"locally_persisted"}


def test_delivery_resolution_failure_is_recorded_and_pages_the_watchdog(
    observer, config, tmp_path
):
    waiting = [alert(5000)]
    config["delivery_command"], _ = delivery_stub(
        tmp_path, fail=[waiting[0]["event_id"]]
    )
    seed_observer(observer, config, waiting)
    for now in (5000, 5001):
        state = observe_once(observer, config, now)
    record = state["delivery_resolution"]
    assert record["consecutive_failed_cycles"] == 2
    assert record["failures"] == [{"code": "nonzero_exit", "returncode": 3}]
    assert waiting[0]["event_id"] not in json.dumps(record)
    events = []
    watchdog = observer.run_watchdog(
        config, now=5002, emit=lambda e: events.append(e) or {"published": True}
    )
    assert "alert_delivery_unresolved" in watchdog["incidents"]
    config["delivery_command"], _ = delivery_stub(tmp_path)
    for now in (5003, 5004):
        state = observe_once(observer, config, now)
    assert state["delivery_resolution"]["consecutive_failed_cycles"] == 0
    watchdog = observer.run_watchdog(
        config, now=5005, emit=lambda e: events.append(e) or {"published": True}
    )
    assert "alert_delivery_unresolved" not in watchdog["incidents"]
    assert [
        e["kind"] for e in events if e["reason"] == "fleet_alert_delivery_unresolved"
    ] == ["alert", "clear"]


def test_undelivered_alerts_are_bounded_and_every_drop_is_counted(
    observer, config, tmp_path
):
    config["delivery_command"], _ = delivery_stub(tmp_path, status="pending")
    old = [alert(500000, age=2 * 86400) for _ in range(5)]
    recent = [alert(500000) for _ in range(600)]
    seed_observer(observer, config, old + recent)
    state = observe_once(observer, config, 500000)
    kept = {a["event_id"] for a in state["alerts"]}
    assert not kept & {a["event_id"] for a in old}
    assert len(kept) == observer.supervisor.MAX_UNDELIVERED_ALERTS
    assert kept == {a["event_id"] for a in recent[-len(kept) :]}
    dropped = state["delivery_dropped"]
    assert dropped["total"] == 605 - len(kept)
    assert dropped["last_at"] == 500000
    watchdog = observer.run_watchdog(
        config, now=500001, emit=lambda _: {"published": True}
    )
    assert "alert_delivery_stale" in watchdog["incidents"]


def test_terminal_alerts_are_still_retained_up_to_128(observer, config, tmp_path):
    config["delivery_command"], _ = delivery_stub(tmp_path)
    terminal = [alert(5000, "dispatcher_suppressed") for _ in range(200)]
    seed_observer(observer, config, terminal)
    state = observe_once(observer, config, 5000)
    assert [a["event_id"] for a in state["alerts"]] == [
        a["event_id"] for a in terminal[-128:]
    ]


def test_failed_lookup_cycle_never_ages_out_undelivered_alerts(
    observer, config, tmp_path
):
    old = [alert(500000, age=2 * 86400) for _ in range(3)]
    config["delivery_command"], _ = delivery_stub(tmp_path, fail=[old[0]["event_id"]])
    seed_observer(observer, config, old)
    state = observe_once(observer, config, 500000)
    # The lookup failed, so nothing is known about these alerts: keep them.
    assert {a["event_id"] for a in state["alerts"]} == {a["event_id"] for a in old}
    assert "delivery_dropped" not in state
    config["delivery_command"], _ = delivery_stub(tmp_path, status="unobserved")
    state = observe_once(observer, config, 500001)
    # A successful lookup that finds no receipt retires them, counted.
    assert state["alerts"] == []
    assert state["delivery_dropped"]["total"] == 3


def test_watchdog_only_lookup_failures_page_after_two_of_its_own_cycles(
    observer, config
):
    observer.run_once(
        config,
        now=100,
        probe=lambda *_: probe(100, {"token": True}),
        emit=lambda _: {"published": True},
        resolve_delivery=lambda _: [],
    )
    failing = lambda _: [{"code": "nonzero_exit", "returncode": 1}]  # noqa: E731
    first = observer.run_watchdog(
        config, now=101, emit=lambda _: {"published": True}, resolve_delivery=failing
    )
    assert "alert_delivery_unresolved" not in first["incidents"]
    second = observer.run_watchdog(
        config, now=102, emit=lambda _: {"published": True}, resolve_delivery=failing
    )
    assert "alert_delivery_unresolved" in second["incidents"]
    third = observer.run_watchdog(
        config,
        now=103,
        emit=lambda _: {"published": True},
        resolve_delivery=lambda _: [],
    )
    assert "alert_delivery_unresolved" not in third["incidents"]


def cap_host(config, value, index=0):
    config["hosts"][index]["max_alert_severity"] = value


def test_capped_host_ssh_unreachable_alerts_as_warning_and_clears_as_info(
    observer, config, monkeypatch
):
    cap_host(config, "warning")
    events = []
    healthy = {"ssh_reachable": True}
    run(observer, config, 1, {"alpha": probe(1, healthy)}, events)
    down = {"ssh_reachable": False}
    for now in (2, 3):
        run(observer, config, now, {"alpha": probe(now, down)}, events)
    assert [(e["kind"], e["reason"], e["severity"]) for e in events] == [
        ("alert", "fleet_alpha_ssh_reachable", "warning")
    ]
    assert published_severity(observer, monkeypatch, events[0]) == "warning"
    state = run(observer, config, 4, {"alpha": probe(4, healthy)}, events)
    assert [(e["kind"], e["severity"]) for e in events[1:]] == [("clear", "info")]
    assert events[1]["incident_id"] == events[0]["incident_id"]
    assert published_severity(observer, monkeypatch, events[1]) == "info"
    assert state["hosts"]["alpha"]["incidents"] == {}


def test_capped_host_probe_unverified_alerts_as_warning(observer, config):
    cap_host(config, "warning")
    events = []
    for now in (1, 2):
        run(observer, config, now, {"alpha": None}, events)
    assert probe_events(events) == [("alert", "warning")]
    run(observer, config, 3, {"alpha": probe(3, {"token": True})}, events)
    assert probe_events(events) == [("alert", "warning"), ("clear", "info")]


def test_uncapped_host_stays_critical_beside_a_capped_host(observer, config):
    cap_host(config, "warning")
    config["hosts"].append(
        {"host": "secondary", "instance": "secondary-i", "probe_command": ["/bin/true"]}
    )
    events = []
    down = {"ssh_reachable": False}
    for now in (1, 2):
        run(
            observer,
            config,
            now,
            {"alpha": probe(now, down), "secondary": probe(now, down)},
            events,
        )
    assert sorted((e["reason"], e["severity"]) for e in events) == [
        ("fleet_alpha_ssh_reachable", "warning"),
        ("fleet_secondary_ssh_reachable", "critical"),
    ]


@given(value=st.one_of(st.integers(), st.lists(st.text(), max_size=3),
                      st.text().filter(lambda value: value not in {"info", "warning", "error", "critical"})))
@example(value="urgent")
@example(value="Warning")
@example(value="")
@example(value=3)
@example(value=["warning"])
def test_invalid_severity_cap_is_ignored_with_a_stderr_note(value):
    observer = load_module()
    with TemporaryDirectory() as directory, redirect_stderr(StringIO()) as errors:
        config = {"state_dir": str(Path(directory) / "state"), "instance": "fleet-test",
                  "probe_timeout_seconds": 0.2, "freshness_seconds": 1200,
                  "hosts": [{"host": "alpha", "instance": "alpha-i", "probe_command": ["/bin/true"]}]}
        cap_host(config, value)
        events = []
        down = {"ssh_reachable": False}
        for now in (1, 2):
            run(observer, config, now, {"alpha": probe(now, down)}, events)
        assert [(e["kind"], e["severity"]) for e in events] == [("alert", "critical")]
        assert "max_alert_severity" in errors.getvalue()


def test_cap_lowers_alerts_but_never_raises_them(observer, config):
    cap_host(config, "error")
    events = []
    down = {"ssh_reachable": False, "model": None}
    for now in (1, 2):
        run(observer, config, now, {"alpha": probe(now, down)}, events)
    assert sorted((e["reason"], e["severity"]) for e in events) == [
        ("fleet_alpha_model_unverified", "warning"),
        ("fleet_alpha_ssh_reachable", "error"),
    ]


def failed_model(now, stamp):
    return probe(now, {"model": False}, evidence={"model": stamp})


def test_one_bot_probe_read_on_several_cycles_is_one_failure(observer, config):
    # The bot re-probes its primary model only every 30 to 60 minutes; the
    # observer reads that single result every cycle. Reads of the same result
    # are one observation, so they never reach the two-failure threshold.
    events = []
    for now in (1, 2, 3, 4):
        state = run(observer, config, now, {"alpha": failed_model(now, 1000)}, events)
    assert events == []
    check = state["hosts"]["alpha"]["checks"]["model"]
    assert check["false_count"] == 1
    assert check["false_evidence"] == 1000


def test_two_distinct_failed_bot_probes_still_open_critical(observer, config):
    events = []
    run(observer, config, 1, {"alpha": failed_model(1, 1000)}, events)
    run(observer, config, 2, {"alpha": failed_model(2, 1000)}, events)
    assert events == []
    run(observer, config, 3, {"alpha": failed_model(3, 2000)}, events)
    assert [(e["kind"], e["reason"], e["severity"]) for e in events] == [
        ("alert", "fleet_alpha_model", "critical")
    ]


def test_success_resets_the_stamp_so_a_later_failure_counts_again(observer, config):
    events = []
    run(observer, config, 1, {"alpha": failed_model(1, 1000)}, events)
    run(observer, config, 2, {"alpha": failed_model(2, 2000)}, events)
    run(
        observer,
        config,
        3,
        {"alpha": probe(3, {"model": True}, evidence={"model": 3000})},
        events,
    )
    assert [(e["kind"], e["reason"]) for e in events] == [
        ("alert", "fleet_alpha_model"),
        ("clear", "fleet_alpha_model"),
    ]
    state = run(observer, config, 4, {"alpha": failed_model(4, 4000)}, events)
    check = state["hosts"]["alpha"]["checks"]["model"]
    assert (check["false_count"], check["false_evidence"]) == (1, 4000)
    assert len(events) == 2


def test_failures_without_a_stamp_count_on_every_read(observer, config):
    # A probe without evidence (an older probe, or a check that has none)
    # keeps today's per-read count, even beside a stamped check.
    events = []
    for now in (1, 2):
        run(
            observer,
            config,
            now,
            {
                "alpha": probe(
                    now, {"model": False, "token": False}, evidence={"model": 1000}
                )
            },
            events,
        )
    assert [e["reason"] for e in events] == ["fleet_alpha_token"]


def test_unverified_host_cycle_resets_the_stamp(observer, config):
    events = []
    run(observer, config, 1, {"alpha": failed_model(1, 1000)}, events)
    run(observer, config, 2, {"alpha": None}, events)
    state = run(observer, config, 3, {"alpha": failed_model(3, 1000)}, events)
    assert state["hosts"]["alpha"]["checks"]["model"]["false_count"] == 1
    state = run(observer, config, 4, {"alpha": failed_model(4, 1000)}, events)
    assert state["hosts"]["alpha"]["checks"]["model"]["false_count"] == 1
    assert events == []


def write_unstamped_state(observer, config, incidents=None):
    # Shape written by release 20260930-6a0e3b0-sevcap: one failure counted,
    # no false_evidence on the check record.
    directory = Path(config["state_dir"])
    directory.mkdir(mode=0o700)
    path = directory / "fleet-observer.json"
    path.write_text(
        observer.json.dumps(
            {
                "schema_version": 1,
                "started_at": 0,
                "completed_at": 0,
                "hosts": {
                    "alpha": {
                        "checks": {
                            "model": {
                                "false_count": 1,
                                "none_count": 0,
                                "last_result": False,
                            }
                        },
                        "incidents": incidents or {},
                        "unverified": None,
                        "last_status": "fresh",
                    }
                },
                "pending_events": [],
                "alerts": [],
            }
        )
    )
    path.chmod(0o600)


def test_failure_counted_before_stamps_is_not_counted_again_on_upgrade(
    observer, config
):
    # The release without stamps already counted the bot's current result
    # once; reading it again with its stamp is the same observation.
    write_unstamped_state(observer, config)
    events = []
    state = run(observer, config, 1, {"alpha": failed_model(1, 1000)}, events)
    check = state["hosts"]["alpha"]["checks"]["model"]
    assert (check["false_count"], check["false_evidence"]) == (1, 1000)
    run(observer, config, 2, {"alpha": failed_model(2, 1000)}, events)
    assert events == []
    run(observer, config, 3, {"alpha": failed_model(3, 2000)}, events)
    assert [e["reason"] for e in events] == ["fleet_alpha_model"]


def test_open_incident_from_before_stamps_stays_open_on_upgrade(observer, config):
    write_unstamped_state(observer, config, incidents={"model": "legacy-incident"})
    events = []
    state = run(observer, config, 1, {"alpha": failed_model(1, 1000)}, events)
    assert state["hosts"]["alpha"]["incidents"] == {"model": "legacy-incident"}
    assert events == []
    state = run(observer, config, 2, {"alpha": probe(2, {"model": True})}, events)
    assert [(e["kind"], e["incident_id"]) for e in events] == [
        ("clear", "legacy-incident")
    ]


def test_unstamped_failure_after_upgrade_still_counts_per_read(observer, config):
    write_unstamped_state(observer, config)
    events = []
    run(observer, config, 1, {"alpha": probe(1, {"model": False})}, events)
    assert [e["reason"] for e in events] == ["fleet_alpha_model"]


@pytest.mark.parametrize(
    "evidence",
    [
        [],
        "1000",
        {"model": "1000"},
        {"model": True},
        {"model": float("nan")},
        {"model": float("inf")},
        {"Model!": 1000},
        {"model_%d" % i: i for i in range(65)},
        {"model": 10**16},
        {"model": -1e16},
        {"model": 10**400},
    ],
)
def test_malformed_evidence_rejects_the_payload(observer, evidence):
    assert (
        observer.validate_probe(probe(1, {"model": False}, evidence=evidence)) is None
    )


def test_valid_evidence_survives_validation(observer):
    payload = observer.validate_probe(
        probe(1, {"model": False}, evidence={"model": 1791428785654})
    )
    assert payload["evidence"] == {"model": 1791428785654}
    assert observer.validate_probe(probe(1, {"model": False}))["evidence"] == {}


@pytest.mark.parametrize("between", [{"model": True}, {"model": None}])
def test_a_success_or_unknown_between_lets_the_same_stamp_count_again(
    observer, config, between
):
    # Without the reset, the repeated stamp after the gap would not count and
    # the next distinct failure would be the first, delaying the page.
    events = []
    run(observer, config, 1, {"alpha": failed_model(1, 1000)}, events)
    run(observer, config, 2, {"alpha": probe(2, between)}, events)
    run(observer, config, 3, {"alpha": failed_model(3, 1000)}, events)
    assert [e for e in events if e["kind"] == "alert"] == []
    run(observer, config, 4, {"alpha": failed_model(4, 2000)}, events)
    assert [(e["kind"], e["reason"]) for e in events if e["kind"] == "alert"] == [
        ("alert", "fleet_alpha_model")
    ]


# The probe replaced m365_mail_read, a Sent Items read, with m365_graph_reachable.
# Every payload also carries a stamped primary-model failure, whose stored record
# (counts and evidence stamp) the retirement must leave alone.
MODEL = "bot_i_primary_model_usable"


def old_m365(now, result):
    return probe(
        now,
        {"ssh_reachable": True, "m365_mail_read": result, MODEL: False},
        evidence={MODEL: 1000 if now == 1 else 2000},
    )


def new_m365(now):
    return probe(
        now,
        {"ssh_reachable": True, "m365_graph_reachable": True, MODEL: False},
        evidence={MODEL: 2000},
    )


def emitter_flags(observer, monkeypatch, event):
    """Return the --flag values publish_event hands the emitter for an event."""
    captured = []

    class Result:
        returncode = 0
        stdout = b"/tmp/event.json\n"

    monkeypatch.setattr(
        observer.supervisor,
        "run_command",
        lambda command, timeout: captured.append(command) or Result(),
    )
    receipt = observer.supervisor.publish_event(
        {"emitter_command": ["/bin/emit"], "instance": "alpha-i"}, event
    )
    assert receipt["published"] is True
    argv = captured[0]
    return {
        argv[i]: argv[i + 1]
        for i in range(1, len(argv) - 1)
        if argv[i].startswith("--")
    }


@pytest.mark.parametrize(
    ("seed", "expected"),
    [
        ((False, False), {"m365_mail_read"}),
        ((None, None), {"m365_mail_read_unverified"}),
        ((False, False, None, None), {"m365_mail_read", "m365_mail_read_unverified"}),
    ],
    ids=["failed", "unknown", "failed-and-unknown"],
)
def test_retired_host_check_clears_each_open_incident_and_opens_nothing(
    observer, config, monkeypatch, seed, expected
):
    events = []
    for now, result in enumerate(seed, 1):
        state = run(observer, config, now, {"alpha": old_m365(now, result)}, events)
    record = state["hosts"]["alpha"]
    opened = {r: i for r, i in record["incidents"].items() if r.startswith("m365_")}
    assert set(opened) == expected
    model = record["checks"][MODEL]
    assert model["false_count"] == 2 and model["false_evidence"] == 2000
    model_incident = record["incidents"][MODEL]
    seeded = len(events)
    start = len(seed) + 1
    for now in range(start, start + observer.NONE_THRESHOLD + 1):
        state = run(observer, config, now, {"alpha": new_m365(now)}, events)
    after = events[seeded:]
    # One clear per open incident, carrying the id its alert carried; no alert.
    assert sorted((e["kind"], e["reason"], e["incident_id"]) for e in after) == sorted(
        ("clear", "fleet_alpha_" + reason, incident)
        for reason, incident in opened.items()
    )
    # Each clear reaches the emitter as a resolution of that incident.
    for event in after:
        flags = emitter_flags(observer, monkeypatch, event)
        assert flags["--event-type"] == "clear"
        assert flags["--severity"] == "info"
        assert flags["--source"] == "agent365-reliability-" + event["reason"]
        assert flags["--diagnostic"] == "incident_id=" + event["incident_id"]
    record = state["hosts"]["alpha"]
    assert record["incidents"] == {MODEL: model_incident}
    assert "m365_mail_read" not in record["checks"]
    # The primary-model record survives unchanged: counts and evidence stamp.
    assert record["checks"][MODEL] == model


@pytest.mark.parametrize(
    "after",
    [
        # A failed probe omits every check: the host is down, not upgraded.
        wrapper_failure,
        # The old probe still runs (a rollback): its result counts as before.
        lambda now: old_m365(now, False),
    ],
    ids=["probe-failed", "old-probe"],
)
def test_retired_host_check_is_kept_until_a_reachable_probe_omits_it(
    observer, config, after
):
    events = []
    for now in (1, 2):
        state = run(observer, config, now, {"alpha": old_m365(now, False)}, events)
    opened = state["hosts"]["alpha"]["incidents"]["m365_mail_read"]
    for now in range(3, 8):
        state = run(observer, config, now, {"alpha": after(now)}, events)
    assert state["hosts"]["alpha"]["incidents"]["m365_mail_read"] == opened
    assert not [e for e in events if e["kind"] == "clear"]
    assert "m365_mail_read" in state["hosts"]["alpha"]["checks"]


def test_retiring_a_host_check_leaves_other_check_state_untouched(observer, config):
    # The primary-model check keeps its stamped failure count, its evidence and
    # its open incident across the retirement: no reset, no clear, no re-alert.
    events = []
    for now, stamp in ((1, 1000), (2, 2000)):
        checks = {"ssh_reachable": True, "m365_mail_read": False, "model": False}
        state = run(
            observer,
            config,
            now,
            {"alpha": probe(now, checks, evidence={"model": stamp})},
            events,
        )
    record = state["hosts"]["alpha"]
    model_before = dict(record["checks"]["model"])
    model_incident = record["incidents"]["model"]
    mail_incident = record["incidents"]["m365_mail_read"]
    seeded = len(events)
    checks = {"ssh_reachable": True, "m365_graph_reachable": True, "model": False}
    for now in range(3, 3 + observer.NONE_THRESHOLD + 1):
        state = run(
            observer,
            config,
            now,
            {"alpha": probe(now, checks, evidence={"model": 2000})},
            events,
        )
    assert [(e["kind"], e["reason"], e["incident_id"]) for e in events[seeded:]] == [
        ("clear", "fleet_alpha_m365_mail_read", mail_incident)
    ]
    record = state["hosts"]["alpha"]
    assert record["incidents"] == {"model": model_incident}
    model_after = record["checks"]["model"]
    for key in ("false_count", "false_evidence", "none_count"):
        assert model_after[key] == model_before[key]


def test_retirement_leaves_an_unknown_check_counting_as_in_a_control_run(
    observer, config, tmp_path
):
    # A check partway to its _unverified warning when m365_mail_read retires
    # keeps counting, and opens on the same cycle as in a run that never had
    # m365_mail_read.
    unknown = "bot_i_whatsapp_connected"

    def history(with_mail):
        cfg = {
            **config,
            "state_dir": str(tmp_path / ("mail" if with_mail else "plain")),
        }
        old = {"ssh_reachable": True}
        if with_mail:
            old["m365_mail_read"] = False
        new = {"ssh_reachable": True, "m365_graph_reachable": True}
        events, counts = [], []
        for now, checks in (
            (1, {**old, unknown: True}),
            (2, {**old, unknown: True}),
            (3, {**old, unknown: None}),
            (4, {**new, unknown: None}),
            (5, {**new, unknown: None}),
        ):
            state = run(observer, cfg, now, {"alpha": probe(now, checks)}, events)
            counts.append(state["hosts"]["alpha"]["checks"][unknown]["none_count"])
        timeline = [(e["kind"], e["reason"], e["created_at"]) for e in events]
        return timeline, counts

    timeline, counts = history(with_mail=True)
    control_timeline, control_counts = history(with_mail=False)
    # The retirement lands on cycle 4, with the unknown check partway there.
    assert ("clear", "fleet_alpha_m365_mail_read", 4) in timeline
    assert 0 < counts[2] < observer.NONE_THRESHOLD
    assert counts == control_counts
    warning = [t for t in timeline if unknown in t[1]]
    assert warning == [t for t in control_timeline if unknown in t[1]]
    assert warning == [("alert", "fleet_alpha_" + unknown + "_unverified", 4)]


# A synthetic retired target names its retired checks in retired_checks, which
# the probe passes through. BROKER_RETIRED is the broker subset; the full list
# also has isolated_canary_liveness, which these tests use as an unlisted check.
# Payloads carry the same stamped primary-model failure as the legacy mail
# capability tests above.
BROKER_RETIRED = [
    "broker_persistent",
    "broker_loaded",
    "broker_http_responsive",
    "broker_legacy_health",
    "broker_liveness",
    "broker_ready",
]
HEALTHY_BROKER = {
    "broker_persistent": True,
    "broker_loaded": True,
    "broker_http_responsive": True,
    "broker_legacy_health": True,
    "broker_ready": True,
}


def old_broker(now, broker, retired_checks=None):
    return probe(
        now,
        {"ssh_reachable": True, **broker, MODEL: False},
        evidence={MODEL: 1000 if now == 1 else 2000},
        retired_checks=retired_checks,
    )


def retired_broker(now):
    return old_broker(now, {}, BROKER_RETIRED)


# retired-host before the stop: /health answers 503 and /ready 404 (unknown).
LEGACY_503 = {**HEALTHY_BROKER, "broker_legacy_health": False, "broker_ready": None}
# retired-host after the stop: nothing listens on port 10000.
LEGACY_STOPPED = {
    "broker_persistent": False,
    "broker_loaded": False,
    "broker_http_responsive": False,
    "broker_legacy_health": False,
    "broker_ready": False,
}
ATTESTED_UNKNOWN = {
    "broker_persistent": True,
    "broker_loaded": True,
    "broker_liveness": None,
    "broker_ready": False,
}
ATTESTED_DOWN = {**ATTESTED_UNKNOWN, "broker_liveness": False}


@pytest.mark.parametrize(
    ("seed", "expected"),
    [
        (
            (LEGACY_503, LEGACY_503, LEGACY_STOPPED, LEGACY_STOPPED),
            {
                "broker_persistent",
                "broker_loaded",
                "broker_http_responsive",
                "broker_legacy_health",
                "broker_ready",
                "broker_ready_unverified",
            },
        ),
        (
            (ATTESTED_UNKNOWN, ATTESTED_UNKNOWN, ATTESTED_DOWN, ATTESTED_DOWN),
            {"broker_liveness", "broker_liveness_unverified", "broker_ready"},
        ),
        (
            ({"broker_http_responsive": False},) * 2,
            {"broker_http_responsive"},
        ),
    ],
    ids=["legacy-503-then-stopped", "attested", "one-check"],
)
def test_retired_checks_clear_each_open_incident_and_open_nothing(
    observer, config, monkeypatch, seed, expected
):
    events = []
    for now, broker in enumerate(seed, 1):
        state = run(observer, config, now, {"alpha": old_broker(now, broker)}, events)
    record = state["hosts"]["alpha"]
    opened = {r: i for r, i in record["incidents"].items() if r.startswith("broker_")}
    assert set(opened) == expected
    model = record["checks"][MODEL]
    assert model["false_count"] == 2 and model["false_evidence"] == 2000
    model_incident = record["incidents"][MODEL]
    seeded = len(events)
    start = len(seed) + 1
    for now in range(start, start + observer.NONE_THRESHOLD + 1):
        state = run(observer, config, now, {"alpha": retired_broker(now)}, events)
    after = events[seeded:]
    # One clear per open incident, carrying the id its alert carried; no alert.
    assert sorted((e["kind"], e["reason"], e["incident_id"]) for e in after) == sorted(
        ("clear", "fleet_alpha_" + reason, incident)
        for reason, incident in opened.items()
    )
    # Each clear reaches the emitter as a resolution of that incident.
    for event in after:
        flags = emitter_flags(observer, monkeypatch, event)
        assert flags["--event-type"] == "clear"
        assert flags["--severity"] == "info"
        assert flags["--source"] == "agent365-reliability-" + event["reason"]
        assert flags["--diagnostic"] == "incident_id=" + event["incident_id"]
    record = state["hosts"]["alpha"]
    assert record["incidents"] == {MODEL: model_incident}
    # No retired check is kept, so none can read as unknown on a later cycle.
    assert not [c for c in record["checks"] if c.startswith("broker_")]
    # The primary-model record survives unchanged: counts and evidence stamp.
    assert record["checks"][MODEL] == model


SEEDED_BROKER = {
    "broker_persistent": False,
    "broker_http_responsive": False,
    "broker_legacy_health": False,
}


@pytest.mark.parametrize(
    "after",
    [
        # A failed probe omits every check: the host is down, not retired.
        wrapper_failure,
        lambda now: None,
        # Only a probe that reached the host may retire its checks.
        lambda now: probe(now, {"ssh_reachable": False}, retired_checks=BROKER_RETIRED),
        lambda now: probe(now, {}, retired_checks=BROKER_RETIRED),
        # The old probe still runs (a rollback): its results count as before.
        lambda now: old_broker(now, SEEDED_BROKER),
        lambda now: old_broker(now, SEEDED_BROKER, []),
    ],
    ids=[
        "probe-failed",
        "no-payload",
        "unreachable-with-list",
        "no-ssh-check-with-list",
        "old-probe",
        "empty-list",
    ],
)
def test_retired_checks_are_kept_until_a_reachable_probe_lists_them(
    observer, config, after
):
    events = []
    for now in (1, 2):
        state = run(
            observer, config, now, {"alpha": old_broker(now, SEEDED_BROKER)}, events
        )
    record = state["hosts"]["alpha"]
    opened = {r: i for r, i in record["incidents"].items() if r.startswith("broker_")}
    assert set(opened) == set(SEEDED_BROKER)
    for now in range(3, 8):
        state = run(observer, config, now, {"alpha": after(now)}, events)
    record = state["hosts"]["alpha"]
    assert {r: record["incidents"][r] for r in opened} == opened
    assert not [e for e in events if e["kind"] == "clear"]
    assert set(SEEDED_BROKER) <= set(record["checks"])


def test_a_retired_check_the_probe_still_sends_is_forgotten(observer, config):
    # The explicit retirement wins over a result the probe still sends:
    # failed, unknown or passing, it is never counted and never alerts.
    events = []
    for now in (1, 2):
        state = run(
            observer, config, now, {"alpha": old_broker(now, SEEDED_BROKER)}, events
        )
    record = state["hosts"]["alpha"]
    opened = {r: i for r, i in record["incidents"].items() if r.startswith("broker_")}
    assert set(opened) == set(SEEDED_BROKER)
    seeded = len(events)
    still_sent = {**SEEDED_BROKER, "broker_ready": None, "broker_loaded": True}
    for now in range(3, 3 + observer.NONE_THRESHOLD + 2):
        state = run(
            observer,
            config,
            now,
            {"alpha": old_broker(now, still_sent, BROKER_RETIRED)},
            events,
        )
    after = events[seeded:]
    assert sorted((e["kind"], e["reason"], e["incident_id"]) for e in after) == sorted(
        ("clear", "fleet_alpha_" + reason, incident)
        for reason, incident in opened.items()
    )
    record = state["hosts"]["alpha"]
    assert not [c for c in record["checks"] if c.startswith("broker_")]
    assert set(record["incidents"]) == {MODEL}


@pytest.mark.parametrize(
    "later",
    [None, [c for c in BROKER_RETIRED if c != "broker_http_responsive"]],
    ids=["list-removed", "name-removed"],
)
def test_a_check_dropped_from_the_list_counts_again_from_scratch(
    observer, config, later
):
    events = []
    failing = {"broker_http_responsive": False}
    for now in (1, 2):
        state = run(observer, config, now, {"alpha": old_broker(now, failing)}, events)
    first = state["hosts"]["alpha"]["incidents"]["broker_http_responsive"]
    for now in (3, 4):
        state = run(
            observer,
            config,
            now,
            {"alpha": old_broker(now, failing, BROKER_RETIRED)},
            events,
        )
    assert "broker_http_responsive" not in state["hosts"]["alpha"]["incidents"]
    seeded = len(events)
    # Rolled back: the check is counted again from zero, so its first failure
    # does not page and its second opens a new incident.
    state = run(observer, config, 5, {"alpha": old_broker(5, failing, later)}, events)
    check = state["hosts"]["alpha"]["checks"]["broker_http_responsive"]
    assert check["false_count"] == 1
    assert events[seeded:] == []
    state = run(observer, config, 6, {"alpha": old_broker(6, failing, later)}, events)
    second = state["hosts"]["alpha"]["incidents"]["broker_http_responsive"]
    assert second != first
    assert [(e["kind"], e["reason"], e["incident_id"]) for e in events[seeded:]] == [
        ("alert", "fleet_alpha_broker_http_responsive", second)
    ]


def test_retired_checks_forget_no_unlisted_check(observer, config):
    # The list names exact checks, never a prefix: a check that only shares a
    # listed name's start keeps its state and its incident.
    events = []
    unlisted = {
        "broker_readiness": False,
        "broker_ready_extra": False,
        "isolated_canary_liveness": False,
    }
    seed = {"ssh_reachable": True, "broker_ready": False, **unlisted}
    for now in (1, 2):
        state = run(observer, config, now, {"alpha": probe(now, seed)}, events)
    opened = dict(state["hosts"]["alpha"]["incidents"])
    assert set(opened) == {"broker_ready", *unlisted}
    seeded = len(events)
    retired = {"ssh_reachable": True, **unlisted}
    for now in range(3, 3 + observer.NONE_THRESHOLD + 1):
        state = run(
            observer,
            config,
            now,
            {"alpha": probe(now, retired, retired_checks=BROKER_RETIRED)},
            events,
        )
    assert [(e["kind"], e["reason"], e["incident_id"]) for e in events[seeded:]] == [
        ("clear", "fleet_alpha_broker_ready", opened["broker_ready"])
    ]
    record = state["hosts"]["alpha"]
    assert record["incidents"] == {check: opened[check] for check in unlisted}
    for check in unlisted:
        assert record["checks"][check]["false_count"] == 2 + observer.NONE_THRESHOLD + 1


@pytest.mark.parametrize(
    "retired_checks",
    [
        "broker_ready",
        ["Broker_Ready"],
        ["broker_ready", 7],
        ["_lead"],
        ["a" * 81],
        ["c%d" % i for i in range(65)],
    ],
    ids=[
        "not-a-list",
        "upper-case",
        "not-a-string",
        "bad-start",
        "too-long",
        "too-many",
    ],
)
def test_malformed_retired_checks_reject_the_payload(observer, retired_checks):
    # The probe drops invalid names itself; a payload that still carries one
    # is not trusted at all, as with any other malformed field.
    payload = probe(1, {"ssh_reachable": True}, retired_checks=retired_checks)
    assert observer.validate_probe(payload) is None


def test_valid_retired_checks_pass_validation(observer):
    names = BROKER_RETIRED + ["a" * 80]
    payload = probe(1, {"ssh_reachable": True}, retired_checks=names)
    assert observer.validate_probe(payload)["retired_checks"] == names
    # Older probes and the wrapper's failure payload carry no list.
    assert observer.validate_probe(probe(1, {"ssh_reachable": True}))[
        "retired_checks"
    ] == []


def test_retired_checks_leave_other_checks_counting_as_in_a_control_run(
    observer, config, tmp_path
):
    # An unknown check, an unstamped failure and a stamped model failure are
    # each partway to their incident when the broker checks retire on cycle 4.
    # Each keeps counting and opens on the same cycle as in a run without a
    # broker.
    unknown = "bot_i_whatsapp_connected"
    failing = "isolated_canary_liveness"
    stamps = {1: 1000, 2: 1000, 3: 1000, 4: 2000, 5: 2000}

    def history(with_broker):
        cfg = {
            **config,
            "state_dir": str(tmp_path / ("broker" if with_broker else "plain")),
        }
        old = {"ssh_reachable": True, **(LEGACY_503 if with_broker else {})}
        events, counts = [], []
        for now in range(1, 6):
            checks = {
                **(old if now < 4 else {"ssh_reachable": True}),
                unknown: True if now < 3 else None,
                failing: True if now < 3 else False,
                MODEL: False,
            }
            payload = probe(
                now,
                checks,
                evidence={MODEL: stamps[now]},
                retired_checks=BROKER_RETIRED if with_broker and now >= 4 else None,
            )
            state = run(observer, cfg, now, {"alpha": payload}, events)
            record = state["hosts"]["alpha"]["checks"]
            counts.append(
                {
                    check: (record[check]["none_count"], record[check]["false_count"])
                    for check in (unknown, failing, MODEL)
                }
            )
        timeline = [(e["kind"], e["reason"], e["created_at"]) for e in events]
        return timeline, counts

    timeline, counts = history(with_broker=True)
    control_timeline, control_counts = history(with_broker=False)
    broker = [t for t in timeline if "_broker_" in t[1]]
    # The broker incidents open on cycle 2 and clear once, on cycle 4.
    assert sorted(broker) == [
        ("alert", "fleet_alpha_broker_legacy_health", 2),
        ("alert", "fleet_alpha_broker_ready_unverified", 2),
        ("clear", "fleet_alpha_broker_legacy_health", 4),
        ("clear", "fleet_alpha_broker_ready_unverified", 4),
    ]
    # Every other check is partway on cycle 3 and counts as in the control run.
    for check in (unknown, failing, MODEL):
        assert 0 < max(counts[2][check]) < observer.FALSE_THRESHOLD
    assert counts == control_counts
    # Sorted: events within one cycle follow set order, which the broker
    # checks' presence may change.
    others = sorted(t for t in timeline if "_broker_" not in t[1])
    assert others == sorted(control_timeline)
    assert others == [
        ("alert", "fleet_alpha_" + MODEL, 4),
        ("alert", "fleet_alpha_" + unknown + "_unverified", 4),
        ("alert", "fleet_alpha_" + failing, 4),
    ]


# The observer loops only over config["hosts"], so a removed host would keep
# its state record and every open incident forever. An explicitly retired host
# moves to retired_hosts with its alert instance, so clear events route there.
SECONDARY = {"host": "secondary", "instance": "secondary-i", "probe_command": ["/bin/true"]}
RETIRED_SECONDARY = {"host": "secondary", "instance": "secondary-i"}


def seed_secondary(observer, config, secondary_payloads, events):
    """Run alpha (healthy) beside secondary for one cycle per secondary payload."""
    config["hosts"].append(dict(SECONDARY))
    for now, secondary in enumerate(secondary_payloads, 1):
        state = run(
            observer,
            config,
            now,
            {"alpha": probe(now, {"ssh_reachable": True}), "secondary": secondary(now)},
            events,
        )
    config["hosts"] = [h for h in config["hosts"] if h["host"] != "secondary"]
    return state


def secondary_failing(now):
    return probe(now, {"ssh_reachable": True, "token": False})


def secondary_down(now):
    return None


@pytest.mark.parametrize(
    "secondary_payloads",
    [
        (secondary_failing, secondary_failing),
        (secondary_down, secondary_down),
        (secondary_failing, secondary_failing, secondary_down, secondary_down),
    ],
    ids=["one-incident", "probe-unverified", "both"],
)
def test_retired_host_clears_each_open_incident_once_and_drops_its_record(
    observer, config, secondary_payloads
):
    events = []
    state = seed_secondary(observer, config, secondary_payloads, events)
    record = state["hosts"]["secondary"]
    opened = dict(record["incidents"])
    if record["unverified"]:
        opened["probe_unverified"] = record["unverified"]
    assert opened
    alpha = state["hosts"]["alpha"]
    seeded = len(events)
    config["retired_hosts"] = [dict(RETIRED_SECONDARY)]
    healthy = {"ssh_reachable": True}
    now = len(secondary_payloads) + 1
    state = run(observer, config, now, {"alpha": probe(now, healthy)}, events)
    after = events[seeded:]
    assert sorted((e["kind"], e["reason"], e["incident_id"]) for e in after) == sorted(
        ("clear", "fleet_secondary_" + reason, incident)
        for reason, incident in opened.items()
    )
    assert {(e["host"], e["instance"], e["severity"]) for e in after} == {
        ("secondary", "secondary-i", "info")
    }
    assert "secondary" not in state["hosts"]
    # The host still probed is untouched.
    assert state["hosts"]["alpha"]["incidents"] == alpha["incidents"]
    # A second cycle finds no record and does nothing.
    seeded = len(events)
    state = run(observer, config, now + 1, {"alpha": probe(now + 1, healthy)}, events)
    assert events[seeded:] == []
    assert "secondary" not in state["hosts"]


def test_host_dropped_from_hosts_without_retirement_is_kept(observer, config):
    # No implicit pruning: only an explicit retired_hosts entry forgets a host.
    events = []
    state = seed_secondary(observer, config, (secondary_failing, secondary_failing), events)
    secondary = state["hosts"]["secondary"]
    assert "token" in secondary["incidents"]
    seeded = len(events)
    for now in (3, 4, 5):
        state = run(
            observer, config, now, {"alpha": probe(now, {"ssh_reachable": True})}, events
        )
    assert events[seeded:] == []
    assert state["hosts"]["secondary"] == secondary


def test_host_in_both_hosts_and_retired_hosts_refuses_to_run(observer, config, capsys):
    config["hosts"].append(dict(SECONDARY))
    config["retired_hosts"] = [dict(RETIRED_SECONDARY)]
    with pytest.raises(observer.supervisor.StateError):
        run(observer, config, 1, {"alpha": None, "secondary": None}, [])
    assert "secondary" in capsys.readouterr().err
    assert not (Path(config["state_dir"]) / "fleet-observer.json").exists()


@pytest.mark.parametrize(
    "retired_hosts",
    [
        "secondary",
        ["secondary"],
        [{"host": "secondary"}],
        [{"host": "Beta", "instance": "secondary-i"}],
        [{"host": "secondary", "instance": ""}],
    ],
    ids=["not-a-list", "bare-name", "no-instance", "bad-host", "bad-instance"],
)
def test_malformed_retired_hosts_refuse_to_run(observer, config, retired_hosts):
    config["retired_hosts"] = retired_hosts
    with pytest.raises(observer.supervisor.StateError):
        run(observer, config, 1, {"alpha": None}, [])


def write_config(path, config):
    path.write_text(json.dumps(config))
    path.chmod(0o600)
    return path


def test_main_exits_nonzero_naming_a_host_in_both_lists(
    observer, config, tmp_path, monkeypatch, capsys
):
    config["hosts"].append(dict(SECONDARY))
    config["retired_hosts"] = [dict(RETIRED_SECONDARY)]
    path = write_config(tmp_path / "config.json", config)
    monkeypatch.setattr(sys, "argv", ["observer", "--config", str(path)])
    assert observer.main() == 1
    err = capsys.readouterr().err
    assert "secondary" in err and "retired_hosts" in err
    assert not Path(config["state_dir"]).exists()
    # Control: the same config with secondary only retired loads.
    config["hosts"] = [h for h in config["hosts"] if h["host"] != "secondary"]
    loaded = observer.load_config(write_config(tmp_path / "ok.json", config))
    assert loaded["retired_hosts"] == [RETIRED_SECONDARY]
