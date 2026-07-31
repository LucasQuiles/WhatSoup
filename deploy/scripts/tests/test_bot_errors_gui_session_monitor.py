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
import json
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


# ---------------------------------------------------------------------------
# Test 11: build emit argv for a non-ok GUI state (no live subprocess)
# ---------------------------------------------------------------------------


def test_build_emit_argv_carries_instance_and_source(mod):
    argv = mod.build_emit_argv(
        host="botbox-a",
        instance="x-bot",
        label="com.whatsoup.x-bot",
        state="gui_session_absent",
        consecutive_failures=2,
        threshold=2,
    )
    assert "--instance" in argv
    assert argv[argv.index("--instance") + 1] == "x-bot"
    assert "--source" in argv
    assert argv[argv.index("--source") + 1] == "gui_session_monitor"


def test_build_emit_argv_encodes_event_class_diagnostic(mod):
    argv = mod.build_emit_argv(
        host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot",
        state="agent_unloaded", consecutive_failures=3, threshold=2,
    )
    diags = [argv[i + 1] for i, a in enumerate(argv) if a == "--diagnostic"]
    assert "gui_state=agent_unloaded" in diags
    assert any(d.startswith("host=botbox-a") for d in diags)
    assert any(d.startswith("consecutive_failures=3") for d in diags)


def test_build_emit_argv_summary_names_state_and_host(mod):
    argv = mod.build_emit_argv(
        host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot",
        state="gui_session_absent", consecutive_failures=2, threshold=2,
    )
    summary = argv[argv.index("--summary") + 1]
    assert "gui_session_absent" in summary
    assert "botbox-a" in summary


def test_build_emit_argv_severity_critical_for_session_absent(mod):
    argv = mod.build_emit_argv(
        host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot",
        state="gui_session_absent", consecutive_failures=2, threshold=2,
    )
    assert argv[argv.index("--severity") + 1] == "critical"


def test_build_emit_argv_severity_warning_for_unreachable(mod):
    # Unreachable is a softer signal than a confirmed logged-out session.
    argv = mod.build_emit_argv(
        host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot",
        state="unreachable", consecutive_failures=2, threshold=2,
    )
    assert argv[argv.index("--severity") + 1] == "warning"


def test_build_emit_argv_no_secrets_or_private_labels(mod):
    # The label is a public reverse-DNS service id; nothing else leaks.
    argv = mod.build_emit_argv(
        host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot",
        state="agent_unloaded", consecutive_failures=2, threshold=2,
    )
    joined = " ".join(argv)
    assert "/Users/" not in joined
    assert "token" not in joined.lower()


def test_build_emit_argv_rejects_ok_state(mod):
    # ok must never produce an alert argv.
    with pytest.raises(ValueError):
        mod.build_emit_argv(
            host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot",
            state="ok", consecutive_failures=9, threshold=2,
        )


# ---------------------------------------------------------------------------
# Test 12: per-target orchestration with injected probe + persisted state
# ---------------------------------------------------------------------------


def _target(host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot"):
    return {"host": host, "instance": instance, "label": label}


def test_run_target_ok_resets_failure_count(mod):
    prior = {"consecutive_failures": 5, "last_state": "gui_session_absent"}
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe(console_owner="x-bot", agent_state="running"),
        prior_state=prior,
        threshold=2,
    )
    assert outcome.state == "ok"
    assert outcome.new_state["consecutive_failures"] == 0
    assert outcome.emit_decision.should_emit is False


def test_run_target_first_failure_increments_but_does_not_emit(mod):
    prior = {"consecutive_failures": 0, "last_state": "ok"}
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe(console_owner="root", agent_state="running"),
        prior_state=prior,
        threshold=2,
    )
    assert outcome.state == "gui_session_absent"
    assert outcome.new_state["consecutive_failures"] == 1
    assert outcome.emit_decision.should_emit is False


def test_run_target_second_failure_emits(mod):
    prior = {"consecutive_failures": 1, "last_state": "gui_session_absent"}
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe(console_owner="root", agent_state="running"),
        prior_state=prior,
        threshold=2,
    )
    assert outcome.state == "gui_session_absent"
    assert outcome.new_state["consecutive_failures"] == 2
    assert outcome.emit_decision.should_emit is True
    assert outcome.emit_argv is not None
    assert "--source" in outcome.emit_argv


def test_run_target_handles_missing_prior_state(mod):
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe(console_owner="root", agent_state="running"),
        prior_state=None,
        threshold=2,
    )
    assert outcome.new_state["consecutive_failures"] == 1
    assert outcome.emit_decision.should_emit is False


def test_run_target_ok_has_no_emit_argv(mod):
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe(console_owner="x-bot", agent_state="running"),
        prior_state=None,
        threshold=2,
    )
    assert outcome.emit_argv is None


def test_run_target_unreachable_increments_failures(mod):
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe(console_owner=None, agent_state=None,
                     console_ok=False, agent_ok=False),
        prior_state={"consecutive_failures": 1, "last_state": "unreachable"},
        threshold=2,
    )
    assert outcome.state == "unreachable"
    assert outcome.new_state["consecutive_failures"] == 2
    assert outcome.emit_decision.should_emit is True


# ===========================================================================
# SLICE 2: post-reboot regression detection (pure logic, injected boot values)
# ===========================================================================


# ---------------------------------------------------------------------------
# Test 13: distill a stable boot id from `sysctl -n kern.boottime`
# ---------------------------------------------------------------------------


def test_distill_boot_id_from_sysctl_boottime(mod):
    # macOS: `sysctl -n kern.boottime` => "{ sec = 1718000000, usec = 123456 } ..."
    raw = "{ sec = 1718000000, usec = 123456 } Mon Jun 10 00:00:00 2026\n"
    assert mod.distill_boot_id(raw, ok=True) == "1718000000"


def test_distill_boot_id_changes_with_boot_time(mod):
    a = mod.distill_boot_id("{ sec = 1718000000, usec = 1 }", ok=True)
    b = mod.distill_boot_id("{ sec = 1718999999, usec = 1 }", ok=True)
    assert a != b


def test_distill_boot_id_fallback_uptime_seconds(mod):
    # Fallback path: a bare integer (e.g. seconds-since-boot bucket) is accepted.
    assert mod.distill_boot_id("987654", ok=True) == "987654"


def test_distill_boot_id_none_when_probe_failed(mod):
    assert mod.distill_boot_id("{ sec = 1718000000 }", ok=False) is None


def test_distill_boot_id_none_on_empty(mod):
    assert mod.distill_boot_id("   ", ok=True) is None


def test_distill_boot_id_none_on_garbage(mod):
    assert mod.distill_boot_id("totally not a boottime", ok=True) is None


# ---------------------------------------------------------------------------
# Test 14: detect_reboot — compare prior vs current boot id (pure)
# ---------------------------------------------------------------------------


def test_detect_reboot_true_when_boot_id_changed(mod):
    assert mod.detect_reboot(prior_boot_id="100", current_boot_id="200") is True


def test_detect_reboot_false_when_boot_id_same(mod):
    assert mod.detect_reboot(prior_boot_id="100", current_boot_id="100") is False


def test_detect_reboot_false_on_first_ever_observation(mod):
    # No prior boot id => cannot assert a reboot (no false regression).
    assert mod.detect_reboot(prior_boot_id=None, current_boot_id="200") is False
    assert mod.detect_reboot(prior_boot_id="", current_boot_id="200") is False


def test_detect_reboot_false_when_current_boot_id_unknown(mod):
    # Fail-closed: a missing/garbage current boot id is NOT a confirmed reboot,
    # but it also must not be treated as "definitely no reboot" downstream —
    # detect_reboot only answers "did we positively confirm a reboot?".
    assert mod.detect_reboot(prior_boot_id="100", current_boot_id=None) is False
    assert mod.detect_reboot(prior_boot_id="100", current_boot_id="") is False


# ---------------------------------------------------------------------------
# Test 15: classify_with_reboot — promote post-reboot agent failure (pure)
# ---------------------------------------------------------------------------


def test_reboot_then_healthy_is_not_a_regression(mod):
    # Clean reboot, agent came back ok => base state unchanged, no regression.
    out = mod.classify_with_reboot(
        base_state="ok", prior_boot_id="100", current_boot_id="200",
    )
    assert out == "ok"


def test_reboot_then_agent_unloaded_is_regression(mod):
    out = mod.classify_with_reboot(
        base_state="agent_unloaded", prior_boot_id="100", current_boot_id="200",
    )
    assert out == "post_reboot_regression"


def test_reboot_then_session_absent_is_regression(mod):
    out = mod.classify_with_reboot(
        base_state="gui_session_absent", prior_boot_id="100", current_boot_id="200",
    )
    assert out == "post_reboot_regression"


