"""Tests for sustained-connection-stability as an alternative recovery proof
for AUTOCLOSE_PROTECTED WhatsApp incidents (whatsapp_device_bond_lost,
instance_logged_out).

Problem: a server-revoked bond (WA_AUTH_BOND_SERVER_REVOKED) forces a socket
disconnect within seconds. The original clear gate required a post-relink
outbound send to prove the bond is alive server-side. But low-traffic bots
and allowlist-restricted instances may never send an organic message after a
relink, so their verified-healthy bond-lost incidents can never self-clear
(ghost incidents that renotify daily forever).

Fix: accept a SUSTAINED stable connection (process uptime above threshold +
zero reconnect attempts + base verified WhatsApp health) as an ALTERNATIVE
to outbound proof. A process connected for 10+ minutes with zero reconnects
cannot have a revoked bond.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_SUPPRESS_STALE_INFO_RENOTIFY",
    "BOT_ERRORS_INCIDENT_STALE_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SECONDS",
    "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS",
    "BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES",
    "BOT_ERRORS_AUTOCLOSE_REOPEN_WINDOW_SECONDS",
    "BOT_ERRORS_AUTOCLOSE_LIVENESS_GATE",
    "BOT_ERRORS_AUTOCLOSE_LIVENESS_HOLD_CAP_SECONDS",
    "BOT_ERRORS_SUSTAINED_STABILITY_MIN_UPTIME_SECONDS",
]


class IsolatedDispatcherTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in _ENV_KEYS}
        for key in _ENV_KEYS:
            os.environ.pop(key, None)
        self._temp = tempfile.TemporaryDirectory(prefix="bot-errors-sustained-")
        self.state_dir = Path(self._temp.name)
        os.environ["BOT_ERRORS_STATE_DIR"] = str(self.state_dir)

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self._temp.cleanup()

    def assert_isolated(self, mod: Any) -> None:
        self.assertEqual(mod.state_root().resolve(), self.state_dir.resolve())


def _load(extra_env: dict[str, str] | None = None):
    env = {"BOT_ERRORS_SUSTAINED_STABILITY_MIN_UPTIME_SECONDS": "600"}
    if extra_env:
        env.update(extra_env)
    for k, v in env.items():
        os.environ[k] = v
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_sustained", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# Base verified-health probe (satisfies is_verified_whatsapp_health_recovery with
# require_outbound_proof=False). This is the minimum for ANY recovery.
_BASE_VERIFIED = (
    "200 status=healthy wa_connected=true state=connected "
    "auth_bond_status=present auth_bond_creds_exists=true "
    "auth_bond_creds_size=4096 auth_failure_class=none"
)


def _probe_with_stability(uptime: int = 7200, reconnect_attempts: int = 0) -> str:
    """A verified-health probe with sustained stability fields."""
    return (
        f"{_BASE_VERIFIED} "
        f"lifecycle_process_uptime_seconds={uptime} "
        f"reconnect_attempts={reconnect_attempts}"
    )


def _probe_with_outbound(after_epoch: int) -> str:
    """A verified-health probe with post-incident outbound proof."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(after_epoch))
    return (
        f"{_BASE_VERIFIED} "
        f"outbound_success_transport_present=true "
        f"outbound_success_at={ts}"
    )


# ---------------------------------------------------------------------------
# Unit tests: has_sustained_connection_stability
# ---------------------------------------------------------------------------

class TestSustainedConnectionStability(IsolatedDispatcherTestCase):
    def test_accepts_high_uptime_zero_reconnects(self):
        mod = _load()
        probe = _probe_with_stability(uptime=7200, reconnect_attempts=0)
        assert mod.has_sustained_connection_stability(probe) is True

    def test_rejects_uptime_below_threshold(self):
        mod = _load()
        probe = _probe_with_stability(uptime=300, reconnect_attempts=0)
        assert mod.has_sustained_connection_stability(probe) is False

    def test_accepts_uptime_at_exact_threshold(self):
        mod = _load({"BOT_ERRORS_SUSTAINED_STABILITY_MIN_UPTIME_SECONDS": "600"})
        probe = _probe_with_stability(uptime=600, reconnect_attempts=0)
        assert mod.has_sustained_connection_stability(probe) is True

    def test_rejects_nonzero_reconnect_attempts(self):
        mod = _load()
        probe = _probe_with_stability(uptime=7200, reconnect_attempts=3)
        assert mod.has_sustained_connection_stability(probe) is False

    def test_rejects_missing_uptime_field(self):
        mod = _load()
        # No lifecycle_process_uptime_seconds in probe
        assert mod.has_sustained_connection_stability(_BASE_VERIFIED) is False

    def test_rejects_zero_uptime(self):
        mod = _load()
        probe = _probe_with_stability(uptime=0, reconnect_attempts=0)
        assert mod.has_sustained_connection_stability(probe) is False

    def test_respects_env_override_for_threshold(self):
        mod = _load({"BOT_ERRORS_SUSTAINED_STABILITY_MIN_UPTIME_SECONDS": "3600"})
        # 1800s uptime: above default (600) but below override (3600)
        probe = _probe_with_stability(uptime=1800, reconnect_attempts=0)
        assert mod.has_sustained_connection_stability(probe) is False
        # 4000s: above override
        probe2 = _probe_with_stability(uptime=4000, reconnect_attempts=0)
        assert mod.has_sustained_connection_stability(probe2) is True


