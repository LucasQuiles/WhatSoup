from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _clean_headless_fragments() -> list[str]:
    return [
        "provider_auth_context=headless_login_keychain_blocked",
        "credential_item_status=ok",
        "claude_settings_exists=true",
        "claude_settings_owner_mismatch=false",
        "claude_settings_writable=true",
        "claude_state_exists=true",
        "claude_state_user_id_present=true",
        "claude_state_oauth_account_present=true",
        "claude_state_owner_mismatch=false",
    ]


def test_headless_provider_auth_failure_is_contradicted_by_fresh_live_service():
    assert _mod.provider_probe_contradicted_by_live_service(
        "provider_auth_required",
        ["provider_auth_context=headless_login_keychain_blocked"],
        {"fresh": True, "active": 1, "alive": 0},
    )


def test_headless_provider_usage_limit_is_not_downgraded_by_live_service():
    assert not _mod.provider_probe_contradicted_by_live_service(
        "provider_usage_limit",
        ["provider_auth_context=headless_login_keychain_blocked"],
        {"fresh": True, "active": 1, "alive": 1},
    )


def test_headless_provider_auth_failure_is_inconclusive_with_clean_local_auth_state():
    assert _mod.provider_probe_inconclusive_due_to_headless_auth(
        "provider_auth_required",
        _clean_headless_fragments(),
    )


def test_headless_provider_auth_failure_stays_actionable_with_hard_credential_negative():
    fragments = _clean_headless_fragments()
    fragments.append("credential_secret_status=missing")

    assert not _mod.provider_probe_inconclusive_due_to_headless_auth(
        "provider_auth_required",
        fragments,
    )


def test_headless_provider_auth_failure_stays_actionable_when_local_auth_state_is_missing():
    assert not _mod.provider_probe_inconclusive_due_to_headless_auth(
        "provider_auth_required",
        ["provider_auth_context=headless_login_keychain_blocked"],
    )


def test_provider_credential_probe_unlocks_and_pins_login_keychain(monkeypatch):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod, "provider_settings_fragments", lambda: [])
    monkeypatch.setattr(_mod, "provider_claude_state_fragments", lambda: [])
    monkeypatch.setattr(_mod, "provider_macos_session_fragments", lambda _account, _timeout: [])
    commands: list[list[str]] = []

    def fake_provider_command_output(command, *_args):
        commands.append(command)
        if command[:2] == ["security", "find-generic-password"] and "-w" in command:
            return "secret-value", "", 0, False
        return "", "", 0, False

    monkeypatch.setattr(_mod, "provider_command_output", fake_provider_command_output)

    fragments = _mod.provider_credential_fragments({}, {}, "claude-cli", 15)

    keychain_path = str(Path.home() / "Library" / "Keychains" / "login.keychain-db")
    account = _mod.os.environ.get("USER") or Path.home().name
    service = "Claude" + " Code-credentials"
    assert "keychain_unlock_status=ok" in fragments
    assert "credential_item_status=ok" in fragments
    assert "credential_secret_status=ok" in fragments
    assert ["security", "unlock-keychain", "-p", "", keychain_path] in commands
    assert ["security", "find-generic-password", "-s", service, "-a", account, keychain_path] in commands
    assert ["security", "find-generic-password", "-s", service, "-a", account, "-w", keychain_path] in commands
