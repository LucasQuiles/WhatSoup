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


def test_instance_plist_environment_refuses_a_duplicate_key(monkeypatch, tmp_path):
    """A duplicate key is refused rather than resolved. Contract CHANGE.

    This reader took the FIRST occurrence and the TypeScript comparator took the
    LAST, so the two disagreed about the same file and neither matched a parser
    with its own precedence. Refusing settles the asymmetry on both sides, and
    it is the fail-closed direction: an operator is told the plist is ambiguous
    instead of one of two tools quietly picking a different value.
    """
    _arm_darwin_plist(
        monkeypatch,
        tmp_path,
        "agent-alpha",
        {"PATH": "/fixture/second/bin"},
        duplicate_path="/fixture/first/bin",
    )
    assert _mod.instance_plist_environment("agent-alpha") is None
    assert _mod.instance_provider_path("agent-alpha") is None


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


# Prefixes that mark a key as Claude/Anthropic identity, authentication or
# configuration. The two rows below pin the CLASS rather than today's split.
CLAUDE_CLASS_ENV_PREFIXES = ("ANTHROPIC_", "CLAUDE_")


def test_opencode_probe_allowlist_admits_no_claude_or_anthropic_class_key():
    """Class pin on the constants. The split test above does NOT cover this.

    That test asserts set equality plus "CLAUDE_CONFIG_DIR" not in the common
    set. Add a provider credential key, or a second CLAUDE_-prefixed variable,
    to COMMON_FUNCTIONAL_ENV_KEYS and every one of its assertions still holds
    while the key enters BOTH probe children. The contract is not "the sets
    differ by this one name", it is "no Claude or Anthropic identity, auth or
    config variable is inherited by the opencode probe child".

    Boundary, stated so a later reader does not widen this wrongly: it stops at
    the ALLOWLIST. opencode_functional_probe_env deliberately injects the
    configured provider credential AFTER the allowlist, and for the "anthropic"
    key service that credential is itself an ANTHROPIC_-prefixed name
    (SERVICE_ENV_MAP). That is an intended per-instance injection of opencode's
    own key, not inheritance, so asserting this class over the whole probe env
    would be false for a valid configuration.
    """
    assert [k for k in _mod.OPENCODE_FUNCTIONAL_ENV_KEYS
            if k.startswith(CLAUDE_CLASS_ENV_PREFIXES)] == []
    # Asserted on the common tuple too: OPENCODE == COMMON today, but that
    # identity is an implementation detail, not the contract.
    assert [k for k in _mod.COMMON_FUNCTIONAL_ENV_KEYS
            if k.startswith(CLAUDE_CLASS_ENV_PREFIXES)] == []
    # Non-vacuity: the predicate matches a real key, and it DISCRIMINATES --
    # the claude allowlist carries exactly one key of this class.
    assert "CLAUDE_CONFIG_DIR".startswith(CLAUDE_CLASS_ENV_PREFIXES)
    assert [k for k in _mod.CLAUDE_FUNCTIONAL_ENV_KEYS
            if k.startswith(CLAUDE_CLASS_ENV_PREFIXES)] == ["CLAUDE_CONFIG_DIR"]


def test_opencode_probe_child_environment_admits_no_claude_or_anthropic_class_key():
    """The same class pin against the environment the helper actually builds.

    The constants row above can be satisfied by a tuple that never reaches the
    child. This one drives governed_child_environment with a base environment
    that really does offer four keys of the class, so an empty result is a fact
    about the allowlist rather than about the fixture.
    """
    base_env = {
        "PATH": "/fixture/pin/bin:/usr/bin",
        "HOME": "/fixture/home",
        "CLAUDE_CONFIG_DIR": "/fixture/config/agent-alpha",
        "CLAUDE_CODE_ENTRYPOINT": "cli",
        "ANTHROPIC_API_KEY": "must-not-propagate",
        "ANTHROPIC_AUTH_TOKEN": "must-not-propagate",
    }
    offered = sorted(k for k in base_env if k.startswith(CLAUDE_CLASS_ENV_PREFIXES))
    assert offered == [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CONFIG_DIR",
    ], "fixture must actually offer keys of the class, or the assertion is vacuous"

    opencode_child = _mod.governed_child_environment(
        "/fixture/pin/bin:/usr/bin",
        "agent-alpha",
        "/fixture/work",
        base_env,
        env_keys=_mod.OPENCODE_FUNCTIONAL_ENV_KEYS,
    )

    assert sorted(k for k in opencode_child
                  if k.startswith(CLAUDE_CLASS_ENV_PREFIXES)) == []
    # The allowlist still ran and the governed keys still travelled.
    assert opencode_child["PATH"] == "/fixture/pin/bin:/usr/bin"
    assert opencode_child["HOME"] == "/fixture/home"
    assert opencode_child["WHATSOUP_INSTANCE"] == "agent-alpha"

    # Contrast from the SAME base environment: the claude allowlist admits the
    # per-instance config root and nothing else of the class, so the rule is
    # "one named config key for one provider", not "no such key anywhere".
    claude_child = _mod.governed_child_environment(
        "/fixture/pin/bin:/usr/bin",
        "agent-alpha",
        "/fixture/work",
        base_env,
        env_keys=_mod.CLAUDE_FUNCTIONAL_ENV_KEYS,
    )
    assert sorted(k for k in claude_child
                  if k.startswith(CLAUDE_CLASS_ENV_PREFIXES)) == ["CLAUDE_CONFIG_DIR"]
    assert claude_child["CLAUDE_CONFIG_DIR"] == "/fixture/config/agent-alpha"


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
REGENERATE_REMEDIATION_FRAGMENT = f"remediation={_mod.REGENERATE_LAUNCHAGENT_REMEDIATION}"


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

# Nested-dict DETECTION is broad: any dict opening token at all, whatever it
# carries, truncates the block and must fail closed.
NESTED_DICT_SPELLINGS = [
    "<dict>",
    "<dict >",
    "<dict\n    >",
    "<dict/>",
    "<dict />",
    '<dict class="x">',
    '<dict foo="a>b">',
]
# What the reader PARSES is narrower: plain and whitespace-padded only.
OUTER_DICT_SPELLINGS = ["<dict>", "<dict >", "<dict\n  >"]
OUTER_SELF_CLOSING_SPELLINGS = ["<dict/>", "<dict />"]
# An attributed dict is REFUSED, not consumed. `<dict a="x>y">` is legal XML, and
# consuming to the first ">" would end the token inside the attribute value and
# read the rest of the opening tag as body pairs.
OUTER_DICT_REFUSED_SPELLINGS = ['<dict class="x">', '<dict foo="a>b">']


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


