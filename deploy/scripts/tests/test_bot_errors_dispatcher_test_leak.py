"""Tests for dispatcher test-leak defense-in-depth (Bead B2).

Loads bot-errors-dispatcher.py via importlib (hyphen in filename prevents normal import).
TDD: these tests were written BEFORE the implementation and verify the contract
as specified in the B2 task for event_is_test_leak, setup_dirs (testleak dir),
process_one drop path, and the daily-counter rollover mechanism.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module(extra_env: dict[str, str] | None = None):
    """Load the dispatcher module, optionally with env vars set."""
    env_backup = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_dispatcher", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


# Load the module for collection-time bindings with a pinned-empty
# BOT_ERRORS_TEST_LEAK_PATH_PATTERNS so an inherited CI env value cannot inject
# extra patterns into the default-pattern / negative-case tests below.
_mod = _load_module(extra_env={"BOT_ERRORS_TEST_LEAK_PATH_PATTERNS": ""})
event_is_test_leak = _mod.event_is_test_leak
matched_test_leak_pattern = _mod.matched_test_leak_pattern


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_event(**kwargs: Any) -> dict[str, Any]:
    base = {
        "schemaVersion": 1,
        "id": "evt-test-001",
        "source": "whatsapp_auth_bond_local_failure",
        "severity": "error",
        "eventType": "alert",
        "summary": "auth bond check",
        "evidence": "",
        "machine": "testhost",
        "instance": "test-bot",
    }
    base.update(kwargs)
    return base


def _make_dirs(tmp_path: Path) -> dict[str, Path]:
    """Create minimal directory structure mirroring setup_dirs."""
    root = tmp_path / "state"
    dirs = {
        "root": root,
        "outbox": root / "outbox",
        "processing": root / "processing",
        "sent": root / "sent",
        "suppressed": root / "suppressed",
        "quarantine": root / "quarantine",
        "writefail_recovered": root / "writefail-recovered",
        "writefail_quarantine": root / "writefail-quarantine",
        "locks": root / "locks",
        "logs": root / "logs",
        "state": root / "dispatcher-state.json",
        "incident_state": root / "incident-state.json",
        "testleak": root / "testleak",
    }
    for key, p in dirs.items():
        if key in ("state", "incident_state"):
            continue
        p.mkdir(parents=True, exist_ok=True)
        p.chmod(0o700)
    return dirs


# ===========================================================================
# UNIT TESTS: physical intervention signal classification
# ===========================================================================

class TestPhysicalInterventionSignals:
    """Pure-function tests for logged-out alert evidence gates."""

    def test_instance_logged_out_accepts_terminal_auth_failure_class(self):
        event = _make_event(
            source="instance_logged_out",
            evidence=(
                "confidence=confirmed reason=whatsapp_auth_loss_with_disconnect_corroboration "
                "last_status_code=unknown last_disconnect_reason=unknown "
                "auth_failure_class=pairing_required"
            ),
        )
        assert _mod.is_logged_out_physical_signal(event)
        assert _mod.is_physical_intervention_signal(event)

    def test_instance_logged_out_accepts_normalized_logged_out_reason(self):
        event = _make_event(
            source="instance_logged_out",
            evidence="last_status_code=401 last_disconnect_reason=logged_out auth_failure_class=none",
        )
        assert _mod.is_logged_out_physical_signal(event)

    def test_instance_logged_out_rejects_ambiguous_disconnect(self):
        event = _make_event(
            source="instance_logged_out",
            evidence="last_status_code=440 last_disconnect_reason=connectionReplaced auth_failure_class=none",
        )
        assert not _mod.is_logged_out_physical_signal(event)

    def test_weak_logged_out_critical_asset_is_not_verified_physical_intervention(self):
        event = _make_event(
            source="instance_logged_out",
            evidence=(
                "connected=false state=unknown reconnect_phase=backoff reconnect_attempts=0 "
                "weak_signal_polls=3"
            ),
            criticalAsset={
                "asset": {
                    "kind": "whatsapp_linked_device",
                    "instance": "test-bot",
                    "owner": "whatsoup",
                },
                "failure": {
                    "code": "WEAK_LOGGED_OUT_SIGNAL",
                    "domain": "account_linkage",
                    "recoverability": "manual_relink_required",
                    "confidence": "probable",
                    "operatorAction": "verify the weak logged-out signal before physical relink",
                    "clearRequirement": "confirmed terminal auth evidence or reconnect recovery",
                },
            },
        )

        assert not _mod.is_logged_out_physical_signal(event)
        assert not _mod.is_verified_device_bond_lost_signal(event)
        assert not _mod.is_physical_intervention_signal(event)
        assert _mod.is_autoclose_protected(event, "testhost|test-bot|instance_logged_out")

    def test_terminal_auth_failure_class_inventory(self):
        assert _mod.TERMINAL_AUTH_FAILURE_CLASSES == {
            "pairing_required",
            "serverside_logout_irreversible",
        }


# ===========================================================================
# UNIT TESTS: event_is_test_leak
# ===========================================================================

class TestEventIsTestLeak:
    """Pure-function tests for event_is_test_leak(event) -> bool."""

    # --- Positive cases (should be detected as test leaks) ---

    def test_evidence_tmp_wa_test_auth(self):
        """Classic case: /tmp/wa-test-auth in evidence."""
        event = _make_event(evidence="authDir: /tmp/wa-test-auth creds_present=true")
        assert event_is_test_leak(event), "should detect /tmp/wa-test-auth"

    def test_evidence_tmp_wa_test_sibling(self):
        """/tmp/wa-test-foo (sibling of auth) in evidence."""
        event = _make_event(evidence="auth: /tmp/wa-test-foo/something else=true")
        assert event_is_test_leak(event), "should detect /tmp/wa-test-* siblings"

    def test_evidence_tmp_wa_test_no_trailing_slash(self):
        """/tmp/wa-test-auth without trailing slash at end of string."""
        event = _make_event(evidence="path=/tmp/wa-test-auth")
        assert event_is_test_leak(event), "should detect /tmp/wa-test-* without trailing slash"

    def test_summary_macos_temp(self):
        """macOS /var/folders/.../T/ temp path in summary field."""
        event = _make_event(
            evidence="normal evidence here",
            summary="failed to read /var/folders/ab/cd123/T/vitest-xyz/socket.json",
        )
        assert event_is_test_leak(event), "should detect /var/folders/.../T/ in summary"

    def test_macos_writefail_fallback_path_is_not_a_leak(self):
        """The dispatcher's OWN TMPDIR writefail fallback dir must never be
        classified as a test leak: every real macOS daily-health event embeds
        it in the writefail inventory line, and matching it silently dropped
        legitimate host alerts."""
        event = _make_event(
            evidence=(
                "writefail: count=0 paths=/home/testuser/.local/state/bot-errors/writefail,"
                "/var/folders/mq/s3m40vj1/T/bot-errors-writefail,/home/testuser/.bot-errors-writefail"
            ),
        )
        assert not event_is_test_leak(event), (
            "macOS TMPDIR bot-errors-writefail fallback must not be dropped as a test leak"
        )

    def test_macos_temp_vitest_subpath_still_detected(self):
        """Tightening the macOS pattern must not lose real vitest temp leaks."""
        event = _make_event(
            evidence="authDir: /var/folders/mq/s3m40vj1/T/bot-errors-health-Ab12Cd/auth",
        )
        assert event_is_test_leak(event), "vitest mkdtemp subpaths must still be detected"

    def test_evidence_vitest_redirect_outbox(self):
        """The vitest redirect outbox root path in evidence."""
        event = _make_event(
            evidence="outbox=/tmp/whatsoup-vitest-bot-errors/line-a/outbox",
        )
        assert event_is_test_leak(event), "should detect /tmp/whatsoup-vitest-bot-errors/"

    def test_nested_payload_field(self):
        """Test-fixture path buried in a nested diagnostics dict."""
        event = _make_event(
            evidence="normal",
            diagnostics={"socket": "/tmp/wa-test-auth/test.sock", "remote": "none"},
        )
        assert event_is_test_leak(event), "should detect test path in nested diagnostics"

    def test_nested_asset_string(self):
        """Test-fixture path in a nested payload dict (any arbitrary key)."""
        event = _make_event(
            payload={"authDir": "/tmp/wa-test-auth", "botId": "test-bot"},
        )
        assert event_is_test_leak(event), "should detect test path in nested payload"

    def test_evidence_only_nested_in_list(self):
        """Test-fixture path in a list value within diagnostics."""
        event = _make_event(
            diagnostics={"paths": ["/tmp/wa-test-foo/creds.json", "/real/path"]},
        )
        assert event_is_test_leak(event), "should detect test path in nested list strings"

    def test_vitest_outbox_deep_subdir(self):
        """Deep subdirectory of the vitest redirect outbox."""
        event = _make_event(
            evidence="/tmp/whatsoup-vitest-bot-errors/line-b/outbox/12345.json",
        )
        assert event_is_test_leak(event), "should detect deep subdir of vitest outbox"

    def test_case_insensitive_match(self):
        """/TMP/WA-TEST-AUTH (uppercase) should still match (case-insensitive)."""
        event = _make_event(evidence="/TMP/WA-TEST-AUTH/creds.json")
        assert event_is_test_leak(event), "matching should be case-insensitive"

    # --- Negative cases (real events that must NOT be suppressed) ---

    def test_real_home_path_not_detected(self):
        """A real home-directory auth path must not be detected as a test leak."""
        event = _make_event(
            evidence="authDir: /srv/whatsoup/state/main-line/auth creds=present",
        )
        assert not event_is_test_leak(event), "home auth paths are real, not test leaks"

    def test_empty_event_not_detected(self):
        """Empty event with no meaningful fields must not trigger false positive."""
        event = {}
        assert not event_is_test_leak(event), "empty event must not be a test leak"

    def test_normal_auth_bond_not_detected(self):
        """Normal auth-bond evidence with no test paths must pass through."""
        event = _make_event(
            evidence=(
                "auth_bond_status=present creds_hash=abcdef12 "
                "auth_bond_creds_size=4096 creds_present=true"
            ),
        )
        assert not event_is_test_leak(event), "real auth-bond evidence must not be suppressed"

    def test_prod_socket_not_detected(self):
        """A production socket path must not match."""
        event = _make_event(
            evidence="socket=/var/run/whatsoup/main-line.sock status=ok",
        )
        assert not event_is_test_leak(event), "/var/run/ is not a test path"

    def test_tmp_unrelated_not_detected(self):
        """/tmp/ path that is NOT a test fixture must not match."""
        event = _make_event(evidence="tmp_dir=/tmp/some-real-app-dir/socket.sock")
        assert not event_is_test_leak(event), "/tmp/some-real-app-dir is not a test fixture"

    def test_regresses_old_test_fixture_auth_bond(self):
        """The old TEST_FIXTURE_AUTH_BOND regex case must still be caught by the new detector."""
        # Mimics the existing suppression test condition exactly
        event = _make_event(
            source="whatsapp_auth_bond_local_failure",
            evidence="authDir: /tmp/wa-test-auth creds_present=true",
        )
        assert event_is_test_leak(event), "generalized detector must catch the old auth-bond fixture case"


    def test_nested_only_match_attributes_correct_pattern(self):
        """A path present ONLY in a nested field must be both detected AND
        attributed: matched_test_leak_pattern returns the specific pattern that
        the nested value matched, not a top-level-field match (there is none).
        """
        # No test path in any top-level string field; the only hit is buried
        # three levels deep in a nested dict-inside-list-inside-dict.
        event = _make_event(
            evidence="auth_bond_status=present creds_present=true",
            summary="daily-health summary, all nominal",
            diagnostics={
                "sockets": [
                    {"name": "primary", "path": "/var/run/whatsoup/p.sock"},
                    {"name": "leaked", "path": "/tmp/whatsoup-vitest-bot-errors/x/outbox"},
                ]
            },
        )
        matched = matched_test_leak_pattern(event)
        assert matched is not None, "nested-only test path must still be detected"
        assert matched == r"/tmp/whatsoup-vitest-bot-errors/", (
            f"matchedPattern must attribute the nested vitest-outbox pattern, got {matched!r}"
        )


# ===========================================================================
# UNIT TESTS: env-extension via BOT_ERRORS_TEST_LEAK_PATH_PATTERNS
# ===========================================================================

class TestEnvExtensionPatterns:
    """Env-var-driven extra patterns are appended to defaults."""

    def test_custom_pattern_comma_separated(self, monkeypatch):
        """Comma-separated extra pattern in env var is honoured."""
        monkeypatch.setenv("BOT_ERRORS_TEST_LEAK_PATH_PATTERNS", r"/tmp/my-custom-test/")
        mod2 = _load_module()
        fn = mod2.event_is_test_leak
        event = _make_event(evidence="socket=/tmp/my-custom-test/primary.sock")
        assert fn(event), "custom comma-separated pattern must be detected"

    def test_custom_pattern_newline_separated(self, monkeypatch):
        """Newline-separated extra patterns in env var are honoured."""
        monkeypatch.setenv(
            "BOT_ERRORS_TEST_LEAK_PATH_PATTERNS",
            "/tmp/custom-test-a/\n/tmp/custom-test-b/",
        )
        mod2 = _load_module()
        fn = mod2.event_is_test_leak
        event_a = _make_event(evidence="/tmp/custom-test-a/file.json")
        event_b = _make_event(evidence="/tmp/custom-test-b/file.json")
        assert fn(event_a), "first newline-separated pattern must match"
        assert fn(event_b), "second newline-separated pattern must match"

    def test_default_patterns_still_match_when_env_set(self, monkeypatch):
        """Default patterns remain effective when env var adds extras."""
        monkeypatch.setenv("BOT_ERRORS_TEST_LEAK_PATH_PATTERNS", "/tmp/extra-custom/")
        mod2 = _load_module()
        fn = mod2.event_is_test_leak
        event = _make_event(evidence="path=/tmp/wa-test-auth/creds.json")
        assert fn(event), "default patterns must still fire when env var is set"

    def test_empty_env_var_does_not_break(self, monkeypatch):
        """Empty env var is safe — default patterns still work."""
        monkeypatch.setenv("BOT_ERRORS_TEST_LEAK_PATH_PATTERNS", "")
        mod2 = _load_module()
        fn = mod2.event_is_test_leak
        event = _make_event(evidence="/tmp/wa-test-auth/creds.json")
        assert fn(event), "empty env var must not disable default patterns"


# ===========================================================================
# UNIT TESTS: daily counter rollover / once-per-day guarantee
# ===========================================================================

class TestDailyCounterMechanism:
    """Drive the daily test-leak counter logic directly without I/O."""

    def _get_fn(self):
        """Return the daily-marker recording function."""
        return _mod.record_test_leak_daily_marker

    def test_first_drop_records_marker(self):
        """First drop on a new date records a marker and returns True."""
        fn = self._get_fn()
        state = {}
        today = "2026-06-12"
        recorded = fn(state, today, count=1)
        assert recorded is True, "first drop on new date should record marker"
        assert "testLeakDaily" in state, "state must have testLeakDaily key"
        assert state["testLeakDaily"][today]["count"] == 1
        assert state["testLeakDaily"][today]["emitted"] is True

    def test_second_call_same_date_does_not_re_emit(self):
        """Subsequent calls on the same date return False (already emitted)."""
        fn = self._get_fn()
        state = {}
        today = "2026-06-12"
        fn(state, today, count=1)
        recorded = fn(state, today, count=2)
        assert recorded is False, "second call on same date must not re-emit"

    def test_accumulates_count_without_re_emitting(self):
        """Count keeps accumulating per date without re-emitting."""
        fn = self._get_fn()
        state = {}
        today = "2026-06-12"
        first = fn(state, today, count=5)
        second = fn(state, today, count=3)  # adds 3 more
        # First call emits; second only accumulates. Exact total = 5 + 3 = 8.
        assert first is True, "first drop on new date emits"
        assert second is False, "second same-date call must not re-emit"
        assert state["testLeakDaily"][today]["count"] == 8, (
            "accumulated count must be exactly 5 + 3 = 8"
        )

    def test_new_date_re_emits(self):
        """A new UTC date triggers a fresh emission."""
        fn = self._get_fn()
        state = {}
        fn(state, "2026-06-11", count=7)
        recorded = fn(state, "2026-06-12", count=1)
        assert recorded is True, "new date must allow fresh emission"
        assert state["testLeakDaily"]["2026-06-12"]["emitted"] is True

    def test_ten_drops_one_marker_per_date(self):
        """10 calls with count=1 each (one per run) produce exactly one emitted=True.

        Simulates 10 dispatcher runs each dropping 1 test-leak event. Accumulated
        daily count must be 10 and exactly one emission fires across all calls.
        """
        fn = self._get_fn()
        state = {}
        today = "2026-06-12"
        emissions = []
        for _ in range(10):
            result = fn(state, today, count=1)
            emissions.append(result)
        assert sum(emissions) == 1, "exactly one True across 10 same-date calls"
        assert state["testLeakDaily"][today]["count"] == 10, "accumulated count must be 10"


    def test_daily_marker_survives_disk_roundtrip(self, tmp_path):
        """The once-per-day guarantee must survive a save -> load_incident_state
        cycle: load_incident_state whitelists keys, so testLeakDaily must be
        explicitly preserved. Without that preservation the marker would be
        dropped on every run and the daily summary would re-fire forever.

        Drives the REAL save_incident_state / load_incident_state I/O against a
        temp state dir to prove the persistence contract end to end.
        """
        fn = self._get_fn()
        paths = {
            "incident_state": tmp_path / "incident-state.json",
            "logs": tmp_path / "logs",
        }
        paths["logs"].mkdir(parents=True, exist_ok=True)
        today = "2026-06-12"

        # Run 1: first drop records + emits, then persist to disk.
        state1 = _mod.load_incident_state(paths)  # fresh, no file yet
        emitted1 = fn(state1, today, count=4)
        assert emitted1 is True, "first drop on new date emits"
        _mod.save_incident_state(paths, state1)
        assert paths["incident_state"].exists(), "state must be written to disk"

        # Run 2: reload from disk — the marker must round-trip intact.
        state2 = _mod.load_incident_state(paths)
        assert "testLeakDaily" in state2, (
            "testLeakDaily must survive load_incident_state whitelist"
        )
        assert state2["testLeakDaily"][today]["emitted"] is True
        assert state2["testLeakDaily"][today]["count"] == 4

        # Same date after roundtrip: must NOT re-emit (once-per-day holds).
        emitted2 = fn(state2, today, count=2)
        assert emitted2 is False, (
            "after disk roundtrip, same-date drop must not re-emit the daily summary"
        )
        assert state2["testLeakDaily"][today]["count"] == 6, "count accumulates to 4 + 2 = 6"

        # Persist + reload once more; new date DOES re-emit.
        _mod.save_incident_state(paths, state2)
        state3 = _mod.load_incident_state(paths)
        emitted3 = fn(state3, "2026-06-13", count=1)
        assert emitted3 is True, "a new UTC date re-emits after roundtrip"


# ===========================================================================
# INTEGRATION TEST: process_one drop path
# ===========================================================================

class TestProcessOneDrop:
    """Integration-style test: process_one on a test-leak event must drop it."""

    def _write_event(self, outbox: Path, event: dict[str, Any]) -> Path:
        name = f"{int(time.time())}.{event['id']}.json"
        path = outbox / name
        path.write_text(json.dumps(event), encoding="utf-8")
        path.chmod(0o600)
        return path

    def test_test_leak_event_not_sent(self, tmp_path, monkeypatch):
        """process_one on a test-leak event must NOT call send_whatsapp."""
        paths = _make_dirs(tmp_path)

        # Ensure setup_dirs also returns the testleak dir
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(paths["root"]))
        monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(paths["outbox"]))
        monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")

        # Guard: if send_whatsapp is ever called, the test must fail
        def _bad_send(text: str, socket_path: str = "") -> None:
            raise AssertionError(
                "send_whatsapp must NEVER be called for a test-leak event"
            )

        monkeypatch.setattr(_mod, "send_whatsapp", _bad_send)

        event = _make_event(
            id="tl-evt-001",
            evidence="authDir: /tmp/wa-test-auth creds_present=true",
        )
        event_path = self._write_event(paths["outbox"], event)

        ok, detail = _mod.process_one(event_path, paths)

        assert detail == "test_leak", f"expected status 'test_leak', got {detail!r}"

    def test_test_leak_event_archived_in_testleak_dir(self, tmp_path, monkeypatch):
        """process_one on a test-leak event must archive under testleak dir."""
        paths = _make_dirs(tmp_path)
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(paths["root"]))
        monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(paths["outbox"]))
        monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
        monkeypatch.setattr(_mod, "send_whatsapp", lambda text, socket_path="": None)

        event = _make_event(
            id="tl-evt-002",
            evidence="path=/tmp/whatsoup-vitest-bot-errors/line-a/outbox/x.json",
        )
        event_path = self._write_event(paths["outbox"], event)

        _mod.process_one(event_path, paths)

        testleak_files = list(paths["testleak"].glob("*"))
        assert len(testleak_files) == 1, "exactly one test-leak event archived under testleak dir"

    def test_test_leak_event_not_in_sent_dir(self, tmp_path, monkeypatch):
        """process_one on a test-leak event must NOT place file in sent dir."""
        paths = _make_dirs(tmp_path)
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(paths["root"]))
        monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(paths["outbox"]))
        monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
        monkeypatch.setattr(_mod, "send_whatsapp", lambda text, socket_path="": None)

        event = _make_event(
            id="tl-evt-003",
            evidence="/var/folders/ab/xyz/T/vitest-run/socket.json",
        )
        event_path = self._write_event(paths["outbox"], event)

        _mod.process_one(event_path, paths)

        sent_files = list(paths["sent"].glob("*"))
        assert len(sent_files) == 0, "test-leak event must not go to sent dir"

    def test_dispatch_log_has_test_leak_dropped_entry(self, tmp_path, monkeypatch):
        """process_one on test-leak event must append test_leak_dropped to dispatch log."""
        paths = _make_dirs(tmp_path)
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(paths["root"]))
        monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(paths["outbox"]))
        monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
        monkeypatch.setattr(_mod, "send_whatsapp", lambda text, socket_path="": None)

        event = _make_event(
            id="tl-evt-004",
            evidence="authDir: /tmp/wa-test-auth/creds.json",
        )
        event_path = self._write_event(paths["outbox"], event)

        _mod.process_one(event_path, paths)

        log_path = paths["logs"] / "dispatch.jsonl"
        assert log_path.exists(), "dispatch log must exist after process_one"
        records = [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]
        leak_records = [r for r in records if r.get("type") == "test_leak_dropped"]
        assert len(leak_records) >= 1, "dispatch log must have a test_leak_dropped entry"
        entry = leak_records[0]
        assert entry["schemaVersion"] == 1
        assert entry["component"] == "dispatcher"
        assert entry["recordKind"] == "test_leak_dropped"
        assert "eventId" not in entry["details"]
        assert "matchedPattern" not in entry["details"]
        assert "source" not in entry["details"]


# ===========================================================================
# INTEGRATION TEST: run_once testLeakDropped tally
# ===========================================================================

class TestRunOnceTestLeakTally:
    """run_once must return testLeakDropped in its result dict."""

    def test_run_once_returns_test_leak_dropped_field(self, tmp_path, monkeypatch):
        """run_once with test-leak events returns testLeakDropped count."""
        root = tmp_path / "state"
        outbox = root / "outbox"
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
        monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
        monkeypatch.setenv("BOT_ERRORS_JID", "12345@g.us")
        monkeypatch.setattr(_mod, "send_whatsapp", lambda text, socket_path="": None)

        # Reload module so env changes take effect for setup_dirs
        mod2 = _load_module()
        monkeypatch.setattr(mod2, "send_whatsapp", lambda text, socket_path="": None)

        # Write 3 test-leak events to outbox
        paths = mod2.setup_dirs()
        for i in range(3):
            event = _make_event(
                id=f"tl-run-{i:03d}",
                evidence=f"authDir: /tmp/wa-test-auth creds_present=true idx={i}",
            )
            name = f"{int(time.time()) + i}.{i}.tl-run-{i:03d}.json"
            p = paths["outbox"] / name
            p.write_text(json.dumps(event), encoding="utf-8")
            p.chmod(0o600)

        result = mod2.run_once(max_events=25)
        assert "testLeakDropped" in result, "run_once result must include testLeakDropped"
        assert result["testLeakDropped"] == 3, (
            f"expected 3 test-leak drops, got {result.get('testLeakDropped')}"
        )
        # Must not count as sent or failed
        assert result.get("sent", 0) == 0, "test-leak events must not count as sent"
        assert result.get("failed", 0) == 0, "test-leak events must not count as failed"

    def test_setup_dirs_creates_testleak_dir(self, tmp_path, monkeypatch):
        """setup_dirs must create and return a testleak path."""
        root = tmp_path / "state2"
        monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
        monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(root / "outbox"))
        mod2 = _load_module()
        paths = mod2.setup_dirs()
        assert "testleak" in paths, "setup_dirs must include 'testleak' key"
        assert paths["testleak"].is_dir(), "testleak dir must exist after setup_dirs"