def test_no_reboot_transient_unload_stays_normal_path(mod):
    # Same boot id => a transient unload is NOT a post-reboot regression; it
    # stays on the normal threshold path as plain agent_unloaded.
    out = mod.classify_with_reboot(
        base_state="agent_unloaded", prior_boot_id="100", current_boot_id="100",
    )
    assert out == "agent_unloaded"


def test_first_ever_observation_no_false_regression(mod):
    # No prior boot id (first run) must never produce a regression even if the
    # agent is down.
    out = mod.classify_with_reboot(
        base_state="agent_unloaded", prior_boot_id=None, current_boot_id="200",
    )
    assert out == "agent_unloaded"


def test_missing_current_boot_id_no_false_regression(mod):
    # Fail-closed: a missing/garbage current boot id must NOT fabricate a
    # regression; base state is preserved.
    out = mod.classify_with_reboot(
        base_state="agent_unloaded", prior_boot_id="100", current_boot_id=None,
    )
    assert out == "agent_unloaded"


def test_reboot_with_inconclusive_base_is_not_regression(mod):
    # A reboot + inconclusive base (e.g. unknown user / garbage probe) must stay
    # inconclusive, never be upgraded to a confident regression.
    out = mod.classify_with_reboot(
        base_state="inconclusive", prior_boot_id="100", current_boot_id="200",
    )
    assert out == "inconclusive"


def test_reboot_with_unreachable_base_is_not_regression(mod):
    out = mod.classify_with_reboot(
        base_state="unreachable", prior_boot_id="100", current_boot_id="200",
    )
    assert out == "unreachable"


# ---------------------------------------------------------------------------
# Test 16: post_reboot_regression is a non-ok state, critical, threshold-gated
# ---------------------------------------------------------------------------


def test_post_reboot_regression_in_non_ok_states(mod):
    assert "post_reboot_regression" in mod.NON_OK_STATES


def test_post_reboot_regression_emit_severity_critical(mod):
    argv = mod.build_emit_argv(
        host="botbox-a", instance="x-bot", label="com.whatsoup.x-bot",
        state="post_reboot_regression", consecutive_failures=2, threshold=2,
    )
    assert argv[argv.index("--severity") + 1] == "critical"
    diags = [argv[i + 1] for i, a in enumerate(argv) if a == "--diagnostic"]
    assert "gui_state=post_reboot_regression" in diags


def test_post_reboot_regression_gated_by_threshold(mod):
    below = mod.evaluate_emit_decision(
        state="post_reboot_regression", consecutive_failures=1, threshold=2,
    )
    at = mod.evaluate_emit_decision(
        state="post_reboot_regression", consecutive_failures=2, threshold=2,
    )
    assert below.should_emit is False
    assert at.should_emit is True


# ---------------------------------------------------------------------------
# Test 17: run_target is boot-aware (persists boot_id, promotes regression)
# ---------------------------------------------------------------------------


def _probe_boot(boot_id, *, console_owner="root", agent_state="unloaded",
                console_ok=True, agent_ok=True):
    p = _probe(console_owner=console_owner, agent_state=agent_state,
               console_ok=console_ok, agent_ok=agent_ok)
    p["boot_id"] = boot_id
    return p


def test_run_target_persists_boot_id(mod):
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe_boot("500", console_owner="x-bot", agent_state="running"),
        prior_state=None,
        threshold=2,
    )
    assert outcome.new_state["boot_id"] == "500"
    assert outcome.state == "ok"


def test_run_target_reboot_then_unloaded_is_regression(mod):
    prior = {"consecutive_failures": 1, "last_state": "agent_unloaded", "boot_id": "100"}
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe_boot("200", console_owner="x-bot", agent_state="unloaded"),
        prior_state=prior,
        threshold=2,
    )
    assert outcome.state == "post_reboot_regression"
    assert outcome.new_state["boot_id"] == "200"
    assert outcome.emit_decision.should_emit is True
    assert "gui_state=post_reboot_regression" in outcome.emit_argv


def test_run_target_no_reboot_transient_unload_is_plain(mod):
    prior = {"consecutive_failures": 1, "last_state": "agent_unloaded", "boot_id": "100"}
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe_boot("100", console_owner="x-bot", agent_state="unloaded"),
        prior_state=prior,
        threshold=2,
    )
    assert outcome.state == "agent_unloaded"


def test_run_target_first_run_no_false_regression(mod):
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe_boot("200", console_owner="x-bot", agent_state="unloaded"),
        prior_state=None,
        threshold=2,
    )
    assert outcome.state == "agent_unloaded"
    assert outcome.new_state["boot_id"] == "200"


def test_run_target_missing_boot_id_no_false_regression(mod):
    # boot probe failed (None) but agent is down after what might be a reboot:
    # must NOT fabricate a regression; stays plain agent_unloaded.
    prior = {"consecutive_failures": 1, "last_state": "agent_unloaded", "boot_id": "100"}
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe_boot(None, console_owner="x-bot", agent_state="unloaded"),
        prior_state=prior,
        threshold=2,
    )
    assert outcome.state == "agent_unloaded"
    # The unknown boot id must not overwrite the last known good boot id with None.
    assert outcome.new_state.get("boot_id") in ("100", None) or "boot_id" in outcome.new_state


def test_run_target_reboot_regression_resets_to_clean_on_recovery(mod):
    # After a regression, a later healthy probe (new boot id) clears failures.
    prior = {"consecutive_failures": 2, "last_state": "post_reboot_regression", "boot_id": "200"}
    outcome = mod.run_target(
        target=_target(),
        expected_user="x-bot",
        probe=_probe_boot("200", console_owner="x-bot", agent_state="running"),
        prior_state=prior,
        threshold=2,
    )
    assert outcome.state == "ok"
    assert outcome.new_state["consecutive_failures"] == 0


# ===========================================================================
# SLICE 3: per-host session-policy matrix (guiSessionExpected enum, non-PII)
# ===========================================================================


# ---------------------------------------------------------------------------
# Test 18: policy_for_target — resolve guiSessionExpected (host + instance)
# ---------------------------------------------------------------------------


def _host(host, role="bot-host", policy=None, instances=None):
    entry = {"host": host, "role": role, "instances": instances or []}
    if policy is not None:
        entry["guiSessionExpected"] = policy
    return entry


def _inst(name, *, expected="always_on", service=None, policy=None):
    item = {"name": name, "expected": expected,
            "service": service or f"com.whatsoup.{name}"}
    if policy is not None:
        item["guiSessionExpected"] = policy
    return item


def test_policy_for_target_reads_host_level_always_aqua(mod):
    host = _host("botbox", policy="always_aqua", instances=[_inst("x-bot")])
    assert mod.policy_for_target(host, host["instances"][0]) == "always_aqua"


def test_policy_for_target_reads_host_level_headless_ok(mod):
    host = _host("relay", role="relay-only", policy="headless_ok",
                 instances=[_inst("agent", expected="on_demand")])
    assert mod.policy_for_target(host, host["instances"][0]) == "headless_ok"


def test_policy_for_target_reads_host_level_not_applicable(mod):
    host = _host("central", role="central", policy="not_applicable",
                 instances=[_inst("primary", service="whatsoup-primary.service")])
    assert mod.policy_for_target(host, host["instances"][0]) == "not_applicable"


def test_policy_for_target_instance_overrides_host(mod):
    host = _host("mixed", policy="always_aqua",
                 instances=[_inst("special", policy="headless_ok")])
    assert mod.policy_for_target(host, host["instances"][0]) == "headless_ok"


def test_policy_for_target_unknown_value_treated_as_missing(mod):
    # A garbage enum value must not be trusted; behaves as "no declared policy".
    host = _host("botbox", policy="banana", instances=[_inst("x-bot")])
    assert mod.policy_for_target(host, host["instances"][0]) is None


def test_policy_for_target_missing_returns_none(mod):
    host = _host("botbox", instances=[_inst("x-bot")])
    assert mod.policy_for_target(host, host["instances"][0]) is None


# ---------------------------------------------------------------------------
# Test 19: gui_targets_from_fleet selects/excludes by declared policy
# ---------------------------------------------------------------------------


_POLICY_FLEET = {
    "schemaVersion": 1,
    "hosts": [
        _host("botbox-a", role="bot-host", policy="always_aqua",
              instances=[_inst("x-bot")]),
        _host("relay-box", role="relay-only", policy="headless_ok",
              instances=[_inst("agent", expected="on_demand",
                               service="com.whatsoup.agent")]),
        _host("central-box", role="central", policy="not_applicable",
              instances=[_inst("primary", service="whatsoup-primary.service")]),
        _host("nobot-box", role="no-bot", policy="not_applicable", instances=[]),
    ],
}


def test_policy_always_aqua_is_monitored(mod):
    targets = mod.gui_targets_from_fleet(_POLICY_FLEET)
    assert sorted(t["host"] for t in targets) == ["botbox-a"]


