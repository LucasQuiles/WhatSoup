"""The bot-memory inventory reports each instance's Pinecone memory health.

Per instance with memory.pinecone: detailed /health memory readiness, and the
configured index as seen with the instance's own key (describe + stats only).
Real defects (readiness not ready, missing index, index in another project,
field map not `text`) are per-instance FAIL lines, so they page BOT ERRORS.
Protection off and zero records are evidence only. The key never appears in
any line, and the inventory does nothing unless the profile opts in.

The key goes only to a project the runtime's guard names, readiness counts only
from this instance's authenticated diagnostic body, and the whole inventory is
bounded: hostile or broken input ends in one truncation line, never a crash.
"""
from __future__ import annotations

from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import re
import threading
import time
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"
_GUARD_SOURCE = Path(__file__).resolve().parents[3] / "src/lib/pinecone-project-guard.ts"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


@pytest.fixture(autouse=True)
def _not_writable_by_others():
    """The inventory refuses folders and configs others can write, so fixtures never are."""
    previous = os.umask(0o022)
    yield
    os.umask(previous)


TAIL ="-proj123.svc.example.pinecone.io"
CFG = {"expectedHostSuffix": TAIL, "index": "whatsapp-bot"}
READY = {"state": "ready", "http": 200, "failure_code": "none"}
INDEX = {"http": 200, "host": "whatsapp-bot" + TAIL, "field_map": {"text": "text"},
         "model": "llama-text-embed-v2", "deletion_protection": "enabled"}
STATS = {"http": 200, "records": 3}
FAKE_KEY = "fake-key-value-never-printed"


def _lines(cfg=CFG, readiness=READY, index=INDEX, stats=STATS, key_resolved=True):
    return _mod.bot_memory_lines("bot-a", cfg, readiness, index, stats, key_resolved)


def _flagged(lines):
    return [line for line in lines if _mod.daily_health_line_is_failure(line) or _mod.daily_health_line_is_warning(line)]


def test_healthy_instance_is_evidence_only() -> None:
    lines = _lines()
    assert _flagged(lines) == []
    assert lines == ["bot_memory bot-a: readiness=ready index=whatsapp-bot field_map=text protection=enabled records=3"]


def test_readiness_not_ready_fails_and_routes_to_the_instance() -> None:
    lines = _lines(readiness={"state": "disabled", "http": 200, "failure_code": "local_guard"})
    fails = [line for line in lines if _mod.daily_health_line_is_failure(line)]
    assert fails == ["FAIL bot_memory bot-a: readiness=disabled failure_code=local_guard"]
    assert _mod._instance_from_fail_line(fails[0]) == "bot-a"
    assert _mod.daily_summary_severity(fails, []) == "critical"


def test_field_map_other_than_text_fails() -> None:
    lines = _lines(index=dict(INDEX, field_map={"text": "chunk_text"}))
    assert [line for line in lines if line.startswith("FAIL ")] == [
        "FAIL bot_memory bot-a: field_map={'text': 'chunk_text'} (WhatSoup writes `text`; every memory save fails)"]


OTHER_HOST = "whatsapp-bot-other99.svc.example.pinecone.io"
MISMATCH = {"state": "project_mismatch", "http": 503, "failure_code": "project_guard_failed"}
MISSING = {"state": "index_missing", "http": 503, "failure_code": "none"}


def test_index_in_another_project_fails_when_readiness_agrees() -> None:
    lines = _lines(readiness=MISMATCH, index=dict(INDEX, host=OTHER_HOST, field_map={"text": "chunk_text"}))
    assert [line for line in lines if line.startswith("FAIL ")] == [
        "FAIL bot_memory bot-a: readiness=project_mismatch failure_code=project_guard_failed",
        "FAIL bot_memory bot-a: wrong_project index host is outside the configured project"]


def test_foreign_index_seen_through_the_job_key_only_warns_when_the_bot_is_ready() -> None:
    # The bot reaches its own index (readiness=ready), so the job resolved another key;
    # the foreign index's field map is not the bot's and is not judged.
    lines = _lines(index=dict(INDEX, host=OTHER_HOST, field_map={"text": "chunk_text"}))
    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == [
        "WARN bot_memory bot-a: wrong_project index host is outside the configured project job_key_differs (readiness=ready)"]


def test_project_id_guard_is_checked_too() -> None:
    lines = _lines(cfg={"projectId": "other99"}, readiness=MISMATCH)
    assert any(line.startswith("FAIL bot_memory bot-a: wrong_project") for line in lines)
    assert _flagged(_lines(cfg={"projectId": "proj123"})) == []


def test_project_id_check_matches_the_runtime_guard() -> None:
    # src/lib/pinecone-project-guard.ts accepts `-<projectId>.` anywhere in the host.
    lines = _lines(cfg={"projectId": "proj123"}, index=dict(INDEX, host="whatsapp-bot-proj123.eu.example.pinecone.io"))
    assert _flagged(lines) == []


def test_missing_index_fails_when_readiness_agrees() -> None:
    lines = _lines(readiness=MISSING, index={"http": 404}, stats=None)
    assert [line for line in lines if line.startswith("FAIL ")] == [
        "FAIL bot_memory bot-a: readiness=index_missing failure_code=none",
        "FAIL bot_memory bot-a: index_missing index=whatsapp-bot"]


def test_missing_index_through_the_job_key_only_warns_when_the_bot_is_ready() -> None:
    lines = _lines(index={"http": 404}, stats=None)
    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == [
        "WARN bot_memory bot-a: index_missing index=whatsapp-bot job_key_differs (readiness=ready)"]


