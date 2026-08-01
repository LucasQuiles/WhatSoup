import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time


PLUGIN_ROOT = pathlib.Path(__file__).resolve().parents[1]
HOOK_PATH = PLUGIN_ROOT / "hooks" / "browser-loop-interrupt.py"
TOOL_NAME = "mcp__superpowers-chrome_chrome__use_browser"


def session_state_path(state_root: pathlib.Path, session_id: str) -> pathlib.Path:
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]
    return state_root / "browser-loop" / f"{digest}.jsonl"


def load_hook_module():
    spec = importlib.util.spec_from_file_location("browser_loop_interrupt", HOOK_PATH)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run_hook(state_root: pathlib.Path, payload: dict | None, *, bot: str | None = "target-bot"):
    env = os.environ.copy()
    env["TOKENOMICS_STATE_DIR"] = str(state_root)
    if bot is None:
        env.pop("TOKENOMICS_BOT", None)
    else:
        env["TOKENOMICS_BOT"] = bot
    stdin = "" if payload is None else json.dumps(payload)
    return subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=stdin,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def payload(session_id: str = "session-a") -> dict:
    return {
        "session_id": session_id,
        "tool_name": TOOL_NAME,
        "tool_input": {"action": "navigate", "payload": "https://example.test"},
    }


def seed_state(state_root: pathlib.Path, session_id: str, timestamps: list[float]) -> pathlib.Path:
    path = session_state_path(state_root, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps({"ts": ts, "tool_name": TOOL_NAME}) + "\n" for ts in timestamps),
        encoding="utf-8",
    )
    return path


def deny_payload(stdout: str) -> dict:
    data = json.loads(stdout)
    assert sorted(data.keys()) == ["hookSpecificOutput"]
    output = data["hookSpecificOutput"]
    assert output["hookEventName"] == "PreToolUse"
    assert output["permissionDecision"] == "deny"
    return output


def test_first_call_allows_without_stdout(tmp_path):
    result = run_hook(tmp_path, payload())

    assert result.returncode == 0
    assert result.stdout == ""


def test_seventh_call_allows_but_eighth_call_denies(tmp_path):
    for _ in range(7):
        result = run_hook(tmp_path, payload())
        assert result.returncode == 0
        assert result.stdout == ""

    result = run_hook(tmp_path, payload())

    output = deny_payload(result.stdout)
    reason = output["permissionDecisionReason"]
    assert "different strategy" in reason
    assert "summarize" in reason
    assert "alternative" in reason
    assert len(reason.encode("utf-8")) <= 2000


def test_stale_entries_do_not_count_toward_sliding_window(tmp_path):
    now = time.time()
    seed_state(
        tmp_path,
        "session-a",
        [now - 120 for _ in range(7)] + [now - 10 for _ in range(6)],
    )

    seventh_fresh = run_hook(tmp_path, payload())
    eighth_fresh = run_hook(tmp_path, payload())

    assert seventh_fresh.stdout == ""
    deny_payload(eighth_fresh.stdout)


def test_two_sessions_are_isolated(tmp_path):
    now = time.time()
    seed_state(tmp_path, "session-a", [now - 10 for _ in range(7)])

    session_b = run_hook(tmp_path, payload("session-b"))
    session_a = run_hook(tmp_path, payload("session-a"))

    assert session_b.stdout == ""
    deny_payload(session_a.stdout)


def test_path_like_session_id_is_hashed_inside_state_dir(tmp_path):
    session_id = "../../etc/passwd"
    result = run_hook(tmp_path, payload(session_id))

    assert result.returncode == 0
    state_path = session_state_path(tmp_path, session_id)
    assert state_path.exists()
    assert state_path.parent == tmp_path / "browser-loop"
    assert state_path.name == hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16] + ".jsonl"


def test_path_like_bot_uses_sanitized_default_state_root(tmp_path, monkeypatch):
    module = load_hook_module()
    monkeypatch.delenv("TOKENOMICS_STATE_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setattr(sys, "platform", "darwin")

    root = module.state_root("../../evil bot")

    assert root == pathlib.Path.home() / "Library" / "Application Support" / "evil_bot-tokenomics"


def test_path_like_bot_uses_xdg_state_dir_on_linux(tmp_path, monkeypatch):
    module = load_hook_module()
    monkeypatch.delenv("TOKENOMICS_STATE_DIR", raising=False)
    monkeypatch.delenv("XDG_STATE_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setattr(sys, "platform", "linux")

    root = module.state_root("../../evil bot")

    assert root == pathlib.Path.home() / ".local" / "state" / "evil_bot-tokenomics"
    assert "Library" not in str(root)
    assert "Application Support" not in str(root)


def test_path_like_bot_honors_xdg_state_home_override_on_linux(tmp_path, monkeypatch):
    module = load_hook_module()
    monkeypatch.delenv("TOKENOMICS_STATE_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "custom-xdg"))
    monkeypatch.setattr(sys, "platform", "linux")

    root = module.state_root("target-bot")

    assert root == tmp_path / "custom-xdg" / "target-bot-tokenomics"


def test_empty_stdin_fails_open(tmp_path):
    result = run_hook(tmp_path, None)

    assert result.returncode == 0
    assert result.stdout == ""


def test_missing_bot_env_fails_open(tmp_path):
    result = run_hook(tmp_path, payload(), bot=None)

    assert result.returncode == 0
    assert result.stdout == ""


def test_corrupt_state_file_fails_open_and_resets_state(tmp_path):
    state_path = session_state_path(tmp_path, "session-a")
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text("{not json}\n", encoding="utf-8")

    result = run_hook(tmp_path, payload())

    assert result.returncode == 0
    assert result.stdout == ""
    records = [json.loads(line) for line in state_path.read_text(encoding="utf-8").splitlines()]
    assert len(records) == 1


def test_unwritable_state_path_fails_open(tmp_path):
    state_root = tmp_path / "state-as-file"
    state_root.write_text("not a directory", encoding="utf-8")

    result = run_hook(state_root, payload())

    assert result.returncode == 0
    assert result.stdout == ""


def test_deny_reason_truncates_to_2000_bytes():
    module = load_hook_module()

    reason = module.build_deny_reason(extra="x" * 5000)

    assert len(reason.encode("utf-8")) <= 2000
    assert "different strategy" in reason
    assert "summarize" in reason
    assert "alternative" in reason
