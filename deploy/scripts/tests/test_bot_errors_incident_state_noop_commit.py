"""A content-identical incident-state commit must not touch the disk.

In production (2026-10-02) the dispatcher wrote
~24 MB/min because ``IncidentStateCycle.commit()`` ran a full controller-state
transaction (journal x4 carrying both ~400 KB envelopes, ``.previous``, the
primary and the marker, each fsynced) on every optimistically-flagged save,
even when the only difference was the ``updatedAt`` stamp commit() adds itself.

These tests pin three things:

* ``ControllerStateSession.unchanged_commit`` returns a no-I/O ``valid`` result
  only for a byte-identical payload on this session's live normal capability,
  and ``None`` (=> the caller saves) in every other case;
* ``IncidentStateCycle.commit()`` with nothing changed performs zero file
  writes and keeps ``updatedAt`` as it was on disk;
* a commit that DOES change content still publishes, journals and signs
  exactly as before (generation +1, ``.previous`` = the prior primary, marker
  high-water bound to the new primary, no journal left behind).
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
_TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))
sys.path.insert(0, str(_TESTS_DIR))

from lib import controller_state as cs  # noqa: E402
from support import dispatcher_fixtures  # noqa: E402

spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_noop_commit", _SCRIPT)
disp = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
spec.loader.exec_module(disp)  # type: ignore[union-attr]


@pytest.fixture(autouse=True)
def _test_incident_authority(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for key, value in dispatcher_fixtures.incident_authority_test_env(tmp_path).items():
        monkeypatch.setenv(key, value)


class CountingOps(cs._RealFileOps):
    """Real syscalls, counted at the controller-state file-ops boundary."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def _count(self, name: str, fn, *args, **kwargs):
        self.calls.append(name)
        return fn(*args, **kwargs)

    def open(self, path, flags, *args, **kwargs):  # type: ignore[override]
        name = "open_write" if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT) else "open_read"
        return self._count(name, os.open, path, flags, *args, **kwargs)

    def write(self, *args, **kwargs):  # type: ignore[override]
        return self._count("write", os.write, *args, **kwargs)

    def fsync_file(self, *args, **kwargs):  # type: ignore[override]
        return self._count("fsync_file", os.fsync, *args, **kwargs)

    def fsync_directory(self, *args, **kwargs):  # type: ignore[override]
        return self._count("fsync_directory", os.fsync, *args, **kwargs)

    def replace(self, *args, **kwargs):  # type: ignore[override]
        return self._count("replace", os.replace, *args, **kwargs)

    def unlink(self, *args, **kwargs):  # type: ignore[override]
        return self._count("unlink", os.unlink, *args, **kwargs)

    def mutations(self) -> list[str]:
        return [
            call
            for call in self.calls
            if call in {"open_write", "write", "fsync_file", "fsync_directory", "replace", "unlink"}
        ]


def _snapshot(directory: Path) -> dict[str, tuple[bytes, int, int]]:
    """Content, inode and mtime of every file: an atomic replace changes the inode."""
    result = {}
    for entry in sorted(directory.iterdir()):
        if entry.is_file():
            info = entry.stat()
            result[entry.name] = (entry.read_bytes(), info.st_ino, info.st_mtime_ns)
    return result


# ---------------------------------------------------------------------------
# Library contract: ControllerStateSession.unchanged_commit
# ---------------------------------------------------------------------------


def _validate(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("count"), int):
        raise ValueError("count must be an integer")
    return dict(raw)


def _lib_session(path: Path, ops: CountingOps | None = None):
    return cs.open_controller_state(
        path,
        component="collector",
        bootstrap=lambda: {"count": 0},
        validate_payload=_validate,
        lock_timeout_seconds=5,
        file_ops=ops,
    )


def _established(tmp_path: Path) -> Path:
    directory = tmp_path / "store"
    directory.mkdir(mode=0o700)
    path = directory / "state.json"
    with _lib_session(path) as session:
        loaded = session.load()
        session.save({"count": 1}, loaded.capability)
    return path


def test_unchanged_commit_has_an_additive_public_signature() -> None:
    signature = inspect.signature(cs.ControllerStateSession.unchanged_commit)
    assert tuple(signature.parameters) == ("self", "payload", "capability")
    # The established public surface is untouched.
    assert tuple(inspect.signature(cs.ControllerStateSession.save).parameters) == (
        "self", "payload", "capability",
    )


