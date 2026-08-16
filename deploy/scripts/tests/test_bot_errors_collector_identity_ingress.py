"""#2427 identity ingress gate: a remote event without a stable nonempty
string identity must never enter the local delivery lifecycle.

Pre-gate behavior (the defect): relay_event coerced any identity with
str(event.get("id") or ""), local_event_exists("") is always False, and the
idless filename fallback embeds a fresh nanosecond token — so every
acknowledgement retry of the same identity-less payload minted ANOTHER local
outbox copy with a reset delivery budget (non-convergent duplicates).

Gate contract (reject-and-ack, NOT durable hold): missing / empty /
non-string ids are quarantined via the existing harvest-quarantine surface
(payload-sha keyed, idempotent across retries) and the claim is acknowledged
by the caller exactly like the duplicate path, so the claim cannot
lease-loop. The write-failure crumb gate tightens the same way: an empty
nested event id is poison, not a harvestable crumb.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_load_mod_with_dirs = _conftest._load_mod_with_dirs
_env = _conftest._env

QUARANTINE_DIR = "writefail-harvest-quarantine"


def _event(**overrides):
    event = {
        "id": "evt-ingress-1",
        "createdAt": "2026-08-01T12:00:00.000Z",
        "instance": "x-bot",
        "source": "test_source",
        "summary": "ingress test",
        "severity": "warning",
    }
    event.update(overrides)
    for key in [k for k, v in event.items() if v is _MISSING]:
        del event[key]
    return event


class _Missing:
    pass


_MISSING = _Missing()


def _record(event) -> dict:
    return {
        "payload": json.dumps(event),
        "claim": "/remote/processing/claim-1.relay",
        "name": "claim-1.json",
    }


def _outbox_files(outbox_dir: Path) -> list[Path]:
    # Exclude the durable-publication lock sidecar (dotfile) — only event
    # lifecycle records count.
    return [p for p in outbox_dir.glob("*") if p.is_file() and not p.name.startswith(".")]


def _quarantine_files(state_dir: Path) -> list[Path]:
    directory = state_dir / QUARANTINE_DIR
    if not directory.exists():
        return []
    return [p for p in directory.glob("*") if p.is_file() and not p.name.startswith(".")]


@pytest.mark.parametrize(
    "bad_id",
    [_MISSING, "", 31337],
    ids=["missing", "empty", "non-string"],
)
def test_invalid_id_is_rejected_and_quarantined(tmp_state, bad_id):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    event = _event(id=bad_id)
    with _env(state_dir, outbox_dir):
        path = mod.relay_event("rhost", "/remote/root", _record(event))
        assert QUARANTINE_DIR in str(path)
        assert _outbox_files(outbox_dir) == []
        assert len(_quarantine_files(state_dir)) == 1
        # Acknowledgement retry of the same claim converges on the SAME
        # quarantine record — no second lifecycle file anywhere.
        path2 = mod.relay_event("rhost", "/remote/root", _record(event))
        assert QUARANTINE_DIR in str(path2)
        assert _outbox_files(outbox_dir) == []
        assert len(_quarantine_files(state_dir)) == 1


def test_identified_event_still_relays(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        path = mod.relay_event("rhost", "/remote/root", _record(_event()))
        assert path.exists()
        assert _outbox_files(outbox_dir) == [path]
        assert _quarantine_files(state_dir) == []


def test_writefail_crumb_empty_nested_id_is_poison(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    crumb = {
        "kind": "outbox_write_failure",
        "event": {"id": "", "createdAt": "2026-08-01T12:00:00.000Z"},
    }
    record = {
        "payload": json.dumps(crumb),
        "claim": "/remote/processing/claim-wf.relay-writefail",
        "name": "claim-wf.json",
    }
    with _env(state_dir, outbox_dir):
        path, status = mod.relay_writefail("rhost", "/remote/root", record)
        assert status == "poison"
        assert QUARANTINE_DIR in str(path)
        assert _outbox_files(outbox_dir) == []


def test_writefail_crumb_missing_nested_id_stays_poison(tmp_state):
    """Negative control: the pre-existing schema gate already poisons a
    missing id; the tightened gate must not regress it."""
    state_dir, outbox_dir = tmp_state
    crumb = {"kind": "outbox_write_failure", "event": {"createdAt": "x"}}
    record = {
        "payload": json.dumps(crumb),
        "claim": "/remote/processing/claim-wf2.relay-writefail",
        "name": "claim-wf2.json",
    }
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        path, status = mod.relay_writefail("rhost", "/remote/root", record)
        assert status == "poison"
