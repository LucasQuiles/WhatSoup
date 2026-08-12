"""#3054: post-adoption cycle-presence guard for IncidentStateCycle|None helpers.

Discriminating test for the save_incident_state envelope-corruption class
(#3053/#3054). Post-adoption (the state dir carries the ``.initialized``
marker) the incident-state primary is enveloped (``_controllerState``). A
cycle-accepting helper called with ``incident=None`` falls through to
``save_incident_state`` — the RESTORE-COMPAT bare-JSON wrapper — which would
overwrite the enveloped primary with bare JSON, so the next
``session.save()`` / ``_validate_envelope`` rejects it with
``schema_incompatible``. The ``_require_incident_cycle_if_adopted`` guard
fails that regression loudly at the helper boundary.

Removing the guard makes the post-adoption cases below STOP raising, so these
tests fail — that is the discrimination contract. Pre-adoption (no
``.initialized``) the bare write is the legitimate legacy/compat path, so the
guard is inert there (and when the cycle IS provided).
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))

from lib.controller_state import open_controller_state  # noqa: E402

spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_3054", _SCRIPT)
disp = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
spec.loader.exec_module(disp)  # type: ignore[union-attr]

_ENV_KEYS = ["BOT_ERRORS_STATE_DIR"]


@pytest.fixture(autouse=True)
def _clean_state_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _make_dirs(paths: dict[str, Path]) -> None:
    for key in (
        "outbox",
        "quarantine",
        "processing",
        "sent",
        "suppressed",
        "storm_collapsed",
        "storm_manifests",
        "dead_letter",
        "writefail_recovered",
        "writefail_quarantine",
        "testleak",
        "logs",
        "locks",
    ):
        paths[key].mkdir(parents=True, exist_ok=True)


def _adopt(root: Path) -> dict[str, Path]:
    """Adopt the state dir via the session save path (creates ``.initialized``)."""
    os.environ["BOT_ERRORS_STATE_DIR"] = str(root)
    paths = disp.state_paths()
    _make_dirs(paths)
    anchor = paths["incident_state"]
    session = open_controller_state(
        anchor,
        component="dispatcher-incident",
        bootstrap=disp.dispatcher_bootstrap_state,
        validate_payload=disp.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    with session:
        result = session.load()
        session.save(dict(result.payload or {}), result.capability)
    marker = paths["incident_state"].parent / (
        paths["incident_state"].name + ".initialized"
    )
    assert marker.exists(), "adoption fixture must create .initialized"
    return paths


def _bare(root: Path) -> dict[str, Path]:
    """Pre-adoption state dir (no ``.initialized`` — bare legacy/compat path)."""
    os.environ["BOT_ERRORS_STATE_DIR"] = str(root)
    paths = disp.state_paths()
    _make_dirs(paths)
    assert not (
        paths["incident_state"].parent / (paths["incident_state"].name + ".initialized")
    ).exists()
    return paths


# Each entry invokes one guarded helper with incident=None (the regression
# shape). The guard fires at entry, before any outbox/file work.
_GUARDED = [
    ("flap_scan_outbox", lambda p: disp.flap_scan_outbox(p)),
    ("sweep_flap_storms", lambda p: disp.sweep_flap_storms(p)),
    ("sweep_stale_incidents", lambda p: disp.sweep_stale_incidents(p)),
    ("collapse_ready_storms", lambda p: disp.collapse_ready_storms(p)),
    (
        "suppress_alerts_recovered_before_delivery",
        lambda p: disp.suppress_alerts_recovered_before_delivery(p),
    ),
    (
        "suppress_ready_recovery_duplicates",
        lambda p: disp.suppress_ready_recovery_duplicates(p),
    ),
    ("collapse_storm_group", lambda p: disp.collapse_storm_group(p, ("fp", 0), [], {})),
    ("process_one", lambda p: disp.process_one(p["outbox"] / "dummy.json", p)),
]


@pytest.mark.parametrize("name,call", _GUARDED)
def test_guard_raises_post_adoption_without_cycle(tmp_path, name, call):
    """DISCRIMINATOR: post-adoption + incident=None MUST raise
    IncidentCycleRequiredError. Fails if the guard is removed (no raise)."""
    paths = _adopt(tmp_path / "adopted")
    with pytest.raises(disp.IncidentCycleRequiredError):
        call(paths)


def test_guard_inert_pre_adoption(tmp_path):
    """Pre-adoption (no ``.initialized``), incident=None is the legitimate
    legacy path — the guard MUST NOT raise; helpers no-op on an empty outbox."""
    paths = _bare(tmp_path / "bare")
    assert disp.collapse_ready_storms(paths) == 0
    assert disp.flap_scan_outbox(paths) == 0
    assert disp.sweep_flap_storms(paths) == (0, 0)
    sent, failed, err = disp.sweep_stale_incidents(paths)
    assert (sent, failed) == (0, 0) and err is None
    assert disp.suppress_alerts_recovered_before_delivery(paths) == 0
    assert disp.suppress_ready_recovery_duplicates(paths) == 0


def test_guard_inert_when_cycle_provided(tmp_path):
    """Post-adoption WITH the cycle provided — the guard MUST NOT raise (the
    session save path is correct). Mirrors the run_once wiring."""
    root = tmp_path / "adopted"
    paths = _adopt(root)
    session = open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=disp.dispatcher_bootstrap_state,
        validate_payload=disp.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    with session:
        result = session.load()
        cycle = disp.IncidentStateCycle(
            session, result.payload, result.capability, paths=paths
        )
        # guard inert when incident is provided; empty outbox -> no-op, no commit
        assert disp.collapse_ready_storms(paths, incident=cycle) == 0
        assert disp.flap_scan_outbox(paths, incident=cycle) == 0


def test_bare_save_incident_state_does_not_create_initialized(tmp_path):
    """Corollary: the bare save_incident_state wrapper does NOT create the
    ``.initialized`` marker — the guard's adoption signal is solely the
    session save path, so a bare-seeded dir stays pre-adoption (guard inert)."""
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path / "bare2")
    paths = disp.state_paths()
    _make_dirs(paths)
    disp.save_incident_state(paths, {"openIncidents": {}})
    assert not (
        paths["incident_state"].parent / (paths["incident_state"].name + ".initialized")
    ).exists()
    # guard inert on this bare-seeded dir
    assert disp.collapse_ready_storms(paths) == 0
