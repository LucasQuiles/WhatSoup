#!/usr/bin/env python3
"""Tests for mcp_schema_inventory_probe metadata-only output.

Style mirrors test_pi_presence_probe.py: NO pytest fixtures; test_* functions;
manual setattr + try/finally monkeypatching; a `__main__` runner printing
"PASS <name>"; and a CLI e2e subprocess test for the default (no --probe-tools)
entrypoint.

NO real MCP server is ever started and NO network is touched. The spawn/transport
boundary (`McpClient`) is replaced with in-memory fakes, and `probe_tools` is
exercised against a fake client; the real subprocess.Popen path is never reached.
"""
import io
import json
import os
import queue
import subprocess
import sys
import tempfile
from argparse import Namespace
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mcp_schema_inventory_probe as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "mcp_schema_inventory_probe.py"


# --------------------------------------------------------------------------
# Small helpers / fakes (no real process, no network)
# --------------------------------------------------------------------------
class FakeProc:
    """Stand-in for subprocess.Popen with deterministic, in-memory behavior."""

    def __init__(self, returncode=None):
        self._returncode = returncode
        self.terminated = False
        self.killed = False
        self.waited = False

    def poll(self):
        return self._returncode

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.waited = True
        return self._returncode

    def kill(self):
        self.killed = True


class FakeClient:
    """Replaces McpClient for probe_tools tests. Scripts initialize + tools/list
    + shutdown responses without touching subprocess or sockets."""

    def __init__(self, responses, raise_on_enter=None, shutdown_raises=False):
        self._responses = responses
        self._raise_on_enter = raise_on_enter
        self._shutdown_raises = shutdown_raises
        self.io_stats = {"stdout_bytes": 7, "stderr_bytes": 0, "returncode": 0}
        self.notified = []

    def __enter__(self):
        if self._raise_on_enter is not None:
            raise self._raise_on_enter
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def request(self, method, params=None):
        if method == "shutdown" and self._shutdown_raises:
            raise RuntimeError("shutdown refused")
        return self._responses[method].pop(0)

    def notify(self, method, params=None):
        self.notified.append(method)


def _client_factory(client):
    def factory(command, cwd, timeout):
        factory.last = {"command": command, "cwd": cwd, "timeout": timeout}
        return client
    factory.last = None
    return factory


def _write_home(tmp):
    old = probe.HOME
    probe.HOME = tmp
    return old


# --------------------------------------------------------------------------
# Pure helpers: command_to_list / command_summary / resolve / classify
# --------------------------------------------------------------------------
def test_command_to_list_handles_list_str_and_other():
    assert probe.command_to_list(["a", 1]) == ["a", "1"]
    assert probe.command_to_list("npx") == ["npx"]
    assert probe.command_to_list(None) == []
    assert probe.command_to_list({"x": 1}) == []


def test_command_summary_empty_returns_argc_zero():
    assert probe.command_summary([]) == {"argc": 0}


def test_command_summary_classifies_every_arg_kind_and_redacts_sensitive():
    home_path = str(probe.HOME / "bin/server.js")
    cmd = [
        "/usr/bin/node",
        home_path,                       # path arg (under HOME)
        "/abs/other.js",                 # path arg (absolute)
        "https://api.example.test/mcp",  # url arg
        "--auth-token=hunter2value",     # sensitive arg
        "plainflag",                     # plain arg
    ]
    summary = probe.command_summary(cmd)
    assert summary["argc"] == 6
    assert summary["executable"] == "/usr/bin/node"
    assert summary["executable_basename"] == "node"
    kinds = [a["kind"] for a in summary["args"]]
    assert kinds == ["path", "path", "url", "sensitive_arg", "arg"]
    # path args expose only basename + hash, never the full path
    assert summary["args"][0]["basename"] == "server.js"
    assert "sha256_16" in summary["args"][0]
    assert home_path not in json.dumps(summary)
    # url arg keeps host/scheme only
    assert summary["args"][2] == {"kind": "url", "host": "api.example.test", "scheme": "https"}
    # sensitive arg value is suppressed
    assert summary["args"][3] == {"kind": "sensitive_arg", "value": "<redacted>"}
    assert "hunter2value" not in json.dumps(summary)
    # plain arg passes through
    assert summary["args"][4] == {"kind": "arg", "value": "plainflag"}


