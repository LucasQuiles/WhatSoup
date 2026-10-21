"""A rollback must not discard the cadence hold for a possibly delivered notice."""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess

import pytest


REPO = Path(__file__).resolve().parents[3]
DEPLOYER = REPO / "deploy/scripts/whatsoup-bot-errors-deploy.sh"
DISPATCHER = "deploy/scripts/bot-errors-dispatcher.py"
LEGACY_DISPATCHER = b"# Older dispatcher without uncertain side-notice holds.\n"


@pytest.fixture
def rollback_tree(tmp_path: Path):
    root = tmp_path / "runtime"
    backup = tmp_path / "backup"
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    manifest = json.loads((REPO / "deploy/bot-errors-runtime-manifest.json").read_text())
    for target in (root, backup):
        for entry in manifest["files"]:
            source = REPO / entry["path"]
            destination = target / entry["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
    (backup / ".was-absent").write_text("")
    (backup / DISPATCHER).write_bytes(LEGACY_DISPATCHER)
    environment = os.environ | {
        "BOT_ERRORS_STATE_DIR": str(state),
        "BOT_ERRORS_RUNTIME_MANIFEST_PATH": str(tmp_path / "unavailable-manifest.json"),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    return root, backup, state, environment


def write_state(directory: Path, payload: dict) -> bytes:
    data = (json.dumps(payload) + "\n").encode()
    path = directory / "incident-state.json"
    path.write_bytes(data)
    path.chmod(0o600)
    return data


def snapshot(root: Path) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


def rollback(tree, mode: str = "rollback") -> subprocess.CompletedProcess:
    root, backup, _state, environment = tree
    args = ["bash", str(DEPLOYER), mode, str(root)]
    if mode == "rollback":
        args.append(str(backup))
    else:
        (root.parent / ".bot-errors-last-known-good-runtime").write_text(str(backup) + "\n")
    return subprocess.run(args, cwd=REPO, env=environment,
                          text=True, capture_output=True, timeout=30)


@pytest.mark.parametrize("payload", [
    {"openIncidents": {"incident": {"lastStaleRenotifyUnconfirmedAt": 1700000000,
                                   "lastStaleRenotifyUnconfirmedRef": "notice-1"}}},
    {"flapState": {"incident": {"unconfirmedStorm": {"openedAt": 1700000000,
                                                      "ref": "notice-2"}}}},
])
def test_refuses_legacy_rollback_without_changing_runtime_or_uncertain_state(rollback_tree, payload):
    root, _backup, state, _environment = rollback_tree
    original_state = write_state(state, {"version": 1, "lastSentAt": {}, "openIncidents": {}, **payload})
    before = snapshot(root)
    result = rollback(rollback_tree)
    assert result.returncode != 0, result.stdout + result.stderr
    assert "ROLLBACK_INCOMPATIBLE" in result.stdout + result.stderr
    assert snapshot(root) == before
    assert (state / "incident-state.json").read_bytes() == original_state


def test_legacy_rollback_is_still_available_without_uncertain_holds(rollback_tree):
    root, _backup, state, _environment = rollback_tree
    original_state = write_state(state, {"version": 1, "lastSentAt": {}, "openIncidents": {
        "incident": {"lastStaleRenotifiedAt": 1700000000, "lastNotifiedAt": 1700000000}}})
    result = rollback(rollback_tree)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / DISPATCHER).read_bytes() == LEGACY_DISPATCHER
    assert (state / "incident-state.json").read_bytes() == original_state


def test_compatible_rollback_preserves_uncertain_holds_with_missing_manifest(rollback_tree):
    root, backup, state, _environment = rollback_tree
    shutil.copyfile(REPO / DISPATCHER, backup / DISPATCHER)
    (root / DISPATCHER).write_bytes(b"# damaged runtime\n")
    original_state = write_state(state, {"version": 1, "lastSentAt": {}, "openIncidents": {
        "incident": {"lastStaleRenotifyUnconfirmedAt": 1700000000}}})
    result = rollback(rollback_tree)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / DISPATCHER).read_bytes() == (REPO / DISPATCHER).read_bytes()
    assert (state / "incident-state.json").read_bytes() == original_state


def test_last_known_good_cannot_bypass_side_notice_compatibility(rollback_tree):
    root, _backup, state, _environment = rollback_tree
    write_state(state, {"version": 1, "lastSentAt": {}, "openIncidents": {},
                        "flapState": {"incident": {"unconfirmedStorm": {"ref": "notice-3"}}}})
    before = snapshot(root)
    result = rollback(rollback_tree, "rollback-lkg")
    assert result.returncode != 0, result.stdout + result.stderr
    assert "ROLLBACK_INCOMPATIBLE" in result.stdout + result.stderr
    assert snapshot(root) == before