def test_missing_index_with_unreadable_readiness_is_unconfirmed() -> None:
    lines = _lines(readiness={"state": None, "http": None, "why": "no_health_token"}, index={"http": 404}, stats=None)
    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == [
        "WARN bot_memory bot-a: readiness_unreadable http=None why=no_health_token",
        "WARN bot_memory bot-a: index_missing index=whatsapp-bot unconfirmed (readiness unreadable)"]


def test_protection_off_and_zero_records_are_evidence_only() -> None:
    lines = _lines(index=dict(INDEX, deletion_protection="disabled"), stats={"http": 200, "records": 0})
    assert _flagged(lines) == []
    assert "protection=disabled" in lines[0] and "records=0" in lines[0]


def test_unreadable_readiness_is_a_warning_not_a_failure() -> None:
    lines = _lines(readiness={"state": None, "http": None, "why": "no_health_token"})
    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == [
        "WARN bot_memory bot-a: readiness_unreadable http=None why=no_health_token"]


def test_key_not_visible_to_the_health_job_is_evidence_only() -> None:
    lines = _lines(index=None, stats=None, key_resolved=False)
    assert _flagged(lines) == []
    assert lines == ["bot_memory bot-a: readiness=ready index=whatsapp-bot index_not_probed=key_not_visible"]


def test_rejected_key_warns() -> None:
    lines = _lines(index={"http": 401}, stats=None)
    assert [line for line in lines if line.startswith(("FAIL ", "WARN "))] == [
        "WARN bot_memory bot-a: index_unreadable http=401"]


def test_a_failed_record_count_read_warns() -> None:
    lines = _lines(stats={"http": 503, "records": None})
    assert _flagged(lines) == ["WARN bot_memory bot-a: stats_unreadable http=503"]
    assert lines[-1].endswith("records=unknown")


def test_a_record_count_never_attempted_is_not_a_read_failure() -> None:
    # Outside the project the key never reaches the data host, so no read failed.
    lines = _lines(index=dict(INDEX, host=OTHER_HOST), stats=None)
    assert not any("stats_unreadable" in line for line in lines)


def test_inventory_is_off_unless_the_profile_opts_in(monkeypatch) -> None:
    def boom(*_args, **_kwargs):
        raise AssertionError("no probe may run when the profile does not opt in")
    monkeypatch.setattr(_mod, "bot_memory_configs", boom)
    assert _mod.bot_memory_inventory({}) == []
    assert _mod.bot_memory_inventory({"expectBotMemory": False}) == []


def _home_with_instance(tmp_path: Path, instance: str, pinecone: dict, **top) -> None:
    folder = tmp_path / ".config/whatsoup/instances" / instance
    folder.mkdir(parents=True)
    (folder / "config.json").write_text(json.dumps(dict({"healthPort": 9999, "memory": {"pinecone": pinecone}}, **top)))


def test_inventory_probes_with_the_instance_key_and_never_prints_it(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    # The launcher unsets this before its lookup; the job's own value is not the bot's key.
    monkeypatch.setenv("PINECONE_API_KEY", "job-environment-value")
    _home_with_instance(tmp_path, "bot-a", CFG)
    _home_with_instance(tmp_path, "no-memory", {})
    seen = {}
    monkeypatch.setattr(_mod, "bot_memory_readiness", lambda name, port: READY)

    def credential(service, timeout, source_env):
        seen["lookup_env_has_key"] = "PINECONE_API_KEY" in source_env
        seen["lookup_env_home"] = source_env.get("HOME")
        return FAKE_KEY if service == "pinecone" else None
    monkeypatch.setattr(_mod, "provider_credential_value", credential)

    def describe(key, index):
        seen["describe"] = (key, index)
        return INDEX

    def stats(key, host):
        seen["stats"] = (key, host)
        return STATS
    monkeypatch.setattr(_mod, "pinecone_describe_index", describe)
    monkeypatch.setattr(_mod, "pinecone_index_stats", stats)
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert seen == {"lookup_env_has_key": False, "lookup_env_home": str(tmp_path),
                    "describe": (FAKE_KEY, "whatsapp-bot"), "stats": (FAKE_KEY, "whatsapp-bot" + TAIL)}
    assert lines == ["bot_memory bot-a: readiness=ready index=whatsapp-bot field_map=text protection=enabled records=3"]
    assert all(FAKE_KEY not in line for line in lines)


def _probe_with_described_host(tmp_path, monkeypatch, cfg, host):
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "bot-a", cfg)
    monkeypatch.setattr(_mod, "bot_memory_readiness", lambda name, port: READY)
    monkeypatch.setattr(_mod, "provider_credential_value", lambda service, timeout, source_env: FAKE_KEY)
    monkeypatch.setattr(_mod, "pinecone_describe_index", lambda key, index: dict(INDEX, host=host))

    def stats(key, host):
        raise AssertionError("the key may go only to a Pinecone host inside the configured project")
    monkeypatch.setattr(_mod, "pinecone_index_stats", stats)
    return _mod.bot_memory_inventory({"expectBotMemory": True})


def test_key_is_not_sent_to_an_index_host_outside_the_project(tmp_path, monkeypatch) -> None:
    lines = _probe_with_described_host(tmp_path, monkeypatch, CFG, OTHER_HOST)
    assert lines[0].startswith("WARN bot_memory bot-a: wrong_project")
    assert lines[-1].endswith("records=unknown")