def test_command_summary_relative_executable_uses_basename():
    summary = probe.command_summary(["npx", "-y", "pkg"])
    assert summary["executable"] == "npx"
    assert summary["executable_basename"] == "npx"


def test_resolve_claude_plugin_arg_substitutes_plugin_root():
    out = probe.resolve_claude_plugin_arg("${CLAUDE_PLUGIN_ROOT}/dist/x.js", Path("/p/root"))
    assert out == "/p/root/dist/x.js"
    # no token -> unchanged
    assert probe.resolve_claude_plugin_arg("static", Path("/p/root")) == "static"


def test_classify_transport_http_stdio_unknown():
    assert probe.classify_transport({"url": "https://x"}) == "http"
    assert probe.classify_transport({"command": ["node"]}) == "stdio"
    assert probe.classify_transport({}) == "unknown"


def test_classify_risk_covers_each_class():
    remote = probe.classify_risk("x", [], "https://remote.test", [])
    assert "remote" in remote["risk_classes"]

    secret = probe.classify_risk("pinecone", [], None, [])
    assert "auth_or_secret_backed" in secret["risk_classes"]
    secret2 = probe.classify_risk("x", [], None, ["API_KEY"])
    assert "auth_or_secret_backed" in secret2["risk_classes"]

    private = probe.classify_risk("whatsapp", [], None, [])
    assert "local_socket_or_private_data" in private["risk_classes"]

    browser = probe.classify_risk("playwright", [], None, [])
    assert "browser_automation" in browser["risk_classes"]

    local = probe.classify_risk("tmup", [], None, [])
    assert "local_state" in local["risk_classes"]

    unknown = probe.classify_risk("mystery", [], None, [])
    assert unknown["risk_classes"] == ["unknown"]


def test_classify_risk_default_probe_gate_blocks_secret_backed_safe_name():
    # memory is in SAFE_DEFAULT_PROBE_NAMES, but env_keys make it secret-backed
    # -> default_probe_allowed must be False (gate is risk-aware, not name-only).
    res = probe.classify_risk("memory", [], None, ["TOKEN"])
    assert res["default_probe_allowed"] is False
    # clean safe name is allowed
    res_ok = probe.classify_risk("memory", ["node", "mem.js"], None, [])
    assert res_ok["default_probe_allowed"] is True


# --------------------------------------------------------------------------
# Collectors: codex / opencode / claude plugin manifests
# --------------------------------------------------------------------------
def test_collect_codex_parses_servers_and_skips_non_dict_spec():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-codex-"))
    old = _write_home(tmp)
    try:
        (tmp / ".codex").mkdir(parents=True)
        (tmp / ".codex/config.toml").write_text(
            "[mcp_servers.local]\n"
            "command = [\"node\", \"srv.js\"]\n"
            "[mcp_servers.remote]\n"
            "url = \"https://api.example.test/mcp\"\n",
            encoding="utf-8",
        )
        entries = probe.collect_codex()
        by_name = {e["server"]: e for e in entries}
        assert set(by_name) == {"local", "remote"}
        assert by_name["local"]["transport"] == "stdio"
        assert by_name["local"]["command"] == ["node", "srv.js"]
        assert by_name["remote"]["transport"] == "http"
        assert by_name["remote"]["url"] == "https://api.example.test/mcp"
        assert all(e["harness"] == "codex" for e in entries)
        assert all(e["enabled_state"] == "configured" for e in entries)
    finally:
        probe.HOME = old


def test_collect_codex_skips_non_dict_spec_entry():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-codex-nondict-"))
    old = _write_home(tmp)
    try:
        (tmp / ".codex").mkdir(parents=True)
        # mcp_servers is a dict, but the "weird" entry is a bare string value.
        (tmp / ".codex/config.toml").write_text(
            "[mcp_servers]\nweird = \"just-a-string\"\n"
            "[mcp_servers.good]\ncommand = [\"node\"]\n",
            encoding="utf-8",
        )
        entries = probe.collect_codex()
        assert [e["server"] for e in entries] == ["good"]  # weird (non-dict) skipped
    finally:
        probe.HOME = old


def test_collect_codex_missing_file_returns_empty():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-codex-missing-"))
    old = _write_home(tmp)
    try:
        assert probe.collect_codex() == []
    finally:
        probe.HOME = old


