"""Tests for #2476: prove loaded generation matches deployed bundle after heal.

Exercises the REAL bot-errors-selfcheck.py module (no local replicas) with the
real service_status vocabulary: active=OK, unknown=skip, loaded/inactive/rc=N=STALE.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-selfcheck.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_selfcheck_2476", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _deps(status_fn):
    return _mod.SelfcheckDeps(
        commit_exists=lambda _sha: True,
        deploy=lambda *_a: (0, ""),
        runtime_verify=lambda *_a: (0, ""),
        push_heartbeat=lambda hb: hb,
        now_epoch=lambda: 1000.0,
        hostname=lambda: "test-host",
        service_status=status_fn,
    )


def test_active_passes(tmp_path: Path):
    """All services active → generation matches."""
    ok, reason = _mod.prove_loaded_generation(tmp_path, _deps(lambda _u: "active"))
    assert ok is True
    assert reason == "ok"


def test_loaded_is_stale(tmp_path: Path):
    """A service with plist present but NOT running (loaded) fails."""
    ok, reason = _mod.prove_loaded_generation(tmp_path, _deps(lambda _u: "loaded"))
    assert ok is False
    assert reason.startswith("generation_mismatch:")
    assert reason.endswith("=loaded")


def test_inactive_is_stale(tmp_path: Path):
    """A stopped service fails."""
    ok, reason = _mod.prove_loaded_generation(tmp_path, _deps(lambda _u: "inactive"))
    assert ok is False
    assert reason.endswith("=inactive")


def test_unknown_skips(tmp_path: Path):
    """Unknown status = no hook available, skip."""
    ok, reason = _mod.prove_loaded_generation(tmp_path, _deps(lambda _u: "unknown"))
    assert ok is True
    assert reason == "ok"


def test_first_stale_unit_named(tmp_path: Path):
    """The first non-active unit stops iteration and is named in the reason."""
    services = list(_mod._HEALED_SERVICES)
    assert len(services) >= 2, "vocabulary test expects at least two healed services"
    statuses = {services[1]: "rc=3"}
    ok, reason = _mod.prove_loaded_generation(
        tmp_path, _deps(lambda u: statuses.get(u, "active"))
    )
    assert ok is False
    assert reason == f"generation_mismatch:{services[1]}=rc=3"
