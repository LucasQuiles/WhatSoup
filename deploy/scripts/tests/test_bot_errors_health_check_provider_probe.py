from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

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


def test_provider_credential_probe_skips_keychain_unlock_by_default(monkeypatch):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.delenv("BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK", raising=False)
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
    assert "keychain_unlock_policy=observe_only" in fragments
    assert "keychain_unlock_status=skipped" in fragments
    assert "credential_item_status=ok" in fragments
    assert "credential_secret_status=ok" in fragments
    assert ["security", "unlock-keychain", "-p", "", keychain_path] not in commands
    assert ["security", "find-generic-password", "-s", service, "-a", account, keychain_path] in commands
    assert ["security", "find-generic-password", "-s", service, "-a", account, "-w", keychain_path] in commands


def test_provider_credential_probe_unlocks_when_env_opted_in(monkeypatch):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setenv("BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK", "1")
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
    assert "keychain_unlock_policy=enabled" in fragments
    assert "keychain_unlock_status=ok" in fragments
    assert "credential_item_status=ok" in fragments
    assert "credential_secret_status=ok" in fragments
    assert ["security", "unlock-keychain", "-p", "", keychain_path] in commands
    assert ["security", "find-generic-password", "-s", service, "-a", account, keychain_path] in commands
    assert ["security", "find-generic-password", "-s", service, "-a", account, "-w", keychain_path] in commands


def test_provider_credential_probe_unlocks_when_profile_opted_in(monkeypatch):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.delenv("BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK", raising=False)
    monkeypatch.setattr(_mod, "provider_settings_fragments", lambda: [])
    monkeypatch.setattr(_mod, "provider_claude_state_fragments", lambda: [])
    monkeypatch.setattr(_mod, "provider_macos_session_fragments", lambda _account, _timeout: [])
    commands: list[list[str]] = []

    def fake_provider_command_output(command, *_args):
        commands.append(command)
        return "", "", 0, False

    monkeypatch.setattr(_mod, "provider_command_output", fake_provider_command_output)

    fragments = _mod.provider_credential_fragments({"providerCredentialUnlockKeychain": True}, {}, "claude-cli", 15)

    keychain_path = str(Path.home() / "Library" / "Keychains" / "login.keychain-db")
    assert "keychain_unlock_policy=enabled" in fragments
    assert "keychain_unlock_status=ok" in fragments
    assert ["security", "unlock-keychain", "-p", "", keychain_path] in commands


def test_provider_credential_probe_item_false_overrides_profile_and_env_unlock(monkeypatch):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setenv("BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK", "1")
    monkeypatch.setattr(_mod, "provider_settings_fragments", lambda: [])
    monkeypatch.setattr(_mod, "provider_claude_state_fragments", lambda: [])
    monkeypatch.setattr(_mod, "provider_macos_session_fragments", lambda _account, _timeout: [])
    commands: list[list[str]] = []

    def fake_provider_command_output(command, *_args):
        commands.append(command)
        return "", "", 0, False

    monkeypatch.setattr(_mod, "provider_command_output", fake_provider_command_output)

    fragments = _mod.provider_credential_fragments(
        {"providerCredentialUnlockKeychain": True},
        {"providerCredentialUnlockKeychain": False},
        "claude-cli",
        15,
    )

    keychain_path = str(Path.home() / "Library" / "Keychains" / "login.keychain-db")
    assert "keychain_unlock_policy=observe_only" in fragments
    assert "keychain_unlock_status=skipped" in fragments
    assert ["security", "unlock-keychain", "-p", "", keychain_path] not in commands


def test_fleet_api_default_url_uses_configured_bind_address(monkeypatch):
    monkeypatch.setenv("FLEET_BIND_ADDRESS", "192.0.2.10")
    monkeypatch.delenv("BOT_ERRORS_FLEET_API_PORT", raising=False)

    assert _mod.fleet_api_default_url({}) == "http://192.0.2.10:9099"


def test_fleet_api_default_url_uses_loopback_for_wildcard_bind(monkeypatch):
    monkeypatch.setenv("FLEET_BIND_ADDRESS", "0.0.0.0")
    monkeypatch.setenv("BOT_ERRORS_FLEET_API_PORT", "19099")

    assert _mod.fleet_api_default_url({}) == "http://127.0.0.1:19099"


def test_fleet_api_default_url_brackets_ipv6_bind(monkeypatch):
    monkeypatch.delenv("FLEET_BIND_ADDRESS", raising=False)
    monkeypatch.delenv("BOT_ERRORS_FLEET_API_PORT", raising=False)

    assert _mod.fleet_api_default_url({"fleetApi": {"bindAddress": "fd7a:115c:a1e0::1", "port": 9098}}) == (
        "http://[fd7a:115c:a1e0::1]:9098"
    )


def test_fleet_api_inventory_explicit_url_still_wins(monkeypatch):
    monkeypatch.setenv("FLEET_BIND_ADDRESS", "192.0.2.10")
    monkeypatch.setenv("BOT_ERRORS_FLEET_API_URL", "http://127.0.0.1:18080/api/instances")
    monkeypatch.setenv("BOT_ERRORS_DRY_FLEET_TOKEN_JSON", '{"active":"token","accept":[]}')
    monkeypatch.setenv("BOT_ERRORS_DRY_FLEET_API_STATUS", "200")
    monkeypatch.setenv("BOT_ERRORS_DRY_FLEET_API_BODY", '{"instances":[{"name":"q"}]}')

    lines = _mod.fleet_api_inventory({"expectFleetApi": True})

    assert len(lines) == 1
    assert "endpoint=http://127.0.0.1:18080/api/instances" in lines[0]
    assert "instances=1" in lines[0]


def test_load_fleet_api_token_expands_tilde_from_profile(monkeypatch, tmp_path):
    home = tmp_path / "home"
    token_file = home / ".config" / "whatsoup" / "fleet-tokens.json"
    token_file.parent.mkdir(parents=True)
    token_file.write_text('{"active":"fixture-active-token","accept":[]}\n', encoding="utf-8")
    token_file.chmod(0o600)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("BOT_ERRORS_DRY_FLEET_TOKEN_JSON", raising=False)
    monkeypatch.delenv("BOT_ERRORS_FLEET_TOKEN_FILE", raising=False)

    token, source, accept_count, error = _mod.load_fleet_api_token(
        {"fleetApiTokenFile": "~/.config/whatsoup/fleet-tokens.json"}
    )

    assert token == "fixture-active-token"
    assert source.startswith("file token_source_path_redacted=true")
    assert "token_source_path_basename=fleet-tokens.json" in source
    assert accept_count == 0
    assert error is None


def test_load_fleet_api_token_rejects_group_or_other_permissions(monkeypatch, tmp_path):
    for mode in (0o404, 0o440, 0o444):
        token_file = tmp_path / f"fleet-tokens-{mode:o}.json"
        token_file.write_text('{"active":"fixture-active-token","accept":[]}\n', encoding="utf-8")
        token_file.chmod(mode)
        monkeypatch.delenv("BOT_ERRORS_DRY_FLEET_TOKEN_JSON", raising=False)
        monkeypatch.setenv("BOT_ERRORS_FLEET_TOKEN_FILE", str(token_file))

        token, _source, _accept_count, error = _mod.load_fleet_api_token({})

        assert token is None
        assert error == f"token_mode_too_open mode={mode:o}"


def test_load_fleet_api_token_rejects_a_symlinked_parent(monkeypatch, tmp_path):
    real_config = tmp_path / "real-config"
    token_file = real_config / "whatsoup" / "fleet-tokens.json"
    token_file.parent.mkdir(parents=True)
    token_file.write_text('{"active":"fixture-active-token","accept":[]}\n', encoding="utf-8")
    token_file.chmod(0o600)
    linked_config = tmp_path / "linked-config"
    linked_config.symlink_to(real_config, target_is_directory=True)
    monkeypatch.delenv("BOT_ERRORS_DRY_FLEET_TOKEN_JSON", raising=False)
    monkeypatch.setenv("BOT_ERRORS_FLEET_TOKEN_FILE", str(linked_config / "whatsoup" / "fleet-tokens.json"))

    token, _source, _accept_count, error = _mod.load_fleet_api_token({})

    assert token is None
    assert error is not None
    assert error.startswith("token_parent_refused errno=")
    assert " depth=" in error
    assert any(f"errno={name}" in error for name in ("ELOOP", "ENOTDIR"))
    assert linked_config.name not in error


def test_load_fleet_api_token_refuses_fifo_without_blocking(monkeypatch, tmp_path):
    import signal

    token_file = tmp_path / "fleet-tokens.json"
    os.mkfifo(token_file, 0o600)
    monkeypatch.delenv("BOT_ERRORS_DRY_FLEET_TOKEN_JSON", raising=False)
    monkeypatch.setenv("BOT_ERRORS_FLEET_TOKEN_FILE", str(token_file))
    prior_handler = signal.getsignal(signal.SIGALRM)

    def timeout_handler(_signum, _frame):
        raise TimeoutError("FIFO open blocked")

    signal.signal(signal.SIGALRM, timeout_handler)
    try:
        signal.setitimer(signal.ITIMER_REAL, 1.0)
        token, _source, _accept_count, error = _mod.load_fleet_api_token({})
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior_handler)

    assert token is None
    assert error == "token_non_regular_refused"