@pytest.mark.parametrize("nested_spelling", NESTED_DICT_SPELLINGS)
def test_default_provider_probe_does_not_spawn_when_a_nested_dict_hides_the_prepend(
    monkeypatch, tmp_path, nested_spelling
):
    """The operator-visible half of MED-7, and a parity assertion.

    Every spelling names the same element, so every row must produce the same
    class. The "<dict>" row is the control that proves the fixture reaches the
    code; the others spawned the provider before the fix, because the hidden
    WHATSOUP_PATH_PREPEND matched the loaded job's absent one.
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


# --- CDATA: the pair regex cannot match across one, so the KEY would vanish ---
#
# The system plist parser accepts a CDATA section and launchd loads the value
# (verified with plutil: a prepend written as CDATA extracts to its plain text).
# The non-"<" pair class introduced with the markup-span fix cannot match a
# CDATA value or key at all, so the pair is dropped and the governed key reads
# as ABSENT -- the benign absent-vs-absent cell -- while the service really does
# carry it. Both readers now refuse a CDATA opener inside the EnvironmentVariables
# block, under the same fail-closed rule as a nested dict.

# The silent-absence class. Each cell is a VALID plist the system parser accepts
# and launchd loads, which the pair-extraction reader turned into a missing
# governed key. The first is delta-introduced by the non-"<" pair class; the
# next four pre-date this branch. Duplicate and unpaired keys are the same
# structural failure reached from the other direction.
SILENT_ABSENCE_CELLS = {
    "cdata_value": [
        '    <key>PATH</key><string>{path}</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key><string><![CDATA[{prepend}]]></string>',
    ],
    "cdata_key_name": [
        '    <key><![CDATA[PATH]]></key><string>{path}</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key><string>{prepend}</string>',
    ],
    "comment_between_key_and_string": [
        '    <key>PATH</key><string>{path}</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key><!-- operator note --><string>{prepend}</string>',
    ],
    "processing_instruction_between_key_and_string": [
        '    <key>PATH</key><string>{path}</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key><?ide fold?><string>{prepend}</string>',
    ],
    "whitespace_in_key_end_tag": [
        '    <key>PATH</key><string>{path}</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key ><string>{prepend}</string>',
    ],
    "whitespace_in_string_start_tag": [
        '    <key>PATH</key><string>{path}</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key><string >{prepend}</string>',
    ],
    "unpaired_key": [
        '    <key>PATH</key><string>{path}</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key>',
    ],
    "duplicate_key": [
        '    <key>PATH</key><string>{path}</string>',
        '    <key>PATH</key><string>/fixture/other/bin</string>',
        '    <key>WHATSOUP_PATH_PREPEND</key><string>{prepend}</string>',
    ],
}


def _write_plist_with_raw_entries(home: Path, name: str, entries: list[str]) -> Path:
    agents = home / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    target = agents / f"com.whatsoup.{name}.plist"
    target.write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<plist version="1.0">',
                "<dict>",
                "  <key>Label</key>",
                f"  <string>com.whatsoup.{name}</string>",
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


@pytest.mark.parametrize("cell", sorted(SILENT_ABSENCE_CELLS))
def test_plist_reader_refuses_every_silent_absence_cell(monkeypatch, tmp_path, cell):
    """Every cell must fail closed rather than drop a governed key.

    The rule under test is general: the body must be fully consumed by matched
    key/string pairs and XML whitespace. These cells are the spellings that
    reached a real plist, not the definition of the rule.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_host(monkeypatch, tmp_path)
    entries = [
        line.format(path=environment["PATH"], prepend=environment["WHATSOUP_PATH_PREPEND"])
        for line in SILENT_ABSENCE_CELLS[cell]
    ]
    _write_plist_with_raw_entries(tmp_path, "agent-alpha", entries)

    assert _mod.instance_plist_environment("agent-alpha") is None, (
        f"{cell}: must be refused, not parsed into a map missing a governed key"
    )
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_UNREADABLE,
        None,
    )


def test_plist_reader_still_parses_the_generator_escaped_form(monkeypatch, tmp_path):
    """Positive control for the refusal: the shipped escaping is unaffected.

    buildPlist escapes "<" as an entity rather than wrapping it in CDATA, and
    that form must keep parsing to the same value the system parser resolves.
    Without this row the CDATA refusal could be satisfied by refusing every
    plist that mentions a "<" at all.
    """
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_raw_entries(
        tmp_path,
        "agent-alpha",
        [
            "    <key>PATH</key><string>/fixture/pin/bin:/usr/bin</string>",
            "    <key>WHATSOUP_PATH_PREPEND</key><string>/fixture/pin&lt;bin</string>",
        ],
    )

    parsed = _mod.instance_plist_environment("agent-alpha")
    assert parsed is not None, "the escaped form is not CDATA and must still parse"
    assert parsed["WHATSOUP_PATH_PREPEND"] == "/fixture/pin<bin"
    assert parsed["PATH"] == "/fixture/pin/bin:/usr/bin"


def test_default_provider_probe_does_not_spawn_when_markup_hides_the_prepend(
    monkeypatch, tmp_path
):
    """End to end: the cell that made the probe spawn where it must not.

    The plist declares WHATSOUP_PATH_PREPEND inside a CDATA section, which the
    system parser resolves and launchd loads, and the loaded job here carries no
    prepend. Dropping the key put both sides in the benign absent-vs-absent cell,
    so the probe reported ok and ran the provider. Refusing the plist fails it
    closed instead.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_raw_entries(
        tmp_path,
        "agent-alpha",
        [
            f'    <key>PATH</key><string>{environment["PATH"]}</string>',
            "    <key>WHATSOUP_PATH_PREPEND</key>"
            f'<string><![CDATA[{environment["WHATSOUP_PATH_PREPEND"]}]]></string>',
        ],
    )
    loaded_environment = dict(environment)
    loaded_environment.pop("WHATSOUP_PATH_PREPEND")

    captured, lines = _claude_probe(monkeypatch, {}, loaded_environment)

    assert not captured, "the probe must not spawn the provider on a refused plist"
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


@pytest.mark.parametrize("outer_spelling", OUTER_DICT_REFUSED_SPELLINGS)
def test_plist_reader_refuses_an_attributed_environment_dict(
    monkeypatch, tmp_path, outer_spelling
):
    """An attributed dict is refused rather than consumed to the first ">".

    A ">" inside an attribute value is legal XML. Consuming the token up to the
    first ">" ends it INSIDE the attribute value, and the remainder of the
    opening tag is then read as body pairs. Because this reader is first-wins, a
    governed key injected from inside the tag would beat the plist's own. plist(5)
    dicts carry no attributes, so refusing costs nothing.
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

    assert _mod.instance_plist_environment("agent-alpha") is None
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_UNREADABLE,
        None,
    )


def test_plist_reader_refuses_a_governed_key_injected_from_inside_a_dict_tag(
    monkeypatch, tmp_path
):
    """The concrete harm the refusal prevents, asserted on the value.

    Without the refusal the reader returns a map whose WHATSOUP_PATH_PREPEND came
    from inside the opening tag, not from the plist body, and first-wins makes it
    beat the real one.
    """
    _arm_darwin_host(monkeypatch, tmp_path)
    agents = tmp_path / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    injected = (
        '<dict foo="a>'
        "<key>WHATSOUP_PATH_PREPEND</key><string>/fixture/injected</string>"
        'b">'
    )
    (agents / "com.whatsoup.agent-alpha.plist").write_text(
        "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<plist version="1.0">',
                "<dict>",
                "  <key>Label</key>",
                "  <string>com.whatsoup.agent-alpha</string>",
                "  <key>EnvironmentVariables</key>",
                f"  {injected}",
                "    <key>PATH</key><string>/fixture/pin/bin:/usr/bin</string>",
                "    <key>WHATSOUP_PATH_PREPEND</key><string>/fixture/pin/bin</string>",
                "  </dict>",
                "</dict>",
                "</plist>",
                "",
            ]
        )
    )

    parsed = _mod.instance_plist_environment("agent-alpha")
    assert parsed is None, f"the injected tag must not parse, got {parsed!r}"


@pytest.mark.parametrize("outer_spelling", OUTER_SELF_CLOSING_SPELLINGS)
def test_plist_reader_reads_a_self_closing_environment_dict_as_empty(
    monkeypatch, tmp_path, outer_spelling
):
    """`<dict/>` is a well-formed EMPTY map, not an unreadable plist.

    The reader now says readable-with-nothing-in-it, and the governed-PATH
    absence check names the real problem. Both states fail the probe closed; only
    the class changes.
    """
    _arm_darwin_host(monkeypatch, tmp_path)
    _write_plist_with_dict_spellings(tmp_path, "agent-alpha", outer_spelling=outer_spelling)

    assert _mod.instance_plist_environment("agent-alpha") == {}
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_READABLE,
        {},
    )


