"""Bearer-bearing health probes must never send a redirected second request."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import threading

import pytest
from hypothesis import example, given, strategies as st

from bot_errors_property_support import private_case, properties


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"
_TOKEN = "synthetic-health-redirect-token"
_PUBLIC_BODY = json.dumps({
    "schema_version": "health.public.v1", "status": "healthy",
    "generated_at": "2026-10-26T00:00:00Z",
    "startupNotification": {"state": "disabled"},
}).encode()


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_GET(self):
        self.server.requests.append((self.path, self.headers.get("Authorization")))
        status = self.server.status if self.path != "/capture" else 200
        self.send_response(status)
        if 300 <= status < 400:
            self.send_header("Location", self.server.target)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.server.body)))
        self.end_headers()
        self.wfile.write(self.server.body)


@contextmanager
def _server(body, status=200):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.body, server.status, server.target, server.requests = body, status, "", []
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _probe(kind, port, root, monkeypatch):
    spec = importlib.util.spec_from_file_location("health_redirect_probe", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for key in ["BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON", "BOT_ERRORS_DRY_FLEET_API_STATUS",
                "BOT_ERRORS_DRY_FLEET_API_ERROR", "BOT_ERRORS_DRY_FLEET_TOKEN_JSON"]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    if kind == "health":
        monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", _TOKEN)
        return module.probe_health(port, "synthetic-instance")
    token_path = root / "fleet-token.json"
    token_path.write_text(json.dumps({"active": _TOKEN, "accept": []}))
    token_path.chmod(0o600)
    monkeypatch.setenv("BOT_ERRORS_FLEET_TOKEN_FILE", str(token_path))
    monkeypatch.setenv("BOT_ERRORS_FLEET_API_URL", f"http://127.0.0.1:{port}")
    return "\n".join(module.fleet_api_inventory({"expectFleetApi": True}))


@properties
@given(kind=st.sampled_from(["health", "fleet"]), status=st.sampled_from([301, 302, 303, 307, 308]),
       other_port=st.booleans())
@example(kind="health", status=302, other_port=True)
@example(kind="fleet", status=302, other_port=True)
@example(kind="health", status=307, other_port=False)
@example(kind="fleet", status=308, other_port=False)
def test_health_probes_refuse_redirects_without_forwarding_bearer(kind, status, other_port):
    body = _PUBLIC_BODY if kind == "health" else b"[]"
    with private_case() as (root, monkeypatch), _server(body) as capture, _server(body, status) as source:
        target_port = capture.server_port if other_port else source.server_port
        source.target = f"http://127.0.0.1:{target_port}/capture"

        line = _probe(kind, source.server_port, root, monkeypatch)

        assert capture.requests == []
        assert source.requests == [("/health" if kind == "health" else "/api/lines", f"Bearer {_TOKEN}")]
        assert line.startswith("FAIL ")
        assert "redirect_refused" in line
        assert str(status) in line
        assert _TOKEN not in line


@pytest.mark.parametrize("kind", ["health", "fleet"])
def test_health_probes_still_authenticate_direct_responses(kind):
    body = _PUBLIC_BODY if kind == "health" else b"[]"
    with private_case() as (root, monkeypatch), _server(body) as source:
        line = _probe(kind, source.server_port, root, monkeypatch)

        assert source.requests == [("/health" if kind == "health" else "/api/lines", f"Bearer {_TOKEN}")]
        assert "200" in line
        assert "redirect_refused" not in line
        assert not line.startswith("FAIL ")
        assert _TOKEN not in line
