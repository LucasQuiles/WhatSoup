# D20 Provider Keychain Unlock Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BOT ERRORS provider credential diagnostics non-mutating by default while preserving an explicit, testable opt-in path for macOS login-keychain unlock probes.

**Architecture:** Keep credential inspection in `bot-errors-health-check.py`, but separate observation from mutation. The health check should always report credential item, secret, keychain access, GUI-session, and Claude state evidence; it should only call `security unlock-keychain` when an operator or profile explicitly allows that mutation.

**Tech Stack:** Python 3 standard library, pytest, Vitest health-check integration tests, BOT ERRORS runtime-manifest guard.

**Status:** active — implemented in local compose branch `integration/provider-hardening-compose-refresh-20260613T194657Z`, not yet pushed or landed on `main`. The approval boundary now applies to publishing/merging the compose branch, not to reimplementing this plan.

---

## Current Evidence

- Current local compose branch: `integration/provider-hardening-compose-refresh-20260613T194657Z`.
- Current local compose head when this plan was written: `0ed8deac9a073ef533393722c750644ac9b92136`.
- Current `origin/main` when this plan was written: `f65c3990f8c203978bd4b51affe7ee5f97e79024`.
- `deploy/scripts/bot-errors-health-check.py:3118` defines `provider_keychain_unlock_status(...)`.
- `deploy/scripts/bot-errors-health-check.py:3456` unconditionally appends `keychain_unlock_status=<...>` by calling `security unlock-keychain -p "" ~/Library/Keychains/login.keychain-db` for `claude-cli` credential diagnostics.
- `deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py:73` pins the current unconditional behavior with `test_provider_credential_probe_unlocks_and_pins_login_keychain`.
- The global workstation instructions correctly warn that SSH shells can see false Claude OAuth negatives until the login keychain is readable. That is diagnostic evidence for an unlock capability; it is not enough to make every health-check probe mutate keychain state by default.

## Risk Statement

The current probe is useful but overconfident: a read-only health check can unlock the login keychain as a side effect, then present later credential probes as if they were observed in the original runtime state. That makes headless credential failures harder to reason about, changes host state during diagnostics, and turns an evidence-gathering path into an implicit remediation path.

## Local Compose Outcome

- Default provider credential diagnostics now emit `keychain_unlock_policy=observe_only` and `keychain_unlock_status=skipped`.
- `security unlock-keychain -p "" ~/Library/Keychains/login.keychain-db` is only called when `BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK=1` or `providerCredentialUnlockKeychain` is true on the profile/item.
- Item-level `providerCredentialUnlockKeychain: false` overrides profile and environment opt-ins.
- Existing credential item, secret, keychain access, Claude state, and GUI-session probes remain active in observe-only mode.
- `deploy/bot-errors-runtime-manifest.json` tracks the changed `bot-errors-health-check.py` hash.

## Decision Record

| Option | Verdict | Reason |
|---|---|---|
| Default to observe-only and skip unlock unless explicitly enabled | Recommended | Preserves diagnostic integrity and avoids silent host-state mutation. |
| Keep unconditional unlock | Reject unless owner approves an exception | It hides whether the provider worked before remediation and makes health checks invasive. |
| Remove unlock support entirely | Reject | macOS fleet diagnostics still need an explicit remediation probe for SSH/keychain visibility failures. |
| Enable unlock by environment flag only | Acceptable minimum | Easy to test and operate; enough for targeted diagnostics. |
| Enable unlock by profile field and environment flag | Recommended | Lets fleet inventory opt in per target while still supporting ad hoc operator runs. |
| Store or print keychain secrets for proof | Reject | The health check must never emit raw keychain values. |

## File Structure

- Modify: `deploy/scripts/bot-errors-health-check.py`
  - Add a small `provider_keychain_unlock_allowed(profile, item)` helper.
  - Add `keychain_unlock_policy=<observe_only|enabled>` evidence.
  - Return `keychain_unlock_status=skipped` when unlock is not allowed.
  - Preserve existing `find-generic-password` and `show-keychain-info` probes.
- Modify: `deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`
  - Replace the current unconditional-unlock test with default-skip and explicit-opt-in tests.
  - Keep command assertions for the pinned `login.keychain-db` path in the opt-in test.
- Modify if integration evidence changes: `tests/scripts/bot-errors-health-check.test.ts`
  - Update expected evidence if any fixture currently assumes unconditional `keychain_unlock_status=ok`.
