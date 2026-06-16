"""TDD tests for transient-unreachable severity downgrade in bot-errors-collector.

GOAL: When a remote host is transiently unreachable (tailscale_offline,
tailscale_online_ssh_timeout, tailscale_online_ssh_failed), the pre-threshold
meta-alerts for remote-claim-failed and remote-writefail-harvest-failed must
be emitted at "warning" severity rather than "critical".

Genuine / non-transient errors (e.g. tailscale_online_ssh_remote_error, or no
reachability diagnosis at all) must keep "critical".

The relay_host_down / backoff / recovery paths are NOT changed — only the
pre-threshold per-attempt meta-alert severity.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Module loader (same pattern as other collector tests)
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_collector", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


@pytest.fixture()
def tmp_state(tmp_path: Path):
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return state_dir, outbox_dir


def _load_mod_with_dirs(state_dir: Path, outbox_dir: Path):
    return _load_module(extra_env={
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    })


def _run_once_defaults(mod, remotes: list[str], **kwargs):
    defaults = dict(
        best_effort_remotes=set(),
        max_events=5,
        timeout=5,
        lease_seconds=30,
        remote_sla=9999,
        alert_cooldown=0,   # zero so meta-alerts always fire (no cooldown skip)
        recovery_successes=2,
    )
    defaults.update(kwargs)
    return mod.run_once(remotes, **defaults)


def _read_outbox_events(outbox_dir: Path) -> list[dict]:
    """Read all JSON events from the outbox directory."""
    events = []
    for f in outbox_dir.glob("*.json"):
        try:
            events.append(json.loads(f.read_text()))
        except json.JSONDecodeError:
            pass
    return events


TRANSIENT_DIAGNOSES = [
    "tailscale_offline",
    "tailscale_online_ssh_timeout",
    "tailscale_online_ssh_failed",
]

NON_TRANSIENT_DIAGNOSES = [
    "tailscale_online_ssh_remote_error",
    None,  # no diagnosis at all
]


# ===========================================================================
# 1. Predicate: is_transient_unreachable
# ===========================================================================

class TestIsTransientUnreachable:
    """Unit tests for the new is_transient_unreachable(diagnostics) predicate."""

    def test_function_exists_on_module(self, tmp_state):
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        assert hasattr(mod, "is_transient_unreachable"), (
            "is_transient_unreachable() must be present on the module"
        )
        assert callable(mod.is_transient_unreachable)

    @pytest.mark.parametrize("diagnosis", TRANSIENT_DIAGNOSES)
    def test_returns_true_for_transient_diagnoses(self, tmp_state, diagnosis):
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        diagnostics = {"reachabilityDiagnosis": diagnosis}
        assert mod.is_transient_unreachable(diagnostics) is True, (
            f"is_transient_unreachable must return True for diagnosis={diagnosis!r}"
        )

    @pytest.mark.parametrize("diagnosis", ["tailscale_online_ssh_remote_error"])
    def test_returns_false_for_non_transient_ssh_remote_error(self, tmp_state, diagnosis):
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        diagnostics = {"reachabilityDiagnosis": diagnosis}
        assert mod.is_transient_unreachable(diagnostics) is False, (
            f"is_transient_unreachable must return False for diagnosis={diagnosis!r}"
        )

    def test_returns_false_for_missing_diagnosis(self, tmp_state):
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        assert mod.is_transient_unreachable({}) is False
        assert mod.is_transient_unreachable({"reachabilityDiagnosis": None}) is False
        assert mod.is_transient_unreachable({"reachabilityDiagnosis": ""}) is False

    def test_returns_false_for_empty_diagnostics(self, tmp_state):
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        assert mod.is_transient_unreachable({}) is False


# ===========================================================================
# 2. enqueue_meta_alert severity parameter
# ===========================================================================

def _with_env(state_dir: Path, outbox_dir: Path):
    """Context manager: set BOT_ERRORS_STATE_DIR + BOT_ERRORS_OUTBOX_DIR."""
    import contextlib

    @contextlib.contextmanager
    def _ctx():
        env_map = {
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
            "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
        }
        backup = {k: os.environ.get(k) for k in env_map}
        for k, v in env_map.items():
            os.environ[k] = v
        try:
            yield
        finally:
            for k, orig in backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig

    return _ctx()


class TestEnqueueMetaAlertSeverityParam:
    """enqueue_meta_alert must accept an optional severity parameter that
    controls the event severity emitted into the outbox."""

    def test_default_severity_is_critical(self, tmp_state):
        """When severity is not passed, the emitted event must be critical."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state: dict = {}
        with _with_env(state_dir, outbox_dir):
            mod.enqueue_meta_alert(
                "host:/srv/bot-errors",
                "remote-claim-failed",
                "summary",
                "evidence",
                state,
                0,   # cooldown=0 → always fires
            )
        events = _read_outbox_events(outbox_dir)
        assert len(events) == 1, f"Expected 1 outbox event, got {len(events)}"
        assert events[0]["severity"] == "critical", (
            f"Default severity must be 'critical', got {events[0]['severity']!r}"
        )

    def test_explicit_warning_severity_emits_warning_event(self, tmp_state):
        """When severity='warning' is passed, the emitted event must be warning."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state: dict = {}
        with _with_env(state_dir, outbox_dir):
            mod.enqueue_meta_alert(
                "host:/srv/bot-errors",
                "remote-claim-failed",
                "summary",
                "evidence",
                state,
                0,
                severity="warning",
            )
        events = _read_outbox_events(outbox_dir)
        assert len(events) == 1, f"Expected 1 outbox event, got {len(events)}"
        assert events[0]["severity"] == "warning", (
            f"Explicit severity='warning' must produce warning event, got {events[0]['severity']!r}"
        )

    def test_explicit_critical_severity_emits_critical_event(self, tmp_state):
        """Explicit severity='critical' must produce a critical event (identity check)."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state: dict = {}
        with _with_env(state_dir, outbox_dir):
            mod.enqueue_meta_alert(
                "host:/srv/bot-errors",
                "remote-claim-failed",
                "summary",
                "evidence",
                state,
                0,
                severity="critical",
            )
        events = _read_outbox_events(outbox_dir)
        assert len(events) == 1, f"Expected 1 outbox event, got {len(events)}"
        assert events[0]["severity"] == "critical"

    def test_renotify_event_uses_passed_severity(self, tmp_state):
        """When a re-notify fires (open incident + cooldown elapsed), the
        severity of the new re-notify event must respect the passed severity."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        state: dict = {}

        with _with_env(state_dir, outbox_dir):
            # First call: opens the incident (severity=warning).
            mod.enqueue_meta_alert(
                "host:/srv/bot-errors",
                "remote-claim-failed",
                "summary",
                "evidence",
                state,
                0,
                severity="warning",
            )
            # Second call: re-notify (cooldown=0 → always re-notifies).
            mod.enqueue_meta_alert(
                "host:/srv/bot-errors",
                "remote-claim-failed",
                "summary",
                "evidence",
                state,
                0,
                severity="warning",
            )
        events = _read_outbox_events(outbox_dir)
        assert len(events) == 2, f"Expected 2 events (open + renotify), got {len(events)}"
        for ev in events:
            assert ev["severity"] == "warning", (
                f"Re-notify event severity must be 'warning', got {ev['severity']!r}"
            )


# ===========================================================================
# 3. remote-claim-failed severity via run_once
# ===========================================================================

class TestRemoteClaimFailedSeverity:
    """remote-claim-failed meta-alert must be 'warning' for transient-unreachable
    diagnoses and 'critical' for non-transient / unknown diagnoses."""

    def _run_with_diagnosis(self, mod, state_dir, outbox_dir, diagnosis):
        """Run once with a faked remote_failure_context that returns the given diagnosis."""
        remote = "machost:/srv/whatsoup/bot-errors"
        host = "machost"

        diag_dict = (
            {"reachabilityDiagnosis": diagnosis}
            if diagnosis is not None
            else {}
        )
        diag_lines = (
            [f"reachabilityDiagnosis={diagnosis}"]
            if diagnosis is not None
            else []
        )

        env_map = {
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
            "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
        }
        backup = {k: os.environ.get(k) for k in env_map}
        for k, v in env_map.items():
            os.environ[k] = v
        try:
            with patch.object(mod, "ssh_json_lines", side_effect=RuntimeError("connection refused")), \
                 patch.object(mod, "remote_failure_context", return_value=(diag_lines, diag_dict)):
                _run_once_defaults(mod, [remote])
        finally:
            for k, orig in backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig

    @pytest.mark.parametrize("diagnosis", TRANSIENT_DIAGNOSES)
    def test_transient_diagnosis_produces_warning_alert(self, tmp_state, diagnosis):
        """pre-threshold remote-claim-failed must be 'warning' for transient diagnoses."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        self._run_with_diagnosis(mod, state_dir, outbox_dir, diagnosis)

        events = _read_outbox_events(outbox_dir)
        claim_events = [e for e in events if e.get("source") == "remote-claim-failed"]
        assert len(claim_events) >= 1, (
            f"Expected at least 1 remote-claim-failed event for diagnosis={diagnosis!r}"
        )
        for ev in claim_events:
            assert ev["severity"] == "warning", (
                f"diagnosis={diagnosis!r}: expected severity='warning', got {ev['severity']!r}"
            )

    @pytest.mark.parametrize("diagnosis", ["tailscale_online_ssh_remote_error"])
    def test_non_transient_diagnosis_keeps_critical(self, tmp_state, diagnosis):
        """Non-transient diagnosis must keep 'critical' severity."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        self._run_with_diagnosis(mod, state_dir, outbox_dir, diagnosis)

        events = _read_outbox_events(outbox_dir)
        claim_events = [e for e in events if e.get("source") == "remote-claim-failed"]
        assert len(claim_events) >= 1, (
            f"Expected at least 1 remote-claim-failed event for diagnosis={diagnosis!r}"
        )
        for ev in claim_events:
            assert ev["severity"] == "critical", (
                f"diagnosis={diagnosis!r}: expected severity='critical', got {ev['severity']!r}"
            )

    def test_no_diagnosis_keeps_critical(self, tmp_state):
        """When no reachability diagnosis is set, severity must stay 'critical'."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        self._run_with_diagnosis(mod, state_dir, outbox_dir, None)

        events = _read_outbox_events(outbox_dir)
        claim_events = [e for e in events if e.get("source") == "remote-claim-failed"]
        for ev in claim_events:
            assert ev["severity"] == "critical", (
                f"No diagnosis: expected severity='critical', got {ev['severity']!r}"
            )


