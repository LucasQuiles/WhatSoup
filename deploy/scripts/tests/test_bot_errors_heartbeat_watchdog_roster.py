"""Independent fleet-roster integrity checks in the heartbeat watchdog.

Covers #1875 (the sentinel heartbeat must be bound to the intended roster and a
roster-blind / zero-host / wrong-manifest / incomplete snapshot must be rejected
as not-green) and #1880 (the watchdog independently compares the collector's
configured remotes against the tracked collectorRemote:true roster so an
omission is visible, without exposing private identifiers).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog_roster",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _load_roster_lib():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_roster", _SCRIPT_ROOT / "lib" / "bot_errors_roster.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_roster_lib = _load_roster_lib()

_NOW = 100000


def _args() -> SimpleNamespace:
    return SimpleNamespace(
        max_q_loop_age=600,
        max_dispatcher_age=300,
        max_collector_age=180,
        max_daily_health_age=25 * 60 * 60,
        max_fleet_sentinel_age=3600,
    )


def _state(monkeypatch, tmp_path: Path) -> Path:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    monkeypatch.setenv("BOT_ERRORS_DRY_NOW", str(_NOW))
    return state


def _roster(hosts: list[dict]) -> dict:
    return {"schemaVersion": 1, "hosts": hosts}


def _write_roster(monkeypatch, tmp_path: Path, roster: dict) -> Path:
    path = tmp_path / "roster.json"
    path.write_text(json.dumps(roster), encoding="utf-8")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", str(path))
    return path


def _sample_roster() -> dict:
    return _roster(
        [
            {"host": "host-a", "role": "bot-host", "collectorRemote": True,
             "instances": [{"name": "bot-a1", "expected": "always_on", "service": "s1"}]},
            {"host": "host-b", "role": "bot-host", "collectorRemote": True,
             "instances": [{"name": "bot-b1", "expected": "always_on", "service": "s2"}]},
            {"host": "host-c", "role": "central", "collectorRemote": False,
             "instances": [{"name": "svc-x", "expected": "always_on", "service": "s3"}]},
        ]
    )


def _write_heartbeat(mod, state: Path, roster: dict, **overrides) -> Path:
    inv = _roster_lib.roster_inventory(roster)
    payload = {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-heartbeat",
        "checkedAt": mod.now_iso(_NOW - 10),
        "healthy": True,
        "fleetAction": "none",
        "hostCount": inv["expectedHostCount"],
        "problemHostCount": 0,
        "rosterDigest": inv["digest"],
        "rosterEpoch": 12345,
        "expectedHostCount": inv["expectedHostCount"],
        "observedHostCount": inv["expectedHostCount"],
        "unknownHostCount": 0,
        "expectedInstanceCount": inv["expectedInstanceCount"],
        "observedInstanceCount": inv["expectedInstanceCount"],
        "problemInstanceCount": 0,
        "unknownInstanceCount": 0,
    }
    payload.update(overrides)
    path = state / "fleet-sentinel" / "sentinel-heartbeat.json"
    mod.atomic_write_json(path, payload)
    return path


def _write_collector_state(mod, state: Path, **fields) -> Path:
    path = state / "collector-state.json"
    mod.atomic_write_json(path, {"schemaVersion": 1, **fields})
    return path


# --------------------------------------------------------------------------
# #1875 -- watchdog independently verifies the roster binding.
# --------------------------------------------------------------------------


def test_correct_roster_is_quiet(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    _write_heartbeat(mod, state, roster)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel" not in problems
    assert "fleet_sentinel:roster" not in problems


def test_roster_blind_heartbeat_is_rejected(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    # Legacy roster-blind heartbeat: fresh, current, but no roster binding at all.
    _write_heartbeat(mod, state, roster, rosterDigest=None, expectedHostCount=None)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel:roster" in problems
    assert "roster-blind" in problems["fleet_sentinel:roster"]


def test_zero_host_snapshot_is_rejected(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    _write_heartbeat(mod, state, roster, expectedHostCount=0, observedHostCount=0, hostCount=0)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel:roster" in problems
    assert "zero" in problems["fleet_sentinel:roster"].lower()


def test_wrong_manifest_digest_mismatch_is_rejected(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    # Heartbeat built from a DIFFERENT (truncated) roster than the independent one.
    truncated = _roster(roster["hosts"][:1])
    _write_heartbeat(mod, state, truncated)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel:roster" in problems
    assert "digest mismatch" in problems["fleet_sentinel:roster"]


def test_dropped_host_accounting_gap_is_rejected(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    # Digest matches, but observed + unknown != expected: a roster member was
    # dropped from the snapshot entirely (expected 3, only 2 accounted for).
    _write_heartbeat(mod, state, roster, observedHostCount=1, unknownHostCount=1)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel:roster" in problems
    assert "accounting gap" in problems["fleet_sentinel:roster"]


def test_heartbeat_only_all_unknown_is_not_a_false_positive(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    # Unprobed heartbeat-only fleet: every host is unknown but fully accounted
    # for (observed 0 + unknown 3 == expected 3). The roster binding is valid, so
    # the roster check must stay quiet rather than storm every cycle.
    _write_heartbeat(mod, state, roster, observedHostCount=0, unknownHostCount=3)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel:roster" not in problems


def test_stale_roster_binding_is_rejected(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    # Sentinel bound an OLD roster; the intended roster has since gained a host.
    old_roster = _roster(_sample_roster()["hosts"][:2])
    _write_heartbeat(mod, state, old_roster)
    new_roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, new_roster)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel:roster" in problems
    assert "digest mismatch" in problems["fleet_sentinel:roster"]


def test_unreadable_independent_roster_fails_closed(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_heartbeat(mod, state, roster)
    # Point the independent roster at a missing path -> cannot verify -> reject.
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", str(tmp_path / "missing-roster.json"))
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel:roster" in problems


def test_missing_heartbeat_defers_to_age_check_not_roster(tmp_path: Path, monkeypatch):
    mod = _load_module()
    _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    # No heartbeat file at all: the age/deadman check owns absence; the roster
    # check must not double-fire.
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    assert "fleet_sentinel" in problems
    assert "fleet_sentinel:roster" not in problems


def test_roster_problem_is_privacy_safe(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    roster = _sample_roster()
    _write_roster(monkeypatch, tmp_path, roster)
    truncated = _roster(roster["hosts"][:1])
    _write_heartbeat(mod, state, truncated)
    problems = mod.collect_problems(_args(), {"fleet_sentinel"})
    message = problems["fleet_sentinel:roster"]
    # Digests are truncated, never the full 64-char hash; no roster host dump.
    assert _roster_lib.roster_inventory(roster)["digest"] not in message


# --------------------------------------------------------------------------
# #1880 -- watchdog independently detects collector-vs-roster drift.
# --------------------------------------------------------------------------


def test_collector_matches_roster_is_quiet(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    _write_roster(monkeypatch, tmp_path, _sample_roster())
    _write_collector_state(mod, state, configuredRemoteHosts=["host-a", "host-b"])
    problems = mod.collect_problems(_args(), {"collector_roster"})
    assert "collector_roster" not in problems


def test_collector_omission_is_visible(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    _write_roster(monkeypatch, tmp_path, _sample_roster())
    # host-b is a required collectorRemote:true roster host but is omitted from
    # the collector's configured remotes.
    _write_collector_state(mod, state, configuredRemoteHosts=["host-a"])
    problems = mod.collect_problems(_args(), {"collector_roster"})
    assert "collector_roster" in problems
    assert "host-b" in problems["collector_roster"]
    assert "missing" in problems["collector_roster"].lower()


def test_collector_extra_host_is_visible_without_leaking_identifier(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    _write_roster(monkeypatch, tmp_path, _sample_roster())
    # A configured remote that is not in the roster at all (potentially private).
    _write_collector_state(mod, state, configuredRemoteHosts=["host-a", "host-b", "unlisted-x"])
    problems = mod.collect_problems(_args(), {"collector_roster"})
    assert "collector_roster" in problems
    assert "extra" in problems["collector_roster"].lower()
    # The private alias must NOT appear verbatim in the drift message.
    assert "unlisted-x" not in problems["collector_roster"]


def test_optional_best_effort_host_is_not_flagged_missing(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    _write_roster(monkeypatch, tmp_path, _sample_roster())
    # host-b is omitted but declared best-effort/optional -> not a drift.
    _write_collector_state(
        mod,
        state,
        configuredRemoteHosts=["host-a"],
        configuredBestEffortRemoteHosts=["host-b"],
    )
    problems = mod.collect_problems(_args(), {"collector_roster"})
    assert "collector_roster" not in problems


def test_collector_state_unreadable_is_explicit_drift(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    _write_roster(monkeypatch, tmp_path, _sample_roster())
    # Present but corrupt collector-state -> config-unreadable drift.
    path = state / "collector-state.json"
    path.write_text("{not json", encoding="utf-8")
    os.chmod(path, 0o600)
    problems = mod.collect_problems(_args(), {"collector_roster"})
    assert "collector_roster" in problems
    assert "unreadable" in problems["collector_roster"].lower()


def test_collector_state_missing_defers_to_collector_age(tmp_path: Path, monkeypatch):
    mod = _load_module()
    _state(monkeypatch, tmp_path)
    _write_roster(monkeypatch, tmp_path, _sample_roster())
    # No collector-state at all: the collector freshness check owns absence.
    problems = mod.collect_problems(_args(), {"collector_roster"})
    assert "collector_roster" not in problems


def test_stale_roster_for_collector_comparison_fails_closed(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _state(monkeypatch, tmp_path)
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", str(tmp_path / "missing-roster.json"))
    _write_collector_state(mod, state, configuredRemoteHosts=["host-a"])
    problems = mod.collect_problems(_args(), {"collector_roster"})
    assert "collector_roster" in problems


# --------------------------------------------------------------------------
# #1866 Task 3 -- membership follows repaired declaration (monitor code is
# UNCHANGED). expected_local_services() reads ONLY the deployed per-host
# profile (BOT_ERRORS_HEALTH_PROFILE / health_profile_path()) -- it never
# consults the inventory. restore_service_to_always_on() (bot_errors_cutover.py,
# Task 1) is the ONE authoritative writer that repairs BOTH the inventory and
# the deployed profile in one call; this proves the watchdog's target-set
# picks svc1 up purely because that profile-side declaration flipped from
# "blocked" to "always_on" -- no watchdog code changed.
# --------------------------------------------------------------------------


def _load_cutover_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_cutover_for_watchdog_roster", _SCRIPT_ROOT / "bot_errors_cutover.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _write_task3_inventory(tmp_path: Path, host: str, profile_filename: str, instance: dict) -> Path:
    path = tmp_path / "bot-errors-expected-fleet.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "hosts": [
                    {
                        "host": host,
                        "role": "bot-host",
                        "guiSessionExpected": "always_aqua",
                        "profile": profile_filename,
                        "collectorRemote": True,
                        "instances": [instance],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


def _write_task3_profile(profiles_dir: Path, filename: str, instance: dict) -> Path:
    profiles_dir.mkdir(parents=True, exist_ok=True)
    path = profiles_dir / filename
    path.write_text(
        json.dumps({"role": "bot-host", "instances": [instance]}),
        encoding="utf-8",
    )
    return path


def test_expected_local_services_follows_repaired_declaration(tmp_path: Path, monkeypatch):
    mod = _load_module()
    cutover_mod = _load_cutover_module()

    host = "h1"
    profile_filename = "h1.json"
    inventory_path = _write_task3_inventory(
        tmp_path,
        host,
        profile_filename,
        {
            "name": "svc1",
            "expected": "blocked",
            "service": "com.whatsoup.svc1",
            "healthPort": 9099,
            "reason": "Service is unloaded/down pending Lucas approval to bootstrap",
        },
    )
    profiles_dir = tmp_path / "health-profiles"
    profile_path = _write_task3_profile(
        profiles_dir,
        profile_filename,
        {
            "name": "svc1",
            "expected": "blocked",
            "service": "com.whatsoup.svc1",
            "reason": "Service is unloaded/down pending Lucas approval to bootstrap",
        },
    )
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(profile_path))

    # Pre-repair: svc1 is declared blocked in the deployed profile -- NOT a
    # monitor target.
    pre_names = {item["name"] for item in mod.expected_local_services()}
    assert "svc1" not in pre_names

    # Repair the declaration via the ONE authoritative writer (#1866 Task 1) --
    # no watchdog code changes; membership must follow the repaired declaration.
    cutover_mod.restore_service_to_always_on(
        host, "svc1", inventory_path=inventory_path, profiles_dir=profiles_dir
    )

    post_names = {item["name"] for item in mod.expected_local_services()}
    assert "svc1" in post_names
