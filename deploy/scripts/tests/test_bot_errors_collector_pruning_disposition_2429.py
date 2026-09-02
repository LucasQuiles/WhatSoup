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
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import pytest

_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest_2429", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_env = _conftest._env
_load_mod_with_dirs = _conftest._load_mod_with_dirs
_all_outbox_events = _conftest._all_outbox_events
_run_once_defaults = _conftest._run_once_defaults
_outbox_by_source = _conftest._outbox_by_source

_COLLECTOR_PATH = Path(__file__).resolve().parent.parent / "bot-errors-collector.py"

# The openAlerts-keyed sources this suite sweeps. Held here rather than read
# from the collector at collection time so the red-first run is reproducible:
# the suite still collects against a tree that has no REGISTERED_ALERT_SOURCES
# yet, which is exactly the tree a reviewer re-runs to see RED-2 fail.
# test_registry_covers_the_issue_acceptance_inventory asserts this list equals
# the module's own OPEN_ALERT_KEY_SOURCES, so the two cannot drift apart.
OPEN_ALERT_KEY_SOURCES = sorted(
    {
        "remote-claim-failed",
        "remote-drain-stale",
        "remote-relay-failed",
        "remote-writefail-harvest-failed",
        "remote-writefail-nondurable",
    }
)

RETIRED = "mini9:/var/tmp/bot-errors-drill"
KEPT = "mini5"
# Reserved synthetic remote for the cycle-level test, matching the identity
# convention the sibling state-recovery suite uses.
REMOTE = "h1.example"


def _happy_patches(stack: ExitStack, mod) -> None:
    """Neutralise every remote seam so a cycle reaches prune with no network."""
    stack.enter_context(
        patch.object(mod, "preflight_remote_unreachable", return_value={"status": "found", "online": True})
    )
    stack.enter_context(patch.object(mod, "ssh_json_lines", return_value=[]))
    stack.enter_context(patch.object(mod, "remote_failure_context", return_value=([], {})))


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


@pytest.mark.parametrize("source", OPEN_ALERT_KEY_SOURCES)
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


def test_prune_is_not_reentrant_on_its_own_output(tmp_state):
    """Re-pruning the SAME dict emits nothing new.

    This is non-reentrancy, not cross-cycle idempotence. A disposition is
    durable at publish_event_json + require_advance time while the pop is
    durable only at save_collector_state, so an abort between the two re-emits
    the whole disposition set on the next cycle. That is at-least-once
    delivery, the same shape enqueue_meta_recovery already has, and the
    duplicates are observation/info events that neither open nor close a
    dispatcher incident.
    """
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
                # Three failed payloads for ONE retired remote: the bucket is
                # digest-keyed, so this is the fan-out case.
                "a" * 64: {"remote": RETIRED, "payloadSha256": "b" * 64, "seenCount": 3},
                "e" * 64: {"remote": RETIRED, "payloadSha256": "f" * 64, "seenCount": 1},
                "0" * 64: {"remote": RETIRED, "payloadSha256": "1" * 64, "seenCount": 9},
                "c" * 64: {"remote": KEPT, "payloadSha256": "d" * 64, "seenCount": 1},
            },
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        assert list(state["writefailAckFailures"]) == ["c" * 64]
        emitted = _dispositions(outbox_dir)
        # ONE disposition for the remote, not one per digest.
        assert len(emitted) == 1
        assert emitted[0]["source"] == "remote-writefail-ack-failed"
        assert emitted[0]["diagnostics"]["dispositionStateLocation"] == mod.ALERT_STATE_ACK_FAILURES
        assert emitted[0]["diagnostics"]["retiredRecordCount"] == 3
        assert emitted[0]["diagnostics"]["remote"] == RETIRED


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