def test_collect_codex_malformed_servers_non_dict_returns_empty():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-codex-bad-"))
    old = _write_home(tmp)
    try:
        (tmp / ".codex").mkdir(parents=True)
        # mcp_servers as an array table list-of -> tomllib yields a list, not dict
        (tmp / ".codex/config.toml").write_text(
            "[[mcp_servers]]\nname = \"x\"\n", encoding="utf-8"
        )
        assert probe.collect_codex() == []
    finally:
        probe.HOME = old


def test_collect_opencode_enabled_disabled_and_configured_states():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-oc-"))
    old = _write_home(tmp)
    try:
        (tmp / ".config/opencode").mkdir(parents=True)
        (tmp / ".config/opencode/opencode.json").write_text(json.dumps({
            "mcp": {
                "on": {"command": ["node", "a.js"], "enabled": True,
                       "environment": {"API_TOKEN": "x"}},
                "off": {"command": ["node", "b.js"], "enabled": False},
                "neither": {"url": "https://oc.example.test", "type": "remote"},
                "bogus": "not-a-dict",
            }
        }), encoding="utf-8")
        entries = probe.collect_opencode()
        by_name = {e["server"]: e for e in entries}
        assert set(by_name) == {"on", "off", "neither"}  # bogus skipped
        assert by_name["on"]["enabled_state"] == "enabled"
        assert by_name["on"]["env_keys"] == ["API_TOKEN"]
        assert by_name["off"]["enabled_state"] == "disabled"
        assert by_name["neither"]["enabled_state"] == "configured"
        assert by_name["neither"]["transport"] == "remote"
    finally:
        probe.HOME = old


def test_collect_opencode_mcp_non_dict_returns_empty():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-oc-bad-"))
    old = _write_home(tmp)
    try:
        (tmp / ".config/opencode").mkdir(parents=True)
        (tmp / ".config/opencode/opencode.json").write_text(
            json.dumps({"mcp": ["x"]}), encoding="utf-8")
        assert probe.collect_opencode() == []
    finally:
        probe.HOME = old


def test_collect_claude_plugin_mcp_resolves_root_and_skips_bad_specs():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-claude-"))
    old = _write_home(tmp)
    try:
        man_dir = tmp / ".claude/plugins/myplugin/.claude-plugin"
        man_dir.mkdir(parents=True)
        (man_dir / "plugin.json").write_text(json.dumps({
            "name": "myplugin",
            "mcpServers": {
                "srv": {
                    "command": "node",
                    "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js", "--flag"],
                    "env": {"TOKEN": "secret"},
                },
                "bad": "not-a-dict",
            },
        }), encoding="utf-8")
        entries = probe.collect_claude_plugin_mcp()
        srv = [e for e in entries if e["server"] == "srv"]
        assert len(srv) == 1
        entry = srv[0]
        assert entry["harness"] == "claude"
        assert entry["plugin"] == "myplugin"
        assert entry["enabled_state"] == "manifest_present_enabled_unknown"
        # ${CLAUDE_PLUGIN_ROOT} resolved to the plugin root (manifest.parent.parent)
        plugin_root = str(man_dir.parent)
        assert entry["command"] == ["node", plugin_root + "/dist/server.js", "--flag"]
        assert "${CLAUDE_PLUGIN_ROOT}" not in json.dumps(entry["command"])
        assert entry["env_keys"] == ["TOKEN"]
        assert not any(e["server"] == "bad" for e in entries)
    finally:
        probe.HOME = old


def test_collect_claude_plugin_mcp_dedups_manifest_seen_across_roots():
    # A manifest under .claude/plugins/cache/ is matched twice: once by the
    # plugins-root recursive glob and once by the cache-root glob. The `seen`
    # guard must dedup it so the server appears exactly once.
    tmp = Path(tempfile.mkdtemp(prefix="mcp-claude-dedup-"))
    old = _write_home(tmp)
    try:
        man_dir = tmp / ".claude/plugins/cache/plug/.claude-plugin"
        man_dir.mkdir(parents=True)
        (man_dir / "plugin.json").write_text(json.dumps({
            "name": "plug",
            "mcpServers": {"srv": {"command": "node", "args": []}},
        }), encoding="utf-8")
        entries = probe.collect_claude_plugin_mcp()
        srv_entries = [e for e in entries if e["server"] == "srv"]
        assert len(srv_entries) == 1, entries  # deduped, not double-counted
    finally:
        probe.HOME = old