def test_load_fleet_api_token_refuses_a_leaf_swapped_to_a_symlink(monkeypatch, tmp_path):
    token_file = tmp_path / "fleet-tokens.json"
    replacement = tmp_path / "replacement.json"
    token_file.write_text('{"active":"fixture-active-token","accept":[]}\n', encoding="utf-8")
    replacement.write_text('{"active":"replacement-token","accept":[]}\n', encoding="utf-8")
    token_file.chmod(0o600)
    replacement.chmod(0o600)
    real_open = os.open
    swapped = False

    def swapping_open(path, flags, mode=0o777, *, dir_fd=None):
        nonlocal swapped
        if path == token_file.name and dir_fd is not None and not swapped:
            swapped = True
            token_file.unlink()
            token_file.symlink_to(replacement)
        return real_open(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.delenv("BOT_ERRORS_DRY_FLEET_TOKEN_JSON", raising=False)
    monkeypatch.setenv("BOT_ERRORS_FLEET_TOKEN_FILE", str(token_file))
    monkeypatch.setattr(_mod.os, "open", swapping_open)

    token, _source, _accept_count, error = _mod.load_fleet_api_token({})

    assert swapped is True
    assert token is None
    assert error is not None
    assert error.startswith("token_symlink_refused")


def test_load_fleet_api_token_reads_from_the_validated_descriptor(monkeypatch, tmp_path):
    token_file = tmp_path / "fleet-tokens.json"
    moved_file = tmp_path / "opened-token.json"
    replacement = tmp_path / "replacement.json"
    token_file.write_text('{"active":"fixture-active-token","accept":[]}\n', encoding="utf-8")
    replacement.write_text('{"active":"replacement-token","accept":[]}\n', encoding="utf-8")
    token_file.chmod(0o600)
    replacement.chmod(0o600)
    real_open = os.open
    swapped = False

    def swapping_after_open(path, flags, mode=0o777, *, dir_fd=None):
        nonlocal swapped
        fd = real_open(path, flags, mode, dir_fd=dir_fd)
        if path == token_file.name and dir_fd is not None and not swapped:
            swapped = True
            token_file.rename(moved_file)
            replacement.rename(token_file)
        return fd

    monkeypatch.delenv("BOT_ERRORS_DRY_FLEET_TOKEN_JSON", raising=False)
    monkeypatch.setenv("BOT_ERRORS_FLEET_TOKEN_FILE", str(token_file))
    monkeypatch.setattr(_mod.os, "open", swapping_after_open)

    token, _source, _accept_count, error = _mod.load_fleet_api_token({})

    assert swapped is True
    assert token == "fixture-active-token"
    assert error is None


def test_read_fleet_token_requires_owner_read_permission(monkeypatch, tmp_path):
    real_open = os.open
    for mode in (0o000, 0o200):
        token_file = tmp_path / f"fleet-tokens-{mode:o}.json"
        token_file.write_text('{"active":"fixture-active-token","accept":[]}\n', encoding="utf-8")
        token_file.chmod(mode)

        def opening_then_restricting(path, flags, open_mode=0o777, *, dir_fd=None):
            if path != token_file.name or dir_fd is None:
                return real_open(path, flags, open_mode, dir_fd=dir_fd)
            token_file.chmod(0o600)
            fd = real_open(path, flags, open_mode, dir_fd=dir_fd)
            token_file.chmod(mode)
            return fd

        monkeypatch.setattr(_mod.os, "open", opening_then_restricting)
        raw, error = _mod.read_fleet_token_text(token_file)
        monkeypatch.setattr(_mod.os, "open", real_open)

        assert raw is None
        assert error == f"token_owner_read_required mode={mode:o}"


def test_required_credential_inventory_rejects_group_read_permissions(tmp_path):
    credential = tmp_path / "fleet-tokens.json"
    credential.write_text('{"active":"fixture-active-token","accept":[]}\n', encoding="utf-8")
    credential.chmod(0o440)

    lines = _mod.required_credential_inventory({"requiredCredentialFiles": [str(credential)]})

    assert len(lines) == 1
    assert lines[0].startswith("FAIL credential:")
    assert "mode=440" in lines[0]


# --- provider_credential_presence: mirror scoped and unscoped lookupCredential ordering ---
# 2026-06-23 fleet audit: provider keys live in ~/.config/whatsoup/credentials/<svc>.key (the file
# store unscoped lookupCredential consults before keyring, NOT the keychain, and NOT
# the ocw ~/.config/secrets/<svc>.env store. The health-check must check the .key store or it
# reports a runtime-resolvable key as missing (false negative — worst for glm, which has only
# glm.key). It must also try the glm->zai-api-key keyring migration the runtime uses.

class _FakeProc:
    def __init__(self, returncode: int, stdout: str) -> None:
        self.returncode = returncode
        self.stdout = stdout


def _arm_presence(monkeypatch, *, ocw_env_present, keychain_returncode, keychain_stdout, keyfile_present=False):
    keychain_calls = []
    keyfile_checks = []
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod, "service_env_var", lambda _service: "DEEPSEEK_API_KEY")
    monkeypatch.setattr(_mod, "dry_credential_status", lambda _service: None)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(_mod, "secret_file_has_service_key", lambda _service, _env_key: ocw_env_present)
    def fake_keyfile(service, source_env=None):
        assert source_env is None
        keyfile_checks.append(service)
        return keyfile_present

    def fake_run(*args, **kwargs):
        keychain_calls.append((args, kwargs))
        return _FakeProc(keychain_returncode, keychain_stdout)

    monkeypatch.setattr(_mod, "whatsoup_keyfile_present", fake_keyfile)
    monkeypatch.setattr(_mod.subprocess, "run", fake_run)
    return keychain_calls, keyfile_checks


def test_credential_presence_unscoped_keyfile_short_circuits_keychain(monkeypatch):
    keychain_calls, keyfile_checks = _arm_presence(
        monkeypatch,
        ocw_env_present=True,
        keychain_returncode=0,
        keychain_stdout="secret-value",
        keyfile_present=True,
    )
    present, source, status = _mod.provider_credential_presence("deepseek", 15)
    assert present is True
    assert source == "whatsoup_keyfile"
    assert status == "present"
    assert keyfile_checks == ["deepseek"]
    assert keychain_calls == []


def test_credential_presence_keyfile_resolves_when_keychain_empty(monkeypatch):
    # The .key file store is the runtime's first unscoped durable backend.
    _arm_presence(monkeypatch, ocw_env_present=False, keychain_returncode=1, keychain_stdout="", keyfile_present=True)
    present, source, status = _mod.provider_credential_presence("deepseek", 15)
    assert present is True
    assert source == "whatsoup_keyfile"
    assert status == "present"


def test_credential_presence_scoped_miss_excludes_unscoped_keyfile(monkeypatch):
    keychain_calls, keyfile_checks = _arm_presence(
        monkeypatch,
        ocw_env_present=False,
        keychain_returncode=1,
        keychain_stdout="",
        keyfile_present=True,
    )

    present, source, status = _mod.provider_credential_presence("deepseek", 15, user="bot")

    assert present is False
    assert source == "macos_keychain"
    assert status == "missing"
    assert keyfile_checks == []
    assert len(keychain_calls) == 1
    args, kwargs = keychain_calls[0]
    assert args[0] == ["security", "find-generic-password", "-s", "deepseek", "-a", "bot", "-w"]
    assert kwargs["timeout"] == 3


def test_credential_presence_scoped_env_is_checked_after_keychain_miss(monkeypatch):
    keychain_calls, keyfile_checks = _arm_presence(
        monkeypatch,
        ocw_env_present=False,
        keychain_returncode=1,
        keychain_stdout="",
        keyfile_present=True,
    )
    monkeypatch.setenv("DEEPSEEK_API_KEY", "scoped-env-value")

    present, source, status = _mod.provider_credential_presence("deepseek", 15, user="bot")

    assert present is True
    assert source == "env"
    assert status == "present"
    assert keyfile_checks == []
    assert len(keychain_calls) == 1


def test_credential_presence_scoped_darwin_alias_keeps_requested_user(monkeypatch):
    commands = []
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod, "service_env_var", lambda _service: "ZAI_API_KEY")
    monkeypatch.setattr(_mod, "dry_credential_status", lambda _service: None)
    monkeypatch.delenv("ZAI_API_KEY", raising=False)
    monkeypatch.setattr(_mod, "secret_file_has_service_key", lambda _service, _env_key: False)
    monkeypatch.setattr(
        _mod,
        "whatsoup_keyfile_present",
        lambda _service, _source_env=None: False,
    )

    def fake_run(cmd, *_args, **_kwargs):
        commands.append(cmd)
        if "zai-api-key" in cmd:
            return _FakeProc(0, "alias-secret")
        return _FakeProc(1, "")

    monkeypatch.setattr(_mod.subprocess, "run", fake_run)

    present, source, status = _mod.provider_credential_presence("glm", 15, user="bot")

    assert (present, source, status) == (True, "macos_keychain", "present")
    assert commands == [
        ["security", "find-generic-password", "-s", "glm", "-a", "bot", "-w"],
        ["security", "find-generic-password", "-s", "zai-api-key", "-a", "bot", "-w"],
    ]


def test_credential_presence_scoped_darwin_does_not_discover_local_account(monkeypatch):
    commands = []
    home_calls = []
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod, "service_env_var", lambda _service: "ZAI_API_KEY")
    monkeypatch.setattr(_mod, "dry_credential_status", lambda _service: None)
    monkeypatch.delenv("ZAI_API_KEY", raising=False)
    monkeypatch.delenv("USER", raising=False)
    monkeypatch.setattr(
        _mod,
        "whatsoup_keyfile_present",
        lambda _service, _source_env=None: False,
    )

    class PathProbe:
        @staticmethod
        def home():
            home_calls.append(True)
            return type("Home", (), {"name": "local-user"})()

    def fake_run(cmd, *_args, **_kwargs):
        commands.append(cmd)
        if "zai-api-key" in cmd:
            return _FakeProc(0, "alias-secret")
        return _FakeProc(1, "")

    monkeypatch.setattr(_mod, "Path", PathProbe)
    monkeypatch.setattr(_mod.subprocess, "run", fake_run)

    present, source, status = _mod.provider_credential_presence("glm", 15, user="bot")

    assert (present, source, status) == (True, "macos_keychain", "present")
    assert home_calls == []
    assert commands == [
        ["security", "find-generic-password", "-s", "glm", "-a", "bot", "-w"],
        ["security", "find-generic-password", "-s", "zai-api-key", "-a", "bot", "-w"],
    ]


