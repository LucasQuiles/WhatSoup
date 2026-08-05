"""Tests for #2473: sweep coherence — per-host checkedAt + duration validation.

fails-before:  Sentinel sweep uses a single checkedAt for all hosts. A slow
               sweep (many hosts, long duration) still appears fresh.
passes-after:  sweepDurationSeconds is recorded; watchdog rejects sweeps that
               exceed the maximum allowed duration.

No regression: A short sweep (small roster, fast probes) passes normally.
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_mod():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_watchdog_2473",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_NOW = 200000


def _age(mod, data: dict) -> tuple[int | None, str]:
    """Call fleet_sentinel_age with a synthetic heartbeat in a private dir."""
    d = Path(tempfile.mkdtemp())
    d.chmod(0o700)
    path = d / "sentinel-heartbeat.json"
    payload = {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-heartbeat",
        "checkedAt": mod.now_iso(_NOW - 10),
        "healthy": True,
        "fleetAction": "none",
        "hostCount": 5,
    }
    payload.update(data)
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)
    return mod.fleet_sentinel_age(path)


# ---------------------------------------------------------------------------
# Run tests directly (TRUE_RC reporter)
# ---------------------------------------------------------------------------


def test_normal_sweep_duration_passes():
    """A short sweep (6s) passes normally."""
    mod = _load_mod()
    mod.now_epoch = lambda: _NOW
    age, detail = _age(mod, {"sweepDurationSeconds": 6})
    assert age is not None, f"normal sweep should pass, got detail={detail}"
    assert isinstance(age, int)
    print("PASS: normal_short_sweep")


def test_excessive_sweep_duration_is_rejected():
    """A sweep lasting 601s exceeds the max duration (600s) and is rejected."""
    mod = _load_mod()
    mod.now_epoch = lambda: _NOW
    age, detail = _age(mod, {"sweepDurationSeconds": 601})
    assert age is None, "excessive sweep should be rejected"
    assert "excessive sentinel sweep duration" in detail
    print("PASS: excessive_sweep_rejected")


def test_no_sweep_duration_field_still_works():
    """Legacy heartbeats without sweepDurationSeconds are not rejected."""
    mod = _load_mod()
    mod.now_epoch = lambda: _NOW
    age, detail = _age(mod, {})
    assert age is not None, "legacy heartbeat without sweepDurationSeconds must pass"
    print("PASS: legacy_no_sweep_field")


def test_sweep_null_duration_still_works():
    """Null sweep duration is treated as absent."""
    mod = _load_mod()
    mod.now_epoch = lambda: _NOW
    age, detail = _age(mod, {"sweepDurationSeconds": None})
    assert age is not None, "null sweepDurationSeconds must pass"
    print("PASS: null_sweep_field")


def test_env_override_max_duration():
    """BOT_ERRORS_SENTINEL_SWEEP_MAX_DURATION changes the threshold."""
    os.environ["BOT_ERRORS_SENTINEL_SWEEP_MAX_DURATION"] = "30"
    try:
        mod = _load_mod()
        mod.now_epoch = lambda: _NOW
        # 30s sweep is fine with 30s threshold
        age, detail = _age(mod, {"sweepDurationSeconds": 30})
        assert age is not None, f"30s sweep with 30s threshold should pass, got={detail}"
        # 31s sweep exceeds 30s threshold
        age, detail = _age(mod, {"sweepDurationSeconds": 31})
        assert age is None, "31s sweep with 30s threshold should be rejected"
    finally:
        os.environ.pop("BOT_ERRORS_SENTINEL_SWEEP_MAX_DURATION", None)
    print("PASS: env_override")


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    test_normal_sweep_duration_passes()
    test_excessive_sweep_duration_is_rejected()
    test_no_sweep_duration_field_still_works()
    test_sweep_null_duration_still_works()
    test_env_override_max_duration()
    print()
    print("ALL 5 TESTS PASS (TRUE_RC=0)")