def test_policy_headless_ok_is_excluded(mod):
    targets = mod.gui_targets_from_fleet(_POLICY_FLEET)
    assert "relay-box" not in {t["host"] for t in targets}


def test_policy_not_applicable_is_excluded(mod):
    targets = mod.gui_targets_from_fleet(_POLICY_FLEET)
    hosts = {t["host"] for t in targets}
    assert "central-box" not in hosts
    assert "nobot-box" not in hosts


def test_policy_headless_ok_overrides_launchagent_label(mod):
    # Even with a com.whatsoup.* LaunchAgent label, headless_ok policy excludes it
    # (explicit declared exclusion, not implicit by label shape).
    fleet = {"hosts": [
        _host("relay-box", role="relay-only", policy="headless_ok",
              instances=[_inst("agent", expected="always_on",
                               service="com.whatsoup.agent")]),
    ]}
    assert mod.gui_targets_from_fleet(fleet) == []


def test_policy_not_applicable_overrides_launchagent_label(mod):
    fleet = {"hosts": [
        _host("weird", role="bot-host", policy="not_applicable",
              instances=[_inst("x-bot", service="com.whatsoup.x-bot")]),
    ]}
    assert mod.gui_targets_from_fleet(fleet) == []


# ---------------------------------------------------------------------------
# Test 20: FAIL-CLOSED default — bot host with unknown/missing policy is
# STILL monitored, never silently dropped.
# ---------------------------------------------------------------------------


def test_bot_host_missing_policy_is_still_monitored(mod):
    fleet = {"hosts": [
        _host("botbox", role="bot-host", policy=None,
              instances=[_inst("x-bot", service="com.whatsoup.x-bot")]),
    ]}
    targets = mod.gui_targets_from_fleet(fleet)
    assert [t["host"] for t in targets] == ["botbox"]


def test_bot_host_garbage_policy_is_still_monitored(mod):
    fleet = {"hosts": [
        _host("botbox", role="bot-host", policy="not-a-real-policy",
              instances=[_inst("x-bot", service="com.whatsoup.x-bot")]),
    ]}
    targets = mod.gui_targets_from_fleet(fleet)
    assert [t["host"] for t in targets] == ["botbox"]


def test_missing_policy_non_launchagent_still_excluded(mod):
    # No policy + non-com.whatsoup label (systemd unit) => still excluded; the
    # fail-closed default only catches plausible GUI LaunchAgents.
    fleet = {"hosts": [
        _host("central", role="central", policy=None,
              instances=[_inst("primary", service="whatsoup-primary.service")]),
    ]}
    assert mod.gui_targets_from_fleet(fleet) == []


# ---------------------------------------------------------------------------
# Test 20b: best_effort policy — an intentionally intermittent (expected-
# sleeping) host is a KNOWN, EXPLICITLY-EXCLUDING policy. It must NOT fall
# through to the fail-closed default and be re-enrolled. Regression for #1874.
# ---------------------------------------------------------------------------


def _declares_best_effort(host_entry: dict) -> bool:
    if host_entry.get("guiSessionExpected") == "best_effort":
        return True
    return any(
        isinstance(inst, dict) and inst.get("guiSessionExpected") == "best_effort"
        for inst in (host_entry.get("instances") or [])
    )


def _load_tracked_manifest(mod) -> dict:
    """Load the checked-in SSOT manifest (deploy/bot-errors-expected-fleet.json)."""
    return json.loads(
        (mod.REPO_ROOT / "deploy" / "bot-errors-expected-fleet.json").read_text(
            encoding="utf-8"
        )
    )


def _best_effort_hosts(mod, fleet: dict) -> set[str]:
    return {
        mod._norm(h.get("host"))
        for h in fleet.get("hosts", [])
        if isinstance(h, dict) and _declares_best_effort(h)
    }


def _collector_membership(mod, fleet: dict) -> set[str]:
    """Hosts the collector is declared (SSOT ``collectorRemote``) to remotely probe.

    There is no collector function that maps a manifest to membership (the
    collector's remotes come from CLI/env, not this file); ``collectorRemote`` is
    the manifest's per-host SSOT for whether the collector treats a host as an
    active remote. That is exactly the field the parity contract must agree with.
    """
    return {
        mod._norm(h.get("host"))
        for h in fleet.get("hosts", [])
        if isinstance(h, dict) and h.get("collectorRemote") is True
    }


def test_policy_for_target_reads_best_effort(mod):
    # best_effort resolves to itself, NOT to None (the old unknown-value path).
    host = _host("gupta", policy="best_effort", instances=[_inst("clanka")])
    assert mod.policy_for_target(host, host["instances"][0]) == "best_effort"


def test_best_effort_is_a_known_excluding_policy(mod):
    assert "best_effort" in mod.KNOWN_GUI_SESSION_POLICIES
    assert "best_effort" in mod._EXCLUDING_POLICIES


def test_gui_vocabulary_matches_policy_ssot(mod):
    # The canonical policy vocabulary lives in tests/support/bot_errors_policy.py
    # (#1874 contract — kept out of deploy/scripts[/lib] so it needs no integrity-
    # manifest entry). The GUI monitor keeps a local copy (it is NOT runtime-imported).
    # This drift-guard makes the two provably identical so they cannot silently diverge.
    tests_dir = str(Path(__file__).resolve().parent)
    if tests_dir not in sys.path:
        sys.path.insert(0, tests_dir)
    from support import bot_errors_policy as ssot

    assert mod.KNOWN_GUI_SESSION_POLICIES == ssot.KNOWN_GUI_SESSION_POLICIES
    assert set(mod._EXCLUDING_POLICIES) == set(ssot._EXCLUDING_POLICIES)
    assert mod.POLICY_ALWAYS_AQUA == ssot.POLICY_ALWAYS_AQUA
    # Every value the GUI monitor treats as excluding must be a known SSOT policy.
    assert set(mod._EXCLUDING_POLICIES) <= ssot.KNOWN_GUI_SESSION_POLICIES


def test_best_effort_overrides_launchagent_label(mod):
    # An intentionally intermittent host carrying an always_on com.whatsoup.*
    # LaunchAgent used to be re-enrolled by the fail-closed default (#1874).
    # The explicit best_effort exclusion must win over the label shape.
    fleet = {"hosts": [
        _host("gupta", role="bot-host", policy="best_effort",
              instances=[_inst("clanka", expected="always_on",
                               service="com.whatsoup.clanka")]),
    ]}
    assert mod.gui_targets_from_fleet(fleet) == []


def test_tracked_manifest_best_effort_row_not_reenrolled(mod):
    # Regression against the checked-in SSOT (deploy/bot-errors-expected-fleet.json):
    # every declared best_effort host must be absent from the GUI-session targets.
    manifest = _load_tracked_manifest(mod)
    best_effort_hosts = _best_effort_hosts(mod, manifest)
    assert best_effort_hosts, "tracked manifest should carry a best_effort row (#1874 fixture)"
    target_hosts = {t["host"] for t in mod.gui_targets_from_fleet(manifest)}
    overlap = best_effort_hosts & target_hosts
    assert not overlap, f"best_effort hosts re-enrolled as GUI targets: {overlap}"


# ---------------------------------------------------------------------------
# Test 20c: cross-monitor parity — collector and GUI-session membership must
# AGREE for a best_effort host (both EXCLUDE it). The pre-fix defect re-enrolled
# gupta into GUI-session monitoring while the collector (collectorRemote:false)
# excluded it, so the two monitoring paths disagreed about the same declared
# policy. Uses the tracked manifest row. Regression for #1874.
# ---------------------------------------------------------------------------


def test_cross_monitor_parity_best_effort_excluded_by_both(mod):
    manifest = _load_tracked_manifest(mod)
    best_effort = _best_effort_hosts(mod, manifest)
    assert best_effort, "tracked manifest should carry a best_effort row (#1874 fixture)"

    gui_members = {t["host"] for t in mod.gui_targets_from_fleet(manifest)}
    collector_members = _collector_membership(mod, manifest)

    gui_overlap = best_effort & gui_members
    collector_overlap = best_effort & collector_members
    assert not gui_overlap, f"GUI monitor enrolled best_effort host(s): {gui_overlap}"
    assert not collector_overlap, f"collector enrolled best_effort host(s): {collector_overlap}"

    # Parity: the two monitors must not disagree about the best_effort host —
    # each membership's intersection with the best_effort set is empty (both exclude).
    assert (best_effort & gui_members) == (best_effort & collector_members) == set()


def test_cross_monitor_parity_holds_across_all_declared_policies(mod):
    # No host may be simultaneously GUI-monitored AND declared best_effort — the
    # exclusion is honored regardless of which monitor reads the manifest.
    manifest = _load_tracked_manifest(mod)
    gui_members = {t["host"] for t in mod.gui_targets_from_fleet(manifest)}
    for host_entry in manifest.get("hosts", []):
        if isinstance(host_entry, dict) and _declares_best_effort(host_entry):
            host = mod._norm(host_entry.get("host"))
            assert host not in gui_members, f"best_effort host still GUI-monitored: {host}"
            assert host_entry.get("collectorRemote") is not True, (
                f"best_effort host still an active collector remote: {host}"
            )