def test_credential_presence_scoped_secret_tool_alias_keeps_requested_user(monkeypatch):
    commands = []
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "linux")
    monkeypatch.setattr(_mod.shutil, "which", lambda _command: "/usr/bin/secret-tool")
    monkeypatch.setattr(_mod, "service_env_var", lambda _service: "ZAI_API_KEY")
    monkeypatch.setattr(_mod, "dry_credential_status", lambda _service: None)
    monkeypatch.delenv("ZAI_API_KEY", raising=False)
    monkeypatch.setattr(_mod, "secret_file_has_service_key", lambda _service, _env_key: False)
    monkeypatch.setattr(
        _mod,
        "whatsoup_keyfile_present",
        lambda _service, _source_env=None: False,
    )

    def fake_run(cmd, *_args, **_kwargs):
        commands.append(cmd)
        if "zai-api-key" in cmd:
            return _FakeProc(0, "alias-secret")
        return _FakeProc(1, "")

    monkeypatch.setattr(_mod.subprocess, "run", fake_run)

    present, source, status = _mod.provider_credential_presence("glm", 15, user="bot")

    assert (present, source, status) == (True, "secret_tool", "present")
    assert commands == [
        ["secret-tool", "lookup", "service", "glm", "user", "bot"],
        ["secret-tool", "lookup", "service", "zai-api-key", "user", "bot"],
    ]


def test_credential_presence_ocw_env_only_is_not_provisioned(monkeypatch):
    # ocw .env present but no keychain and no .key store -> NOT runtime-resolvable; diagnostic only.
    _arm_presence(monkeypatch, ocw_env_present=True, keychain_returncode=1, keychain_stdout="", keyfile_present=False)
    present, source, status = _mod.provider_credential_presence("deepseek", 15)
    assert present is False
    assert source == "secret_file"
    assert status == "present_in_ocw_env_only_not_runtime_store"


def test_credential_presence_env_short_circuits(monkeypatch):
    _arm_presence(monkeypatch, ocw_env_present=True, keychain_returncode=1, keychain_stdout="", keyfile_present=True)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "live-from-process-env")
    present, source, status = _mod.provider_credential_presence("deepseek", 15)
    assert present is True
    assert source == "env"
    assert status == "present"


def test_credential_presence_missing_everywhere(monkeypatch):
    _arm_presence(monkeypatch, ocw_env_present=False, keychain_returncode=1, keychain_stdout="", keyfile_present=False)
    present, source, status = _mod.provider_credential_presence("deepseek", 15)
    assert present is False
    assert source == "macos_keychain"
    assert status == "missing"


def test_credential_presence_glm_resolves_via_zai_api_key_migration(monkeypatch):
    # glm's live key is stored under keyring service "zai-api-key" (SERVICE_KEYCHAIN_FALLBACKS),
    # exactly as lookupCredential's SERVICE_MIGRATION_FALLBACKS does.
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod, "service_env_var", lambda _service: "ZAI_API_KEY")
    monkeypatch.setattr(_mod, "dry_credential_status", lambda _service: None)
    monkeypatch.delenv("ZAI_API_KEY", raising=False)
    monkeypatch.setattr(_mod, "secret_file_has_service_key", lambda _service, _env_key: False)
    monkeypatch.setattr(
        _mod,
        "whatsoup_keyfile_present",
        lambda _service, _source_env=None: False,
    )

    def fake_run(cmd, *_a, **_k):
        # resolvable ONLY under the migration service name "zai-api-key"
        if "zai-api-key" in cmd:
            return _FakeProc(0, "glm-secret")
        return _FakeProc(1, "")

    monkeypatch.setattr(_mod.subprocess, "run", fake_run)
    present, source, status = _mod.provider_credential_presence("glm", 15)
    assert present is True
    assert source == "macos_keychain"
    assert status == "present"


# --- watchdog currency: detect stale pre-#952 (degraded-intolerant) watchdogs (2026-06-23 drift) ---

def test_classify_watchdog_policy_degraded_tolerant():
    assert _mod.classify_watchdog_policy('if status not in ("healthy", "degraded"):\n  restart') == "degraded_tolerant"


def test_classify_watchdog_policy_stale_is_intolerant():
    assert _mod.classify_watchdog_policy('if status != "healthy":\n  restart') == "degraded_intolerant"


def test_classify_watchdog_policy_unknown():
    assert _mod.classify_watchdog_policy("echo no restart decision here") == "unknown"


def test_canonical_watchdog_template_is_degraded_tolerant():
    # The SHIPPED template must stay #952-tolerant; guards against reintroducing the flap class.
    tmpl = Path(__file__).resolve().parents[2] / "templates" / "watchdog-script.sh"
    assert tmpl.is_file()
    assert _mod.classify_watchdog_policy(tmpl.read_text(encoding="utf-8")) == "degraded_tolerant"


def test_watchdog_currency_inventory_skips_non_darwin(monkeypatch):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "linux")
    assert _mod.watchdog_currency_inventory(["rb-bot"]) == []


def test_watchdog_currency_inventory_warns_on_stale(monkeypatch, tmp_path):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod.Path, "home", lambda: tmp_path)
    bindir = tmp_path / ".local" / "bin"
    bindir.mkdir(parents=True)
    (bindir / "rb-bot-watchdog").write_text('#!/bin/bash\nif status != "healthy":\n  restart\n')
    out = _mod.watchdog_currency_inventory(["rb-bot"])
    assert len(out) == 1
    assert out[0].startswith("WARN watchdog_currency rb-bot: stale_pre_952_watchdog")
    assert "remediation=redeploy_degraded_tolerant_watchdog_template" in out[0]


def test_watchdog_currency_inventory_clean_on_tolerant(monkeypatch, tmp_path):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod.Path, "home", lambda: tmp_path)
    bindir = tmp_path / ".local" / "bin"
    bindir.mkdir(parents=True)
    (bindir / "ad-bot-watchdog").write_text('#!/bin/bash\nif status not in ("healthy", "degraded"):\n  restart\n')
    assert _mod.watchdog_currency_inventory(["ad-bot"]) == []


def test_watchdog_currency_inventory_skips_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod.Path, "home", lambda: tmp_path)
    (tmp_path / ".local" / "bin").mkdir(parents=True)
    assert _mod.watchdog_currency_inventory(["yl-bot"]) == []


# --- governed runtime PATH prepend: probe/launcher binary-selection parity ---
#
# The launcher (deploy/whatsoup -> whatsoup_export_runtime_path) reads
# WHATSOUP_PATH_PREPEND out of the LaunchAgent environment; the probe composes
# the effective PATH itself. These tests pin that BOTH sides select the same
# binary, using two independent code paths: the launcher side shells out to the
# real helper, the probe side goes through effective_instance_provider_path +
# executable_candidate. BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH is deliberately
# unset -- setting it short-circuits the helper at :4322 and the comparison
# becomes vacuous.



def _assert_fail_line_is_path_free(line: str, *fixture_paths: Path) -> None:
    """A fail-closed FAIL line must carry no filesystem path, on EITHER platform.

    The basetemp spelling differs by platform -- macOS resolves the temp root
    through /private while Linux does not -- so an `in` check against a single
    spelling passes vacuously on the other one. That is exactly how the first
    version of this assertion went green on macOS and red on the Linux CI job,
    which is the platform the probe actually deploys to. Assert every spelling
    of each fixture path AND, decisively, that the line carries no path
    separator at all, which cannot pass vacuously anywhere.
    """
    for fixture in fixture_paths:
        raw = str(fixture)
        spellings = {raw, os.path.realpath(raw)}
        spellings.add(raw[len("/private"):] if raw.startswith("/private/") else f"/private{raw}")
        for spelling in spellings:
            assert spelling not in line, f"FAIL line leaks the fixture path {spelling}: {line}"
    assert "/" not in line, f"FAIL line carries a path separator: {line}"


def _write_shadow(directory: Path, name: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / name
    target.write_text("#!/bin/sh\nexit 0\n")
    target.chmod(0o755)
    return target


def _prepend_fixture(tmp_path: Path) -> dict[str, str]:
    """Synthetic instance environment as a governed plist would render it.

    PATH is `<prepend>:<ambient>` exactly as buildPlist composes it, and
    WHATSOUP_PATH_PREPEND carries the same governed prefix.
    """
    home = tmp_path / "home"
    prepend_bin = tmp_path / "pin" / "bin"
    ambient_bin = tmp_path / "ambient" / "bin"
    node_bin = tmp_path / "node" / "bin"
    (home / ".local" / "bin").mkdir(parents=True, exist_ok=True)
    prepend_bin.mkdir(parents=True, exist_ok=True)
    ambient_bin.mkdir(parents=True, exist_ok=True)
    _write_shadow(node_bin, "node")
    return {
        "HOME": str(home),
        "PATH": f"{prepend_bin}:{ambient_bin}:/usr/bin:/bin",
        "WHATSOUP_NODE": str(node_bin / "node"),
        "WHATSOUP_PATH_PREPEND": str(prepend_bin),
    }


def _launcher_resolved(command_name: str, environment: dict[str, str]) -> str:
    """Resolve a command the way the launcher does, through the real helper."""
    import subprocess

    helper = _mod.REPO_ROOT / "deploy" / "lib" / "runtime-path.sh"
    proc = subprocess.run(
        [
            "/bin/bash",
            "-c",
            # declare -F first: without it a removed or renamed helper would
            # leave the shell resolving "$3" from the AMBIENT PATH and the
            # parity assertion would pass while proving nothing.
            '. "$1"; declare -F whatsoup_export_runtime_path >/dev/null || { echo "helper missing" >&2; exit 9; }; '
            'whatsoup_export_runtime_path "$HOME" "$2" || exit 1; command -v "$3"',
            "runtime-path",
            str(helper),
            environment["WHATSOUP_NODE"],
            command_name,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=15,
        check=False,
        env=dict(environment),
    )
    assert proc.returncode == 0, f"launcher-side resolution failed: {proc.stderr}"
    resolved = proc.stdout.strip()
    assert resolved, "launcher-side resolution produced no path"
    return resolved


def _write_instance_plist(
    home: Path,
    name: str,
    environment: dict[str, str],
    *,
    nested_dict: bool = False,
    duplicate_path: str | None = None,
) -> Path:
    """Write a real LaunchAgent plist so the guarded reader is exercised for real.

    These fixtures drive instance_plist_environment itself, including its
    fail-closed shapes, and let assertions use the surviving map accessor.
    """
    agents = home / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    entries: list[str] = []
    if duplicate_path is not None:
        entries.append(f"    <key>PATH</key><string>{duplicate_path}</string>")
    for key, value in environment.items():
        entries.append(f"    <key>{key}</key><string>{value}</string>")
    if nested_dict:
        entries.append("    <key>Nested</key><dict><key>Inner</key><string>x</string></dict>")
    target = agents / f"com.whatsoup.{name}.plist"
    target.write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<plist version="1.0">',
                "<dict>",
                "  <key>Label</key>",
                f"  <string>com.whatsoup.{name}</string>",
                "  <key>KeepAlive</key>",
                "  <dict><key>Crashed</key><true/></dict>",
                "  <key>EnvironmentVariables</key>",
                "  <dict>",
                *entries,
                "  </dict>",
                "</dict>",
                "</plist>",
                "",
            ]
        )
    )
    return target


