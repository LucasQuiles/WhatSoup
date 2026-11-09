"""Exercise credential boundaries through the real fleet HTTP adapter."""

import contextlib
import io
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
from threading import Thread
from unittest.mock import patch

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def isolate_proxy_configuration(monkeypatch):
    monkeypatch.setattr("urllib.request.getproxies", lambda: {})
    monkeypatch.setattr("urllib.request._opener", None)


@contextlib.contextmanager
def endpoint(status=200, payload=None, location=None):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.path, self.headers.get("Authorization")))
            body = json.dumps(payload if payload is not None else {"status": "ok"}).encode()
            self.send_response(status)
            if location is not None:
                self.send_header("Location", location)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            yield server.server_port, requests
        finally:
            server.shutdown()
            thread.join(timeout=5)
            assert not thread.is_alive(), "fixture server did not stop"


def http_adapter():
    scope = {}
    request = {"health_reader_code": (ROOT.parent / "lib/health_reader.py").read_text()}
    with patch.object(sys, "argv", ["probe", json.dumps(request)]), contextlib.redirect_stdout(io.StringIO()):
        exec(compile((ROOT / "fleet_probe_remote.py").read_text(), "fleet_probe_remote", "exec"), scope)
    return scope["http"]


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirect_never_sends_health_token_to_another_server(status):
    http = http_adapter()
    with endpoint(payload={"whatsapp": {"connected": True}}) as (other_port, other_requests):
        with endpoint(status=status, location=f"http://127.0.0.1:{other_port}/stolen") as (port, requests):
            result = http(port, "/health", "fixture-secret")
    assert requests == [("/health", "Bearer fixture-secret")]
    assert other_requests == [], "redirect target received the authenticated request"
    assert result == (None, {})


def test_redirect_body_cannot_be_used_as_authenticated_health():
    http = http_adapter()
    with endpoint(status=302, payload={"whatsapp": {"connected": True}}) as (port, requests):
        result = http(port, "/health", "fixture-secret")
    assert requests == [("/health", "Bearer fixture-secret")]
    assert result == (None, {})


@pytest.mark.parametrize("path,status,payload", [
    ("/health", 200, {"whatsapp": {"connected": True}}),
    ("/live", 200, {"status": "ok"}),
    ("/ready", 503, {"status": "unready"}),
    ("/ready", 404, {"detail": "Not Found"}),
])
def test_direct_health_and_broker_responses_keep_status_and_body(path, status, payload):
    http = http_adapter()
    with endpoint(status=status, payload=payload) as (port, requests):
        result = http(port, path, "fixture-secret")
    assert requests == [(path, "Bearer fixture-secret")]
    assert result == (status, payload)


def test_environment_proxy_cannot_receive_loopback_credentials():
    http = http_adapter()
    with endpoint(payload={"source": "proxy"}) as (proxy_port, proxy_requests):
        with endpoint(payload={"source": "direct"}) as (port, requests):
            proxy_url = f"http://127.0.0.1:{proxy_port}"
            with patch("urllib.request.getproxies", return_value={"http": proxy_url}), patch("urllib.request.proxy_bypass", return_value=False):
                result = http(port, "/health", "fixture-secret")
    assert proxy_requests == [], "environment proxy received the authenticated request"
    assert requests == [("/health", "Bearer fixture-secret")]
    assert result == (200, {"source": "direct"})


def test_existing_fleet_response_limit_accepts_more_than_shared_reader_limit():
    http = http_adapter()
    payload = {"details": "x" * 70000}
    with endpoint(payload=payload) as (port, requests):
        result = http(port, "/health")
    assert requests == [("/health", None)]
    assert result == (200, payload)
