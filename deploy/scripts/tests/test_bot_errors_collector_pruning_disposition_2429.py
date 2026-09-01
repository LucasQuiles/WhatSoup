"""#2429 residual half: configuration-pruning terminal disposition.

The fail-closed-load half of #2429 is already closed by the controller-state
session (collector) and PR #3053 (dispatcher). This suite owns only the
remaining half: ``prune_state_to_configured_remotes`` used to ``pop`` open
alert bookkeeping for a no-longer-configured remote with no audited terminal
record, and recognised only three of the registered alert sources, silently
retaining every other source's key.

Contract pinned here:

- every retiring open record emits exactly one ``configuration_retired``
  disposition through the collector's normal durable outbox path BEFORE its
  state is removed;
- the disposition is an ``observation`` envelope, never a ``clear`` -- a
  configuration retirement is not health evidence and must not close the
  dispatcher incident as recovered (issue text: "Do not manufacture a
  recovery clear");
- the pruning source inventory is the registry every collector emitter mints
  from, so a registered-but-uninventoried source can no longer strand;
- an unregistered key fails closed: nothing is published, nothing is popped.
"""
from __future__ import annotations

import ast
import copy
import importlib.util
import json
from pathlib import Path

import pytest

_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest_2429", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_env = _conftest._env
_load_mod_with_dirs = _conftest._load_mod_with_dirs
_all_outbox_events = _conftest._all_outbox_events
_outbox_by_source = _conftest._outbox_by_source

_COLLECTOR_PATH = Path(__file__).resolve().parent.parent / "bot-errors-collector.py"

RETIRED = "mini9:/var/tmp/bot-errors-drill"
KEPT = "mini5"


def _open_record(opened_at: int = 1_700_000_000) -> dict:
    return {
        "status": "open",
        "eventId": "collector-synthetic-open",
        "openedAt": opened_at,
        "openedIso": "2026-09-01T00:00:00Z",
        "lastSeenAt": opened_at,
        "lastSeenIso": "2026-09-01T00:00:00Z",
        "lastEvidence": "synthetic",
        "suppressedCount": 0,
    }


def _dispositions(outbox_dir: Path) -> list[dict]:
    found = []
    for event in _all_outbox_events(outbox_dir):
        diagnostics = event.get("diagnostics")
        if isinstance(diagnostics, dict) and diagnostics.get("disposition") == "configuration_retired":
            found.append(event)
    return found


# --- RED-1: retiring an open record emitted no terminal disposition ---------