def _arm_darwin_host(monkeypatch, tmp_path: Path) -> None:
    # Clear EVERY environment affordance that would mark the governed surfaces
    # not-applicable. Without this the matrix below would silently stop testing
    # what it claims the moment one of these leaked in from the ambient
    # environment, which is the vacuity mode that made an earlier assertion in
    # this file pass on one platform and fail on the other.
    monkeypatch.delenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", raising=False)
    monkeypatch.delenv("BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT", raising=False)
    monkeypatch.delenv("BOT_ERRORS_DRY_PROVIDER_PROBE_RC", raising=False)
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod.Path, "home", classmethod(lambda cls: tmp_path))


def _arm_darwin_plist(monkeypatch, tmp_path: Path, name: str, environment: dict[str, str], **kwargs):
    _arm_darwin_host(monkeypatch, tmp_path)
    return _write_instance_plist(tmp_path, name, environment, **kwargs)


def test_probe_and_launcher_select_the_same_opencode_under_a_governed_prepend(
    monkeypatch, tmp_path
):
    monkeypatch.delenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", raising=False)
    environment = _prepend_fixture(tmp_path)
    prepend_bin = tmp_path / "pin" / "bin"
    local_bin = tmp_path / "home" / ".local" / "bin"
    # Shadow in BOTH: the governed pin and the auto-updating ~/.local/bin.
    _write_shadow(prepend_bin, "opencode")
    _write_shadow(local_bin, "opencode")

    effective = _mod.effective_instance_provider_path(environment)
    assert effective is not None, "effective provider PATH was not composed"
    # Vacuity guard: proves the shared helper actually ran rather than the
    # dry-run short circuit returning the inherited PATH unchanged.
    assert str(tmp_path / "node" / "bin") in effective

    probe_side = _mod.executable_candidate("opencode", effective)
    launcher_side = _launcher_resolved("opencode", environment)

    assert probe_side == str(prepend_bin / "opencode")
    assert probe_side == launcher_side


def test_claude_cli_probe_resolves_the_command_from_the_effective_provider_path(
    monkeypatch, tmp_path
):
    environment = _prepend_fixture(tmp_path)
    prepend_bin = tmp_path / "pin" / "bin"
    probe_bin = tmp_path / "probe" / "bin"
    _write_shadow(prepend_bin, "claude")
    _write_shadow(probe_bin, "claude")
    # Arm a synthetic plist under a temp HOME. Without this the test ran on the
    # real darwin home with no LaunchAgent, which is both a hygiene problem and
    # the exact unreadable-plist state that now fails closed.
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    # The probe process's OWN PATH carries a different claude; resolving from it
    # is exactly the defect under test.
    monkeypatch.setenv("PATH", f"{probe_bin}:/usr/bin:/bin")
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))

    captured: list[list[str]] = []

    def _fake_output(command, *args, **kwargs):
        captured.append(list(command))
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)

    _mod.provider_probe_target_inventory(
        {},
        {},
        "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli",
        "primary",
    )

    assert captured, "claude-cli probe never invoked the provider command"
    assert captured[0][0] == str(prepend_bin / "claude")
    assert captured[0][0] == _launcher_resolved("claude", environment)


def test_claude_cli_probe_keeps_an_explicit_operator_probe_command(monkeypatch, tmp_path):
    environment = _prepend_fixture(tmp_path)
    _write_shadow(tmp_path / "pin" / "bin", "claude")
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))

    captured: list[list[str]] = []

    def _fake_output(command, *args, **kwargs):
        captured.append(list(command))
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)

    _mod.provider_probe_target_inventory(
        {},
        {"providerProbeCommand": "/fixture/operator/bin/claude"},
        "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli",
        "primary",
    )

    assert captured, "claude-cli probe never invoked the provider command"
    assert captured[0][0] == "/fixture/operator/bin/claude"


def test_instance_provider_path_prepend_match_treats_both_absent_as_equal():
    assert _mod.instance_provider_path_prepend_match(None, None)
    assert _mod.instance_provider_path_prepend_match("", None)
    assert _mod.instance_provider_path_prepend_match(None, "")
    assert _mod.instance_provider_path_prepend_match("/fixture/pin/bin", "/fixture/pin/bin")
    assert not _mod.instance_provider_path_prepend_match("/fixture/pin/bin", None)
    assert not _mod.instance_provider_path_prepend_match(None, "/fixture/pin/bin")
    assert not _mod.instance_provider_path_prepend_match("/fixture/pin/bin", "/fixture/other/bin")


def test_instance_plist_environment_reads_every_governed_key(monkeypatch, tmp_path):
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": "/fixture/pin/bin:/usr/bin", "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin"},
    )
    environment = _mod.instance_plist_environment("agent-alpha")
    assert environment is not None
    assert environment["PATH"] == "/fixture/pin/bin:/usr/bin"
    assert environment["WHATSOUP_PATH_PREPEND"] == "/fixture/pin/bin"
    assert _mod.environment_value(environment, "WHATSOUP_PATH_PREPEND") == "/fixture/pin/bin"


def test_instance_plist_environment_fails_closed_on_a_nested_dict(monkeypatch, tmp_path):
    # The block regex stops at the first </dict>, so a nested dict would truncate
    # the map and make a declared key read as absent. Report unknown instead,
    # matching the TypeScript comparator's refusal.
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": "/fixture/pin/bin:/usr/bin", "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin"},
        nested_dict=True,
    )
    assert _mod.instance_plist_environment("agent-alpha") is None
    assert _mod.instance_provider_path("agent-alpha") is None


def test_instance_plist_environment_keeps_the_first_duplicate_key(monkeypatch, tmp_path):
    # The single-key re.search this reader replaced returned the FIRST match; a
    # hand-edited plist with two PATH keys must not resolve differently now.
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": "/fixture/second/bin"},
        duplicate_path="/fixture/first/bin",
    )
    assert _mod.instance_provider_path("agent-alpha") == "/fixture/first/bin"


def test_path_starts_with_entries_compares_whole_entries_including_empties():
    assert _mod.path_starts_with_entries("/fixture/pin/bin:/usr/bin", "/fixture/pin/bin")
    assert not _mod.path_starts_with_entries("/fixture/pin/binary:/usr/bin", "/fixture/pin/bin")
    assert _mod.path_starts_with_entries("/fixture/a/bin:/usr/bin", None)
    # Empty entries are compared, not filtered, so this agrees with
    # pathStartsWithEntries in src/fleet/launchd-env-drift.ts.
    assert not _mod.path_starts_with_entries("/a:/b:/usr/bin", "/a::/b")
    assert _mod.path_starts_with_entries("/a::/b:/usr/bin", "/a::/b")


def _opencode_probe_lines(monkeypatch, tmp_path, *, plist_environment, loaded_environment):
    _arm_darwin_plist(monkeypatch, tmp_path, "agent-alpha", plist_environment)
    monkeypatch.setattr(_mod, "instance_provider_path", lambda name: plist_environment.get("PATH"))
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(loaded_environment))
    monkeypatch.setattr(
        _mod, "effective_instance_provider_path", lambda environment: "/fixture/pin/bin:/usr/bin:/bin"
    )
    monkeypatch.setattr(
        _mod, "executable_candidate", lambda command, path_value=None: "/fixture/pin/bin/opencode"
    )
    # Stub the exec boundary so a probe that gets PAST every runtime-path check
    # reaches the version/help stage deterministically, without a real binary.
    monkeypatch.setattr(
        _mod,
        "provider_command_output",
        lambda command, *args, **kwargs: (
            "opencode 1.0.0\nusage: opencode run --format json --pure -m model\n", "", 0, False
        ),
    )
    return _mod.opencode_provider_probe_inventory(
        {},
        {},
        "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli", "model": "xai/grok-4"}},
        "opencode-cli",
    )


def test_opencode_probe_fails_when_the_loaded_job_lacks_the_declared_prepend(monkeypatch, tmp_path):
    lines = _opencode_probe_lines(
        monkeypatch,
        tmp_path,
        plist_environment={
            "PATH": "/fixture/pin/bin:/usr/bin:/bin",
            "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin",
        },
        loaded_environment={"PATH": "/fixture/pin/bin:/usr/bin:/bin", "HOME": "/fixture/user-root"},
    )
    assert "failure_class=provider_runtime_path_prepend_mismatch" in lines[0]
    assert "remediation=regenerate_and_reload_the_instance_launchagent" in lines[0]
    # A drifted launchctl print parser presents as this same class, and
    # regenerating would not fix that, so the remediation has to say so.
    assert "verify_launchctl_print_output_parses" in lines[0]