def test_collect_claude_plugin_mcp_servers_non_dict_is_skipped():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-claude-bad-"))
    old = _write_home(tmp)
    try:
        man_dir = tmp / ".claude/plugins/p/.claude-plugin"
        man_dir.mkdir(parents=True)
        (man_dir / "plugin.json").write_text(json.dumps({
            "name": "p", "mcpServers": ["nope"],
        }), encoding="utf-8")
        assert probe.collect_claude_plugin_mcp() == []
    finally:
        probe.HOME = old


# --------------------------------------------------------------------------
# Tool summarization / schema shape / side-effect class
# --------------------------------------------------------------------------
def test_side_effect_class_for_tool_buckets():
    assert probe.side_effect_class_for_tool("delete_thing") == "potential_write_or_external_side_effect"
    assert probe.side_effect_class_for_tool("browser_click") == "browser_or_gui_side_effect"
    assert probe.side_effect_class_for_tool("remember_fact") == "local_state_side_effect"
    assert probe.side_effect_class_for_tool("get_status") == "likely_read_or_compute"


def test_schema_shape_non_dict_returns_typed_hash():
    out = probe.schema_shape(["not", "a", "dict"])
    assert out["type"] == "list"
    assert "sha256_16" in out and len(out["sha256_16"]) == 16
    # a None schema also goes through the non-dict path
    out_none = probe.schema_shape(None)
    assert out_none["type"] == "NoneType"


def test_schema_shape_dict_counts_props_and_required():
    out = probe.schema_shape({
        "type": "object",
        "properties": {"b": {}, "a": {}},
        "required": ["a"],
        "additionalProperties": False,
    })
    assert out["type"] == "object"
    assert out["property_count"] == 2
    assert out["property_names"] == ["a", "b"]
    assert out["required_count"] == 1
    assert out["required_names"] == ["a"]
    assert out["has_additional_properties"] is True


def test_summarize_tools_skips_non_dict_and_suppresses_descriptions():
    tools = [
        "not-a-tool",  # skipped
        {"name": "zebra", "description": "ZZ secret blurb",
         "inputSchema": {"type": "object", "properties": {"p": {}}}},
        {"name": "alpha", "description": "",
         "outputSchema": {"type": "object"}},
    ]
    rows = probe.summarize_tools(tools)
    assert [r["name"] for r in rows] == ["alpha", "zebra"]  # sorted, non-dict dropped
    rendered = json.dumps(rows)
    assert "secret blurb" not in rendered
    zebra = next(r for r in rows if r["name"] == "zebra")
    assert zebra["description_bytes"] == len("ZZ secret blurb".encode())
    assert zebra["description_sha256_16"]
    alpha = next(r for r in rows if r["name"] == "alpha")
    assert alpha["description_bytes"] == 0
    assert alpha["description_sha256_16"] is None
    assert alpha["output_schema_present"] is True
    assert zebra["output_schema_present"] is False


# --------------------------------------------------------------------------
# reader_thread (in-memory stream, no process)
# --------------------------------------------------------------------------
def test_reader_thread_stdout_pumps_queue_and_records_stats():
    stream = io.StringIO("line1\nline2\n")
    q = queue.Queue()
    sink = {}
    probe.reader_thread(stream, q, sink, "stdout")
    assert q.get_nowait() == "line1\n"
    assert q.get_nowait() == "line2\n"
    assert sink["stdout_bytes"] == len("line1\nline2\n".encode())
    assert sink["stdout_sha256_16"] and len(sink["stdout_sha256_16"]) == 16


def test_reader_thread_stderr_does_not_enqueue_and_empty_hash_is_none():
    stream = io.StringIO("")
    q = queue.Queue()
    sink = {}
    probe.reader_thread(stream, q, sink, "stderr")
    assert q.empty()
    assert sink["stderr_bytes"] == 0
    assert sink["stderr_sha256_16"] is None


# --------------------------------------------------------------------------
# McpClient: enter/exit/send/notify/request/wait_for_id (fake proc, no Popen)
# --------------------------------------------------------------------------
def test_mcpclient_enter_starts_readers_via_fake_popen():
    client = probe.McpClient(["node", "srv.js"], probe.HOME, 1.0)
    started = {}

    class FakePopen:
        def __init__(self, *a, **k):
            self.stdin = io.StringIO()
            self.stdout = io.StringIO("")
            self.stderr = io.StringIO("")
            started["args"] = a

        def poll(self):
            return 0

    threads = []

    class FakeThread:
        def __init__(self, target=None, args=(), daemon=None):
            self.target, self.args = target, args

        def start(self):
            threads.append(self.args[3])  # label

    old_popen, old_thread = probe.subprocess.Popen, probe.threading.Thread
    probe.subprocess.Popen = FakePopen
    probe.threading.Thread = FakeThread
    try:
        with client as c:
            assert c is client
            assert sorted(threads) == ["stderr", "stdout"]
    finally:
        probe.subprocess.Popen = old_popen
        probe.threading.Thread = old_thread


