"""#3479: a flap-storm alert whose send raised must not be recorded as sent.

flap_scan_outbox records the trip, then flap_evaluate advances the storm
lifecycle (stormAt, stormSeverity, lastStormEmitAt, cadenceStep), then the
alert is sent. When the send raised, the advanced lifecycle used to be
persisted anyway: the alert was never delivered, the emit watermark said it
was, and should_suppress_send then suppressed every member event as
"consolidated into open flap storm". The lifecycle advance must be undone when
the send itself raised. The trip still counts, and a send that succeeded keeps
its lifecycle even if the dispatch-log append after it fails.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_FLAP_DETECTION",
    "BOT_ERRORS_FLAP_TRIP_THRESHOLD",
    "BOT_ERRORS_FLAP_WINDOW_SECONDS",
    "BOT_ERRORS_FLAP_PROMOTE_SECONDS",
    "BOT_ERRORS_FLAP_CRITICAL_COUNT",
    "BOT_ERRORS_FLAP_STABLE_SECONDS",
]

# One trip opens a storm, so a single outbox event drives the emit path.
_TEST_ENV = {
    "BOT_ERRORS_FLAP_TRIP_THRESHOLD": "1",
    "BOT_ERRORS_FLAP_WINDOW_SECONDS": "600",
    "BOT_ERRORS_FLAP_PROMOTE_SECONDS": "100",
    "BOT_ERRORS_FLAP_CRITICAL_COUNT": "1000",
    "BOT_ERRORS_FLAP_STABLE_SECONDS": "3600",
}

NOW = 1_790_000_000
SHED = "outbound governor ceiling exceeded"
MACHINE = "host-a"
INSTANCE = "line-a"
SOURCE = "health_body_degraded"
KEY = f"{MACHINE}|{INSTANCE}|{SOURCE}"
STORM_FIELDS = ("stormAt", "stormSeverity", "lastStormEmitAt", "cadenceStep")

_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)


def _load(state_dir: Path, monkeypatch):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    for k, v in _TEST_ENV.items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_flap_send_failure_{state_dir.name}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    monkeypatch.setattr(mod.time, "time", lambda: NOW)
    return mod


def _event(event_id: str) -> dict:
    return {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "machine": MACHINE,
        "instance": INSTANCE,
        "source": SOURCE,
        "summary": "health is degraded",
        "evidence": "degraded",
        "createdAt": "2026-09-21T13:33:20Z",
        "id": event_id,
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
    }


def _stage(paths, event_id: str) -> None:
    path = paths["outbox"] / f"20260921T133320Z.{event_id}.json"
    path.write_text(json.dumps(_event(event_id)), encoding="utf-8")
    path.chmod(0o600)


def _record_kinds(paths) -> list[str]:
    log = paths["logs"] / "dispatch.jsonl"
    if not log.exists():
        return []
    return [json.loads(line).get("recordKind") for line in log.read_text().splitlines() if line.strip()]


def _entry(mod, paths) -> dict:
    return mod.load_incident_state(paths)["flapState"][KEY]


def _failing_sender(sent: list):
    def _send(text, *_a, **_k):
        sent.append(text)
        raise RuntimeError(SHED)
    return _send


def test_a_failed_storm_send_does_not_open_the_storm(tmp_path, monkeypatch):
    mod = _load(tmp_path / "open", monkeypatch)
    paths = mod.setup_dirs()
    sent: list = []
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender(sent))
    _stage(paths, "evt-3479-a")

    assert mod.flap_scan_outbox(paths) == 0
    assert len(sent) == 1, "the scan must reach the storm send"

    entry = _entry(mod, paths)
    for field in STORM_FIELDS:
        assert field not in entry, (field, entry)
    # The trip itself still counts.
    assert entry["cumulativeCount"] == 1, entry
    assert entry["lastTripAt"] == NOW, entry
    assert entry["tripTimestamps"] == [NOW], entry
    kinds = _record_kinds(paths)
    assert kinds.count("flap_scan_error") == 1, kinds
    assert "flap_storm" not in kinds, kinds

    # No suppression is licensed by an alert that never went out.
    state = mod.load_incident_state(paths)
    reason = mod.should_suppress_send(_event("evt-3479-member"), state)
    assert not (reason or "").startswith("flap_storm_member"), reason


def test_the_next_occurrence_emits_the_storm_once(tmp_path, monkeypatch):
    mod = _load(tmp_path / "retry", monkeypatch)
    paths = mod.setup_dirs()
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender([]))
    _stage(paths, "evt-3479-a")
    mod.flap_scan_outbox(paths)

    delivered: list = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, *_a, **_k: delivered.append(text))
    _stage(paths, "evt-3479-b")
    assert mod.flap_scan_outbox(paths) == 1
    assert len(delivered) == 1, delivered
    assert _record_kinds(paths).count("flap_storm") == 1
    entry = _entry(mod, paths)
    assert entry["stormAt"] == NOW and entry["lastStormEmitAt"] == NOW, entry


# A storm that is already open: a re-emit is due, either as the escalation to
# critical or as a post-promotion cadence step. A failed send must leave every
# lifecycle field exactly as it was.
_OPEN_STORMS = {
    "escalation": {"stormAt": NOW - 500, "stormSeverity": "warning", "lastStormEmitAt": NOW - 500},
    "cadence": {
        "stormAt": NOW - 90_000,
        "stormSeverity": "critical",
        "lastStormEmitAt": NOW - 90_000,
        "cadenceStep": 2,
    },
}


@pytest.mark.parametrize("case", sorted(_OPEN_STORMS))
def test_a_failed_re_emit_keeps_the_open_storm_unchanged(tmp_path, monkeypatch, case):
    mod = _load(tmp_path / case, monkeypatch)
    paths = mod.setup_dirs()
    prior = dict(_OPEN_STORMS[case])
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {},
        "lastSentAt": {},
        "flapState": {KEY: {
            **prior,
            "tripTimestamps": [],
            "cumulativeCount": 3,
            "lastTripAt": NOW - 500,
            "firstTripAt": NOW - 90_000,
        }},
    })
    sent: list = []
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender(sent))
    _stage(paths, "evt-3479-c")

    assert mod.flap_scan_outbox(paths) == 0
    assert len(sent) == 1, "the scan must reach the re-emit send"
    entry = _entry(mod, paths)
    for field in STORM_FIELDS:
        assert entry.get(field) == prior.get(field), (field, entry)
    assert entry["cumulativeCount"] == 4, entry
    assert entry["lastTripAt"] == NOW, entry


def test_a_successful_send_keeps_its_lifecycle_when_the_log_append_fails(tmp_path, monkeypatch):
    mod = _load(tmp_path / "log-fail", monkeypatch)
    paths = mod.setup_dirs()
    delivered: list = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, *_a, **_k: delivered.append(text))
    real_append = mod.append_dispatch_log

    def _append(paths_arg, payload, *args, **kwargs):
        if payload.get("type") == "flap_storm":
            raise OSError("injected dispatch-log failure")
        return real_append(paths_arg, payload, *args, **kwargs)

    monkeypatch.setattr(mod, "append_dispatch_log", _append)
    _stage(paths, "evt-3479-d")
    mod.flap_scan_outbox(paths)

    assert len(delivered) == 1, delivered
    entry = _entry(mod, paths)
    # The alert went out, so rolling back would re-emit it on the next scan.
    assert entry["stormAt"] == NOW and entry["lastStormEmitAt"] == NOW, entry
    assert entry["stormSeverity"] == "warning", entry
