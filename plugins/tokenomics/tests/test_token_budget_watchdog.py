import importlib.machinery
import importlib.util
import json
import os
import pathlib
import socket
import threading
import urllib.request


PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
WATCHDOG_PATH = PLUGIN_ROOT / "scripts" / "token-budget-watchdog"


def load_watchdog():
    loader = importlib.machinery.SourceFileLoader("token_budget_watchdog", str(WATCHDOG_PATH))
    spec = importlib.util.spec_from_loader("token_budget_watchdog", loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def make_env(tmp_path, *, ceiling="1000", cooldown="1800", state_override=True):
    env = {
        "HOME": str(tmp_path / "home"),
        "TOKENOMICS_BOT": "target-bot",
        "TOKENOMICS_INSTANCE_PATH": str(tmp_path / "instance"),
        "TOKENOMICS_CEILING": ceiling,
        "TOKENOMICS_ALERT_COOLDOWN_SECONDS": cooldown,
        "WHATSOUP_REPO": str(tmp_path / "WhatSoup"),
    }
    if state_override:
        env["TOKENOMICS_STATE_DIR"] = str(tmp_path / "state")
    return env


def helper_output(module, total_tokens, *, available=True):
    return module.HelperResult(
        exit_code=0,
        stdout=json.dumps(
            {
                "total_tokens": total_tokens,
                "sources": {"whatsoup_db": {"available": available}},
            }
        ),
        stderr="",
    )


def run_cycle(module, env, helper_result, *, now=1_000):
    alerts = []

    result = module.run_cycle(
        env=env,
        now_fn=lambda: now,
        syslog_fn=lambda priority, message: alerts.append((priority, message)),
        helper_fn=lambda _config: helper_result,
    )
    return result, alerts


def state_root(module, env) -> pathlib.Path:
    return module.state_root(env)


def history_lines(module, env):
    path = state_root(module, env) / "history.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def last_alert(module, env):
    path = state_root(module, env) / "last-alert.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def test_helper_nonzero_exit_produces_no_alert_or_history(tmp_path, capsys):
    module = load_watchdog()
    env = make_env(tmp_path)

    result, alerts = run_cycle(
        module,
        env,
        module.HelperResult(exit_code=2, stdout="", stderr="helper failed"),
    )

    assert result == 0
    assert alerts == []
    assert history_lines(module, env) == []
    assert last_alert(module, env) is None
    assert "helper failed" in capsys.readouterr().err


def test_helper_unavailable_produces_no_alert_or_history(tmp_path):
    module = load_watchdog()
    env = make_env(tmp_path)

    result, alerts = run_cycle(module, env, helper_output(module, 900, available=False))

    assert result == 0
    assert alerts == []
    assert history_lines(module, env) == []
    assert last_alert(module, env) is None


def test_below_ceiling_writes_history_without_syslog(tmp_path):
    module = load_watchdog()
    env = make_env(tmp_path, ceiling="1000")

    result, alerts = run_cycle(module, env, helper_output(module, 500), now=1_234)

    assert result == 0
    assert alerts == []
    assert history_lines(module, env) == [
        {"ts": 1_234, "window_sum": 500, "ceiling": 1000, "pct": 0.5}
    ]
    assert last_alert(module, env) is None


def test_above_ceiling_alerts_and_updates_last_alert(tmp_path):
    module = load_watchdog()
    env = make_env(tmp_path, ceiling="1000")

    result, alerts = run_cycle(module, env, helper_output(module, 750), now=2_000)

    assert result == 0
    assert len(alerts) == 1
    assert alerts[0][0] == module.syslog.LOG_WARNING
    assert "target-bot" in alerts[0][1]
    assert history_lines(module, env)[0]["pct"] == 0.75
    assert last_alert(module, env) == {"ts": 2_000}


def test_cooldown_suppresses_duplicate_alert_but_records_history(tmp_path):
    module = load_watchdog()
    env = make_env(tmp_path, ceiling="1000", cooldown="1800")
    root = state_root(module, env)
    root.mkdir(parents=True)
    (root / "last-alert.json").write_text(json.dumps({"ts": 2_000}), encoding="utf-8")

    result, alerts = run_cycle(module, env, helper_output(module, 900), now=2_300)

    assert result == 0
    assert alerts == []
    assert len(history_lines(module, env)) == 1
    assert last_alert(module, env) == {"ts": 2_000}


def test_cooldown_expiry_allows_fresh_alert(tmp_path):
    module = load_watchdog()
    env = make_env(tmp_path, ceiling="1000", cooldown="1800")
    root = state_root(module, env)
    root.mkdir(parents=True)
    (root / "last-alert.json").write_text(json.dumps({"ts": 2_000}), encoding="utf-8")

    result, alerts = run_cycle(module, env, helper_output(module, 900), now=4_000)

    assert result == 0
    assert len(alerts) == 1
    assert len(history_lines(module, env)) == 1
    assert last_alert(module, env) == {"ts": 4_000}


def test_concurrent_history_appends_remain_valid_json(tmp_path):
    module = load_watchdog()
    history_path = tmp_path / "history.jsonl"

    def append_many(worker):
        for i in range(50):
            module.append_history(history_path, {"worker": worker, "i": i})

    threads = [threading.Thread(target=append_many, args=(worker,)) for worker in (1, 2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    records = [json.loads(line) for line in history_path.read_text(encoding="utf-8").splitlines()]
    assert len(records) == 100
    assert sorted({record["worker"] for record in records}) == [1, 2]


def test_alert_only_no_network_kill_or_log_directory(tmp_path, monkeypatch):
    module = load_watchdog()
    env = make_env(tmp_path, ceiling="1000", state_override=False)
    calls = []

    monkeypatch.setattr(os, "kill", lambda *args, **kwargs: calls.append(("kill", args, kwargs)))
    monkeypatch.setattr(
        socket,
        "create_connection",
        lambda *args, **kwargs: calls.append(("socket", args, kwargs)),
    )
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *args, **kwargs: calls.append(("urlopen", args, kwargs)),
    )

    result, alerts = run_cycle(module, env, helper_output(module, 900), now=5_000)

    assert result == 0
    assert len(alerts) == 1
    assert calls == []
    assert not (pathlib.Path(env["HOME"]) / "Library" / "Logs").exists()


def test_watchdog_source_has_no_chat_network_or_config_mutation_imports():
    source = WATCHDOG_PATH.read_text(encoding="utf-8")

    for forbidden in ("requests", "httpx", "urllib", "socket", "os.kill", "sendMessage", "WhatsApp"):
        assert forbidden not in source
    assert ".config/whatsoup" not in source


def test_invokes_token_window_helper_with_resolved_node_and_timeout(tmp_path):
    module = load_watchdog()
    repo = tmp_path / "WhatSoup"
    script = repo / "scripts" / "token-window.ts"
    script.parent.mkdir(parents=True)
    script.write_text("// helper\n", encoding="utf-8")
    env = make_env(tmp_path)
    env["WHATSOUP_REPO"] = str(repo)
    env["TOKENOMICS_NODE_BIN"] = "/custom/node"
    seen = {}

    def fake_run(args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        return type("Completed", (), {"returncode": 0, "stdout": '{"total_tokens":1}', "stderr": ""})()

    result = module.invoke_token_window(module.load_config(env), run_fn=fake_run)

    assert result.exit_code == 0
    assert seen["args"] == [
        "/custom/node",
        "--experimental-strip-types",
        str(script),
        "--instance",
        env["TOKENOMICS_INSTANCE_PATH"],
        "--window",
        "5h",
        "--json",
    ]
    assert seen["kwargs"]["cwd"] == str(repo)
    assert seen["kwargs"]["timeout"] == 30