def test_mcpclient_send_raises_when_not_started():
    client = probe.McpClient(["x"], probe.HOME, 1.0)
    try:
        client.send({"hello": 1})
        raise AssertionError("expected RuntimeError")
    except RuntimeError as exc:
        assert "not started" in str(exc)


def test_mcpclient_request_and_notify_serialize_jsonrpc():
    client = probe.McpClient(["x"], probe.HOME, 1.0)
    sent = []

    class StdinSink:
        def write(self, data):
            sent.append(data)

        def flush(self):
            pass

    client.proc = FakeProc(returncode=None)
    client.proc.stdin = StdinSink()
    # feed the response so request() resolves
    client.queue.put(json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}) + "\n")
    resp = client.request("ping", {"a": 1})
    assert resp["result"] == {"ok": True}
    assert resp["_ignored_stdout_lines"] == 0
    payload = json.loads(sent[0])
    assert payload == {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"a": 1}}
    # notify has no id
    client.notify("event")
    notif = json.loads(sent[1])
    assert notif == {"jsonrpc": "2.0", "method": "event"}
    # notify WITH params includes the params object
    client.notify("event2", {"k": "v"})
    notif2 = json.loads(sent[2])
    assert notif2 == {"jsonrpc": "2.0", "method": "event2", "params": {"k": "v"}}


def test_wait_for_id_ignores_garbage_and_unmatched_ids():
    client = probe.McpClient(["x"], probe.HOME, 2.0)
    client.proc = FakeProc(returncode=None)
    client.queue.put("not json at all\n")                       # ignored (json error)
    client.queue.put(json.dumps({"id": 99, "result": 1}) + "\n")  # unmatched id
    client.queue.put(json.dumps({"id": 5, "result": "hit"}) + "\n")
    client.next_id = 5
    msg = client.wait_for_id(5)
    assert msg["result"] == "hit"
    assert msg["_ignored_stdout_lines"] == 1


def test_wait_for_id_raises_when_process_exits_with_empty_queue():
    client = probe.McpClient(["x"], probe.HOME, 2.0)
    client.proc = FakeProc(returncode=1)  # already exited
    try:
        client.wait_for_id(1)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as exc:
        assert "exited before response" in str(exc)


def test_wait_for_id_times_out():
    client = probe.McpClient(["x"], probe.HOME, 0.05)
    client.proc = FakeProc(returncode=None)  # alive, but never answers
    try:
        client.wait_for_id(1)
        raise AssertionError("expected TimeoutError")
    except TimeoutError as exc:
        assert "timed out" in str(exc)


def test_mcpclient_exit_terminates_running_proc():
    client = probe.McpClient(["x"], probe.HOME, 1.0)
    fake = FakeProc(returncode=None)
    client.proc = fake
    client.__exit__(None, None, None)
    assert fake.terminated is True
    assert client.io_stats["returncode"] == fake.poll()


def test_mcpclient_exit_kills_on_terminate_timeout():
    client = probe.McpClient(["x"], probe.HOME, 1.0)

    class StubbornProc(FakeProc):
        def wait(self, timeout=None):
            raise subprocess.TimeoutExpired(cmd="x", timeout=timeout)

    fake = StubbornProc(returncode=None)
    client.proc = fake
    client.__exit__(None, None, None)
    assert fake.terminated is True
    assert fake.killed is True


def test_mcpclient_exit_noop_when_no_proc():
    client = probe.McpClient(["x"], probe.HOME, 1.0)
    client.proc = None
    # must not raise
    client.__exit__(None, None, None)
    assert "returncode" not in client.io_stats


# --------------------------------------------------------------------------
# probe_tools: happy path + every unhappy branch (McpClient is faked)
# --------------------------------------------------------------------------
def test_probe_tools_skips_when_no_command():
    res = probe.probe_tools({"command": [], "transport": "stdio"}, 1.0)
    assert res == {"status": "skipped", "reason": "no_stdio_command"}


