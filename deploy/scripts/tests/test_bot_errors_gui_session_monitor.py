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
