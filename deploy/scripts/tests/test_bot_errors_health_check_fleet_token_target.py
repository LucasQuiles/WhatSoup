"""The health check sends its tokens only to the local port it names (relay 23 W2).

fleet_api_inventory sent the fleet token through the default urlopen: an
environment proxy received it, a redirect from the local port carried the
Authorization header to the new host, and an environment or profile URL
override sent it to any host. probe_health sent the per-instance health tokens
to 127.0.0.1 the same way, so an environment proxy received them. Relay 22 A2
made this a must-fix for the dispatcher; the health check now uses the same
helpers (lib.fleet_lines): the target is refused before the token is read, and
the opener uses no proxy and follows no redirect.
"""
from __future__ import annotations

import http.server
import importlib.util
import json
import threading
import urllib.request
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"

_FLEET_ENV = (
    "BOT_ERRORS_FLEET_API_URL",
    "BOT_ERRORS_FLEET_TOKEN_FILE",
    "BOT_ERRORS_FLEET_API_PORT",
    "FLEET_BIND_ADDRESS",
    "BOT_ERRORS_DRY_FLEET_TOKEN_JSON",
    "BOT_ERRORS_DRY_FLEET_API_ERROR",
    "BOT_ERRORS_DRY_FLEET_API_STATUS",
    "BOT_ERRORS_DRY_FLEET_API_BODY",
    "BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON",
)
_PROXY_ENV = ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "all_proxy", "ALL_PROXY")


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check_fleet_token_target", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _serve(host: str, reply):
    """A one-thread HTTP server on `host` that records each request's path and token header."""
    seen: list[dict] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - the stdlib handler name
            seen.append({"path": self.path, "authorization": self.headers.get("Authorization")})
            status, headers, body = reply(self)
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer((host, 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


def _lines_reply(_handler):
    return 200, {"Content-Type": "application/json"}, json.dumps([{"name": "q"}]).encode()


@pytest.fixture
def fleet_profile(tmp_path, monkeypatch):
    for key in _FLEET_ENV + _PROXY_ENV:
        monkeypatch.delenv(key, raising=False)
    # urlopen caches one opener per process and reads the proxy settings when it
    # builds it; drop the cache so no case depends on test order.
    monkeypatch.setattr(urllib.request, "_opener", None)
    token = tmp_path / "fleet-tokens.json"
    token.write_text(json.dumps({"active": "synthetic-fleet-token", "accept": []}), encoding="utf-8")
    token.chmod(0o600)
    servers: list = []
    yield lambda url: {"expectFleetApi": True, "fleetApiTokenFile": str(token), "fleetApiUrl": url}, servers
    for server in servers:
        server.shutdown()
        server.server_close()


def _set_proxy(monkeypatch, proxy) -> None:
    for key in ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"):
        monkeypatch.setenv(key, f"http://127.0.0.1:{proxy.server_address[1]}")


def test_a_redirect_sends_no_fleet_token_and_gives_a_reason(fleet_profile):
    profile_for, servers = fleet_profile
    other, other_seen = _serve("127.0.0.1", _lines_reply)
    target = f"http://127.0.0.1:{other.server_address[1]}/api/lines"
    local, local_seen = _serve("127.0.0.1", lambda _h: (302, {"Location": target}, b""))
    servers.extend([other, local])

    [line] = _mod.fleet_api_inventory(profile_for(f"http://127.0.0.1:{local.server_address[1]}"))

    assert other_seen == [], "the redirect was followed and the token went with it"
    assert [entry["authorization"] for entry in local_seen] == ["Bearer synthetic-fleet-token"]
    assert line.startswith("FAIL fleet_api: fleet_api_redirect_refused"), line
    assert "synthetic-fleet-token" not in line


def test_a_proxy_setting_in_the_environment_is_not_used_for_the_fleet_call(fleet_profile, monkeypatch):
    profile_for, servers = fleet_profile
    proxy, proxy_seen = _serve("127.0.0.1", _lines_reply)
    local, local_seen = _serve("127.0.0.1", _lines_reply)
    servers.extend([proxy, local])
    _set_proxy(monkeypatch, proxy)

    [line] = _mod.fleet_api_inventory(profile_for(f"http://127.0.0.1:{local.server_address[1]}"))

    assert proxy_seen == [], "the request and its token went through the proxy"
    assert [entry["path"] for entry in local_seen] == ["/api/lines"]
    assert line.startswith("fleet_api: status=200"), line


@pytest.mark.parametrize("via", ["environment", "profile"])
@pytest.mark.parametrize("url", ["http://192.0.2.55:9099", "https://127.0.0.1:9099", "http://fleet.example:9099"])
def test_an_override_to_another_host_is_refused_with_no_request(fleet_profile, monkeypatch, via, url):
    profile_for, _servers = fleet_profile
    profile = profile_for(url)
    if via == "environment":
        profile.pop("fleetApiUrl")
        monkeypatch.setenv("BOT_ERRORS_FLEET_API_URL", url)
    requests: list = []
    token_reads: list = []
    real_load = _mod.load_fleet_api_token

    def _load_token(*args, **kwargs):
        token_reads.append(1)
        return real_load(*args, **kwargs)

    monkeypatch.setattr(_mod, "load_fleet_api_token", _load_token)
    monkeypatch.setattr(_mod, "urlopen", lambda request, **_k: requests.append(request))

    [line] = _mod.fleet_api_inventory(profile)

    assert requests == [], "a request left for a host the token must never reach"
    assert token_reads == [], "the token was read for a refused target"
    assert line.startswith("FAIL fleet_api: fleet_api_host_refused"), line


def test_non_loopback_configured_bind_is_refused_before_token_read(fleet_profile, monkeypatch):
    profile_for, _servers = fleet_profile
    profile = profile_for("")
    profile.pop("fleetApiUrl")
    profile["fleetApi"] = {"bindAddress": "192.0.2.10", "port": 9098}
    requests: list = []
    token_reads: list = []
    real_load = _mod.load_fleet_api_token

    def _load_token(*args, **kwargs):
        token_reads.append(1)
        return real_load(*args, **kwargs)

    monkeypatch.setattr(_mod, "load_fleet_api_token", _load_token)
    monkeypatch.setattr(_mod, "urlopen", lambda request, **_k: requests.append(request))

    [line] = _mod.fleet_api_inventory(profile)

    assert requests == [], "a configured non-loopback bind must not receive the token"
    assert token_reads == [], "the token was read for a refused configured bind"
    assert line.startswith("FAIL fleet_api: fleet_api_host_refused"), line


def test_a_proxy_setting_in_the_environment_is_not_used_for_the_instance_health_call(fleet_profile, monkeypatch):
    _profile_for, servers = fleet_profile
    proxy, proxy_seen = _serve("127.0.0.1", lambda _h: (200, {"Content-Type": "application/json"}, b"{}"))
    local, local_seen = _serve("127.0.0.1", lambda _h: (200, {"Content-Type": "application/json"}, b"{}"))
    servers.extend([proxy, local])
    _set_proxy(monkeypatch, proxy)
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "synthetic-health-token")

    _mod.probe_health(local.server_address[1], "primary-bot")

    assert proxy_seen == [], "the health token went through the proxy"
    assert [entry["authorization"] for entry in local_seen] == ["Bearer synthetic-health-token"]


_MALFORMED = "SYNTHmalformedtoken0123\nX"


def _assert_no_token_bytes(line: str) -> None:
    for fragment in ("SYNTH", "malformed", "token0123", "Bearer"):
        assert fragment not in line, line


def test_a_malformed_fleet_token_never_reaches_the_report_line(fleet_profile, tmp_path):
    # Relay 25 Y3: a token with a line break makes http.client raise
    # "Invalid header value" holding the full "Bearer <token>" bytes. The line
    # names the exception type only.
    profile_for, servers = fleet_profile
    local, local_seen = _serve("127.0.0.1", _lines_reply)
    servers.append(local)
    profile = profile_for(f"http://127.0.0.1:{local.server_address[1]}")
    Path(profile["fleetApiTokenFile"]).write_text(json.dumps({"active": _MALFORMED, "accept": []}), encoding="utf-8")

    [line] = _mod.fleet_api_inventory(profile)

    assert local_seen == []
    assert line.startswith("FAIL fleet_api: fleet_api_probe_failed"), line
    assert line.endswith("error=ValueError"), line
    _assert_no_token_bytes(line)


def test_a_malformed_health_token_never_reaches_the_report_line(fleet_profile, monkeypatch):
    _profile_for, servers = fleet_profile
    local, local_seen = _serve("127.0.0.1", lambda _h: (200, {"Content-Type": "application/json"}, b"{}"))
    servers.append(local)
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", _MALFORMED)

    line = _mod.probe_health(local.server_address[1], "primary-bot")

    assert local_seen == []
    assert line == f"FAIL http://127.0.0.1:{local.server_address[1]}/health ValueError", line
    _assert_no_token_bytes(line)