# ===========================================================================
# 4. remote-writefail-harvest-failed severity via run_once
# ===========================================================================

class TestWritefailHarvestSeverity:
    """remote-writefail-harvest-failed meta-alert must be 'warning' for transient
    diagnoses and 'critical' for non-transient ones."""

    def _run_with_writefail_diagnosis(self, mod, state_dir, outbox_dir, diagnosis):
        """Run once where outbox succeeds but writefail harvest fails with given diagnosis."""
        remote = "machost:/srv/whatsoup/bot-errors"
        host = "machost"

        diag_dict = (
            {"reachabilityDiagnosis": diagnosis}
            if diagnosis is not None
            else {}
        )
        diag_lines = (
            [f"reachabilityDiagnosis={diagnosis}"]
            if diagnosis is not None
            else []
        )

        # fake_ssh: first call (outbox CLAIM_SCRIPT) succeeds → returns []
        # second call (REMOTE_WRITEFAIL_CLAIM_SCRIPT) → raises
        call_count = [0]

        def fake_ssh(h, script, args, timeout):
            call_count[0] += 1
            if script is mod.REMOTE_CLAIM_SCRIPT:
                return []   # outbox claim succeeds
            raise RuntimeError("connection refused")  # writefail fails

        env_map = {
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
            "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
        }
        backup = {k: os.environ.get(k) for k in env_map}
        for k, v in env_map.items():
            os.environ[k] = v
        try:
            with patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
                 patch.object(mod, "remote_failure_context", return_value=(diag_lines, diag_dict)):
                _run_once_defaults(mod, [remote])
        finally:
            for k, orig in backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig

    @pytest.mark.parametrize("diagnosis", TRANSIENT_DIAGNOSES)
    def test_transient_writefail_produces_warning(self, tmp_state, diagnosis):
        """pre-threshold remote-writefail-harvest-failed must be 'warning' for transient."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        self._run_with_writefail_diagnosis(mod, state_dir, outbox_dir, diagnosis)

        events = _read_outbox_events(outbox_dir)
        wf_events = [e for e in events if e.get("source") == "remote-writefail-harvest-failed"]
        assert len(wf_events) >= 1, (
            f"Expected writefail event for diagnosis={diagnosis!r}; got events: {[e.get('source') for e in events]}"
        )
        for ev in wf_events:
            assert ev["severity"] == "warning", (
                f"diagnosis={diagnosis!r}: expected severity='warning', got {ev['severity']!r}"
            )

    def test_non_transient_writefail_keeps_critical(self, tmp_state):
        """Non-transient diagnosis must keep 'critical' for writefail harvest."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        self._run_with_writefail_diagnosis(mod, state_dir, outbox_dir, "tailscale_online_ssh_remote_error")

        events = _read_outbox_events(outbox_dir)
        wf_events = [e for e in events if e.get("source") == "remote-writefail-harvest-failed"]
        assert len(wf_events) >= 1, "Expected writefail event for non-transient diagnosis"
        for ev in wf_events:
            assert ev["severity"] == "critical", (
                f"Non-transient: expected severity='critical', got {ev['severity']!r}"
            )