- Modify: `deploy/bot-errors-runtime-manifest.json`
  - Regenerate the `bot-errors-health-check.py` hash after implementation.
- Modify if manifest expectations need the new hash: `tests/scripts/bot-errors-health-check.test.ts`
  - Keep runtime-manifest integrity coverage green.
- Modify: `docs/superpowers/plans/2026-06-13-outstanding-burndown.md`
  - Mark D20 as planned, then implemented only after code lands.
- Modify: `docs/work-index.md` and `docs/work-index.json`
  - Regenerate after adding or changing this plan.

## Compatibility Contract

- Do not print raw keychain secret output.
- Do not print raw keychain paths in operator-visible evidence unless existing redaction already permits it.
- Keep `credential_backend=macos_keychain`, `credential_service=...`, `credential_account=...`, `credential_item_status=...`, `credential_secret_status=...`, and `keychain_access_status=...`.
- Keep headless-context classification:
  - `provider_auth_context=headless_login_keychain_blocked`
  - `provider_auth_context=recent_reboot_headless_keychain_risk`
  - `provider_auth_context=noninteractive_probe_keychain_blocked`
- Preserve dry-test support through `provider_command_output(...)` and existing `BOT_ERRORS_DRY_PROVIDER_*` environment variables.
- Only `claude-cli` provider credential diagnostics are in scope.
- Runtime unlock support remains macOS-only unless dry-test environment variables force execution in tests.

## Proposed Evidence Fields

- `keychain_unlock_policy=observe_only` when no operator/profile opt-in is present.
- `keychain_unlock_status=skipped` when policy is observe-only.
- `keychain_unlock_policy=enabled` when an operator/profile opt-in is present.
- `keychain_unlock_status=<ok|empty|missing|user_interaction_required|timeout|rc_N|probe_error_...>` when policy is enabled.

## Proposed Operator Controls

- Environment flag: `BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK=1`.
- Profile or item boolean: `providerCredentialUnlockKeychain`.
- Precedence: profile/item opt-in or environment opt-in enables unlock; absence disables unlock.
- Explicit false in profile/item should disable profile-level inheritance for that item if the implementation already has a safe boolean profile reader. If not, implement only positive opt-in and document that item-level false is unsupported in this slice.

## Task 1: Add Default Observe-Only Test

**Files:**
- Modify: `deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`

- [ ] **Step 1: Rename the current unconditional test**

Change:

```python
def test_provider_credential_probe_unlocks_and_pins_login_keychain(monkeypatch):
```

to:

```python
def test_provider_credential_probe_skips_keychain_unlock_by_default(monkeypatch):
```

- [ ] **Step 2: Add environment cleanup at the start of the test**

Add this after the existing `HOST_PLATFORM` monkeypatch:

```python
    monkeypatch.delenv("BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK", raising=False)
```

- [ ] **Step 3: Change the expected fragments**

Replace:

```python
    assert "keychain_unlock_status=ok" in fragments
```

with:

```python
    assert "keychain_unlock_policy=observe_only" in fragments
    assert "keychain_unlock_status=skipped" in fragments
```

- [ ] **Step 4: Change the command assertion**

Replace:

```python
    assert ["security", "unlock-keychain", "-p", "", keychain_path] in commands
```

with:

```python
    assert ["security", "unlock-keychain", "-p", "", keychain_path] not in commands
```

- [ ] **Step 5: Run the test and verify it fails red**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py::test_provider_credential_probe_skips_keychain_unlock_by_default -q > /tmp/d20-red.log 2>&1; echo "pytest-exit=$?"
```

Expected before implementation: nonzero exit because the existing code still emits `keychain_unlock_status=ok` and calls `security unlock-keychain`.

## Task 2: Add Explicit Opt-In Unlock Test

**Files:**
- Modify: `deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`

- [ ] **Step 1: Add an environment opt-in test**

Add this test below the default observe-only test:

```python
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
```

- [ ] **Step 2: Run the new opt-in test and verify it fails red**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py::test_provider_credential_probe_unlocks_when_env_opted_in -q > /tmp/d20-optin-red.log 2>&1; echo "pytest-exit=$?"
```

Expected before implementation: nonzero exit because `keychain_unlock_policy=enabled` is not emitted.

