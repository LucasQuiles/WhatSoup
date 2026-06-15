"""Tests for the external (off-GUI) GUI-session monitor.

Context (the outage this defends against)
------------------------------------------
WhatSoup bots are per-user macOS GUI LaunchAgents. When a bot's user logs out
of the GUI (e.g. /dev/console owned by root at loginwindow), the bot
drops AND the in-GUI watchdog dies in the same failure, so the outage is
silent. This monitor runs OFF the target host (over SSH) and classifies, per
expected GUI-LaunchAgent host, whether the bot user's Aqua session and agent
are present.

These tests exercise the REAL classification + threshold logic with INJECTED
probe results (no live SSH, no mocking of the function under test), per the
project's writing-fail-closed-gates and test-integrity discipline.

Module loader mirrors test_bot_errors_collector_reachability.py.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-gui-session-monitor.py"


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_gui_session_monitor", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        assert spec and spec.loader
        # Register before exec so dataclass field-type resolution under
        # `from __future__ import annotations` can find the module's namespace
        # (importlib best practice; see feedback_dataclass_future_annotations_importlib).
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


@pytest.fixture(scope="module")
def mod():
    return _load_module()


# ---------------------------------------------------------------------------
# probe-result data structure (injected; never live SSH in tests)
# ---------------------------------------------------------------------------


def _probe(
    *,
    console_owner: Any,
    agent_state: Any,
    console_ok: bool = True,
    agent_ok: bool = True,
    error: str | None = None,
) -> Any:
    """Build a GuiProbeResult-like dict with the injected probe outputs."""
    return {
        "console_owner": console_owner,
        "agent_state": agent_state,
        "console_ok": console_ok,
        "agent_ok": agent_ok,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Test 1: ok — console owner == bot user AND agent running
# ---------------------------------------------------------------------------


def test_classify_ok_when_owner_matches_and_agent_running(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="botuser", agent_state="running"),
    )
    assert result == "ok"


def test_classify_ok_generalizes_to_any_matching_user(mod):
    # Forces the classifier away from any hardcoded username.
    result = mod.classify_gui_session(
        expected_user="ana-bot",
        probe=_probe(console_owner="ana-bot", agent_state="running"),
    )
    assert result == "ok"


# ---------------------------------------------------------------------------
# Test 3: gui_session_absent — console owned by login window (root)
# ---------------------------------------------------------------------------


def test_classify_gui_session_absent_when_console_is_root(mod):
    # The real-world outage shape: /dev/console owned by root at loginwindow.
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="root", agent_state="running"),
    )
    assert result == "gui_session_absent"


def test_classify_gui_session_absent_when_other_user_logged_in(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="someoneelse", agent_state="running"),
    )
    assert result == "gui_session_absent"


# ---------------------------------------------------------------------------
# Test 4: agent_unloaded — session present, agent not loaded/running
# ---------------------------------------------------------------------------


def test_classify_agent_unloaded_when_agent_unloaded(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="botuser", agent_state="unloaded"),
    )
    assert result == "agent_unloaded"


def test_classify_agent_unloaded_when_agent_loaded_but_not_running(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="botuser", agent_state="not_running"),
    )
    assert result == "agent_unloaded"


# ---------------------------------------------------------------------------
# Test 5: unreachable — transport failure on either probe (FAIL-CLOSED)
# ---------------------------------------------------------------------------


def test_classify_unreachable_when_console_probe_failed(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(
            console_owner=None,
            agent_state="running",
            console_ok=False,
            error="ssh: connect to host ... Operation timed out",
        ),
    )
    assert result == "unreachable"


def test_classify_unreachable_when_agent_probe_failed(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(
            console_owner="botuser",
            agent_state=None,
            agent_ok=False,
            error="ssh: connect to host ... Connection refused",
        ),
    )
    assert result == "unreachable"


def test_unreachable_never_ok_even_if_visible_fields_look_healthy(mod):
    # Defends against masking: a partial success must NEVER read as ok.
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(
            console_owner="botuser",
            agent_state="running",
            agent_ok=False,
        ),
    )
    assert result != "ok"
    assert result == "unreachable"


# ---------------------------------------------------------------------------
# Test 6: inconclusive — empty / garbage probe payload (FAIL-CLOSED)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "console_owner,agent_state",
    [
        ("", "running"),                       # empty console owner
        ("   ", "running"),                    # whitespace console owner
        ("Password:", "running"),              # garbage (permission prompt)
        ("a b c", "running"),                  # multi-token garbage
        ("botuser", ""),                       # empty agent state
        ("botuser", "Could not find service"), # raw launchctl error, not distilled
        ("botuser", "garbage"),                # unknown agent token
    ],
)
def test_classify_inconclusive_on_garbage_payload(mod, console_owner, agent_state):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner=console_owner, agent_state=agent_state),
    )
    assert result != "ok"
    assert result == "inconclusive"


def test_classify_inconclusive_when_expected_user_unknown(mod):
    # Cannot prove health against an unknown expectation.
    result = mod.classify_gui_session(
        expected_user="",
        probe=_probe(console_owner="botuser", agent_state="running"),
    )
    assert result != "ok"
    assert result == "inconclusive"


# ---------------------------------------------------------------------------
# Test 7: consecutive-failure threshold gating (default 2)
# ---------------------------------------------------------------------------


def test_threshold_default_is_two(mod):
    assert mod.default_failure_threshold() == 2


def test_should_emit_false_when_state_ok(mod):
    # An ok state never emits, regardless of count.
    decision = mod.evaluate_emit_decision(
        state="ok", consecutive_failures=5, threshold=2,
    )
    assert decision.should_emit is False


def test_should_emit_false_below_threshold(mod):
    # First non-ok observation (count==1) must NOT emit at threshold 2.
    decision = mod.evaluate_emit_decision(
        state="gui_session_absent", consecutive_failures=1, threshold=2,
    )
    assert decision.should_emit is False


def test_should_emit_true_at_threshold(mod):
    decision = mod.evaluate_emit_decision(
        state="gui_session_absent", consecutive_failures=2, threshold=2,
    )
    assert decision.should_emit is True


def test_should_emit_true_above_threshold(mod):
    decision = mod.evaluate_emit_decision(
        state="agent_unloaded", consecutive_failures=4, threshold=2,
    )
    assert decision.should_emit is True


def test_unreachable_also_gated_by_threshold(mod):
    below = mod.evaluate_emit_decision(
        state="unreachable", consecutive_failures=1, threshold=2,
    )
    at = mod.evaluate_emit_decision(
        state="unreachable", consecutive_failures=2, threshold=2,
    )
    assert below.should_emit is False
    assert at.should_emit is True


def test_threshold_one_emits_immediately(mod):
    decision = mod.evaluate_emit_decision(
        state="inconclusive", consecutive_failures=1, threshold=1,
    )
    assert decision.should_emit is True


# ---------------------------------------------------------------------------
# Test 8: SSOT-driven GUI target enumeration (no hardcoded host list)
# ---------------------------------------------------------------------------


_FAKE_FLEET = {
    "schemaVersion": 1,
    "hosts": [
        {
            "host": "botbox-a",
            "role": "bot-host",
            "instances": [
                {"name": "x-bot", "expected": "always_on",
                 "service": "com.whatsoup.x-bot", "healthPort": 9095},
            ],
        },
        {
            "host": "botbox-b",
            "role": "bot-host",
            "instances": [
                {"name": "y-bot", "expected": "always_on",
                 "service": "com.whatsoup.y-bot", "healthPort": 9096},
                {"name": "z-bot", "expected": "always_on",
                 "service": "com.whatsoup.z-bot", "healthPort": 9097},
            ],
        },
        {  # systemd central host — NOT a GUI LaunchAgent host, must be excluded
            "host": "central-box",
            "role": "central",
            "instances": [
                {"name": "primary", "expected": "always_on",
                 "service": "whatsoup-primary.service", "healthPort": 9092},
            ],
        },
        {  # relay-only on_demand — excluded (down is healthy)
            "host": "relay-box",
            "role": "relay-only",
            "instances": [
                {"name": "agent", "expected": "on_demand",
                 "service": "com.whatsoup.agent", "healthPort": 9095},
            ],
        },
        {  # blocked instance — excluded (intentionally down)
            "host": "blocked-box",
            "role": "bot-host-blocked",
            "instances": [
                {"name": "b-bot", "expected": "blocked",
                 "service": "com.whatsoup.b-bot"},
            ],
        },
        {  # no-bot host — excluded (no instances)
            "host": "empty-box",
            "role": "no-bot",
            "instances": [],
        },
    ],
}


def test_gui_targets_only_always_on_launchagent_hosts(mod):
    targets = mod.gui_targets_from_fleet(_FAKE_FLEET)
    hosts = sorted({t["host"] for t in targets})
    assert hosts == ["botbox-a", "botbox-b"]


def test_gui_targets_expand_per_instance_with_label(mod):
    targets = mod.gui_targets_from_fleet(_FAKE_FLEET)
    pairs = sorted((t["host"], t["label"]) for t in targets)
    assert pairs == [
        ("botbox-a", "com.whatsoup.x-bot"),
        ("botbox-b", "com.whatsoup.y-bot"),
        ("botbox-b", "com.whatsoup.z-bot"),
    ]


def test_gui_targets_carry_instance_name(mod):
    targets = mod.gui_targets_from_fleet(_FAKE_FLEET)
    by_label = {t["label"]: t for t in targets}
    assert by_label["com.whatsoup.x-bot"]["instance"] == "x-bot"


def test_gui_targets_exclude_non_launchagent_service_labels(mod):
    # systemd .service units are not gui/<uid>/<label> agents — never targets.
    targets = mod.gui_targets_from_fleet(_FAKE_FLEET)
    assert all(t["label"].startswith("com.whatsoup.") for t in targets)


def test_gui_targets_empty_on_missing_hosts_key(mod):
    assert mod.gui_targets_from_fleet({"schemaVersion": 1}) == []


# ---------------------------------------------------------------------------
# Test 9: distill raw `launchctl print` output into an agent_state token
# ---------------------------------------------------------------------------


def test_distill_agent_state_running(mod):
    # `launchctl print gui/<uid>/<label>` for a live agent reports a pid + state.
    raw = (
        "com.whatsoup.x-bot = {\n"
        "\tactive count = 1\n"
        "\tstate = running\n"
        "\tpid = 4821\n"
        "}\n"
    )
    assert mod.distill_agent_state(raw, ok=True) == "running"


def test_distill_agent_state_not_running_when_no_pid(mod):
    # Loaded but waiting (no pid, state not running).
    raw = (
        "com.whatsoup.x-bot = {\n"
        "\tactive count = 0\n"
        "\tstate = waiting\n"
        "}\n"
    )
    assert mod.distill_agent_state(raw, ok=True) == "not_running"


def test_distill_agent_state_unloaded_on_not_found(mod):
    # The agent_unloaded shape: launchctl cannot find the service.
    raw = "Could not find service \"com.whatsoup.x-bot\" in domain for gui"
    assert mod.distill_agent_state(raw, ok=True) == "unloaded"


def test_distill_agent_state_unloaded_when_domain_missing(mod):
    # No Aqua session => the gui/<uid> domain itself is absent.
    raw = "Could not find domain for gui/501"
    assert mod.distill_agent_state(raw, ok=True) == "unloaded"


def test_distill_agent_state_none_when_probe_failed(mod):
    # Transport failure => no state to distill (classifier -> unreachable).
    assert mod.distill_agent_state("", ok=False) is None


def test_distill_agent_state_none_on_empty_ok_output(mod):
    # ok transport but empty payload => garbage => no distilled state (fail-closed).
    assert mod.distill_agent_state("   ", ok=True) is None


def test_distill_agent_state_none_on_unrecognized_output(mod):
    assert mod.distill_agent_state("totally unexpected blob", ok=True) is None


# ---------------------------------------------------------------------------
# Test 10: distill console owner from `stat -f %Su /dev/console`
# ---------------------------------------------------------------------------


def test_distill_console_owner_strips_whitespace(mod):
    assert mod.distill_console_owner("botuser\n", ok=True) == "botuser"


def test_distill_console_owner_root_at_loginwindow(mod):
    assert mod.distill_console_owner("root\n", ok=True) == "root"


def test_distill_console_owner_none_when_probe_failed(mod):
    assert mod.distill_console_owner("anything", ok=False) is None


def test_distill_console_owner_none_on_empty(mod):
    assert mod.distill_console_owner("\n", ok=True) is None