def test_opencode_probe_fails_when_the_declared_prepend_does_not_lead_its_own_path(monkeypatch, tmp_path):
    lines = _opencode_probe_lines(
        monkeypatch,
        tmp_path,
        plist_environment={
            "PATH": "/usr/bin:/bin",
            "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin",
        },
        loaded_environment={
            "PATH": "/usr/bin:/bin",
            "HOME": "/fixture/user-root",
            "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin",
        },
    )
    assert "failure_class=provider_runtime_path_prepend_inconsistent" in lines[0]


def test_opencode_probe_passes_the_prepend_checks_when_plist_and_job_agree(monkeypatch, tmp_path):
    lines = _opencode_probe_lines(
        monkeypatch,
        tmp_path,
        plist_environment={
            "PATH": "/fixture/pin/bin:/usr/bin:/bin",
            "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin",
        },
        loaded_environment={
            "PATH": "/fixture/pin/bin:/usr/bin:/bin",
            "HOME": "/fixture/user-root",
            "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin",
        },
    )
    joined = "\n".join(lines)
    assert "provider_runtime_path_prepend" not in joined
    # Positive companion: an absence-only assertion would also pass on an empty
    # return or an unrelated early exit, so prove the probe reached the stage
    # that only runs AFTER every runtime-path check has passed.
    assert lines, "probe returned no lines at all"
    assert "detected_mode=" in joined


def test_opencode_functional_probe_env_retains_the_governed_prepend():
    child = _mod.opencode_functional_probe_env(
        {"type": "agent", "agentOptions": {"provider": "opencode-cli"}},
        "primary",
        2,
        "/fixture/pin/bin:/fixture/user-root/.local/bin",
        "agent-alpha",
        None,
        {"PATH": "/fixture/pin/bin:/usr/bin", "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin"},
    )
    assert child.get("WHATSOUP_PATH_PREPEND") == "/fixture/pin/bin"


def test_governed_child_environment_retains_the_configured_claude_config_dir():
    # The per-instance config root is a claude-cli key, so it is asserted
    # against the claude-cli allowlist. Its absence from the opencode allowlist
    # is HIGH-1 and has its own rows below.
    child = _mod.governed_child_environment(
        "/fixture/pin/bin:/usr/bin",
        "agent-alpha",
        "/fixture/work",
        {
            "PATH": "/fixture/pin/bin:/usr/bin",
            "CLAUDE_CONFIG_DIR": "/fixture/config/agent-alpha",
        },
        env_keys=_mod.CLAUDE_FUNCTIONAL_ENV_KEYS,
    )

    assert child.get("CLAUDE_CONFIG_DIR") == "/fixture/config/agent-alpha"


def test_governed_child_environment_leaves_absent_claude_config_dir_absent():
    child = _mod.governed_child_environment(
        "/fixture/pin/bin:/usr/bin",
        "agent-alpha",
        "/fixture/work",
        {"PATH": "/fixture/pin/bin:/usr/bin"},
        env_keys=_mod.CLAUDE_FUNCTIONAL_ENV_KEYS,
    )

    assert "CLAUDE_CONFIG_DIR" not in child


def test_governed_child_environment_defaults_to_the_narrower_allowlist():
    """A caller that names no allowlist must get the common set, not a wide one.

    The default is the fail-closed direction: a probe added later without an
    explicit key set carries no provider-specific variable at all, rather than
    inheriting whichever provider needed the most.
    """
    child = _mod.governed_child_environment(
        "/fixture/pin/bin:/usr/bin",
        "agent-alpha",
        "/fixture/work",
        {
            "PATH": "/fixture/pin/bin:/usr/bin",
            "CLAUDE_CONFIG_DIR": "/fixture/config/agent-alpha",
        },
    )

    assert "CLAUDE_CONFIG_DIR" not in child
    assert child["PATH"] == "/fixture/pin/bin:/usr/bin"


def test_opencode_functional_probe_child_excludes_the_claude_config_root():
    """HIGH-1. The probe child must never be wider than the production child.

    buildOpenCodeBaseChildEnv (src/runtimes/agent/providers/child-env.ts) is a
    separate positive allowlist that admits no Claude auth or config variable.
    CLAUDE_CONFIG_DIR reached this probe only because one shared tuple served
    both providers.
    """
    child = _mod.opencode_functional_probe_env(
        {},
        "primary",
        2,
        "/fixture/pin/bin:/usr/bin",
        "agent-alpha",
        "/fixture/work",
        {
            "PATH": "/fixture/pin/bin:/usr/bin",
            "CLAUDE_CONFIG_DIR": "/fixture/config/agent-alpha",
        },
    )

    assert "CLAUDE_CONFIG_DIR" not in child
    # Vacuity guards: the allowlist ran and the governed keys still travel.
    assert child["PATH"] == "/fixture/pin/bin:/usr/bin"
    assert child["WHATSOUP_INSTANCE"] == "agent-alpha"


def test_the_two_probe_allowlists_differ_only_by_the_claude_config_root():
    """Pins the split itself, so a later key lands on a deliberate side.

    Stated precisely rather than as "never wider": the opencode probe child does
    carry WHATSOUP_PATH_PREPEND, which the production opencode child does not.
    That one is the point of the probe -- it proves PATH parity with the
    launcher -- and it is not an auth or config variable.
    """
    common = set(_mod.COMMON_FUNCTIONAL_ENV_KEYS)
    assert set(_mod.OPENCODE_FUNCTIONAL_ENV_KEYS) == common
    assert set(_mod.CLAUDE_FUNCTIONAL_ENV_KEYS) - common == {"CLAUDE_CONFIG_DIR"}
    assert "CLAUDE_CONFIG_DIR" not in common
    assert "WHATSOUP_PATH_PREPEND" in common


def test_default_provider_probe_child_keeps_the_claude_config_root(monkeypatch, tmp_path):
    """The other side of the split, through the real probe rather than the helper.

    Passes before and after: the split must not take the config root away from
    the provider that legitimately needs it.
    """
    environment = _matrix_environment(tmp_path)
    environment["CLAUDE_CONFIG_DIR"] = str(tmp_path / "config" / "agent-alpha")
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    seen: dict[str, object] = {}

    def _fake_output(command, *args, **kwargs):
        seen["child_env"] = kwargs.get("child_env")
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    _mod.provider_probe_target_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli", "primary",
    )

    child_env = seen.get("child_env")
    assert child_env is not None, "the probe never reached the provider spawn"
    assert child_env["CLAUDE_CONFIG_DIR"] == str(tmp_path / "config" / "agent-alpha")


def test_governed_child_environment_excludes_provider_credentials():
    child = _mod.governed_child_environment(
        "/fixture/pin/bin:/usr/bin",
        "agent-alpha",
        "/fixture/work",
        {
            "PATH": "/fixture/pin/bin:/usr/bin",
            "ANTHROPIC_API_KEY": "must-not-propagate",
            "OPENAI_API_KEY": "must-not-propagate",
        },
    )

    assert "ANTHROPIC_API_KEY" not in child
    assert "OPENAI_API_KEY" not in child


# --- claude-cli is the DEFAULT provider: it gets the same governed checks ---


def _claude_probe(monkeypatch, item, loaded_environment):
    captured: list[list[str]] = []

    def _fake_output(command, *args, **kwargs):
        captured.append(list(command))
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(loaded_environment))
    lines = _mod.provider_probe_target_inventory(
        {},
        item,
        "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli",
        "primary",
    )
    return captured, lines


def test_claude_cli_probe_fails_when_the_loaded_job_lacks_the_declared_prepend(monkeypatch, tmp_path):
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": "/fixture/pin/bin:/usr/bin", "WHATSOUP_PATH_PREPEND": "/fixture/pin/bin"},
    )
    captured, lines = _claude_probe(
        monkeypatch,
        {"providerProbeCommand": "/fixture/operator/bin/claude"},
        {"PATH": "/fixture/pin/bin:/usr/bin", "HOME": str(tmp_path)},
    )
    assert not captured, "probe must fail closed before invoking the provider"
    assert "failure_class=provider_runtime_path_prepend_mismatch" in lines[0]
    assert "verify_launchctl_print_output_parses" in lines[0]
    _assert_fail_line_is_path_free(lines[0], tmp_path)


def test_claude_cli_probe_fails_closed_when_the_plist_exists_but_the_job_environment_is_unreadable(
    monkeypatch, tmp_path
):
    # launchctl print failed or the job is unloaded: the effective provider PATH
    # cannot be composed. Falling back to the probe's own PATH here is the
    # pre-fix defect, so this must fail closed instead.
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": "/fixture/pin/bin:/usr/bin"},
    )
    captured, lines = _claude_probe(monkeypatch, {}, {})
    assert not captured, "probe must fail closed before invoking the provider"
    assert "failure_class=provider_runtime_path_unavailable" in lines[0]
    assert "reason=effective_path_uncomposable" in lines[0]
    assert "remediation=repair_the_shared_runtime_path_helper_and_node_pin" in lines[0]
    # Mirror of the no-claude case: the other cause of the same class must be
    # equally path-free, or the redaction fix would only cover one branch.
    _assert_fail_line_is_path_free(lines[0], tmp_path)


