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


# ---------------------------------------------------------------------------
# Case 5: the inventory's expected is a legal "blocked", but the deployed
# profile's own expected is something else entirely (e.g. "none"). The
# profile side must be validated too -- only blocked->always_on is a legal
# transition on EITHER surface -- and a healthPort is present here so an
# unfixed writer that only checks the inventory would actually mutate and
# write both files instead of raising.
# ---------------------------------------------------------------------------


def test_profile_expected_outside_legal_states_fails_closed(tmp_path: Path):
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
    profile_path = _write_profile(
        profiles_dir,
        "h1.json",
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "none",
                    "service": "com.whatsoup.svc1",
                }
            ],
        },
    )
    inventory_before = inventory_path.read_bytes()
    profile_before = profile_path.read_bytes()

    with pytest.raises(mod.CutoverError, match="profile"):
        mod.restore_service_to_always_on(
            "h1", "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
        )

    assert inventory_path.read_bytes() == inventory_before
    assert profile_path.read_bytes() == profile_before


# ---------------------------------------------------------------------------
# Case 6: the inventory instance has no healthPort, but the deployed
# profile's instance does -- the repair must succeed, source the port from
# the profile, and end up with that port in BOTH files.
# ---------------------------------------------------------------------------


def test_health_port_sourced_from_profile_when_inventory_lacks_it(tmp_path: Path):
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
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9100,
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
        "healthPort": 9100,
        "inventoryRepaired": True,
        "profileRepaired": True,
    }

    inventory_after = json.loads(inventory_path.read_text(encoding="utf-8"))
    inv_instance = inventory_after["hosts"][0]["instances"][0]
    assert inv_instance["healthPort"] == 9100
    assert inv_instance["expected"] == "always_on"

    profile_after = json.loads(profile_path.read_text(encoding="utf-8"))
    prof_instance = profile_after["instances"][0]
    assert prof_instance["healthPort"] == 9100
    assert prof_instance["expected"] == "always_on"


# ---------------------------------------------------------------------------
# Case 7/8: asymmetric repair -- one surface is already "always_on" while
# the other is still "blocked". The summary flags must report which surface
# actually flipped, and both files must end up "always_on" regardless.
# ---------------------------------------------------------------------------


def test_asymmetric_repair_inventory_already_always_on(tmp_path: Path):
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
                        "expected": "always_on",
                        "service": "com.whatsoup.svc1",
                        "healthPort": 9099,
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
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    summary = mod.restore_service_to_always_on(
        "h1", "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
    )

    assert summary["inventoryRepaired"] is False
    assert summary["profileRepaired"] is True

    inventory_after = json.loads(inventory_path.read_text(encoding="utf-8"))
    assert inventory_after["hosts"][0]["instances"][0]["expected"] == "always_on"

    profile_after = json.loads(profile_path.read_text(encoding="utf-8"))
    assert profile_after["instances"][0]["expected"] == "always_on"


# ---------------------------------------------------------------------------
# cutover_gate (#1866 Task 2): a fail-closed post-cutover CHECK, distinct
# from the repair writer above. It never mutates either surface; it only
# reports whether a "live" instance (per an injected ``live_probe``) is
# ACTUALLY visible to monitoring on every surface monitoring reads:
#   1. the checked-in inventory's ``expected``,
#   2. the deployed profile's ``expected``,
#   3. ``healthPort`` metadata present on BOTH surfaces, and
#   4. the real monitor membership predicate (``expected == "always_on" and
#      service``, mirroring ``expected_local_instances()`` in
#      bot-errors-heartbeat-watchdog.py:706-730).
# All four must agree for ok=True; any disagreement while the probe reports
# active+healthy is an itemized failure. A probe reporting not-active or
# not-healthy short-circuits to ok=True -- a stopped, never-restored
# service is not a false alert.
# ---------------------------------------------------------------------------


def _probe(active: bool, healthy: bool):
    def _live_probe(host: str, name: str) -> dict:
        return {"active": active, "healthy": healthy}

    return _live_probe


def test_gate_a_active_healthy_still_blocked_fails_closed(tmp_path: Path):
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
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    result = mod.cutover_gate(
        "h1",
        "svc1",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        live_probe=_probe(active=True, healthy=True),
    )

    assert result.ok is False
    lowered = [f.lower() for f in result.failures]
    assert any("inventory" in f for f in lowered)
    assert any("profile" in f for f in lowered)
    assert any("membership" in f for f in lowered)
    # healthPort agrees on both surfaces (9099/9099) -- that check must NOT
    # also fire, or a broken check 3 would silently pad the failure list.
    assert not any("healthport" in f for f in lowered)
    assert len(result.failures) == 3


def test_gate_b_after_restore_passes_with_no_failures(tmp_path: Path):
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
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    mod.restore_service_to_always_on(
        "h1", "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
    )

    result = mod.cutover_gate(
        "h1",
        "svc1",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        live_probe=_probe(active=True, healthy=True),
    )

    assert result.ok is True
    assert result.failures == []