def test_key_is_not_sent_to_a_host_that_is_not_pinecone(tmp_path, monkeypatch) -> None:
    # The host passes the configured guard, so only the Pinecone-host rule refuses it.
    cfg = {"expectedHostSuffix": ".example.com", "index": "whatsapp-bot"}
    lines = _probe_with_described_host(tmp_path, monkeypatch, cfg, "whatsapp-bot.example.com")
    assert lines == ["bot_memory bot-a: readiness=ready index=whatsapp-bot field_map=text protection=enabled "
                     "records=unknown stats_not_probed=host_not_pinecone"]


def test_instance_with_its_own_key_variable_is_not_probed(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "bot-b", dict(CFG, apiKeyEnv="OTHER_PINECONE_API_KEY"))
    monkeypatch.setattr(_mod, "bot_memory_readiness", lambda name, port: READY)

    def boom(*_args, **_kwargs):
        raise AssertionError("a launcher-only key variable is not resolvable by the health job")
    monkeypatch.setattr(_mod, "provider_credential_value", boom)
    monkeypatch.setattr(_mod, "pinecone_describe_index", boom)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "bot_memory bot-b: readiness=ready index=whatsapp-bot index_not_probed=key_not_visible"]


def test_a_memory_key_service_setting_does_not_stop_the_probe(tmp_path, monkeypatch) -> None:
    # resolveMemoryConfig (src/config.ts) drops memory.pinecone.apiKeyService, so the
    # runtime keys this instance the normal way and the inventory must probe it too.
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "bot-c", dict(CFG, apiKeyService="other-pinecone"))
    seen = _stub_probes(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_healthy("bot-c")]
    assert seen["credential"] == 1 and seen["describe"] == ["whatsapp-bot"]


def _stub_probes(monkeypatch, host=INDEX["host"], readiness=READY) -> dict:
    seen = {"credential": 0, "describe": [], "stats": []}
    monkeypatch.setattr(_mod, "bot_memory_readiness", lambda name, port: readiness)

    def credential(service, timeout, source_env):
        seen["credential"] += 1
        return FAKE_KEY

    def describe(key, index):
        seen["describe"].append(index)
        return dict(INDEX, host=host)

    def stats(key, host):
        seen["stats"].append(host)
        return STATS
    monkeypatch.setattr(_mod, "provider_credential_value", credential)
    monkeypatch.setattr(_mod, "pinecone_describe_index", describe)
    monkeypatch.setattr(_mod, "pinecone_index_stats", stats)
    return seen


def test_operator_guard_matches_the_runtime_source() -> None:
    # The checker copies the runtime's operator default; this keeps the copies equal.
    source = _GUARD_SOURCE.read_text(encoding="utf-8")

    def constant(name: str) -> str:
        match = re.search(rf"^export const {name} = '([^']+)';$", source, re.MULTILINE)
        assert match, name
        return match.group(1)
    assert _mod.BOT_MEMORY_OPERATOR_INSTANCE == constant("OPERATOR_INSTANCE_NAME")
    assert _mod.BOT_MEMORY_OPERATOR_PROJECT_ID == constant("OPERATOR_PINECONE_PROJECT_ID")


@pytest.mark.parametrize("name", ["q", " Q "])
def test_operator_instance_without_a_guard_is_held_to_the_operator_project(tmp_path, monkeypatch, name) -> None:
    # resolvePineconeProjectGuard: the config `name` (botName), trimmed and lower-cased.
    monkeypatch.setattr(_mod, "BOT_MEMORY_OPERATOR_PROJECT_ID", "proj123")
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "operator", {"index": "whatsapp-bot"}, name=name)
    seen = _stub_probes(monkeypatch)
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert seen["stats"] == ["whatsapp-bot" + TAIL]
    assert lines == ["bot_memory operator: readiness=ready index=whatsapp-bot field_map=text protection=enabled records=3"]


def test_operator_default_refuses_a_host_outside_the_operator_project(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_OPERATOR_PROJECT_ID", "proj123")
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "operator", {"index": "whatsapp-bot"}, name="q")
    seen = _stub_probes(monkeypatch, host=OTHER_HOST)
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert seen["stats"] == []
    assert lines[0].startswith("WARN bot_memory operator: wrong_project")
    assert lines[-1].endswith("records=unknown")


@pytest.mark.parametrize(("folder", "top"), [
    pytest.param("bot-a", {}, id="no-name"),
    pytest.param("bot-a", {"name": "bot-a"}, id="named"),
    # The runtime names an instance by its config, not its folder.
    pytest.param("q", {}, id="operator-folder-without-operator-name"),
    # The runtime runs an empty name unguarded; the checker still sends no key.
    pytest.param("bot-a", {"name": ""}, id="empty-name"),
])
def test_unguarded_instance_fails_and_its_key_is_never_resolved(tmp_path, monkeypatch, folder, top) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, folder, {"index": "whatsapp-bot"}, **top)
    seen = _stub_probes(monkeypatch)
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert seen == {"credential": 0, "describe": [], "stats": []}
    assert lines == [
        f"FAIL bot_memory {folder}: project_guard_missing (memory.pinecone sets neither projectId nor expectedHostSuffix; the key is not sent)",
        f"bot_memory {folder}: readiness=ready index=whatsapp-bot index_not_probed=project_guard_missing"]
    assert _mod._instance_from_fail_line(lines[0]) == folder


def test_host_check_fails_closed_without_a_guard() -> None:
    assert _mod.bot_memory_host_in_project("whatsapp-bot" + TAIL, {}) is False
    assert _mod.bot_memory_host_in_project("", {"projectId": "proj123"}) is False
    assert _mod.bot_memory_host_in_project("whatsapp-bot" + TAIL, {"projectId": "proj123"}) is True


def test_daily_includes_the_inventory() -> None:
    assert "*bot_memory_inventory(profile)" in inspect.getsource(_mod.daily)