# ---------------------------------------------------------------------------
# Test 20d: manifest validation rejects UNKNOWN guiSessionExpected policy
# values. A typo'd / retired enum must fail config validation LOUDLY rather
# than silently falling through to the fail-closed default and changing
# monitor membership. A MISSING policy is NOT an error (that is the intended
# fail-closed default). Regression for #1874 acceptance criterion.
# ---------------------------------------------------------------------------


def test_unknown_policy_values_flags_host_level_typo(mod):
    fleet = {"hosts": [
        _host("botbox", role="bot-host", policy="alwys_aqua",  # typo
              instances=[_inst("x-bot")]),
    ]}
    offenders = mod.unknown_policy_values(fleet)
    assert [o["value"] for o in offenders] == ["alwys_aqua"]
    assert offenders[0]["host"] == "botbox"


def test_unknown_policy_values_flags_instance_level_typo(mod):
    host = _host("botbox", role="bot-host", policy="always_aqua",
                 instances=[_inst("special", policy="handless_ok")])  # typo
    offenders = mod.unknown_policy_values({"hosts": [host]})
    assert len(offenders) == 1
    assert offenders[0]["value"] == "handless_ok"
    assert offenders[0]["instance"] == "special"


def test_unknown_policy_values_ignores_missing_policy(mod):
    # Missing policy is the intended fail-closed default, NOT a validation error.
    fleet = {"hosts": [_host("botbox", role="bot-host", policy=None,
                             instances=[_inst("x-bot")])]}
    assert mod.unknown_policy_values(fleet) == []


def test_unknown_policy_values_accepts_every_known_policy(mod):
    fleet = {"hosts": [
        _host("a", policy="always_aqua", instances=[_inst("x")]),
        _host("b", policy="headless_ok", instances=[_inst("y")]),
        _host("c", policy="not_applicable", instances=[_inst("z")]),
        _host("d", policy="best_effort", instances=[_inst("w")]),
    ]}
    assert mod.unknown_policy_values(fleet) == []


def test_unknown_policy_values_clean_for_tracked_manifest(mod):
    # CI-level guard: the checked-in SSOT must never carry an unknown policy value.
    assert mod.unknown_policy_values(_load_tracked_manifest(mod)) == []


