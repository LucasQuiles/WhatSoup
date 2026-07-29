"""Tests for F5: dispatcher dead-letter + meta-alert.

TDD — written against the designed contract:
- next_backoff() returns None once attempts >= cap (default 10, BOT_ERRORS_DELIVERY_MAX_ATTEMPTS).
- An event that keeps failing moves to dead-letter/ at the cap with status "dead_letter".
- The dead-letter dir lives under state root (sibling to outbox), not inside outbox.
- A meta-alert fires at most once per hour when dead-letter dir is non-empty.
- email_fallback_unavailable=True is recorded when fallback script is missing/non-executable.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Env isolation fixture
# ---------------------------------------------------------------------------

TEST_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_OUTBOX_DIR",
]


@pytest.fixture(autouse=True)
def _clean_test_env():
    """Remove test-specific env vars before each test and restore after."""
    saved = {k: os.environ.get(k) for k in TEST_ENV_KEYS}
    for k in TEST_ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module(extra_env: dict[str, str] | None = None):
    """Load the dispatcher module with optional env vars set PERSISTENTLY.

    Unlike some other test loaders, this function sets the env vars and does NOT
    restore them, so that runtime calls to os.environ.get() within the loaded
    module's functions continue to see the test env.  Callers that need cleanup
    must restore env themselves.
    """
    if extra_env:
        for k, v in extra_env.items():
            os.environ[k] = v
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


# ---------------------------------------------------------------------------
# F5-a: next_backoff returns None at the cap
# ---------------------------------------------------------------------------

class TestNextBackoffCap:
    def test_returns_int_below_cap(self):
        mod = _load_module({"BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "5"})
        result = mod.next_backoff(1)
        assert isinstance(result, int), f"expected int, got {type(result)}"
        assert result > 0

    def test_returns_none_at_cap(self):
        mod = _load_module({"BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "5"})
        result = mod.next_backoff(5)
        assert result is None, f"expected None at cap=5, got {result!r}"

    def test_returns_none_above_cap(self):
        mod = _load_module({"BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "5"})
        result = mod.next_backoff(99)
        assert result is None, f"expected None above cap, got {result!r}"

    def test_default_cap_is_10(self):
        mod = _load_module()
        assert isinstance(mod.next_backoff(9), int), "attempt 9 should return int"
        assert mod.next_backoff(10) is None, "attempt 10 should return None with default cap"

    def test_env_tunable_cap(self):
        mod = _load_module({"BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "3"})
        assert isinstance(mod.next_backoff(2), int)
        assert mod.next_backoff(3) is None

    def test_cap_must_be_positive(self):
        with pytest.raises((ValueError, SystemExit, Exception)):
            _load_module({"BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "0"})


# ---------------------------------------------------------------------------
# F5-b: dead-letter placement relative to outbox scan
# ---------------------------------------------------------------------------

class TestDeadLetterDirectoryPlacement:
    def test_dead_letter_is_sibling_to_outbox_not_inside(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        outbox = paths["outbox"]
        dead_letter = paths["dead_letter"]
        assert not str(dead_letter).startswith(str(outbox) + "/"), (
            f"dead_letter {dead_letter} must not be inside outbox {outbox}"
        )

    def test_dead_letter_is_under_state_root(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        root = paths["root"]
        dead_letter = paths["dead_letter"]
        assert str(dead_letter).startswith(str(root)), (
            f"dead_letter {dead_letter} not under root {root}"
        )

    def test_dead_letter_created_with_private_discipline(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        dead_letter = paths["dead_letter"]
        assert dead_letter.exists(), "dead_letter dir must exist after setup_dirs"
        assert dead_letter.is_dir()
        mode = dead_letter.stat().st_mode & 0o777
        assert mode == 0o700, f"dead_letter mode should be 0o700, got 0o{mode:03o}"

    def test_dead_letter_is_not_writefail_dir(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        dead_letter = paths["dead_letter"]
        for wf in mod.writefail_dirs():
            assert str(dead_letter) != str(wf), (
                f"dead_letter must not collide with writefail dir: {dead_letter}"
            )


# ---------------------------------------------------------------------------
# F5-c: event terminates at exactly cap with status dead_letter
# ---------------------------------------------------------------------------

class TestDeadLetterTermination:
    def _make_event_at_cap_minus_one(self, paths: dict[str, Path], cap: int) -> Path:
        event: dict[str, Any] = {
            "schemaVersion": 1,
            "id": "evt-cap-test",
            "eventType": "alert",
            "severity": "critical",
            "source": "socket_down",
            "instance": "ana-bot",
            "machine": "nucles",
            "summary": "cap test event",
            "evidence": "testing cap",
            "createdAt": "2026-06-12T00:00:00Z",
            "delivery": {
                "attempts": cap - 1,
                "status": "queued",
                "nextAttemptAtEpoch": 0,
                "lastError": "prev failure",
            },
        }
        event_path = paths["outbox"] / "20260612000000.ana-bot.socket_down.evt-cap-test.json"
        event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
        event_path.chmod(0o600)
        return event_path

    def test_event_at_cap_moves_to_dead_letter(self, tmp_path):
        cap = 5
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": str(cap),
        })
        paths = mod.setup_dirs()
        event_path = self._make_event_at_cap_minus_one(paths, cap)

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("always fails")), \
             patch.object(mod, "email_fallback", return_value=False), \
             patch.object(mod, "EMAIL_FALLBACK", "/nonexistent/fallback.sh"):
            ok, detail = mod.process_one(event_path, paths)

        dead_letter = paths["dead_letter"]
        files = list(dead_letter.glob("*.json"))
        assert len(files) == 1, f"Expected 1 file in dead-letter, got {len(files)}"

        dl_record = json.loads(files[0].read_text())
        assert "event" in dl_record, "dead-letter record must contain 'event'"
        assert "delivery" in dl_record, "dead-letter record must contain 'delivery'"
        assert "terminated_at" in dl_record, "dead-letter record must contain 'terminated_at'"
        assert dl_record.get("delivery", {}).get("status") == "dead_letter", (
            f"delivery.status should be dead_letter, got: {dl_record.get('delivery')}"
        )

    def test_event_below_cap_stays_in_outbox(self, tmp_path):
        cap = 10
        state_dir = str(tmp_path / "state")
        env = {
            "BOT_ERRORS_STATE_DIR": state_dir,
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": str(cap),
        }
        # Keep env set during execution
        orig = {k: os.environ.get(k) for k in env}
        for k, v in env.items():
            os.environ[k] = v
        try:
            mod = _load_module(env)
            paths = mod.setup_dirs()

            event: dict[str, Any] = {
                "schemaVersion": 1,
                "id": "evt-below-cap",
                "eventType": "alert",
                "severity": "critical",
                "source": "socket_down",
                "instance": "ana-bot",
                "machine": "nucles",
                "summary": "below cap test",
                "evidence": "not at cap",
                "createdAt": "2026-06-12T00:00:00Z",
                "delivery": {
                    "attempts": 2,
                    "status": "queued",
                    "nextAttemptAtEpoch": 0,
                    "lastError": None,
                },
            }
            event_path = paths["outbox"] / "20260612000000.ana-bot.socket_down.evt-below-cap.json"
            event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
            event_path.chmod(0o600)

            with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("fails")), \
                 patch.object(mod, "email_fallback", return_value=False), \
                 patch.object(mod, "EMAIL_FALLBACK", "/nonexistent/fallback.sh"):
                ok, detail = mod.process_one(event_path, paths)

            dead_files = list(paths["dead_letter"].glob("*.json"))
            assert len(dead_files) == 0, f"Event should not be in dead-letter; got {len(dead_files)}"

            outbox_files = list(paths["outbox"].glob("*.json"))
            assert len(outbox_files) == 1, f"Event should remain in outbox; got {len(outbox_files)}"
        finally:
            for k, orig_v in orig.items():
                if orig_v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig_v

    def test_dead_letter_event_not_re_scanned_by_outbox(self, tmp_path):
        """After dead-lettering, outbox glob finds no remaining events."""
        cap = 3
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": str(cap),
        })
        paths = mod.setup_dirs()
        event_path = self._make_event_at_cap_minus_one(paths, cap)

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("fails")), \
             patch.object(mod, "email_fallback", return_value=False), \
             patch.object(mod, "EMAIL_FALLBACK", "/nonexistent/fallback.sh"):
            mod.process_one(event_path, paths)

        # Outbox should have no json files (event was moved to dead-letter)
        outbox_files = list(paths["outbox"].glob("*.json"))
        assert len(outbox_files) == 0, (
            f"Dead-lettered event must not remain in outbox; found {outbox_files}"
        )


# ---------------------------------------------------------------------------
# F5-d: email_fallback_unavailable recorded when fallback missing/non-executable
# ---------------------------------------------------------------------------

class TestEmailFallbackUnavailableRecorded:
    def test_email_fallback_unavailable_recorded_when_missing(self, tmp_path):
        state_dir = tmp_path / "state"
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        paths = mod.setup_dirs()

        # attempts=3 triggers the email fallback code path
        event: dict[str, Any] = {
            "schemaVersion": 1,
            "id": "evt-fb-unavail",
            "eventType": "alert",
            "severity": "critical",
            "source": "socket_down",
            "instance": "ana-bot",
            "machine": "nucles",
            "summary": "fallback unavail test",
            "evidence": "testing email fallback unavailable",
            "createdAt": "2026-06-12T00:00:00Z",
            "delivery": {
                "attempts": 3,
                "status": "queued",
                "nextAttemptAtEpoch": 0,
                "lastError": None,
            },
        }
        event_path = paths["outbox"] / "20260612000000.ana-bot.socket_down.evt-fb-unavail.json"
        event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
        event_path.chmod(0o600)

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
             patch.object(mod, "EMAIL_FALLBACK", "/nonexistent/email-fallback-xyz.sh"):
            ok, detail = mod.process_one(event_path, paths)

        # Event should be requeued in outbox (not at cap yet)
        outbox_files = list(paths["outbox"].glob("*.json"))
        assert outbox_files, "Event should remain in outbox after failure at attempt 4"
        requeued = json.loads(outbox_files[0].read_text())
        delivery = requeued.get("delivery", {})
        assert delivery.get("email_fallback_unavailable") is True, (
            f"expected email_fallback_unavailable=True, got: {delivery}"
        )

    def test_email_fallback_not_unavailable_when_executable(self, tmp_path):
        """email_fallback_unavailable should not be set when the fallback IS executable."""
        state_dir = tmp_path / "state"
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        paths = mod.setup_dirs()

        # Create an executable fallback that always succeeds
        fallback = tmp_path / "fake-fallback.sh"
        fallback.write_text("#!/bin/sh\nexit 0\n")
        fallback.chmod(0o755)

        event: dict[str, Any] = {
            "schemaVersion": 1,
            "id": "evt-fb-avail",
            "eventType": "alert",
            "severity": "critical",
            "source": "socket_down",
            "instance": "ana-bot",
            "machine": "nucles",
            "summary": "fallback avail test",
            "evidence": "testing email fallback available",
            "createdAt": "2026-06-12T00:00:00Z",
            "delivery": {
                "attempts": 3,
                "status": "queued",
                "nextAttemptAtEpoch": 0,
                "lastError": None,
            },
        }
        event_path = paths["outbox"] / "20260612000000.ana-bot.socket_down.evt-fb-avail.json"
        event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
        event_path.chmod(0o600)

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
             patch.object(mod, "EMAIL_FALLBACK", str(fallback)):
            ok, detail = mod.process_one(event_path, paths)

        outbox_files = list(paths["outbox"].glob("*.json"))
        assert outbox_files, "Event should remain in outbox"
        requeued = json.loads(outbox_files[0].read_text())
        delivery = requeued.get("delivery", {})
        # email_fallback_unavailable should NOT be set (or should be False/absent)
        assert not delivery.get("email_fallback_unavailable"), (
            f"email_fallback_unavailable should not be set when fallback is available, got: {delivery}"
        )


# ---------------------------------------------------------------------------
# F5-e: meta-alert fires when dead-letter dir is non-empty, throttled per hour
# ---------------------------------------------------------------------------

class TestDeadLetterMetaAlert:
    def _seed_dead_letter(self, paths: dict[str, Path]) -> None:
        dl_dir = paths["dead_letter"]
        dl_record = {
            "event": {
                "id": "dead-evt-001",
                "source": "socket_down",
                "summary": "Dead event summary",
                "createdAt": "2026-06-12T00:00:00Z",
            },
            "delivery": {"status": "dead_letter", "attempts": 10},
            "terminated_at": "2026-06-12T01:00:00Z",
        }
        path = dl_dir / "20260612010000.dead-evt-001.json"
        path.write_text(json.dumps(dl_record, indent=2, sort_keys=True) + "\n")
        path.chmod(0o600)

    def _queued_meta_alerts(self, paths: dict[str, Path]) -> list[dict]:
        return [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(paths["outbox"].glob("*.json"))
        ]

    def test_meta_alert_fires_when_dead_letter_non_empty(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        self._seed_dead_letter(paths)

        with patch.object(mod, "append_dispatch_log"), \
             patch.object(mod, "read_meta_state", return_value={}):
            count = mod.queue_dead_letter_meta_alert(paths, int(time.time()))

        assert count == 1, f"Expected meta-alert fired (count=1), got {count}"
        queued_payloads = self._queued_meta_alerts(paths)
        assert queued_payloads, "Expected durable meta-alert publication"
        meta = queued_payloads[0]
        assert meta.get("source") == "meta_alert_dead_letter", (
            f"source wrong: {meta.get('source')!r}"
        )
        assert meta.get("severity") == "critical"

    def test_meta_alert_throttled_within_hour(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        self._seed_dead_letter(paths)

        now = int(time.time())
        state_recent = {"deadLetterMetaAlertAtEpoch": now - 1800}  # 30 min ago

        with patch.object(mod, "append_dispatch_log"), \
             patch.object(mod, "read_meta_state", return_value=state_recent):
            count = mod.queue_dead_letter_meta_alert(paths, now)

        assert count == 0, f"Expected meta-alert throttled (count=0), got {count}"
        assert self._queued_meta_alerts(paths) == []

    def test_meta_alert_fires_after_hour_elapsed(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        self._seed_dead_letter(paths)

        now = int(time.time())
        state_old = {"deadLetterMetaAlertAtEpoch": now - 7200}  # 2h ago

        with patch.object(mod, "append_dispatch_log"), \
             patch.object(mod, "read_meta_state", return_value=state_old):
            count = mod.queue_dead_letter_meta_alert(paths, now)

        assert count == 1, f"Expected meta-alert fired (count=1), got {count}"
        assert len(self._queued_meta_alerts(paths)) == 1

    def test_meta_alert_zero_when_dead_letter_empty(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        # Dead-letter dir exists but is empty (only created by setup_dirs, no files placed)

        with patch.object(mod, "append_dispatch_log"), \
             patch.object(mod, "read_meta_state", return_value={}):
            count = mod.queue_dead_letter_meta_alert(paths, int(time.time()))

        assert count == 0, f"Expected no meta-alert for empty dead-letter dir, got {count}"
        assert self._queued_meta_alerts(paths) == []

    def test_meta_alert_source_not_in_test_leak_patterns(self):
        mod = _load_module()
        fake_event = {
            "source": "meta_alert_dead_letter",
            "instance": "bot-errors-dispatcher",
            "machine": "nucles",
            "summary": "Dead-letter meta-alert",
            "evidence": "dead_letter_count=1",
        }
        assert not mod.event_is_test_leak(fake_event), (
            "meta_alert_dead_letter must not be flagged as a test leak"
        )

    def test_real_meta_alert_event_survives_leak_filter_under_test_sandbox(self):
        # Regression: the REAL meta-alert event (built by dead_letter_meta_event)
        # must not self-match the test-leak filter even when the state root is a
        # test sandbox path (/var/folders/.../T/, /tmp/whatsoup-vitest-bot-errors/).
        # The dead-letter dir absolute path must NOT appear in any scannable field
        # — otherwise the meta-alert is silently dropped in integration tests.
        mod = _load_module()
        for sandbox in (
            "/tmp/whatsoup-vitest-bot-errors/run-xyz",
            "/var/folders/ab/cd/T/state-root",
            "/tmp/wa-test-auth-state",
        ):
            paths = {"dead_letter": Path(sandbox) / "dead-letter"}
            event = mod.dead_letter_meta_event(paths, 1, "an undeliverable alert")
            assert not mod.event_is_test_leak(event), (
                f"real meta-alert leaked under sandbox {sandbox}: "
                f"{mod.matched_test_leak_pattern(event)}"
            )

    def test_meta_alert_evidence_contains_count(self, tmp_path):
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(tmp_path / "state")})
        paths = mod.setup_dirs()
        self._seed_dead_letter(paths)

        with patch.object(mod, "append_dispatch_log"), \
             patch.object(mod, "read_meta_state", return_value={}):
            mod.queue_dead_letter_meta_alert(paths, int(time.time()))

        queued_payloads = self._queued_meta_alerts(paths)
        assert queued_payloads, "Expected meta-alert queued"
        evidence = queued_payloads[0].get("evidence", "")
        assert "dead_letter_count" in evidence, (
            f"meta-alert evidence must contain dead_letter_count; got: {evidence!r}"
        )
