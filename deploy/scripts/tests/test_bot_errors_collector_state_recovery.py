"""RED-first tests for collector controller-state adoption (recovery plan Task 3).

Written BEFORE the implementation. Verifies against `lib/controller_state.py`:
- bootstrap creates an enveloped, library-managed store
- legacy plain-JSON state migrates without value changes
- valid state advances its generation across cycles
- a corrupt primary recovers from the previous snapshot, retaining domain state
- reconciliation returns the validated recovered payload unchanged
  (`validated_previous_only`) with no redaction/timestamp rewrite
- both-corrupt state fail-stops (`ControllerStateRequired`), makes zero remote/
  probe/claim/ack/outbox effects, and leaves every non-exempt artifact untouched
- the collector process exits `STATE_RECOVERY_REQUIRED_EXIT` (78) on corrupt
  state with a content-free stderr diagnostic and no outbox artifact
- ordinary saves persist `redacted_collector_payload(state)`
- the watchdog's collector-state readers still parse a library-written store
  (mixed-version bundle safety for this PR)
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Shared module loader / tmp_state fixture / env-scoping helpers live in
# conftest.py and are loaded by file path because this suite runs under
# --import-mode=importlib (see the header comment in
# test_bot_errors_collector_backoff.py for the full rationale).
_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location(
    "bot_errors_collector_test_conftest", _CONFTEST_PATH
)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_env = _conftest._env
_load_mod_with_dirs = _conftest._load_mod_with_dirs
_run_once_defaults = _conftest._run_once_defaults
_all_outbox_events = _conftest._all_outbox_events

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
COLLECTOR_PATH = SCRIPTS_DIR / "bot-errors-collector.py"
WATCHDOG_PATH = SCRIPTS_DIR / "bot-errors-heartbeat-watchdog.py"

REMOTE = "h1.example"

# Every remote/probe/claim/ack/outbox seam in the collector. The forbidden-
# effect matrix patches all of them and requires zero calls on the
# recovery_required path.
FORBIDDEN_SEAMS = (
    "ssh_json_lines",
    "preflight_remote_unreachable",
    "remote_liveness_probe_ok",
    "remote_ack",
    "remote_writefail_ack",
    "remote_writefail_ack_degraded",
    # claim moves (copy_claim_atomic / move_claim_terminal) execute on the
    # remote host inside the shipped script; their only local channel is
    # ssh_json_lines, which is patched above.
    "relay_event",
    "relay_writefail",
    "_emit_collector_outbox_event",
    "emit_relay_host_state_event",
    "emit_collector_capture_escalation_event",
    "enqueue_meta_alert",
    "enqueue_meta_recovery",
    "defer_meta_recovery",
    "reset_tailscale_cache",
    "load_tailscale_status",
)

# metadata_only_controller_details output for a controller_state_mode record:
# projection strips "component" into the record envelope, everything else is
# the closed diagnostic detail set.
CLOSED_STATE_MODE_DETAIL_KEYS = {
    "schemaVersion",
    "stateMode",
    "reason",
    "currentGeneration",
    "recoveredGeneration",
    "recoveryReceiptId",
    "occurrenceCount",
    "stagingAttempt",
}

GARBAGE = b"{corrupt json \x00 not parseable"
# Assembled at runtime so the source never contains a token-shaped literal
# (the redaction under test keys on the assembled shape).
TOKEN_MARKER = "ghp_" + "0123456789abcdefghij0123456789abcdef"


def _happy_patches(stack: ExitStack, mod) -> None:
    stack.enter_context(
        patch.object(
            mod,
            "preflight_remote_unreachable",
            return_value={"status": "found", "online": True},
        )
    )
    stack.enter_context(patch.object(mod, "ssh_json_lines", return_value=[]))
    stack.enter_context(
        patch.object(mod, "remote_failure_context", return_value=([], {}))
    )


def _run_cycle(mod, remotes=None):
    with ExitStack() as stack:
        _happy_patches(stack, mod)
        return _run_once_defaults(mod, list(remotes or [REMOTE]))


def _read_payload(mod) -> dict:
    session = mod.open_collector_state_session()
    try:
        result = session.load()
        assert result.mode in {"bootstrap", "valid", "recovered", "reconciled"}
        return result.payload
    finally:
        session.close()


def _raw_doc(state_dir: Path) -> dict:
    return json.loads(
        (state_dir / "collector-state.json").read_text(encoding="utf-8")
    )


def _seed_saved_state(mod, payloads: list[dict]) -> None:
    """Persist payloads through the raw session (no redaction adapter)."""
    session = mod.open_collector_state_session()
    try:
        result = session.load()
        capability = result.capability
        for payload in payloads:
            commit = session.save(payload, capability)
            capability = commit.capability
    finally:
        session.close()


def _snapshot(*roots: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for root in roots:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                entries[f"{root.name}/{path.relative_to(root)}"] = digest
    return entries


def _rich_state(marker: str = "seed-1") -> dict:
    return {
        "remotes": {
            REMOTE: {
                "consecutiveFailures": 4,
                "backoffUntil": 4102444800,
                "downEventEmitted": True,
                "lastDrainAt": 1600000000,
                "lastDrainIso": "2020-09-13T12:26:40Z",
                "lastDrainError": f"boom {marker}",
            }
        },
        "alerts": {f"{REMOTE}|remote-drain-stale": 1600000000},
        "ackContributors": {REMOTE: ["writefail-1"]},
        "configuredRemotes": [REMOTE],
        "configuredRemoteHosts": [REMOTE.split(":", 1)[0]],
        "configuredBestEffortRemotes": [],
        "configuredBestEffortRemoteHosts": [],
        "updatedAt": "2020-09-13T12:26:40Z",
    }


# ---------------------------------------------------------------------------
# Bootstrap / migration / generation advancement
# ---------------------------------------------------------------------------


def test_bootstrap_creates_enveloped_state_via_library(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        assert mod.collector_bootstrap_state() == {"remotes": {}}
        result = _run_cycle(mod)
        assert result["failed"] == 0
        doc = _raw_doc(state_dir)
        metadata = doc["_controllerState"]
        assert metadata["component"] == "collector"
        assert isinstance(metadata["generation"], int)
        assert doc["configuredRemotes"] == [REMOTE]


def test_legacy_state_migrates_without_value_changes(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    legacy = _rich_state("legacy")
    (state_dir / "collector-state.json").write_text(
        json.dumps(legacy, sort_keys=True), encoding="utf-8"
    )
    os.chmod(state_dir / "collector-state.json", 0o600)
    with _env(state_dir, outbox_dir):
        session = mod.open_collector_state_session()
        try:
            # The library commits the migration on first load and reports it
            # as "reconciled"; the payload values are untouched.
            result = session.load()
            assert result.mode == "reconciled"
            assert result.payload == legacy
        finally:
            session.close()
        doc = _raw_doc(state_dir)
        payload = {k: v for k, v in doc.items() if k != "_controllerState"}
        assert payload == legacy
        assert doc["_controllerState"]["component"] == "collector"
        session = mod.open_collector_state_session()
        try:
            result = session.load()
            assert result.mode == "valid"
            assert result.payload == legacy
        finally:
            session.close()


def test_valid_state_generation_advances_across_cycles(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        _run_cycle(mod)
        first = _raw_doc(state_dir)["_controllerState"]["generation"]
        _run_cycle(mod)
        second = _raw_doc(state_dir)["_controllerState"]["generation"]
        assert second > first


# ---------------------------------------------------------------------------
# Recovery: corrupt primary, reconciliation semantics, fail-stop
# ---------------------------------------------------------------------------


def test_corrupt_primary_recovery_retains_previous_payload(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    rich_v1 = _rich_state("v1")
    rich_v2 = _rich_state("v2")
    with _env(state_dir, outbox_dir):
        _seed_saved_state(mod, [rich_v1, rich_v2])
        (state_dir / "collector-state.json").write_bytes(GARBAGE)
        session = mod.open_collector_state_session()
        try:
            result = session.load()
            assert result.mode == "recovered"
            assert result.payload == rich_v1
        finally:
            session.close()


def test_reconciliation_preserves_payload_without_redaction_rewrite(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    rich_v1 = _rich_state("v1")
    rich_v1["remotes"][REMOTE]["lastDrainError"] = f"boom {TOKEN_MARKER}"
    with _env(state_dir, outbox_dir):
        _seed_saved_state(mod, [rich_v1, _rich_state("v2")])
        (state_dir / "collector-state.json").write_bytes(GARBAGE)
        session = mod.open_collector_state_session()
        try:
            result = session.load()
            assert result.mode == "recovered"
            recovered, outcome = mod.reconcile_recovered_collector_state(
                result.payload
            )
            committed = session.complete_reconciliation(
                recovered, result.capability, outcome=outcome
            )
            assert committed.mode == "reconciled"
        finally:
            session.close()
        doc = _raw_doc(state_dir)
        # The recovered payload is preserved exactly: no redaction pass, no
        # timestamp rewrite.
        assert doc["remotes"][REMOTE]["lastDrainError"] == f"boom {TOKEN_MARKER}"
        assert doc["updatedAt"] == "2020-09-13T12:26:40Z"


def test_run_once_completes_recovery_and_retains_domain_roots(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    rich_v1 = _rich_state("v1")
    with _env(state_dir, outbox_dir):
        _seed_saved_state(mod, [rich_v1, _rich_state("v2")])
        (state_dir / "collector-state.json").write_bytes(GARBAGE)
        result = _run_cycle(mod)
        assert result["failed"] == 0
        payload = _read_payload(mod)
        assert REMOTE in payload["remotes"]
        assert payload["alerts"] == rich_v1["alerts"]
        assert payload["ackContributors"] == rich_v1["ackContributors"]


def test_restart_after_reconciliation_runs_clean(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        _seed_saved_state(mod, [_rich_state("v1"), _rich_state("v2")])
        (state_dir / "collector-state.json").write_bytes(GARBAGE)
        _run_cycle(mod)
        _run_cycle(mod)
        session = mod.open_collector_state_session()
        try:
            result = session.load()
            assert result.mode == "valid"
        finally:
            session.close()


def test_both_corrupt_fail_stops_with_controller_state_required(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    (state_dir / "collector-state.json").write_bytes(GARBAGE)
    os.chmod(state_dir / "collector-state.json", 0o600)
    with _env(state_dir, outbox_dir):
        with pytest.raises(mod.ControllerStateRequired):
            _run_cycle(mod)


# ---------------------------------------------------------------------------
# Candidate evidence / reconciliation adapter contract
# ---------------------------------------------------------------------------


def test_reconcile_recovered_collector_state_returns_unchanged_copy(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    payload = _rich_state("candidate")
    recovered, outcome = mod.reconcile_recovered_collector_state(payload)
    assert outcome == "validated_previous_only"
    assert recovered == payload
    assert recovered is not payload
    # Candidate evidence (configured remotes, claims, acks, probe fixtures)
    # takes only the validated previous payload as input; mutating the copy
    # must not leak back into recovered membership, clocks, or backoff.
    recovered["remotes"]["injected"] = {"consecutiveFailures": 0}
    recovered["alerts"]["injected"] = 1
    assert "injected" not in payload["remotes"]
    assert "injected" not in payload["alerts"]


def test_validator_rejects_non_object_remotes(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    with pytest.raises(Exception):
        mod.validate_collector_state({"remotes": ["not", "a", "mapping"]})
    sanitized = mod.validate_collector_state(
        {"remotes": {}, "_controllerState": {"format": "x"}}
    )
    assert "_controllerState" not in sanitized


# ---------------------------------------------------------------------------
# Save transform
# ---------------------------------------------------------------------------


def test_ordinary_save_applies_redaction_transform(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        session = mod.open_collector_state_session()
        try:
            result = session.load()
            state = {"remotes": {REMOTE: {"note": f"tok {TOKEN_MARKER}"}}}
            mod.save_collector_state(session, state, result.capability)
        finally:
            session.close()
        raw = (state_dir / "collector-state.json").read_text(encoding="utf-8")
        assert TOKEN_MARKER not in raw
        assert "[REDACTED_GITHUB_TOKEN]" in raw


# ---------------------------------------------------------------------------
# Forbidden effects on the recovery_required path
# ---------------------------------------------------------------------------


def test_recovery_required_makes_no_forbidden_effects(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    (state_dir / "collector-state.json").write_bytes(GARBAGE)
    os.chmod(state_dir / "collector-state.json", 0o600)
    with _env(state_dir, outbox_dir):
        before = _snapshot(state_dir, outbox_dir)
        mocks = {}
        with ExitStack() as stack:
            for seam in FORBIDDEN_SEAMS:
                mocks[seam] = stack.enter_context(
                    patch.object(mod, seam, MagicMock())
                )
            with pytest.raises(mod.ControllerStateRequired):
                _run_once_defaults(mod, [REMOTE])
        for seam, mock in mocks.items():
            assert mock.call_count == 0, f"forbidden seam called: {seam}"
        after = _snapshot(state_dir, outbox_dir)

        exempt_prefixes = (
            # Store-private sidecars (lock, receipt, evidence, marker); the
            # trailing dot keeps the primary itself non-exempt.
            f"{state_dir.name}/.collector-state.json.",
            f"{state_dir.name}/collector-state.json.",
            f"{state_dir.name}/logs/collector.jsonl",
            f"{state_dir.name}/controller-log-health/collector.json",
        )
        changed = {
            name
            for name in set(before) | set(after)
            if before.get(name) != after.get(name)
        }
        unexpected = {
            name
            for name in changed
            if not name.startswith(exempt_prefixes)
        }
        assert unexpected == set(), unexpected
        # The corrupt primary is preserved byte-for-byte.
        assert (state_dir / "collector-state.json").read_bytes() == GARBAGE
        # The outbox is untouched entirely.
        assert _all_outbox_events(outbox_dir) == []

        # Every exempt diagnostic uses the closed projection schema and leaks
        # no raw state content.
        log_path = state_dir / "logs" / "collector.jsonl"
        if log_path.exists():
            for line in log_path.read_text(encoding="utf-8").splitlines():
                record = json.loads(line)
                if record.get("recordKind") == "controller_state_mode":
                    assert set(record["details"]) <= CLOSED_STATE_MODE_DETAIL_KEYS
                    assert "corrupt json" not in line


# ---------------------------------------------------------------------------
# Process boundary: exit 78
# ---------------------------------------------------------------------------


def test_corrupt_state_exits_78_without_outbox_effect(tmp_state):
    state_dir, outbox_dir = tmp_state
    (state_dir / "collector-state.json").write_bytes(GARBAGE)
    os.chmod(state_dir / "collector-state.json", 0o600)
    env = dict(os.environ)
    env.update(
        {
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
            "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
        }
    )
    completed = subprocess.run(
        [
            sys.executable,
            str(COLLECTOR_PATH),
            "--remote",
            "fake-remote.invalid",
            "--max-events",
            "1",
            "--timeout",
            "1",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    assert completed.returncode == 78, (
        completed.returncode,
        completed.stdout,
        completed.stderr,
    )
    assert _all_outbox_events(outbox_dir) == []
    # stderr carries exactly one content-free diagnostic object.
    diagnostics = []
    for line in completed.stderr.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        parsed = json.loads(line)
        if parsed.get("stateMode") is not None:
            diagnostics.append(parsed)
    assert len(diagnostics) == 1, completed.stderr
    diagnostic = diagnostics[0]
    assert diagnostic["component"] == "collector"
    assert diagnostic["stateMode"] == "recovery_required"
    assert set(diagnostic) <= CLOSED_STATE_MODE_DETAIL_KEYS | {"component"}
    assert "corrupt json" not in completed.stderr


# ---------------------------------------------------------------------------
# Mixed-version bundle safety: watchdog readers of collector state
# ---------------------------------------------------------------------------


def _load_watchdog():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog_under_test", WATCHDOG_PATH
    )
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def test_library_written_state_remains_readable_by_watchdog(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    seeded = _rich_state("wd")
    seeded["configuredBestEffortRemoteHosts"] = ["besteffort.example"]
    with _env(state_dir, outbox_dir):
        _seed_saved_state(mod, [seeded])
        watchdog = _load_watchdog()
        configured = watchdog.collector_configured_hosts()
        assert configured == [REMOTE.split(":", 1)[0]]
        best_effort = watchdog.collector_best_effort_hosts()
        assert best_effort == ["besteffort.example"]
        evidence = watchdog.collector_reachability_evidence(
            REMOTE.split(":", 1)[0]
        )
        assert isinstance(evidence, str)
