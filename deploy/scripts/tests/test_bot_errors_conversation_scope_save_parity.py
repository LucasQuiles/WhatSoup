"""The conversation-scope sweep must bound state on the PRODUCTION save path.

``sweep_conversation_scopes`` had a single call site, inside
``save_incident_state`` — the RESTORE-COMPAT bare-JSON wrapper. Production
saves do not go through it: ``run_once`` constructs an ``IncidentStateCycle``
unconditionally, every save barrier reads ``if incident: incident.commit()
else: save_incident_state(...)``, and post-adoption
``_require_incident_cycle_if_adopted`` forbids the bare path outright. So the
retention window and the outer key cap that the configuration docs promise
were enforced only on a path production does not take.

These tests drive the controller-backed ``commit()`` and assert the bound
holds there. The compat-path test is the control: it passed before the fix as
well, which is what localises the gap to ``commit()`` rather than to the
sweep itself.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))

from lib.controller_state import open_controller_state  # noqa: E402

spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_save_parity", _SCRIPT)
disp = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
spec.loader.exec_module(disp)  # type: ignore[union-attr]

SOURCE = "agent_turn_admission_rejected"
MACHINE = "unknown"
SCOPE = "cs1_a1b2c3d4e5f60718"

_ENV_KEYS = ["BOT_ERRORS_STATE_DIR", "BOT_ERRORS_CONVERSATION_SCOPE_MAX_KEYS"]


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
        "outbox", "quarantine", "processing", "sent", "suppressed",
        "storm_collapsed", "storm_manifests", "dead_letter",
        "writefail_recovered", "writefail_quarantine", "testleak",
        "logs", "locks",
    ):
        paths[key].mkdir(parents=True, exist_ok=True)
    # controller_state rejects a group/other-writable anchor parent as
    # unsafe_file, which would fault the session before the assertion runs.
    os.chmod(paths["incident_state"].parent, 0o700)


def _session(paths: dict[str, Path]):
    return open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=disp.dispatcher_bootstrap_state,
        validate_payload=disp.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )


def _adopt(root: Path) -> dict[str, Path]:
    """Adopt the state dir via the session save path (creates .initialized)."""
    os.environ["BOT_ERRORS_STATE_DIR"] = str(root)
    paths = disp.state_paths()
    _make_dirs(paths)
    session = _session(paths)
    with session:
        result = session.load()
        session.save(dict(result.payload or {}), result.capability)
    return paths


def _bare(root: Path) -> dict[str, Path]:
    os.environ["BOT_ERRORS_STATE_DIR"] = str(root)
    paths = disp.state_paths()
    _make_dirs(paths)
    return paths


def _over_cap_scopes(payload: dict, over_by: int = 40) -> int:
    """Fill the sidecar past the outer cap with OPEN, FRESH keys.

    Every key is open and every record is fresh, so the closed-incident and
    retention arms of the sweep cannot fire. The only bound that can reduce
    the map is the outer key cap, which is what these tests measure.
    """
    now = int(time.time())
    total = disp.CONVERSATION_SCOPE_MAX_KEYS + over_by
    keys = [f"{MACHINE}|instance-{index:04d}|{SOURCE}" for index in range(total)]
    payload["openIncidents"] = {key: {"status": "open"} for key in keys}
    payload["conversationScopes"] = {
        key: {SCOPE: {"lastSeenAt": now - index, "eventIds": {}}}
        for index, key in enumerate(keys)
    }
    return total


def test_the_controller_backed_commit_bounds_the_conversation_scope_sidecar(tmp_path):
    """codex MED-2, the sharpest finding: the bound must hold on commit().

    Before the fix this asserted 168 keys persisted through commit(), because
    commit() called only now_iso and redacted_dispatcher_payload.
    """
    paths = _adopt(tmp_path / "adopted")
    session = _session(paths)
    with session:
        result = session.load()
        payload = dict(result.payload or {})
        total = _over_cap_scopes(payload)
        assert total > disp.CONVERSATION_SCOPE_MAX_KEYS
        assert len(payload["conversationScopes"]) == total

        cycle = disp.IncidentStateCycle(
            session, payload, result.capability, paths=paths
        )
        cycle.commit()

    assert len(payload["conversationScopes"]) == disp.CONVERSATION_SCOPE_MAX_KEYS


def test_control_the_compat_wrapper_already_bounded_the_sidecar(tmp_path):
    """CONTROL: save_incident_state enforced the same bound before the fix.

    This leg passes on both sides of the change. It is what makes the defect
    "commit() skips the sweep" rather than "the sweep does not work".
    """
    paths = _bare(tmp_path / "bare")
    payload = dict(disp.dispatcher_bootstrap_state())
    total = _over_cap_scopes(payload)
    assert len(payload["conversationScopes"]) == total

    disp.save_incident_state(paths, payload)

    assert len(payload["conversationScopes"]) == disp.CONVERSATION_SCOPE_MAX_KEYS


def test_a_failing_sweep_is_logged_and_still_lets_the_write_through(tmp_path):
    """SHOULD-1: a silently swallowed sweep failure means the bounds are off.

    The sweep's `except: pass` moved onto the PRODUCTION save path with the
    normaliser. Keeping the write unblocked is right -- a larger state file is
    recoverable, a lost incident update is not -- but swallowing without a
    signal means the documented 128-key and TTL bounds can stop holding with
    nothing to alert on. The failure is now logged through the module's own
    bounded, metadata-only helper.
    """
    paths = _adopt(tmp_path / "adopted")
    session = _session(paths)

    def _boom(state, current):
        raise RuntimeError("sweep exploded")

    logged: list[tuple] = []
    original_sweep = disp.sweep_conversation_scopes
    original_log = disp.log_conversation_scope_error
    disp.sweep_conversation_scopes = _boom  # type: ignore[assignment]
    disp.log_conversation_scope_error = (  # type: ignore[assignment]
        lambda phase, key, exc, treated: logged.append((phase, key, str(exc), treated))
    )
    try:
        with session:
            result = session.load()
            payload = dict(result.payload or {})
            payload["openIncidents"] = {"k": {"status": "open"}}
            cycle = disp.IncidentStateCycle(
                session, payload, result.capability, paths=paths
            )
            cycle.commit()
    finally:
        disp.sweep_conversation_scopes = original_sweep  # type: ignore[assignment]
        disp.log_conversation_scope_error = original_log  # type: ignore[assignment]

    # The write still completed: the normaliser stamped updatedAt and the
    # commit persisted, so housekeeping never blocks an incident update.
    assert payload.get("updatedAt"), "the state write must still complete"

    assert logged, "a swallowed sweep failure must still emit a signal"
    phase, _key, message, treated = logged[0]
    assert phase == "save_normalize", phase
    assert "sweep exploded" in message
    assert treated is False


def test_an_idle_cycle_still_sweeps_the_scope_sidecar(tmp_path):
    """SHOULD-3: retention must not depend on the queue being busy.

    The sweep runs inside the save path, and on a fully idle cycle nothing
    saves: run_once's only non-process_one commit sits behind `if emitted:`
    for the test-leak daily marker. So an orphaned or expired subtree was
    retained forever with an empty queue, contradicting the retention row in
    docs/configuration.md. This drives run_once with NO queued events and an
    orphaned subtree seeded, and asserts the sweep still bounded it.
    """
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path / "idle")
    paths = disp.setup_dirs()
    os.chmod(paths["incident_state"].parent, 0o700)

    now = int(time.time())
    orphan = f"{MACHINE}|instance-gone|{SOURCE}"
    session = _session(paths)
    with session:
        result = session.load()
        payload = dict(result.payload or {})
        # No open incident for this key: its subtree is dead weight.
        payload["openIncidents"] = {}
        payload["conversationScopes"] = {
            orphan: {SCOPE: {"lastSeenAt": now, "eventIds": {}}}
        }
        session.save(payload, result.capability)

    assert not list(paths["outbox"].glob("*.json")), "the cycle must be idle"
    disp.run_once(8)

    scopes = disp.load_incident_state(paths).get("conversationScopes") or {}
    assert orphan not in scopes, (
        "an idle cycle must still sweep an orphaned conversation-scope "
        f"subtree: {scopes!r}"
    )