class _Response:
    def __init__(self, status: int, body: bytes) -> None:
        self.status, self._body = status, body

    def read(self, _limit: int = -1) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc) -> None:
        return None


def _http_error(code: int, body: bytes) -> HTTPError:
    return HTTPError("http://127.0.0.1:9999/health", code, "status", {}, io.BytesIO(body))


MEMORY_READY = {"readiness": {"state": "ready", "failure_code": "none"}}
MEMORY_DEGRADED = {"readiness": {"state": "degraded", "failure_code": "upsert_failed"}}
DEEP_JSON = "[" * 100_000 + "]" * 100_000


def _diagnostic(instance="bot-a", **extra) -> dict:
    """A privileged /health body: `whatsapp` marks the diagnostic projection."""
    body = {"status": "healthy", "whatsapp": {"connected": True}}
    if instance is not None:
        body["instance"] = {"name": instance}
    return dict(body, **extra)


def _read_readiness(monkeypatch, status: int, raw: bytes, seen: dict | None = None) -> dict:
    def opener(req, timeout):
        if seen is not None:
            seen["auth"] = req.get_header("Authorization")
        if status == 200:
            return _Response(200, raw)
        raise _http_error(status, raw)
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    monkeypatch.setattr(_mod, "urlopen", opener)
    return _mod.bot_memory_readiness("bot-a", 9999)


def test_readiness_reads_the_diagnostic_body_of_an_unhealthy_instance(monkeypatch) -> None:
    seen = {}
    body = json.dumps(_diagnostic(memory=MEMORY_DEGRADED)).encode()
    assert _read_readiness(monkeypatch, 503, body, seen) == {"state": "degraded", "http": 503, "failure_code": "upsert_failed"}
    assert seen == {"auth": "Bearer health-token-value"}


@pytest.mark.parametrize(("status", "body", "why"), [
    pytest.param(200, {"schema_version": "health.public.v1", "status": "healthy", "memory": MEMORY_READY},
                 "health_token_rejected", id="public"),
    pytest.param(401, _diagnostic(memory=MEMORY_READY), "health_token_rejected", id="rejected"),
    pytest.param(200, {"memory": MEMORY_READY}, "not_diagnostic", id="memory-only"),
    pytest.param(200, _diagnostic("bot-b", memory=MEMORY_READY), "health_identity_mismatch", id="other-instance"),
    pytest.param(200, _diagnostic(None, memory=MEMORY_READY), "health_identity_missing", id="no-instance-name"),
])
def test_readiness_counts_only_from_this_instances_diagnostic_body(monkeypatch, status, body, why) -> None:
    raw = json.dumps(body).encode()
    assert _read_readiness(monkeypatch, status, raw) == {"state": None, "http": status, "why": why}


def test_body_supplied_readiness_values_are_bounded_tokens(monkeypatch) -> None:
    body = _diagnostic(memory={"readiness": {"state": "not ready " * 10_000, "failure_code": {"nested": [1]}}})
    readiness = _read_readiness(monkeypatch, 503, json.dumps(body).encode())
    assert len(readiness["state"]) <= 64 and " " not in readiness["state"]
    assert readiness["failure_code"] == "<dict>"


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args) -> None:
        return

    def do_GET(self) -> None:
        self.server.requests.append((self.path, self.headers.get("Authorization")))
        self.send_response(self.server.status)
        if self.server.location:
            self.send_header("Location", self.server.location)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(self.server.body)))
        self.end_headers()
        self.wfile.write(self.server.body)


@contextmanager
def _server(status: int, body: bytes, location: str = ""):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.status, server.body, server.location, server.requests = status, body, location, []
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_readiness_reads_a_real_diagnostic_response(monkeypatch) -> None:
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    with _server(200, json.dumps(_diagnostic(memory=MEMORY_READY)).encode()) as source:
        readiness = _mod.bot_memory_readiness("bot-a", source.server_port)
    assert source.requests == [("/health", "Bearer health-token-value")]
    assert readiness == {"state": "ready", "http": 200, "failure_code": "none"}


# The probe refuses the whole 3xx range, so every 3xx status the stdlib names is a
# case, including each code urllib would follow.
@pytest.mark.parametrize("status", [code.value for code in HTTPStatus if 300 <= code < 400])
def test_readiness_refuses_a_real_redirect_without_forwarding_the_token(monkeypatch, status) -> None:
    body = json.dumps(_diagnostic(memory=MEMORY_READY)).encode()
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    with _server(200, body) as capture:
        with _server(status, body, f"http://127.0.0.1:{capture.server_port}/health") as source:
            readiness = _mod.bot_memory_readiness("bot-a", source.server_port)
    assert capture.requests == []
    assert source.requests == [("/health", "Bearer health-token-value")]
    assert readiness == {"state": None, "http": status, "why": "redirect_refused"}


class _DripHandler(BaseHTTPRequestHandler):
    """Announces a large body, then sends one byte every 50 ms for 3 s: never idle long enough to time out."""

    def log_message(self, *_args) -> None:
        return

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "100000")
        self.end_headers()
        stop = time.monotonic() + 3.0
        try:
            while time.monotonic() < stop:
                self.wfile.write(b" ")
                self.wfile.flush()
                time.sleep(0.05)
        except OSError:
            return