def test_plist_reader_refuses_a_non_string_value_in_the_environment(
    monkeypatch, tmp_path
):
    """A non-string entry makes the plist unreadable. Contract CHANGE.

    An earlier round asserted this plist was READABLE with the <data> entry
    skipped. That was the same silent-absence defect in a milder form: the
    reader decided on its own which entries to ignore, and an entry it ignores
    is a key it cannot report. launchd's EnvironmentVariables is a dictionary of
    STRINGS, so a <data> value there is a schema violation; refusing it is the
    correct contract, and a key paired with a non-string value is structurally
    the same case as a key separated from its string by markup.

    Deliberately NOT fixed by adding a consume-and-ignore path for
    <key>..</key><data>..</data>: that would reinstate the reader's licence to
    skip entries it does not model, which is the defect itself.
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

    assert _mod.instance_plist_environment("agent-alpha") is None
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_UNREADABLE,
        None,
    )



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
    # The EXACT class, not the provider_runtime_path_ prefix, so a silent
    # migration to a neighbouring class cannot pass here.
    #
    # This row asserted provider_runtime_path_mismatch until glm-1. All six
    # states left the generated PATH unresolved, so instance_provider_path_match
    # compared None against the loaded PATH and failed, and every state landed
    # on a PATH class -- measured for each of the six at the time, and correct
    # as a description of what the code did. It was the wrong ANSWER: the plist
    # is the fault, and the default provider said so for the identical state.
    # Naming the PATH sent an operator to repair something that was not broken.
    # Both branches now refuse through one shared function.
    assert "failure_class=provider_runtime_plist_unreadable" in lines[0], f"{state}: {lines[0]}"
    # The old line carried the governed PATH's directory. The shared refusal is
    # path-free like its sibling, so assert that too rather than only the class.
    _assert_fail_line_is_path_free(lines[0], tmp_path)


@pytest.mark.parametrize("state", PLIST_BREAKAGE_STATES)
def test_both_providers_name_the_same_cause_for_an_unreadable_plist(monkeypatch, tmp_path, state):
    """glm-1. One plist state must not produce two different remediations.

    Both classes are new in this PR, which is what makes this introduced rather
    than inherited. For the SAME unreadable plist the default provider reported
    `provider_runtime_plist_unreadable` and told the operator to regenerate the
    LaunchAgent, while opencode reported `provider_runtime_path_mismatch` and
    sent them to repair a PATH that is not the problem. An operator running both
    providers on one host got two contradictory instructions for one fault, and
    whichever they followed first was the wrong one for the other instance.

    Asserted as a PARITY property over the shared state rather than as two
    independent expectations, so the two branches cannot drift apart again by
    one of them changing class.
    """
    environment = _matrix_environment(tmp_path)
    target_plist = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    _break_plist(target_plist, state, tmp_path)
    # Vacuity guard: both branches must be looking at a genuinely unreadable
    # plist, or the parity below is between two irrelevant answers.
    assert _mod.instance_plist_environment("agent-alpha") is None, f"{state}: fixture must be unreadable"

    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    opencode_lines = _mod.opencode_provider_probe_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli", "model": "xai/grok-4"}},
        "opencode-cli",
    )
    captured, claude_lines = _claude_probe(monkeypatch, {}, dict(environment))

    assert not captured, f"{state}: neither provider may run on a plist it cannot read"
    for label, lines in (("opencode", opencode_lines), ("claude-cli", claude_lines)):
        assert "failure_class=provider_runtime_plist_unreadable" in lines[0], f"{state}/{label}: {lines[0]}"
        assert "provider_runtime_path_mismatch" not in lines[0], f"{state}/{label}: {lines[0]}"
        assert REGENERATE_REMEDIATION_FRAGMENT in lines[0], f"{state}/{label}: {lines[0]}"


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

    # NON-VACUITY: the loaded job itself carries a socket variable, so an empty
    # result proves the child env is BUILT from an allowlist rather than merely
    # that nothing synthesized one. Asserting absence against a source that never
    # offered the variable could not fail for the right reason.
    source_environment = dict(environment)
    source_environment["WHATSOUP_MCP_SOCKET"] = "/fixture/workspace/.claude/whatsoup.sock"

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(source_environment))
    _mod.provider_probe_target_inventory({}, {}, "agent-alpha", config, "claude-cli", "primary")

    child_env = seen.get("child_env")
    assert child_env is not None, "the probe never reached the provider spawn"
    assert source_environment["WHATSOUP_MCP_SOCKET"], "fixture must offer the variable"
    assert "WHATSOUP_MCP_SOCKET" not in child_env, (
        "a diagnostic must not be handed the instance's tool socket, by synthesis or inheritance"
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


def _spawn_env_and_cwd(args, kwargs):
    """(child_env, child_cwd) from a provider_command_output call, either form.

    The capability probes pass them as KEYWORDS and the functional probe passes
    them POSITIONALLY, so a fixed index is wrong for half the call sites and
    silently yields the env dict where the cwd was expected. Positional order
    after `command` is: timeout, three dry-run env names, input_text, child_env,
    child_cwd.
    """
    child_env = kwargs.get("child_env", args[5] if len(args) > 5 else None)
    child_cwd = kwargs.get("child_cwd", args[6] if len(args) > 6 else None)
    return child_env, child_cwd


def _write_marker_binary(directory: Path, name: str, marker: str) -> Path:
    """A REAL executable that announces itself, so 'it ran' is observable."""
    directory.mkdir(parents=True, exist_ok=True)
    binary = directory / name
    binary.write_text(f"#!/bin/sh\necho {marker}\n")
    binary.chmod(0o755)
    return binary


def _governed_probe_fixture(monkeypatch, tmp_path, configured_command):
    """Instance whose GOVERNED PATH supplies claude, plus an AMBIENT-only binary.

    The governed PATH must supply `claude` or the runtime-path gate refuses
    before the spawn and the resolution step under test is never reached. The
    configured probe command is a DIFFERENT bare name that exists only on the
    health check's own PATH.
    """
    environment = _prepend_fixture(tmp_path)
    governed_bin = tmp_path / "pin" / "bin"
    _write_marker_binary(governed_bin, "claude", "GOVERNED-CLAUDE-RAN")
    ambient_bin = tmp_path / "ambient-only" / "bin"
    _write_marker_binary(ambient_bin, "bareprobe", "UNGOVERNED-BINARY-RAN")
    # The ambient PATH of the health-check process carries the bare name; the
    # governed PATH does not.
    monkeypatch.setenv("PATH", f"{ambient_bin}:/usr/bin:/bin")
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    lines = _mod.provider_probe_target_inventory(
        {}, {"providerProbeCommand": configured_command}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli", "primary",
    )
    return environment, governed_bin, ambient_bin, lines


def test_probe_command_is_never_resolved_from_the_health_check_own_path(monkeypatch, tmp_path):
    """MUST. A bare command absent from the governed PATH must not run.

    Resolving it from the health check's OWN PATH yields an absolute argv[0],
    and an absolute argv[0] executes regardless of the child environment's PATH.
    A configured bare probe command missing from the governed PATH would then run
    an ungoverned binary and report ITS health as the service's, which
    contradicts the documented contract that the provider is executed with the
    governed PATH rather than resolved from the probe process's own.

    No spawn stub here: the real provider_command_output runs, and the ungoverned
    binary prints a marker. The marker's ABSENCE is the proof that nothing ran.
    """
    environment, _governed_bin, ambient_bin, lines = _governed_probe_fixture(
        monkeypatch, tmp_path, "bareprobe",
    )
    joined = "\n".join(lines)

    assert "UNGOVERNED-BINARY-RAN" not in joined, (
        "the probe executed a binary the governed PATH cannot supply"
    )
    assert "failure_class=provider_runtime_path_unavailable" in lines[0], lines[0]
    assert "reason=command_not_on_governed_path" in lines[0], lines[0]
    # The line carries no command and no filesystem path, matching the redaction
    # stance for the whole provider_runtime_path_* family.
    assert "bareprobe" not in joined
    _assert_fail_line_is_path_free(lines[0], tmp_path)
    assert str(ambient_bin) not in joined


def test_probe_command_resolves_against_the_governed_path_and_runs(monkeypatch, tmp_path):
    """Positive control. A bare command ON the governed PATH still resolves and runs.

    Without this, the row above could be satisfied by never resolving anything.
    """
    seen: dict[str, object] = {}
    real_output = _mod.provider_command_output

    def _spy(command, *args, **kwargs):
        seen["argv"] = list(command)
        return real_output(command, *args, **kwargs)

    monkeypatch.setattr(_mod, "provider_command_output", _spy)
    environment, governed_bin, _ambient, lines = _governed_probe_fixture(
        monkeypatch, tmp_path, "claude",
    )

    argv = seen.get("argv")
    assert argv, "the probe never reached the spawn"
    assert os.path.isabs(argv[0]), f"argv[0] must be absolute, got {argv[0]}"
    assert argv[0].startswith(str(governed_bin)), (
        f"argv[0] must resolve under the governed directory, got {argv[0]}"
    )
    assert "GOVERNED-CLAUDE-RAN" in "\n".join(lines), lines


def test_probe_directory_predicate_rejects_a_descendant_of_the_workspace(tmp_path):
    """MED-3. A temporary root inside the workspace must not count as outside."""
    workspace = tmp_path / "workspace"
    (workspace / "tmp" / "probe").mkdir(parents=True)
    assert not _mod.probe_directory_is_outside_workspace(
        str(workspace / "tmp" / "probe"), str(workspace)
    )
    assert not _mod.probe_directory_is_outside_workspace(str(workspace), str(workspace))
    # A sibling whose name merely starts with the workspace path is NOT inside it.
    sibling = tmp_path / "workspace-other"
    sibling.mkdir()
    assert _mod.probe_directory_is_outside_workspace(str(sibling), str(workspace))


def test_probe_directory_predicate_resolves_symlinks_before_deciding(tmp_path):
    """A symlinked temporary root that lands inside the workspace is refused.

    This is the case a string comparison cannot see: the probe path looks
    unrelated until both sides are resolved.
    """
    workspace = tmp_path / "workspace"
    (workspace / "inner").mkdir(parents=True)
    link = tmp_path / "looks-neutral"
    link.symlink_to(workspace / "inner")

    assert not _mod.probe_directory_is_outside_workspace(str(link), str(workspace))
    # Control: the same link pointing somewhere genuinely outside is accepted.
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    other_link = tmp_path / "also-neutral"
    other_link.symlink_to(elsewhere)
    assert _mod.probe_directory_is_outside_workspace(str(other_link), str(workspace))


def _force_samefile_oserror(monkeypatch):
    def _raise(_a, _b):
        raise OSError("simulated: identity unreadable")
    monkeypatch.setattr(os.path, "samefile", _raise)


def _governed_claude_fixture(monkeypatch, tmp_path, marker="GOVERNED-CLAUDE-RAN"):
    """Instance whose governed PATH supplies a real claude that prints a marker."""
    environment = _prepend_fixture(tmp_path)
    governed_bin = tmp_path / "pin" / "bin"
    _write_marker_binary(governed_bin, "claude", marker)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    return environment, governed_bin


def _run_claude_probe(item=None):
    return _mod.provider_probe_target_inventory(
        {}, item or {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}},
        "claude-cli", "primary",
    )


def test_absent_temp_root_is_not_reported_as_a_governed_path_failure(monkeypatch, tmp_path):
    """D-1. A temporary directory that cannot be created is not a PATH fact.

    The FileNotFoundError arm wrapped the whole block, so a TMPDIR that does not
    exist reported reason=command_not_on_governed_path even though the command
    resolved fine. Fail-closed either way, but mislabelled: it sends an operator
    to repair a runtime path that is not broken.
    """
    _governed_claude_fixture(monkeypatch, tmp_path)
    monkeypatch.setattr(_mod.tempfile, "tempdir", str(tmp_path / "no-such-temp-root"))

    lines = _run_claude_probe()

    assert "reason=command_not_on_governed_path" not in lines[0], lines[0]
    assert "failure_class=provider_probe_failed" in lines[0], lines[0]


def test_missing_shebang_interpreter_is_not_reported_as_a_governed_path_failure(
    monkeypatch, tmp_path
):
    """D-1, the case exc.filename cannot separate on its own.

    A script whose interpreter is missing raises FileNotFoundError reporting the
    SCRIPT's path, which is argv[0] — identical in shape to a command that never
    resolved. Measured rather than assumed, which is why the discriminator is
    whether resolution against the governed PATH succeeded, not the filename.
    """
    environment, governed_bin = _governed_claude_fixture(monkeypatch, tmp_path)
    # Replace the governed claude with one whose interpreter does not exist.
    binary = governed_bin / "claude"
    binary.write_text("#!/nonexistent/interpreter\necho unreachable\n")
    binary.chmod(0o755)

    lines = _run_claude_probe()

    assert "reason=command_not_on_governed_path" not in lines[0], lines[0]
    assert "failure_class=provider_probe_failed" in lines[0], lines[0]


def test_a_command_absent_from_the_governed_path_keeps_its_own_class(monkeypatch, tmp_path):
    """D-1 control: the true case must keep reporting the governed-PATH class.

    Without this the two rows above could be satisfied by removing the class
    entirely.
    """
    environment, governed_bin = _governed_claude_fixture(monkeypatch, tmp_path)
    ambient_bin = tmp_path / "ambient-only" / "bin"
    _write_marker_binary(ambient_bin, "bareprobe", "UNGOVERNED-BINARY-RAN")
    monkeypatch.setenv("PATH", f"{ambient_bin}:/usr/bin:/bin")

    lines = _run_claude_probe({"providerProbeCommand": "bareprobe"})

    assert "failure_class=provider_runtime_path_unavailable" in lines[0], lines[0]
    assert "reason=command_not_on_governed_path" in lines[0], lines[0]
    assert "UNGOVERNED-BINARY-RAN" not in "\n".join(lines)


def test_probe_directory_refuses_when_identity_is_unreadable(monkeypatch, tmp_path):
    """The ancestor walk must not answer 'outside' when it cannot tell.

    Swallowing OSError and continuing let the loop run out at the filesystem
    root and return True, which the caller reads as "safe" and SPAWNS. That is a
    fail-OPEN branch inside a containment control, and the opposite direction
    from the realpath failure in the same function, which refuses.

    The fixture reaches the walk rather than the string prefix: the workspace and
    the probe are spelled with different case, so the prefix test cannot decide
    and only identity can.
    """
    workspace = tmp_path / "Workspace"
    (workspace / "tmp").mkdir(parents=True)
    probe = str(tmp_path / "workspace" / "tmp")
    if not os.path.exists(probe):
        pytest.skip("case-sensitive volume: this spelling is a different directory here")

    # Control: with identity readable the probe is correctly seen as inside.
    assert not _mod.probe_directory_is_outside_workspace(probe, str(workspace))

    _force_samefile_oserror(monkeypatch)
    assert not _mod.probe_directory_is_outside_workspace(probe, str(workspace)), (
        "an unreadable identity must refuse, not report the probe as outside"
    )


def test_probe_directory_reports_an_absent_workspace_as_outside(monkeypatch, tmp_path):
    """A configured workspace that does not exist cannot contain the probe.

    Existence is decided ONCE, before the walk, precisely so this case does not
    reach the OSError arm. Refusing here would refuse EVERY probe on an instance
    whose configured workspace is absent, which is the regression this control
    already had to fix once. Disclosed rather than silent: absent reads as
    outside.
    """
    absent = str(tmp_path / "never-created")
    probe = tmp_path / "probe"
    probe.mkdir()

    assert _mod.probe_directory_is_outside_workspace(str(probe), absent)
    # Still true when identity is unreadable, because existence decided first.
    _force_samefile_oserror(monkeypatch)
    assert _mod.probe_directory_is_outside_workspace(str(probe), absent)


def test_probe_directory_refuses_a_probe_that_does_not_exist(tmp_path):
    """A vanished probe directory refuses rather than reading as outside.

    Disclosed consequence of the existence rule: in production the probe is a
    directory the probe itself just created, so this arm is defensive.
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert not _mod.probe_directory_is_outside_workspace(str(tmp_path / "gone"), str(workspace))


