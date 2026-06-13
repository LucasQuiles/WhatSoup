"""Tests for F7: daily-health severity de-conflation.

Verifies:
- _DAILY_INFRA_FAIL_PREFIXES and _failure_is_infra_only correctly classify
  failure lines as infra-class (downgradeable) or non-infra (keep critical).
- daily_summary_severity returns correct severity for all combinations of
  failures and warnings.
- The daily summary event for a pure-infra-fail scenario is "warning", NOT
  "critical", because the per-instance critical events still fire independently
  (emit_per_instance_health_failures is unchanged).
- Mixed infra + non-infra stays "critical" (fail-safe).
- Warnings-only -> "warning"; clean -> "info".
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


_mod = _load_module()
_failure_is_infra_only = _mod._failure_is_infra_only
daily_summary_severity = _mod.daily_summary_severity


# ---------------------------------------------------------------------------
# T1: _failure_is_infra_only unit cases
# ---------------------------------------------------------------------------

class TestFailureIsInfraOnly:
    """Unit tests for _failure_is_infra_only with the specified category tokens."""

    # True cases (downgradeable infra categories)
    def test_disk_fail_is_infra(self):
        assert _failure_is_infra_only("FAIL disk: low") is True

    def test_queue_fail_is_infra(self):
        assert _failure_is_infra_only("FAIL queue oldest: 9000s") is True

    def test_dns_fail_is_infra(self):
        assert _failure_is_infra_only("FAIL dns: unresolved") is True

    def test_clock_fail_is_infra(self):
        assert _failure_is_infra_only("FAIL clock: skew") is True

    def test_rustdesk_fail_is_infra(self):
        assert _failure_is_infra_only("FAIL rustdesk: down") is True

    # False cases (non-infra: keep critical)
    def test_auth_bond_is_not_infra(self):
        assert _failure_is_infra_only("FAIL auth_bond line-a: lost") is False

    def test_health_is_not_infra(self):
        assert _failure_is_infra_only("FAIL health line-a: probe") is False

    def test_path_like_token_is_not_infra(self):
        # config /path/config.json: invalid JSON — path-like, must reject (fail-safe)
        assert _failure_is_infra_only("FAIL config /path/config.json: invalid JSON") is False

    def test_required_tools_is_not_infra(self):
        # Synthetic "required tools missing: jq" is never downgradeable
        assert _failure_is_infra_only("required tools missing: jq") is False

    def test_instance_fail_is_not_infra(self):
        assert _failure_is_infra_only("FAIL instance line-b: down") is False

    def test_empty_string_is_not_infra(self):
        assert _failure_is_infra_only("") is False

    def test_disk_without_fail_prefix_is_infra(self):
        # Without the FAIL prefix, the first token is "disk" — still infra
        # (real lines from disk_inventory may have FAIL prefix; this verifies tokenisation)
        assert _failure_is_infra_only("disk: probe_path=/tmp free_bytes=100") is True


# ---------------------------------------------------------------------------
# T2: daily_summary_severity pure function
# ---------------------------------------------------------------------------

class TestDailySummarySeverity:
    """Tests for the daily_summary_severity pure function."""

    def test_infra_only_failures_is_warning(self):
        """All-infra failures -> summary is warning (de-conflated from critical)."""
        failures = ["FAIL disk: low free_bytes=100"]
        assert daily_summary_severity(failures, []) == "warning"

    def test_non_infra_failure_alone_is_critical(self):
        """auth_bond failure alone -> critical (fail-safe)."""
        failures = ["FAIL auth_bond line-a: lost"]
        assert daily_summary_severity(failures, []) == "critical"

    def test_mixed_infra_and_non_infra_is_critical(self):
        """Mixed disk + auth_bond -> critical (any non-infra keeps it critical)."""
        failures = [
            "FAIL disk: low free_bytes=100",
            "FAIL auth_bond line-a: lost",
        ]
        assert daily_summary_severity(failures, []) == "critical"

    def test_required_tools_missing_is_critical(self):
        """Synthetic required tools failure alone -> critical (not infra)."""
        failures = ["required tools missing: jq"]
        assert daily_summary_severity(failures, []) == "critical"

    def test_warnings_only_is_warning(self):
        """No failures, only warnings -> warning."""
        assert daily_summary_severity([], ["WARN disk: some warning"]) == "warning"

    def test_clean_is_info(self):
        """No failures, no warnings -> info."""
        assert daily_summary_severity([], []) == "info"

    def test_multiple_infra_failures_are_warning(self):
        """Multiple infra-only failures -> warning (all must be infra)."""
        failures = [
            "FAIL disk: low free_bytes=100",
            "FAIL dns: unresolved",
            "FAIL rustdesk: down",
        ]
        assert daily_summary_severity(failures, []) == "warning"

    def test_dns_only_failure_is_warning(self):
        """DNS-only failure -> warning (infra-class)."""
        failures = ["FAIL dns nucles-custom-domain: host=nucles.quiles.studio missing_expected=100.91.13.7"]
        assert daily_summary_severity(failures, []) == "warning"

    def test_rustdesk_only_failure_is_warning(self):
        """RustDesk-only failure -> warning (infra-class)."""
        failures = ["FAIL rustdesk: id=999999999 expected_id=1076834574"]
        assert daily_summary_severity(failures, []) == "warning"


# ---------------------------------------------------------------------------
# T3: integration — disk-only daily run produces warning summary
# ---------------------------------------------------------------------------

@pytest.fixture()
def dirs(tmp_path: Path):
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return state_dir, outbox_dir


def _load_health(state_dir: Path, outbox_dir: Path):
    return _load_module({
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
    })


def _outbox_events(outbox_dir: Path) -> list[dict]:
    files = list(outbox_dir.glob("*.json"))
    return [json.loads(p.read_text()) for p in files]


def test_disk_only_failure_produces_warning_summary(dirs):
    """A daily run whose ONLY failure is disk -> summary severity == warning.
    Per-instance fail events (emit_per_instance_health_failures) are unaffected
    and still critical, but disk is not a per-instance prefix so no per-instance
    event fires here — only the summary event exists, at warning severity.
    """
    state_dir, outbox_dir = dirs
    env = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        # Dry-run disk with critically low free space (1 byte free of 1GB total)
        "BOT_ERRORS_DRY_DISK_FREE_BYTES": "1",
        "BOT_ERRORS_DRY_DISK_TOTAL_BYTES": str(1 * 1024 * 1024 * 1024),
        # Suppress all other checks that could produce failures
        "BOT_ERRORS_DRY_CLOCK_STATUS": "synced",
        "BOT_ERRORS_DRY_UPTIME_SECONDS": "3600",
        "BOT_ERRORS_HEALTH_PROFILE_JSON": json.dumps({
            "role": "f7-disk-only",
            "expectDispatcher": False,
            "expectQLoop": False,
            "expectPersonalSocket": False,
            "expectPersonalTools": False,
            "expectConfigInventory": False,
            "expectPluginInventory": False,
            "expectRuntimeManifest": False,
            "expectAlertTarget": False,
        }),
    }
    mod = _load_health(state_dir, outbox_dir)
    backup = {k: os.environ.get(k) for k in env}
    for k, v in env.items():
        os.environ[k] = v
    try:
        mod.daily()
    finally:
        for k, orig in backup.items():
            if orig is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = orig

    events = _outbox_events(outbox_dir)
    summary_events = [e for e in events if e.get("source") == "daily-health"]
    assert len(summary_events) == 1, f"Expected 1 daily-health summary event, got {len(summary_events)}"
    summary = summary_events[0]
    assert summary["severity"] == "warning", (
        f"Disk-only failure should produce summary severity='warning', got {summary['severity']!r}. "
        f"Evidence: {summary.get('evidence', '')[:400]}"
    )
    # Must not be info — there IS a failure
    assert summary["severity"] != "info"


# ---------------------------------------------------------------------------
# T4: integration — auth_bond failure (alone and mixed) stays critical
# ---------------------------------------------------------------------------

def test_auth_bond_failure_alone_is_critical_summary(dirs):
    """daily_summary_severity with auth_bond failure alone -> critical."""
    # Test the pure function directly (auth_bond = non-infra)
    failures = ["FAIL auth_bond line-a: lost"]
    result = daily_summary_severity(failures, [])
    assert result == "critical", f"auth_bond alone must be critical, got {result!r}"


def test_mixed_disk_and_auth_bond_is_critical_summary(dirs):
    """daily_summary_severity with mixed disk+auth_bond -> critical (not downgraded)."""
    failures = [
        "FAIL disk: low free_bytes=100",
        "FAIL auth_bond line-a: lost",
    ]
    result = daily_summary_severity(failures, [])
    assert result == "critical", f"mixed disk+auth_bond must be critical, got {result!r}"


# ---------------------------------------------------------------------------
# T5: emit_per_instance_health_failures still fires critical events (safety check)
# ---------------------------------------------------------------------------

def test_emit_per_instance_health_failures_always_critical(dirs):
    """emit_per_instance_health_failures fires critical force-notify events regardless
    of the summary severity. This is the safety proof that downgrading the summary
    to warning for infra-only failures does NOT lose per-instance alerts."""
    state_dir, outbox_dir = dirs
    health = _load_health(state_dir, outbox_dir)
    backup = {
        "BOT_ERRORS_STATE_DIR": os.environ.get("BOT_ERRORS_STATE_DIR"),
        "BOT_ERRORS_OUTBOX_DIR": os.environ.get("BOT_ERRORS_OUTBOX_DIR"),
    }
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    os.environ["BOT_ERRORS_OUTBOX_DIR"] = str(outbox_dir)
    try:
        # This is a per-instance fail line (config is in _INSTANCE_FAIL_PREFIXES)
        paths = health.emit_per_instance_health_failures([
            "FAIL config line-a: missing required tokens.env",
        ])
    finally:
        for k, orig in backup.items():
            if orig is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = orig

    assert len(paths) == 1
    event = json.loads(Path(paths[0]).read_text())
    assert event["severity"] == "critical"
    assert event["source"] == "daily-health-fail"
    assert event["diagnostics"]["forceNotify"] is True