def test_a_drip_fed_readiness_body_cannot_hold_the_inventory_past_its_deadline(tmp_path, monkeypatch) -> None:
    real_readiness = _mod.bot_memory_readiness
    monkeypatch.setattr(_mod, "HEALTH_PROBE_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setenv("HOME", str(tmp_path))
    _stub_probes(monkeypatch)
    monkeypatch.setattr(_mod, "bot_memory_readiness", real_readiness)
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    server = ThreadingHTTPServer(("127.0.0.1", 0), _DripHandler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        _home_with_instance(tmp_path, "bot-a", CFG, healthPort=server.server_port)
        started = time.monotonic()
        lines = _mod.bot_memory_inventory({"expectBotMemory": True})
        elapsed = time.monotonic() - started
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    # Each byte arrives inside the socket timeout; only the step's absolute deadline ends the read.
    assert elapsed < 2.5
    assert lines[0] == "WARN bot_memory bot-a: readiness_unreadable http=None why=deadline_exceeded"


def _stalled(release: threading.Event, value: dict):
    def call(*_args):
        release.wait(10)
        return value
    return call


def test_a_stalled_index_read_cannot_hold_the_inventory_past_its_deadline(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_TIMEOUT_SECONDS", 0.2)
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    release = threading.Event()
    monkeypatch.setattr(_mod, "pinecone_describe_index", _stalled(release, dict(INDEX)))
    try:
        started = time.monotonic()
        lines = _mod.bot_memory_inventory({"expectBotMemory": True})
        elapsed = time.monotonic() - started
    finally:
        release.set()
    assert elapsed < 2.0
    assert "WARN bot_memory bot-a: index_unreadable http=None" in lines


def test_a_stalled_record_count_read_cannot_hold_the_inventory_past_its_deadline(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_TIMEOUT_SECONDS", 0.2)
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    release = threading.Event()
    monkeypatch.setattr(_mod, "pinecone_index_stats", _stalled(release, dict(STATS)))
    try:
        started = time.monotonic()
        lines = _mod.bot_memory_inventory({"expectBotMemory": True})
        elapsed = time.monotonic() - started
    finally:
        release.set()
    assert elapsed < 2.0
    assert "WARN bot_memory bot-a: stats_unreadable http=None" in lines


def test_a_step_error_surfaces_instead_of_hiding_behind_the_deadline() -> None:
    def step():
        raise AssertionError("must surface")
    with pytest.raises(AssertionError, match="must surface"):
        _mod.bot_memory_call(step, (), 5.0, "late")


def test_a_step_with_no_time_left_never_starts(monkeypatch) -> None:
    def no_thread(*_args, **_kwargs):
        raise AssertionError("no step may start once its deadline has passed")
    monkeypatch.setattr(_mod, "threading", SimpleNamespace(Thread=no_thread))
    assert _mod.bot_memory_call(lambda: None, (), 0.0, "late") == "late"


def test_a_step_deadline_is_cut_to_the_time_left_in_the_inventory() -> None:
    now = [0.0]
    budget = _mod.BotMemoryBudget(clock=lambda: now[0])
    assert budget.step_seconds(30.0) == 30.0
    now[0] = _mod.BOT_MEMORY_MAX_SECONDS - 10.0
    assert budget.step_seconds(30.0) == 10.0
    now[0] = _mod.BOT_MEMORY_MAX_SECONDS + 5.0
    assert budget.step_seconds(30.0) == 0.0


def test_a_deeply_nested_readiness_body_is_unparsed_not_a_crash(monkeypatch) -> None:
    raw = DEEP_JSON.encode()
    assert _read_readiness(monkeypatch, 200, raw) == {"state": None, "http": 200, "why": "unparsed_body"}


def test_the_inventory_reports_a_deeply_nested_readiness_body_and_keeps_going(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "bot-a", CFG)
    _home_with_instance(tmp_path, "bot-b", CFG)
    real_readiness = _mod.bot_memory_readiness
    _stub_probes(monkeypatch)
    monkeypatch.setattr(_mod, "bot_memory_readiness", real_readiness)
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    monkeypatch.setattr(_mod, "urlopen", lambda req, timeout: _Response(200, DEEP_JSON.encode()))
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert lines == [
        line
        for name in ("bot-a", "bot-b")
        for line in (
            f"WARN bot_memory {name}: readiness_unreadable http=200 why=unparsed_body",
            f"bot_memory {name}: readiness=None index=whatsapp-bot field_map=text protection=enabled records=3",
        )
    ]


def test_a_deeply_nested_config_is_skipped_and_the_next_instance_still_reports(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    deep = tmp_path / ".config/whatsoup/instances/bot-0-deep"
    deep.mkdir(parents=True)
    (deep / "config.json").write_text('{"memory": ' + DEEP_JSON + "}")
    _home_with_instance(tmp_path, "bot-a", CFG)
    _stub_probes(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_healthy("bot-a")]


def _healthy(name: str) -> str:
    return f"bot_memory {name}: readiness=ready index=whatsapp-bot field_map=text protection=enabled records=3"


def _inventory_home(tmp_path: Path, monkeypatch, names: list[str]) -> dict:
    monkeypatch.setenv("HOME", str(tmp_path))
    for name in names:
        _home_with_instance(tmp_path, name, CFG)
    return _stub_probes(monkeypatch)


def _assert_truncated(lines: list[str], limit: str, reported: int) -> None:
    assert lines[-1] == f"WARN bot_memory_inventory: truncated limit={limit} instances_reported={reported}"
    assert sum(line.startswith("WARN bot_memory_inventory:") for line in lines) == 1
    # One inventory-wide warning: never a per-instance event.
    assert _mod.daily_health_line_is_warning(lines[-1])
    assert not _mod.daily_health_line_is_failure(lines[-1])
    assert _mod._instance_from_fail_line(lines[-1]) is None


def test_config_count_is_bounded(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_MAX_CONFIGS", 2)
    seen = _inventory_home(tmp_path, monkeypatch, ["bot-a", "bot-b", "bot-c"])
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert lines[:-1] == [_healthy("bot-a"), _healthy("bot-b")]
    _assert_truncated(lines, "config_count_limit", 2)
    assert seen["describe"] == ["whatsapp-bot", "whatsapp-bot"]


def test_oversized_config_is_skipped_unread_and_later_instances_still_run(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "bot-a", CFG)
    _home_with_instance(tmp_path, "bot-b", CFG, pad="x" * 8192)
    _home_with_instance(tmp_path, "bot-c", CFG)
    seen = _stub_probes(monkeypatch)
    monkeypatch.setattr(_mod, "BOT_MEMORY_CONFIG_MAX_BYTES", 4096)
    reads = []
    real_read = _mod.bot_memory_read_bytes

    def read(fd, limit):
        reads.append(limit)
        return real_read(fd, limit)
    monkeypatch.setattr(_mod, "bot_memory_read_bytes", read)
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    # One oversized file must not hide every instance after it, and it is never read.
    assert reads == [4097, 4097]
    assert lines[0] == _healthy("bot-a")
    assert lines[1].startswith("WARN bot_memory bot-b: config_skipped size=")
    assert lines[1].endswith(" limit=4096 (not parsed)")
    assert lines[2] == _healthy("bot-c")
    assert len(lines) == 3
    assert not any(line.startswith("WARN bot_memory_inventory:") for line in lines)
    assert seen["describe"] == ["whatsapp-bot", "whatsapp-bot"]


def test_field_map_rendering_is_bounded() -> None:
    wide = {f"field{index}": "x" * 500 for index in range(1000)}
    deep: list = []
    for _ in range(100_000):
        deep = [deep]
    for field_map, rendered in ((wide, "<dict size=1000>"), (deep, "<list size=1>"), ({"text": 1}, "<dict size=1>")):
        lines = _lines(index=dict(INDEX, field_map=field_map))
        assert [line for line in lines if line.startswith("FAIL ")] == [
            f"FAIL bot_memory bot-a: field_map={rendered} (WhatSoup writes `text`; every memory save fails)"]
        assert lines[-1].endswith("field_map=other protection=enabled records=3")


def test_field_map_strings_are_redacted_before_they_reach_evidence() -> None:
    secret_shaped = "ghp_" + "C" * 36  # synthetic, a shape the shared redactor masks
    lines = _lines(index=dict(INDEX, field_map={"text": secret_shaped}))
    assert not any(secret_shaped in line for line in lines)
    assert [line for line in lines if line.startswith("FAIL ")] == [
        "FAIL bot_memory bot-a: field_map={'text': '[REDACTED_GITHUB_TOKEN]'} "
        "(WhatSoup writes `text`; every memory save fails)"]


def test_wall_time_is_bounded(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_MAX_SECONDS", 100.0)
    seen = _inventory_home(tmp_path, monkeypatch, ["bot-a", "bot-b"])
    now = [0.0]

    def slow_readiness(name, port):
        now[0] += 70.0
        return READY
    monkeypatch.setattr(_mod, "bot_memory_readiness", slow_readiness)
    lines = _mod.bot_memory_inventory({"expectBotMemory": True}, _mod.BotMemoryBudget(clock=lambda: now[0]))
    assert lines[:-1] == [_healthy("bot-a")]
    _assert_truncated(lines, "wall_time_limit", 1)
    assert seen["describe"] == ["whatsapp-bot"]


def test_output_lines_are_bounded(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_MAX_LINES", 3)
    _inventory_home(tmp_path, monkeypatch, ["bot-a", "bot-b", "bot-c"])
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    # One line stays reserved, so the truncation line keeps the total within the limit.
    assert lines[:-1] == [_healthy("bot-a"), _healthy("bot-b")]
    _assert_truncated(lines, "output_line_limit", 2)
    assert len(lines) == 3


def test_output_bytes_are_bounded(tmp_path, monkeypatch) -> None:
    limit = len(_healthy("bot-a")) + 1 + _mod.BOT_MEMORY_TRUNCATION_RESERVE_BYTES
    monkeypatch.setattr(_mod, "BOT_MEMORY_MAX_OUTPUT_BYTES", limit)
    _inventory_home(tmp_path, monkeypatch, ["bot-a", "bot-b"])
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert lines[:-1] == [_healthy("bot-a")]
    _assert_truncated(lines, "output_byte_limit", 1)
    assert sum(len(line.encode("utf-8")) + 1 for line in lines) <= limit


def test_the_longest_truncation_line_fits_its_reservation() -> None:
    limit = max(("wall_time_limit", "config_count_limit", "output_line_limit", "output_byte_limit",
                 "instance_entry_limit"), key=len)
    # Every reported instance took one discovered entry, so the count never exceeds the entry bound.
    line = f"WARN bot_memory_inventory: truncated limit={limit} instances_reported={_mod.BOT_MEMORY_MAX_ENTRIES}"
    assert len(line.encode("utf-8")) + 1 <= _mod.BOT_MEMORY_TRUNCATION_RESERVE_BYTES


def _instance_dir(tmp_path: Path, name: str) -> Path:
    return tmp_path / ".config/whatsoup/instances" / name


def _refused(name: str, reason: str) -> str:
    return f"WARN bot_memory {name}: config_refused reason={reason}"


def _track_readiness(monkeypatch) -> list:
    asked = []

    def readiness(name, port):
        asked.append(name)
        return READY
    monkeypatch.setattr(_mod, "bot_memory_readiness", readiness)
    return asked


def _fstat_reports(monkeypatch, path: Path, field: int, value: int) -> None:
    """fstat of this one inode reports `value` in stat field `field` (4 = uid, 6 = size)."""
    target = os.stat(path).st_ino
    real_fstat = os.fstat

    def fstat(fd):
        result = real_fstat(fd)
        if result.st_ino != target:
            return result
        fields = list(result[:10])
        fields[field] = value
        return os.stat_result(fields)
    monkeypatch.setattr(os, "fstat", fstat)


def test_a_symlinked_instance_folder_is_refused_and_never_probed(tmp_path, monkeypatch) -> None:
    seen = _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "config.json").write_text(json.dumps({"healthPort": 9999, "memory": {"pinecone": CFG}}))
    _instance_dir(tmp_path, "bot-b").symlink_to(elsewhere, target_is_directory=True)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_healthy("bot-a"), _refused("bot-b", "symlink")]
    assert asked == ["bot-a"]
    assert seen["describe"] == ["whatsapp-bot"]


def test_a_symlinked_config_is_refused_and_never_probed(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, [])
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text(json.dumps({"healthPort": 9999, "memory": {"pinecone": CFG}}))
    folder = _instance_dir(tmp_path, "bot-a")
    folder.mkdir(parents=True)
    (folder / "config.json").symlink_to(elsewhere)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "symlink")]
    assert asked == []


def test_a_config_swapped_for_a_symlink_after_its_check_is_not_followed(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, [])
    decoy = tmp_path / "decoy.json"
    decoy.write_text(json.dumps({"healthPort": 9999, "memory": {"pinecone": CFG}}))
    folder = _instance_dir(tmp_path, "bot-a")
    folder.mkdir(parents=True)
    (folder / "config.json").symlink_to(decoy)
    real_stat = os.stat

    def stat_before_swap(path, *, dir_fd=None, follow_symlinks=True):
        # The classification still sees a regular file; the link appears before the open.
        if path == "config.json" and not follow_symlinks:
            return real_stat(decoy)
        return real_stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
    monkeypatch.setattr(os, "stat", stat_before_swap)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "unopenable")]
    assert asked == []


def test_an_instance_folder_swapped_for_a_symlink_after_its_check_is_not_followed(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, [])
    decoy = tmp_path / "decoy"
    decoy.mkdir()
    (decoy / "config.json").write_text(json.dumps({"healthPort": 9999, "memory": {"pinecone": CFG}}))
    _instance_dir(tmp_path, "bot-a").parent.mkdir(parents=True)
    _instance_dir(tmp_path, "bot-a").symlink_to(decoy, target_is_directory=True)
    real_stat = os.stat

    def stat_before_swap(path, *, dir_fd=None, follow_symlinks=True):
        # The classification still sees a folder; the link appears before the open.
        if path == "bot-a" and not follow_symlinks:
            return real_stat(decoy)
        return real_stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
    monkeypatch.setattr(os, "stat", stat_before_swap)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "unopenable")]
    assert asked == []