def test_claude_cli_probe_is_unchanged_on_a_host_with_no_launchagent(monkeypatch, tmp_path):
    # Linux/systemd hosts render no plist. instance_plist_governed_environment is
    # None there, so the legacy resolution chain must stay byte-identical and no
    # new failure class may appear. This pins the change as a provable no-op.
    monkeypatch.delenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", raising=False)
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "linux")
    monkeypatch.setattr(_mod.Path, "home", classmethod(lambda cls: tmp_path))
    probe_bin = tmp_path / "probe" / "bin"
    _write_shadow(probe_bin, "claude")
    monkeypatch.setenv("PATH", f"{probe_bin}:/usr/bin:/bin")

    captured, lines = _claude_probe(monkeypatch, {}, {})

    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_NOT_APPLICABLE,
        None,
    )
    assert captured, "probe must still run on a host with no LaunchAgent"
    assert captured[0][0] == str(probe_bin / "claude")
    assert "provider_runtime_path_prepend" not in "\n".join(lines)
    assert "provider_runtime_path_unavailable" not in "\n".join(lines)


def test_claude_cli_probe_passes_the_prepend_checks_when_plist_and_job_agree(monkeypatch, tmp_path):
    environment = _prepend_fixture(tmp_path)
    prepend_bin = tmp_path / "pin" / "bin"
    _write_shadow(prepend_bin, "claude")
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    captured, lines = _claude_probe(monkeypatch, {}, environment)

    assert captured, "probe never invoked the provider command"
    assert captured[0][0] == str(prepend_bin / "claude")
    assert "provider_runtime_path_prepend" not in "\n".join(lines)


def test_claude_cli_probe_fails_closed_when_the_governed_path_holds_no_claude(monkeypatch, tmp_path):
    # False-green on the DEFAULT provider: the effective PATH composes fine, but
    # it holds no claude. executable_candidate returns None rather than widening
    # when given a real path, so the old code fell through to shutil.which and
    # reported status=ok naming an ambient binary the service cannot execute.
    # opencode fails closed under the identical fixture; this closes the asymmetry.
    environment = _prepend_fixture(tmp_path)
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    # Deliberately OUTSIDE every directory the governed composition can see:
    # not the prepend, not ~/.local/bin, not the pinned node dir, not the plist
    # PATH. This is the npm-global / Homebrew / scheduler-PATH shape.
    probe_only_bin = tmp_path / "probe-only" / "bin"
    _write_shadow(probe_only_bin, "claude")
    monkeypatch.setenv("PATH", f"{probe_only_bin}:/usr/bin:/bin")

    # Preconditions that make this the exact reported shape, asserted so the
    # test cannot pass for an unrelated reason.
    effective = _mod.effective_instance_provider_path(environment)
    assert effective is not None, "fixture must compose an effective PATH"
    assert _mod.executable_candidate("claude", effective) is None, "fixture must have no claude on the governed PATH"
    assert _mod.shutil.which("claude") == str(probe_only_bin / "claude")

    captured, lines = _claude_probe(monkeypatch, {}, environment)

    assert not captured, "probe must not execute a binary absent from the governed PATH"
    assert "failure_class=provider_runtime_path_unavailable" in lines[0]
    assert "reason=no_claude_on_governed_path" in lines[0]
    _assert_fail_line_is_path_free(lines[0], probe_only_bin, tmp_path)


# --- MED-3: every unreadable-plist state must fail closed on the DEFAULT provider ---
#
# The parser returns None for six distinct broken states, and the governed-
# environment wrapper returned that same None for the two BENIGN states (Linux,
# dry-run). Both callers read None as "no failure", so on macOS a missing,
# planted, corrupt or unreadable LaunchAgent made the default provider report
# green while opencode failed closed on the identical fixture. The parser's own
# docstring says None means UNKNOWN. These rows pin the asymmetry closed.


def _break_plist(target: Path, state: str, home: Path) -> None:
    """Put the instance plist into one named broken state. Synthetic HOME only."""
    if state == "missing":
        target.unlink()
    elif state == "wrong_label":
        target.write_text(target.read_text().replace("com.whatsoup.agent-alpha", "com.other.agent-alpha"))
    elif state == "nested_dict":
        target.write_text(
            target.read_text().replace(
                "  </dict>\n</dict>",
                "    <key>Nested</key><dict><key>Inner</key><string>x</string></dict>\n  </dict>\n</dict>",
                1,
            )
        )
    elif state == "oversized":
        target.write_text(target.read_text() + ("<!-- " + "x" * 70000 + " -->\n"))
    elif state == "symlinked":
        real = home / "real-agent.plist"
        real.write_text(target.read_text())
        target.unlink()
        target.symlink_to(real)
    elif state == "unreadable":
        target.chmod(0o000)
    else:
        raise AssertionError(f"unknown state {state}")


PLIST_BREAKAGE_STATES = ["missing", "wrong_label", "nested_dict", "oversized", "symlinked", "unreadable"]


def _matrix_environment(tmp_path: Path) -> dict[str, str]:
    environment = _prepend_fixture(tmp_path)
    _write_shadow(tmp_path / "pin" / "bin", "claude")
    _write_shadow(tmp_path / "pin" / "bin", "opencode")
    return environment


# --- MED-7: the plist readers must match the dict ELEMENT, not one spelling ---
#
# Both readers matched the literal "<dict>". Every other legal spelling of the
# same element slipped past the nested-dict guard while still truncating the
# block at the first "</dict>", so a governed key declared AFTER a nested dict
# read as ABSENT rather than as unknown. Absent on both sides is the benign
# prepend cell, so the probe reported ok and spawned the provider where the
# well-formed plist fails closed.
#
# Fixture shape matters: the existing helpers append their nested dict LAST, so
# every governed key is already parsed before the truncation point and the
# fail-open cannot show. These fixtures put the nested dict BEFORE the prepend.

NESTED_DICT_SPELLINGS = ["<dict>", "<dict >", "<dict\n    >", '<dict class="x">', "<dict/>"]
OUTER_DICT_SPELLINGS = ["<dict>", "<dict >", "<dict\n  >", '<dict class="x">']


def _write_plist_with_dict_spellings(
    home: Path,
    name: str,
    *,
    outer_spelling: str = "<dict>",
    nested_spelling: str | None = None,
    environment: dict[str, str] | None = None,
    extra_entries: list[str] | None = None,
    trailing_environment: dict[str, str] | None = None,
) -> Path:
    """Instance plist whose EnvironmentVariables dict tokens are spelled verbatim.

    `trailing_environment` is written after the nested dict and any extra
    markup on purpose -- that is the only position from which a governed key can
    be lost to a truncated block, and it is the position the shipped fixtures
    never exercised.
    """
    agents = home / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    entries: list[str] = []
    for key, value in (environment or {}).items():
        entries.append(f"    <key>{key}</key><string>{value}</string>")
    entries.extend(extra_entries or [])
    if nested_spelling is not None:
        if nested_spelling.endswith("/>"):
            entries.append(f"    <key>Nested</key>{nested_spelling}")
        else:
            entries.append(
                f"    <key>Nested</key>{nested_spelling}<key>Inner</key><string>x</string></dict>"
            )
    for key, value in (trailing_environment or {}).items():
        entries.append(f"    <key>{key}</key><string>{value}</string>")
    environment_block = (
        [f"  {outer_spelling}"]
        if outer_spelling.endswith("/>")
        else [f"  {outer_spelling}", *entries, "  </dict>"]
    )
    target = agents / f"com.whatsoup.{name}.plist"
    target.write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<plist version="1.0">',
                "<dict>",
                "  <key>Label</key>",
                f"  <string>com.whatsoup.{name}</string>",
                "  <key>KeepAlive</key>",
                "  <dict><key>Crashed</key><true/></dict>",
                "  <key>EnvironmentVariables</key>",
                *environment_block,
                "</dict>",
                "</plist>",
                "",
            ]
        )
    )
    return target


@pytest.mark.parametrize("nested_spelling", NESTED_DICT_SPELLINGS)
def test_plist_reader_fails_closed_on_every_nested_dict_spelling(
    monkeypatch, tmp_path, nested_spelling
):
    environment = _matrix_environment(tmp_path)
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_dict_spellings(
        tmp_path,
        "agent-alpha",
        nested_spelling=nested_spelling,
        environment={"PATH": environment["PATH"]},
        trailing_environment={
            "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]
        },
    )

    assert _mod.instance_plist_environment("agent-alpha") is None, (
        "a nested dict truncates the map, so the reader must report unknown"
    )
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_UNREADABLE,
        None,
    )


@pytest.mark.parametrize("nested_spelling", ["<dict>", "<dict >"])
def test_default_provider_probe_does_not_spawn_when_a_nested_dict_hides_the_prepend(
    monkeypatch, tmp_path, nested_spelling
):
    """The operator-visible half of MED-7, and a parity assertion.

    Both spellings name the same element, so both must produce the same class.
    The "<dict>" row is the control that proves the fixture reaches the code;
    the "<dict >" row is the one that spawned the provider before the fix,
    because the hidden WHATSOUP_PATH_PREPEND matched the loaded job's absent one.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_dict_spellings(
        tmp_path,
        "agent-alpha",
        nested_spelling=nested_spelling,
        environment={"PATH": environment["PATH"]},
        trailing_environment={
            "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]
        },
    )
    loaded_environment = dict(environment)
    # The pre-migration loaded job carries no governed prepend. Paired with a
    # prepend the reader lost, that is the benign absent/absent cell.
    loaded_environment.pop("WHATSOUP_PATH_PREPEND")

    captured, lines = _claude_probe(monkeypatch, {}, loaded_environment)

    assert not captured, "the probe must not spawn the provider on an unreadable plist"
    assert "failure_class=provider_runtime_plist_unreadable" in lines[0]
    _assert_fail_line_is_path_free(lines[0], tmp_path)


@pytest.mark.parametrize("outer_spelling", OUTER_DICT_SPELLINGS)
def test_plist_reader_accepts_every_environment_dict_spelling(
    monkeypatch, tmp_path, outer_spelling
):
    """The other direction: a valid plist must not be called unreadable.

    Matching the literal "<dict>" made these fail CLOSED, which is safe but
    misnames the operator's problem: the plist is fine.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_dict_spellings(
        tmp_path,
        "agent-alpha",
        outer_spelling=outer_spelling,
        environment={
            "PATH": environment["PATH"],
            "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"],
        },
    )

    assert _mod.instance_plist_environment("agent-alpha") == {
        "PATH": environment["PATH"],
        "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"],
    }