def test_probe_tools_skips_non_stdio_transport():
    res = probe.probe_tools({"command": ["node"], "transport": "http"}, 1.0)
    assert res == {"status": "skipped", "reason": "not_stdio"}


def test_probe_tools_happy_path_paginates_and_emits_metadata():
    client = FakeClient({
        "initialize": [{"result": {"capabilities": {"tools": {}}}}],
        "tools/list": [
            {"result": {"tools": [{"name": "b_tool",
                                   "description": "hidden blurb",
                                   "inputSchema": {"type": "object",
                                                   "properties": {"x": {}}}}],
                        "nextCursor": "page2"}},
            {"result": {"tools": [{"name": "a_tool", "description": ""}]}},
        ],
        "shutdown": [{"result": {}}],
    })
    old = probe.McpClient
    probe.McpClient = _client_factory(client)
    try:
        res = probe.probe_tools({"command": ["node", "s.js"], "transport": "stdio"}, 1.0)
    finally:
        probe.McpClient = old
    assert res["status"] == "ok"
    assert res["tool_count"] == 2
    assert res["pages"] == 2
    assert [t["name"] for t in res["tools"]] == ["a_tool", "b_tool"]
    assert res["shutdown_status"] == "ok"
    assert res["shutdown_error_type"] is None
    assert res["server_capabilities_keys"] == ["tools"]
    assert "notifications/initialized" in client.notified
    assert "hidden blurb" not in json.dumps(res)
    assert isinstance(res["elapsed_ms"], int)


def test_probe_tools_initialize_error_is_typed_not_silent_skip():
    client = FakeClient({
        "initialize": [{"error": {"code": -32000, "message": "boom"}}],
    })
    old = probe.McpClient
    probe.McpClient = _client_factory(client)
    try:
        res = probe.probe_tools({"command": ["node"], "transport": "stdio"}, 1.0)
    finally:
        probe.McpClient = old
    assert res["status"] == "error"
    assert res["phase"] == "initialize"
    assert res["error_code"] == -32000
    assert res["error_message_sha256_16"]
    assert "boom" not in json.dumps(res)  # message hashed, not emitted


def test_probe_tools_tools_list_error_is_typed():
    client = FakeClient({
        "initialize": [{"result": {"capabilities": {}}}],
        "tools/list": [{"error": {"code": -32601, "message": "no method"}}],
    })
    old = probe.McpClient
    probe.McpClient = _client_factory(client)
    try:
        res = probe.probe_tools({"command": ["node"], "transport": "stdio"}, 1.0)
    finally:
        probe.McpClient = old
    assert res["status"] == "error"
    assert res["phase"] == "tools/list"
    assert res["error_code"] == -32601
    assert "no method" not in json.dumps(res)


def test_probe_tools_shutdown_error_recorded_but_status_ok():
    # capabilities is a non-dict here -> server_capabilities_keys falls to the
    # `else []` branch instead of sorting dict keys.
    client = FakeClient({
        "initialize": [{"result": {"capabilities": ["not", "a", "dict"]}}],
        "tools/list": [{"result": {"tools": []}}],
    }, shutdown_raises=True)
    old = probe.McpClient
    probe.McpClient = _client_factory(client)
    try:
        res = probe.probe_tools({"command": ["node"], "transport": "stdio"}, 1.0)
    finally:
        probe.McpClient = old
    assert res["status"] == "ok"
    assert res["shutdown_status"] == "error"
    assert res["shutdown_error_type"] == "RuntimeError"
    assert res["server_capabilities_keys"] == []  # capabilities not a dict -> else []


def test_probe_tools_transport_exception_is_typed_error():
    client = FakeClient({}, raise_on_enter=OSError("cannot spawn"))
    old = probe.McpClient
    probe.McpClient = _client_factory(client)
    try:
        res = probe.probe_tools({"command": ["node"], "transport": "stdio"}, 1.0)
    finally:
        probe.McpClient = old
    assert res["status"] == "error"
    assert res["phase"] == "transport"
    assert res["error_type"] == "OSError"
    assert res["error_message_sha256_16"]
    assert "cannot spawn" not in json.dumps(res)


# --------------------------------------------------------------------------
# select_probe_entries
# --------------------------------------------------------------------------
def _entry(server, command=None, risk=None, harness="codex"):
    return {
        "server": server, "harness": harness,
        "command": command or ["node", server + ".js"],
        "risk_classes": risk or [],
    }


