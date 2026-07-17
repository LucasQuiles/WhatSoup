from __future__ import annotations

import importlib.util
import os
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
    monkeypatch.setenv("FLEET_BIND_ADDRESS", "100.91.13.7")
    monkeypatch.delenv("BOT_ERRORS_FLEET_API_PORT", raising=False)

    assert _mod.fleet_api_default_url({}) == "http://100.91.13.7:9099"


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
    monkeypatch.setenv("FLEET_BIND_ADDRESS", "100.91.13.7")
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
    def fake_keyfile(service):
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
    monkeypatch.setattr(_mod, "whatsoup_keyfile_present", lambda _service: False)

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


def test_credential_presence_scoped_secret_tool_alias_keeps_requested_user(monkeypatch):
    commands = []
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "linux")
    monkeypatch.setattr(_mod.shutil, "which", lambda _command: "/usr/bin/secret-tool")
    monkeypatch.setattr(_mod, "service_env_var", lambda _service: "ZAI_API_KEY")
    monkeypatch.setattr(_mod, "dry_credential_status", lambda _service: None)
    monkeypatch.delenv("ZAI_API_KEY", raising=False)
    monkeypatch.setattr(_mod, "secret_file_has_service_key", lambda _service, _env_key: False)
    monkeypatch.setattr(_mod, "whatsoup_keyfile_present", lambda _service: False)

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
    monkeypatch.setattr(_mod, "whatsoup_keyfile_present", lambda _service: False)

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
