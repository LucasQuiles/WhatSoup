"""Email fallback must never escalate test-provenance / test-leak events, and
must never be run from a test sandbox -- but it MUST still fire for genuine
alerts.

2026-08-28: a pytest-fixture dead-letter (dispatch log under a Linux
``pytest-of-<user>`` basetemp, synthetic machine name, a REAL instance label)
was delivered to the operator as a real critical email through the F5 email
fallback. The queue path already suppresses test-provenance events; the email
fallback applied no such gate.

#3404: the first gate scanned the POST-injection event for ``/pytest-of-<user>/``
and re-ran the global test-leak scan on it. Two false blocks followed: a genuine
alert whose evidence merely mentioned an orphaned ``/tmp/pytest-of-*`` directory
dead-lettered silently, and any dispatcher whose state root sat under a macOS
``$TMPDIR`` blocked every email because its own injected ``dispatchLog`` path
matched. The gate now evaluates test-leak on the AS-CLAIMED event and binds the
test-root rule to the state directory the dispatcher was launched with.
"""
from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = ["BOT_ERRORS_STATE_DIR", "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS", "BOT_ERRORS_TEST_LEAK_PATH_PATTERNS"]

_CLEAN_STATE_DIR = "/tmp/unused-state-dir-for-pattern-test"
_PYTEST_BASETEMP_STATE_DIR = "/srv/whatsoup/tmp/pytest-of-user/pytest-4/testdeadlettersavesabsorbe0/state"
_MACOS_VITEST_SANDBOX_STATE_DIR = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/whatsoup-vitest-bot-errors/0123456789ab.1"


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {key: os.environ.get(key) for key in _ENV_KEYS}
    yield
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _load_module(env: dict[str, str]):
    for key, value in env.items():
        os.environ[key] = value
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_email_provenance", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _event(**overrides: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schemaVersion": 1,
        "id": "evt-email-provenance",
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health-fail",
        "instance": "eh-bot",
        "machine": "relay-deadletter-hub",
        "summary": "daily health failing",
        "evidence": "health eh-bot: 500 status=unhealthy",
        "createdAt": "2026-08-28T23:39:19Z",
        "delivery": {"attempts": 3, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    event.update(overrides)
    return event


def _tmp_retention_alert() -> dict[str, Any]:
    # The #3404 scenario: a real alert about orphaned pytest temp directories.
    # Not a global test leak (WhatsApp delivers it), so email must be allowed.
    return _event(
        id="evt-tmp-retention",
        source="process-tmp-retention",
        machine="relay-host",
        summary="orphaned pytest temp dirs accumulating",
        evidence="found stale /tmp/pytest-of-runner/pytest-12/ dirs (retention breach)",
    )


def _write_event(paths: dict[str, Path], event: dict[str, Any]) -> Path:
    event_path = paths["outbox"] / f"20260828233919.eh-bot.daily-health-fail.{event['id']}.json"
    event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
    event_path.chmod(0o600)
    return event_path


def _executable_fallback(tmp_path: Path) -> str:
    script = tmp_path / "email-fallback.sh"
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o755)
    return str(script)


def _dispatch_log_records(paths: dict[str, Path]) -> list[dict[str, Any]]:
    log_path = paths["logs"] / "dispatch.jsonl"
    if not log_path.exists():
        return []
    return [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]


def _dispatch_log_types(paths: dict[str, Path]) -> list[str]:
    return [record.get("type") for record in _dispatch_log_records(paths)]


@contextlib.contextmanager
def _state_root_outside_test_roots() -> Iterator[Path]:
    # Every pytest tmp root is a recognised test root by design (that is the
    # 2026-08-28 leak's tell), so the positive email path needs a state dir
    # OUTSIDE any of them; it is created under $HOME and removed.
    state_root = Path.home() / f".bot-errors-email-gate-test-{uuid.uuid4().hex}"
    try:
        yield state_root
    finally:
        shutil.rmtree(state_root, ignore_errors=True)


# --------------------------------------------------------------------------
# Gate unit behaviour
# --------------------------------------------------------------------------


def test_launched_state_dir_under_pytest_basetemp_blocks_without_widening_global_patterns():
    # The basetemp rule is scoped to the email gate AND bound to the dispatcher's
    # own state directory: a global TEST_LEAK pattern would match the suite's own
    # tmp_path roots on Linux CI and drop fixture events in unrelated tests.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _PYTEST_BASETEMP_STATE_DIR})
    event = _event()
    assert mod.event_is_test_leak(event) is False
    assert mod.matched_test_leak_pattern({"evidence": _PYTEST_BASETEMP_STATE_DIR}) is None
    assert mod.matched_state_dir_test_root_pattern(_PYTEST_BASETEMP_STATE_DIR) == r"/pytest-of-[^/]+/"
    assert mod.email_fallback_blocked_reason(event) == "test_state_dir"
    assert mod.email_fallback_blocked_reason(event, state_dir=Path(_PYTEST_BASETEMP_STATE_DIR)) == "test_state_dir"


