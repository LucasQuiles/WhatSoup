"""Tests for #3501: self-healing mode repair of a legacy daily-health receipt.

`ensure_private_dir()` re-applies 0700 to the state directory on every cycle,
but nothing repaired the leaf receipt, so a `daily-health-receipt.json` written
before the strict durable reader was adopted keeps its pre-adoption mode
forever and `observe_json()` rejects it with `DurableWriteError: permission` on
every subsequent cycle. The daily cycle therefore never publishes, while the
outbox event queued immediately beforehand still reads as success.

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents
normal import), matching the loader in
test_bot_errors_health_check_deadman_levels.py.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"
if str(_SCRIPT.parent) not in sys.path:
    sys.path.insert(0, str(_SCRIPT.parent))

from lib.durable_json import DurableWriteError  # noqa: E402

# Reader tolerance and writer output are two different constants and a test that
# hardcodes one for the other can pass against the wrong value. Both are pinned
# here by name: the reader forbids any bit in 0o077, the writer publishes at
# DurableJsonTarget.final_mode.
_READER_FORBIDDEN_MODE_BITS = 0o077
_EXPECTED_SUCCESSOR_MODE = 0o600

# The acceptance matrix from the issue intake: the exact leaf modes the strict
# reader was observed to reject. Enumerated, not sampled, because the point is
# that 0640 and 0604 fail the reader just as 0644 does, so a repair that
# special-cases 0644 must not pass.
_FORBIDDEN_LEGACY_MODES = (0o644, 0o640, 0o604, 0o660, 0o606, 0o601, 0o610)

# The acceptance matrix for the parent guard: group-writable and world-writable
# state roots, again enumerated from the intake rather than sampled.
_WRITABLE_PARENT_MODES = (0o777, 0o720, 0o702)


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()

_LEGACY_PAYLOAD = {
    "eventId": "evt.daily-health.legacy",
    "severity": "info",
    "emittedAt": "2026-09-01T00:00:00Z",
    "eventPath": "/var/legacy/outbox/evt.daily-health.legacy.json",
}


def _write_legacy_receipt(root: Path, mode: int = 0o644) -> tuple[Path, bytes]:
    """Create the deployed pre-adoption artifact: legacy fields, no generation."""
    root.chmod(0o700)
    receipt_path = root / "daily-health-receipt.json"
    raw = (json.dumps(_LEGACY_PAYLOAD, sort_keys=True) + "\n").encode("utf-8")
    receipt_path.write_bytes(raw)
    receipt_path.chmod(mode)
    assert "generation" not in _LEGACY_PAYLOAD, "legacy artifact must carry no generation"
    return receipt_path, raw


def _new_event(root: Path, name: str = "evt.daily-health.current.json") -> Path:
    event_path = root / "outbox" / name
    event_path.parent.mkdir(parents=True, exist_ok=True)
    event_path.write_text("{}", encoding="utf-8")
    return event_path


def _mode_of(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


class _StatWithSubstitutedUid:
    """Wrap a real stat result, overriding only st_uid.

    Foreign ownership cannot be provoked by an unprivileged test, so it is
    injected at the stat result, as the lane contract requires. Matching on
    st_ino targets exactly the leaf under test and leaves every other stat call
    in the process untouched.
    """

    def __init__(self, base: os.stat_result, uid: int) -> None:
        self._base = base
        self.st_uid = uid

    def __getattr__(self, name: str):
        return getattr(self._base, name)


@pytest.fixture
def foreign_owner(monkeypatch):
    """Return a callable that makes one inode look foreign-owned to os.stat."""

    real_stat = os.stat

    def install(path: Path, uid: int) -> None:
        target_inode = path.lstat().st_ino

        def fake_stat(target, *args, **kwargs):
            result = real_stat(target, *args, **kwargs)
            if result.st_ino == target_inode:
                return _StatWithSubstitutedUid(result, uid)
            return result

        monkeypatch.setattr(os, "stat", fake_stat)

    return install


# ===========================================================================
# C4 / acceptance 1: the deployed legacy state must publish a successor
# ===========================================================================

def test_legacy_mode_receipt_publishes_successor(tmp_path, monkeypatch):
    """RED on main: DurableWriteError: permission from the strict reader."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    receipt_path, _raw = _write_legacy_receipt(tmp_path)
    event_path = _new_event(tmp_path)

    _mod.record_daily_health_receipt(event_path, "critical")

    successor = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert successor["eventId"] == "evt.daily-health.current"
    assert successor["severity"] == "critical"
    assert successor["eventPath"] == str(event_path)
    assert successor["emittedAt"] != _LEGACY_PAYLOAD["emittedAt"]