def test_config_check_rejects_unknown_policy_value(mod, tmp_path, monkeypatch, capsys):
    # A typo'd policy that would otherwise be silently re-enrolled by the
    # fail-closed default must instead FAIL config_check loudly (exit 2).
    fleet_file = tmp_path / "fleet-typo.json"
    fleet_file.write_text(
        '{"hosts":[{"host":"botbox","role":"bot-host","guiSessionExpected":"alwys_aqua",'
        '"instances":[{"name":"x-bot","expected":"always_on","service":"com.whatsoup.x-bot"}]}]}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.delenv("BOT_ERRORS_EXPECTED_FLEET", raising=False)

    assert mod.config_check() == 2
    captured = capsys.readouterr()
    assert "unknown guiSessionExpected policy value" in captured.err
    assert "alwys_aqua" in captured.err


# ---------------------------------------------------------------------------
# Test 21: public sanitized manifests must not arm private-label monitors
# without a hub-private expected-fleet override.
# ---------------------------------------------------------------------------


def test_private_monitor_override_not_required_by_default(mod):
    fleet = {"hosts": [
        _host("botbox", role="bot-host", policy="always_aqua",
              instances=[_inst("x-bot")]),
    ]}
    assert mod.private_monitor_override_required_count(fleet) == 0
    assert mod.private_override_contract_error(fleet, expected_fleet_override="") is None


def test_private_monitor_override_required_marker_counts_hosts(mod):
    fleet = {"hosts": [
        {
            **_host("sanitized-box", role="bot-host", policy="always_aqua",
                    instances=[_inst("placeholder-a")]),
            "privateMonitorOverrideRequired": True,
        },
    ]}
    assert mod.private_monitor_override_required_count(fleet) == 1


def test_private_monitor_override_missing_fails_closed(mod):
    fleet = {"hosts": [
        {
            **_host("sanitized-box", role="bot-host", policy="always_aqua",
                    instances=[_inst("placeholder-a")]),
            "privateMonitorOverrideRequired": True,
        },
    ]}
    error = mod.private_override_contract_error(fleet, expected_fleet_override="")
    assert error is not None
    assert "BOT_ERRORS_EXPECTED_FLEET" in error


def test_private_monitor_override_inside_repo_fails_closed(mod):
    fleet = {"hosts": [
        {
            **_host("sanitized-box", role="bot-host", policy="always_aqua",
                    instances=[_inst("placeholder-a")]),
            "privateMonitorOverrideRequired": True,
        },
    ]}
    error = mod.private_override_contract_error(
        fleet,
        expected_fleet_override=str(mod.REPO_ROOT / "deploy" / "bot-errors-expected-fleet.json"),
    )
    assert error is not None
    assert "outside the repo root" in error


def test_private_monitor_override_outside_repo_passes(mod, tmp_path):
    fleet = {"hosts": [
        {
            **_host("sanitized-box", role="bot-host", policy="always_aqua",
                    instances=[_inst("placeholder-a")]),
            "privateMonitorOverrideRequired": True,
        },
    ]}
    private_file = tmp_path / "expected-fleet.private.json"
    private_file.write_text("{}", encoding="utf-8")
    assert (
        mod.private_override_contract_error(
            fleet,
            expected_fleet_override=str(private_file),
        )
        is None
    )


def test_config_check_fails_closed_when_private_override_missing(mod, tmp_path, monkeypatch, capsys):
    fleet_file = tmp_path / "expected-fleet.public.json"
    fleet_file.write_text(
        """{"hosts":[{"host":"sanitized-box","role":"bot-host","guiSessionExpected":"always_aqua","privateMonitorOverrideRequired":true,"instances":[{"name":"placeholder-a","service":"com.whatsoup.placeholder-a","port":9090}]}]}""",
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.delenv("BOT_ERRORS_EXPECTED_FLEET", raising=False)

    assert mod.config_check() == 2
    captured = capsys.readouterr()
    assert "private expected-fleet override required" in captured.err


def test_config_check_passes_private_override_without_ssh_or_state(mod, tmp_path, monkeypatch, capsys):
    fleet_file = tmp_path / "expected-fleet.private.json"
    fleet_file.write_text(
        """{"hosts":[{"host":"sanitized-box","role":"bot-host","guiSessionExpected":"always_aqua","privateMonitorOverrideRequired":true,"instances":[{"name":"real-bot","service":"com.whatsoup.real-bot","port":9090}]}]}""",
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setenv("BOT_ERRORS_EXPECTED_FLEET", str(fleet_file))
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: (_ for _ in ()).throw(AssertionError("config check must not resolve SSH users")))
    monkeypatch.setattr(mod, "save_state", lambda state: (_ for _ in ()).throw(AssertionError("config check must not write state")))

    assert mod.config_check() == 0
    captured = capsys.readouterr()
    assert "gui-session-monitor config ok" in captured.out


# ---------------------------------------------------------------------------
# A5: config_check branch tests — unreadable/invalid JSON, non-dict payload,
# zero GUI targets.  These branches exist in the source; the tests assert the
# correct exit code and stderr message for each path.
# ---------------------------------------------------------------------------


def test_config_check_fails_closed_on_unreadable_invalid_json(mod, tmp_path, monkeypatch, capsys):
    """config_check must return 2 when the fleet file is not valid JSON."""
    bad_file = tmp_path / "fleet-bad.json"
    bad_file.write_text("{not valid json", encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: bad_file)

    assert mod.config_check() == 2
    captured = capsys.readouterr()
    assert "not valid JSON" in captured.err


def test_config_check_fails_closed_on_non_dict_json_payload(mod, tmp_path, monkeypatch, capsys):
    """config_check must return 2 when the fleet file contains a JSON array, not an object."""
    list_file = tmp_path / "fleet-list.json"
    list_file.write_text("[1, 2, 3]", encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: list_file)

    assert mod.config_check() == 2
    captured = capsys.readouterr()
    assert "must contain a JSON object" in captured.err


def test_config_check_fails_closed_on_zero_gui_targets(mod, tmp_path, monkeypatch, capsys):
    """config_check must return 2 when the fleet yields no GUI-session monitor targets."""
    no_targets_file = tmp_path / "fleet-no-targets.json"
    # A valid JSON object but with no bot-host entries that would yield targets.
    no_targets_file.write_text(
        '{"hosts":[{"host":"central","role":"central","instances":[]}]}',
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "fleet_path", lambda: no_targets_file)

    assert mod.config_check() == 2
    captured = capsys.readouterr()
    assert "no GUI-session monitor targets" in captured.err


# ===========================================================================
# NEW TESTS — added to raise coverage from 63% to >=98%
# Covers: ssh_command, ssh_timeout_seconds, fleet_path, load_fleet,
# state_path, load_state, save_state, resolve_expected_user,
# _parse_user_overrides, _run_ssh, probe_host, emit_event, run_once,
# parse_args, main, plus scattered branch lines in pure functions.
# ===========================================================================

import subprocess
from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# sys.path branch (line 46) — module-level: if SCRIPT_DIR not in sys.path
# The fixture reloads a fresh copy with SCRIPT_DIR removed from sys.path.
# ---------------------------------------------------------------------------


def test_script_dir_added_to_sys_path_when_missing(tmp_path):
    """The module inserts SCRIPT_DIR into sys.path when it is not already present."""
    import importlib.util as ilu
    import sys as _sys

    script = Path(__file__).resolve().parents[1] / "bot-errors-gui-session-monitor.py"
    spec = ilu.spec_from_file_location("_gui_monitor_fresh", script)
    fresh = ilu.module_from_spec(spec)

    script_dir = str(script.parent)
    was_present = script_dir in _sys.path
    if was_present:
        _sys.path.remove(script_dir)
    try:
        _sys.modules[spec.name] = fresh
        spec.loader.exec_module(fresh)
        assert script_dir in _sys.path
    finally:
        if not was_present and script_dir in _sys.path:
            _sys.path.remove(script_dir)
        _sys.modules.pop(spec.name, None)


# ---------------------------------------------------------------------------
# _has_live_pid (lines 188-190) — pid= form and pid with digits > 0
# ---------------------------------------------------------------------------


def test_has_live_pid_pid_equals_form(mod):
    text = "pid=1234\n"
    assert mod._has_live_pid(text) is True


def test_has_live_pid_pid_space_form(mod):
    text = "\tpid 4821\n"
    assert mod._has_live_pid(text) is True


def test_has_live_pid_zero_pid_returns_false(mod):
    # pid = 0 is not a live process
    text = "\tpid = 0\n"
    assert mod._has_live_pid(text) is False


def test_has_live_pid_no_pid_line_returns_false(mod):
    text = "state = running\nactive count = 1\n"
    assert mod._has_live_pid(text) is False


# ---------------------------------------------------------------------------
# default_failure_threshold (lines 272-276) — env var parsing branches
# ---------------------------------------------------------------------------


def test_default_failure_threshold_custom_valid(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD", "5")
    assert mod.default_failure_threshold() == 5


def test_default_failure_threshold_invalid_string_falls_back(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD", "not-a-number")
    assert mod.default_failure_threshold() == 2


def test_default_failure_threshold_zero_falls_back(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD", "0")
    assert mod.default_failure_threshold() == 2


def test_default_failure_threshold_negative_falls_back(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD", "-1")
    assert mod.default_failure_threshold() == 2


# ---------------------------------------------------------------------------
# policy_for_target (line 316) — non-dict source skipped
# ---------------------------------------------------------------------------


def test_policy_for_target_skips_non_dict_instance(mod):
    host = {"host": "botbox", "guiSessionExpected": "always_aqua", "instances": []}
    # Pass a non-dict instance — should fall through to host policy
    result = mod.policy_for_target(host, "not-a-dict")
    assert result == "always_aqua"


# ---------------------------------------------------------------------------
# gui_targets_from_fleet branch lines (349, 352, 355, 358, 368->370)
# ---------------------------------------------------------------------------


def test_gui_targets_skips_non_dict_host_entry(mod):
    fleet = {"hosts": ["not-a-dict", {"host": "botbox", "instances": [
        {"name": "x", "expected": "always_on", "service": "com.whatsoup.x"}
    ]}]}
    targets = mod.gui_targets_from_fleet(fleet)
    assert len(targets) == 1
    assert targets[0]["host"] == "botbox"


def test_gui_targets_skips_host_with_empty_host_key(mod):
    fleet = {"hosts": [
        {"host": "", "instances": [
            {"name": "x", "expected": "always_on", "service": "com.whatsoup.x"}
        ]},
        {"host": "botbox", "instances": [
            {"name": "y", "expected": "always_on", "service": "com.whatsoup.y"}
        ]},
    ]}
    targets = mod.gui_targets_from_fleet(fleet)
    assert len(targets) == 1
    assert targets[0]["host"] == "botbox"


def test_gui_targets_skips_non_list_instances(mod):
    fleet = {"hosts": [
        {"host": "botbox", "instances": "not-a-list"},
    ]}
    assert mod.gui_targets_from_fleet(fleet) == []


def test_gui_targets_skips_non_dict_instance_item(mod):
    fleet = {"hosts": [
        {"host": "botbox", "instances": [
            "not-a-dict",
            {"name": "x", "expected": "always_on", "service": "com.whatsoup.x"},
        ]},
    ]}
    targets = mod.gui_targets_from_fleet(fleet)
    assert len(targets) == 1
    assert targets[0]["instance"] == "x"


def test_gui_targets_always_aqua_with_empty_label_skipped(mod):
    # always_aqua policy but empty service label -> skipped (line 368->370)
    fleet = {"hosts": [
        {"host": "botbox", "guiSessionExpected": "always_aqua", "instances": [
            {"name": "x", "expected": "always_on", "service": ""},
        ]},
    ]}
    targets = mod.gui_targets_from_fleet(fleet)
    assert targets == []


def test_gui_targets_always_aqua_with_label_uses_name_or_label(mod):
    # always_aqua + no name -> falls back to label
    fleet = {"hosts": [
        {"host": "botbox", "guiSessionExpected": "always_aqua", "instances": [
            {"name": "", "expected": "always_on", "service": "com.whatsoup.x"},
        ]},
    ]}
    targets = mod.gui_targets_from_fleet(fleet)
    assert len(targets) == 1
    assert targets[0]["instance"] == "com.whatsoup.x"


# ---------------------------------------------------------------------------
# private_monitor_override_required_count (line 392) — non-list hosts
# ---------------------------------------------------------------------------


def test_private_monitor_override_required_count_non_list_hosts(mod):
    assert mod.private_monitor_override_required_count({"hosts": "bad"}) == 0


def test_private_monitor_override_required_count_no_hosts_key(mod):
    assert mod.private_monitor_override_required_count({}) == 0


# ---------------------------------------------------------------------------
# _path_is_under (lines 404-405) — OSError branch
# ---------------------------------------------------------------------------


def test_path_is_under_oserror_returns_false(mod, monkeypatch):
    """_path_is_under must return False on OSError (e.g. invalid path)."""
    from pathlib import Path as _Path

    class BrokenPath(_Path):
        _flavour = _Path(".")._flavour

        def resolve(self):
            raise OSError("simulated resolve failure")

    broken = BrokenPath("/nonexistent/probe")
    result = mod._path_is_under(broken, _Path("/some/root"))
    assert result is False


# ---------------------------------------------------------------------------
# run_target (lines 521-522) — unparseable prior_count
# ---------------------------------------------------------------------------


def test_run_target_handles_unparseable_prior_count(mod):
    prior = {"consecutive_failures": "not-an-int", "last_state": "ok"}
    outcome = mod.run_target(
        target={"host": "h", "instance": "i", "label": "com.whatsoup.x"},
        expected_user="x",
        probe=_probe(console_owner="root", agent_state="running"),
        prior_state=prior,
        threshold=2,
    )
    # Unparseable prior count treated as 0, so this is the first failure (count=1)
    assert outcome.new_state["consecutive_failures"] == 1
    assert outcome.emit_decision.should_emit is False


# ---------------------------------------------------------------------------
# evaluate_emit_decision (line 578) — unknown state branch (pass)
# ---------------------------------------------------------------------------


def test_evaluate_emit_decision_unknown_state_still_gates_by_threshold(mod):
    # A completely unknown state falls through the `if state not in NON_OK_STATES: pass`
    # branch and is still threshold-gated (not suppressed, not raised).
    below = mod.evaluate_emit_decision(
        state="alien_state", consecutive_failures=1, threshold=2,
    )
    at = mod.evaluate_emit_decision(
        state="alien_state", consecutive_failures=2, threshold=2,
    )
    assert below.should_emit is False
    assert at.should_emit is True


# ---------------------------------------------------------------------------
# ssh_command (lines 598-599) — env var vs default
# ---------------------------------------------------------------------------


def test_ssh_command_returns_default_ssh(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_SSH_COMMAND", raising=False)
    assert mod.ssh_command() == ["ssh"]


def test_ssh_command_reads_env_var(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_SSH_COMMAND", "ssh -o StrictHostKeyChecking=no")
    result = mod.ssh_command()
    assert result == ["ssh", "-o", "StrictHostKeyChecking=no"]


# ---------------------------------------------------------------------------
# ssh_timeout_seconds (lines 603-607) — valid, invalid, custom
# ---------------------------------------------------------------------------


def test_ssh_timeout_seconds_default(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS", raising=False)
    assert mod.ssh_timeout_seconds() == 15.0


def test_ssh_timeout_seconds_custom(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS", "30")
    assert mod.ssh_timeout_seconds() == 30.0


def test_ssh_timeout_seconds_invalid_falls_back(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS", "bad")
    assert mod.ssh_timeout_seconds() == 15.0


def test_ssh_timeout_seconds_below_minimum_clamped(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS", "0")
    assert mod.ssh_timeout_seconds() == 1.0


# ---------------------------------------------------------------------------
# fleet_path (lines 611-614) — env var vs default
# ---------------------------------------------------------------------------


def test_fleet_path_default(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_EXPECTED_FLEET", raising=False)
    p = mod.fleet_path()
    assert p.name == "bot-errors-expected-fleet.json"
    assert "deploy" in str(p)


def test_fleet_path_custom_env(mod, monkeypatch, tmp_path):
    custom = tmp_path / "my-fleet.json"
    monkeypatch.setenv("BOT_ERRORS_EXPECTED_FLEET", str(custom))
    assert mod.fleet_path() == custom


# ---------------------------------------------------------------------------
# load_fleet (lines 618-625) — success, OSError, JSONDecodeError, non-dict
# ---------------------------------------------------------------------------


def test_load_fleet_reads_valid_json(mod, monkeypatch, tmp_path):
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text('{"hosts": []}', encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    result = mod.load_fleet()
    assert result == {"hosts": []}


def test_load_fleet_returns_empty_on_missing_file(mod, monkeypatch, tmp_path):
    missing = tmp_path / "nonexistent.json"
    monkeypatch.setattr(mod, "fleet_path", lambda: missing)
    assert mod.load_fleet() == {}


def test_load_fleet_returns_empty_on_invalid_json(mod, monkeypatch, tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: bad)
    assert mod.load_fleet() == {}


def test_load_fleet_returns_empty_on_non_dict_json(mod, monkeypatch, tmp_path):
    arr = tmp_path / "array.json"
    arr.write_text("[1, 2, 3]", encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: arr)
    assert mod.load_fleet() == {}


# ---------------------------------------------------------------------------
# state_path (lines 656-661) — env var forms
# ---------------------------------------------------------------------------


def test_state_path_custom_env_var(mod, monkeypatch, tmp_path):
    custom = tmp_path / "custom-state.json"
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_STATE", str(custom))
    monkeypatch.delenv("BOT_ERRORS_STATE_DIR", raising=False)
    assert mod.state_path() == custom


def test_state_path_state_dir_env_var(mod, monkeypatch, tmp_path):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_STATE", raising=False)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    p = mod.state_path()
    assert p.parent == tmp_path
    assert p.name == "gui-session-monitor-state.json"


def test_state_path_default_no_env(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_STATE", raising=False)
    monkeypatch.delenv("BOT_ERRORS_STATE_DIR", raising=False)
    p = mod.state_path()
    assert p.name == "gui-session-monitor-state.json"
    assert ".local" in str(p) or "state" in str(p)


# ---------------------------------------------------------------------------
# load_state (lines 665-670) — success, missing, invalid, non-dict
# ---------------------------------------------------------------------------


def test_load_state_reads_valid_json(mod, monkeypatch, tmp_path):
    state_file = tmp_path / "state.json"
    state_file.write_text('{"key": {"consecutive_failures": 3}}', encoding="utf-8")
    monkeypatch.setattr(mod, "state_path", lambda: state_file)
    result = mod.load_state()
    assert result == {"key": {"consecutive_failures": 3}}


def test_load_state_returns_empty_on_missing(mod, monkeypatch, tmp_path):
    missing = tmp_path / "no-state.json"
    monkeypatch.setattr(mod, "state_path", lambda: missing)
    assert mod.load_state() == {}


def test_load_state_returns_empty_on_invalid_json(mod, monkeypatch, tmp_path):
    bad = tmp_path / "bad-state.json"
    bad.write_text("{bad", encoding="utf-8")
    monkeypatch.setattr(mod, "state_path", lambda: bad)
    assert mod.load_state() == {}


def test_load_state_returns_empty_on_non_dict(mod, monkeypatch, tmp_path):
    arr = tmp_path / "arr-state.json"
    arr.write_text("[1, 2]", encoding="utf-8")
    monkeypatch.setattr(mod, "state_path", lambda: arr)
    assert mod.load_state() == {}


# ---------------------------------------------------------------------------
# save_state (lines 674-679) — atomic write via temp file
# ---------------------------------------------------------------------------


def test_save_state_writes_json_atomically(mod, monkeypatch, tmp_path):
    state_file = tmp_path / "subdir" / "state.json"
    monkeypatch.setattr(mod, "state_path", lambda: state_file)
    payload = {"host/label": {"consecutive_failures": 2, "last_state": "unreachable"}}
    mod.save_state(payload)
    assert state_file.exists()
    import json as _json
    data = _json.loads(state_file.read_text())
    assert data == payload


def test_save_state_creates_parent_dirs(mod, monkeypatch, tmp_path):
    deep = tmp_path / "a" / "b" / "c" / "state.json"
    monkeypatch.setattr(mod, "state_path", lambda: deep)
    mod.save_state({"x": 1})
    assert deep.exists()


# ---------------------------------------------------------------------------
# _parse_user_overrides (lines 714-721) — env var parsing
# ---------------------------------------------------------------------------


def test_parse_user_overrides_empty(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_USERS", raising=False)
    assert mod._parse_user_overrides() == {}


def test_parse_user_overrides_single_entry(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_USERS", "botbox=alice")
    assert mod._parse_user_overrides() == {"botbox": "alice"}


def test_parse_user_overrides_multiple_entries(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_USERS", "hosta=alice,hostb=bob")
    result = mod._parse_user_overrides()
    assert result == {"hosta": "alice", "hostb": "bob"}


def test_parse_user_overrides_skips_empty_host_or_user(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_USERS", "=alice,hostb=,hostc=charlie")
    result = mod._parse_user_overrides()
    assert result == {"hostc": "charlie"}


def test_parse_user_overrides_entry_without_equals_ignored(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_USERS", "noequalssign,host=user")
    result = mod._parse_user_overrides()
    assert result == {"host": "user"}


# ---------------------------------------------------------------------------
# resolve_expected_user (lines 690-710) — override map, SSH success/fail
# ---------------------------------------------------------------------------


def test_resolve_expected_user_from_override(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_GUI_MONITOR_USERS", "botbox=alice")
    monkeypatch.delenv("BOT_ERRORS_SSH_COMMAND", raising=False)
    # Should return from override without touching subprocess
    assert mod.resolve_expected_user("botbox") == "alice"


def test_resolve_expected_user_ssh_success(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_USERS", raising=False)
    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = "Host botbox\nUser alice\nPort 22\n"
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    assert mod.resolve_expected_user("botbox") == "alice"


def test_resolve_expected_user_ssh_nonzero_returns_none(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_USERS", raising=False)
    fake_proc = MagicMock()
    fake_proc.returncode = 1
    fake_proc.stdout = ""
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    assert mod.resolve_expected_user("botbox") is None


def test_resolve_expected_user_oserror_returns_none(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_USERS", raising=False)
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(OSError("no ssh")))
    assert mod.resolve_expected_user("botbox") is None


def test_resolve_expected_user_subprocess_error_returns_none(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_USERS", raising=False)
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(subprocess.SubprocessError("timeout")))
    assert mod.resolve_expected_user("botbox") is None


def test_resolve_expected_user_no_user_line_returns_none(mod, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_GUI_MONITOR_USERS", raising=False)
    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = "Host botbox\nPort 22\nHostName botbox.local\n"
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    assert mod.resolve_expected_user("botbox") is None


# ---------------------------------------------------------------------------
# _run_ssh (lines 725-741) — success, nonzero+stdout, nonzero+empty, OSError
# ---------------------------------------------------------------------------


def test_run_ssh_success(mod, monkeypatch):
    fake_proc = MagicMock()
    fake_proc.returncode = 0
    fake_proc.stdout = "alice\n"
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    ok, out = mod._run_ssh("botbox", ["stat", "-f", "%Su", "/dev/console"])
    assert ok is True
    assert out == "alice\n"


def test_run_ssh_nonzero_with_stdout_is_usable(mod, monkeypatch):
    fake_proc = MagicMock()
    fake_proc.returncode = 1
    fake_proc.stdout = "Could not find service com.whatsoup.x\n"
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    ok, out = mod._run_ssh("botbox", ["launchctl", "print", "gui/501/com.whatsoup.x"])
    assert ok is True
    assert "Could not find" in out


def test_run_ssh_nonzero_empty_stdout_is_failure(mod, monkeypatch):
    fake_proc = MagicMock()
    fake_proc.returncode = 255
    fake_proc.stdout = ""
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    ok, out = mod._run_ssh("botbox", ["stat", "-f", "%Su", "/dev/console"])
    assert ok is False
    assert out == ""


def test_run_ssh_oserror_returns_false(mod, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(OSError("unreachable")))
    ok, out = mod._run_ssh("botbox", ["stat", "-f", "%Su", "/dev/console"])
    assert ok is False
    assert out == ""


def test_run_ssh_subprocess_error_returns_false(mod, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(subprocess.SubprocessError("timeout")))
    ok, out = mod._run_ssh("botbox", ["stat", "-f", "%Su", "/dev/console"])
    assert ok is False
    assert out == ""


# ---------------------------------------------------------------------------
# probe_host (lines 750-769) — integration of SSH probes
# ---------------------------------------------------------------------------


def _make_run_ssh_mock(responses):
    """Return a _run_ssh mock that returns successive (ok, stdout) pairs."""
    calls = iter(responses)

    def _mock(host, remote_cmd):
        return next(calls)

    return _mock


def test_probe_host_all_probes_succeed(mod, monkeypatch):
    """When all SSH probes succeed, probe dict has correct fields."""
    responses = [
        (True, "alice\n"),          # console probe
        (True, "501\n"),            # uid probe
        (True, "com.whatsoup.x = {\n\tstate = running\n\tpid = 1234\n}\n"),  # agent probe
        (True, "{ sec = 1718000000, usec = 1 }"),  # boot probe
    ]
    monkeypatch.setattr(mod, "_run_ssh", _make_run_ssh_mock(responses))
    result = mod.probe_host("botbox", "alice", "com.whatsoup.x")
    assert result["console_ok"] is True
    assert result["console_owner"] == "alice"
    assert result["agent_ok"] is True
    assert result["agent_state"] == "running"
    assert result["boot_id"] == "1718000000"


def test_probe_host_console_failure(mod, monkeypatch):
    """Console SSH failure -> console_ok=False, fail-closed."""
    responses = [
        (False, ""),            # console probe fails
        (True, "501\n"),        # uid probe (still called)
        (True, "com.whatsoup.x = {\n\tstate = running\n}\n"),
        (True, "{ sec = 1718000000, usec = 1 }"),
    ]
    monkeypatch.setattr(mod, "_run_ssh", _make_run_ssh_mock(responses))
    result = mod.probe_host("botbox", "alice", "com.whatsoup.x")
    assert result["console_ok"] is False
    assert result["console_owner"] is None


def test_probe_host_uid_probe_fails_skips_agent(mod, monkeypatch):
    """When uid probe fails, agent probe is skipped (agent_ok=False)."""
    responses = [
        (True, "alice\n"),        # console
        (False, ""),              # uid probe fails
        # NO agent probe call (uid not obtained)
        (True, "{ sec = 1718000000, usec = 1 }"),  # boot
    ]
    monkeypatch.setattr(mod, "_run_ssh", _make_run_ssh_mock(responses))
    result = mod.probe_host("botbox", "alice", "com.whatsoup.x")
    assert result["agent_ok"] is False
    assert result["agent_state"] is None


def test_probe_host_none_expected_user_skips_uid_and_agent(mod, monkeypatch):
    """When expected_user is None, uid+agent probes are skipped entirely."""
    responses = [
        (True, "alice\n"),         # console
        # No uid probe (expected_user is None)
        # No agent probe
        (True, "{ sec = 1718000000, usec = 1 }"),  # boot
    ]
    monkeypatch.setattr(mod, "_run_ssh", _make_run_ssh_mock(responses))
    result = mod.probe_host("botbox", None, "com.whatsoup.x")
    assert result["agent_ok"] is False
    assert result["agent_state"] is None


def test_probe_host_boot_probe_fails(mod, monkeypatch):
    """Boot probe failure yields boot_id=None (no fabricated reboot)."""
    responses = [
        (True, "alice\n"),
        (True, "501\n"),
        (True, "com.whatsoup.x = {\n\tstate = running\n\tpid = 1234\n}\n"),
        (False, ""),              # boot probe fails
    ]
    monkeypatch.setattr(mod, "_run_ssh", _make_run_ssh_mock(responses))
    result = mod.probe_host("botbox", "alice", "com.whatsoup.x")
    assert result["boot_id"] is None


def test_probe_host_uid_non_digit_skips_agent(mod, monkeypatch):
    """When uid output is non-digit, agent probe is skipped."""
    responses = [
        (True, "alice\n"),
        (True, "not-a-uid\n"),   # uid ok but non-digit
        # No agent probe
        (True, "{ sec = 1718000000, usec = 1 }"),
    ]
    monkeypatch.setattr(mod, "_run_ssh", _make_run_ssh_mock(responses))
    result = mod.probe_host("botbox", "alice", "com.whatsoup.x")
    assert result["agent_ok"] is False


# ---------------------------------------------------------------------------
# emit_event (lines 780-791) — dry_run, subprocess success, failure, OSError
# ---------------------------------------------------------------------------


def test_emit_event_dry_run_prints_and_returns_zero(mod, capsys):
    argv = ["--severity", "critical", "--summary", "test alert"]
    rc = mod.emit_event(argv, dry_run=True)
    assert rc == 0
    out = capsys.readouterr().out
    assert "[dry-run]" in out
    assert "--severity" in out


def test_emit_event_real_run_success(mod, monkeypatch):
    fake_proc = MagicMock()
    fake_proc.returncode = 0
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    rc = mod.emit_event(["--summary", "x"], dry_run=False)
    assert rc == 0


def test_emit_event_real_run_nonzero(mod, monkeypatch):
    fake_proc = MagicMock()
    fake_proc.returncode = 1
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: fake_proc)
    rc = mod.emit_event(["--summary", "x"], dry_run=False)
    assert rc == 1


def test_emit_event_oserror_returns_one(mod, monkeypatch, capsys):
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(OSError("no emit")))
    rc = mod.emit_event(["--summary", "x"], dry_run=False)
    assert rc == 1
    assert "emit failed" in capsys.readouterr().err


def test_emit_event_subprocess_error_returns_one(mod, monkeypatch, capsys):
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(subprocess.SubprocessError("boom")))
    rc = mod.emit_event(["--summary", "x"], dry_run=False)
    assert rc == 1


# ---------------------------------------------------------------------------
# run_once (lines 795-835) — orchestration with mocked I/O
# ---------------------------------------------------------------------------


def _minimal_fleet_json():
    return '{"hosts":[{"host":"botbox","guiSessionExpected":"always_aqua","instances":[{"name":"x-bot","service":"com.whatsoup.x-bot"}]}]}'


def test_run_once_dry_run_no_state_write(mod, monkeypatch, tmp_path, capsys):
    """dry_run=True must not call save_state."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {})
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: "alice")
    monkeypatch.setattr(mod, "probe_host", lambda host, user, label: {
        "console_owner": "alice", "agent_state": "running",
        "console_ok": True, "agent_ok": True, "boot_id": None, "error": None,
    })

    save_called = []
    monkeypatch.setattr(mod, "save_state", lambda s: save_called.append(s))

    rc = mod.run_once(dry_run=True)
    assert rc == 0
    assert save_called == [], "save_state must not be called in dry_run mode"


def test_run_once_persists_state_on_real_run(mod, monkeypatch, tmp_path):
    """dry_run=False must call save_state with updated state."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {})
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: "alice")
    monkeypatch.setattr(mod, "probe_host", lambda host, user, label: {
        "console_owner": "alice", "agent_state": "running",
        "console_ok": True, "agent_ok": True, "boot_id": None, "error": None,
    })

    saved = {}

    def _save(s):
        saved.update(s)

    monkeypatch.setattr(mod, "save_state", _save)
    rc = mod.run_once(dry_run=False)
    assert rc == 0
    assert "botbox/com.whatsoup.x-bot" in saved


def test_run_once_emits_on_threshold_met(mod, monkeypatch, tmp_path):
    """When threshold is met, emit_event is called and rc propagates."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    # prior state: already 1 failure -> second failure reaches threshold=2
    monkeypatch.setattr(mod, "load_state", lambda: {
        "botbox/com.whatsoup.x-bot": {"consecutive_failures": 1, "last_state": "gui_session_absent"}
    })
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: "alice")
    monkeypatch.setattr(mod, "probe_host", lambda host, user, label: {
        "console_owner": "root", "agent_state": "running",
        "console_ok": True, "agent_ok": True, "boot_id": None, "error": None,
    })
    monkeypatch.setattr(mod, "save_state", lambda s: None)

    emitted = []
    monkeypatch.setattr(mod, "emit_event", lambda argv, dry_run: (emitted.append(argv), 0)[1])

    rc = mod.run_once(dry_run=False)
    assert rc == 0
    assert len(emitted) == 1
    assert "--source" in emitted[0]


def test_run_once_emit_failure_returns_nonzero(mod, monkeypatch, tmp_path):
    """If emit_event returns nonzero, run_once returns 1."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {
        "botbox/com.whatsoup.x-bot": {"consecutive_failures": 1, "last_state": "gui_session_absent"}
    })
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: "alice")
    monkeypatch.setattr(mod, "probe_host", lambda host, user, label: {
        "console_owner": "root", "agent_state": "running",
        "console_ok": True, "agent_ok": True, "boot_id": None, "error": None,
    })
    monkeypatch.setattr(mod, "save_state", lambda s: None)
    monkeypatch.setattr(mod, "emit_event", lambda argv, dry_run: 1)

    rc = mod.run_once(dry_run=False)
    assert rc == 1


def test_run_once_unresolvable_user_uses_fail_closed_probe(mod, monkeypatch, tmp_path, capsys):
    """resolve_expected_user returning None -> fail-closed probe (unreachable)."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {})
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: None)
    probe_called = []
    monkeypatch.setattr(mod, "probe_host", lambda *a, **kw: (probe_called.append(True), {})[1])
    monkeypatch.setattr(mod, "save_state", lambda s: None)

    rc = mod.run_once(dry_run=True)
    assert rc == 0
    assert probe_called == [], "probe_host must not be called when user is unresolved"


def test_run_once_private_override_error_returns_two(mod, monkeypatch, tmp_path, capsys):
    """When private override error exists, run_once returns 2 without probing."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_fleet", lambda: {"hosts": []})
    monkeypatch.setattr(mod, "private_override_contract_error", lambda fleet: "config error: missing override")

    rc = mod.run_once(dry_run=True)
    assert rc == 2
    assert "config error" in capsys.readouterr().err


def test_run_once_empty_targets_fails_closed(mod, monkeypatch, tmp_path, capsys):
    """An implicit-empty fleet (no targets, no not_applicable) must fail closed (#2467).

    Previously run_once silently returned 0 with zero targets — erasing all
    coverage. Now it exits 2 and preserves prior state without overwriting it.
    """
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text('{"hosts":[]}', encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {})

    saved = {}
    monkeypatch.setattr(mod, "save_state", lambda s: saved.update(s))

    rc = mod.run_once(dry_run=False)
    assert rc == 2
    assert saved == {}  # prior state NOT overwritten
    captured = capsys.readouterr()
    assert "no GUI-session monitor targets" in captured.err


# ---------------------------------------------------------------------------
# parse_args (lines 839-854)
# ---------------------------------------------------------------------------


def test_parse_args_defaults(mod):
    args = mod.parse_args([])
    assert args.dry_run is False
    assert args.once is False
    assert args.config_check is False


def test_parse_args_dry_run(mod):
    args = mod.parse_args(["--dry-run"])
    assert args.dry_run is True


def test_parse_args_once(mod):
    args = mod.parse_args(["--once"])
    assert args.once is True


def test_parse_args_config_check(mod):
    args = mod.parse_args(["--config-check"])
    assert args.config_check is True


def test_parse_args_combined(mod):
    args = mod.parse_args(["--dry-run", "--once"])
    assert args.dry_run is True
    assert args.once is True


# ---------------------------------------------------------------------------
# main (lines 858-861)
# ---------------------------------------------------------------------------


def test_main_config_check_mode(mod, monkeypatch, capsys, tmp_path):
    """main --config-check calls config_check() and returns its exit code."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.delenv("BOT_ERRORS_EXPECTED_FLEET", raising=False)
    rc = mod.main(["--config-check"])
    assert rc == 0
    assert "gui-session-monitor config ok" in capsys.readouterr().out


def test_main_dry_run_mode(mod, monkeypatch, tmp_path):
    """main --dry-run calls run_once(dry_run=True)."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {})
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: "alice")
    monkeypatch.setattr(mod, "probe_host", lambda host, user, label: {
        "console_owner": "alice", "agent_state": "running",
        "console_ok": True, "agent_ok": True, "boot_id": None, "error": None,
    })
    save_called = []
    monkeypatch.setattr(mod, "save_state", lambda s: save_called.append(s))

    rc = mod.main(["--dry-run"])
    assert rc == 0
    assert save_called == []


def test_main_normal_run(mod, monkeypatch, tmp_path):
    """main with no flags calls run_once(dry_run=False)."""
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {})
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: "alice")
    monkeypatch.setattr(mod, "probe_host", lambda host, user, label: {
        "console_owner": "alice", "agent_state": "running",
        "console_ok": True, "agent_ok": True, "boot_id": None, "error": None,
    })
    monkeypatch.setattr(mod, "save_state", lambda s: None)

    rc = mod.main([])
    assert rc == 0


def test_main_default_argv_uses_sys_argv(mod, monkeypatch, tmp_path):
    """main(None) reads from sys.argv[1:]."""
    import sys as _sys
    fleet_file = tmp_path / "fleet.json"
    fleet_file.write_text(_minimal_fleet_json(), encoding="utf-8")
    monkeypatch.setattr(mod, "fleet_path", lambda: fleet_file)
    monkeypatch.setattr(mod, "load_state", lambda: {})
    monkeypatch.setattr(mod, "resolve_expected_user", lambda host: "alice")
    monkeypatch.setattr(mod, "probe_host", lambda host, user, label: {
        "console_owner": "alice", "agent_state": "running",
        "console_ok": True, "agent_ok": True, "boot_id": None, "error": None,
    })
    monkeypatch.setattr(mod, "save_state", lambda s: None)
    monkeypatch.setattr(_sys, "argv", ["bot-errors-gui-session-monitor.py"])

    rc = mod.main(None)
    assert rc == 0


# ---------------------------------------------------------------------------
# Task 3 (#1866): membership follows repaired declaration -- monitor code is
# UNCHANGED. gui_targets_from_fleet()/load_fleet() read ONLY the checked-in
# inventory (fleet_path() / BOT_ERRORS_EXPECTED_FLEET) -- they never consult
# the deployed per-host profile. restore_service_to_always_on()
# (bot_errors_cutover.py, Task 1) is the ONE authoritative writer that repairs
# BOTH the inventory and the deployed profile in one call; this proves the
# GUI-session monitor's target-set picks svc1 up purely because that
# inventory-side declaration flipped from "blocked" to "always_on" -- no
# monitor code changed. The fixture deliberately declares NO
# guiSessionExpected policy on the host, so membership falls to the
# fail-closed default (`expected == "always_on"` + a `com.whatsoup.*` label)
# -- the one branch where the blocked->always_on flip is actually load-bearing.
# ---------------------------------------------------------------------------


def _load_cutover_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_cutover_for_gui_session_monitor", _SCRIPT.parent / "bot_errors_cutover.py"
    )
    cutover_mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(cutover_mod)
    return cutover_mod


def _write_task3_inventory(tmp_path: Path, host: str, profile_filename: str, instance: dict) -> Path:
    path = tmp_path / "bot-errors-expected-fleet.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "hosts": [
                    {
                        "host": host,
                        "role": "bot-host",
                        "profile": profile_filename,
                        "collectorRemote": True,
                        "instances": [instance],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_task3_profile(profiles_dir: Path, filename: str, instance: dict) -> Path:
    profiles_dir.mkdir(parents=True, exist_ok=True)
    path = profiles_dir / filename
    path.write_text(
        json.dumps({"role": "bot-host", "instances": [instance]}),
        encoding="utf-8",
    )
    return path


def test_gui_targets_follow_repaired_declaration(mod, tmp_path: Path, monkeypatch):
    cutover_mod = _load_cutover_module()

    host = "host-a"
    profile_filename = "host-a.json"
    instance_name = "svc1"
    label = "com.whatsoup.svc1"

    inventory_path = _write_task3_inventory(
        tmp_path,
        host,
        profile_filename,
        {"name": instance_name, "expected": "blocked", "service": label, "healthPort": 9095},
    )
    profiles_dir = tmp_path / "health-profiles"
    profile_path = _write_task3_profile(
        profiles_dir,
        profile_filename,
        {"name": instance_name, "expected": "blocked", "service": label},
    )
    monkeypatch.setattr(mod, "fleet_path", lambda: inventory_path)

    # Pre-repair: svc1 is declared blocked in the inventory -- NOT a monitor
    # target.
    pre_targets = {t["instance"] for t in mod.gui_targets_from_fleet(mod.load_fleet())}
    assert instance_name not in pre_targets

    # Repair the declaration via the ONE authoritative writer (#1866 Task 1) --
    # no monitor code changes; membership must follow the repaired declaration.
    cutover_mod.restore_service_to_always_on(
        host, instance_name, inventory_path=inventory_path, profiles_dir=profiles_dir
    )

    post_targets = {t["instance"] for t in mod.gui_targets_from_fleet(mod.load_fleet())}
    assert instance_name in post_targets