def test_genuine_alert_mentioning_pytest_dir_is_not_blocked():
    # #3404 red: with a clean state dir, a real alert whose EVIDENCE mentions a
    # /tmp/pytest-of-* path must reach the email fallback (previously "test_leak").
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    event = _tmp_retention_alert()
    assert mod.event_is_test_leak(event) is False
    assert mod.email_fallback_blocked_reason(event) is None
    assert mod.email_fallback_blocked_reason(event, state_dir=Path(_CLEAN_STATE_DIR)) is None


def test_injected_dispatch_log_path_does_not_block_email_fallback():
    # #3404: the dispatcher stamps diagnostics.dispatchLog (under its state
    # root) into the event before delivery. With a state root under a macOS
    # $TMPDIR that path matches the global /var/folders/.../T/ leak pattern, so
    # the POST-injection event reads as a leak -- but the as-claimed event is
    # clean and the launched state dir here is not a test root.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    injected = _event(diagnostics={"dispatchLog": _MACOS_VITEST_SANDBOX_STATE_DIR + "/logs/dispatch.jsonl"})
    assert mod.event_is_test_leak(injected) is True, "scenario precondition: injected path is a leak pattern"
    assert mod.email_fallback_blocked_reason(injected) is None

    as_claimed = mod.as_claimed_event(injected)
    assert as_claimed is not injected
    assert "dispatchLog" not in as_claimed["diagnostics"]
    assert injected["diagnostics"] == {"dispatchLog": _MACOS_VITEST_SANDBOX_STATE_DIR + "/logs/dispatch.jsonl"}
    assert mod.event_is_test_leak(as_claimed) is False


def test_as_claimed_event_preserves_producer_diagnostics_and_passes_through_untouched_events():
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    untouched = _event()
    assert mod.as_claimed_event(untouched) is untouched
    producer_only = _event(diagnostics={"omitDispatchLogInMessage": True})
    assert mod.as_claimed_event(producer_only) is producer_only
    mixed = _event(diagnostics={"omitDispatchLogInMessage": True, "dispatchLog": "/x/logs/dispatch.jsonl"})
    assert mod.as_claimed_event(mixed)["diagnostics"] == {"omitDispatchLogInMessage": True}


def test_as_claimed_test_leak_is_still_blocked_with_a_clean_state_dir():
    # event_is_test_leak semantics are unchanged: a producer-claimed fixture
    # path is a leak wherever the dispatcher runs.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    leaked = _event(evidence="authDir: /tmp/wa-test-auth/creds.json unreadable")
    assert mod.event_is_test_leak(leaked) is True
    assert mod.email_fallback_blocked_reason(leaked) == "test_leak"


def test_blocked_reason_recognises_provenance_flag_and_clean_events():
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    flagged = _event(runtime={"provenance": {"test": True}})
    assert mod.email_fallback_blocked_reason(flagged) == "test_provenance"
    assert mod.email_fallback_blocked_reason(_event()) is None


@pytest.mark.parametrize(
    "state_dir",
    [
        _PYTEST_BASETEMP_STATE_DIR,
        _MACOS_VITEST_SANDBOX_STATE_DIR,
        "/tmp/whatsoup-vitest-bot-errors/0123456789ab.2",
        "/tmp/wa-test-auth/state",
    ],
)
def test_launched_state_dir_under_any_recognised_test_root_blocks(state_dir: str):
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    assert mod.matched_state_dir_test_root_pattern(state_dir) is not None
    assert mod.email_fallback_blocked_reason(_event(), state_dir=state_dir) == "test_state_dir"
    assert mod.email_fallback_blocked_reason(_event(), state_dir=Path(state_dir)) == "test_state_dir"


@pytest.mark.parametrize(
    "state_dir",
    [
        _CLEAN_STATE_DIR,
        str(Path.home() / ".local/state/bot-errors"),
        "/srv/whatsoup/state/bot-errors",
    ],
)
def test_launched_state_dir_outside_test_roots_does_not_block(state_dir: str):
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    assert mod.matched_state_dir_test_root_pattern(state_dir) is None
    assert mod.email_fallback_blocked_reason(_event(), state_dir=state_dir) is None