def test_successor_generation_advances_past_the_legacy_receipt(tmp_path, monkeypatch):
    """C8: publication metadata advances past the legacy predecessor.

    The generation lives in the PublicationResult, not in the receipt payload.
    The legacy on-disk format carries no generation field and this change does
    not synthesize one, so the predecessor's generation reads as absent and the
    successor's is 1.
    """
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    receipt_path, _raw = _write_legacy_receipt(tmp_path)

    result = _mod.record_daily_health_receipt(_new_event(tmp_path), "info")

    assert result.advance_allowed
    assert result.public_projection()["authority"] == "intended_authoritative"
    assert result.generation == 1
    assert "generation" not in json.loads(receipt_path.read_text(encoding="utf-8"))


def test_successor_mode_is_exactly_the_targets_final_mode(tmp_path, monkeypatch):
    """C8: expected private permissions, asserted against both constants."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    receipt_path, _raw = _write_legacy_receipt(tmp_path)

    target = _mod.durable_json_target(
        trusted_root=tmp_path.resolve(strict=True),
        relative_path=receipt_path.name,
    )
    assert target.final_mode == _EXPECTED_SUCCESSOR_MODE

    _mod.record_daily_health_receipt(_new_event(tmp_path), "info")

    assert _mode_of(receipt_path) == target.final_mode
    assert not _mode_of(receipt_path) & _READER_FORBIDDEN_MODE_BITS


def test_pre_repair_mode_is_recorded_as_evidence(tmp_path, monkeypatch, capsys):
    """C6: the repair preserves the previous receipt's mode as evidence."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    receipt_path, _raw = _write_legacy_receipt(tmp_path, 0o644)

    _mod.record_daily_health_receipt(_new_event(tmp_path), "info")

    successor = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert successor[_mod.LEGACY_RECEIPT_MODE_EVIDENCE_FIELD] == "0644"
    assert "0644" in capsys.readouterr().err


