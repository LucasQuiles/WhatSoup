"""The watchdog must never mistake a non-disclosing /health answer for telemetry.

/health answers HTTP 200 on both legs. With a valid instance health token it
returns the privileged diagnostic body; without one it returns a public
envelope carrying neither `whatsapp` nor `instance`. Verified live 2026-08-16
against a single production process: the unauthenticated legs reported status
"healthy" while the privileged body of that same process reported "degraded"
with degradation_causes ["turn_recovery_degraded"].

Before the guard, an unauthorized probe fell through to the connected check and
emitted `connected=none` — a confident claim that the bot had lost its WhatsApp
bond, which routes an operator to a physical QR re-pair (the most expensive
remediation there is) while hiding the real degradation. Misattribution is
strictly worse than silence, so the reasons must name the probe defect and
declare the bond UNOBSERVED.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog_envelope",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


wd = _load_module()


def _public_envelope(status: str = "healthy") -> dict:
    """The real captured public shape."""
    return {
        "schema_version": "health.public.v1",
        "status": status,
        "generated_at": "2026-08-16T20:58:10.682Z",
        "startupNotification": {"state": "disabled", "policy": "disabled"},
    }


def _privileged_degraded() -> dict:
    """The real captured privileged shape from the SAME process."""
    return {
        "status": "degraded",
        "generated_at": "2026-08-16T20:58:10.682Z",
        "degradation_causes": ["turn_recovery_degraded"],
        "status_reasons": [
            "runtime.turn_finalization_debt",
            "runtime.completed_delivery_identity_debt",
        ],
        "instance": {"name": "a-bot"},
        "whatsapp": {
            "connected": True,
            "connection": {"state": "connected", "auth_failure_class": "none"},
            "auth_bond": {"status": "present", "issues": []},
        },
    }


def test_public_envelope_never_reads_as_a_lost_bond():
    reasons, ctx = wd.health_reasons_from_payload(_public_envelope(), "a-bot")
    joined = " ".join(reasons)
    assert "health_body_not_disclosed=public_envelope" in reasons
    assert "probe_unauthorized=instance_health_token_missing_or_invalid" in reasons
    assert "bond_and_runtime=unobserved" in reasons
    # The specific misattribution this guard exists to kill.
    assert "connected=" not in joined, (
        "an unauthorized probe must not claim anything about the WhatsApp bond"
    )
    assert "physical_intervention_required" not in joined
    assert ctx["bond_status"] is None


def test_public_envelope_healthy_still_reports_a_problem():
    """It must not go silent either — the probe itself is broken."""
    reasons, _ = wd.health_reasons_from_payload(_public_envelope("healthy"), "a-bot")
    assert reasons, "a non-disclosing answer is a defect, not a clean bill of health"


def test_privileged_body_classification_is_unchanged():
    reasons, ctx = wd.health_reasons_from_payload(_privileged_degraded(), "a-bot")
    assert "health_status=degraded" in reasons
    assert "degradation_causes=turn_recovery_degraded" in reasons
    assert "health_body_not_disclosed=public_envelope" not in reasons
    assert ctx["bond_status"] == "present"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"status": "healthy"},
        {"schema_version": "health.public.v2", "status": "healthy"},
        {"whatsapp": "not-a-dict"},
        None,
        [],
    ],
)
def test_disclosure_predicate_is_fail_closed(payload):
    assert wd.health_body_is_disclosed(payload) is False


def test_disclosure_predicate_accepts_the_privileged_body():
    assert wd.health_body_is_disclosed(_privileged_degraded()) is True


def test_probe_sends_the_instance_token_when_resolvable(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_HEALTH_TOKEN_A_BOT", "tok-abc")
    assert wd.instance_health_token("a-bot") == "tok-abc"


def test_probe_token_absent_is_none_not_empty_string(monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_A_BOT", raising=False)
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.setattr(wd.Path, "home", staticmethod(lambda: Path("/nonexistent-home")))
    assert wd.instance_health_token("a-bot") is None