# ---------------------------------------------------------------------------
# Unit tests: has_post_incident_outbound_proof
# ---------------------------------------------------------------------------

class TestPostIncidentOutboundProof(IsolatedDispatcherTestCase):
    def test_accepts_outbound_after_incident(self):
        mod = _load()
        now = int(time.time())
        incident_open = now - 3600
        record = {"openedAt": incident_open, "eventCreatedAtEpoch": incident_open}
        probe = _probe_with_outbound(after_epoch=now - 60)
        assert mod.has_post_incident_outbound_proof(probe, record, incident_open) is True

    def test_rejects_outbound_before_incident(self):
        mod = _load()
        now = int(time.time())
        incident_open = now
        record = {"openedAt": incident_open, "eventCreatedAtEpoch": incident_open}
        probe = _probe_with_outbound(after_epoch=now - 3600)
        assert mod.has_post_incident_outbound_proof(probe, record, incident_open) is False

    def test_rejects_missing_outbound_transport(self):
        mod = _load()
        now = int(time.time())
        incident_open = now - 3600
        record = {"openedAt": incident_open}
        # No outbound_success_transport_present field
        assert mod.has_post_incident_outbound_proof(_BASE_VERIFIED, record, incident_open) is False


# ---------------------------------------------------------------------------
# Integration tests: daily_health_clear_candidate_keys recognizes sustained
# stability as alternative to outbound proof for AUTOCLOSE_PROTECTED sources.
# ---------------------------------------------------------------------------

def _make_recovery_event(
    machine: str,
    instance: str,
    probe: str,
    created_epoch: int,
) -> dict[str, Any]:
    """A daily-health recovery event carrying a health probe for an instance."""
    return {
        "schemaVersion": 1,
        "id": f"daily-health-{created_epoch}",
        "eventType": "clear",
        "severity": "info",
        "source": "daily-health",
        "instance": instance,
        "machine": machine,
        "summary": f"Daily health for {instance}",
        "evidence": f"health {instance}: {probe}",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created_epoch)),
    }


def _make_incident_state(
    incident_key: str,
    opened_epoch: int,
) -> dict[str, Any]:
    return {
        "version": 1,
        "openIncidents": {
            incident_key: {
                "status": "open",
                "eventCreatedAtEpoch": opened_epoch,
                "openedAt": opened_epoch,
                "openedIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(opened_epoch)),
                "suppressedCount": 0,
            }
        },
        "lastSentAt": {},
    }