def test_identical_payload_after_load_is_a_no_io_result(tmp_path: Path) -> None:
    path = _established(tmp_path)
    before = _snapshot(path.parent)
    ops = CountingOps()
    with _lib_session(path, ops) as session:
        loaded = session.load()
        ops.calls.clear()
        result = session.unchanged_commit({"count": 1}, loaded.capability)
        assert ops.mutations() == []
        assert result is not None
        assert result.mode == "valid"
        assert result.generation == loaded.diagnostic.current_generation
        assert result.capability is loaded.capability
        assert result.diagnostic.mode == "valid"
        # The capability stays live: a later real save still succeeds.
        committed = session.save({"count": 2}, result.capability)
        assert committed.generation == result.generation + 1
    assert before != _snapshot(path.parent)


def test_identical_payload_after_save_is_a_no_io_result(tmp_path: Path) -> None:
    path = _established(tmp_path)
    ops = CountingOps()
    with _lib_session(path, ops) as session:
        loaded = session.load()
        saved = session.save({"count": 5}, loaded.capability)
        before = _snapshot(path.parent)
        ops.calls.clear()
        result = session.unchanged_commit({"count": 5}, saved.capability)
        assert result is not None and result.generation == saved.generation
        assert ops.mutations() == []
        assert _snapshot(path.parent) == before


@pytest.mark.parametrize("payload", [{"count": 2}, {"count": 1, "extra": True}])
def test_changed_payload_is_not_unchanged(tmp_path: Path, payload) -> None:
    path = _established(tmp_path)
    with _lib_session(path) as session:
        loaded = session.load()
        assert session.unchanged_commit(payload, loaded.capability) is None


def test_invalid_payload_defers_to_save_which_still_rejects(tmp_path: Path) -> None:
    path = _established(tmp_path)
    with _lib_session(path) as session:
        loaded = session.load()
        assert session.unchanged_commit({"count": "x"}, loaded.capability) is None
        with pytest.raises(ValueError):
            session.save({"count": "x"}, loaded.capability)


def test_bootstrap_capability_is_never_unchanged(tmp_path: Path) -> None:
    directory = tmp_path / "fresh"
    directory.mkdir(mode=0o700)
    path = directory / "state.json"
    with _lib_session(path) as session:
        loaded = session.load()
        assert loaded.mode == "bootstrap"
        assert session.unchanged_commit({"count": 0}, loaded.capability) is None


def test_superseded_capability_is_never_unchanged(tmp_path: Path) -> None:
    path = _established(tmp_path)
    with _lib_session(path) as session:
        loaded = session.load()
        session.save({"count": 1}, loaded.capability)
        # The consumed capability must not be reported as a live no-op.
        assert session.unchanged_commit({"count": 1}, loaded.capability) is None


# ---------------------------------------------------------------------------
# Dispatcher: IncidentStateCycle.commit()
# ---------------------------------------------------------------------------


@pytest.fixture()
def adopted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    paths = disp.state_paths()
    for key in (
        "outbox", "quarantine", "processing", "sent", "suppressed",
        "storm_collapsed", "storm_manifests", "dead_letter",
        "writefail_recovered", "writefail_quarantine", "testleak",
        "logs", "locks",
    ):
        paths[key].mkdir(parents=True, exist_ok=True)
    os.chmod(paths["incident_state"].parent, 0o700)
    with _dispatcher_session(paths) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=paths)
        cycle.payload["openIncidents"]["m|i|src"] = {"status": "open", "eventId": "e1"}
        cycle.commit()
    return paths


def _dispatcher_session(paths: dict[str, Path], ops: CountingOps | None = None):
    return cs.open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=disp.dispatcher_bootstrap_state,
        validate_payload=disp.validate_dispatcher_state,
        lock_timeout_seconds=10,
        file_ops=ops,
    )


def _primary(paths: dict[str, Path]) -> dict[str, Any]:
    return json.loads(paths["incident_state"].read_bytes())


def test_cycle_commit_with_nothing_changed_writes_nothing(adopted) -> None:
    paths = adopted
    directory = paths["incident_state"].parent
    on_disk = _primary(paths)
    state_files_before = {
        name: value for name, value in _snapshot(directory).items()
        if name.startswith("incident-state.json")
    }
    ops = CountingOps()
    with _dispatcher_session(paths, ops) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=paths)
        ops.calls.clear()
        for _ in range(3):
            result = cycle.commit()
            assert result.mode == "valid"
            assert result.generation == on_disk["_controllerState"]["generation"]
        assert ops.mutations() == []
        # The in-memory payload still mirrors disk, stamp included.
        assert cycle.payload["updatedAt"] == on_disk["updatedAt"]
    state_files_after = {
        name: value for name, value in _snapshot(directory).items()
        if name.startswith("incident-state.json")
    }
    assert state_files_after == state_files_before