## Task 3: Implement Unlock Policy Helper

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py`

- [ ] **Step 1: Add a strict boolean reader for profile/item values**

Place this helper near `profile_string(...)` or the other profile readers:

```python
def profile_bool(scope: dict[str, Any], key: str) -> bool | None:
    raw = scope.get(key)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        normalized = raw.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return None
```

- [ ] **Step 2: Add the unlock policy helper**

Place this near `provider_keychain_unlock_status(...)`:

```python
def provider_keychain_unlock_allowed(profile: dict[str, Any], item: dict[str, Any]) -> bool:
    item_value = profile_bool(item, "providerCredentialUnlockKeychain")
    if item_value is not None:
        return item_value
    profile_value = profile_bool(profile, "providerCredentialUnlockKeychain")
    if profile_value is not None:
        return profile_value
    return env_flag("BOT_ERRORS_PROVIDER_KEYCHAIN_UNLOCK", False)
```

- [ ] **Step 3: Gate the unlock call**

Replace:

```python
    keychain_path = Path.home() / "Library" / "Keychains" / "login.keychain-db"
    fragments.append(f"keychain_unlock_status={provider_keychain_unlock_status(keychain_path, timeout_seconds)}")
```

with:

```python
    keychain_path = Path.home() / "Library" / "Keychains" / "login.keychain-db"
    if provider_keychain_unlock_allowed(profile, item):
        fragments.append("keychain_unlock_policy=enabled")
        fragments.append(f"keychain_unlock_status={provider_keychain_unlock_status(keychain_path, timeout_seconds)}")
    else:
        fragments.append("keychain_unlock_policy=observe_only")
        fragments.append("keychain_unlock_status=skipped")
```

- [ ] **Step 4: Run the focused Python tests and verify green**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py -q > /tmp/d20-provider-probe-green.log 2>&1; echo "pytest-exit=$?"
```

Expected after implementation: `pytest-exit=0`.

## Task 4: Add Profile/Item Precedence Tests

**Files:**
- Modify: `deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`

- [ ] **Step 1: Add a profile opt-in test**

Add:

```python
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
```

- [ ] **Step 2: Add an item-level explicit false test**

Add:

```python
def test_provider_credential_probe_item_false_overrides_profile_unlock(monkeypatch):
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
```

- [ ] **Step 3: Run the focused Python tests**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py -q > /tmp/d20-provider-probe-precedence.log 2>&1; echo "pytest-exit=$?"
```

Expected: `pytest-exit=0`.

## Task 5: Update TypeScript Integration Expectations If Needed

**Files:**
- Inspect and possibly modify: `tests/scripts/bot-errors-health-check.test.ts`

- [ ] **Step 1: Search for hardcoded unlock status assumptions**

Run:

```bash
rg -n "keychain_unlock_status|keychain_unlock_policy|unlock-keychain" tests/scripts/bot-errors-health-check.test.ts
```

- [ ] **Step 2: If a fixture expects unconditional unlock success, update it**

Use expected evidence like:

```ts
expect(event.evidence).toContain('keychain_unlock_policy=observe_only');
expect(event.evidence).toContain('keychain_unlock_status=skipped');
```

- [ ] **Step 3: Preserve existing auth-context assertions**

Keep assertions like:

```ts
expect(event.evidence).toContain('provider_auth_context=headless_login_keychain_blocked');
expect(event.evidence).toContain('provider_auth_context=noninteractive_probe_keychain_blocked');
```

- [ ] **Step 4: Run the TypeScript integration test**

Run:

```bash
npm test -- --pool=forks --fileParallelism=false tests/scripts/bot-errors-health-check.test.ts > /tmp/d20-health-check-ts.log 2>&1; echo "vitest-exit=$?"
```

Expected: `vitest-exit=0`.

## Task 6: Regenerate Manifest Hash And Docs

**Files:**
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `docs/superpowers/plans/2026-06-13-outstanding-burndown.md`
- Modify: `docs/work-index.md`
- Modify: `docs/work-index.json`

- [ ] **Step 1: Regenerate or update BOT ERRORS runtime manifest hashes**

Use the repository's existing manifest update path. If there is no update command, run the manifest guard, read its expected hash output, and update only the `deploy/scripts/bot-errors-health-check.py` entry.

Run:

```bash
npm run guard:bot-errors-runtime-manifest > /tmp/d20-manifest-before.log 2>&1; echo "manifest-exit=$?"
```

Expected before hash update: nonzero exit if `bot-errors-health-check.py` changed and the manifest is stale; zero exit after updating the manifest.

- [ ] **Step 2: Mark D20 implemented only after code is green**

In `docs/superpowers/plans/2026-06-13-outstanding-burndown.md`, change the D20 row from "separate decision" to "implemented in local branch" only after the code and manifest checks pass.

- [ ] **Step 3: Regenerate work index**

Run:

```bash
npm run work-index:regen > /tmp/d20-work-index-regen.log 2>&1; echo "work-index-regen-exit=$?"
npm run guard:work-index > /tmp/d20-work-index-check.log 2>&1; echo "work-index-check-exit=$?"
```

Expected: both exit markers are `0`.

## Task 7: Validation Ladder

**Files:**
- No new files beyond the implementation/test/docs set.

- [ ] **Step 1: Python focused tests**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py -q > /tmp/d20-provider-probe-final.log 2>&1; echo "pytest-exit=$?"
```