class TestSustainedStabilityRecoveryPath(IsolatedDispatcherTestCase):
    """A bond-lost incident with NO outbound proof but WITH sustained stability
    must be selected by daily_health_clear_candidate_keys."""

    def test_bond_lost_with_stability_is_selected_without_outbound(self):
        """Stable base health selects a protected incident for evaluation."""
        mod = _load()
        now = int(time.time())
        incident_open = now - 86400  # opened 24h ago
        machine, instance = "mini4", "eh-bot"
        incident_key = f"{machine}|{instance}|whatsapp_device_bond_lost"

        state = _make_incident_state(incident_key, incident_open)

        # Probe: verified health + sustained stability, but NO outbound send
        probe = _probe_with_stability(uptime=123894, reconnect_attempts=0)
        event = _make_recovery_event(machine, instance, probe, now)

        self.assert_isolated(mod)
        candidate_keys = mod.daily_health_clear_candidate_keys(event, state)

        assert incident_key in candidate_keys, (
            "Bond-lost incident with sustained stability must be selected for evaluation"
        )

    def test_bond_lost_without_continuity_is_retained_as_candidate(self):
        """Base health selects the key, but missing continuity cannot close it."""
        mod = _load()
        now = int(time.time())
        incident_open = now - 86400
        machine, instance = "mini4", "eh-bot"
        incident_key = f"{machine}|{instance}|whatsapp_device_bond_lost"

        state = _make_incident_state(incident_key, incident_open)

        # Probe: verified health but low uptime (just restarted) and no outbound
        probe = _probe_with_stability(uptime=120, reconnect_attempts=0)
        event = _make_recovery_event(machine, instance, probe, now)

        self.assert_isolated(mod)
        candidates = mod.daily_health_clear_candidate_keys(event, state)
        assert incident_key in candidates
        normalized = mod.normalize_dispatch_observation(event)
        decisions = dict(mod.source_specific_clear_decisions(event, state, normalized))
        assert decisions[incident_key].status.value == "candidate"
        self.assert_isolated(mod)
        mod.append_clear_proof_evidence(state["openIncidents"][incident_key], decisions[incident_key])
        assert incident_key in state["openIncidents"]
        assert state["openIncidents"][incident_key]["candidateClearProofs"]

    def test_bond_lost_with_reconnect_attempts_remains_candidate(self):
        """A flapping connection is selected but lacks continuity proof."""
        mod = _load()
        now = int(time.time())
        incident_open = now - 86400
        machine, instance = "mini4", "eh-bot"
        incident_key = f"{machine}|{instance}|whatsapp_device_bond_lost"

        state = _make_incident_state(incident_key, incident_open)

        # High uptime but actively reconnecting — NOT stable
        probe = _probe_with_stability(uptime=7200, reconnect_attempts=5)
        event = _make_recovery_event(machine, instance, probe, now)

        self.assert_isolated(mod)
        candidates = mod.daily_health_clear_candidate_keys(event, state)
        assert incident_key in candidates
        normalized = mod.normalize_dispatch_observation(event)
        decisions = dict(mod.source_specific_clear_decisions(event, state, normalized))
        assert decisions[incident_key].status.value == "candidate"

    def test_bond_lost_with_outbound_proof_is_selected(self):
        """Outbound proof keeps the protected incident in evaluator scope."""
        mod = _load()
        now = int(time.time())
        incident_open = now - 3600
        machine, instance = "mini7", "rb-bot"
        incident_key = f"{machine}|{instance}|whatsapp_device_bond_lost"

        state = _make_incident_state(incident_key, incident_open)

        # Probe: outbound proof, no uptime info — original path
        probe = _probe_with_outbound(after_epoch=now - 60)
        event = _make_recovery_event(machine, instance, probe, now)

        self.assert_isolated(mod)
        candidate_keys = mod.daily_health_clear_candidate_keys(event, state)

        assert incident_key in candidate_keys, (
            "Bond-lost incident with outbound proof must be selected for evaluation"
        )

    def test_logged_out_with_stability_is_selected(self):
        """instance_logged_out is selected for the same protected evaluator policy."""
        mod = _load()
        now = int(time.time())
        incident_open = now - 86400
        machine, instance = "mini4", "eh-bot"
        incident_key = f"{machine}|{instance}|instance_logged_out"

        state = _make_incident_state(incident_key, incident_open)

        probe = _probe_with_stability(uptime=50000, reconnect_attempts=0)
        event = _make_recovery_event(machine, instance, probe, now)

        self.assert_isolated(mod)
        candidate_keys = mod.daily_health_clear_candidate_keys(event, state)

        assert incident_key in candidate_keys, (
            "instance_logged_out with stability must be selected for evaluation"
        )

    def test_non_protected_source_does_not_need_stability_or_outbound(self):
        """Non-AUTOCLOSE_PROTECTED sources (e.g. health_body_degraded) clear on base
        verified health alone — no outbound proof or stability required."""
        mod = _load()
        now = int(time.time())
        incident_open = now - 86400
        machine, instance = "mini4", "eh-bot"
        incident_key = f"{machine}|{instance}|health_body_degraded"

        state = _make_incident_state(incident_key, incident_open)

        # Base verified health only — no uptime, no outbound
        event = _make_recovery_event(machine, instance, _BASE_VERIFIED, now)

        self.assert_isolated(mod)
        candidate_keys = mod.daily_health_clear_candidate_keys(event, state)

        assert incident_key in candidate_keys, (
            "Non-protected source must be selected on base verified health"
        )

    def test_accepted_decision_closes_stability_recovered_incident(self):
        """End-to-end: only an accepted evaluator decision removes the incident."""
        mod = _load()
        now = int(time.time())
        incident_open = now - 86400
        machine, instance = "mini4", "eh-bot"
        incident_key = f"{machine}|{instance}|whatsapp_device_bond_lost"

        state = _make_incident_state(incident_key, incident_open)

        probe = _probe_with_stability(uptime=123894, reconnect_attempts=0)
        event = _make_recovery_event(machine, instance, probe, now)

        self.assert_isolated(mod)
        normalized = mod.normalize_dispatch_observation(event)
        decisions = mod.source_specific_clear_decisions(event, state, normalized)
        accepted = [(key, decision) for key, decision in decisions if decision.status.value == "accepted"]
        assert [key for key, _ in accepted] == [incident_key]
        self.assert_isolated(mod)
        for key, decision in accepted:
            mod.finalize_accepted_clear(state, key, event, decision)
        assert incident_key not in state["openIncidents"], (
            "Incident must be removed from openIncidents after stability-based recovery"
        )
