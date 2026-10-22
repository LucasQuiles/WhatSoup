"""A failing flap-storm resolve notice must back off, then be abandoned.

sweep_flap_storms sends a "storm resolved" notice and pops the flapState entry.
When the send raised, the pop was skipped and the outer except only counted the
error and appended a flap_resolve_error line, so the notice was retried every
dispatcher cycle (30 s) forever and dispatch.jsonl grew by one line per storm
per cycle (~12.5k failed sends on one host). A failed resolve send now records
resolveAttempts / lastResolveErrorAt / nextResolveAt, skips the entry until
nextResolveAt, and after FLAP_RESOLVE_MAX_ATTEMPTS drops the entry with one
flap_resolve_abandoned record.
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
    "BOT_ERRORS_FLAP_RESOLVE_RETRY_BASE_SECONDS",
    "BOT_ERRORS_FLAP_RESOLVE_RETRY_MAX_SECONDS",
    "BOT_ERRORS_FLAP_RESOLVE_MAX_ATTEMPTS",
]

_TEST_ENV = {
    "BOT_ERRORS_FLAP_TRIP_THRESHOLD": "3",
    "BOT_ERRORS_FLAP_WINDOW_SECONDS": "600",
    "BOT_ERRORS_FLAP_PROMOTE_SECONDS": "1800",
    "BOT_ERRORS_FLAP_CRITICAL_COUNT": "1000",
    "BOT_ERRORS_FLAP_STABLE_SECONDS": "3600",
}

NOW = 1_790_000_000
CYCLE = 30
SHED = "outbound governor ceiling exceeded"
KEY = "host-a|line-a|health_body_degraded"

_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)


class _Clock:
    def __init__(self, now: int) -> None:
        self.now = now

    def __call__(self) -> int:
        return self.now


def _load(state_dir: Path, monkeypatch):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    for k, v in _TEST_ENV.items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_flap_resolve_backoff_{state_dir.name}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    clock = _Clock(NOW)
    monkeypatch.setattr(mod.time, "time", clock)
    return mod, clock


def _seed_resolvable_storm(mod, paths, **extra) -> None:
    """An open storm that last reached storm rate long ago: resolvable now."""
    entry = {
        "tripTimestamps": [],
        "cumulativeCount": 7,
        "firstTripAt": NOW - 90_000,
        "lastTripAt": NOW - 50_000,
        "stormAt": NOW - 50_000,
        "stormSeverity": "warning",
        "lastStormEmitAt": NOW - 50_000,
        "lastStormRateAt": NOW - 50_000,
        **extra,
    }
    assert mod.flap_should_resolve(entry, NOW) is True, "precondition: resolvable"
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {},
        "lastSentAt": {},
        "flapState": {KEY: entry},
    })


def _records(paths) -> list[dict]:
    log = paths["logs"] / "dispatch.jsonl"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


def _kinds(paths) -> list[str]:
    return [r.get("recordKind") for r in _records(paths)]


def _entry(mod, paths) -> dict | None:
    return mod.load_incident_state(paths).get("flapState", {}).get(KEY)


def _failing_sender(sent: list):
    def _send(text, *_a, **_k):
        sent.append(text)
        raise RuntimeError(SHED)
    return _send


def test_failed_resolve_records_backoff_and_skips_until_due(tmp_path, monkeypatch):
    mod, clock = _load(tmp_path / "skip", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    sent: list = []
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender(sent))

    assert mod.sweep_flap_storms(paths) == (0, 1)
    assert len(sent) == 1
    entry = _entry(mod, paths)
    assert entry is not None, "a failed resolve must keep the entry"
    assert entry.get("resolveAttempts") == 1, entry
    assert entry.get("lastResolveErrorAt") == NOW, entry
    assert entry.get("nextResolveAt") == NOW + 30, entry
    assert _kinds(paths).count("flap_resolve_error") == 1

    # One second before the backoff expires: no send, no log line, no error.
    clock.now = NOW + 29
    assert mod.sweep_flap_storms(paths) == (0, 0)
    assert len(sent) == 1, "the sweep must not send before nextResolveAt"
    assert _kinds(paths).count("flap_resolve_error") == 1

    # At nextResolveAt the resolve is attempted again.
    clock.now = NOW + 30
    assert mod.sweep_flap_storms(paths) == (0, 1)
    assert len(sent) == 2


def test_backoff_doubles_and_caps(tmp_path, monkeypatch):
    mod, clock = _load(tmp_path / "cap", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender([]))

    delays: list = []
    for _ in range(9):
        mod.sweep_flap_storms(paths)
        entry = _entry(mod, paths)
        assert entry is not None
        delays.append(entry.get("nextResolveAt", 0) - clock.now)
        clock.now = entry.get("nextResolveAt", clock.now)
    assert delays == [30, 60, 120, 240, 480, 960, 1920, 3600, 3600], delays


def test_entry_is_abandoned_after_max_attempts(tmp_path, monkeypatch):
    mod, clock = _load(tmp_path / "abandon", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    sent: list = []
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender(sent))

    total_errors = 0
    for attempt in range(1, 11):
        resolved, errors = mod.sweep_flap_storms(paths)
        assert resolved == 0
        total_errors += errors
        entry = _entry(mod, paths)
        if attempt < 10:
            assert entry is not None, attempt
            clock.now = entry.get("nextResolveAt", clock.now)
    assert len(sent) == 10
    assert total_errors == 10
    assert _entry(mod, paths) is None, "the entry must be dropped after 10 failures"
    kinds = _kinds(paths)
    assert kinds.count("flap_resolve_abandoned") == 1, kinds
    assert kinds.count("flap_resolve_error") == 10, kinds
    # The abandoned record precedes the final error line, so a failing error
    # append cannot lose it.
    assert kinds.index("flap_resolve_abandoned") == len(kinds) - 2, kinds
    assert kinds[-1] == "flap_resolve_error", kinds
    abandoned =[r for r in _records(paths) if r.get("recordKind") == "flap_resolve_abandoned"][0]
    # incidentKey is written but the controller log's metadata-only filter drops it.
    assert abandoned.get("details") == {"attempts": 10, "cumulativeCount": 7, "underlyingOpen": False}, abandoned

    # Nothing is left to retry.
    clock.now += 100_000
    assert mod.sweep_flap_storms(paths) == (0, 0)
    assert len(sent) == 10


def test_success_after_failures_pops_the_entry(tmp_path, monkeypatch):
    mod, clock = _load(tmp_path / "recover", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender([]))
    for _ in range(3):
        mod.sweep_flap_storms(paths)
        clock.now = _entry(mod, paths).get("nextResolveAt", clock.now)

    delivered: list = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, *_a, **_k: delivered.append(text))
    assert mod.sweep_flap_storms(paths) == (1, 0)
    assert len(delivered) == 1
    assert _entry(mod, paths) is None
    kinds = _kinds(paths)
    assert kinds.count("flap_storm_resolved") == 1
    assert "flap_resolve_abandoned" not in kinds


def test_entry_without_backoff_fields_resolves_on_first_sweep(tmp_path, monkeypatch):
    mod, _clock = _load(tmp_path / "legacy", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    assert not {"resolveAttempts", "nextResolveAt", "lastResolveErrorAt"} & set(_entry(mod, paths))
    delivered: list = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, *_a, **_k: delivered.append(text))

    assert mod.sweep_flap_storms(paths) == (1, 0)
    assert len(delivered) == 1
    assert _entry(mod, paths) is None
    assert _kinds(paths).count("flap_storm_resolved") == 1


def test_log_growth_is_bounded_by_attempts_not_cycles(tmp_path, monkeypatch):
    mod, clock = _load(tmp_path / "growth", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    sent: list = []
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender(sent))

    cycles = 1000  # ~8.3 h of 30 s dispatcher cycles
    for i in range(cycles):
        clock.now = NOW + i * CYCLE
        mod.sweep_flap_storms(paths)

    kinds = _kinds(paths)
    assert len(sent) == 10, len(sent)
    assert kinds.count("flap_resolve_error") <= 10, kinds.count("flap_resolve_error")
    assert kinds.count("flap_resolve_abandoned") == 1
    assert len(kinds) <= 11, len(kinds)
    assert _entry(mod, paths) is None


def _inject_on_next_load(mod, monkeypatch, **fields) -> None:
    """The durable writer refuses non-finite floats, so such a value can only
    reach the sweep through a load (json.loads accepts NaN/Infinity) or an
    in-memory payload. Inject it into the next load only."""
    real_load = mod.load_incident_state
    pending = [fields]

    def _load_state(paths_arg, *args, **kwargs):
        state = real_load(paths_arg, *args, **kwargs)
        if pending:
            state["flapState"][KEY].update(pending.pop())
        return state

    monkeypatch.setattr(mod, "load_incident_state", _load_state)


@pytest.mark.parametrize("value", [float("nan"), float("inf")], ids=["nan", "inf"])
def test_non_finite_resolve_attempts_is_a_first_attempt(tmp_path, monkeypatch, value):
    mod, _clock = _load(tmp_path / f"attempts-{value}", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    _inject_on_next_load(mod, monkeypatch, resolveAttempts=value)
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender([]))

    assert mod.sweep_flap_storms(paths) == (0, 1)
    entry = _entry(mod, paths)
    assert entry is not None
    assert entry.get("resolveAttempts") == 1, entry
    assert entry.get("nextResolveAt") == NOW + 30, entry


def test_infinite_next_resolve_at_does_not_skip(tmp_path, monkeypatch):
    mod, _clock = _load(tmp_path / "next-inf", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    _inject_on_next_load(mod, monkeypatch, nextResolveAt=float("inf"))
    delivered: list = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, *_a, **_k: delivered.append(text))

    assert mod.sweep_flap_storms(paths) == (1, 0)
    assert len(delivered) == 1
    assert _entry(mod, paths) is None


def test_backoff_resets_when_the_storm_retrips(tmp_path, monkeypatch):
    mod, clock = _load(tmp_path / "retrip", monkeypatch)
    paths = mod.setup_dirs()
    _seed_resolvable_storm(mod, paths)
    monkeypatch.setattr(mod, "send_whatsapp", _failing_sender([]))
    for _ in range(3):
        mod.sweep_flap_storms(paths)
        clock.now = _entry(mod, paths).get("nextResolveAt", clock.now)
    assert _entry(mod, paths).get("resolveAttempts") == 3

    # The storm re-trips at storm rate: not resolvable, so the budget resets.
    state = mod.load_incident_state(paths)
    state["flapState"][KEY]["tripTimestamps"] = [clock.now - 3, clock.now - 2, clock.now - 1]
    mod.save_incident_state(paths, state)
    assert mod.flap_should_resolve(_entry(mod, paths), clock.now) is False, "precondition: not resolvable"
    assert mod.sweep_flap_storms(paths) == (0, 0)
    entry = _entry(mod, paths)
    assert entry is not None
    assert not {"resolveAttempts", "nextResolveAt", "lastResolveErrorAt"} & set(entry), entry

    # Rate decays again: the next failure is attempt 1 of a fresh budget.
    state = mod.load_incident_state(paths)
    state["flapState"][KEY]["tripTimestamps"] = []
    mod.save_incident_state(paths, state)
    assert mod.flap_should_resolve(_entry(mod, paths), clock.now) is True, "precondition: resolvable"
    assert mod.sweep_flap_storms(paths) == (0, 1)
    entry = _entry(mod, paths)
    assert entry.get("resolveAttempts") == 1, entry
    assert entry.get("nextResolveAt") == clock.now + 30, entry