def test_probe_directory_identity_holds_through_a_symlinked_alias(tmp_path):
    """LOW-1. A platform-independent identity row, runnable on Linux CI.

    The case-variant row above can only assert its point on a case-INSENSITIVE
    volume and skips elsewhere, so on a Linux runner it proves nothing. A
    symlinked alias of the workspace exercises the same identity question on
    every platform: the probe reached through the alias is INSIDE the workspace,
    and a string comparison of the two spellings would not say so.
    """
    workspace = tmp_path / "workspace"
    (workspace / "inner").mkdir(parents=True)
    alias = tmp_path / "alias"
    alias.symlink_to(workspace)

    # Probe reached through the alias, workspace named directly.
    assert not _mod.probe_directory_is_outside_workspace(str(alias / "inner"), str(workspace))
    # And the mirror: workspace named through the alias.
    assert not _mod.probe_directory_is_outside_workspace(str(workspace / "inner"), str(alias))
    # Control: a directory outside the workspace stays outside through the alias.
    other = tmp_path / "other"
    other.mkdir()
    assert _mod.probe_directory_is_outside_workspace(str(other), str(alias))


def test_probe_directory_predicate_is_case_insensitive_aware(tmp_path):
    """S-A. On a case-insensitive volume, case must not read as 'outside'.

    macOS volumes are case-insensitive by default, so two spellings that differ
    only in case name ONE directory. Comparing realpath strings raw returned
    "outside" for a probe directory that is genuinely inside, which is the
    permissive direction for a containment check.
    """
    workspace = tmp_path / "Workspace"
    inner = workspace / "tmp"
    inner.mkdir(parents=True)
    variant = str(tmp_path / "workspace")

    # Ask the FILESYSTEM whether the two spellings are one directory. Deciding
    # this by normcase would be wrong twice over: normcase is the identity
    # function on POSIX, so the branch below would never take the
    # case-insensitive path even on a volume that is.
    same_directory = os.path.exists(variant) and os.path.samefile(variant, str(workspace))
    if not same_directory:
        # Case-SENSITIVE volume, which is the Linux CI default: the two spellings
        # really are different directories, so there is no case question to
        # answer here and this row asserts nothing about the fix. Skipped with
        # the measured reason rather than inverted into a vacuous pass; the
        # symlink-alias row above carries the identity assertion on every
        # platform.
        pytest.skip("case-sensitive volume: the two spellings are different directories here")
    assert not _mod.probe_directory_is_outside_workspace(str(inner), variant)
    # Control, true on every volume: the exact spelling is inside.
    assert not _mod.probe_directory_is_outside_workspace(str(inner), str(workspace))