def test_cycle_commit_with_a_change_publishes_journals_and_signs_as_before(adopted) -> None:
    paths = adopted
    anchor = paths["incident_state"]
    before = _primary(paths)
    before_raw = anchor.read_bytes()
    ops = CountingOps()
    with _dispatcher_session(paths, ops) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=paths)
        cycle.payload["openIncidents"]["m|i|src2"] = {"status": "open", "eventId": "e2"}
        ops.calls.clear()
        result = cycle.commit()
        # Full transaction: journal written and retired, .previous rotated,
        # primary and marker replaced -- all fsynced.
        assert ops.calls.count("replace") >= 4
        assert "unlink" in ops.calls
        assert ops.calls.count("fsync_file") >= 4
        # An immediately repeated commit is now the no-op.
        ops.calls.clear()
        again = cycle.commit()
        assert ops.mutations() == []
        assert again.generation == result.generation
    after = _primary(paths)
    meta = after["_controllerState"]
    assert result.generation == before["_controllerState"]["generation"] + 1
    assert meta["generation"] == result.generation
    assert "m|i|src2" in after["openIncidents"]
    assert after["updatedAt"] >= before["updatedAt"]
    assert (anchor.parent / f"{anchor.name}.previous").read_bytes() == before_raw
    assert not (anchor.parent / f"{anchor.name}.transaction").exists()
    marker = json.loads((anchor.parent / f"{anchor.name}.initialized").read_bytes())
    assert marker["highWaterGeneration"] == meta["generation"]
    assert marker["highWaterIntegritySha256"] == meta["integritySha256"]
    # The published store still loads as valid at the new generation.
    with _dispatcher_session(paths) as session:
        reloaded = session.load()
        assert reloaded.mode == "valid"
        assert reloaded.diagnostic.current_generation == meta["generation"]


def test_cycle_baseline_is_the_disk_not_the_constructor_payload(adopted) -> None:
    """A payload mutated BEFORE the cycle is built must still be persisted."""
    paths = adopted
    generation = _primary(paths)["_controllerState"]["generation"]
    with _dispatcher_session(paths) as session:
        loaded = session.load()
        payload = dict(loaded.payload)
        payload["lastSentAt"] = {"m|i|src": 123}
        cycle = disp.IncidentStateCycle(session, payload, loaded.capability, paths=paths)
        result = cycle.commit()
    assert result.generation == generation + 1
    assert _primary(paths)["lastSentAt"] == {"m|i|src": 123}


def test_cycle_sweep_removal_is_a_real_change(adopted, monkeypatch) -> None:
    """Housekeeping inside commit() that drops PERSISTED content still writes.

    The comparison runs after ``_normalize_incident_state_for_save``, so a
    sweep that removes an on-disk record is a real change even when the caller
    itself changed nothing.
    """
    paths = adopted
    with _dispatcher_session(paths) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=paths)
        now = int(disp.time.time())
        cycle.payload["conversationScopes"] = {
            "m|i|src": {"cs1_x": {"lastSeenAt": now, "eventIds": {}}}
        }
        cycle.commit()
    persisted = _primary(paths)
    assert "conversationScopes" in persisted
    generation = persisted["_controllerState"]["generation"]

    # Every record is now past retention: the save-path sweep removes it.
    monkeypatch.setattr(disp, "CONVERSATION_SCOPE_RETENTION_SECONDS", -1)
    with _dispatcher_session(paths) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=paths)
        result = cycle.commit()
    after = _primary(paths)
    assert "conversationScopes" not in after
    assert result.generation == after["_controllerState"]["generation"] == generation + 1


def test_cycle_sweep_of_unpersisted_content_is_a_no_op(adopted) -> None:
    """A sidecar that never reached disk and is swept away changes nothing."""
    paths = adopted
    generation = _primary(paths)["_controllerState"]["generation"]
    with _dispatcher_session(paths) as session:
        loaded = session.load()
        payload = dict(loaded.payload)
        payload["conversationScopes"] = {"m|i|closed": {"cs1_x": {"lastSeenAt": 1, "eventIds": {}}}}
        cycle = disp.IncidentStateCycle(session, payload, loaded.capability, paths=paths)
        result = cycle.commit()
    assert result.generation == generation
    assert _primary(paths)["_controllerState"]["generation"] == generation


