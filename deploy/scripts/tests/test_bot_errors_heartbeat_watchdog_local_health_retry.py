"""Tests for confirm-retry on the watchdog local-health probe.

Root cause of a false-positive ``local_health:<instance>`` critical: the probe
was single-shot. A busy agent event loop (mid-turn, spawning Bash/MCP) could
miss one 3s health request, return ``http_status=0 body=timed out``, and fire a
critical against an endpoint that answered 200 in 62ms moments later.

Fix: a transport-level failure (status 0) is retried before escalating. A real
outage fails every attempt; a transient blip clears on retry. HTTP error codes
mean the server answered — a real signal — and return immediately, no retry.

Covered:
- transient single timeout then success -> reachable (retried, no false alert).
- timeout on every attempt -> unreachable (genuine outage still flagged).
- HTTPError (server answered) -> returned at once, NOT retried.
- retry count / backoff env overrides parse and clamp.
- backoff is slept between transport failures, not after the final attempt.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-heartbeat-watchdog.py"

_ENV_KEYS = [
    "BOT_ERRORS_LOCAL_HEALTH_RETRIES",
    "BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS",
    "BOT_ERRORS_LOCAL_HEALTH_TIMEOUT_SECONDS",
    "BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES",
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


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_watchdog_local_health", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_HEALTHY_BODY = '{"status":"healthy","instance":{"name":"q"}}'


class _FakeResponse:
    def __init__(self, status: int, body: str):
        self.status = status
        self._body = body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, _n=None):
        return self._body


# ---------------------------------------------------------------------------
# local_health_http_response retry behaviour
# ---------------------------------------------------------------------------

def test_transient_timeout_then_success_is_reachable():
    mod = _load()
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise URLError("timed out")
        return _FakeResponse(200, _HEALTHY_BODY)

    sleeps: list[float] = []
    mod.urlopen = fake_urlopen  # type: ignore[attr-defined]
    mod.time.sleep = lambda s: sleeps.append(s)  # type: ignore[attr-defined]

    status, body, url = mod.local_health_http_response("q", 9092)
    assert status == 200
    assert body == _HEALTHY_BODY
    assert calls["n"] == 2          # first failed, retry succeeded
    assert len(sleeps) == 1         # backoff slept once, between attempts


def test_timeout_every_attempt_is_unreachable():
    mod = _load()
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "2"
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        raise URLError("timed out")

    mod.urlopen = fake_urlopen  # type: ignore[attr-defined]
    mod.time.sleep = lambda s: None  # type: ignore[attr-defined]

    status, body, url = mod.local_health_http_response("q", 9092)
    assert status == 0
    assert "timed out" in body
    assert calls["n"] == 3          # 1 + 2 retries, genuine outage still flagged


def test_http_error_is_not_retried():
    mod = _load()
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "5"
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        raise HTTPError(url="u", code=503, msg="bad", hdrs=None, fp=None)

    mod.urlopen = fake_urlopen  # type: ignore[attr-defined]
    mod.time.sleep = lambda s: None  # type: ignore[attr-defined]

    status, _body, _url = mod.local_health_http_response("q", 9092)
    assert status == 503
    assert calls["n"] == 1          # server answered -> real signal, no retry


def test_first_attempt_success_does_not_retry_or_sleep():
    mod = _load()
    calls = {"n": 0}
    sleeps: list[float] = []
    mod.urlopen = lambda req, timeout=None: (calls.__setitem__("n", calls["n"] + 1) or _FakeResponse(200, _HEALTHY_BODY))  # type: ignore[attr-defined]
    mod.time.sleep = lambda s: sleeps.append(s)  # type: ignore[attr-defined]

    status, _body, _url = mod.local_health_http_response("q", 9092)
    assert status == 200
    assert calls["n"] == 1
    assert sleeps == []             # no backoff when the first probe succeeds


# ---------------------------------------------------------------------------
# config parsing
# ---------------------------------------------------------------------------

def test_retries_env_parses_and_clamps():
    mod = _load()
    assert mod.local_health_retries() == 2          # default
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "4"
    assert mod.local_health_retries() == 4
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "-3"
    assert mod.local_health_retries() == 0          # clamped non-negative
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "bad"
    assert mod.local_health_retries() == 2          # falls back to default


def test_backoff_env_parses_and_clamps():
    mod = _load()
    assert mod.local_health_retry_backoff() == pytest.approx(0.75)
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS"] = "1.5"
    assert mod.local_health_retry_backoff() == pytest.approx(1.5)
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS"] = "-2"
    assert mod.local_health_retry_backoff() == 0.0   # clamped non-negative
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS"] = "nan"
    assert mod.local_health_retry_backoff() == pytest.approx(0.75)


def test_zero_retries_preserves_single_shot():
    mod = _load()
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "0"
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        raise URLError("timed out")

    mod.urlopen = fake_urlopen  # type: ignore[attr-defined]
    mod.time.sleep = lambda s: None  # type: ignore[attr-defined]

    status, _body, _url = mod.local_health_http_response("q", 9092)
    assert status == 0
    assert calls["n"] == 1          # retries=0 -> old single-shot behaviour