def test_plist_reader_reads_a_self_closing_environment_dict_as_empty(monkeypatch, tmp_path):
    """`<dict/>` is a well-formed EMPTY map, not an unreadable plist.

    The reader now says readable-with-nothing-in-it, and the governed-PATH
    absence check names the real problem. Both states fail the probe closed; only
    the class changes.
    """
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_dict_spellings(tmp_path, "agent-alpha", outer_spelling="<dict/>")

    assert _mod.instance_plist_environment("agent-alpha") == {}
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_READABLE,
        {},
    )


def test_plist_reader_does_not_let_intervening_markup_swallow_a_governed_key(
    monkeypatch, tmp_path
):
    """The key/value pair regex must not span markup.

    A dotted non-greedy key group walked THROUGH an unrelated element and
    matched one bogus pair whose key was the whole run and whose value belonged
    to the next real key -- so WHATSOUP_PATH_PREPEND read as absent from a plist
    that declares it, with no nested dict involved.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_dict_spellings(
        tmp_path,
        "agent-alpha",
        environment={"PATH": environment["PATH"]},
        extra_entries=["    <key>KeepAliveHint</key><data>eA==</data>"],
        trailing_environment={
            "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]
        },
    )

    parsed = _mod.instance_plist_environment("agent-alpha")
    assert parsed is not None, "no nested dict here: the plist is readable"
    assert parsed.get("PATH") == environment["PATH"]
    assert parsed.get("WHATSOUP_PATH_PREPEND") == environment["WHATSOUP_PATH_PREPEND"]
    # The non-string element contributes no pair at all rather than a bogus one.
    assert "KeepAliveHint" not in parsed
    assert sorted(parsed) == ["PATH", "WHATSOUP_PATH_PREPEND"]



@pytest.mark.parametrize("generated_path", [None, ""])
def test_default_provider_probe_fails_closed_when_readable_plist_has_no_governed_path(
    monkeypatch, tmp_path, generated_path
):
    loaded_environment = _matrix_environment(tmp_path)
    loaded_environment.pop("WHATSOUP_PATH_PREPEND")
    plist_environment = {"HOME": str(tmp_path / "home")}
    if generated_path is not None:
        plist_environment["PATH"] = generated_path
    _arm_darwin_plist(monkeypatch, tmp_path, "agent-alpha", plist_environment)

    captured, lines = _claude_probe(monkeypatch, {}, loaded_environment)

    assert not captured, "probe must fail before invoking the provider"
    assert "failure_class=provider_runtime_path_unavailable" in lines[0]
    assert "reason=generated_path_absent" in lines[0]
    _assert_fail_line_is_path_free(lines[0], tmp_path)


@pytest.mark.parametrize("generated_path", [None, ""])
def test_opencode_probe_fails_closed_when_readable_plist_has_no_governed_path(
    monkeypatch, tmp_path, generated_path
):
    loaded_environment = _matrix_environment(tmp_path)
    loaded_environment.pop("WHATSOUP_PATH_PREPEND")
    plist_environment = {"HOME": str(tmp_path / "home")}
    if generated_path is not None:
        plist_environment["PATH"] = generated_path
    _arm_darwin_plist(monkeypatch, tmp_path, "agent-alpha", plist_environment)
    monkeypatch.setattr(
        _mod,
        "loaded_instance_environment",
        lambda _name: dict(loaded_environment),
    )
    captured: list[list[str]] = []

    def _fake_output(command, *args, **kwargs):
        captured.append(list(command))
        return ("opencode 1.0.0", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)

    lines = _mod.opencode_provider_probe_inventory(
        {},
        {},
        "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli"}},
        "opencode-cli",
    )

    assert not captured, "probe must fail before invoking the provider"
    assert "failure_class=provider_runtime_path_unavailable" in lines[0]
    assert "reason=generated_path_absent" in lines[0]
    _assert_fail_line_is_path_free(lines[0], tmp_path)


def test_opencode_probe_uses_one_generated_environment_snapshot_during_atomic_replacement(
    monkeypatch,
):
    old_environment = {
        "PATH": "/fixture/old/bin:/usr/bin",
        "WHATSOUP_PATH_PREPEND": "/fixture/old/bin",
    }
    new_environment = {
        "PATH": "/fixture/new/bin:/usr/bin",
        "WHATSOUP_PATH_PREPEND": "/fixture/new/bin",
    }
    reads: list[dict[str, str]] = []

    def _changing_plist(_name):
        environment = old_environment if not reads else new_environment
        reads.append(dict(environment))
        return dict(environment)

    monkeypatch.delenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", raising=False)
    monkeypatch.delenv("BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT", raising=False)
    monkeypatch.delenv("BOT_ERRORS_DRY_PROVIDER_PROBE_RC", raising=False)
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod, "instance_plist_environment", _changing_plist)
    monkeypatch.setattr(
        _mod,
        "loaded_instance_environment",
        lambda _name: {
            **old_environment,
            "HOME": "/fixture/home",
            "WHATSOUP_NODE": "/fixture/node/bin/node",
        },
    )
    monkeypatch.setattr(
        _mod,
        "effective_instance_provider_path",
        lambda _environment: old_environment["PATH"],
    )
    monkeypatch.setattr(
        _mod,
        "executable_candidate",
        lambda _command, _path=None: "/fixture/old/bin/opencode",
    )
    captured: list[list[str]] = []

    def _fake_output(command, *args, **kwargs):
        captured.append(list(command))
        return (
            "opencode 1.0.0\nusage: opencode run --format json --pure -m model\n",
            "",
            0,
            False,
        )

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)

    lines = _mod.opencode_provider_probe_inventory(
        {},
        {},
        "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli"}},
        "opencode-cli",
    )

    assert reads == [old_environment]
    assert captured, "a coherent generated snapshot must reach the provider boundary"
    assert "provider_runtime_path_prepend_mismatch" not in "\n".join(lines)


def test_default_provider_probe_healthy_plist_control_row(monkeypatch, tmp_path):
    # Control: with a readable plist whose loaded job disagrees, the default
    # provider already fails closed. Without this row the six broken rows below
    # could pass for a reason unrelated to plist readability.
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    # Loaded job AGREES on the prepend so the prepend check passes and the
    # runtime-path gate is what refuses; it carries no PATH, so the effective
    # PATH cannot compose.
    captured, lines = _claude_probe(
        monkeypatch, {}, {"WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]}
    )
    assert not captured
    assert "failure_class=provider_runtime_path_unavailable" in lines[0]
    assert "reason=effective_path_uncomposable" in lines[0]


@pytest.mark.parametrize("state", PLIST_BREAKAGE_STATES)
def test_default_provider_probe_fails_closed_on_every_unreadable_plist_state(monkeypatch, tmp_path, state):
    environment = _matrix_environment(tmp_path)
    target = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    _break_plist(target, state, tmp_path)
    assert _mod.instance_plist_environment("agent-alpha") is None, f"{state}: fixture must be unreadable"

    captured, lines = _claude_probe(monkeypatch, {}, dict(environment))

    # Assert the REFUSAL REASON, not merely that something failed: a status-only
    # assertion passes when an unrelated validator refuses for another cause.
    assert not captured, f"{state}: probe must not run a provider it cannot vouch for"
    assert "failure_class=provider_runtime_plist_unreadable" in lines[0], f"{state}: {lines[0]}"
    _assert_fail_line_is_path_free(lines[0], tmp_path)


@pytest.mark.parametrize("state", PLIST_BREAKAGE_STATES)
def test_opencode_probe_also_fails_closed_on_every_unreadable_plist_state(monkeypatch, tmp_path, state):
    # Parity rows: opencode already failed closed on all six. Pinning it here
    # means a future change cannot restore the asymmetry from either side.
    environment = _matrix_environment(tmp_path)
    target = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    _break_plist(target, state, tmp_path)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))

    lines = _mod.opencode_provider_probe_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli", "model": "xai/grok-4"}},
        "opencode-cli",
    )
    assert lines[0].startswith("FAIL provider_probe"), f"{state}: {lines[0]}"
    assert "failure_class=provider_runtime_path_" in lines[0], f"{state}: {lines[0]}"


def test_default_provider_probe_stays_benign_when_there_is_no_launchagent_surface(monkeypatch, tmp_path):
    # The two BENIGN states must NOT be swept into the fail-closed change:
    # a Linux host has no plist by design, and the dry-run override is a test
    # affordance. This is the regression guard for the fix's blast radius.
    environment = _matrix_environment(tmp_path)
    monkeypatch.delenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", raising=False)
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "linux")
    monkeypatch.setattr(_mod.Path, "home", classmethod(lambda cls: tmp_path))
    state, env = _mod.instance_plist_governed_environment("agent-alpha")
    assert (state, env) == (_mod.GOVERNED_PLIST_NOT_APPLICABLE, None)

    captured, lines = _claude_probe(monkeypatch, {}, dict(environment))
    assert captured, "a host with no LaunchAgent surface must still probe"
    assert "provider_runtime_plist_unreadable" not in "\n".join(lines)


def test_default_provider_probe_gate_applies_even_with_an_operator_probe_command(monkeypatch, tmp_path):
    # MED-2 negative control. The runtime-path gate is a statement about the
    # SERVICE's PATH, so an operator override picks WHICH binary is probed but
    # must not exempt the service from the gate. Before the hoist the gate lived
    # inside `if not command:` and an override reported status=ok here.
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    captured, lines = _claude_probe(
        monkeypatch,
        {"providerProbeCommand": "/fixture/operator/bin/claude"},
        {"WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    assert not captured, "an override must not exempt the service PATH from the gate"
    assert "failure_class=provider_runtime_path_unavailable" in lines[0]
    assert "reason=effective_path_uncomposable" in lines[0]


def test_default_provider_probe_runs_the_provider_in_the_governed_environment(monkeypatch, tmp_path):
    # MED-1. The binary is chosen from the governed PATH, so it must also RUN
    # under that PATH. Passing no child environment meant a `#!/usr/bin/env node`
    # wrapper resolved its interpreter from the probe's PATH, exercising the
    # right executable under the wrong node or config root.
    environment = _matrix_environment(tmp_path)
    prepend_bin = tmp_path / "pin" / "bin"
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    seen: dict[str, object] = {}

    def _fake_output(command, *args, **kwargs):
        seen["command"] = list(command)
        seen["child_env"] = kwargs.get("child_env")
        seen["child_cwd"] = kwargs.get("child_cwd")
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    _mod.provider_probe_target_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli", "primary",
    )

    assert seen.get("command", [None])[0] == str(prepend_bin / "claude")
    child_env = seen.get("child_env")
    assert child_env is not None, "the provider must not run in the probe's own environment"
    # The environment key that decides interpreter and binary resolution.
    effective = _mod.effective_instance_provider_path(environment)
    assert child_env["PATH"] == effective
    assert child_env["PATH"].split(":")[0] == str(prepend_bin)
    assert child_env.get("WHATSOUP_PATH_PREPEND") == environment["WHATSOUP_PATH_PREPEND"]
    # The working directory is pinned by its own test below: the probe is given
    # an explicit one, and it is NOT the instance workspace.
    assert seen.get("child_cwd"), "the probe must be given an explicit working directory"


def test_default_provider_probe_runs_outside_the_instance_agent_workspace(monkeypatch, tmp_path):
    """MED-2. An unattended diagnostic must not inherit the agent's permissions.

    The probe used to spawn the provider with cwd = the instance workspace and a
    WHATSOUP_MCP_SOCKET synthesized from that same directory. The workspace
    carries the agent's own project-local settings surface (written by
    src/core/settings-template.ts with a permissive default mode and tool
    allowances), so a one-shot diagnostic adopted them and was handed the
    instance's tool socket.

    Nothing the probe checks needs that directory: the binary is resolved to an
    absolute path out of the governed PATH before the spawn, and PATH parity
    travels in the child environment. So the probe runs from a fresh directory
    it owns.

    Residual, stated so this is not mistaken for isolation: HOME still comes from
    the governed environment, so user-level settings under that HOME still apply.
    What this removes is the project-local surface and the socket.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    # A populated workspace, so "the probe directory is empty" discriminates
    # between the two directories instead of holding trivially.
    (workspace / "workspace-marker").write_text("x")
    config = {
        "type": "agent",
        "agentOptions": {"provider": "claude-cli", "cwd": str(workspace)},
    }
    seen: dict[str, object] = {}

    def _fake_output(command, *args, **kwargs):
        # Read the directory from INSIDE the call: the probe owns it through a
        # context manager, so it is gone by the time the inventory returns and an
        # assertion made afterwards would report a cleaned-up directory as an
        # implementation bug.
        cwd = kwargs.get("child_cwd")
        seen["child_cwd"] = cwd
        seen["cwd_is_dir"] = bool(cwd) and Path(cwd).is_dir()
        seen["cwd_entries"] = (
            sorted(entry.name for entry in Path(cwd).iterdir())
            if cwd and Path(cwd).is_dir()
            else None
        )
        seen["child_env"] = kwargs.get("child_env")
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    _mod.provider_probe_target_inventory({}, {}, "agent-alpha", config, "claude-cli", "primary")

    # Vacuity guard: the probe reached the spawn rather than failing closed first.
    assert seen, "the probe never reached the provider spawn"
    assert _mod.agent_workspace_cwd(config, "agent-alpha") == str(workspace)
    assert seen["child_cwd"] != str(workspace), "the probe must not run in the agent workspace"
    assert seen["cwd_is_dir"], "the probe must be given a real directory"
    assert seen["cwd_entries"] == [], "the probe directory must be fresh, not a populated one"
    # Positive control on the same call: the governed environment still travels.
    child_env = seen["child_env"]
    assert child_env is not None
    assert child_env["PATH"] == _mod.effective_instance_provider_path(environment)
    assert child_env["WHATSOUP_INSTANCE"] == "agent-alpha"


