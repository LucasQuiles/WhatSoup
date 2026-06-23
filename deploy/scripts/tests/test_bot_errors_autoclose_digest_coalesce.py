"""Tests for Pattern A (digest coalescing) — the auto-close summary is coalesced
ACROSS sweep runs, not just within one run.

Design: docs/superpowers/specs/2026-06-16-bot-errors-noise-reduction-design.md §3.

The stale sweep ticks every ~30s. The auto-close digest was consolidated within a
single run, so a draining backlog emitted one "Auto-closed N" message per tick — the
digest itself became the noise stream. This gate coalesces the digest across runs:
incident CLOSURE stays immediate (renotify stops, open state cannot grow unbounded),
but the WhatsApp summary is emitted at most once per window — or sooner if the pending
batch reaches the burst cap, so a real flood is still reported promptly. Fail-open: a
send failure keeps the batch pending for the next sweep (no lost digest).
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS",
    "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_MAX_PENDING",
    "BOT_ERRORS_INCIDENT_STALE_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SECONDS",
    "BOT_ERRORS_INCIDENT_STALE_RENOTIFY_SECONDS",
]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load(state_dir: Path, extra_env: dict[str, str] | None = None):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    for k, v in (extra_env or {}).items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bot_errors_autoclose_coalesce", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _capture_sends(mod) -> list[str]:
    sends: list[str] = []
    mod.send_whatsapp = lambda text, *a, **k: sends.append(text)  # type: ignore[assignment]
    return sends


def _stale_tool_error(now: int, n: int) -> dict:
    """A non-actionable runtime-tool-error:* incident, stale + past escalate."""
    return {
        "status": "stale",
        "severity": "warning",
        "openedAt": now - 5 * 86400,
        "lastSeenAt": now - 5 * 86400,
        "lastSummary": f"Agent tool failure: tool-{n}",
    }


def _write_state(mod, *, incidents: dict, digest: dict | None = None) -> None:
    path = mod.state_paths()["incident_state"]
    path.parent.mkdir(parents=True, exist_ok=True)
    state = {"version": 1, "openIncidents": incidents, "lastSentAt": {}}
    if digest is not None:
        state["staleAutocloseDigest"] = digest
    path.write_text(json.dumps(state))


def _read_state(mod) -> dict:
    return json.loads(mod.state_paths()["incident_state"].read_text())


def _incidents(now: int, count: int) -> dict:
    return {
        f"host-a|instance-x|runtime-tool-error:provider-cli:tool-{i}": _stale_tool_error(now, i)
        for i in range(count)
    }


# ---------------------------------------------------------------------------
# T1: a trickle within the window is coalesced — closures happen every sweep,
#     but NO digest is sent while the window is open; pendingCount accumulates.
# ---------------------------------------------------------------------------

def test_trickle_within_window_is_coalesced(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS": "3600"})
    now = int(time.time())
    # Seed a recent digest so the first sweep is already inside the window.
    _write_state(mod, incidents=_incidents(now, 2), digest={"lastDigestAt": now, "pendingCount": 0, "pendingKeys": []})

    sends = _capture_sends(mod)
    mod.sweep_stale_incidents(mod.state_paths())

    assert sends == []  # nothing pushed inside the window
    st = _read_state(mod)
    assert st["openIncidents"] == {}  # but the incidents WERE closed immediately
    assert st["staleAutocloseDigest"]["pendingCount"] == 2

    # second tick a moment later: still inside window -> still coalesced, count grows
    _write_state(mod, incidents=_incidents(now, 3), digest=st["staleAutocloseDigest"])
    mod.sweep_stale_incidents(mod.state_paths())
    assert sends == []
    assert _read_state(mod)["staleAutocloseDigest"]["pendingCount"] == 5


# ---------------------------------------------------------------------------
# T2: once the coalescing window has elapsed, the pending batch is emitted as a
#     single digest reporting the exact coalesced total, then the batch resets.
# ---------------------------------------------------------------------------

def test_window_elapsed_emits_single_digest(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS": "3600"})
    now = int(time.time())
    # last digest 4000s ago (> 1h window) and 4 already pending from earlier sweeps.
    _write_state(
        mod,
        incidents=_incidents(now, 2),
        digest={"lastDigestAt": now - 4000, "pendingCount": 4,
                "pendingKeys": ["host-a|instance-x|runtime-tool-error:provider-cli:old"]},
    )
    sends = _capture_sends(mod)
    mod.sweep_stale_incidents(mod.state_paths())

    assert len(sends) == 1
    assert "Auto-closed 6 non-actionable" in sends[0]  # 4 pending + 2 this sweep
    accum = _read_state(mod)["staleAutocloseDigest"]
    assert accum["pendingCount"] == 0  # reset after emit
    assert accum["lastDigestAt"] >= now


# ---------------------------------------------------------------------------
# T3: a large batch trips the burst cap and emits immediately even inside the
#     window, so a real flood is still reported promptly.
# ---------------------------------------------------------------------------

def test_burst_cap_emits_within_window(tmp_path):
    mod = _load(tmp_path, {
        "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS": "100000",  # window never elapses
        "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_MAX_PENDING": "3",
    })
    now = int(time.time())
    _write_state(mod, incidents=_incidents(now, 4), digest={"lastDigestAt": now, "pendingCount": 0, "pendingKeys": []})

    sends = _capture_sends(mod)
    mod.sweep_stale_incidents(mod.state_paths())

    assert len(sends) == 1  # 4 >= cap of 3 -> emit despite open window
    assert "Auto-closed 4 non-actionable" in sends[0]
    assert _read_state(mod)["staleAutocloseDigest"]["pendingCount"] == 0


# ---------------------------------------------------------------------------
# T4: coalescing disabled (window=0) restores legacy per-sweep digest behavior.
# ---------------------------------------------------------------------------

def test_coalescing_disabled_emits_per_sweep(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS": "0"})
    now = int(time.time())
    _write_state(mod, incidents=_incidents(now, 2), digest={"lastDigestAt": now, "pendingCount": 0, "pendingKeys": []})

    sends = _capture_sends(mod)
    mod.sweep_stale_incidents(mod.state_paths())

    assert len(sends) == 1  # gate off -> emit every run
    assert "Auto-closed 2 non-actionable" in sends[0]


# ---------------------------------------------------------------------------
# T5: a send failure on the digest keeps the batch PENDING (no lost digest) —
#     incidents are still closed, and the next due sweep retries the summary.
# ---------------------------------------------------------------------------

def test_send_failure_keeps_batch_pending(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS": "3600"})
    now = int(time.time())
    _write_state(
        mod,
        incidents=_incidents(now, 2),
        digest={"lastDigestAt": now - 4000, "pendingCount": 0, "pendingKeys": []},  # window elapsed -> due
    )

    def _boom(text, *a, **k):
        raise RuntimeError("whatsapp down")

    mod.send_whatsapp = _boom  # type: ignore[assignment]
    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    st = _read_state(mod)
    assert st["openIncidents"] == {}  # closure is unconditional
    assert st["staleAutocloseDigest"]["pendingCount"] == 2  # batch retained for retry
    assert err is not None
