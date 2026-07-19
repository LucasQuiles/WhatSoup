"""Tests for the authoritative blocked->always_on cutover-repair writer (#1866).

A restored fleet service can stay declared ``expected: "blocked"`` in two
independent JSON surfaces even after it comes back up: the checked-in
inventory (``deploy/bot-errors-expected-fleet.json``) and the deployed
per-host profile (``deploy/health-profiles/<host>.json``). Monitoring reads
both, so a partial repair (one file fixed, the other stale) still hides the
service from monitoring. ``restore_service_to_always_on`` is the ONE writer
that repairs both files, in one call, or repairs neither.

Fixture shapes below mirror the real files as read from
``deploy/bot-errors-expected-fleet.json`` and
``deploy/health-profiles/mini1.json`` / ``mini2.json`` before writing these
tests: the inventory host record carries ``host``, ``role``,
``guiSessionExpected``, ``profile`` (the deployed profile's filename),
``collectorRemote``, and ``instances[]``; each instance carries ``name``,
``expected``, ``service``, and (when known) ``healthPort``. The deployed
profile mirrors ``instances[]`` under its own ``role``/``expect*`` fields.
The real ``mini2.json`` / ``ar-bot`` entry is exactly the "blocked, no
healthPort anywhere" shape exercised by ``test_missing_health_port_fails_closed``.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_cutover", _SCRIPT_ROOT / "bot_errors_cutover.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _inventory(hosts: list[dict]) -> dict:
    return {
        "schemaVersion": 1,
        "description": "Expected BOT ERRORS monitoring fleet.",
        "hosts": hosts,
    }


def _write_inventory(tmp_path: Path, hosts: list[dict]) -> Path:
    path = tmp_path / "bot-errors-expected-fleet.json"
    path.write_text(json.dumps(_inventory(hosts), indent=2) + "\n", encoding="utf-8")
    return path


def _write_profile(profiles_dir: Path, filename: str, profile: dict) -> Path:
    profiles_dir.mkdir(parents=True, exist_ok=True)
    path = profiles_dir / filename
    path.write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Case 1: happy path -- blocked instance with a known healthPort in the
# inventory but NOT yet in the deployed profile. Both files must end up
# repaired and agree on the same healthPort.
# ---------------------------------------------------------------------------


def test_restores_blocked_service_in_both_surfaces(tmp_path: Path):
    mod = _load_module()
    inventory_path = _write_inventory(
        tmp_path,
        [
            {
                "host": "h1",
                "role": "bot-host",
                "guiSessionExpected": "always_aqua",
                "profile": "h1.json",
                "collectorRemote": True,
                "instances": [
                    {
                        "name": "svc1",
                        "expected": "blocked",
                        "service": "com.whatsoup.svc1",
                        "healthPort": 9099,
                        "reason": "Service is unloaded/down pending Lucas approval to bootstrap",
                    }
                ],
            }
        ],
    )
    profiles_dir = tmp_path / "health-profiles"
    profile_path = _write_profile(
        profiles_dir,
        "h1.json",
        {
            "role": "bot-host",
            "expectConfigInventory": True,
            "requiredConfigMaxMode": "600",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "reason": "Service is unloaded/down pending Lucas approval to bootstrap",
                }
            ],
        },
    )

    summary = mod.restore_service_to_always_on(
        "h1", "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
    )

    assert summary == {
        "host": "h1",
        "name": "svc1",
        "healthPort": 9099,
        "inventoryRepaired": True,
        "profileRepaired": True,
    }

    inventory_after = json.loads(inventory_path.read_text(encoding="utf-8"))
    inv_instance = inventory_after["hosts"][0]["instances"][0]
    assert inv_instance["expected"] == "always_on"
    assert inv_instance["healthPort"] == 9099

    profile_after = json.loads(profile_path.read_text(encoding="utf-8"))
    prof_instance = profile_after["instances"][0]
    assert prof_instance["expected"] == "always_on"
    assert prof_instance["healthPort"] == 9099


# ---------------------------------------------------------------------------
# Case 2: blocked instance with no healthPort anywhere (mirrors the real
# mini2.json / ar-bot shape) -- fail closed, and leave both files untouched.
# ---------------------------------------------------------------------------


def test_missing_health_port_fails_closed(tmp_path: Path):
    mod = _load_module()
    inventory_path = _write_inventory(
        tmp_path,
        [
            {
                "host": "mini2",
                "role": "bot-host-blocked",
                "guiSessionExpected": "not_applicable",
                "profile": "mini2.json",
                "collectorRemote": True,
                "instances": [
                    {
                        "name": "ar-bot",
                        "expected": "blocked",
                        "service": "com.whatsoup.ar-bot",
                        "reason": "Service is unloaded/down pending Lucas approval to bootstrap",
                    }
                ],
            }
        ],
    )
    profiles_dir = tmp_path / "health-profiles"
    profile_path = _write_profile(
        profiles_dir,
        "mini2.json",
        {
            "role": "bot-host-blocked",
            "expectDispatcher": False,
            "expectQLoop": False,
            "instances": [
                {
                    "name": "ar-bot",
                    "expected": "blocked",
                    "service": "com.whatsoup.ar-bot",
                    "reason": "Service is unloaded/down pending Lucas approval to bootstrap",
                }
            ],
        },
    )
    inventory_before = inventory_path.read_bytes()
    profile_before = profile_path.read_bytes()

    with pytest.raises(mod.CutoverError, match="healthPort"):
        mod.restore_service_to_always_on(
            "mini2", "ar-bot", inventory_path=inventory_path, profiles_dir=profiles_dir
        )

    assert inventory_path.read_bytes() == inventory_before
    assert profile_path.read_bytes() == profile_before


# ---------------------------------------------------------------------------
# Case 3: an instance whose expected is neither "blocked" nor "always_on"
# (e.g. "none", mirroring the real relay-only-host / "agent" entry) is left untouched
# -- only blocked->always_on is a legal transition.
# ---------------------------------------------------------------------------


def test_non_blocked_expected_is_untouched_and_rejected(tmp_path: Path):
    mod = _load_module()
    inventory_path = _write_inventory(
        tmp_path,
        [
            {
                "host": "relay-host",
                "role": "relay-only",
                "guiSessionExpected": "headless_ok",
                "profile": "relay-host.json",
                "collectorRemote": True,
                "instances": [
                    {
                        "name": "agent",
                        "expected": "none",
                        "reason": "agent launchd label not deployed; relay-only host has no bot instance",
                    }
                ],
            }
        ],
    )
    profiles_dir = tmp_path / "health-profiles"
    profile_path = _write_profile(
        profiles_dir,
        "relay-host.json",
        {
            "role": "relay-only",
            "instances": [
                {
                    "name": "agent",
                    "expected": "none",
                    "reason": "agent launchd label not deployed; relay-only host has no bot instance",
                }
            ],
        },
    )
    inventory_before = inventory_path.read_bytes()
    profile_before = profile_path.read_bytes()

    with pytest.raises(mod.CutoverError, match="none"):
        mod.restore_service_to_always_on(
            "relay-host", "agent", inventory_path=inventory_path, profiles_dir=profiles_dir
        )

    assert inventory_path.read_bytes() == inventory_before
    assert profile_path.read_bytes() == profile_before


# ---------------------------------------------------------------------------
# Case 4: absent instance -- fail closed rather than silently no-op.
# ---------------------------------------------------------------------------


def test_absent_instance_fails_closed(tmp_path: Path):
    mod = _load_module()
    inventory_path = _write_inventory(
        tmp_path,
        [
            {
                "host": "h1",
                "role": "bot-host",
                "guiSessionExpected": "always_aqua",
                "profile": "h1.json",
                "collectorRemote": True,
                "instances": [
                    {
                        "name": "svc1",
                        "expected": "blocked",
                        "service": "com.whatsoup.svc1",
                        "healthPort": 9099,
                    }
                ],
            }
        ],
    )
    profiles_dir = tmp_path / "health-profiles"
    _write_profile(
        profiles_dir,
        "h1.json",
        {"role": "bot-host", "instances": [{"name": "svc1", "expected": "blocked"}]},
    )

    with pytest.raises(mod.CutoverError):
        mod.restore_service_to_always_on(
            "h1", "does-not-exist", inventory_path=inventory_path, profiles_dir=profiles_dir
        )

    with pytest.raises(mod.CutoverError):
        mod.restore_service_to_always_on(
            "no-such-host", "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
        )
