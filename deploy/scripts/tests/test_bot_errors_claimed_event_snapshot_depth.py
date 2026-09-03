"""The claimed-event snapshot must not cap event nesting depth, and must fail safe.

#3404 follow-up. ``process_one`` takes an independent snapshot of the event as
its producer claimed it, before writing any dispatcher bookkeeping into it, and
the F5 email gate reads that snapshot rather than the live event.

The first implementation of that snapshot used ``copy.deepcopy``, which consumes
roughly twice the interpreter stack per nesting level as the rest of
``process_one``. It halved the deepest event the dispatcher could handle -- 989
levels before, 495 after, measured on this interpreter -- and the failure was not
a rejection: ``RecursionError`` escaped ``process_one``, ``run_once`` calls it
unguarded, and ``reclaim_processing`` returns the stranded claimed file to the
outbox with no attempt counter. One over-deep event therefore aborted every
dispatcher pass, forever, and alerting stopped silently.

These tests pin both halves of the fix:

* the file's own round-trip idiom (``json_snapshot``, shared with
  ``validate_dispatcher_state``) raises the ceiling by more than an order of
  magnitude, and
* a payload that still cannot be snapshotted is quarantined as poison -- which
  moves it out of the queue and raises an operator alert -- instead of crashing
  the cycle and taking every alert queued behind it down too.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_TEST_LEAK_PATH_PATTERNS",
]

# Deeper than copy.deepcopy survives inside process_one on this interpreter
# (measured ceiling 495) and far below the round-trip idiom's own ceiling
# (measured between 8000 and 10000), so it separates the two idioms without
# sitting near either edge.
_DEEP = 700


@pytest.fixture(autouse=True)
def _clean_env() -> Iterator[None]:
    saved = {key: os.environ.get(key) for key in _ENV_KEYS}
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _load_module(env: dict[str, str]):
    for key, value in env.items():
        os.environ[key] = value
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_snapshot_depth_{uuid.uuid4().hex}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _nest(depth: int) -> dict[str, Any]:
    payload: dict[str, Any] = {"leaf": "x"}
    for _ in range(depth):
        payload = {"n": payload}
    return payload


def _event(event_id: str, **overrides: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health-fail",
        "instance": "eh-bot",
        "machine": "relay-host",
        "createdAt": "2026-08-28T23:39:19Z",
        "summary": "daily health failing",
        "evidence": "health eh-bot: 500 status=unhealthy",
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    event.update(overrides)
    return event


def _write_event(paths: dict[str, Path], event: dict[str, Any], stamp: str) -> Path:
    event_path = paths["outbox"] / f"{stamp}.eh-bot.daily-health-fail.{event['id']}.json"
    event_path.write_text(json.dumps(event, sort_keys=True) + "\n")
    event_path.chmod(0o600)
    return event_path


def _state_root() -> Iterator[Path]:
    root = Path.home() / f".bot-errors-snapshot-depth-{uuid.uuid4().hex}"
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def state_root() -> Iterator[Path]:
    yield from _state_root()


_dispatch_log_records = dispatcher_fixtures.dispatch_log_records


# --------------------------------------------------------------------------
# The snapshot helper itself
# --------------------------------------------------------------------------


# Each shape carries the verdict the gate must return for it, so the idiom
# comparison below cannot pass by both sides being None.
_SHAPES: dict[str, tuple[dict[str, Any], str | None]] = {
    "provenance_flag": ({"runtime": {"provenance": {"test": True}}}, "test_provenance"),
    "leak_path_in_evidence": (
        {"evidence": "authDir: /tmp/wa-test-auth/creds.json unreadable"},
        "test_leak",
    ),
    "clean_alert": ({}, None),
    "nested_list_bools_float_null": (
        {
            "diagnostics": {
                "logHints": ["a", "b"],
                "counts": [1, 2, [3, {"deep": None}]],
                "ratio": 0.5,
                "flag": False,
                "missing": None,
            }
        },
        None,
    ),
}


@pytest.mark.parametrize("shape", sorted(_SHAPES))
def test_json_snapshot_equals_the_input_and_is_independent_of_it(shape: str, state_root: Path):
    mod = _load_module({"BOT_ERRORS_STATE_DIR": str(state_root)})
    event = _event("evt-shape", **_SHAPES[shape][0])

    snapshot = mod.json_snapshot(event)

    assert snapshot == event, "round-trip must be structural identity for a JSON-shaped event"
    assert snapshot is not event
    # Independence is the whole point of taking a snapshot: later mutation of
    # the live event must not reach it.
    event["delivery"]["lastError"] = "mutated after the snapshot"
    event.setdefault("diagnostics", {})["dispatchLog"] = "/state/logs/dispatch.jsonl"
    assert snapshot["delivery"]["lastError"] is None
    assert "dispatchLog" not in snapshot.get("diagnostics", {})


@pytest.mark.parametrize("shape", sorted(_SHAPES))
def test_gate_verdict_is_identical_under_both_snapshot_idioms(shape: str, state_root: Path):
    # S1: the round-trip replaces copy.deepcopy at this call site only if the
    # two produce the same gate answer. Pinned for every shape the reviewer
    # tabled, on a production-like state dir so the state-dir rule stays out.
    #
    # Each side is also compared against the verdict the shape is SUPPOSED to
    # get. Asserting only that the two idioms agree is vacuous for the two clean
    # shapes, where both are None and would stay equal even if the gate stopped
    # working entirely.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": str(state_root)})
    overrides, expected = _SHAPES[shape]
    event = _event("evt-shape", **overrides)

    via_roundtrip = mod.email_fallback_blocked_reason(mod.json_snapshot(event), state_dir=state_root)
    via_deepcopy = mod.email_fallback_blocked_reason(copy.deepcopy(event), state_dir=state_root)

    assert via_roundtrip == expected, shape
    assert via_deepcopy == expected, shape


def test_json_snapshot_tolerates_nesting_that_deepcopy_cannot(state_root: Path):
    # The measurement behind the fix, asserted rather than described: the two
    # idioms are not interchangeable at depth, and the one now in use is the
    # deeper of the two.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": str(state_root)})
    deep = _nest(_DEEP)

    with pytest.raises(RecursionError):
        copy.deepcopy(deep)
    assert mod.json_snapshot(deep) == deep


# --------------------------------------------------------------------------
# process_one and the cycle
# --------------------------------------------------------------------------


def test_deeply_nested_event_is_delivered_not_crashed(state_root: Path):
    # X1 red: at the deepcopy snapshot this raised RecursionError out of
    # process_one. The dispatcher's own reader accepts the event, so refusing
    # to handle it here was a crash, not a policy.
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(state_root),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    event_path = _write_event(paths, _event("evt-deep", payload=_nest(_DEEP)), "20260828233919")

    with patch.object(mod, "send_whatsapp", return_value=None):
        ok, detail = mod.process_one(event_path, paths)

    assert (ok, detail) == (True, "sent")
    assert not list(paths["quarantine"].glob("*.poison"))


def test_unsnapshottable_event_is_quarantined_and_the_next_alert_still_delivers(state_root: Path):
    """The poison-loop guard: one bad event must not take the whole pass down.

    The snapshot is failed at its seam rather than by nesting an event past the
    round-trip's real ceiling, and that is a deliberate, disclosed limitation.
    The round-trip's ceiling (measured between 8000 and 10000) is far above the
    depth ``process_one`` reaches it at: from 990 levels up, ``operation_id`` in
    the durable publish above the snapshot raises ``RecursionError`` first, both
    here and at ``e460995a``. So no event depth reaches this branch, and this
    guard does NOT close that pre-existing crash -- closing it means hardening
    the publish path, which is a different change.

    What the branch is worth is unchanged: it is the reason ANY snapshot
    failure, including one from a future non-serialisable member or a raised
    recursion limit, costs one quarantined event instead of every alert in the
    queue. Faking the seam is what isolates it.
    """
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(state_root),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    _write_event(paths, _event("evt-unsnapshottable"), "20260828233918")
    _write_event(paths, _event("evt-ordinary"), "20260828233919")

    real_snapshot = mod.json_snapshot

    def failing_snapshot(payload: Any) -> Any:
        if isinstance(payload, dict) and payload.get("id") == "evt-unsnapshottable":
            raise RecursionError("simulated snapshot failure")
        return real_snapshot(payload)

    sent: list[str] = []
    with patch.object(mod, "json_snapshot", side_effect=failing_snapshot), \
         patch.object(mod, "send_whatsapp", side_effect=lambda text: sent.append(text)), \
         patch.object(mod, "email_fallback", return_value=True):
        summary = mod.run_once(max_events=10)

    # The ordinary alert queued behind the bad one is delivered in the SAME
    # cycle -- the property the crash destroyed.
    assert summary.get("sent") == 1, summary
    assert any("daily health failing" in text for text in sent), sent

    poison = list(paths["quarantine"].glob("*evt-unsnapshottable*.poison"))
    assert len(poison) == 1, list(paths["quarantine"].iterdir())
    # It left the queue for good: no requeue, so no second crash next cycle.
    assert not list(paths["outbox"].glob("*evt-unsnapshottable*"))
    assert not list(paths["processing"].glob("*evt-unsnapshottable*"))

    quarantine_records = [r for r in _dispatch_log_records(paths) if r.get("type") == "quarantine"]
    assert len(quarantine_records) == 1, quarantine_records