def test_no_evidence_field_when_no_repair_was_needed(tmp_path, monkeypatch):
    """A receipt already at 0600 must not be labelled as repaired."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    receipt_path, _raw = _write_legacy_receipt(tmp_path, 0o600)

    _mod.record_daily_health_receipt(_new_event(tmp_path), "info")

    successor = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert _mod.LEGACY_RECEIPT_MODE_EVIDENCE_FIELD not in successor


# ===========================================================================
# C2: the repair preserves the legacy payload and predecessor identity
# ===========================================================================

def test_repair_preserves_payload_bytes_and_inode(tmp_path):
    """The repair changes the mode and nothing else."""
    receipt_path, raw = _write_legacy_receipt(tmp_path)
    before_inode = receipt_path.lstat().st_ino

    outcome = _mod.repair_legacy_private_receipt_mode(receipt_path)

    assert outcome.refusal is None
    assert outcome.previous_mode == 0o644
    assert receipt_path.read_bytes() == raw
    assert receipt_path.lstat().st_ino == before_inode
    assert _mode_of(receipt_path) == 0o600


def test_repaired_receipt_is_readable_as_the_predecessor(tmp_path):
    """C2: after the repair the strict reader sees the legacy payload and sha."""
    receipt_path, raw = _write_legacy_receipt(tmp_path)
    _mod.repair_legacy_private_receipt_mode(receipt_path)

    target = _mod.durable_json_target(
        trusted_root=tmp_path.resolve(strict=True),
        relative_path=receipt_path.name,
    )
    observation = _mod.observe_json(target)

    assert observation.payload == _LEGACY_PAYLOAD
    assert observation.version.raw_sha256 == hashlib.sha256(raw).hexdigest()
    assert observation.version.generation is None


@pytest.mark.parametrize("legacy_mode", _FORBIDDEN_LEGACY_MODES)
def test_repair_clears_every_forbidden_bit(tmp_path, legacy_mode):
    """The repair must not special-case 0644; 0640 and 0604 fail the reader too."""
    receipt_path, _raw = _write_legacy_receipt(tmp_path, legacy_mode)

    outcome = _mod.repair_legacy_private_receipt_mode(receipt_path)

    assert outcome.previous_mode == legacy_mode
    assert not _mode_of(receipt_path) & _mod.LEGACY_RECEIPT_FORBIDDEN_MODE_BITS
    assert _mod.LEGACY_RECEIPT_FORBIDDEN_MODE_BITS == _READER_FORBIDDEN_MODE_BITS


def test_repair_is_a_noop_on_a_compliant_leaf(tmp_path):
    receipt_path, _raw = _write_legacy_receipt(tmp_path, 0o600)

    outcome = _mod.repair_legacy_private_receipt_mode(receipt_path)

    assert outcome == _mod.LegacyReceiptRepair(None, None)
    assert _mode_of(receipt_path) == 0o600


def test_repair_is_a_noop_when_the_receipt_is_absent(tmp_path):
    tmp_path.chmod(0o700)

    outcome = _mod.repair_legacy_private_receipt_mode(tmp_path / "daily-health-receipt.json")

    assert outcome == _mod.LegacyReceiptRepair(None, None)


# ===========================================================================
# C5: negative controls, each asserting its own refusal reason
# ===========================================================================

def test_repair_refuses_a_symlinked_leaf(tmp_path):
    real_path, raw = _write_legacy_receipt(tmp_path)
    link_root = tmp_path / "linked"
    link_root.mkdir(mode=0o700)
    link_path = link_root / "daily-health-receipt.json"
    link_path.symlink_to(real_path)

    outcome = _mod.repair_legacy_private_receipt_mode(link_path)

    assert outcome.refusal == _mod.LEGACY_RECEIPT_REFUSAL_SYMLINK
    assert outcome.previous_mode is None
    assert real_path.read_bytes() == raw
    assert _mode_of(real_path) == 0o644, "the symlink target must be left unmodified"


def test_repair_refuses_a_foreign_owned_leaf(tmp_path, foreign_owner):
    receipt_path, raw = _write_legacy_receipt(tmp_path)
    foreign_owner(receipt_path, os.getuid() + 1)

    outcome = _mod.repair_legacy_private_receipt_mode(receipt_path)

    assert outcome.refusal == _mod.LEGACY_RECEIPT_REFUSAL_FOREIGN_OWNER
    assert outcome.previous_mode is None
    assert receipt_path.read_bytes() == raw
    assert _mode_of(receipt_path) == 0o644, "a foreign-owned leaf must be left unmodified"


def test_repair_refuses_a_multiply_linked_leaf(tmp_path):
    receipt_path, raw = _write_legacy_receipt(tmp_path)
    os.link(receipt_path, tmp_path / "second-name.json")
    assert receipt_path.lstat().st_nlink == 2

    outcome = _mod.repair_legacy_private_receipt_mode(receipt_path)

    assert outcome.refusal == _mod.LEGACY_RECEIPT_REFUSAL_MULTIPLE_LINKS
    assert outcome.previous_mode is None
    assert receipt_path.read_bytes() == raw
    assert _mode_of(receipt_path) == 0o644, "a multiply-linked leaf must be left unmodified"


@pytest.mark.parametrize("parent_mode", _WRITABLE_PARENT_MODES)
def test_repair_refuses_a_group_or_world_writable_parent(tmp_path, parent_mode):
    root = tmp_path / "state"
    root.mkdir(mode=0o700)
    receipt_path, raw = _write_legacy_receipt(root)
    root.chmod(parent_mode)

    outcome = _mod.repair_legacy_private_receipt_mode(receipt_path)

    assert outcome.refusal == _mod.LEGACY_RECEIPT_REFUSAL_PARENT_WRITABLE
    assert outcome.previous_mode is None
    assert receipt_path.read_bytes() == raw
    assert _mode_of(receipt_path) == 0o644, "a leaf under a writable parent must be left unmodified"


def test_repair_matches_the_reader_through_a_symlinked_state_root(tmp_path):
    """Parity: a symlinked state root is transparent to the repair.

    _durable_target resolves the parent, so the reader publishes through a
    symlinked state root. A repair that refused there would be permanently
    inert on exactly the hosts whose legacy receipt still needs repairing.
    """
    real_root = tmp_path / "real-state"
    real_root.mkdir(mode=0o700)
    receipt_path, raw = _write_legacy_receipt(real_root)
    linked_root = tmp_path / "linked-state"
    linked_root.symlink_to(real_root, target_is_directory=True)

    outcome = _mod.repair_legacy_private_receipt_mode(
        linked_root / "daily-health-receipt.json"
    )

    assert outcome.refusal is None
    assert outcome.previous_mode == 0o644
    assert receipt_path.read_bytes() == raw
    assert _mode_of(receipt_path) == 0o600


def test_repair_matches_the_reader_through_a_symlinked_ancestor(tmp_path, monkeypatch):
    """Parity control: a symlinked ancestor above the state root is transparent.

    A linked home directory is the realistic shape. Going through
    record_daily_health_receipt asserts the other half of parity too: the
    reader observes and publishes on the same path the repair accepted.
    """
    real_home = tmp_path / "real-home"
    real_root = real_home / "state"
    real_root.mkdir(mode=0o700, parents=True)
    real_home.chmod(0o700)
    linked_home = tmp_path / "linked-home"
    linked_home.symlink_to(real_home, target_is_directory=True)
    root_via_link = linked_home / "state"
    _write_legacy_receipt(root_via_link)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root_via_link))
    event_path = _new_event(root_via_link)

    result = _mod.record_daily_health_receipt(event_path, "info")

    assert result.advance_allowed, "the reader must publish where the repair accepted"
    real_receipt = real_root / "daily-health-receipt.json"
    successor = json.loads(real_receipt.read_text(encoding="utf-8"))
    assert successor["eventId"] == event_path.stem
    assert successor[_mod.LEGACY_RECEIPT_MODE_EVIDENCE_FIELD] == "0644"
    assert _mode_of(real_receipt) == _EXPECTED_SUCCESSOR_MODE


def test_parent_walk_refuses_a_symlinked_component(tmp_path):
    """The O_NOFOLLOW walk still refuses, exercised below the resolution step.

    After resolution no component is a symlink, so this guard fires only when a
    component is swapped for a symlink between the resolve and the walk. That
    race has no deterministic end-to-end test, so the walk is driven directly
    with an unresolved path to keep the guard falsifiable.
    """
    real_root = tmp_path / "real-state"
    real_root.mkdir(mode=0o700)
    linked_root = tmp_path / "linked-state"
    linked_root.symlink_to(real_root, target_is_directory=True)

    with pytest.raises(_mod._ReceiptParentUnusable) as excinfo:
        _mod._open_receipt_parent(linked_root)

    assert excinfo.value.refusal == _mod.LEGACY_RECEIPT_REFUSAL_PARENT_SYMLINK


def test_parent_walk_accepts_a_real_directory_chain(tmp_path):
    """Positive control for the walk itself."""
    real_root = tmp_path / "real-state"
    real_root.mkdir(mode=0o700)

    descriptor = _mod._open_receipt_parent(real_root.resolve(strict=True))
    try:
        assert os.stat(descriptor).st_ino == real_root.stat().st_ino
    finally:
        os.close(descriptor)


def test_repair_still_repairs_under_a_real_directory_parent(tmp_path):
    """Positive control for the walk: a real parent chain still repairs."""
    real_root = tmp_path / "real-state"
    real_root.mkdir(mode=0o700)
    receipt_path, raw = _write_legacy_receipt(real_root)

    outcome = _mod.repair_legacy_private_receipt_mode(receipt_path)

    assert outcome.refusal is None
    assert outcome.previous_mode == 0o644
    assert _mode_of(receipt_path) == 0o600
    assert receipt_path.read_bytes() == raw


def test_repair_refuses_a_non_regular_leaf(tmp_path):
    tmp_path.chmod(0o700)
    fifo_path = tmp_path / "daily-health-receipt.json"
    os.mkfifo(fifo_path, 0o644)

    outcome = _mod.repair_legacy_private_receipt_mode(fifo_path)

    assert outcome.refusal in {
        _mod.LEGACY_RECEIPT_REFUSAL_NOT_REGULAR,
        _mod.LEGACY_RECEIPT_REFUSAL_UNOPENABLE,
    }
    assert outcome.previous_mode is None
    assert _mode_of(fifo_path) == 0o644


def test_refusal_leaves_the_strict_reader_to_reject(tmp_path, monkeypatch, capsys):
    """A refused repair must not mask the reader; the cycle still fails closed."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    receipt_path, raw = _write_legacy_receipt(tmp_path)
    os.link(receipt_path, tmp_path / "second-name.json")

    with pytest.raises(DurableWriteError) as excinfo:
        _mod.record_daily_health_receipt(_new_event(tmp_path), "info")

    assert "permission" in str(excinfo.value)
    assert receipt_path.read_bytes() == raw
    assert _mod.LEGACY_RECEIPT_REFUSAL_MULTIPLE_LINKS in capsys.readouterr().err