def test_red1_retired_open_alert_emits_terminal_disposition(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {
            "remotes": {RETIRED: {"lastError": "old drill alias"}, KEPT: {}},
            "alerts": {f"{RETIRED}:remote-claim-failed": 1_700_000_000},
            "openAlerts": {f"{RETIRED}:remote-claim-failed": _open_record()},
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        assert state["openAlerts"] == {}
        assert state["alerts"] == {}

        emitted = _dispositions(outbox_dir)
        assert len(emitted) == 1, f"expected one configuration_retired disposition, got {len(emitted)}"


# --- RED-2: a registered-but-uninventoried source was silently retained -----


@pytest.mark.parametrize(
    "source",
    [
        "remote-claim-failed",
        "remote-drain-stale",
        "remote-relay-failed",
        "remote-writefail-harvest-failed",
        "remote-writefail-nondurable",
    ],
)
def test_red2_every_registered_open_alert_source_is_pruned_and_dispositioned(tmp_state, source):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        key = f"{RETIRED}:{source}"
        state = {
            "remotes": {RETIRED: {}, KEPT: {}},
            "alerts": {},
            "openAlerts": {key: _open_record()},
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        assert key not in state["openAlerts"], f"{source} record stranded after its remote was unconfigured"
        emitted = _dispositions(outbox_dir)
        assert len(emitted) == 1
        assert emitted[0]["source"] == source


# --- disposition record shape ----------------------------------------------


def test_disposition_record_shape_is_pinned(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {
            "remotes": {RETIRED: {}, KEPT: {}},
            "alerts": {},
            "openAlerts": {f"{RETIRED}:remote-drain-stale": _open_record()},
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        emitted = _dispositions(outbox_dir)
        assert len(emitted) == 1
        event = emitted[0]

        # Envelope: an observation, NEVER a clear. A clear would route through
        # the dispatcher's incident_recovery path and close the incident as
        # recovered, which is exactly the false recovery #2429 forbids.
        assert event["eventType"] == "observation"
        assert event["eventKind"] == "observation"
        assert event["severity"] == "info"

        # Identity: same source + diagnostics.remote as the alert it retires,
        # so the disposition lands on that incident's key, not a new one.
        assert event["source"] == "remote-drain-stale"
        assert event["instance"] == "bot-errors-collector"

        diagnostics = event["diagnostics"]
        assert diagnostics["remote"] == RETIRED
        assert diagnostics["disposition"] == "configuration_retired"
        assert diagnostics["dispositionReason"] == "remote_not_configured"
        assert diagnostics["dispositionSource"] == "remote-drain-stale"
        assert diagnostics["dispositionStateLocation"] == mod.ALERT_STATE_OPEN_ALERTS
        assert isinstance(diagnostics["retiredAt"], int) and diagnostics["retiredAt"] > 0
        assert diagnostics["retiredAtIso"].endswith("Z")
        assert diagnostics["priorStatus"] == "open"
        assert len(diagnostics["alertKeyDigest"]) == 16
        # Content-free digest: never the raw key.
        assert RETIRED not in diagnostics["alertKeyDigest"]


# --- fail closed on an unregistered source ---------------------------------


def test_unregistered_alert_source_fails_closed(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {
            "remotes": {RETIRED: {}, KEPT: {}},
            "alerts": {},
            "openAlerts": {
                f"{RETIRED}:remote-claim-failed": _open_record(),
                f"{RETIRED}:remote-brand-new-source": _open_record(),
            },
        }
        before = copy.deepcopy(state)

        with pytest.raises(mod.UnregisteredAlertSourceError) as excinfo:
            mod.prune_state_to_configured_remotes(state, [KEPT])

        # Validation precedes every effect: no event published, no key popped.
        assert _all_outbox_events(outbox_dir) == []
        assert state == before

        message = str(excinfo.value)
        assert "unregistered_alert_source" in message
        # Bounded + content-free: no raw key, no remote identity, no path.
        assert RETIRED not in message
        assert "remote-brand-new-source" not in message


def test_unregistered_source_failure_is_bounded_and_counted(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {
            "remotes": {KEPT: {}},
            "alerts": {f"{RETIRED}:unknown-a": 1},
            "openAlerts": {f"{RETIRED}:unknown-b": _open_record()},
        }
        with pytest.raises(mod.UnregisteredAlertSourceError) as excinfo:
            mod.prune_state_to_configured_remotes(state, [KEPT])
        assert "keys=2" in str(excinfo.value)


# --- configured remotes are untouched, and pruning is idempotent ------------


def test_configured_remote_open_alert_is_untouched(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        key = f"{KEPT}:remote-claim-failed"
        state = {
            "remotes": {KEPT: {"lastSuccessAt": 1}},
            "alerts": {key: 1_700_000_000},
            "openAlerts": {key: _open_record()},
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        assert state["openAlerts"][key]["status"] == "open"
        assert state["alerts"][key] == 1_700_000_000
        assert state["remotes"][KEPT] == {"lastSuccessAt": 1}
        assert _all_outbox_events(outbox_dir) == []


def test_second_prune_emits_nothing_new(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {
            "remotes": {RETIRED: {}, KEPT: {}},
            "alerts": {},
            "openAlerts": {f"{RETIRED}:remote-relay-failed": _open_record()},
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])
        first = len(_all_outbox_events(outbox_dir))
        assert first == 1

        mod.prune_state_to_configured_remotes(state, [KEPT])
        assert len(_all_outbox_events(outbox_dir)) == first


# --- acknowledgement membership --------------------------------------------


def test_writefail_ack_membership_is_dispositioned_before_deletion(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {
            "remotes": {RETIRED: {}, KEPT: {}},
            "writefailAckFailures": {
                "a" * 64: {"remote": RETIRED, "payloadSha256": "b" * 64, "seenCount": 3},
                "c" * 64: {"remote": KEPT, "payloadSha256": "d" * 64, "seenCount": 1},
            },
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        assert list(state["writefailAckFailures"]) == ["c" * 64]
        emitted = _dispositions(outbox_dir)
        assert len(emitted) == 1
        assert emitted[0]["source"] == "remote-writefail-ack-failed"
        assert emitted[0]["diagnostics"]["dispositionStateLocation"] == mod.ALERT_STATE_ACK_FAILURES


# --- direct escalation tiers ------------------------------------------------


def test_direct_escalation_tiers_are_dispositioned_before_deletion(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {
            "remotes": {
                RETIRED: {"captureFailureEscalated": True, "downEventEmitted": True, "downSince": 1},
                KEPT: {},
            },
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        assert list(state["remotes"]) == [KEPT]
        by_source = _outbox_by_source(outbox_dir)
        assert len(by_source[mod.COLLECTOR_CAPTURE_ESCALATION_SOURCE]) == 1
        assert len(by_source[mod.RELAY_HOST_DOWN_SOURCE]) == 1
        for events in by_source.values():
            for event in events:
                assert event["eventType"] == "observation"
                assert event["diagnostics"]["dispositionStateLocation"] == mod.ALERT_STATE_REMOTE_RECORD


def test_quiet_remote_record_emits_no_disposition(tmp_state):
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state = {"remotes": {RETIRED: {"lastSuccessAt": 1}, KEPT: {}}}
        mod.prune_state_to_configured_remotes(state, [KEPT])
        assert list(state["remotes"]) == [KEPT]
        assert _all_outbox_events(outbox_dir) == []


# --- registry drift guard (coverage assertion, not a positive control) ------


def _emitted_source_literals() -> set[str]:
    """Every string literal this module mints an alert-bearing event under.

    Scans the collector's own AST rather than a hand-typed list, so a new
    emit site with a new source literal fails this test until the registry
    covers it.
    """
    tree = ast.parse(_COLLECTOR_PATH.read_text())
    literals: set[str] = set()
    positional_second = {"enqueue_meta_alert", "enqueue_meta_recovery", "defer_meta_recovery"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if (
                    isinstance(key, ast.Constant)
                    and key.value == "source"
                    and isinstance(value, ast.Constant)
                    and isinstance(value.value, str)
                ):
                    literals.add(value.value)
        if isinstance(node, ast.Call):
            name = node.func.id if isinstance(node.func, ast.Name) else None
            if name in positional_second and len(node.args) >= 2:
                arg = node.args[1]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    literals.add(arg.value)
            # clear_meta_recovery_progress(state, remote, source) -- source is 3rd.
            if name == "clear_meta_recovery_progress" and len(node.args) >= 3:
                arg = node.args[2]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    literals.add(arg.value)
            if name == "_emit_collector_outbox_event":
                candidates = list(node.args[1:2])
                candidates += [kw.value for kw in node.keywords if kw.arg == "source"]
                for arg in candidates:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        literals.add(arg.value)
    return literals


def test_every_emitted_source_literal_is_registered(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    literals = _emitted_source_literals()
    # Coverage assertion: the scan must actually find the known emit sites.
    # An empty or truncated scan would otherwise pass vacuously.
    assert "remote-claim-failed" in literals
    assert "remote-writefail-ack-failed" in literals
    assert len(literals) >= 6
    registered = set(mod.REGISTERED_ALERT_SOURCES)
    assert literals <= registered, f"unregistered emit-site sources: {sorted(literals - registered)}"


def test_registry_covers_the_issue_acceptance_inventory(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    registered = set(mod.REGISTERED_ALERT_SOURCES)
    required = {
        "remote-claim-failed",
        "remote-drain-stale",
        "remote-relay-failed",
        "remote-writefail-harvest-failed",
        "remote-writefail-nondurable",
        "remote-writefail-ack-failed",
        mod.COLLECTOR_CAPTURE_ESCALATION_SOURCE,
        mod.RELAY_HOST_DOWN_SOURCE,
    }
    assert required <= registered
    # Every registered source declares where its state lives, and only the
    # openAlerts-keyed subset is suffix-matched by alert_remote_from_key.
    for source in registered:
        assert mod.REGISTERED_ALERT_SOURCES[source] in {
            mod.ALERT_STATE_OPEN_ALERTS,
            mod.ALERT_STATE_ACK_FAILURES,
            mod.ALERT_STATE_REMOTE_RECORD,
        }
    assert set(mod.OPEN_ALERT_KEY_SOURCES) == {
        s for s, loc in mod.REGISTERED_ALERT_SOURCES.items() if loc == mod.ALERT_STATE_OPEN_ALERTS
    }


def test_alert_remote_from_key_rejects_unregistered_source(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    assert mod.alert_remote_from_key(f"{RETIRED}:remote-drain-stale") == RETIRED
    with pytest.raises(mod.UnregisteredAlertSourceError):
        mod.alert_remote_from_key(f"{RETIRED}:not-a-registered-source")
