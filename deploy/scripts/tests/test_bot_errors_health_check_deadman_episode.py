"""Falsifiers for #2425: deadman episode lifecycle with delivery-proven advancement.

The deadman must advance sent count / cooldown only on an accepted delivery,
retain durable pending onset/recovery state when every channel rejects, and
model one supervision episode with stable member identities instead of keying
incidents by a hash of the raw problem strings.

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents
normal import) and drives ``deadman()`` end-to-end against real state files
under a tmp state root, with typed channel fakes for direct WhatsApp + email.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check_deadman_episode", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class DirectChannel:
    """send_direct fake: 'accept' returns, 'reject' raises, 'timeout' raises TimeoutError."""

    def __init__(self) -> None:
        self.behavior = "accept"
        self.calls: list[str] = []

    def __call__(self, text: str) -> None:
        self.calls.append(text)
        if self.behavior == "accept":
            return
        if self.behavior == "timeout":
            raise TimeoutError("synthetic direct timeout")
        raise RuntimeError("send_message returned error: synthetic rejection")


class EmailChannel:
    """email_fallback_outcome fake returning a fixed typed token."""

    def __init__(self) -> None:
        self.token = "rejected"
        self.calls: list[str] = []

    def __call__(self, subject: str, body: str) -> str:
        self.calls.append(subject)
        return self.token


@pytest.fixture()
def env(monkeypatch, tmp_path: Path) -> SimpleNamespace:
    mod = _load_module()
    monkeypatch.setattr(mod, "state_root", lambda: tmp_path)

    # Fresh dispatcher state file: real (recent) mtime with a small fake epoch
    # keeps state_age at 0, and no cycleCompletedAt inside restart grace means
    # no staleness problem unless a test writes an old cycleCompletedAt.
    dispatcher_state = tmp_path / mod.DISPATCHER_STATE
    dispatcher_state.write_text("{}")

    socket_file = tmp_path / "personal.sock"
    socket_file.write_text("")
    monkeypatch.setattr(mod, "SOCKET_PATH", str(socket_file))

    svc = {"status": "active"}
    monkeypatch.setattr(mod, "service_is_active", lambda _service: svc["status"])
    monkeypatch.setattr(mod, "service_restart_ages", lambda _service: (600, 600))

    clock = {"now": 1_000}
    monkeypatch.setattr(mod, "current_epoch", lambda: clock["now"])

    direct = DirectChannel()
    monkeypatch.setattr(mod, "send_direct", direct)
    email = EmailChannel()
    monkeypatch.setattr(mod, "email_fallback_outcome", email)

    def run() -> int:
        return mod.deadman(max_state_age=180, restart_grace=30, cooldown_seconds=300)

    def state() -> dict:
        return json.loads((tmp_path / "deadman-state.json").read_text(encoding="utf-8"))

    def episode() -> dict:
        record = state().get("episode")
        assert isinstance(record, dict), "episode record must be persisted"
        return record

    def set_service_problem(active: bool) -> None:
        svc["status"] = "inactive" if active else "active"

    def set_socket_problem(active: bool) -> None:
        target = tmp_path / ("missing.sock" if active else "personal.sock")
        monkeypatch.setattr(mod, "SOCKET_PATH", str(target))

    def advance(seconds: int) -> None:
        clock["now"] += seconds

    return SimpleNamespace(
        mod=mod,
        tmp_path=tmp_path,
        direct=direct,
        email=email,
        run=run,
        state=state,
        episode=episode,
        set_service_problem=set_service_problem,
        set_socket_problem=set_socket_problem,
        advance=advance,
        clock=clock,
        dispatcher_state=dispatcher_state,
    )


# ===========================================================================
# Onset delivery-proven advancement
# ===========================================================================

def test_onset_all_channels_rejected_leaves_pending_and_consumes_no_cooldown(env):
    env.set_service_problem(True)
    env.direct.behavior = "reject"
    env.email.token = "rejected"

    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "pending"
    assert onset["sentCount"] == 0
    assert not onset.get("lastAcceptedAtEpoch")
    assert onset["attemptCount"] == 1
    assert onset["lastAttempt"]["direct_whatsapp"] == "failed"
    assert onset["lastAttempt"]["email_fallback"] == "rejected"

    # A fully-failed onset must not start cooldown: the next run retries the
    # channels instead of suppressing.
    env.advance(60)
    assert env.run() == 2
    assert len(env.direct.calls) == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "pending"
    assert onset["attemptCount"] == 2
    assert onset["sentCount"] == 0


def test_accepted_onset_after_pending_advances_exactly_once_across_restart(env):
    env.set_service_problem(True)
    env.direct.behavior = "reject"
    env.email.token = "rejected"
    assert env.run() == 2

    env.direct.behavior = "accept"
    env.advance(60)
    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "delivered"
    assert onset["sentCount"] == 1
    assert onset["deliveredKind"] == "accepted"
    assert onset["attemptCount"] == 0

    # Same problem inside cooldown: suppressed, no channel attempt, count holds.
    env.advance(60)
    calls_before = len(env.direct.calls)
    assert env.run() == 2
    assert len(env.direct.calls) == calls_before
    onset = env.episode()["onset"]
    assert onset["sentCount"] == 1
    assert onset["suppressed"] == 1


def test_delivered_onset_repages_after_cooldown_expiry(env):
    env.set_service_problem(True)
    assert env.run() == 2
    assert env.episode()["onset"]["sentCount"] == 1

    env.advance(301)
    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["sentCount"] == 2
    assert onset["suppressed"] == 0
    assert len(env.direct.calls) == 2


# ===========================================================================
# Recovery delivery-proven resolution
# ===========================================================================

def test_recovery_all_channels_rejected_keeps_incident_open(env):
    env.set_service_problem(True)
    assert env.run() == 2

    env.set_service_problem(False)
    env.direct.behavior = "reject"
    env.email.token = "rejected"
    env.advance(60)
    assert env.run() == 0
    record = env.episode()
    assert record["status"] == "open"
    assert record["recovery"]["state"] == "pending"
    assert record["recovery"]["attemptCount"] == 1

    # Retries boundedly on the next clean run instead of forgetting.
    env.advance(60)
    assert env.run() == 0
    assert env.episode()["recovery"]["attemptCount"] == 2


def test_accepted_recovery_resolves_exactly_once(env):
    env.set_service_problem(True)
    assert env.run() == 2

    env.set_service_problem(False)
    env.direct.behavior = "reject"
    env.email.token = "rejected"
    env.advance(60)
    assert env.run() == 0
    assert env.episode()["status"] == "open"

    env.direct.behavior = "accept"
    env.advance(60)
    assert env.run() == 0
    state = env.state()
    assert state.get("episode") in (None, {})
    resolved = state.get("lastResolvedEpisode")
    assert isinstance(resolved, dict)
    assert resolved["status"] == "resolved"

    calls_before = len(env.direct.calls)
    env.advance(60)
    assert env.run() == 0
    assert len(env.direct.calls) == calls_before


# ===========================================================================
# Stable episode identity and membership revisions
# ===========================================================================

def test_membership_addition_keeps_stable_episode(env):
    env.set_service_problem(True)
    assert env.run() == 2
    first = env.episode()
    episode_id = first["episodeId"]
    first_revision = first["revision"]

    # A second contributor joins the same supervision episode; the new
    # information pages despite the onset cooldown.
    env.set_socket_problem(True)
    env.advance(60)
    assert env.run() == 2
    record = env.episode()
    assert record["episodeId"] == episode_id
    assert record["revision"] > first_revision
    assert set(record["members"]) == {"service_inactive", "socket_missing"}
    assert len(env.direct.calls) == 2
    assert record["onset"]["sentCount"] == 2


def test_stale_age_churn_does_not_fragment_identity(env):
    env.dispatcher_state.write_text(json.dumps({"cycleCompletedAt": env.mod.epoch_to_iso(500)}))
    assert env.run() == 2
    record = env.episode()
    episode_id = record["episodeId"]
    assert set(record["members"]) == {"cycle_stale"}
    revision = record["revision"]

    # The stale age grows every run; the member identity and episode must not.
    env.advance(60)
    assert env.run() == 2
    record = env.episode()
    assert record["episodeId"] == episode_id
    assert record["revision"] == revision
    assert len(env.direct.calls) == 1
    assert record["onset"]["suppressed"] == 1


def test_partial_recovery_closes_only_recovered_members(env):
    env.set_service_problem(True)
    env.set_socket_problem(True)
    assert env.run() == 2

    env.set_socket_problem(False)
    env.advance(60)
    assert env.run() == 2
    record = env.episode()
    assert record["status"] == "open"
    assert record["members"]["socket_missing"]["status"] == "recovered"
    assert record["members"]["service_inactive"]["status"] == "active"
    assert "recovery" not in record


def test_full_recovery_emits_single_aggregate_notice(env):
    env.set_service_problem(True)
    env.set_socket_problem(True)
    assert env.run() == 2

    env.set_socket_problem(False)
    env.advance(60)
    assert env.run() == 2

    env.set_service_problem(False)
    env.advance(60)
    onset_calls = len(env.direct.calls)
    assert env.run() == 0
    recovery_calls = len(env.direct.calls) - onset_calls
    assert recovery_calls == 1
    assert env.state().get("lastResolvedEpisode", {}).get("status") == "resolved"


# ===========================================================================
# Distinct durable delivery outcomes
# ===========================================================================

def test_direct_timeout_is_durable_outcome_unknown_and_does_not_advance(env):
    env.set_service_problem(True)
    env.direct.behavior = "timeout"
    env.email.token = "rejected"
    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "pending"
    assert onset["sentCount"] == 0
    assert onset["lastAttempt"]["direct_whatsapp"] == "outcome_unknown"


def test_email_non_accepted_tokens_are_durable_and_do_not_advance(env):
    env.set_service_problem(True)
    env.direct.behavior = "reject"

    env.email.token = "rejected"
    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "pending"
    assert onset["lastAttempt"]["email_fallback"] == "rejected"

    # Each retry durably overwrites lastAttempt with the newest token while
    # the onset stays pending and unadvanced.
    env.advance(30)
    env.email.token = "timed_out"
    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "pending"
    assert onset["lastAttempt"]["email_fallback"] == "timed_out"

    env.advance(30)
    env.email.token = "unavailable"
    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "pending"
    assert onset["sentCount"] == 0
    assert onset["lastAttempt"]["email_fallback"] == "unavailable"


def test_email_accepted_unconfirmed_advances_with_explicit_kind(env):
    env.set_service_problem(True)
    env.direct.behavior = "reject"
    env.email.token = "accepted_unconfirmed"
    assert env.run() == 2
    onset = env.episode()["onset"]
    assert onset["state"] == "delivered"
    assert onset["deliveredKind"] == "accepted_unconfirmed"
    assert onset["sentCount"] == 1


def test_email_fallback_outcome_tokens(monkeypatch, tmp_path: Path):
    mod = _load_module()

    monkeypatch.setattr(mod, "EMAIL_FALLBACK", str(tmp_path / "absent-fallback"))
    assert mod.email_fallback_outcome("s", "b") == "unavailable"

    script = tmp_path / "email-fallback"
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o755)
    monkeypatch.setattr(mod, "EMAIL_FALLBACK", str(script))
    assert mod.email_fallback_outcome("s", "b") == "accepted_unconfirmed"
    assert mod.email_fallback("s", "b") is True

    script.write_text("#!/bin/sh\nexit 3\n")
    assert mod.email_fallback_outcome("s", "b") == "rejected"
    assert mod.email_fallback("s", "b") is False

    import subprocess as _subprocess

    def raise_timeout(*_args, **_kwargs):
        raise _subprocess.TimeoutExpired(cmd="email-fallback", timeout=20)

    monkeypatch.setattr(mod.subprocess, "run", raise_timeout)
    assert mod.email_fallback_outcome("s", "b") == "timed_out"
    assert mod.email_fallback("s", "b") is False


# ===========================================================================
# Bounded retry
# ===========================================================================

def test_pending_retry_is_bounded_and_resets_on_membership_revision(env):
    env.set_service_problem(True)
    env.direct.behavior = "reject"
    env.email.token = "rejected"

    limit = env.mod.DEADMAN_PENDING_MAX_ATTEMPTS
    for _ in range(limit):
        assert env.run() == 2
        env.advance(30)
    assert len(env.direct.calls) == limit

    assert env.run() == 2
    assert len(env.direct.calls) == limit
    assert env.episode()["onset"]["state"] == "exhausted"

    # New information (a membership revision) re-arms the attempt budget.
    env.set_socket_problem(True)
    env.advance(30)
    assert env.run() == 2
    assert len(env.direct.calls) == limit + 1
    onset = env.episode()["onset"]
    assert onset["state"] == "pending"
    assert onset["attemptCount"] == 1


# ===========================================================================
# Crash boundaries: accepted send, then crash before persist
# ===========================================================================

def test_crash_after_accepted_onset_before_save_converges(env, monkeypatch):
    env.set_service_problem(True)
    real_save = env.mod.save_deadman_state

    def crashing_save(_state: dict) -> None:
        raise OSError("synthetic crash before persist")

    monkeypatch.setattr(env.mod, "save_deadman_state", crashing_save)
    with pytest.raises(OSError):
        env.run()
    assert len(env.direct.calls) == 1
    assert not (env.tmp_path / "deadman-state.json").exists()

    # After restart the state is still unsent; at-least-once delivery re-sends
    # and the accepted onset is recorded exactly once.
    monkeypatch.setattr(env.mod, "save_deadman_state", real_save)
    env.advance(60)
    assert env.run() == 2
    assert len(env.direct.calls) == 2
    assert env.episode()["onset"]["sentCount"] == 1


def test_crash_after_accepted_recovery_before_save_converges(env, monkeypatch):
    env.set_service_problem(True)
    assert env.run() == 2
    env.set_service_problem(False)

    real_save = env.mod.save_deadman_state
    saved_once = {"armed": True}

    def crashing_save(state: dict) -> None:
        if saved_once["armed"]:
            saved_once["armed"] = False
            raise OSError("synthetic crash before persist")
        real_save(state)

    monkeypatch.setattr(env.mod, "save_deadman_state", crashing_save)
    env.advance(60)
    with pytest.raises(OSError):
        env.run()

    env.advance(60)
    assert env.run() == 0
    state = env.state()
    assert state.get("episode") in (None, {})
    assert state.get("lastResolvedEpisode", {}).get("status") == "resolved"


# ===========================================================================
# Evidence hygiene
# ===========================================================================

def test_notification_and_state_contain_no_raw_problem_text_or_paths(env):
    env.set_service_problem(True)
    env.set_socket_problem(True)
    assert env.run() == 2

    text = env.direct.calls[0]
    assert "service_inactive" in text
    assert "socket_missing" in text
    forbidden = (
        str(env.tmp_path),
        "is not active (status=",
        "personal socket missing:",
        "dispatcher state stale",
        "dispatcher state missing:",
    )
    for needle in forbidden:
        assert needle not in text, f"notification leaked raw evidence: {needle!r}"

    episode_bytes = json.dumps(env.episode())
    for needle in forbidden:
        assert needle not in episode_bytes, f"state leaked raw evidence: {needle!r}"


# ===========================================================================
# Legacy v1 state adoption
# ===========================================================================

def test_legacy_v1_open_incidents_adopted_not_orphaned(env):
    legacy = {
        "schemaVersion": 1,
        "incidents": {
            "aaaa1111": {
                "status": "open",
                "problems": ["legacy problem text"],
                "sentCount": 1,
                "lastSentAtEpoch": 900,
                "suppressed": 2,
            },
            "bbbb2222": {
                "status": "resolved",
                "problems": [],
            },
        },
    }
    legacy_path = env.tmp_path / "deadman-state.json"
    legacy_path.write_text(json.dumps(legacy))
    # The durable publisher refuses to replace non-private files; a real
    # pre-upgrade state file was written 0600 by the same machinery.
    legacy_path.chmod(0o600)

    assert env.run() == 0
    assert len(env.direct.calls) == 1
    state = env.state()
    assert state["incidents"]["aaaa1111"]["status"] == "resolved"
    assert state["incidents"]["bbbb2222"]["status"] == "resolved"
    assert state.get("lastResolvedEpisode", {}).get("status") == "resolved"