def test_writable_state_root_is_judged_before_it_is_narrowed(tmp_path, monkeypatch, capsys):
    """The repair must run before ensure_private_dir(), not after.

    ensure_private_dir() re-applies 0700 to the state root. Running it first
    would hand the parent guard a value it had just sanitized, and the repair
    would then chmod a leaf that a world-writable root may have let anyone
    plant. This pins the ordering: reversing it turns this test red.
    """
    root = tmp_path / "state"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    receipt_path, raw = _write_legacy_receipt(root)
    event_path = _new_event(root)
    root.chmod(0o777)

    with pytest.raises(DurableWriteError):
        _mod.record_daily_health_receipt(event_path, "info")

    assert _mod.LEGACY_RECEIPT_REFUSAL_PARENT_WRITABLE in capsys.readouterr().err
    assert receipt_path.read_bytes() == raw
    assert _mode_of(receipt_path) == 0o644, "a leaf under a writable root must be left unmodified"


# ===========================================================================
# C3: the strict reader is not relaxed
# ===========================================================================

def test_strict_reader_still_rejects_a_permissive_leaf(tmp_path):
    """The repair is the only thing that changed; observe_json is unchanged."""
    receipt_path, _raw = _write_legacy_receipt(tmp_path, 0o644)
    target = _mod.durable_json_target(
        trusted_root=tmp_path.resolve(strict=True),
        relative_path=receipt_path.name,
    )

    with pytest.raises(DurableWriteError):
        _mod.observe_json(target)
