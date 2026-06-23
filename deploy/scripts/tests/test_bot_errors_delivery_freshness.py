"""Tests for A4 — delivery freshness telemetry.

The dispatcher re-sends a queued event up to BOT_ERRORS_DELIVERY_MAX_ATTEMPTS
times WITHOUT re-validating that the underlying condition still holds. A reader
then cannot tell whether a re-delivered alert is current or a stale echo (the
"attempts=5, already false" problem). A4 stamps two honest markers on a
RE-delivery (attempts > 1): how old the event is at delivery, and that the
condition was NOT re-probed. A first delivery (attempts == 1) stays clean.
"""
from __future__ import annotations

import importlib.util
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


@pytest.fixture(autouse=True)
def _clean_env(tmp_path):
    saved = os.environ.get("BOT_ERRORS_STATE_DIR")
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    (tmp_path / "logs").mkdir(parents=True, exist_ok=True)
    yield
    if saved is None:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
    else:
        os.environ["BOT_ERRORS_STATE_DIR"] = saved


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_fresh", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _event(mod, attempts: int, age_seconds: int) -> dict:
    created_epoch = int(time.time()) - age_seconds
    created_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created_epoch))
    return {
        "schemaVersion": 1,
        "id": "evt-1",
        "eventType": "alert",
        "severity": "critical",
        "machine": "host-a",
        "instance": "instance-x",
        "source": "local_health",
        "summary": "health port refused",
        "createdAt": created_iso,
        "delivery": {"attempts": attempts, "status": "queued"},
    }


def test_redelivery_is_stamped_and_rendered(mod_age=600):
    mod = _load()
    ev = _event(mod, attempts=3, age_seconds=mod_age)
    mod.stamp_delivery_freshness(ev, int(time.time()))

    # Markers persisted on the event.
    assert ev["delivery"]["revalidated"] is False
    assert ev["delivery"]["ageAtDeliverySeconds"] >= mod_age - 2
    # And surfaced in the rendered alert so a reader sees it may be stale.
    text = mod.format_event(ev)
    assert "revalidated" in text.lower()
    assert "delivery_age" in text.lower()


def test_first_delivery_stays_clean():
    mod = _load()
    ev = _event(mod, attempts=1, age_seconds=5)
    mod.stamp_delivery_freshness(ev, int(time.time()))

    # No staleness markers on a first, fresh delivery.
    assert "ageAtDeliverySeconds" not in ev["delivery"]
    assert "revalidated" not in ev["delivery"]
    text = mod.format_event(ev)
    assert "delivery_age" not in text.lower()