def test_probe_directory_check_is_not_applied_without_a_configured_workspace(
    monkeypatch, tmp_path
):
    """S-B. No configured workspace means nothing to keep the probe out of.

    agent_workspace_cwd falls back to the home directory so a spawn always has a
    working directory. Feeding that fallback to the containment check would make
    EVERY probe refuse on a host whose TMPDIR sits under the home directory,
    which is the default on macOS for some configurations. The check now asks
    configured_agent_workspace_cwd and skips itself when the instance declares
    none.
    """
    assert _mod.configured_agent_workspace_cwd({"agentOptions": {}}) is None
    assert _mod.configured_agent_workspace_cwd(
        {"agentOptions": {"cwd": "/fixture/workspace"}}
    ) == "/fixture/workspace"

    environment = _prepend_fixture(tmp_path)
    _write_marker_binary(tmp_path / "pin" / "bin", "claude", "GOVERNED-CLAUDE-RAN")
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    # The temp root under the HOME the fallback would have used. Before the fix
    # this made the probe refuse; with no configured workspace it must proceed.
    # tempfile.gettempdir() CACHES its answer, so setting TMPDIR after any earlier
    # temp directory in the process has no effect; tempfile.tempdir is the
    # documented override and is what the probe actually reads.
    home_tmp = tmp_path / "tmp-under-home"
    home_tmp.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(_mod.tempfile, "tempdir", str(home_tmp))

    lines = _mod.provider_probe_target_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {}},
        "claude-cli", "primary",
    )

    joined = "\n".join(lines)
    assert "provider_probe_directory_unsafe" not in joined, joined
    assert "GOVERNED-CLAUDE-RAN" in joined, joined


def test_probe_refuses_when_the_temp_directory_sits_inside_the_workspace(
    monkeypatch, tmp_path
):
    """S-E. Drives a provider_probe_directory_unsafe CALL SITE, not the predicate.

    The two predicate rows exercise the comparison; neither reached the emitted
    line, so its class string and remediation were unexercised. Pointing TMPDIR
    inside a CONFIGURED workspace makes the probe's own temporary directory land
    where the probe must not run.
    """
    environment = _prepend_fixture(tmp_path)
    _write_marker_binary(tmp_path / "pin" / "bin", "claude", "GOVERNED-CLAUDE-RAN")
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    workspace = tmp_path / "workspace"
    inside = workspace / "tmp"
    inside.mkdir(parents=True)
    # tempfile.gettempdir() caches; tempfile.tempdir is the documented override.
    monkeypatch.setattr(_mod.tempfile, "tempdir", str(inside))

    lines = _mod.provider_probe_target_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"cwd": str(workspace)}},
        "claude-cli", "primary",
    )

    assert "failure_class=provider_probe_directory_unsafe" in lines[0], lines[0]
    assert "remediation=set_TMPDIR_outside_the_instance_workspace" in lines[0], lines[0]
    # The provider must not have run, and the line must not publish paths.
    assert "GOVERNED-CLAUDE-RAN" not in "\n".join(lines)
    _assert_fail_line_is_path_free(lines[0], tmp_path)


def _opencode_probe_with_env(monkeypatch, tmp_path, *, break_temp_root):
    """Drive the opencode inventory to the capability probes, optionally with a
    temporary root that does not exist."""
    environment = _prepend_fixture(tmp_path)
    governed_bin = tmp_path / "pin" / "bin"
    _write_marker_binary(governed_bin, "opencode", "opencode 1.0.0")
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    service_environment = dict(environment)
    service_environment["XAI_API_KEY"] = "fixture-not-a-real-key"
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(service_environment))

    run_help = "Usage: opencode run [options]\n  --format json\n  --pure\n  -m, --model <model>\n"

    def _fake_output(command, *args, **kwargs):
        if command[1:3] == ["run", "--help"]:
            return (run_help, "", 0, False)
        if command[1:2] == ["run"]:
            return ('{"type":"step_finish","part":{"reason":"stop"}}', "", 0, False)
        return ("opencode 1.0.0", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    if break_temp_root:
        monkeypatch.setattr(_mod.tempfile, "tempdir", str(tmp_path / "no-such-temp-root"))
    return _mod.opencode_provider_probe_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli", "model": "xai/grok-4"}},
        "opencode-cli",
    )


def test_opencode_probe_does_not_blame_the_cli_for_a_missing_temp_root(monkeypatch, tmp_path):
    """B7-1. A broken probe environment must not read as a broken opencode.

    The diagnostic temporary directory is this range's addition, so its failure
    mode is too. Routed through the blanket handler it surfaced as
    provider_compatibility_unsupported with remediation
    install_or_upgrade_opencode_modern_run_cli, which sends an operator to
    upgrade a CLI that is working. The default provider already discriminates
    ENOENT by whether the missing file is the command; this applies the same rule
    on the opencode path.
    """
    lines = _opencode_probe_with_env(monkeypatch, tmp_path, break_temp_root=True)

    assert "failure_class=provider_probe_failed" in lines[0], lines[0]
    assert "provider_compatibility_unsupported" not in lines[0], lines[0]
    assert "install_or_upgrade_opencode_modern_run_cli" not in lines[0], lines[0]
    # Still fails closed: the probe did not report a healthy provider.
    assert lines[0].startswith("FAIL provider_probe"), lines[0]


def test_opencode_probe_still_reports_a_missing_cli_as_unsupported(monkeypatch, tmp_path):
    """Control: when the missing file IS the command, the upgrade guidance stays.

    Without this the row above could be satisfied by removing the compatibility
    class altogether.
    """
    environment = _prepend_fixture(tmp_path)
    governed_bin = tmp_path / "pin" / "bin"
    _write_marker_binary(governed_bin, "opencode", "opencode 1.0.0")
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    service_environment = dict(environment)
    service_environment["XAI_API_KEY"] = "fixture-not-a-real-key"
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(service_environment))

    resolved = str(governed_bin / "opencode")

    def _vanished(command, *args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", resolved)

    monkeypatch.setattr(_mod, "provider_command_output", _vanished)

    lines = _mod.opencode_provider_probe_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli", "model": "xai/grok-4"}},
        "opencode-cli",
    )

    assert "failure_class=provider_compatibility_unsupported" in lines[0], lines[0]
    assert "remediation=install_or_upgrade_opencode_modern_run_cli" in lines[0], lines[0]


