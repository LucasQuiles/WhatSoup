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

from contextlib import contextmanager
import http.server
import importlib.util
import json
import string
import threading
import time
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from hypothesis import example, given, settings, strategies as st

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

_PATH_SEGMENT = st.text(alphabet=string.ascii_lowercase + string.digits + "-_", min_size=1, max_size=48)
_ARBITRARY_REFUSED_FLEET_PATH = st.one_of(
    _PATH_SEGMENT.map(lambda segment: f"/{segment}"),
    _PATH_SEGMENT.map(lambda segment: f"/{segment}/api/lines"),
    _PATH_SEGMENT.map(lambda segment: f"/api/lines/{segment}"),
    _PATH_SEGMENT.map(lambda segment: f"/api%2f{segment}"),
    _PATH_SEGMENT.map(lambda segment: f"//{segment}"),
)
_SUPPORTED_FLEET_PATHS = ("", "/api/lines", "/api/instances")


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


@contextmanager
def fleet_profile_scope(base, monkeypatch):
    for key in _FLEET_ENV + _PROXY_ENV:
        monkeypatch.delenv(key, raising=False)
    # urlopen caches one opener per process and reads the proxy settings when it
    # builds it; drop the cache so no case depends on test order.
    monkeypatch.setattr(urllib.request, "_opener", None)
    token = base / "fleet-tokens.json"
    token.write_text(json.dumps({"active": "synthetic-fleet-token", "accept": []}), encoding="utf-8")
    token.chmod(0o600)
    servers: list = []
    try:
        yield lambda url: {"expectFleetApi": True, "fleetApiTokenFile": str(token), "fleetApiUrl": url}, servers
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


@pytest.fixture
def fleet_profile(tmp_path, monkeypatch):
    with fleet_profile_scope(tmp_path, monkeypatch) as profile:
        yield profile


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


@pytest.mark.parametrize("host", ["localhost", "LOCALHOST"])
def test_named_loopback_alias_is_refused_before_token_read(fleet_profile, monkeypatch, host):
    profile_for, _servers = fleet_profile
    profile = profile_for(f"http://{host}:9099")
    reads = []
    monkeypatch.setattr(_mod, "load_fleet_api_token", lambda *_a: (
        reads.append("token") or ("synthetic-token", "fixture", 0, None)
    ))
    monkeypatch.setattr(_mod, "urlopen", lambda *_a, **_k: None)

    assert _mod.fleet_api_inventory(profile) == ["FAIL fleet_api: fleet_api_host_refused"]
    assert reads == []


@pytest.mark.parametrize("component", ["?token=synthetic-private-value", "#synthetic-private-value"])
def test_fleet_url_components_are_refused_without_disclosure(fleet_profile, monkeypatch, component):
    profile_for, _servers = fleet_profile
    profile = profile_for("http://127.0.0.1:9099/api/lines" + component)
    reads = []
    monkeypatch.setattr(_mod, "load_fleet_api_token", lambda *_a: (
        reads.append("token") or ("synthetic-token", "fixture", 0, None)
    ))
    monkeypatch.setattr(_mod, "urlopen", lambda *_a, **_k: None)

    assert _mod.fleet_api_inventory(profile) == ["FAIL fleet_api: fleet_api_host_refused"]
    assert reads == []


@given(consumer=st.sampled_from(("dispatcher", "health")),
       via=st.sampled_from(("environment", "profile")), path=_ARBITRARY_REFUSED_FLEET_PATH)
@example(consumer='dispatcher', via='environment', path='/synthetic-private-value')
@example(consumer='dispatcher', via='environment', path='/synthetic-private-value/api/lines')
@example(consumer='dispatcher', via='environment', path='/synthetic-private-value/api/instances')
@example(consumer='dispatcher', via='environment', path='/api/lines/../synthetic-private-value')
@example(consumer='dispatcher', via='environment', path='/api%2flines')
@example(consumer='dispatcher', via='environment', path='//api/lines')
@example(consumer='dispatcher', via='profile', path='/synthetic-private-value')
@example(consumer='dispatcher', via='profile', path='/synthetic-private-value/api/lines')
@example(consumer='dispatcher', via='profile', path='/synthetic-private-value/api/instances')
@example(consumer='dispatcher', via='profile', path='/api/lines/../synthetic-private-value')
@example(consumer='dispatcher', via='profile', path='/api%2flines')
@example(consumer='dispatcher', via='profile', path='//api/lines')
@example(consumer='health', via='environment', path='/synthetic-private-value')
@example(consumer='health', via='environment', path='/synthetic-private-value/api/lines')
@example(consumer='health', via='environment', path='/synthetic-private-value/api/instances')
@example(consumer='health', via='environment', path='/api/lines/../synthetic-private-value')
@example(consumer='health', via='environment', path='/api%2flines')
@example(consumer='health', via='environment', path='//api/lines')
@example(consumer='health', via='profile', path='/synthetic-private-value')
@example(consumer='health', via='profile', path='/synthetic-private-value/api/lines')
@example(consumer='health', via='profile', path='/synthetic-private-value/api/instances')
@example(consumer='health', via='profile', path='/api/lines/../synthetic-private-value')
@example(consumer='health', via='profile', path='/api%2flines')
@example(consumer='health', via='profile', path='//api/lines')
@settings(max_examples=60, deadline=None, database=None)
def test_arbitrary_fleet_paths_are_refused_before_credentials_or_requests(consumer, via, path):
    with TemporaryDirectory(prefix="fleet-token-target-") as directory:
        with pytest.MonkeyPatch.context() as monkeypatch:
            with fleet_profile_scope(Path(directory), monkeypatch) as (profile_for, _servers):
                from lib import fleet_lines

                url = "http://127.0.0.1:9099" + path
                profile = profile_for(url)
                if via == "environment":
                    profile.pop("fleetApiUrl")
                    monkeypatch.setenv("BOT_ERRORS_FLEET_API_URL", url)
                reads = []
                requests = []
                monkeypatch.setattr(_mod, "load_fleet_api_token", lambda *_a: (
                    reads.append("health-token") or ("synthetic-token", "fixture", 0, None)
                ))
                monkeypatch.setattr(fleet_lines, "read_fleet_token_text", lambda *_a: (
                    reads.append("dispatcher-token") or ('{"active":"synthetic-token"}', None)
                ))
                monkeypatch.setattr(_mod, "urlopen", lambda *_a, **_k: requests.append("health-request"))
                monkeypatch.setattr(fleet_lines, "fleet_api_opener", lambda: (
                    lambda *_a, **_k: requests.append("dispatcher-request")
                ))

                if consumer == "health":
                    result = _mod.fleet_api_inventory(profile)
                else:
                    observed = fleet_lines.read_fleet_lines(profile, timeout=5)
                    result = [observed.error]
                    assert observed.lines is None

                assert reads == [], "credentials were read for an arbitrary API path"
                assert requests == [], "a request was made for an arbitrary API path"
                assert result == (["FAIL fleet_api: fleet_api_host_refused"] if consumer == "health"
                                  else ["fleet_api_host_refused"])