def test_gate_c_genuinely_blocked_probe_inactive_no_false_alert(tmp_path: Path):
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
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    result = mod.cutover_gate(
        "h1",
        "svc1",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        live_probe=_probe(active=False, healthy=False),
    )

    assert result.ok is True
    assert result.failures == []


def test_gate_d_inventory_profile_divergence_fails_closed(tmp_path: Path):
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
                        "expected": "always_on",
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
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    result = mod.cutover_gate(
        "h1",
        "svc1",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        live_probe=_probe(active=True, healthy=True),
    )

    assert result.ok is False
    lowered = [f.lower() for f in result.failures]
    assert any("profile" in f for f in lowered)
    # inventory itself already agrees -- it must NOT be named.
    assert not any("inventory expected" in f for f in lowered)


def test_gate_e_missing_health_port_in_profile_fails_closed(tmp_path: Path):
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
                        "expected": "always_on",
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
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "always_on",
                    "service": "com.whatsoup.svc1",
                }
            ],
        },
    )

    result = mod.cutover_gate(
        "h1",
        "svc1",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        live_probe=_probe(active=True, healthy=True),
    )

    assert result.ok is False
    lowered = [f.lower() for f in result.failures]
    assert any("healthport" in f for f in lowered)
    assert len(result.failures) == 1


def test_gate_f_raising_live_probe_fails_closed(tmp_path: Path):
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
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    def _raising_probe(host: str, name: str) -> dict:
        raise RuntimeError("probe-boom-9099")

    result = mod.cutover_gate(
        "h1",
        "svc1",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        live_probe=_raising_probe,
    )

    assert result.ok is False
    assert result.failures != []
    assert any("probe-boom-9099" in f for f in result.failures)


def test_gate_g_malformed_profile_json_fails_closed(tmp_path: Path):
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
    profiles_dir.mkdir(parents=True, exist_ok=True)
    profile_path = profiles_dir / "h1.json"
    profile_path.write_text("{not valid json", encoding="utf-8")

    result = mod.cutover_gate(
        "h1",
        "svc1",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        # active+healthy so a broken fail-closed contract that somehow
        # limped past the malformed profile would have something to
        # disagree about -- proving ok=False came from the JSON parse
        # failure, not from an inert probe result.
        live_probe=_probe(active=True, healthy=True),
    )

    assert result.ok is False
    lowered = [f.lower() for f in result.failures]
    assert any("parse" in f for f in lowered)
    assert any("json" in f for f in lowered)


def test_gate_h_absent_instance_fails_closed(tmp_path: Path):
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
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "blocked",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    result = mod.cutover_gate(
        "h1",
        "does-not-exist",
        inventory_path=inventory_path,
        profiles_dir=profiles_dir,
        live_probe=_probe(active=True, healthy=True),
    )

    assert result.ok is False
    lowered = [f.lower() for f in result.failures]
    assert any("not found" in f for f in lowered)
    assert any("does-not-exist" in f for f in lowered)


def test_asymmetric_repair_profile_already_always_on(tmp_path: Path):
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
    profile_path = _write_profile(
        profiles_dir,
        "h1.json",
        {
            "role": "bot-host",
            "instances": [
                {
                    "name": "svc1",
                    "expected": "always_on",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    summary = mod.restore_service_to_always_on(
        "h1", "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
    )

    assert summary["inventoryRepaired"] is True
    assert summary["profileRepaired"] is False

    inventory_after = json.loads(inventory_path.read_text(encoding="utf-8"))
    assert inventory_after["hosts"][0]["instances"][0]["expected"] == "always_on"

    profile_after = json.loads(profile_path.read_text(encoding="utf-8"))
    assert profile_after["instances"][0]["expected"] == "always_on"


# ---------------------------------------------------------------------------
# Case 9: idempotent rerun -- both surfaces are ALREADY "always_on" (e.g. the
# operator reruns the repair after a previous successful call, or after the
# cutover_gate above already reported ok=True). Neither flip flag should
# claim a repair happened, and both files must still read "always_on"
# afterward -- a rerun must be a safe no-op flip-wise, not a divergence.
# ---------------------------------------------------------------------------


def test_rerun_when_both_surfaces_already_always_on_is_a_noop(tmp_path: Path):
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
                        "expected": "always_on",
                        "service": "com.whatsoup.svc1",
                        "healthPort": 9099,
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
            "instances": [
                {
                    "name": "svc1",
                    "expected": "always_on",
                    "service": "com.whatsoup.svc1",
                    "healthPort": 9099,
                }
            ],
        },
    )

    summary = mod.restore_service_to_always_on(
        "h1", "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
    )

    assert summary["inventoryRepaired"] is False
    assert summary["profileRepaired"] is False
    assert summary["healthPort"] == 9099

    inventory_after = json.loads(inventory_path.read_text(encoding="utf-8"))
    assert inventory_after["hosts"][0]["instances"][0]["expected"] == "always_on"
    assert inventory_after["hosts"][0]["instances"][0]["healthPort"] == 9099

    profile_after = json.loads(profile_path.read_text(encoding="utf-8"))
    assert profile_after["instances"][0]["expected"] == "always_on"
    assert profile_after["instances"][0]["healthPort"] == 9099