def test_select_probe_entries_default_allowlist_filters_unsafe_and_dedups():
    entries = [
        _entry("memory"),
        _entry("memory"),                         # duplicate -> deduped
        _entry("pinecone", risk=["auth_or_secret_backed"]),  # secret -> filtered
        _entry("randomthing"),                    # not in safe default -> filtered
    ]
    selected = probe.select_probe_entries(entries, requested=set(), allow_secret_backed=False)
    assert [e["server"] for e in selected] == ["memory"]


def test_select_probe_entries_requested_overrides_allowlist():
    entries = [_entry("randomthing"), _entry("memory")]
    selected = probe.select_probe_entries(entries, requested={"randomthing"}, allow_secret_backed=False)
    assert [e["server"] for e in selected] == ["randomthing"]


def test_select_probe_entries_allow_secret_backed_keeps_secret_servers():
    entries = [_entry("pinecone", risk=["auth_or_secret_backed"])]
    blocked = probe.select_probe_entries(entries, requested={"pinecone"}, allow_secret_backed=False)
    assert blocked == []
    allowed = probe.select_probe_entries(entries, requested={"pinecone"}, allow_secret_backed=True)
    assert [e["server"] for e in allowed] == ["pinecone"]


# --------------------------------------------------------------------------
# public_entry
# --------------------------------------------------------------------------
def test_public_entry_drops_raw_command_url_and_adds_summaries():
    entry = {
        "server": "remote", "harness": "codex",
        "command": ["node", "/home/secret.js"],
        "url": "https://host.example.test/mcp?token=abc",
        "risk_classes": ["remote"],
    }
    pub = probe.public_entry(entry)
    assert "command" not in pub and "url" not in pub
    assert pub["command_summary"]["argc"] == 2
    # public_entry builds a url_summary, but redact() then suppresses it whole
    # because the key contains "url" (defense in depth) -> no host/scheme leak.
    assert "url_summary" in pub
    assert pub["url_summary"] == "<redacted>"
    assert "host.example.test" not in json.dumps(pub)
    assert "/home/secret.js" not in json.dumps(pub)


# --------------------------------------------------------------------------
# build_report: static (no probe) + probe_tools paths + skip reasons
# --------------------------------------------------------------------------
def test_tool_description_is_hashed_not_emitted():
    tools = [
        {
            "name": "read_secretish",
            "description": "description includes sk-proj-0000000000000000000000000000000000000000",
            "inputSchema": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        }
    ]
    rows = probe.summarize_tools(tools)
    rendered = json.dumps(rows, sort_keys=True)
    assert rows[0]["description_bytes"] > 0, rows
    assert rows[0]["description_sha256_16"], rows
    assert "description includes" not in rendered, rows
    assert "sk-proj-0000000000000000000000000000000000000000" not in rendered, rows
    assert rows[0]["input_schema"]["property_names"] == ["path"], rows


def test_static_report_redacts_command_and_url_values():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-schema-probe-test-"))
    old_home = probe.HOME
    try:
        probe.HOME = tmp
        (tmp / ".codex").mkdir(parents=True)
        (tmp / ".codex/config.toml").write_text(
            """
            [mcp_servers.remote]
            url = "https://token.example.test/mcp?token=sk-proj-0000000000000000000000000000000000000000"

            [mcp_servers.local]
            command = "/tmp/secret-command"
            """,
            encoding="utf-8",
        )
        report = probe.build_report(Namespace(probe_tools=False, server=[], allow_secret_backed=False, timeout=1.0))
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "agent-runtime-mcp-schema-inventory", report
        assert "sk-proj-0000000000000000000000000000000000000000" not in rendered, report
        assert "token.example.test" not in rendered, report
    finally:
        probe.HOME = old_home


def test_build_report_static_summary_counts_and_verdict():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-build-static-"))
    old = _write_home(tmp)
    try:
        (tmp / ".codex").mkdir(parents=True)
        (tmp / ".codex/config.toml").write_text(
            "[mcp_servers.memory]\ncommand = [\"node\", \"mem.js\"]\n"
            "[mcp_servers.pinecone]\nurl = \"https://pc.example.test\"\n",
            encoding="utf-8",
        )
        report = probe.build_report(Namespace(probe_tools=False, server=[], allow_secret_backed=False, timeout=1.0))
        assert report["verdict"] == "static_inventory_only"
        assert report["proof_class"] == "static_config"
        assert report["summary"]["configured_entry_count"] == 2
        assert report["summary"]["configured_by_harness"] == {"codex": 2}
        assert report["summary"]["probe_tools_requested"] is False
        assert report["summary"]["probe_selected_count"] == 0
        # nothing probed -> all entries land in skipped with reason not_requested
        assert report["summary"]["skipped_count"] == 2
        assert {s["reason"] for s in report["skipped"]} == {"not_requested"}
    finally:
        probe.HOME = old