@given(consumer=st.sampled_from(("dispatcher", "health")), path=st.sampled_from(_SUPPORTED_FLEET_PATHS))
@example(consumer='dispatcher', path='')
@example(consumer='dispatcher', path='/api/lines')
@example(consumer='dispatcher', path='/api/instances')
@example(consumer='health', path='')
@example(consumer='health', path='/api/lines')
@example(consumer='health', path='/api/instances')
@settings(max_examples=6, deadline=None, database=None)
def test_supported_fleet_paths_reach_only_the_named_local_endpoint(consumer, path):
    with TemporaryDirectory(prefix="fleet-token-target-") as directory:
        with pytest.MonkeyPatch.context() as monkeypatch:
            with fleet_profile_scope(Path(directory), monkeypatch) as (profile_for, servers):
                from lib.fleet_lines import read_fleet_lines

                local, seen = _serve("127.0.0.1", _lines_reply)
                servers.append(local)
                profile = profile_for(f"http://127.0.0.1:{local.server_address[1]}" + path)

                if consumer == "health":
                    [line] = _mod.fleet_api_inventory(profile)
                    assert line.startswith("fleet_api: status=200"), line
                else:
                    result = read_fleet_lines(profile, timeout=5)
                    assert result.error is None
                    assert result.lines is not None

                assert seen == [{"path": path or "/api/lines", "authorization": "Bearer synthetic-fleet-token"}]


@pytest.mark.parametrize("consumer", ["dispatcher", "health"])
@pytest.mark.parametrize("phase", ["headers", "body"])
@pytest.mark.parametrize("error_status", [False, True])
def test_fleet_transfer_deadline_bounds_a_dripping_peer(fleet_profile, monkeypatch, consumer, phase, error_status):
    from lib.fleet_lines import read_fleet_lines

    profile_for, servers = fleet_profile
    disconnected = threading.Event()
    received = threading.Event()
    stopped = threading.Event()

    class DrippingHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - stdlib entry point
            received.set()
            body = b'{"lines":[],"padding":"012345678901234567890123456789"}'
            status = b"503 Unavailable" if error_status else b"200 OK"
            headers = b"HTTP/1.1 " + status + b"\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n"
            prefix, dripping = (b"", headers + body) if phase == "headers" else (headers, body)
            try:
                self.connection.sendall(prefix)
                for byte in dripping:
                    if stopped.is_set():
                        break
                    self.connection.sendall(bytes([byte]))
                    # Keep bytes arriving within the socket timeout while exceeding the total deadline.
                    if stopped.wait(0.05):
                        break
            except (BrokenPipeError, ConnectionResetError):
                disconnected.set()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DrippingHandler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    servers.append(server)
    profile = profile_for(f"http://127.0.0.1:{server.server_address[1]}")
    monkeypatch.setattr(_mod, "HEALTH_PROBE_TIMEOUT_SECONDS", 0.5)
    started = time.monotonic()
    try:
        if consumer == "dispatcher":
            result = read_fleet_lines(profile, timeout=0.5)
            failed = result.lines is None and result.error is not None
        else:
            [line] = _mod.fleet_api_inventory(profile)
            failed = line.startswith("FAIL fleet_api:")
            assert "synthetic-fleet-token" not in line
        elapsed = time.monotonic() - started
        assert received.is_set(), "the real local peer was never contacted"
        assert failed, "an unfinished transfer must not become usable inventory"
        assert elapsed < 1.5, f"whole-transfer deadline was exceeded: {elapsed:.2f}s"
        assert disconnected.wait(1), "the deadline left the transport running"
    finally:
        stopped.set()
        server.shutdown()
        serving.join(timeout=2)