def test_deploying_an_old_packet_cannot_bypass_side_notice_compatibility(rollback_tree):
    root, backup, state, environment = rollback_tree
    write_state(state, {"version": 1, "lastSentAt": {}, "openIncidents": {
        "incident": {"lastStaleRenotifyUnconfirmedAt": 1700000000}}})
    manifest = json.loads((REPO / "deploy/bot-errors-runtime-manifest.json").read_text())
    for entry in manifest["files"]:
        entry["sha256"] = hashlib.sha256((backup / entry["path"]).read_bytes()).hexdigest()
    manifest_path = root.parent / "old-packet-manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    before = snapshot(root)
    result = subprocess.run(
        ["bash", str(DEPLOYER), "deploy", str(root), str(backup)], cwd=REPO,
        env=environment | {"BOT_ERRORS_RUNTIME_MANIFEST_PATH": str(manifest_path)},
        text=True, capture_output=True, timeout=30,
    )
    assert result.returncode != 0, result.stdout + result.stderr
    assert "ROLLBACK_INCOMPATIBLE" in result.stdout + result.stderr
    assert snapshot(root) == before
    assert not list(root.parent.glob(".bot-errors-deploy-backup-*"))


def assert_unknown_state_refuses_legacy_rollback(tree):
    root, _backup, _state, _environment = tree
    before = snapshot(root)
    result = rollback(tree)
    assert result.returncode != 0, result.stdout + result.stderr
    assert "ROLLBACK_STATE_UNAVAILABLE" in result.stdout + result.stderr
    assert snapshot(root) == before


def test_malformed_state_cannot_authorize_legacy_rollback(rollback_tree):
    primary = rollback_tree[2] / "incident-state.json"
    primary.write_text("{broken")
    primary.chmod(0o600)
    assert_unknown_state_refuses_legacy_rollback(rollback_tree)


def test_fifo_state_cannot_authorize_legacy_rollback(rollback_tree):
    os.mkfifo(rollback_tree[2] / "incident-state.json", 0o600)
    assert_unknown_state_refuses_legacy_rollback(rollback_tree)


def test_symlink_state_cannot_authorize_legacy_rollback(rollback_tree):
    state = rollback_tree[2]
    outside = state.parent / "outside-state.json"
    outside.write_text('{"openIncidents": {}, "lastSentAt": {}}')
    outside.chmod(0o600)
    (state / "incident-state.json").symlink_to(outside)
    assert_unknown_state_refuses_legacy_rollback(rollback_tree)


def test_missing_adopted_state_cannot_authorize_legacy_rollback(rollback_tree):
    marker = rollback_tree[2] / "incident-state.json.initialized"
    marker.write_text("{}")
    marker.chmod(0o600)
    assert_unknown_state_refuses_legacy_rollback(rollback_tree)


def test_evidence_only_state_cannot_authorize_legacy_rollback(rollback_tree):
    evidence = rollback_tree[2] / "0123456789abcdef0123456789abcdef.controller-state-evidence"
    evidence.write_text("retained recovery evidence")
    evidence.chmod(0o600)
    assert_unknown_state_refuses_legacy_rollback(rollback_tree)


def test_semantically_invalid_incident_state_cannot_authorize_legacy_rollback(rollback_tree):
    write_state(rollback_tree[2], {"openIncidents": {}, "lastSentAt": []})
    assert_unknown_state_refuses_legacy_rollback(rollback_tree)


@pytest.mark.parametrize("value", ["not-an-int", {"timestamp": 1700000000}])
def test_invalid_timestamp_member_cannot_authorize_legacy_rollback(rollback_tree, value):
    original = write_state(rollback_tree[2], {"openIncidents": {}, "lastSentAt": {"incident": value}})
    assert_unknown_state_refuses_legacy_rollback(rollback_tree)
    assert (rollback_tree[2] / "incident-state.json").read_bytes() == original


def test_runtime_supported_legacy_timestamp_remains_readable(rollback_tree):
    original = write_state(rollback_tree[2], {"openIncidents": {}, "lastSentAt": {"incident": "1700000000"}})
    result = rollback(rollback_tree)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (rollback_tree[2] / "incident-state.json").read_bytes() == original


@pytest.mark.parametrize("mode", ["rollback", "rollback-lkg"])
def test_relative_service_state_cannot_authorize_legacy_rollback(rollback_tree, mode):
    root, backup, state, environment = rollback_tree
    write_state(state, {"openIncidents": {"incident": {
        "lastStaleRenotifyUnconfirmedAt": 1700000000}}, "lastSentAt": {}})
    before = snapshot(root)
    relative_environment = environment | {"BOT_ERRORS_STATE_DIR": state.name}
    result = rollback((root, backup, state, relative_environment), mode)
    assert result.returncode != 0, result.stdout + result.stderr
    assert "ROLLBACK_STATE_UNAVAILABLE" in result.stdout + result.stderr
    assert snapshot(root) == before


def test_legacy_rollback_before_first_dispatch_does_not_create_incident_state(rollback_tree):
    root, _backup, state, _environment = rollback_tree
    result = rollback(rollback_tree)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (root / DISPATCHER).read_bytes() == LEGACY_DISPATCHER
    assert not (state / "incident-state.json").exists()
