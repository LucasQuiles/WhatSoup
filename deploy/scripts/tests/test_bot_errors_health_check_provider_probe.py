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


# --- provider_credential_presence: mirror lookupCredential (env -> keyring + migration -> .key store) ---
# 2026-06-23 fleet audit: provider keys live in ~/.config/whatsoup/credentials/<svc>.key (the file
# store lookupCredential consults after a keyring miss, keyring.ts:209), NOT the keychain, and NOT
# the ocw ~/.config/secrets/<svc>.env store. The health-check must check the .key store or it
# reports a runtime-resolvable key as missing (false negative — worst for glm, which has only
# glm.key). It must also try the glm->zai-api-key keyring migration the runtime uses.

class _FakeProc:
    def __init__(self, returncode: int, stdout: str) -> None:
        self.returncode = returncode
        self.stdout = stdout


def _arm_presence(monkeypatch, *, ocw_env_present, keychain_returncode, keychain_stdout, keyfile_present=False):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod, "service_env_var", lambda _service: "DEEPSEEK_API_KEY")
    monkeypatch.setattr(_mod, "dry_credential_status", lambda _service: None)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(_mod, "secret_file_has_service_key", lambda _service, _env_key: ocw_env_present)
    monkeypatch.setattr(_mod, "whatsoup_keyfile_present", lambda _service: keyfile_present)
    monkeypatch.setattr(
        _mod.subprocess,
        "run",
        lambda *_a, **_k: _FakeProc(keychain_returncode, keychain_stdout),
    )


def test_credential_presence_keychain_present_wins(monkeypatch):
    _arm_presence(monkeypatch, ocw_env_present=True, keychain_returncode=0, keychain_stdout="secret-value", keyfile_present=True)
    present, source, status = _mod.provider_credential_presence("deepseek", 15)
    assert present is True
    assert source == "macos_keychain"
    assert status == "present"


def test_credential_presence_keyfile_resolves_when_keychain_empty(monkeypatch):
    # THE FIX: the .key file store is the runtime's real backend -> RESOLVABLE even with empty keychain.
    _arm_presence(monkeypatch, ocw_env_present=False, keychain_returncode=1, keychain_stdout="", keyfile_present=True)
    present, source, status = _mod.provider_credential_presence("deepseek", 15)
    assert present is True
    assert source == "whatsoup_keyfile"
    assert status == "present"


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