# ===========================================================================
# 5. relay_host_down path is UNCHANGED
# ===========================================================================

class TestRelayHostDownUnchanged:
    """The relay_host_down / backoff path must NOT be affected by the severity change.
    relay_host_down uses emit_relay_host_state_event, not enqueue_meta_alert,
    so it is already outside the scope — but we confirm no regression."""

    def test_relay_host_down_event_emitted_without_severity_field_interference(self, tmp_state):
        """After RELAY_BACKOFF_FAILURE_THRESHOLD failures, relay_host_down is emitted
        (not remote-claim-failed), regardless of the transient diagnosis."""
        state_dir, outbox_dir = tmp_state
        mod = _load_mod_with_dirs(state_dir, outbox_dir)

        remote = "machost:/srv/whatsoup/bot-errors"
        threshold = mod.RELAY_BACKOFF_FAILURE_THRESHOLD

        diag_dict = {"reachabilityDiagnosis": "tailscale_offline"}
        diag_lines = ["reachabilityDiagnosis=tailscale_offline"]

        env_map = {
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
            "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
        }
        backup = {k: os.environ.get(k) for k in env_map}
        for k, v in env_map.items():
            os.environ[k] = v
        try:
            with patch.object(mod, "ssh_json_lines", side_effect=RuntimeError("connection refused")), \
                 patch.object(mod, "remote_failure_context", return_value=(diag_lines, diag_dict)):
                # Run enough cycles to cross the threshold.
                for _ in range(threshold + 1):
                    _run_once_defaults(mod, [remote])
        finally:
            for k, orig in backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig

        events = _read_outbox_events(outbox_dir)
        sources = [e.get("source") for e in events]
        # relay_host_down must have fired.
        assert "relay_host_down" in sources, (
            f"relay_host_down event must be emitted after {threshold} failures; sources={sources}"
        )
        # After threshold, no new per-attempt remote-claim-failed alerts (suppressed).
        # We can't assert count==0 for pre-threshold ones, but we assert relay_host_down exists.
