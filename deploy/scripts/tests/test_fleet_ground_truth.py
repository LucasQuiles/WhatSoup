"""Unit tests for the fleet ground-truth panel (deploy/scripts/fleet-ground-truth.py).

The panel is the reliability program's Pillar-1 deliverable: one call renders the
non-circular, evidence-ordered picture for an instance so operators and agents
decide on GROUND TRUTH, not proxies. These tests pin the rev-2 contract:

- evidence is timestamped; NEWER evidence supersedes older on a contradiction —
  outbound flow proves serving only *as of its timestamp* and cannot override a
  fresher failed model probe (and vice versa: flow newer than a failed probe
  outdates the probe verdict);
- an idle bot with a FRESH failed credential probe is genuinely (latently)
  broken — the stale-RED misread and the serving-full-stop misread both die here;
- flap cumulative≫window is a persistent steady condition (monitoring artifact),
  cumulative≈window is a genuine burst — the ml-bot(728/1) vs yl-bot(5/5)
  discriminator;
- a terminal logged-out bond reads "physical re-pair required; restart will not
  fix" (the watchdog e2e's semantics, surfaced to humans);
- missing axes are reported UNOBSERVED, never guessed (absence is not evidence);
- the panel is PII-safe by construction: counts, timestamps, and status enums
  only — never message content.

Fixture bodies mirror real production shapes captured 2026-08-16 (ad-bot/ew-bot
credential-unavailable; ml-bot logged-out watchdog body).
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "fleet-ground-truth.py"


def _load():
    spec = importlib.util.spec_from_file_location("fleet_ground_truth", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


fgt = _load()

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS
NOW_MS = 1_786_902_000_000  # 2026-08-16T17:40Z-ish, epoch ms


def _health_logged_out():
    # Real ml-bot/mini8 503 shape (test_watchdog_terminal_logout_e2e.py).
    return {
        "status": "unhealthy",
        "generated_at_ms": NOW_MS - 60_000,
        "whatsapp": {
            "connected": False,
            "connection": {
                "state": "disconnected",
                "auth_failure_class": "serverside_logout_irreversible",
                "last_status_code": 401,
            },
        },
    }


def _health_credential_unavailable(checked_age_ms: int):
    # Real ad-bot/mini10 authed shape (live read 2026-08-16 17:49Z).
    return {
        "status": "degraded",
        "generated_at_ms": NOW_MS - 30_000,
        "instance": {
            "effectiveProvider": "claude-cli",
            "fallbackReason": None,
            "primaryModelUsability": {
                "status": "credential-unavailable",
                "checkedAt": NOW_MS - checked_age_ms,
                "probeInFlight": False,
            },
        },
        "whatsapp": {"connected": True, "connection": {"state": "connected"}},
        "turn_capability": {
            "model_usable": None,
            "model_usable_stale": True,
            "model_usability_status": "credential-unavailable",
            "last_turn_error_class": None,
        },
    }


def _health_ok(probe_age_ms: int = 10 * 60_000):
    return {
        "status": "healthy",
        "generated_at_ms": NOW_MS - 5_000,
        "instance": {
            "effectiveProvider": "claude-cli",
            "fallbackReason": None,
            "primaryModelUsability": {
                "status": "usable",
                "checkedAt": NOW_MS - probe_age_ms,
                "probeInFlight": False,
            },
        },
        "whatsapp": {"connected": True, "connection": {"state": "connected"}},
        "turn_capability": {
            "model_usable": True,
            "model_usable_stale": False,
            "model_usability_status": "usable",
            "last_turn_error_class": None,
        },
    }


def _flow(last_out_age_ms, last_in_age_ms, out24=0, in24=0):
    return {
        "last_outbound_ms": None if last_out_age_ms is None else NOW_MS - last_out_age_ms,
        "last_inbound_ms": None if last_in_age_ms is None else NOW_MS - last_in_age_ms,
        "outbound_24h": out24,
        "inbound_24h": in24,
        "observed_at_ms": NOW_MS,
    }


def _panel(**kw):
    kw.setdefault("host", "mini10")
    kw.setdefault("instance", "ad-bot")
    kw.setdefault("now_ms", NOW_MS)
    return fgt.build_panel(**kw)


def _verdicts(panel, axis=None):
    vs = panel["verdicts"]
    return [v for v in vs if axis is None or v["axis"] == axis]


def _codes(panel, axis=None):
    return {v["verdict"] for v in _verdicts(panel, axis)}


# ---------------------------------------------------------------------------
# Bond axis: terminal logout must read physical, never restartable.

def test_terminal_logged_out_reads_physical_repair_not_restart():
    p = _panel(health=_health_logged_out())
    codes = _codes(p, "bond")
    assert "needs_physical_repair" in codes
    joined = json.dumps(p["verdicts"])
    assert "restart_will_not_fix" in joined
    # and nothing anywhere suggests a restart remedy
    assert "restart_may_fix" not in joined


def test_connected_bond_is_not_flagged_for_repair():
    p = _panel(health=_health_ok())
    assert "needs_physical_repair" not in _codes(p, "bond")


# ---------------------------------------------------------------------------
# Model axis: fresh failed probe = genuine; stale verdict = suspect the probe.

def test_fresh_credential_unavailable_on_idle_bot_is_genuine_latent():
    p = _panel(
        health=_health_credential_unavailable(checked_age_ms=40 * 60_000),
        flow=_flow(16 * DAY_MS, 16 * DAY_MS),
    )
    codes = _codes(p, "model")
    assert "credential_unavailable_genuine" in codes
    assert "latent_while_idle" in _codes(p)
    # the stale-RED misread must NOT appear for a fresh probe
    assert "model_verdict_stale_suspect_probe" not in codes


def test_stale_credential_verdict_suspects_probe_not_credential():
    p = _panel(health=_health_credential_unavailable(checked_age_ms=3 * DAY_MS))
    codes = _codes(p, "model")
    assert "model_verdict_stale_suspect_probe" in codes
    assert "credential_unavailable_genuine" not in codes


# ---------------------------------------------------------------------------
# Evidence ordering: the newer of {flow, probe} wins the contradiction.

def test_older_outbound_cannot_override_fresher_failed_probe():
    # ad/ew/rb's real shape: outbound existed days ago; probe failed 40min ago.
    p = _panel(
        health=_health_credential_unavailable(checked_age_ms=40 * 60_000),
        flow=_flow(10 * DAY_MS, 10 * DAY_MS, out24=0),
    )
    assert "credential_unavailable_genuine" in _codes(p, "model")
    assert "serving" not in _codes(p, "flow")  # serving_as_of only, and not asserted over the probe
    joined = json.dumps(p["verdicts"])
    assert "full stop" not in joined


def test_fresher_outbound_outdates_older_failed_probe():
    # Probe failed 3h ago, but outbound flowed 5 minutes ago: flow is newer —
    # the probe verdict is outdated, not the flow.
    p = _panel(
        health=_health_credential_unavailable(checked_age_ms=3 * HOUR_MS),
        flow=_flow(5 * 60_000, 20 * 60_000, out24=12, in24=9),
    )
    codes = _codes(p)
    assert "serving_as_of" in codes
    assert "model_verdict_outdated_by_flow" in codes
    assert "credential_unavailable_genuine" not in codes


def test_healthy_with_recent_flow_is_serving_as_of_timestamp():
    p = _panel(health=_health_ok(), flow=_flow(10 * 60_000, 15 * 60_000, out24=4, in24=3))
    assert "serving_as_of" in _codes(p, "flow")


# ---------------------------------------------------------------------------
# Flap axis: cumulative-vs-window discriminator (ml-bot 728/1 vs yl-bot 5/5).

def test_flap_cumulative_much_greater_than_window_is_persistent_artifact():
    p = _panel(flap={"cumulative": 728, "in_window": 1, "window_seconds": 600,
                     "last_trip_ms": NOW_MS - 300_000, "observed_at_ms": NOW_MS})
    codes = _codes(p, "flap")
    assert "persistent_steady_condition" in codes
    assert "genuine_burst" not in codes


def test_flap_cumulative_close_to_window_is_genuine_burst():
    p = _panel(flap={"cumulative": 5, "in_window": 5, "window_seconds": 600,
                     "last_trip_ms": NOW_MS - 60_000, "observed_at_ms": NOW_MS})
    codes = _codes(p, "flap")
    assert "genuine_burst" in codes
    assert "persistent_steady_condition" not in codes


# ---------------------------------------------------------------------------
# Unobserved axes are named, never guessed.

def test_missing_axes_are_reported_unobserved_with_no_verdicts():
    p = _panel(health=_health_ok())  # no flow, no flap
    assert "flow" in p["unobserved"]
    assert "flap" in p["unobserved"]
    assert not _verdicts(p, "flow")
    assert not _verdicts(p, "flap")


def test_health_fetch_error_marks_bond_and_model_unobserved():
    p = _panel(health=None, health_error="connect timeout",
               flow=_flow(60_000, 60_000, out24=1))
    assert "bond" in p["unobserved"]
    assert "model" in p["unobserved"]
    # the error is surfaced verbatim, not swallowed
    assert p["axes"]["health_error"] == "connect timeout"
    # flow evidence still renders (evidence that exists is never dropped)
    assert "serving_as_of" in _codes(p, "flow")


# ---------------------------------------------------------------------------
# Every verdict cites the evidence timestamps it used (auditability).

def test_verdicts_carry_evidence_timestamps():
    p = _panel(
        health=_health_credential_unavailable(checked_age_ms=40 * 60_000),
        flow=_flow(10 * DAY_MS, 10 * DAY_MS),
    )
    for v in p["verdicts"]:
        assert v["because"], f"verdict {v['verdict']} has no rationale"
        assert "evidence_ms" in v, f"verdict {v['verdict']} cites no evidence timestamps"


# ---------------------------------------------------------------------------
# PII safety: structural — the panel never carries message content.

def test_panel_is_pii_safe_counts_and_timestamps_only():
    p = _panel(health=_health_ok(), flow=_flow(60_000, 60_000, out24=3, in24=2),
               flap={"cumulative": 5, "in_window": 5, "window_seconds": 600,
                     "last_trip_ms": NOW_MS, "observed_at_ms": NOW_MS})
    dumped = json.dumps(p).lower()
    for banned in ("content", "message_text", "body_text", "chat_jid"):
        assert banned not in dumped


# ---------------------------------------------------------------------------
# The PII-safe SQL the flow adapter uses is counts/timestamps only.

def test_flow_query_selects_no_content_column():
    q = fgt.FLOW_QUERY.lower()
    assert "content" not in q
    assert "is_from_me" in q and "timestamp" in q


# ---------------------------------------------------------------------------
# Health-split guard (#2515): /health answers 200 both authenticated and not.
# The public envelope reported status "healthy" on a production instance at
# 2026-08-16T20:58Z while the SAME process's privileged body reported
# "degraded" with degradation_causes ["turn_recovery_degraded"]. Both bodies
# below are the real captured shapes (operator evidence archive).
# A panel that renders a clean picture from the public envelope reproduces
# exactly the blindness it exists to prevent, so absence of disclosure must
# fail CLOSED: bond/model UNOBSERVED plus an explicit verdict.

def _health_public_envelope(status: str = "healthy"):
    return {
        "schema_version": "health.public.v1",
        "status": status,
        "generated_at": "2026-08-16T20:58:10.682Z",
        "generated_at_ms": NOW_MS,
        "startupNotification": {"state": "disabled", "policy": "disabled"},
    }


def test_public_envelope_is_not_read_as_a_health_verdict():
    p = _panel(health=_health_public_envelope())
    # It must NOT derive axes from a body that discloses none.
    assert "bond" not in p["axes"]
    assert "model" not in p["axes"]
    assert "status" not in p["axes"], (
        "the public envelope's status must never surface as the panel status"
    )
    assert set(["bond", "model"]).issubset(set(p["unobserved"]))
    names = [v["verdict"] for v in p["verdicts"]]
    assert "health_body_not_disclosed" in names


def test_public_envelope_healthy_never_yields_a_clean_panel():
    """The specific live failure: envelope says healthy, truth was degraded."""
    p = _panel(health=_health_public_envelope(status="healthy"))
    assert p["verdicts"], "a non-disclosing answer must never render zero verdicts"
    assert p["axes"]["health_envelope"]["disclosed"] is False
    assert p["axes"]["health_envelope"]["reported_status"] == "healthy"


def test_disclosure_check_is_fail_closed_on_unknown_shapes():
    # No schema_version and no whatsapp block -> not disclosed.
    assert fgt.health_body_is_disclosed({"status": "healthy"}) is False
    assert fgt.health_body_is_disclosed({}) is False
    # Privileged body (carries the whatsapp diagnostic block) -> disclosed.
    assert fgt.health_body_is_disclosed(_health_ok()) is True
    assert fgt.health_body_is_disclosed(_health_logged_out()) is True


def test_privileged_body_still_produces_its_verdicts():
    """Regression guard: the new gate must not swallow real diagnostic bodies."""
    p = _panel(health=_health_logged_out())
    names = [v["verdict"] for v in p["verdicts"]]
    assert "health_body_not_disclosed" not in names
    assert "needs_physical_repair" in names
