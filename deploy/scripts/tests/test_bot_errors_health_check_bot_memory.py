"""The bot-memory inventory reports each instance's Pinecone memory health.

Per instance with memory.pinecone: detailed /health memory readiness, and the
configured index as seen with the instance's own key (describe + stats only).
Real defects (readiness not ready, missing index, index in another project,
field map not `text`) are per-instance FAIL lines, so they page BOT ERRORS.
Protection off and zero records are evidence only. The key never appears in
any line, and the inventory does nothing unless the profile opts in.
"""
from __future__ import annotations

import importlib.util
import inspect
import io
import json
from pathlib import Path
from urllib.error import HTTPError

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()

TAIL = "-proj123.svc.example.pinecone.io"
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


def test_inventory_is_off_unless_the_profile_opts_in(monkeypatch) -> None:
    def boom(*_args, **_kwargs):
        raise AssertionError("no probe may run when the profile does not opt in")
    monkeypatch.setattr(_mod, "bot_memory_configs", boom)
    assert _mod.bot_memory_inventory({}) == []
    assert _mod.bot_memory_inventory({"expectBotMemory": False}) == []


def _home_with_instance(tmp_path: Path, name: str, pinecone: dict) -> None:
    folder = tmp_path / ".config/whatsoup/instances" / name
    folder.mkdir(parents=True)
    (folder / "config.json").write_text(json.dumps({"healthPort": 9999, "memory": {"pinecone": pinecone}}))


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
    lines = _probe_with_described_host(tmp_path, monkeypatch, {"index": "whatsapp-bot"}, "whatsapp-bot.example.com")
    assert lines == ["bot_memory bot-a: readiness=ready index=whatsapp-bot field_map=text protection=enabled records=unknown"]


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


def test_instance_with_another_keyring_service_is_not_probed(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    _home_with_instance(tmp_path, "bot-c", dict(CFG, apiKeyService="other-pinecone"))
    monkeypatch.setattr(_mod, "bot_memory_readiness", lambda name, port: READY)

    def boom(*_args, **_kwargs):
        raise AssertionError("a key under another keyring service may differ from the job's lookup")
    monkeypatch.setattr(_mod, "provider_credential_value", boom)
    monkeypatch.setattr(_mod, "pinecone_describe_index", boom)
    assert _mod.bot_memory_inventory({"expectBotMemory": True}) == [
        "bot_memory bot-c: readiness=ready index=whatsapp-bot index_not_probed=key_not_visible"]


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


def test_readiness_reads_the_privileged_body_of_an_unhealthy_instance(monkeypatch) -> None:
    body = json.dumps({"memory": {"readiness": {"state": "degraded", "failure_code": "upsert_failed"}}}).encode()
    seen = {}

    def opener(req, timeout):
        seen["auth"] = req.get_header("Authorization")
        raise _http_error(503, body)
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    monkeypatch.setattr(_mod, "urlopen", opener)
    assert _mod.bot_memory_readiness("bot-a", 9999) == {"state": "degraded", "http": 503, "failure_code": "upsert_failed"}
    assert seen == {"auth": "Bearer health-token-value"}


def test_readiness_refuses_a_redirect(monkeypatch) -> None:
    def opener(req, timeout):
        raise _http_error(302, b"")
    monkeypatch.setattr(_mod, "instance_health_token", lambda name: "health-token-value")
    monkeypatch.setattr(_mod, "urlopen", opener)
    assert _mod.bot_memory_readiness("bot-a", 9999) == {"state": None, "http": 302, "why": "redirect_refused"}


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
