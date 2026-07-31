"""Tests for typed active-service inventory observation (#2486).

The old ``active_whatsoup_service_names()`` returned a bare ``set[str]`` —
an observation failure (missing binary, timeout, nonzero exit, malformed
output, unsupported platform) was indistinguishable from a genuine
zero-service observation, silently masking the detector.

``observe_active_services()`` returns a ``ServiceInventoryObservation`` with
a discriminated ``status`` so the profile-coverage consumer can fail-closed
on any non-``observed`` result.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader (mirrors test_bot_errors_daily_health_saliency.py)
# ---------------------------------------------------------------------------

_SCRIPTS = Path(__file__).resolve().parents[1]
_HEALTH_SCRIPT = _SCRIPTS / "bot-errors-health-check.py"


def _load_module(name: str, script: Path, extra_env: dict[str, str] | None = None):
    """Load a module with env vars active during exec_module."""
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location(name, script)
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


class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = ""):
        self.returncode = returncode
        self.stdout = stdout


def _fake_run_factory(
    returncode: int = 0, stdout: str = "", exc: Exception | None = None
):
    def _fake_run(*args, **kwargs):
        if exc is not None:
            raise exc
        return _FakeProc(returncode, stdout)

    return _fake_run


@pytest.fixture()
def mod():
    """Load the health-check module on a Linux host (systemd backend)."""
    return _load_module(
        "health_obs_linux", _HEALTH_SCRIPT, {"BOT_ERRORS_DRY_PLATFORM": "linux"}
    )


# ---------------------------------------------------------------------------
# service_manager_backend — canonical platform resolver
# ---------------------------------------------------------------------------


class TestServiceManagerBackend:
    def test_macos_routes_to_launchctl(self, mod):
        mod.HOST_PLATFORM = "darwin"
        assert mod.service_manager_backend() == "launchctl"

    def test_linux_routes_to_systemd(self, mod):
        mod.HOST_PLATFORM = "linux"
        assert mod.service_manager_backend() == "systemd"

    def test_wsl_routes_to_systemd_not_launchctl(self, mod):
        """WSL must use systemd, never the macOS launchctl binary (#2486)."""
        mod.HOST_PLATFORM = "linux"
        # Even with WSL evidence present, backend is systemd.
        assert mod.service_manager_backend() == "systemd"

    def test_unknown_platform_is_unsupported(self, mod):
        mod.HOST_PLATFORM = "freebsd"
        assert mod.service_manager_backend() == "unsupported"


# ---------------------------------------------------------------------------
# observe_active_services — typed result contract
# ---------------------------------------------------------------------------


class TestObserveActiveServicesDryOverride:
    def test_dry_override_returns_observed_with_names(self, mod, monkeypatch):
        monkeypatch.setenv(
            "BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES",
            "com.whatsoup.alpha,com.whatsoup.beta",
        )
        obs = mod.observe_active_services()
        assert obs.status == "observed"
        assert obs.observed_count == 2
        assert obs.names == frozenset({"alpha", "beta"})

    def test_dry_override_strips_com_whatsoup_prefix(self, mod, monkeypatch):
        monkeypatch.setenv(
            "BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", "com.whatsoup.line-a"
        )
        obs = mod.observe_active_services()
        assert obs.names == frozenset({"line-a"})

    def test_dry_empty_string_is_observed_zero(self, mod, monkeypatch):
        """A successful observation of zero services must be 'observed' (#2486)."""
        monkeypatch.setenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", "")
        obs = mod.observe_active_services()
        assert obs.status == "observed"
        assert obs.observed_count == 0
        assert obs.names == frozenset()

    def test_observed_carries_freshness_timestamp(self, mod, monkeypatch):
        monkeypatch.setenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", "")
        obs = mod.observe_active_services()
        assert obs.observed_at  # non-empty ISO-8601
        assert "T" in obs.observed_at


class TestObserveActiveServicesFailurePaths:
    def test_unsupported_platform_is_unsupported_status(self, mod, monkeypatch):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_MANAGER", "unsupported")
        obs = mod.observe_active_services()
        assert obs.status == "unsupported"
        assert obs.observed_count == 0
        assert obs.backend == "unsupported"

    def test_binary_not_found_is_unavailable(self, mod, monkeypatch):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_MANAGER", raising=False)
        monkeypatch.setattr(
            mod.subprocess,
            "run",
            _fake_run_factory(exc=FileNotFoundError("no launchctl")),
        )
        obs = mod.observe_active_services()
        assert obs.status == "unavailable"
        assert obs.error_class == "binary_not_found"

    def test_timeout_is_timeout_status(self, mod, monkeypatch):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_MANAGER", raising=False)
        monkeypatch.setattr(
            mod.subprocess,
            "run",
            _fake_run_factory(exc=subprocess.TimeoutExpired(cmd=[], timeout=3)),
        )
        obs = mod.observe_active_services()
        assert obs.status == "timeout"
        assert obs.error_class == "discovery_timeout_3s"

    def test_nonzero_exit_is_command_failed(self, mod, monkeypatch):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_MANAGER", raising=False)
        monkeypatch.setattr(
            mod.subprocess, "run", _fake_run_factory(returncode=1, stdout="")
        )
        obs = mod.observe_active_services()
        assert obs.status == "command_failed"
        assert obs.exit_code == 1
        assert obs.error_class == "nonzero_exit"

    def test_malformed_binary_output_is_malformed(self, mod, monkeypatch):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_MANAGER", raising=False)
        monkeypatch.setattr(
            mod.subprocess, "run", _fake_run_factory(stdout="ok\x00garbage\x00")
        )
        obs = mod.observe_active_services()
        assert obs.status == "malformed"
        assert obs.error_class == "binary_or_control_chars_in_output"


class TestObserveActiveServicesLiveParsing:
    def test_launchctl_output_parsed_to_observed(self, mod, monkeypatch):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_MANAGER", "launchctl")
        launchctl_out = (
            "PID	Status	Label\n"
            "123	0	com.whatsoup.alpha\n"
            "456	0	com.whatsoup.beta\n"
            "-	0	com.apple.something\n"
            "789	0	com.whatsoup.alpha\n"  # duplicate -> deduped
        )
        monkeypatch.setattr(
            mod.subprocess, "run", _fake_run_factory(stdout=launchctl_out)
        )
        obs = mod.observe_active_services()
        assert obs.status == "observed"
        assert obs.names == frozenset({"alpha", "beta"})
        assert obs.observed_count == 2  # deduped

    def test_systemd_output_parsed_to_observed(self, mod, monkeypatch):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_MANAGER", raising=False)
        mod.HOST_PLATFORM = "linux"
        systemd_out = (
            "whatsoup@alpha.service loaded active running\n"
            "whatsoup@beta.service  loaded active running\n"
            "other.service          loaded active running\n"
        )
        monkeypatch.setattr(
            mod.subprocess, "run", _fake_run_factory(stdout=systemd_out)
        )
        obs = mod.observe_active_services()
        assert obs.status == "observed"
        assert obs.names == frozenset({"alpha", "beta"})

    def test_valid_zero_whatsoup_services_is_observed(self, mod, monkeypatch):
        """launchctl output with no whatsoup entries is a valid observed zero."""
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_MANAGER", "launchctl")
        monkeypatch.setattr(
            mod.subprocess, "run", _fake_run_factory(stdout="123 0 com.apple.foo\n")
        )
        obs = mod.observe_active_services()
        assert obs.status == "observed"
        assert obs.observed_count == 0


# ---------------------------------------------------------------------------
# unprofiled_service_inventory — fail-closed consumer
# ---------------------------------------------------------------------------


class TestUnprofiledServiceInventoryFailClosed:
    def test_observation_failure_emits_profile_coverage_observation(
        self, mod, monkeypatch, tmp_path
    ):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_MANAGER", "unsupported")
        lines = mod.unprofiled_service_inventory(tmp_path, set())
        assert len(lines) == 1
        assert "FAIL profile_coverage_observation" in lines[0]
        assert "status=unsupported" in lines[0]

    def test_timeout_emits_non_green(self, mod, monkeypatch, tmp_path):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_MANAGER", raising=False)
        monkeypatch.setattr(
            mod.subprocess,
            "run",
            _fake_run_factory(exc=subprocess.TimeoutExpired(cmd=[], timeout=3)),
        )
        lines = mod.unprofiled_service_inventory(tmp_path, set())
        assert any(
            "FAIL profile_coverage_observation status=timeout" in l for l in lines
        )

    def test_command_failed_emits_non_green(self, mod, monkeypatch, tmp_path):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_MANAGER", raising=False)
        monkeypatch.setattr(
            mod.subprocess, "run", _fake_run_factory(returncode=2, stdout="")
        )
        lines = mod.unprofiled_service_inventory(tmp_path, set())
        assert any("status=command_failed" in l and "exit_code=2" in l for l in lines)


class TestUnprofiledServiceInventoryPositiveDetection:
    def test_undeclared_service_still_detected(self, mod, monkeypatch, tmp_path):
        """Positive detection is preserved after the result-contract change (#2486)."""
        monkeypatch.setenv(
            "BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", "com.whatsoup.rogue"
        )
        lines = mod.unprofiled_service_inventory(tmp_path, set())
        assert any("FAIL profile_coverage_service rogue" in l for l in lines)

    def test_known_service_not_flagged(self, mod, monkeypatch, tmp_path):
        monkeypatch.setenv(
            "BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", "com.whatsoup.fleet"
        )
        lines = mod.unprofiled_service_inventory(tmp_path, {"fleet"})
        assert not any("profile_coverage_service" in l for l in lines)

    def test_support_names_not_flagged(self, mod, monkeypatch, tmp_path):
        monkeypatch.setenv(
            "BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", "com.whatsoup.dashboard"
        )
        lines = mod.unprofiled_service_inventory(tmp_path, set())
        assert not any("profile_coverage_service" in l for l in lines)


# ---------------------------------------------------------------------------
# Privacy — no service names or secrets in observation-failure receipts
# ---------------------------------------------------------------------------


class TestPrivacyReceipts:
    def test_observation_fail_line_has_no_service_names(
        self, mod, monkeypatch, tmp_path
    ):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_MANAGER", "unsupported")
        lines = mod.unprofiled_service_inventory(tmp_path, set())
        fail_line = lines[0]
        # Metadata only: status/backend/count/freshness — no names.
        assert "com.whatsoup" not in fail_line
        assert "service=" not in fail_line.replace("observed_at=", "")

    def test_observation_fail_line_has_no_paths_or_accounts(
        self, mod, monkeypatch, tmp_path
    ):
        monkeypatch.delenv("BOT_ERRORS_DRY_ACTIVE_WHATSOUP_SERVICES", raising=False)
        monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_MANAGER", "unsupported")
        lines = mod.unprofiled_service_inventory(tmp_path, set())
        fail_line = lines[0]
        assert "config_exists" not in fail_line
        assert "/home/" not in fail_line
        assert "token" not in fail_line.lower()