def test_state_dir_binding_honours_operator_test_leak_patterns():
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR,
        "BOT_ERRORS_TEST_LEAK_PATH_PATTERNS": r"/opt/ci-sandbox/",
    })
    assert mod.matched_state_dir_test_root_pattern("/opt/ci-sandbox/run-7/state") == r"/opt/ci-sandbox/"
    assert mod.email_fallback_blocked_reason(_event(), state_dir="/opt/ci-sandbox/run-7/state") == "test_state_dir"


# --------------------------------------------------------------------------
# process_one integration
# --------------------------------------------------------------------------


def test_test_provenance_event_never_reaches_email_fallback(tmp_path: Path):
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    event_path = _write_event(paths, _event(runtime={"provenance": {"test": True}}))

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
         patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
         patch.object(mod, "email_fallback", return_value=True) as fallback:
        mod.process_one(event_path, paths)

    assert fallback.call_count == 0
    assert "email_fallback_test_provenance_suppressed" in _dispatch_log_types(paths)
    outbox_files = list(paths["outbox"].glob("*.json"))
    assert outbox_files, "event must be requeued, not delivered by email"
    delivery = json.loads(outbox_files[0].read_text()).get("delivery", {})
    assert delivery.get("emailFallback") == "not_attempted"


def test_dispatcher_launched_under_pytest_root_never_reaches_email_fallback(tmp_path: Path):
    # A dispatcher whose OWN state lives under a pytest basetemp is a test run
    # and must not email, even for an event that is clean in every field.
    #
    # The ``pytest-of-<user>`` segment is CONSTRUCTED rather than inherited from
    # the ambient tmp_path: pytest invoked with an explicit ``--basetemp`` has no
    # such segment in its roots, which would make the precondition below
    # vacuously false and the whole test a no-op.
    state_dir = tmp_path / "pytest-of-runner" / "pytest-1" / "testrun0" / "state"
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    # On this host the ambient basetemp may already match a different rule
    # (macOS $TMPDIR), so the precondition is `is not None`; that the
    # constructed segment ALONE suffices -- which is what keeps the test honest
    # under `--basetemp` on a clean root -- is pinned on a synthetic path.
    assert mod.matched_state_dir_test_root_pattern(state_dir) is not None
    assert mod.matched_state_dir_test_root_pattern(
        "/srv/clean/pytest-of-runner/pytest-1/testrun0/state"
    ) == r"/pytest-of-[^/]+/"
    assert mod.email_fallback_blocked_reason(_event(), state_dir=state_dir) == "test_state_dir"
    paths = mod.setup_dirs()
    event = _event()
    assert mod.event_is_test_leak(event) is False
    event_path = _write_event(paths, event)

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
         patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
         patch.object(mod, "email_fallback", return_value=True) as fallback:
        mod.process_one(event_path, paths)

    assert fallback.call_count == 0
    # The suppression IS recorded; the reason string is not. Controller-log
    # details are projected onto a metadata-only allowlist
    # (lib/controller_log.py: metadata_only_controller_details), and no gate
    # reason -- "test_provenance", "test_leak", or "test_state_dir" -- is in it,
    # so the durable record carries the attempt count only. That is unchanged
    # from main; the reason itself is pinned at the unit level above.
    suppressed = [r for r in _dispatch_log_records(paths) if r.get("type") == "email_fallback_test_provenance_suppressed"]
    assert len(suppressed) == 1, suppressed
    assert suppressed[0].get("details", {}).get("attempts", 0) >= 3, suppressed[0]


def test_clean_event_still_uses_email_fallback(tmp_path: Path):
    with _state_root_outside_test_roots() as state_root:
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_root),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        paths = mod.setup_dirs()
        event_path = _write_event(paths, _event())

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
             patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
             patch.object(mod, "email_fallback", return_value=True) as fallback:
            mod.process_one(event_path, paths)

        assert fallback.call_count == 1


def test_genuine_alert_mentioning_pytest_dir_reaches_email_fallback(tmp_path: Path):
    # #3404 end-to-end: the process-tmp-retention alert is NOT dead-lettered
    # silently; with WhatsApp down and a production-like state dir it escalates.
    with _state_root_outside_test_roots() as state_root:
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_root),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        paths = mod.setup_dirs()
        event_path = _write_event(paths, _tmp_retention_alert())

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
             patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
             patch.object(mod, "email_fallback", return_value=True) as fallback:
            mod.process_one(event_path, paths)

        assert fallback.call_count == 1
        assert "email_fallback_test_provenance_suppressed" not in _dispatch_log_types(paths)