def test_opencode_probe_is_unaffected_when_the_temp_root_is_sound(monkeypatch, tmp_path):
    """Second control: the ordinary path is untouched by the discrimination."""
    lines = _opencode_probe_with_env(monkeypatch, tmp_path, break_temp_root=False)

    assert not lines[0].startswith("FAIL provider_probe"), lines[0]
    assert "detected_mode=modern-run" in lines[0], lines[0]


def test_opencode_capability_probes_run_outside_the_instance_workspace(monkeypatch, tmp_path):
    """SHOULD-4. The three capability probes are not the functional probe.

    `--version`, `--help` and `run --help` ask the binary what it is and what it
    supports. None starts a session, so none needs the instance workspace or its
    tool socket; both reached them only because the three shared the functional
    probe's child env and cwd. The workspace justification in the body covers
    the FUNCTIONAL probe alone.

    The functional probe is deliberately unchanged and has its own control row,
    so this cannot be read as moving opencode off its context wholesale.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "workspace-marker").write_text("x")
    config = {
        "type": "agent",
        "agentOptions": {"provider": "opencode-cli", "cwd": str(workspace), "model": "xai/grok-4"},
    }
    seen: list[dict[str, object]] = []

    def _fake_output(command, *args, **kwargs):
        env, cwd = _spawn_env_and_cwd(args, kwargs)
        seen.append({
            "argv": list(command),
            "cwd": cwd,
            # Read from INSIDE the call: the diagnostic directory is owned by a
            # context manager and is gone once the inventory returns.
            "cwd_entries": (
                sorted(entry.name for entry in Path(cwd).iterdir())
                if cwd and Path(cwd).is_dir() else None
            ),
            "has_socket": bool(env) and "WHATSOUP_MCP_SOCKET" in env,
            "path": (env or {}).get("PATH"),
        })
        return ("opencode 1.0.0", "", 0, False)

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    _mod.opencode_provider_probe_inventory({}, {}, "agent-alpha", config, "opencode-cli")

    capability = [row for row in seen if row["argv"][1:] in (["--version"], ["--help"], ["run", "--help"])]
    assert len(capability) == 3, f"expected three capability probes, saw {[r['argv'][1:] for r in seen]}"
    for row in capability:
        label = " ".join(row["argv"][1:])
        assert row["cwd"] != str(workspace), f"{label} must not run in the agent workspace"
        assert row["cwd_entries"] == [], f"{label} must run in a fresh directory the probe owns"
        assert not row["has_socket"], f"{label} must not be handed the instance tool socket"
        # The governed PATH still travels, so the binary resolves as the service does.
        assert row["path"] == _mod.effective_instance_provider_path(environment), label


def test_no_ambient_fallback_when_the_effective_path_cannot_be_composed(monkeypatch, tmp_path):
    """glm-2. The comment says there is deliberately NO ambient fallback.

    `shutil.which(command, path=None)` searches the CALLING process's PATH --
    path=None does not mean "no path". So when no effective provider PATH
    composed, a bare configured command was resolved out of the health check's
    own environment into an ABSOLUTE argv[0], and absolute argv[0] executes
    regardless of the child environment's PATH, so the child allowlist did not
    contain it. `resolved_on_governed_path` was then set True on that
    resolution and the binary's health was reported as the service's.

    Reachable in production: on a systemd host the plist state is
    `not_applicable`, and an instance whose loaded environment is missing HOME
    or PATH composes no effective PATH and lands exactly here.

    The probe is NOT made to refuse. On a host with no LaunchAgent surface the
    legacy chain is the contract, and a host that HAS one already refuses above
    with `provider_runtime_path_unavailable`. What must stop is the claim of
    governance: argv[0] stays as the caller gave it, and the line says the
    resolution was not governed.
    """
    monkeypatch.delenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", raising=False)
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "linux")
    monkeypatch.setattr(_mod.Path, "home", classmethod(lambda cls: tmp_path))
    ambient_bin = tmp_path / "ambient-only" / "bin"
    ungoverned = _write_marker_binary(ambient_bin, "bareprobe", "UNGOVERNED-BINARY-RAN")
    monkeypatch.setenv("PATH", f"{ambient_bin}:/usr/bin:/bin")

    # Preconditions, so a pass cannot come from a fixture that never reached the
    # branch: the state really is not_applicable, no effective PATH composes,
    # and the bare name really IS resolvable from the probe's own PATH -- which
    # is what the fix must decline to do.
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_NOT_APPLICABLE,
        None,
    )
    assert _mod.effective_instance_provider_path({}) is None
    assert _mod.shutil.which("bareprobe") == str(ungoverned)

    captured, lines = _claude_probe(monkeypatch, {"providerProbeCommand": "bareprobe"}, {})

    assert captured, "the legacy chain still runs where there is no governed surface"
    assert captured[0][0] == "bareprobe", (
        "argv[0] must stay as configured, not be resolved off the probe's own PATH"
    )
    assert captured[0][0] != str(ungoverned)
    assert "command_resolution=ambient_not_governed" in lines[0], lines[0]
    assert "UNGOVERNED-BINARY-RAN" not in "\n".join(lines)


def test_the_resolution_note_survives_a_failing_spawn(monkeypatch, tmp_path):
    """glm-2. The provenance must not be a happy-path-only field.

    The exception arms return without reaching the post-spawn report section, so
    a note defined beside that section would be absent from exactly the lines an
    operator reads when something went wrong. A timeout or an error against a
    binary chosen by the WRONG PATH is when the provenance matters most.
    """
    monkeypatch.delenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", raising=False)
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "linux")
    monkeypatch.setattr(_mod.Path, "home", classmethod(lambda cls: tmp_path))

    def _boom(command, *args, **kwargs):
        raise RuntimeError("probe blew up")

    monkeypatch.setattr(_mod, "provider_command_output", _boom)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: {})
    lines = _mod.provider_probe_target_inventory(
        {}, {"providerProbeCommand": "bareprobe"}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "claude-cli"}}, "claude-cli", "primary",
    )

    assert "failure_class=provider_probe_failed" in lines[0], lines[0]
    assert "command_resolution=ambient_not_governed" in lines[0], lines[0]


def test_a_governed_resolution_is_not_labelled_ambient(monkeypatch, tmp_path):
    """Control for the row above, twice over.

    Without it, hard-coding the note onto every line would satisfy the
    assertion above, and so would a fix that stopped resolving anything at all.
    Here the governed PATH does supply the binary: argv[0] must be the governed
    absolute path AND the line must carry no resolution note, because absence of
    the note is what now means "governed".
    """
    environment = _prepend_fixture(tmp_path)
    governed_bin = tmp_path / "pin" / "bin"
    _write_shadow(governed_bin, "claude")
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )

    assert _mod.effective_instance_provider_path(dict(environment)) is not None

    captured, lines = _claude_probe(monkeypatch, {}, dict(environment))

    assert captured, "a governed host must still probe"
    assert captured[0][0] == str(governed_bin / "claude")
    assert "command_resolution" not in "\n".join(lines), lines[0]


def test_an_unwritable_temp_root_is_a_probe_environment_failure_not_a_compatibility_one(
    monkeypatch, tmp_path
):
    """LOW-6. The opencode arm's catch-all misnamed its own environment.

    Its `except FileNotFoundError` already separates "the probe brought
    something missing" from "the binary is unusable", because reporting the
    first as a compatibility failure tells an operator to upgrade opencode when
    opencode is fine. Every OTHER OSError from the same block -- a PermissionError
    or an ENOSPC out of the tempdir path -- fell through to the bare
    `except Exception`, which returns exactly that misleading class and the
    install_or_upgrade remediation.

    The claude-cli arm's catch-all already answers provider_probe_failed here,
    so this is an asymmetry between two arms of one function, not a new policy.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))
    unwritable = tmp_path / "unwritable-temp-root"
    unwritable.mkdir()
    unwritable.chmod(0o500)

    # Vacuity guard: assert the fixture raises, and raises the RIGHT class. A
    # root-run suite, or a filesystem ignoring the mode, would otherwise make
    # this row pass against a probe that never reached the branch it names.
    with pytest.raises(PermissionError):
        _mod.tempfile.mkdtemp(dir=str(unwritable))
    monkeypatch.setattr(_mod.tempfile, "tempdir", str(unwritable))

    lines = _mod.opencode_provider_probe_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli", "model": "xai/grok-4"}},
        "opencode-cli",
    )

    assert "failure_class=provider_probe_failed" in lines[0], lines[0]
    assert "remediation=repair_the_probe_environment_and_retry" in lines[0], lines[0]
    # The wrong answer named explicitly, so a future widening cannot restore it.
    assert "provider_compatibility_unsupported" not in lines[0], lines[0]
    assert "install_or_upgrade_opencode" not in lines[0], lines[0]


