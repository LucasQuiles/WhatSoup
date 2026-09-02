"""Email fallback must never escalate test-provenance / test-leak events, and
must never be run from a test sandbox -- but it MUST still fire for genuine
alerts.

2026-08-28: a pytest-fixture dead-letter (dispatch log under a Linux
``pytest-of-<user>`` basetemp, synthetic machine name, a REAL instance label)
was delivered to the operator as a real critical email through the F5 email
fallback. The queue path already suppresses test-provenance events; the email
fallback applied no such gate.

#3404: the first gate scanned the POST-injection event for ``/pytest-of-<user>/``
and re-ran the global test-leak scan on it, so a genuine alert whose evidence
merely mentioned an orphaned ``/tmp/pytest-of-*`` directory dead-lettered
silently. The gate now evaluates test-leak on the AS-CLAIMED event and binds the
test-root rule to the state directory the dispatcher was launched with. That
false block is closed.

CORRECTION (#3404 follow-up). An earlier version of this docstring, and the
commit message that landed it, also listed the macOS ``$TMPDIR`` state root as a
false block that had been fixed. It was NOT fixed. It was RELABELLED, and in one
dimension it is now WIDER:

* ``matched_state_dir_test_root_pattern`` applies the whole
  ``TEST_LEAK_PATTERNS`` set to the state directory, and that set contains
  ``/var/folders/.../T/``. A dispatcher whose state root sits under a macOS
  ``$TMPDIR`` still blocks every email fallback -- now deliberately, under the
  distinct reason ``test_state_dir`` rather than ``test_leak``.
* With ``diagnostics.omitDispatchLogInMessage: true`` no ``$TMPDIR`` string ever
  reached the event, so that configuration used to escalate by email. It is now
  blocked on the state directory alone. Measured, same clean payload, state root
  ``/var/folders/aa/bb1234567890/T/bot-errors``: base ``None``, here
  ``test_state_dir``.

The new semantics are the intended ones -- what makes a run a test run is where
its own state lives, not what its payload mentions -- but an operator running a
production dispatcher out of ``$TMPDIR`` loses the email fallback, so the
widening is recorded here rather than described as a fix.
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

# Transport failure texts produced VERBATIM by shipped code, both carrying a path
# that matches a global test-leak pattern. json_rpc_call raises
# RuntimeError(f"socket missing: {socket_path}") and send_whatsapp raises
# RuntimeError(f"send_message returned error: {result}"); process_one funnels
# either into delivery.lastError via mark_failure, three statements before the
# email gate runs. Neither is producer-claimed text.
_SOCKET_MISSING_ERROR = (
    "socket missing: /var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/whatsoup/eh-bot/whatsoup.sock"
)
_BRIDGE_ERROR_WITH_FIXTURE_PATH = (
    "send_message returned error: {'isError': True, 'authDir': '/tmp/wa-test-auth/creds.json'}"
)


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


def test_dispatcher_owned_text_reads_as_a_leak_while_the_claimed_payload_does_not():
    """Fixture-validity check for the two #3404 regression scenarios.

    Pins the premise the integration tests rest on: the SAME alert is clean as
    the producer claimed it, yet reads as a test leak once the dispatcher has
    written its own text into it -- diagnostics.dispatchLog on every event, and
    delivery.lastError once the transport fails.

    It deliberately does NOT assert that the gate ignores the injected text, and
    could not: the gate now trusts its caller to hand it the claimed payload, so
    that property lives at the call site, not in the function. It is covered
    end-to-end by test_transport_error_path_in_lastError_does_not_block_email_fallback.
    """
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    claimed = _event()
    assert mod.event_is_test_leak(claimed) is False
    assert mod.email_fallback_blocked_reason(claimed, state_dir=Path(_CLEAN_STATE_DIR)) is None

    injected = _event(diagnostics={"dispatchLog": _MACOS_VITEST_SANDBOX_STATE_DIR + "/logs/dispatch.jsonl"})
    assert mod.event_is_test_leak(injected) is True, "dispatchLog injection alone reads as a leak"
    failed = mod.mark_failure(_event(), _SOCKET_MISSING_ERROR)
    assert mod.event_is_test_leak(failed) is True, "transport error text alone reads as a leak"


def test_as_claimed_test_leak_is_still_blocked_with_a_clean_state_dir():
    """Pins FUNCTION semantics, not route coverage.

    event_is_test_leak semantics are unchanged: a producer-claimed fixture path
    is a leak wherever the dispatcher runs. This branch is deliberately
    unreachable through ``process_one`` -- the B2 check at the claim already
    dropped such events as ``test_leak_dropped`` long before F5 -- so no
    integration test can cover it. It is kept as defence in depth for any future
    caller of the gate, and as an anti-regression pin on the shared detector.
    """
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


@pytest.mark.parametrize(
    ("label", "transport_error"),
    [
        ("socket_missing", _SOCKET_MISSING_ERROR),
        ("bridge_error_payload", _BRIDGE_ERROR_WITH_FIXTURE_PATH),
    ],
)
def test_transport_error_path_in_lastError_does_not_block_email_fallback(
    tmp_path: Path,
    label: str,
    transport_error: str,
) -> None:
    """A dispatcher-owned transport error must not make a genuine alert look leaked.

    The email fallback only matters when WhatsApp is already failing, and it is
    exactly then that ``process_one`` calls ``mark_failure(event, str(exc))``,
    writing the transport's own exception text into ``delivery.lastError`` three
    statements before the gate. Both texts here are produced verbatim by shipped
    code and carry a path that matches a global test-leak pattern.

    Gating on the post-injection event therefore reported ``test_leak`` for a
    clean producer payload on a production state dir, and the alert dead-lettered
    silently -- the #3404 headline reached through a second field. The gate reads
    the as-claimed snapshot, so the injected text cannot reach it.
    """
    with _state_root_outside_test_roots() as state_root:
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_root),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        assert mod.matched_state_dir_test_root_pattern(state_root) is None, "precondition: production-like state dir"
        claimed = _event()
        assert mod.event_is_test_leak(claimed) is False, "precondition: producer payload is clean"
        assert mod.event_is_test_leak(mod.mark_failure(_event(), transport_error)) is True, (
            "precondition: the transport error text alone reads as a leak"
        )

        paths = mod.setup_dirs()
        event_path = _write_event(paths, claimed)

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError(transport_error)), \
             patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
             patch.object(mod, "email_fallback", return_value=True) as fallback:
            mod.process_one(event_path, paths)

        assert fallback.call_count == 1, label
        assert "email_fallback_test_provenance_suppressed" not in _dispatch_log_types(paths)


def test_retried_event_carrying_a_prior_attempts_lasterror_still_escalates(tmp_path: Path):
    """The fallback fires only on a RETRY, so the snapshot sees persisted bookkeeping.

    F5, asked as: on attempt 3 the event has been through ``mark_failure``
    before, and the retry paths publish the mutated event back to the claimed
    file and move it to the outbox. Does the next attempt's B2 snapshot -- taken
    at the claim, before this pass writes anything -- therefore carry attempt
    2's ``delivery.lastError``, and can that text suppress the fallback on the
    one attempt where it fires?

    Answer: it does carry it, and it cannot suppress the fallback. The
    email-only pytest-basetemp rule is bound to the launched state directory and
    is not matched against event text at all, so a persisted transport error
    naming a pytest root reaches the gate and is ignored.

    The neighbouring case, a persisted ``lastError`` matching a GLOBAL test-leak
    pattern, used to be worse and is fixed separately in this change: see
    ``test_retry_with_a_path_bearing_transport_error_is_not_archived_as_a_leak``.
    """
    stale = "socket missing: /tmp/pytest-of-runner/pytest-12/whatsoup.sock"
    with _state_root_outside_test_roots() as state_root:
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_root),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        assert mod.matched_state_dir_test_root_pattern(state_root) is None, "precondition: production state dir"
        # The event exactly as attempt 2 left it on disk: attempts persisted,
        # and the previous transport failure's text still in lastError.
        retried = _event(delivery={
            "attempts": 2,
            "status": "queued",
            "nextAttemptAtEpoch": 0,
            "lastError": stale,
        })
        assert mod.event_is_test_leak(retried) is False, (
            "precondition: a pytest-root path is NOT a global leak pattern"
        )

        paths = mod.setup_dirs()
        event_path = _write_event(paths, retried)

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("bridge unavailable")), \
             patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
             patch.object(mod, "email_fallback", return_value=True) as fallback:
            mod.process_one(event_path, paths)

        assert fallback.call_count == 1, "attempt 3 must escalate; the retry reached the fallback threshold"
        assert "email_fallback_test_provenance_suppressed" not in _dispatch_log_types(paths)


# --------------------------------------------------------------------------
# producer_claim: the single input to every test-provenance decision
# --------------------------------------------------------------------------


def test_producer_claim_drops_dispatcher_bookkeeping_and_keeps_the_payload():
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    event = _event(
        delivery={"attempts": 2, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": _SOCKET_MISSING_ERROR},
        diagnostics={"dispatchLog": "/state/logs/dispatch.jsonl", "omitDispatchLogInMessage": True},
    )

    claim = mod.producer_claim(event)

    assert "delivery" not in claim
    assert "dispatchLog" not in claim["diagnostics"]
    # Everything the producer actually said survives, including its own
    # diagnostics keys -- stripping is scoped to what the dispatcher writes.
    assert claim["diagnostics"] == {"omitDispatchLogInMessage": True}
    for field in ("id", "eventType", "severity", "source", "instance", "machine", "summary", "evidence"):
        assert claim[field] == event[field]
    # Independent copy: the live event is untouched and later mutation cannot
    # reach the claim.
    assert event["delivery"]["lastError"] == _SOCKET_MISSING_ERROR
    event["evidence"] = "mutated after the claim"
    assert claim["evidence"] != "mutated after the claim"


def test_producer_claim_still_exposes_a_genuine_leak_in_producer_fields():
    # The stripping must not blunt detection: a real fixture event declares
    # itself in producer-owned fields, and all of those are preserved.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    for field in ("evidence", "summary"):
        leaked = _event(**{field: "authDir: /tmp/wa-test-auth/creds.json unreadable"})
        assert mod.matched_test_leak_pattern(mod.producer_claim(leaked)) is not None, field
    nested = _event(diagnostics={"logHints": ["see /tmp/wa-test-auth/creds.json"]})
    assert mod.matched_test_leak_pattern(mod.producer_claim(nested)) is not None


def _run_attempts(mod, paths, tmp_path: Path, errors: list[str]):
    """Drive process_one once per entry in `errors`, following the requeue."""
    results = []
    calls = {"n": 0}

    def failing_send(_text: str) -> None:
        index = calls["n"]
        calls["n"] += 1
        raise RuntimeError(errors[index])

    for _ in errors:
        queued = sorted(paths["outbox"].glob("*evt-email-provenance*"))
        if not queued:
            results.append((None, "not-queued", 0))
            break
        with patch.object(mod, "send_whatsapp", side_effect=failing_send), \
             patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
             patch.object(mod, "email_fallback", return_value=True) as fallback:
            ok, detail = mod.process_one(queued[0], paths)
        results.append((ok, detail, fallback.call_count))
    return results


def test_retry_with_a_path_bearing_transport_error_is_not_archived_as_a_leak(tmp_path: Path):
    """A genuine alert must survive a transport error that names a fixture path.

    The multi-attempt case, starting where a real event starts: attempt 0, clean
    producer payload, production-like state root. The transport fails on the
    first attempt with a message shipped code actually raises,
    ``RuntimeError(f"socket missing: {socket_path}")``, and that socket sits
    under a test-fixture path.

    ``mark_failure`` writes that string into ``delivery.lastError``, and the
    retry path publishes the mutated event back to the queued file. Deriving the
    B2 verdict from the live event therefore made attempt 2 read the
    dispatcher's own text and ARCHIVE the alert as a test leak: destroyed, not
    delayed, with the email fallback never reached. Verified identical at
    ``e460995a`` and at ``c6a00805``, so this predates the gate work; it is the
    same class #3404 exists to close, through the queue gate rather than the
    email gate.

    Both gates now read ``producer_claim`` only, so the alert survives to the
    fallback threshold and escalates.
    """
    with _state_root_outside_test_roots() as state_root:
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_root),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        assert mod.matched_state_dir_test_root_pattern(state_root) is None, "precondition: production state dir"
        clean = _event(delivery={"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None})
        assert mod.event_is_test_leak(clean) is False, "precondition: the producer payload is clean"
        assert mod.event_is_test_leak(mod.mark_failure(_event(), _SOCKET_MISSING_ERROR)) is True, (
            "precondition: the transport error text alone reads as a leak"
        )

        paths = mod.setup_dirs()
        _write_event(paths, clean)

        results = _run_attempts(mod, paths, tmp_path, [
            _SOCKET_MISSING_ERROR,
            "bridge unavailable",
            "bridge unavailable",
        ])

        details = [detail for _ok, detail, _calls in results]
        assert "test_leak" not in details, results
        assert "test_leak_dropped" not in _dispatch_log_types(paths)
        assert not list(paths["testleak"].glob("*evt-email-provenance*")), "the alert must not be archived"
        # Attempt 3 is the first at the fallback threshold, and it escalates.
        assert results[-1][0] is True, results
        assert results[-1][1] == "email_delivered", results
        assert results[-1][2] == 1, results
        assert "email_fallback_test_provenance_suppressed" not in _dispatch_log_types(paths)


def test_a_genuine_producer_claimed_leak_is_still_archived_at_the_claim(tmp_path: Path):
    # Negative control for the test above: narrowing what B2 reads must not
    # stop it dropping a real fixture event. Same route, same state dir; the
    # only difference is that the leak is in the producer's own evidence.
    with _state_root_outside_test_roots() as state_root:
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_root),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        paths = mod.setup_dirs()
        leaked = _event(evidence="authDir: /tmp/wa-test-auth/creds.json unreadable")
        event_path = _write_event(paths, leaked)

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("bridge unavailable")), \
             patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
             patch.object(mod, "email_fallback", return_value=True) as fallback:
            ok, detail = mod.process_one(event_path, paths)

        assert (ok, detail) == (False, "test_leak")
        assert fallback.call_count == 0
        assert "test_leak_dropped" in _dispatch_log_types(paths)
        assert len(list(paths["testleak"].glob("*evt-email-provenance*"))) == 1


def test_state_dir_test_root_match_is_spelling_independent(tmp_path: Path):
    """A test root must be recognised however the state dir is spelled.

    ``BOT_ERRORS_STATE_DIR`` is taken unnormalised, so a relative value or a
    symlink into a sandbox would present a clean string for a state root that is
    really a test root. Matching only the supplied spelling fails OPEN: the test
    run is allowed to email the operator.
    """
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})
    sandbox = tmp_path / "pytest-of-runner" / "pytest-1" / "state"
    sandbox.mkdir(parents=True)
    assert mod.matched_state_dir_test_root_pattern(sandbox) is not None, "absolute spelling"

    # A symlink whose own path says nothing about where it points.
    link = tmp_path / "clean-looking-state"
    link.symlink_to(sandbox, target_is_directory=True)
    assert mod.matched_state_dir_test_root_pattern(link) is not None, "symlink alias"

    # A relative spelling of the same directory.
    previous = os.getcwd()
    os.chdir(tmp_path / "pytest-of-runner" / "pytest-1")
    try:
        assert mod.matched_state_dir_test_root_pattern("state") is not None, "relative spelling"
    finally:
        os.chdir(previous)


def test_unresolvable_state_dir_blocks_rather_than_allows():
    # Fail closed: a state directory that cannot be classified must not be
    # treated as production. Otherwise the failure mode of the check is to
    # permit exactly what it exists to prevent.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": _CLEAN_STATE_DIR})

    class Unresolvable:
        def __fspath__(self) -> str:
            return "\x00/not/a/real/path"

    matched = mod.matched_state_dir_test_root_pattern(Unresolvable())
    assert matched == mod.UNRESOLVABLE_STATE_DIR_PATTERN
    assert mod.email_fallback_blocked_reason(_event(), state_dir=Unresolvable()) == "test_state_dir"
