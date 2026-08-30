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
from pathlib import Path

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