def test_an_unusable_opencode_binary_still_reports_the_compatibility_class(monkeypatch, tmp_path):
    """Control for the row above: the compatibility class is NOT removed.

    Without this, widening the OSError arm to answer provider_probe_failed for
    everything would satisfy the assertion above and silently retire the class
    that tells an operator to upgrade opencode.
    """
    environment = _matrix_environment(tmp_path)
    _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(environment))

    resolved = _mod.executable_candidate("opencode", _mod.effective_instance_provider_path(environment))
    assert resolved, "fixture must resolve an opencode on the governed PATH"

    def _enoent(command, *args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", command[0])

    monkeypatch.setattr(_mod, "provider_command_output", _enoent)

    lines = _mod.opencode_provider_probe_inventory(
        {}, {}, "agent-alpha",
        {"type": "agent", "agentOptions": {"provider": "opencode-cli", "model": "xai/grok-4"}},
        "opencode-cli",
    )

    assert "failure_class=provider_compatibility_unsupported" in lines[0], lines[0]
    assert "remediation=install_or_upgrade_opencode_modern_run_cli" in lines[0], lines[0]


def test_opencode_functional_probe_keeps_the_workspace_and_socket(monkeypatch, tmp_path):
    """Control for the row above: the functional probe is NOT moved.

    It drives a real session that reads the instance's own context, so it keeps
    both the workspace cwd and the synthesized socket. Without this row the
    capability-probe change could quietly spread to the session probe.
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
        "agentOptions": {"provider": "opencode-cli", "cwd": str(workspace), "model": "xai/grok-4"},
    }
    seen: list[dict[str, object]] = []

    # detect_opencode_mode must classify the CLI as modern-run, or the inventory
    # returns provider_compatibility_unsupported before the functional spawn.
    run_help = "Usage: opencode run [options]\n  --format json\n  --pure\n  -m, --model <model>\n"

    def _fake_output(command, *args, **kwargs):
        env, cwd = _spawn_env_and_cwd(args, kwargs)
        seen.append({"argv": list(command), "cwd": cwd, "env": env})
        if command[1:3] == ["run", "--help"]:
            return (run_help, "", 0, False)
        if command[1:2] == ["run"]:
            return ('{"type":"message","text":"OK"}', "", 0, False)
        return ("opencode 1.0.0", "", 0, False)

    # The model selects the xai key service, and a missing credential returns
    # provider_credential_missing before the functional spawn. Synthetic value.
    service_environment = dict(environment)
    service_environment["XAI_API_KEY"] = "fixture-not-a-real-key"

    monkeypatch.setattr(_mod, "provider_command_output", _fake_output)
    monkeypatch.setattr(_mod, "loaded_instance_environment", lambda name: dict(service_environment))
    _mod.opencode_provider_probe_inventory(
        {"expectOpenCodeFunctionalProbe": True}, {}, "agent-alpha", config, "opencode-cli",
    )

    functional = [row for row in seen
                  if row["argv"][1:2] == ["run"] and row["argv"][1:3] != ["run", "--help"]]
    assert len(functional) == 1, f"expected one functional probe, saw {[r['argv'][1:3] for r in seen]}"
    row = functional[0]
    assert row["cwd"] == str(workspace), "the functional probe keeps the instance workspace"
    socket_path = (row["env"] or {}).get("WHATSOUP_MCP_SOCKET")
    assert socket_path is not None, "the functional probe keeps its synthesized socket"
    assert socket_path.startswith(f"{workspace}/")


# --- HIGH-1: an XML comment is not markup these readers may act on ---
#
# Pre-existing on main, taken here because this branch already hardens this
# parser and the TypeScript comparator it mirrors. Both were measured on the
# pre-fix code, not reasoned about:
#   a commented-out Label naming this instance, above a real Label naming
#     another, made the reader return the OTHER instance's environment
#     ({'PATH': '/planted/bin'}) for agent-alpha;
#   a commented-out EnvironmentVariables dict before the live one won the
#     `find`, so the decoy's body was read and the live dict never looked at;
#   an unterminated `<!--` was ignored outright and everything after it parsed
#     as live markup.


def test_a_commented_out_label_cannot_vouch_for_a_plist_labelled_for_another_instance(
    monkeypatch, tmp_path
):
    """The Label guard is what keeps a planted plist from being parsed at all.

    Its docstring says a Label that matches the instance is why "an unrelated or
    planted plist at the expected pathname is never parsed". One comment turned
    that off: the FIRST Label match was the commented-out one.
    """
    target = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha", {"PATH": "/planted/bin"},
    )
    raw = target.read_text()
    # The comment must span a COMPLETE Label element. Commenting out only the
    # <string> half leaves a live <key>Label</key> above the opener, the pairing
    # regex fails to match there, and the read refuses for an unrelated reason --
    # a fixture that passes on the unfixed reader and proves nothing. Measured:
    # the first shape of this test did exactly that.
    label_element = "  <key>Label</key>\n  <string>com.whatsoup.agent-alpha</string>"
    assert raw.count(label_element) == 1, "fixture shape changed"
    decoyed = raw.replace(
        label_element,
        f"  <!-- {label_element} -->\n"
        "  <key>Label</key>\n"
        "  <string>com.whatsoup.some-other-instance</string>",
        1,
    )
    # Vacuity guard: on the UNFIXED reader this fixture is accepted and returns
    # the other instance's environment. Asserting that here would pin the
    # defect, so instead assert the two properties that make the fixture real:
    # the decoy is a complete commented Label naming THIS instance, and the only
    # live Label names a DIFFERENT one.
    assert "<!--   <key>Label</key>\n  <string>com.whatsoup.agent-alpha</string> -->" in decoyed
    live = decoyed.replace(decoyed[decoyed.index("<!--"):decoyed.index("-->") + 3], "")
    assert "com.whatsoup.agent-alpha" not in live
    assert "<string>com.whatsoup.some-other-instance</string>" in live
    target.write_text(decoyed)

    assert _mod.instance_plist_environment("agent-alpha") is None
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_UNREADABLE,
        None,
    )

    # Positive control: the refusal is about the DECOY, not about comments or
    # about this pathname. The same plist, correctly labelled, still parses.
    target.write_text(raw)
    assert _mod.instance_plist_environment("agent-alpha") == {"PATH": "/planted/bin"}


def test_a_commented_out_decoy_dict_cannot_hide_the_live_environment(monkeypatch, tmp_path):
    """Stated as a DIFFERENTIAL: the comment must make no difference at all.

    Asserting only the post-fix map would keep passing if the reader started
    refusing BOTH shapes, which is different behaviour wearing the same green.
    The decoy body is deliberately a PLAUSIBLE one, so before the fix the read
    succeeded and looked ordinary rather than failing loudly.
    """
    target = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": "/real/bin", "OPERATOR_API_KEY": "fixture-not-a-real-key"},
    )
    honest = target.read_text()
    decoyed = honest.replace(
        "  <key>EnvironmentVariables</key>",
        "  <!-- <key>EnvironmentVariables</key>\n"
        "  <dict>\n"
        "    <key>PATH</key><string>/decoy/bin</string>\n"
        "  </dict> -->\n"
        "  <key>EnvironmentVariables</key>",
        1,
    )
    assert "/decoy/bin" in decoyed, "fixture must actually carry the decoy"

    target.write_text(decoyed)
    from_decoyed = _mod.instance_plist_environment("agent-alpha")
    target.write_text(honest)
    from_honest = _mod.instance_plist_environment("agent-alpha")

    assert from_decoyed == from_honest
    # And the shared value is the LIVE dict's, so neither side is the decoy's.
    assert from_decoyed == {"PATH": "/real/bin", "OPERATOR_API_KEY": "fixture-not-a-real-key"}


def test_an_unterminated_comment_is_refused_rather_than_ignored(monkeypatch, tmp_path):
    target = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha", {"PATH": "/real/bin"},
    )
    # Positive control: the same file parses before the opener is appended, so
    # the refusal below is attributable to the comment and to nothing else.
    assert _mod.instance_plist_environment("agent-alpha") == {"PATH": "/real/bin"}

    target.write_text(target.read_text() + "<!-- never closed\n")
    assert _mod.instance_plist_environment("agent-alpha") is None


def _unicode_only_whitespace() -> list[str]:
    """Codepoints ``str.strip()`` removes that the XML whitespace set does not.

    DERIVED from the production constant rather than enumerated by hand. Three
    hand-picked fillers were a sample of this domain, not the whole of it: at
    Python 3.12 the domain is 25 codepoints. Deriving it covers all of them and
    keeps the test correct if ``PLIST_XML_SPACE`` ever changes.
    """
    return [
        chr(cp)
        for cp in range(0x110000)
        if chr(cp).strip() == "" and chr(cp) not in _mod.PLIST_XML_SPACE
    ]


_UNICODE_ONLY_WHITESPACE = _unicode_only_whitespace()


def test_the_unicode_only_whitespace_domain_is_not_empty():
    """Guard against a vacuous parametrize.

    If the derivation ever yields an empty list the parametrized test below
    silently runs ZERO cases and reports green. Assert the domain is populated
    and still contains the three characters that motivated the fix.
    """
    assert len(_UNICODE_ONLY_WHITESPACE) >= 20
    for ch in ("\u00a0", "\x0c", "\x0b"):
        assert ch in _UNICODE_ONLY_WHITESPACE


@pytest.mark.parametrize(
    "filler", _UNICODE_ONLY_WHITESPACE, ids=lambda c: f"U+{ord(c):04X}"
)
def test_the_marker_to_dict_gap_uses_the_xml_whitespace_set(monkeypatch, tmp_path, filler):
    """glm-3. One gap in this reader still used a Unicode-wide strip.

    Body consumption was tightened to the four XML whitespace characters, but
    the check that only whitespace separates the EnvironmentVariables key from
    its dict kept `.strip()`, which also removes U+00A0, form feed and vertical
    tab. The system plist parser rejects all three, so this reader called a
    plist well-formed that launchd refuses to load, and then reported its
    contents as the service's governed environment.

    Pre-existing on main; taken here only because this reader is already open.
    """
    agents = tmp_path / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    target = agents / "com.whatsoup.agent-alpha.plist"
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod.Path, "home", classmethod(lambda cls: tmp_path))

    def _plist(gap: str) -> str:
        return (
            '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n'
            "  <key>Label</key>\n  <string>com.whatsoup.agent-alpha</string>\n"
            f"  <key>EnvironmentVariables</key>{gap}<dict>\n"
            "    <key>PATH</key><string>/fixture/pin/bin</string>\n"
            "  </dict>\n</dict>\n</plist>\n"
        )

    # Positive control: the same fixture with a LEGAL XML-whitespace gap parses,
    # so the refusal below is attributable to the filler and to nothing else.
    target.write_text(_plist("\n  "))
    assert _mod.instance_plist_environment("agent-alpha") == {"PATH": "/fixture/pin/bin"}

    target.write_text(_plist(f"\n {filler} "))
    assert _mod.instance_plist_environment("agent-alpha") is None, f"U+{ord(filler):04X}"


def test_only_the_dry_path_override_marks_the_governed_surfaces_not_applicable(
    monkeypatch, tmp_path
):
    """MED-2. Stubbing the probe's OUTPUT must not un-apply the plist checks.

    Exactly one environment variable may mark the governed surfaces
    not-applicable: BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH, which replaces the
    provider PATH at its source, so there is genuinely no plist-derived value
    left to govern.

    The probe-stub variables are a different kind of affordance. They replace
    what the CHILD PROCESS returns; they say nothing about whether this host has
    a LaunchAgent surface or whether that surface is readable. Letting them
    reach applicability meant a stub variable leaking into a deployed
    environment silently switched off every check this branch added: the plist
    could be missing, planted, symlinked or wrongly labelled and the default
    provider still reported healthy. This asserts the inverse, per variable:
    with a broken plist, each stub variable alone leaves the state UNREADABLE.
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
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_UNREADABLE,
        None,
    )

    # Each stub variable alone: still UNREADABLE. Both are asserted rather than
    # one, because either alone used to be sufficient to switch the checks off.
    for stub_variable, stub_value in (
        ("BOT_ERRORS_DRY_PROVIDER_PROBE_RC", "0"),
        ("BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT", "OK"),
    ):
        monkeypatch.setenv(stub_variable, stub_value)
        assert _mod.instance_plist_governed_environment("agent-alpha") == (
            _mod.GOVERNED_PLIST_UNREADABLE,
            None,
        ), f"{stub_variable} must not un-apply the governed plist checks"
        monkeypatch.delenv(stub_variable, raising=False)

    # The one affordance that legitimately does: it replaces the provider PATH
    # at its source, so no plist-derived governed value survives to compare.
    monkeypatch.setenv("BOT_ERRORS_DRY_INSTANCE_PROVIDER_PATH", "/fixture/dry/bin")
    assert _mod.instance_plist_governed_environment("agent-alpha") == (
        _mod.GOVERNED_PLIST_NOT_APPLICABLE,
        None,
    )