def test_a_config_others_can_write_is_refused(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    (_instance_dir(tmp_path, "bot-a") / "config.json").chmod(0o664)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "writable_by_others")]
    assert asked == []


def test_an_instance_folder_others_can_write_is_refused(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    _instance_dir(tmp_path, "bot-a").chmod(0o775)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "writable_by_others")]
    assert asked == []


def test_a_readable_instance_folder_is_accepted(tmp_path, monkeypatch) -> None:
    # Fleet folders were 755 until recently: readable by others is not a refusal, writable is.
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    _instance_dir(tmp_path, "bot-a").chmod(0o755)
    (_instance_dir(tmp_path, "bot-a") / "config.json").chmod(0o644)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_healthy("bot-a")]


def test_an_instances_root_others_can_write_is_refused_whole(tmp_path, monkeypatch) -> None:
    seen = _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    (tmp_path / ".config/whatsoup/instances").chmod(0o777)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "WARN bot_memory_inventory: instances_refused reason=writable_by_others"]
    assert asked == [] and seen["describe"] == []


def test_an_opted_in_host_without_an_instances_folder_says_so(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, [])
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "WARN bot_memory_inventory: instances_unobserved reason=missing"]


def test_a_symlinked_instances_root_is_refused_whole(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, [])
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "bot-a").mkdir(parents=True)
    (elsewhere / "bot-a" / "config.json").write_text(json.dumps({"healthPort": 9999, "memory": {"pinecone": CFG}}))
    (tmp_path / ".config/whatsoup").mkdir(parents=True)
    (tmp_path / ".config/whatsoup/instances").symlink_to(elsewhere, target_is_directory=True)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "WARN bot_memory_inventory: instances_refused reason=symlink"]
    assert asked == []