def _module_string_constants(tree: ast.Module) -> dict[str, str]:
    """Module-level `NAME = "single-line literal"` bindings.

    Multi-line values are excluded on purpose and are held accountable
    separately by test_every_source_named_constant_is_classified: the collector
    embeds a ~27KB remote helper script as REMOTE_DURABLE_JSON_SOURCE, which is
    program text, not an alert source. Resolving it here would flood the sweep,
    so instead every *_SOURCE constant must be explicitly classified below and a
    new one fails the classification test until someone decides which it is.
    """
    constants: dict[str, str] = {}
    for node in tree.body:
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
        else:
            continue
        value = node.value
        if not (isinstance(value, ast.Constant) and isinstance(value.value, str)):
            continue
        if "\n" in value.value:
            continue
        for target in targets:
            if isinstance(target, ast.Name):
                constants[target.id] = value.value
    return constants


def _resolve(arg: ast.expr, constants: dict[str, str]) -> str | None:
    """A string literal, or a Name bound to a module-level string constant."""
    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
        return arg.value
    if isinstance(arg, ast.Name):
        return constants.get(arg.id)
    return None


def _emitted_source_literals() -> set[str]:
    """Every source this module can mint an alert-bearing event under.

    Scans the collector's own AST rather than a hand-typed list, so a new emit
    site fails this test until the registry covers it. Three producing forms are
    swept, because the codebase uses all three:

    1. a string literal argument;
    2. a Name argument bound to a module-level string constant -- the form
       COLLECTOR_CAPTURE_ESCALATION_SOURCE uses, which the first revision of
       this sweep missed entirely (review F1);
    3. the VALUES of RELAY_HOST_STATE_KIND_SOURCES, which is the only place a
       relay-host `kind` becomes a source. Its keys are deliberately not swept:
       "relay_host_recovered" is a kind, never a source (#2419 maps it to the
       DOWN source so the clear keys onto the open incident), so sweeping keys
       would report a source that must never exist.
    """
    tree = ast.parse(_COLLECTOR_PATH.read_text())
    constants = _module_string_constants(tree)
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
                resolved = _resolve(node.args[1], constants)
                if resolved is not None:
                    literals.add(resolved)
            # clear_meta_recovery_progress(state, remote, source) -- source is 3rd.
            if name == "clear_meta_recovery_progress" and len(node.args) >= 3:
                resolved = _resolve(node.args[2], constants)
                if resolved is not None:
                    literals.add(resolved)
            if name == "_emit_collector_outbox_event":
                candidates = list(node.args[1:2])
                candidates += [kw.value for kw in node.keywords if kw.arg == "source"]
                for arg in candidates:
                    resolved = _resolve(arg, constants)
                    if resolved is not None:
                        literals.add(resolved)
        # Form 3: the relay-host kind -> source translation table.
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "RELAY_HOST_STATE_KIND_SOURCES" for t in node.targets
        ):
            if isinstance(node.value, ast.Dict):
                for value in node.value.values:
                    resolved = _resolve(value, constants)
                    if resolved is not None:
                        literals.add(resolved)
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id == "RELAY_HOST_STATE_KIND_SOURCES" and isinstance(node.value, ast.Dict):
                for value in node.value.values:
                    resolved = _resolve(value, constants)
                    if resolved is not None:
                        literals.add(resolved)
    return literals