@pytest.mark.parametrize(
    "stub_variable,stub_value",
    [("BOT_ERRORS_DRY_PROVIDER_PROBE_RC", "0"), ("BOT_ERRORS_DRY_PROVIDER_PROBE_STDOUT", "OK")],
)
def test_a_leaked_probe_stub_variable_cannot_disable_the_plist_gate(
    monkeypatch, tmp_path, stub_variable, stub_value
):
    """MED-2, the consequence rather than the predicate.

    The unit row above pins the state; this one pins what an operator sees. A
    dry-probe variable present in a DEPLOYED environment is not a hypothetical:
    it is one exported line in a service plist or a shell profile away, and it
    is the same class of leak the dry-run PATH override is documented as. With
    the plist missing, the default provider must still refuse and name the
    plist as the problem. Before the fix it spawned and reported healthy, which
    is the fail-open itself: the checks this branch adds were silently off.

    provider_command_output is stubbed by _claude_probe, so the variable is
    never consumed here; its mere PRESENCE is what used to be load-bearing.
    """
    environment = _matrix_environment(tmp_path)
    target = _arm_darwin_plist(
        monkeypatch, tmp_path, "agent-alpha",
        {"PATH": environment["PATH"], "WHATSOUP_PATH_PREPEND": environment["WHATSOUP_PATH_PREPEND"]},
    )
    _break_plist(target, "missing", tmp_path)
    monkeypatch.setenv(stub_variable, stub_value)

    # Vacuity guard: the fixture really is unreadable, so a pass cannot come
    # from a plist that happens to parse.
    assert _mod.instance_plist_environment("agent-alpha") is None

    captured, lines = _claude_probe(monkeypatch, {}, dict(environment))

    assert not captured, "probe must not run a provider it cannot vouch for"
    assert "failure_class=provider_runtime_plist_unreadable" in lines[0], lines[0]
    _assert_fail_line_is_path_free(lines[0], tmp_path)