def test_an_instances_root_swapped_for_a_symlink_after_its_check_is_not_followed(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, [])
    decoy = tmp_path / "decoy"
    (decoy / "bot-a").mkdir(parents=True)
    (decoy / "bot-a" / "config.json").write_text(json.dumps({"healthPort": 9999, "memory": {"pinecone": CFG}}))
    root = tmp_path / ".config/whatsoup/instances"
    root.parent.mkdir(parents=True)
    root.symlink_to(decoy, target_is_directory=True)
    real_lstat = os.lstat

    def lstat_before_swap(path, *args, **kwargs):
        # The check still sees a folder; the link appears before the open.
        if Path(path) == root:
            return real_lstat(decoy)
        return real_lstat(path, *args, **kwargs)
    monkeypatch.setattr(os, "lstat", lstat_before_swap)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "WARN bot_memory_inventory: instances_unobserved reason=unreadable"]
    assert asked == []


def test_an_instances_root_owned_by_another_user_is_refused_whole(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    _fstat_reports(monkeypatch, tmp_path / ".config/whatsoup/instances", 4, os.getuid() + 1)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "WARN bot_memory_inventory: instances_refused reason=foreign_owner"]
    assert asked == []


def test_an_instance_folder_owned_by_another_user_is_refused(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    _fstat_reports(monkeypatch, _instance_dir(tmp_path, "bot-a"), 4, os.getuid() + 1)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "foreign_owner")]
    assert asked == []