def test_default_provider_probe_child_carries_no_synthesized_mcp_socket(monkeypatch, tmp_path):
    """MED-2 negative control, asserted on its own so it cannot hide behind the cwd row.

    The probe SYNTHESIZED a WHATSOUP_MCP_SOCKET from the workspace it was about
    to run in, handing an unattended diagnostic the instance's tool socket. No
    check in this inventory reads the socket.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    config = {
        "type": "agent",
        "agentOptions": {"provider": "claude-cli", "cwd": str(workspace)},
    }
    seen: dict[str, object] = {}

    def _fake_output(command, *args, **kwargs):
        seen["child_env"] = kwargs.get("child_env")
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    _mod.provider_probe_target_inventory({}, {}, "agent-alpha", config, "claude-cli", "primary")

    child_env = seen.get("child_env")
    assert child_env is not None, "the probe never reached the provider spawn"
    assert "WHATSOUP_MCP_SOCKET" not in child_env, (
        "a diagnostic must not be handed the instance's tool socket"
    )
    # Vacuity guard: the allowlist still produced a populated environment.
    assert child_env["PATH"] == _mod.effective_instance_provider_path(environment)


def test_only_the_opencode_probe_gates_generated_against_loaded_path(monkeypatch, tmp_path):
    """S1. Pins the asymmetry the module comment and docs now describe.

    `instance_provider_path_match` has ONE call site, in the opencode inventory.
    The comment above the default-provider branch used to claim claude-cli got
    "the same governed PATH and prepend checks", and docs/configuration.md said
    both PATH steps ran for both providers. Neither was true of the
    generated-vs-loaded EQUALITY gate.

    This is a characterization pin, not a red-first row: it passes before and
    after, which is exactly what makes it evidence that narrowing the prose was
    the correct half of the either/or rather than adding the gate.

    One fixture, both providers: a generated PATH that differs from the loaded
    one while still leading with the governed prepend, so the prepend checks
    agree and only the equality gate can separate the two probes.
    """
    environment = _matrix_environment(tmp_path)
    prepend_bin = tmp_path / "pin" / "bin"
    generated_path = f"{prepend_bin}:/usr/bin"
    assert generated_path != environment["PATH"], "the fixture must actually differ"
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {
            "PATH": generated_path,
            "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"],
        },
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    captured: list[list[str]] = []

    def _fake_output(command, *args, **kwargs):
        captured.append(list(command))
        return ("OK", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)

    opencode_lines = _mod.opencode_provider_probe_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli"}},
        "opencode-cli",
    )
    assert "failure_class=provider_runtime_path_mismatch" in opencode_lines[0]

    claude_lines = _mod.provider_probe_target_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli", "primary",
    )
    joined = "\n".join(claude_lines)
    assert "provider_runtime_path_mismatch" not in joined
    # Vacuity guard: the default provider reached the spawn on the same fixture
    # rather than failing closed for some unrelated reason.
    assert captured and captured[-1][0] == str(prepend_bin / "claude")


def test_opencode_functional_probe_still_runs_in_the_instance_workspace(monkeypatch, tmp_path):
    """Control for the change above: the opencode probe is deliberately untouched.

    Its functional probe drives a real session that reads the instance's own
    context, so it keeps both the workspace cwd and the socket. Without this row,
    dropping them for the default provider could silently spread.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    config = {
        "type": "agent",
        "agentOptions": {"provider": "opencode-cli", "cwd": str(workspace)},
    }
    seen: dict[str, object] = {}

    def _fake_output(command, *args, **kwargs):
        seen["child_cwd"] = kwargs.get("child_cwd")
        seen["child_env"] = kwargs.get("child_env")
        return ("opencode 1.0.0", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    _mod.opencode_provider_probe_inventory({}, {}, "agent-alpha", config, "opencode-cli")

    assert seen, "the opencode probe never reached the provider spawn"
    assert seen["child_cwd"] == str(workspace)
    child_env = seen["child_env"]
    assert child_env is not None
    socket_path = child_env.get("WHATSOUP_MCP_SOCKET")
    assert socket_path is not None, "the opencode probe keeps its synthesized socket"
    assert socket_path.startswith(f"{workspace}/")
    assert socket_path.endswith("whatsoup.sock")


def test_governed_checks_apply_when_no_dry_affordance_is_set(monkeypatch, tmp_path):
    """Named pin for the environment affordances that switch the checks off.

    Two environment variables mark the governed surfaces not-applicable: the
    dry-run PATH override and an injected probe result. Both are production-code
    bypasses of a fail-closed path, so this asserts explicitly that with NEITHER
    set the fail-closed still holds, and that each one alone is enough to switch
    it off. Without this the six-row matrix would still pass if an affordance
    leaked in from the ambient environment, because the assertion would never
    reach the code it names.
    """
    environment = _matrix_environment(tmp_path)
    target = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    _break_plist(target, "missing", tmp_path)

    # Precondition: the affordances really are absent for this assertion.
    assert os.environ.get("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH") is None
    assert os.environ.get("BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT") is None
    assert os.environ.get("BOT_ERRORS_DRY_PROVIDER_PROBE_RC") is None
    assert _mod.provider_probe_output_is_stubbed() is False
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_UNREADABLE,
        None,
    )

    # Each affordance ALONE switches the governed surfaces off, which is the
    # bypass being disclosed rather than hidden.
    monkeypatch.setenv("BOT_ERRORS_DRY_PROVIDER_PROBE_RC", "0")
    assert _mod.provider_probe_output_is_stubbed() is True
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_NOT_APPLICABLE,
        None,
    )
    monkeypatch.delenv("BOT_ERRORS_DRY_PROVIDER_PROBE_RC", raising=False)
    monkeypatch.setenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", "/fixture/dry/bin")
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_NOT_APPLICABLE,
        None,
    )