@pytest.fixture()
def quiet_held_incident(adopted, monkeypatch):
    clock = [2_000_000_000]
    monkeypatch.setattr(disp.time, "time", lambda: clock[0])
    for name, value in {
        "SUPPRESS_STALE_INFO_RENOTIFY": True,
        "INCIDENT_STALE_SECONDS": 60,
        "INCIDENT_ESCALATE_SECONDS": 120,
        "AUTOCLOSE_LIVENESS_GATE": True,
        "AUTOCLOSE_LIVENESS_HOLD_CAP_SECONDS": 86400,
        "STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS": 0,
    }.items():
        monkeypatch.setattr(disp, name, value)
    sends = []
    monkeypatch.setattr(
        disp,
        "send_whatsapp",
        lambda text, *_args, **_kwargs: sends.append(text),
    )
    key = "host-a|bot-errors-health|daily-health-fail:instance-x"
    with _dispatcher_session(adopted) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=adopted)
        cycle.payload["openIncidents"] = {key: {
            "status": "stale", "openedAt": clock[0] - 1000,
            "lastSeenAt": clock[0] - 900, "lastSummary": "daily-health found issues",
        }}
        cycle.commit()
    return adopted, key, clock, sends


def _sweep_held(paths, mutate=None):
    ops = CountingOps()
    with _dispatcher_session(paths, ops) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=paths)
        if mutate:
            mutate(cycle.payload)
        ops.calls.clear()
        assert disp.sweep_stale_incidents(paths, incident=cycle) == (0, 0, None)
    return ops


def test_unchanged_stale_hold_avoids_state_writes_across_restarts(quiet_held_incident):
    paths, key, clock, sends = quiet_held_incident
    assert _sweep_held(paths).mutations()
    before = _primary(paths)
    for _ in range(9):
        clock[0] += 30
        assert _sweep_held(paths).mutations() == []
        assert _primary(paths) == before
    assert sends == []
    clock[0] += 30
    assert _sweep_held(paths).mutations()
    after = _primary(paths)
    assert after["openIncidents"][key]["staleSuppressedCount"] == 2
    assert after["openIncidents"][key]["autocloseFirstHeldAt"] == before["openIncidents"][key]["autocloseFirstHeldAt"]


def test_stale_hold_cap_is_checked_before_diagnostic_cadence(quiet_held_incident, monkeypatch):
    paths, key, clock, sends = quiet_held_incident
    monkeypatch.setattr(disp, "AUTOCLOSE_LIVENESS_HOLD_CAP_SECONDS", 45)
    _sweep_held(paths)
    clock[0] += 60
    assert _sweep_held(paths).mutations()
    assert key not in _primary(paths)["openIncidents"]
    assert len(sends) == 1 and "unverified" in sends[0].lower()


def test_verified_recovery_is_checked_before_diagnostic_cadence(quiet_held_incident):
    paths, key, clock, sends = quiet_held_incident
    _sweep_held(paths)
    clock[0] += 30
    def recover(payload):
        payload["openIncidents"][key]["lastEvidence"] = (
            "health instance-x: 200 status=healthy wa_connected=true state=connected "
            "auth_bond_status=present auth_bond_creds_exists=true "
            "auth_bond_creds_size=4096 auth_failure_class=none"
        )
    assert _sweep_held(paths, recover).mutations()
    assert key not in _primary(paths)["openIncidents"]
    assert len(sends) == 1


def test_actionable_stale_alert_does_not_wait_for_diagnostic_cadence(quiet_held_incident):
    paths, key, clock, sends = quiet_held_incident
    _sweep_held(paths)
    clock[0] += 30
    with _dispatcher_session(paths) as session:
        loaded = session.load()
        cycle = disp.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=paths)
        cycle.payload["openIncidents"][key]["failureCode"] = "WA_AUTH_BOND_SERVER_REVOKED"
        assert disp.sweep_stale_incidents(paths, incident=cycle) == (1, 0, None)
    assert len(sends) == 1
    record = _primary(paths)["openIncidents"][key]
    assert record["lastStaleRenotifiedAt"] == clock[0]


def test_backward_clock_step_does_not_freeze_suppression_diagnostics(quiet_held_incident):
    paths, key, clock, sends = quiet_held_incident
    _sweep_held(paths)
    clock[0] -= 10
    assert _sweep_held(paths).mutations()
    record = _primary(paths)["openIncidents"][key]
    assert record["lastStaleSuppressedAt"] == clock[0]
    assert record["staleSuppressedCount"] == 2
    assert sends == []