Expected: `pytest-exit=0`.

- [ ] **Step 2: Python deploy tests if shared deploy script behavior changed broadly**

Run:

```bash
python3 -m pytest deploy/scripts/tests/ -q > /tmp/d20-deploy-pytest.log 2>&1; echo "pytest-exit=$?"
```

Expected: `pytest-exit=0`.

- [ ] **Step 3: TypeScript health-check integration**

Run:

```bash
npm test -- --pool=forks --fileParallelism=false tests/scripts/bot-errors-health-check.test.ts > /tmp/d20-health-check-final.log 2>&1; echo "vitest-exit=$?"
```

Expected: `vitest-exit=0`.

- [ ] **Step 4: Runtime manifest guard**

Run:

```bash
npm run guard:bot-errors-runtime-manifest > /tmp/d20-runtime-manifest-final.log 2>&1; echo "manifest-exit=$?"
```

Expected: `manifest-exit=0`.

- [ ] **Step 5: Test Integrity on changed tests**

Run:

```bash
"$HOME/.claude/plugins/test-integrity/scripts/test-integrity" scan --ci deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py tests/scripts/bot-errors-health-check.test.ts > /tmp/d20-test-integrity.log 2>&1; echo "test-integrity-exit=$?"
```

Expected: `test-integrity-exit=0`.

- [ ] **Step 6: Full branch gate**

Run:

```bash
npm run verify:push:branch > /tmp/d20-verify-push-branch.log 2>&1; echo "verify-exit=$?"
```

Expected: `verify-exit=0`.

## Task 8: Commit Hygiene

**Files:**
- Stage only D20 implementation, tests, manifest, and docs.

- [ ] **Step 1: Review branch state**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: no unrelated files and `git diff --check` emits no whitespace errors.

- [ ] **Step 2: Commit after green focused tests**

Run:

```bash
git add deploy/scripts/bot-errors-health-check.py deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py tests/scripts/bot-errors-health-check.test.ts deploy/bot-errors-runtime-manifest.json docs/superpowers/plans/2026-06-13-outstanding-burndown.md docs/work-index.md docs/work-index.json
git commit -m "fix: make provider keychain unlock diagnostics opt-in"
```

If `tests/scripts/bot-errors-health-check.test.ts` was not changed, omit it from `git add`.

- [ ] **Step 3: Commit plan-only update if implementation is deferred**

Run:

```bash
git add -f docs/superpowers/plans/2026-06-13-d20-provider-keychain-unlock-policy.md
git add docs/superpowers/plans/2026-06-13-outstanding-burndown.md docs/work-index.md docs/work-index.json
git commit -m "docs: add D20 keychain unlock policy plan"
```

Use this commit path only if no runtime code was changed.

## Approval Boundary

- No push, PR, merge, force-push, or branch deletion is part of this plan without named operator approval.
- If implemented in the current compose branch, publish only as part of the compose branch after rechecking draft PR collisions and getting explicit approval.
- If implemented as a separate branch, branch from current `origin/main`, not from the compose branch, unless the operator explicitly requests a compose-only follow-up.

## Rollback

- Revert the implementation commit to return to current unconditional unlock behavior.
- If only the plan was committed, revert the docs commit or mark the plan superseded by the chosen policy.

## Self-Review

- Spec coverage: D20 keychain mutation policy, tests, manifest, docs, work-index, and approval boundaries are covered.
- Placeholder scan: no unresolved placeholder markers or unspecified test steps remain.
- Type consistency: helper names and evidence field names are consistent across the implementation tasks.
