"""Confirm-retry coverage for the watchdog local-health probe.

The watchdog should not escalate a single transport-level local health blip as
critical when the endpoint answers on a follow-up attempt. HTTP status errors
mean the server answered, so those remain immediate signal and are not retried.
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
    saved = {key: os.environ.get(key) for key in _ENV_KEYS}
    for key in _ENV_KEYS:
        os.environ.pop(key, None)
    yield
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_watchdog_local_health", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_HEALTHY_BODY = '{"status":"healthy","instance":{"name":"line-alpha"}}'


class _FakeResponse:
    def __init__(self, status: int, body: str):
        self.status = status
        self._body = body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self, _n=None):
        return self._body


def test_transient_transport_failure_then_success_is_retried():
    mod = _load_module()
    calls = {"count": 0}
    sleeps: list[float] = []

    def fake_urlopen(_request, timeout=None):
        calls["count"] += 1
        if calls["count"] == 1:
            raise URLError("timed out")
        return _FakeResponse(200, _HEALTHY_BODY)

    mod.urlopen = fake_urlopen
    mod.time.sleep = lambda seconds: sleeps.append(seconds)

    status, body, url = mod.local_health_http_response("line-alpha", 3201)

    assert status == 200
    assert body == _HEALTHY_BODY
    assert url == "http://127.0.0.1:3201/health"
    assert calls["count"] == 2
    assert len(sleeps) == 1


def test_transport_failure_on_every_attempt_remains_unreachable():
    mod = _load_module()
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "2"
    calls = {"count": 0}

    def fake_urlopen(_request, timeout=None):
        calls["count"] += 1
        raise URLError("timed out")

    mod.urlopen = fake_urlopen
    mod.time.sleep = lambda _seconds: None

    status, body, _url = mod.local_health_http_response("line-alpha", 3201)

    assert status == 0
    assert "timed out" in body
    assert calls["count"] == 3


def test_http_error_is_returned_without_retry():
    mod = _load_module()
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "5"
    calls = {"count": 0}

    def fake_urlopen(_request, timeout=None):
        calls["count"] += 1
        raise HTTPError(url="u", code=503, msg="bad", hdrs=None, fp=None)

    mod.urlopen = fake_urlopen
    mod.time.sleep = lambda _seconds: None

    status, _body, _url = mod.local_health_http_response("line-alpha", 3201)

    assert status == 503
    assert calls["count"] == 1


def test_first_attempt_success_does_not_sleep_or_retry():
    mod = _load_module()
    calls = {"count": 0}
    sleeps: list[float] = []

    def fake_urlopen(_request, timeout=None):
        calls["count"] += 1
        return _FakeResponse(200, _HEALTHY_BODY)

    mod.urlopen = fake_urlopen
    mod.time.sleep = lambda seconds: sleeps.append(seconds)

    status, _body, _url = mod.local_health_http_response("line-alpha", 3201)

    assert status == 200
    assert calls["count"] == 1
    assert sleeps == []


def test_retries_env_parses_and_clamps():
    mod = _load_module()

    assert mod.local_health_retries() == 2
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "4"
    assert mod.local_health_retries() == 4
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "-3"
    assert mod.local_health_retries() == 0
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "bad"
    assert mod.local_health_retries() == 2


def test_backoff_env_parses_and_clamps():
    mod = _load_module()

    assert mod.local_health_retry_backoff() == pytest.approx(0.75)
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS"] = "1.5"
    assert mod.local_health_retry_backoff() == pytest.approx(1.5)
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS"] = "-2"
    assert mod.local_health_retry_backoff() == 0.0
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS"] = "nan"
    assert mod.local_health_retry_backoff() == pytest.approx(0.75)


def test_zero_retries_preserves_single_shot_transport_failure():
    mod = _load_module()
    os.environ["BOT_ERRORS_LOCAL_HEALTH_RETRIES"] = "0"
    calls = {"count": 0}

    def fake_urlopen(_request, timeout=None):
        calls["count"] += 1
        raise URLError("timed out")

    mod.urlopen = fake_urlopen
    mod.time.sleep = lambda _seconds: None

    status, _body, _url = mod.local_health_http_response("line-alpha", 3201)

    assert status == 0
    assert calls["count"] == 1
