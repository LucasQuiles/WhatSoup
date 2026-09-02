"""Writer-level adoption guard for save_incident_state (#3053/#3054 follow-up).

``_require_incident_cycle_if_adopted`` is a *helper-boundary* check. It asks
"does an IncidentStateCycle exist?" and returns inert as soon as one is
supplied. That is not the same question as "does this write use the cycle?",
so a helper can pass the boundary guard holding a cycle and still reach the
bare-JSON wrapper on a later branch.

``collapse_storm_group`` is exactly that shape: it calls the boundary guard on
entry, then on its superseding branch calls ``save_incident_state`` directly.
Post-adoption that overwrites the ``_controllerState`` envelope with bare JSON,
so the next validate rejects the primary as ``schema_incompatible`` -- the
corruption class #3053 fixed, reachable again through a guard that "passed".

Patching the individual call sites would leave the next one exposed. The guard
therefore lives in ``save_incident_state`` itself, where it covers every caller
including ones added later: post-adoption the bare write is never legitimate.
Pre-adoption it remains the correct legacy/compat path, so the guard is inert
there, and ``IncidentStateCycle.commit()`` persists via ``session.save()`` and
never routes through the wrapper, so the supported path is untouched.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_guard", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def dispatcher():
    return _load_dispatcher()


def _anchor(tmp_path: Path, *, adopted: bool) -> Path:
    anchor = tmp_path / "incident-state.json"
    anchor.write_text("{}")
    if adopted:
        (tmp_path / "incident-state.json.initialized").write_text("")
    return anchor


def test_adoption_detector_tracks_the_initialized_marker(dispatcher, tmp_path):
    anchor = _anchor(tmp_path, adopted=False)
    assert dispatcher._incident_state_is_adopted(anchor) is False
    (tmp_path / "incident-state.json.initialized").write_text("")
    assert dispatcher._incident_state_is_adopted(anchor) is True


def test_bare_write_allowed_pre_adoption(dispatcher, tmp_path):
    """Legacy/compat path: no marker means the bare write is still correct."""
    anchor = _anchor(tmp_path, adopted=False)
    assert dispatcher._incident_state_is_adopted(anchor) is False
    assert dispatcher._reject_bare_write_if_adopted(anchor) is None


def test_bare_write_rejected_post_adoption(dispatcher, tmp_path):
    anchor = _anchor(tmp_path, adopted=True)
    with pytest.raises(dispatcher.IncidentCycleRequiredError) as excinfo:
        dispatcher._reject_bare_write_if_adopted(anchor)
    assert "save_incident_state" in str(excinfo.value)


def test_save_incident_state_refuses_post_adoption_without_any_boundary_guard(
    dispatcher, tmp_path
):
    """The regression: the 4876 shape, reaching the writer with no guard run.

    If this raises anything other than IncidentCycleRequiredError -- including
    succeeding -- the writer attempted a bare-JSON write over an enveloped
    primary, which is the corruption itself.
    """
    anchor = _anchor(tmp_path, adopted=True)
    with pytest.raises(dispatcher.IncidentCycleRequiredError):
        dispatcher.save_incident_state({"incident_state": anchor}, {"k": "v"})


def test_save_incident_state_does_not_write_when_it_refuses(dispatcher, tmp_path):
    """The refusal must be fail-closed: the primary is left byte-identical."""
    anchor = _anchor(tmp_path, adopted=True)
    anchor.write_text('{"sentinel": "enveloped-primary"}')
    before = anchor.read_bytes()
    with pytest.raises(dispatcher.IncidentCycleRequiredError):
        dispatcher.save_incident_state({"incident_state": anchor}, {"k": "v"})
    assert anchor.read_bytes() == before


def test_boundary_guard_still_inert_when_a_cycle_is_supplied(dispatcher, tmp_path):
    """Unchanged behaviour -- and non-vacuous: the same inputs raise without one."""
    anchor = _anchor(tmp_path, adopted=True)
    paths = {"incident_state": anchor}
    assert (
        dispatcher._require_incident_cycle_if_adopted(
            paths, object(), helper="collapse_storm_group"
        )
        is None
    )
    with pytest.raises(dispatcher.IncidentCycleRequiredError):
        dispatcher._require_incident_cycle_if_adopted(
            paths, None, helper="collapse_storm_group"
        )


# ---------------------------------------------------------------------------
# The live-incident falsifier: collapse_storm_group's superseding branch.
#
# The writer guard above turns a silent corruption into a raised error, which
# is strictly better but still an outage -- the dispatcher then crash-loops on
# exit 78. The *direct* defect is that one branch never gated its write:
# ``save_incident_state`` has 12 executable call sites in this file and 11 were wrapped in
# ``if incident: incident.commit() else: ...``. The superseding-digest branch
# of ``collapse_storm_group`` was the sole exception, so a caller holding a
# cycle still bare-wrote the primary and destroyed the envelope.
#
# Reaching that branch needs two things at once: a *second* storm batch after
# the first digest was delivered (the superseding revision), and an event whose
# ``source`` starts with ``daily-health`` -- only that sets ``state_changed``.
# Both held on 2026-08-30: a daily-health FAIL burst across six hosts at
# 11:20:52Z, a storm collapse at 11:20:54Z, envelope gone at 11:21:31Z.
# ---------------------------------------------------------------------------

_HEALTHY_PROBE = "http_status=200 health_status=healthy"


def _adopt_via_real_session(dispatcher, root: Path, monkeypatch) -> dict[str, Path]:
    """Adopt the store through the REAL controller-state session.

    Deliberately not a hand-written marker file. ``controller_state`` owns the
    ``.initialized`` suffix and spells it internally; if it ever moves or
    renames the marker, this fixture stops adopting and every guard test below
    fails loudly. A synthetic marker would keep these tests green while the
    production guard silently failed *open* -- the guard would stop guarding
    and nothing would say so.
    """
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    paths = dispatcher.setup_dirs()
    anchor = paths["incident_state"]
    session = dispatcher.open_controller_state(
        anchor,
        component="dispatcher-incident",
        bootstrap=dispatcher.dispatcher_bootstrap_state,
        validate_payload=dispatcher.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    with session:
        result = session.load()
        session.save(dict(result.payload or {}), result.capability)
    marker = anchor.parent / (anchor.name + ".initialized")
    assert marker.exists(), "adoption fixture must go through the real writer"
    return paths


def _member(event_id: str, machine: str, base_epoch: int) -> dict[str, Any]:
    """A daily-health storm member -- the source that sets ``state_changed``."""
    return {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health",
        "machine": machine,
        "instance": "eh-bot",
        "summary": f"storm member {event_id}",
        "evidence": f"health eh-bot: {_HEALTHY_PROBE}",
        "createdAt": _iso(event_id, base_epoch),
        "diagnostics": {"relay": {"remoteHost": machine}},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
    }


def _iso(_event_id: str, base_epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(base_epoch))


def _queue(paths: dict[str, Path], name: str, event: dict[str, Any]) -> Path:
    path = paths["outbox"] / name
    path.write_text(json.dumps(event), encoding="utf-8")
    path.chmod(0o600)
    return path


def test_superseding_branch_must_not_reach_the_bare_writer(
    dispatcher, tmp_path, monkeypatch
):
    """RED before the gate: the superseding branch bare-writes despite a cycle.

    Drives the real ``collapse_storm_group`` against an adopted store while
    holding an ``IncidentStateCycle``. Pre-fix the branch calls
    ``save_incident_state`` unconditionally, so the writer guard fires and this
    raises ``IncidentCycleRequiredError`` -- proving the branch reaches the
    bare writer. Post-fix it commits through the cycle and the envelope on disk
    is still intact.
    """
    monkeypatch.setenv("BOT_ERRORS_STORM_THRESHOLD", "2")
    monkeypatch.setenv("BOT_ERRORS_STORM_WINDOW_SECONDS", "120")
    monkeypatch.setattr(
        dispatcher, "send_whatsapp", lambda text, socket_path="": None, raising=False
    )
    paths = _adopt_via_real_session(dispatcher, tmp_path, monkeypatch)
    base = int(time.time())

    m1 = _member("e1", "host-a", base)
    m2 = _member("e2", "host-b", base)
    _queue(paths, "a.json", m1)
    _queue(paths, "b.json", m2)
    fingerprint = dispatcher.storm_fingerprint(m1)

    session = dispatcher.open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=dispatcher.dispatcher_bootstrap_state,
        validate_payload=dispatcher.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    with session:
        loaded = session.load()
        cycle = dispatcher.IncidentStateCycle(
            session, loaded.payload, loaded.capability, paths=paths
        )
        # Batch 1 -> initial manifest + queued digest.
        dispatcher.collapse_storm_group(
            paths,
            (fingerprint, base),
            [(paths["outbox"] / "a.json", m1), (paths["outbox"] / "b.json", m2)],
            cycle.payload,
            incident=cycle,
        )
        # Deliver the digest: its evidence is now immutable, so the next batch
        # must create a *superseding* revision -- the branch under test.
        digests = [p for p in paths["outbox"].glob("*.json") if "storm-collapse" in p.name]
        assert len(digests) == 1, f"expected one queued digest, got {len(digests)}"
        os.replace(digests[0], paths["sent"] / f"{digests[0].name}.{base}.sent")

        m3 = _member("e3", "host-c", base + 30)
        _queue(paths, "c.json", m3)
        # Pre-fix this raises IncidentCycleRequiredError from the writer guard.
        dispatcher.collapse_storm_group(
            paths,
            (fingerprint, base),
            [(paths["outbox"] / "c.json", m3)],
            cycle.payload,
            incident=cycle,
        )

    primary = json.loads(paths["incident_state"].read_text(encoding="utf-8"))
    # The absorbed daily-health signal must reach the COMMITTED primary. Without
    # this the branch could persist nothing at all and still keep the envelope.
    assert "host-c" in (primary.get("dailyHealthFreshness") or {}), (
        "superseding branch committed nothing: the absorbed host is missing from the primary"
    )
    assert "_controllerState" in primary, (
        "superseding branch destroyed the envelope -- this is the #3053 "
        "corruption that crash-loops the dispatcher on exit 78"
    )


# ---------------------------------------------------------------------------
# Review findings on the 2026-09-02 recut (Codex + Opus adversarial reviews).
# ---------------------------------------------------------------------------


def test_storm_branch_refuses_a_state_dict_that_is_not_the_cycle_payload(dispatcher, tmp_path, monkeypatch):
    """commit() persists incident.payload; a different dict would be dropped.

    The identity check runs at entry, before any member publication or manifest
    write, so a mis-wired caller fails closed with nothing half-applied.
    """
    paths = _adopt_via_real_session(dispatcher, tmp_path, monkeypatch)
    base = int(time.time())
    fingerprint = "identity-check"
    m1 = _member("e1", "host-a", base)
    _queue(paths, "a.json", m1)
    session = dispatcher.open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=dispatcher.dispatcher_bootstrap_state,
        validate_payload=dispatcher.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    with session:
        loaded = session.load()
        cycle = dispatcher.IncidentStateCycle(
            session, loaded.payload, loaded.capability, paths=paths
        )
        with pytest.raises(ValueError, match="incident.payload"):
            dispatcher.collapse_storm_group(
                paths,
                (fingerprint, base),
                [(paths["outbox"] / "a.json", m1)],
                dict(loaded.payload or {}),
                incident=cycle,
            )
    assert (paths["outbox"] / "a.json").exists(), "entry check must run before any member move"
    assert not list(paths["storm_manifests"].glob("*.json")), "entry check must run before any manifest write"


def test_writer_refuses_bare_json_over_an_observed_envelope_without_the_marker(dispatcher, tmp_path):
    """Closes the adoption race: marker absent, but the file already carries the envelope."""
    anchor = tmp_path / "incident-state.json"
    envelope = {"_controllerState": {"schemaVersion": 1, "generation": 3}, "updatedAt": "2026-09-02T00:00:00Z"}
    anchor.write_text(json.dumps(envelope), encoding="utf-8")
    anchor.chmod(0o600)  # durable_json refuses group/other-readable targets before any guard runs
    assert dispatcher._incident_state_is_adopted(anchor) is False
    before = anchor.read_bytes()
    with pytest.raises(dispatcher.IncidentCycleRequiredError, match="_controllerState"):
        dispatcher.save_incident_state({"incident_state": anchor}, {"incidents": {}})
    assert anchor.read_bytes() == before, "the envelope must survive untouched"


def test_daemon_exits_loudly_when_the_writer_guard_fires(dispatcher, monkeypatch, capsys):
    """Under --daemon the guard must stop the loop, not be swallowed as a failed cycle.

    A swallowed guard called record_state, which drops cycleCompletedAt and
    parks the deadman on the cycle_incomplete branch that a 30s interval never
    trips. Exiting keeps the last cycleCompletedAt on disk so cycle_stale can
    fire after the unit restarts.
    """

    def boom(_max_events):
        raise dispatcher.IncidentCycleRequiredError("save_incident_state: refusing a post-adoption bare-JSON write")

    def never(*_args, **_kwargs):
        raise AssertionError("the guard path must not record state or sleep")

    monkeypatch.setattr(dispatcher, "run_once", boom)
    monkeypatch.setattr(dispatcher, "setup_dirs", never)
    monkeypatch.setattr(dispatcher, "record_state", never)
    monkeypatch.setattr(dispatcher.time, "sleep", never)
    with pytest.raises(SystemExit) as raised:
        dispatcher.run_daemon(30, 25)
    assert raised.value.code == dispatcher.INCIDENT_CYCLE_REQUIRED_EXIT == 79
    out = capsys.readouterr().out
    record = json.loads(out.strip().splitlines()[-1])
    assert record["exit"] == 79 and "post-adoption" in record["error"]


def test_bare_writer_waits_for_the_controller_adoption_lock(dispatcher, tmp_path):
    """The bare write must serialise with adoption on ``<anchor>.lock``.

    While another holder has the exclusive flock, the writer must not touch the
    primary; once released, the pre-adoption bare write proceeds normally.
    """
    import fcntl

    anchor = tmp_path / "incident-state.json"
    anchor.write_text('{"sentinel": "pre-adoption"}', encoding="utf-8")
    anchor.chmod(0o600)
    lock_path = tmp_path / "incident-state.json.lock"
    holder = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(holder, fcntl.LOCK_EX)
        before = anchor.read_bytes()
        with pytest.raises(TimeoutError, match="adoption lock"):
            dispatcher.save_incident_state({"incident_state": anchor}, {"incidents": {}}, lock_timeout_seconds=0.2)
        assert anchor.read_bytes() == before, "the primary must not change while the lock is held elsewhere"
        fcntl.flock(holder, fcntl.LOCK_UN)
    finally:
        os.close(holder)
    dispatcher.save_incident_state({"incident_state": anchor}, {"incidents": {}}, lock_timeout_seconds=0.2)
    assert json.loads(anchor.read_text(encoding="utf-8")).get("incidents") == {}


def test_bare_writer_lock_is_the_controller_session_lock(dispatcher, tmp_path, monkeypatch):
    """Prove both writers contend on the same file: a real session cannot open while the bare writer's lock is held."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    paths = dispatcher.setup_dirs()
    anchor = paths["incident_state"]
    with dispatcher._AdoptionLock(anchor, 0.2):
        with pytest.raises(Exception) as raised:
            session = dispatcher.open_controller_state(
                anchor,
                component="dispatcher-incident",
                bootstrap=dispatcher.dispatcher_bootstrap_state,
                validate_payload=dispatcher.validate_dispatcher_state,
                lock_timeout_seconds=0.2,
            )
            with session:
                session.load()
        if isinstance(raised.value, dispatcher.ControllerStateRequired):
            details = json.dumps(dispatcher.state_diagnostic_details(raised.value.diagnostic))
            assert "lock" in details, details
        else:
            assert isinstance(raised.value, TimeoutError), repr(raised.value)
    # Released: the same session shape now adopts normally (adoption happens on save).
    session = dispatcher.open_controller_state(
        anchor,
        component="dispatcher-incident",
        bootstrap=dispatcher.dispatcher_bootstrap_state,
        validate_payload=dispatcher.validate_dispatcher_state,
        lock_timeout_seconds=2,
    )
    with session:
        result = session.load()
        session.save(dict(result.payload or {}), result.capability)
    assert dispatcher._incident_state_is_adopted(anchor)