def test_every_emitted_source_literal_is_registered(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    swept = _emitted_source_literals()
    # Coverage assertion: the sweep must actually reach all three producing
    # forms. An empty or truncated scan would otherwise pass vacuously, which
    # is exactly how the first revision stayed green while two of the eight
    # sources were invisible to it (review F1).
    assert "remote-claim-failed" in swept, "literal-argument form not swept"
    assert "remote-writefail-ack-failed" in swept, "event-dict literal form not swept"
    assert mod.COLLECTOR_CAPTURE_ESCALATION_SOURCE in swept, "module-constant form not swept"
    assert mod.RELAY_HOST_DOWN_SOURCE in swept, "relay-kind translation table not swept"
    assert len(swept) >= 8, f"sweep reached only {len(swept)} sources: {sorted(swept)}"
    registered = set(mod.REGISTERED_ALERT_SOURCES)
    assert swept <= registered, f"unregistered emit-site sources: {sorted(swept - registered)}"


# Every module-level constant whose name ends in _SOURCE must be classified.
# Adding one without a decision here is a test failure, which is what stops a
# new escalation tier from being minted outside the inventory (review F1a).
CLASSIFIED_ALERT_SOURCE = "alert-source"
CLASSIFIED_EMBEDDED_SCRIPT = "embedded-remote-script"

SOURCE_CONSTANT_DISPOSITIONS = {
    "COLLECTOR_CAPTURE_ESCALATION_SOURCE": CLASSIFIED_ALERT_SOURCE,
    "RELAY_HOST_DOWN_SOURCE": CLASSIFIED_ALERT_SOURCE,
    # Program text shipped to the remote host, not a source name.
    "REMOTE_DURABLE_JSON_SOURCE": CLASSIFIED_EMBEDDED_SCRIPT,
}


def test_every_source_named_constant_is_classified(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    tree = ast.parse(_COLLECTOR_PATH.read_text())
    found: set[str] = set()
    for node in tree.body:
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = list(node.targets)
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        for target in targets:
            if isinstance(target, ast.Name) and target.id.endswith("_SOURCE"):
                found.add(target.id)
    assert found, "scan found no *_SOURCE constants at all"
    unclassified = found - set(SOURCE_CONSTANT_DISPOSITIONS)
    assert not unclassified, (
        f"unclassified *_SOURCE constant(s): {sorted(unclassified)}. Add each to "
        "SOURCE_CONSTANT_DISPOSITIONS as an alert source (and to "
        "REGISTERED_ALERT_SOURCES) or as an embedded script."
    )
    stale = set(SOURCE_CONSTANT_DISPOSITIONS) - found
    assert not stale, f"SOURCE_CONSTANT_DISPOSITIONS names constants that no longer exist: {sorted(stale)}"
    for name, disposition in SOURCE_CONSTANT_DISPOSITIONS.items():
        if disposition == CLASSIFIED_ALERT_SOURCE:
            assert getattr(mod, name) in mod.REGISTERED_ALERT_SOURCES, (
                f"{name} is classified as an alert source but is not registered"
            )


def test_remote_record_sources_declare_an_open_flag(tmp_state):
    """The flag map and the registry must agree in both directions.

    Before this, the prune branched on hand-typed flag names, so a third
    remote-record tier could be registered and still have its open state
    deleted with no disposition, with nothing red (review F1).
    """
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    registered_remote_record = {
        source
        for source, location in mod.REGISTERED_ALERT_SOURCES.items()
        if location == mod.ALERT_STATE_REMOTE_RECORD
    }
    assert set(mod.REMOTE_RECORD_OPEN_FLAGS) == registered_remote_record
    assert registered_remote_record == {
        mod.COLLECTOR_CAPTURE_ESCALATION_SOURCE,
        mod.RELAY_HOST_DOWN_SOURCE,
    }
    for flag in mod.REMOTE_RECORD_OPEN_FLAGS.values():
        assert isinstance(flag, str) and flag


def test_relay_host_kind_translation_is_closed(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    # Every kind resolves to a REGISTERED source, and the recovered kind
    # deliberately carries the DOWN source (#2419) rather than one of its own.
    for kind, source in mod.RELAY_HOST_STATE_KIND_SOURCES.items():
        assert source in mod.REGISTERED_ALERT_SOURCES, f"{kind} maps to unregistered {source}"
    assert mod.relay_host_state_source("relay_host_recovered") == mod.RELAY_HOST_DOWN_SOURCE
    assert mod.relay_host_state_source("relay_host_down") == mod.RELAY_HOST_DOWN_SOURCE
    assert "relay_host_recovered" not in mod.REGISTERED_ALERT_SOURCES
    # An unknown kind fails closed instead of minting an unregistered source.
    with pytest.raises(mod.UnregisteredAlertSourceError) as excinfo:
        mod.relay_host_state_source("relay_host_flapping")
    assert "unregistered_relay_host_kind" in str(excinfo.value)
    assert "relay_host_flapping" not in str(excinfo.value)


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
    # openAlerts-keyed subset is suffix-matched by split_alert_key.
    for source in registered:
        assert mod.REGISTERED_ALERT_SOURCES[source] in {
            mod.ALERT_STATE_OPEN_ALERTS,
            mod.ALERT_STATE_ACK_FAILURES,
            mod.ALERT_STATE_REMOTE_RECORD,
        }
    assert set(mod.OPEN_ALERT_KEY_SOURCES) == {
        s for s, loc in mod.REGISTERED_ALERT_SOURCES.items() if loc == mod.ALERT_STATE_OPEN_ALERTS
    }
    # Pins what test_red2_* parametrises over against the module's own
    # inventory. A source added to (or dropped from) the registry without a
    # matching change here fails this assertion instead of quietly leaving the
    # sweep short, and the sweep cannot pass vacuously on an empty list.
    assert OPEN_ALERT_KEY_SOURCES == sorted(mod.OPEN_ALERT_KEY_SOURCES)
    assert len(OPEN_ALERT_KEY_SOURCES) == 5


def test_split_alert_key_splits_registered_and_refuses_the_rest(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    # A remote containing a colon still splits on the trailing source suffix.
    assert mod.split_alert_key(f"{RETIRED}:remote-drain-stale") == (RETIRED, "remote-drain-stale")
    assert mod.split_alert_key(f"{RETIRED}:not-a-registered-source") is None
    # split_alert_key reports; require_registered_alert_keys is what fails closed.
    with pytest.raises(mod.UnregisteredAlertSourceError):
        mod.require_registered_alert_keys([f"{RETIRED}:not-a-registered-source"])
    assert not hasattr(mod, "alert_remote_from_key"), (
        "alert_remote_from_key had no production caller after #2429; it was removed "
        "so nothing adopts a raising contract nobody exercises"
    )


# --- the alerts-only (legacy) branch ---------------------------------------


def test_alerts_only_key_is_dispositioned_as_legacy(tmp_state):
    """An alerts timestamp with no openAlerts record still owns an episode.

    legacy_open_record() exists precisely to materialise an open incident from
    a pre-open-incident alerts timestamp, so retiring one is retiring an open
    lifecycle and must not be silent either.
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        key = f"{RETIRED}:remote-relay-failed"
        state = {
            "remotes": {RETIRED: {}, KEPT: {}},
            "alerts": {key: 1_700_000_000},
            "openAlerts": {},
        }
        mod.prune_state_to_configured_remotes(state, [KEPT])

        assert state["alerts"] == {}
        emitted = _dispositions(outbox_dir)
        assert len(emitted) == 1
        assert emitted[0]["diagnostics"]["priorStatus"] == "legacy"
        assert emitted[0]["diagnostics"]["dispositionStateLocation"] == mod.ALERT_STATE_OPEN_ALERTS


# --- cycle-level fail-closed (not just the prune function) ------------------


def test_unregistered_key_fails_the_whole_cycle_closed(tmp_state):
    """The operational claim, pinned: the CYCLE fails closed, not just prune.

    Every other test in this file calls prune_state_to_configured_remotes
    directly. This one drives a real cycle through run_once against a durable
    ledger, so a later refactor that wraps the cycle in a broad `except` or
    moves the prune below the first effect turns red here (review F2).
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        # Seed a durable ledger through the collector's own session writer.
        session = mod.open_collector_state_session()
        try:
            payload, capability = mod._load_collector_state_for_cycle(session)
            payload["remotes"] = {REMOTE: {}}
            payload["openAlerts"] = {f"{REMOTE}:collector-disk-full": _open_record()}
            mod.save_collector_state(session, payload, capability)
        finally:
            session.close()

        state_file = state_dir / "collector-state.json"
        before = state_file.read_bytes()
        assert _all_outbox_events(outbox_dir) == []

        with ExitStack() as stack:
            _happy_patches(stack, mod)
            with pytest.raises(mod.UnregisteredAlertSourceError) as excinfo:
                _run_once_defaults(mod, [REMOTE])

        assert "unregistered_alert_source" in str(excinfo.value)
        # Nothing committed, nothing published: the prior ledger is intact and
        # still recoverable.
        assert state_file.read_bytes() == before
        assert _all_outbox_events(outbox_dir) == []