def test_a_config_owned_by_another_user_is_refused(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    _fstat_reports(monkeypatch, _instance_dir(tmp_path, "bot-a") / "config.json", 4, os.getuid() + 1)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "foreign_owner")]
    assert asked == []


def test_a_hard_linked_config_is_refused(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    os.link(_instance_dir(tmp_path, "bot-a") / "config.json", tmp_path / "second-name.json")
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "multiple_links")]
    assert asked == []


def test_a_fifo_config_is_refused_without_blocking(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, [])
    folder = _instance_dir(tmp_path, "bot-a")
    folder.mkdir(parents=True)
    os.mkfifo(folder / "config.json")
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot-a", "not_regular")]


def test_the_config_read_stops_at_the_limit_even_if_the_file_grew_after_its_size_check(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    monkeypatch.setattr(_mod, "BOT_MEMORY_CONFIG_MAX_BYTES", 64)
    config = _instance_dir(tmp_path, "bot-a") / "config.json"
    assert config.stat().st_size > 64
    _fstat_reports(monkeypatch, config, 6, 10)
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "WARN bot_memory bot-a: config_skipped size=65 limit=64 (not parsed)"]
    assert asked == []


def test_instance_discovery_is_bounded_before_any_config_is_read(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_MAX_ENTRIES", 3)
    _inventory_home(tmp_path, monkeypatch, ["bot-a", "bot-b", "bot-c", "bot-d"])
    reads = []
    monkeypatch.setattr(_mod, "bot_memory_read_config", lambda root_fd, name: reads.append(name))
    lines = _mod.bot_memory_inventory({"expectBotMemory": True})
    assert lines == ["WARN bot_memory_inventory: truncated limit=instance_entry_limit instances_reported=0"]
    _assert_truncated(lines, "instance_entry_limit", 0)
    assert reads == []


def test_instance_discovery_at_its_bound_still_runs(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_mod, "BOT_MEMORY_MAX_ENTRIES", 3)
    _inventory_home(tmp_path, monkeypatch, ["bot-a", "bot-b", "bot-c"])
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        _healthy("bot-a"), _healthy("bot-b"), _healthy("bot-c")]


def test_an_unsafe_instance_name_is_refused_as_one_safe_line(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot\nFAIL health x"])
    asked = _track_readiness(monkeypatch)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_refused("bot_FAIL_health_x", "unsafe_name")]
    assert asked == []


def test_a_plain_file_beside_the_instances_is_ignored(tmp_path, monkeypatch) -> None:
    _inventory_home(tmp_path, monkeypatch, ["bot-a"])
    (tmp_path / ".config/whatsoup/instances/.DS_Store").write_bytes(b"\0")
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [_healthy("bot-a")]


def test_readiness_without_a_token_sends_nothing(monkeypatch) -> None:
    def opener(req, timeout):
        raise AssertionError("no request without the instance's health token")
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: None)
    monkeypatch.setattr(_mod, "urlopen", opener)
    assert _mod.bot_memory_readiness("bot-a", 9999) == {"state": None, "http": None, "why": "no_health_token"}


def test_an_unexpected_probe_error_is_a_warning_not_a_crash(monkeypatch) -> None:
    def opener(req, timeout):
        raise RuntimeError("unexpected")
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    monkeypatch.setattr(_mod, "urlopen", opener)
    assert _mod.bot_memory_readiness("bot-a", 9999) == {"state": None, "http": None, "why": "RuntimeError"}
    assert _mod.pinecone_describe_index(FAKE_KEY, "whatsapp-bot") == {"http": None}


def test_pinecone_reads_send_the_key_only_in_a_header(monkeypatch) -> None:
    requests = []
    described = {"host": "whatsapp-bot" + TAIL, "deletion_protection": "enabled",
                 "embed": {"field_map": {"text": "text"}, "model": "llama-text-embed-v2"}}

    def opener(req, timeout):
        requests.append((req.get_method(), req.full_url, req.get_header("Api-key"), req.data))
        payload = described if req.full_url.endswith("/indexes/whatsapp-bot") else {"totalVectorCount": 3}
        return _Response(200, json.dumps(payload).encode())
    monkeypatch.setattr(_mod, "urlopen", opener)
    index = _mod.pinecone_describe_index(FAKE_KEY, "whatsapp-bot")
    stats = _mod.pinecone_index_stats(FAKE_KEY, index["host"])
    assert index == INDEX
    assert stats == STATS
    assert [(method, url.split("/")[2], key, data) for method, url, key, data in requests] == [
        ("GET", "api.pinecone.io", FAKE_KEY, None),
        ("POST", "whatsapp-bot" + TAIL, FAKE_KEY, b"{}"),
    ]
    assert all(FAKE_KEY not in url for _method, url, _key, _data in requests)


def test_configured_index_name_stays_one_path_segment(monkeypatch) -> None:
    urls = []

    def opener(req, timeout):
        urls.append(req.full_url)
        return _Response(404, b"null")
    monkeypatch.setattr(_mod, "urlopen", opener)
    _mod.pinecone_describe_index(FAKE_KEY, "../projects?x=1")
    assert urls == ["https://api.pinecone.io/indexes/..%2Fprojects%3Fx%3D1"]