def test_build_report_probe_tools_classifies_skip_reasons_and_aggregates():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-build-probe-"))
    old_home = _write_home(tmp)
    (tmp / ".codex").mkdir(parents=True)
    (tmp / ".codex/config.toml").write_text(
        # memory: safe default -> probed
        "[mcp_servers.memory]\ncommand = [\"node\", \"mem.js\"]\n"
        # pinecone: secret-backed -> skipped (secret reason)
        "[mcp_servers.pinecone]\ncommand = [\"node\", \"pc.js\"]\nenv = {API_TOKEN = \"x\"}\n"
        # extra: not in allowlist -> skipped (outside allowlist)
        "[mcp_servers.extra]\ncommand = [\"node\", \"e.js\"]\n",
        encoding="utf-8",
    )

    client = FakeClient({
        "initialize": [{"result": {"capabilities": {"tools": {}}}}],
        "tools/list": [{"result": {"tools": [
            {"name": "lookup", "description": "", "inputSchema": {"type": "object"}},
            {"name": "store_note", "description": "", "inputSchema": {"type": "object"}},
        ]}}],
        "shutdown": [{"result": {}}],
    })
    old_client = probe.McpClient
    probe.McpClient = _client_factory(client)
    try:
        report = probe.build_report(Namespace(
            probe_tools=True, server=[], allow_secret_backed=False, timeout=1.0))
    finally:
        probe.McpClient = old_client
        probe.HOME = old_home

    assert report["verdict"] == "partial_schema_inventory_landed"
    assert report["proof_class"] == "static_config_plus_mcp_tools_list_for_selected_stdio_servers"
    assert report["summary"]["probe_tools_requested"] is True
    assert report["summary"]["probe_selected_count"] == 1
    assert report["summary"]["probe_ok_count"] == 1
    assert report["summary"]["probe_tool_count_total"] == 2

    probes = report["schema_probes"]
    assert len(probes) == 1
    assert probes[0]["server"] == "memory"
    assert probes[0]["schema_probe"]["status"] == "ok"

    reasons = {s["server"]: s["reason"] for s in report["skipped"]}
    assert reasons["pinecone"] == "secret_remote_or_private_data_backed"
    assert reasons["extra"] == "outside_safe_default_allowlist"
    assert "memory" not in reasons  # memory was probed, not skipped


# --------------------------------------------------------------------------
# main() entrypoints (in-process, stdout captured)
# --------------------------------------------------------------------------
def test_main_default_emits_static_json(capsys_free_stdout=None):
    tmp = Path(tempfile.mkdtemp(prefix="mcp-main-"))
    old = _write_home(tmp)
    buf = io.StringIO()
    from contextlib import redirect_stdout
    try:
        with redirect_stdout(buf):
            rc = probe.main([])
    finally:
        probe.HOME = old
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-mcp-schema-inventory"
    assert report["verdict"] == "static_inventory_only"


def test_main_pretty_flag_indents_output():
    tmp = Path(tempfile.mkdtemp(prefix="mcp-main-pretty-"))
    old = _write_home(tmp)
    buf = io.StringIO()
    from contextlib import redirect_stdout
    try:
        with redirect_stdout(buf):
            rc = probe.main(["--pretty"])
    finally:
        probe.HOME = old
    assert rc == 0
    out = buf.getvalue()
    assert "\n  " in out  # indented (pretty) JSON
    assert json.loads(out)["schema"] == "agent-runtime-mcp-schema-inventory"


def test_cli_entrypoint_emits_valid_json():
    # e2e: covers the `if __name__ == "__main__"` entrypoint + real json.dump path.
    # Default mode only (no --probe-tools) -> never starts an MCP server.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-mcp-schema-inventory"
    assert "verdict" in report and "limitations" in report
    assert report["proof_class"] == "static_config"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} MCP schema inventory tests passed")
