# macOS Credential Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make credential reads and mutations bounded and file-safe on macOS, remove request-time keychain warning storms, and preload canonical per-instance health tokens without duplicating them in launchd configuration.

**Architecture:** Harden shared private-file primitives first. Then make `keyring.ts` distinguish unscoped file-first resolution from account-scoped Keychain-only resolution. Finally, reuse the descriptor-safe health-token reader in the launch wrapper and bound macOS `security` through the pinned Node runtime.

**Tech Stack:** TypeScript 5.9, Node.js 24.15.0, Vitest 4.1.8 with `--pool=forks`, Bash with `set -euo pipefail`, macOS `security`, Linux `secret-tool`.

## Global Constraints

- Work only in the isolated branch rooted at live `origin/main`.
- Tests must fail before production edits and pass afterward; masked failures are inconclusive.
- Every synchronous `security` and `secret-tool` child uses a 3,000 ms timeout and `SIGKILL` when Node owns the child.
- Credential values stay off argv, logs, errors, reports, and test output.
- User-scoped lookups and mutations never use an unscoped `<service>.key` file.
- Preserve database-compatibility and restart-preflight ordering in `deploy/whatsoup`.
- Do not change the native OAuth credential-heal path.
- Do not push, build a release, deploy, restart, or mutate credentials before Hold Point A.
- Reuse commits `d481bfe1b808638c0ea282663fce86a64ad00299`, `8b4aa58ef`, `85ac4eb4f`, and `5b3bc9628` selectively; never cherry-pick their unrelated changes.

---

### Task 1: Hardened Private Credential File Primitives

**Files:**
- Modify: `src/lib/private-fs.ts`
- Modify: `tests/lib/private-fs.test.ts`

**Interfaces:**
- Consumes: `forceEnsurePrivateDirectorySync`, `assertWritablePrivateFileSync`, and `fsyncDirectory`.
- Produces: `writeAtomicPrivateFileSync(filePath: string, data: string | Buffer, label?: string): void`.
- Produces: `readPrivateFileSync(filePath: string, options: { label?: string; maxBytes: number }): string | null`.
- Produces: `deletePrivateFileSync(filePath: string, label?: string): boolean`.

- [ ] **Step 1: Add failing private-file tests**

Port only the `atomic private-file primitives` tests and required imports from:

```bash
git show d481bfe1b808638c0ea282663fce86a64ad00299:tests/lib/private-fs.test.ts
```

Keep cases for exclusive random temporary paths, file-before-directory fsync ordering, cleanup after rename/fsync failure, symlink/directory/FIFO rejection, bounded reads, private modes, symlinked directories, and directory fsync after deletion.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh exec -- vitest run tests/lib/private-fs.test.ts --pool=forks
```

Expected: FAIL because the three exports do not exist. Any unrelated failure must be fixed before implementation.

- [ ] **Step 3: Port the minimal proven implementation**

Port the `randomUUID`, `readSync`, and `Stats` imports, validators, and three exported functions from `d481bfe1b808638c0ea282663fce86a64ad00299:src/lib/private-fs.ts`. Preserve these flags and sequence:

```ts
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
  constants.O_NOFOLLOW | constants.O_NONBLOCK;
// write -> fchmod(0600) -> fsync(file) -> close -> rename -> fsyncDirectory(dir)
```

`readPrivateFileSync` allocates `maxBytes + 1`, returns `null` only for `ENOENT`, and throws on unsafe existing paths. Replace the duplicate marker body with:

```ts
export function writePrivateJsonMarkerSync(filePath: string, value: unknown): void {
  writeAtomicPrivateFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'marker');
}
```

- [ ] **Step 4: Prove GREEN and commit**

```bash
bash scripts/run-with-pinned-npm.sh exec -- vitest run tests/lib/private-fs.test.ts --pool=forks
$HOME/.claude/plugins/test-integrity/scripts/test-integrity scan tests/lib/private-fs.test.ts
git diff --check
git add src/lib/private-fs.ts tests/lib/private-fs.test.ts
git commit -m "refactor(security): add hardened private credential files"
```

Expected: tests pass, scan has no findings, and diff check is silent.

---

### Task 2: Resolver Ordering, Bounds, Mirroring, and Warning Deduplication

**Files:**
- Modify: `src/lib/keyring.ts`
- Modify: `tests/lib/keyring.test.ts`
- Modify: `tests/lib/keyring-warn.test.ts`
- Modify: `tests/lib/keyring-write.test.ts`
- Modify: `tests/lib/health-token-keyring.test.ts`
- Modify: `tests/lib/keyring-opencode-auth.test.ts`
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`

**Interfaces:**
- Consumes: Task 1 private-file functions.
- Preserves: `lookupCredential`, `writeCredential`, `deleteCredential`, and their return types.
- Produces: unscoped env → private file → bounded keyring → OpenCode resolution.
- Produces: scoped bounded keyring → allowed env → OpenCode resolution with no private-file access.

- [ ] **Step 1: Write failing ordering, timeout, mutation, and warning tests**

Add exact cases proving an unscoped mode-0600 file short-circuits Keychain, a user-scoped miss cannot read that file, and every child call has:

```ts
expect(options).toEqual(expect.objectContaining({
  timeout: 3_000,
  killSignal: 'SIGKILL',
}));
```

Add cases proving unscoped macOS writes mirror the file, scoped writes do not, mirror failure is sanitized and removes a stale shadow in the tested cleanup path, unscoped deletes attempt both layers, scoped deletes leave the file untouched, and Keychain delete failure cannot report `deleted: true`.

Add warning-dedupe coverage:

```ts
lookupCredential('anthropic', { skipEnv: true });
lookupCredential('anthropic', { skipEnv: true });
lookupCredential('openai', { skipEnv: true });
expect(logWarn).toHaveBeenCalledTimes(2);
```

Update the Python diagnostic contract so unscoped file-first ordering and scoped file exclusion match runtime behavior.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/lib/keyring.test.ts tests/lib/keyring-warn.test.ts \
  tests/lib/keyring-write.test.ts tests/lib/health-token-keyring.test.ts \
  tests/lib/keyring-opencode-auth.test.ts --pool=forks
PYTHONDONTWRITEBYTECODE=1 python3.12 -m pytest -q -p no:cacheprovider \
  deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py
```

Expected: failures identify old keyring-before-file ordering, five-second/no-kill bounds, missing mirror behavior, and repeated warnings.

- [ ] **Step 3: Implement the contract**

Use these exact imports and constants:

```ts
import {
  deletePrivateFileSync,
  readPrivateFileSync,
  writeAtomicPrivateFileSync,
} from './private-fs.ts';

const KEYRING_COMMAND_TIMEOUT_MS = 3_000;
const FILE_STORE_MAX_BYTES = 4_096;
const warnedKeyringReadServices = new Set<string>();
const keyringExecOptions = {
  timeout: KEYRING_COMMAND_TIMEOUT_MS,
  killSignal: 'SIGKILL' as const,
};
```

Normal lookup: mapped env, `fileStoreRead(service)`, backend candidates, OpenCode. Scoped lookup: backend candidates, allowed env, OpenCode; never call `fileStoreRead`. Preserve migration aliases in the backend loop. `_resetBackendCache()` also clears the warned-service set for test isolation.

Validate service names before paths; reject empty, `/`, `\\`, and NUL. Use `readPrivateFileSync` with `maxBytes: 4_096`, `writeAtomicPrivateFileSync(..., 'credential')`, and `deletePrivateFileSync(..., 'credential')`.

Only `options.user === undefined` uses macOS dual-store behavior. Keychain succeeds before atomic mirror; mirror failure attempts file cleanup and throws sanitized `KEYRING_WRITE_FAILED`. Unscoped delete attempts both layers and succeeds only when Keychain deletion succeeded and the file is absent.

Apply `keyringExecOptions` to all `security` and `secret-tool` calls, retaining each call's existing `stdio`, `input`, and parsing.

- [ ] **Step 4: Prove GREEN, scan, typecheck, and commit**

```bash
bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/lib/private-fs.test.ts tests/lib/keyring.test.ts \
  tests/lib/keyring-warn.test.ts tests/lib/keyring-write.test.ts \
  tests/lib/health-token-keyring.test.ts tests/lib/keyring-opencode-auth.test.ts \
  --pool=forks
PYTHONDONTWRITEBYTECODE=1 python3.12 -m pytest -q -p no:cacheprovider \
  deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py
$HOME/.claude/plugins/test-integrity/scripts/test-integrity scan \
  tests/lib/private-fs.test.ts tests/lib/keyring.test.ts tests/lib/keyring-warn.test.ts \
  tests/lib/keyring-write.test.ts tests/lib/health-token-keyring.test.ts \
  tests/lib/keyring-opencode-auth.test.ts \
  deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git add src/lib/keyring.ts tests/lib/keyring*.test.ts \
  tests/lib/health-token-keyring.test.ts \
  deploy/scripts/bot-errors-health-check.py \
  deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py
git commit -m "fix(security): bound and prioritize credential sources"
```

Expected: all focused checks pass. Existing Vitest configuration warnings remain disclosed and are not called pristine.

---

### Task 3: Descriptor-Safe Health Token Preload and Documentation

**Files:**
- Create: `src/fleet/health-token-file.ts`
- Create: `deploy/lib/read-private-health-token.mjs`
- Create: `deploy/lib/read-private-health-token.sh`
- Create: `tests/fleet/health-token-file.test.ts`
- Modify: `deploy/whatsoup`
- Modify: `tests/deploy/whatsoup-health-token-wrapper.test.ts`
- Modify: `deploy/check-health-token-keyring.sh`
- Modify: `docs/configuration.md`
- Modify: `docs/runbooks/macos-launchd-deployment.md`
- Modify: `docs/security-handoffs/2026-05-09-env-secret-exposure.md`

**Interfaces:**
- Produces: `readPrivateHealthTokenFileSync(filePath: string): CanonicalHealthToken | null`.
- Produces: `whatsoup_read_private_health_token(node, reader, token_file)`.
- Produces: wrapper env → per-instance file → scoped Keychain → legacy Keychain precedence.

- [ ] **Step 1: Port and adapt failing reader/wrapper tests**

Port `tests/fleet/health-token-file.test.ts` and the private-file wrapper scenarios from commit `8b4aa58ef`. Keep the canonical 64-hex token fixture and cases for preloaded env short-circuit, safe file short-circuit on Darwin/Linux, absent file fallback, unsafe mode/owner/symlink/malformed/duplicate rejection without disclosure, and a hanging Darwin child bounded by the five-second outer harness timeout. Adapt the earlier branch so an existing env value remains authoritative.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/fleet/health-token-file.test.ts \
  tests/deploy/whatsoup-health-token-wrapper.test.ts --pool=forks
```

Expected: FAIL because the reader files and wrapper precedence do not exist.

- [ ] **Step 3: Port the descriptor-safe reader and bounded Keychain helper**

Port selectively:

```bash
git show 8b4aa58ef:src/fleet/health-token-file.ts
git show 85ac4eb4f:deploy/lib/read-private-health-token.mjs
git show 85ac4eb4f:deploy/lib/read-private-health-token.sh
git show 5b3bc9628:deploy/whatsoup
```

Retain `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, `fstatSync`, identity checks, exact mode 0600, current-uid ownership, the 87-byte maximum, NUL-terminated path input, and secret-free errors. The Node-backed macOS helper retains `timeout: 3_000`, `killSignal: 'SIGKILL'`, `maxBuffer: 4_096`, ignored stdin/stderr, and service/account-only argv.

- [ ] **Step 4: Implement wrapper precedence without moving gates**

Source the reader after pinned Node resolution. Keep all database/restart gates in place. After `XDG_CONFIG` exists, implement:

```bash
if [ -z "${WHATSOUP_HEALTH_TOKEN:-}" ]; then
  HEALTH_TOKEN_FILE="$XDG_CONFIG/whatsoup/instances/$INSTANCE/tokens.env"
  if [ -e "$HEALTH_TOKEN_FILE" ] || [ -L "$HEALTH_TOKEN_FILE" ]; then
    WHATSOUP_HEALTH_TOKEN="$(whatsoup_read_private_health_token \
      "$NODE" "$SCRIPT_DIR/lib/read-private-health-token.mjs" "$HEALTH_TOKEN_FILE")"
  fi
fi
if [ -z "${WHATSOUP_HEALTH_TOKEN:-}" ]; then
  WHATSOUP_HEALTH_TOKEN="$(keyring_lookup whatsoup-health-token "" user "$INSTANCE")"
fi
if [ -z "${WHATSOUP_HEALTH_TOKEN:-}" ]; then
  WHATSOUP_HEALTH_TOKEN="$(keyring_lookup whatsoup_health WHATSOUP_HEALTH_TOKEN)"
fi
[ -z "${WHATSOUP_HEALTH_TOKEN:-}" ] || export WHATSOUP_HEALTH_TOKEN
```

- [ ] **Step 5: Update docs and diagnostics**

Document unscoped `$XDG_CONFIG_HOME/whatsoup/credentials/<service>.key` separately from per-instance `$XDG_CONFIG_HOME/whatsoup/instances/<instance>/tokens.env`. Update the checker header, configuration reference, macOS runbook, and W-5 handoff with scoped/unscoped precedence and the no-plaintext-launchd target.

- [ ] **Step 6: Prove GREEN, run guards, and commit**

```bash
bash scripts/run-with-pinned-npm.sh exec -- vitest run \
  tests/lib/private-fs.test.ts tests/lib/keyring.test.ts \
  tests/lib/keyring-warn.test.ts tests/lib/keyring-write.test.ts \
  tests/lib/health-token-keyring.test.ts tests/lib/keyring-opencode-auth.test.ts \
  tests/fleet/health-token-file.test.ts \
  tests/deploy/whatsoup-health-token-wrapper.test.ts --pool=forks
$HOME/.claude/plugins/test-integrity/scripts/test-integrity scan \
  tests/lib/private-fs.test.ts tests/lib/keyring.test.ts tests/lib/keyring-warn.test.ts \
  tests/lib/keyring-write.test.ts tests/lib/health-token-keyring.test.ts \
  tests/lib/keyring-opencode-auth.test.ts tests/fleet/health-token-file.test.ts \
  tests/deploy/whatsoup-health-token-wrapper.test.ts
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
bash scripts/run-with-pinned-npm.sh run guard:deployer-static
git diff --check
git add src/fleet/health-token-file.ts deploy/lib/read-private-health-token.* \
  tests/fleet/health-token-file.test.ts deploy/whatsoup \
  tests/deploy/whatsoup-health-token-wrapper.test.ts \
  deploy/check-health-token-keyring.sh docs/configuration.md \
  docs/runbooks/macos-launchd-deployment.md \
  docs/security-handoffs/2026-05-09-env-secret-exposure.md
git commit -m "fix(deploy): preload private health tokens safely"
```

Expected: tests, typecheck, guards, integrity, and diff checks pass; masked or skipped checks remain gaps.

---

### Task 4: Independent Verification and Hold Point A Packet

**Files:**
- Record: `.superpowers/sdd/progress.md` and generated review packages (ignored scratch evidence).
- Modify production files only for concrete reviewer findings.

**Interfaces:**
- Consumes: Tasks 1–3 commits and the design contract.
- Produces: independent task reviews, final branch review, and the Hold Point A packet.

- [ ] **Step 1: Review each task range**

Generate an SDD review package from the recorded pre-task base through each task head. A fresh reviewer checks the brief, report, diff, tests, and reuse report. Important findings go to one bounded fix worker and then re-review.

- [ ] **Step 2: Run final clean-worktree verification**

Repeat Task 3's full gate set, then run:

```bash
git status --short
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: clean worktree, no whitespace errors, intended commits only.

- [ ] **Step 3: Audit fleet file state without values**

For every target host, capture presence, owner, mode, and byte count for `credentials/*.key` and per-instance `tokens.env`. Any unexpected `.key` stops that host until its relationship to the active credential is proven without disclosure.

- [ ] **Step 4: Stop at Hold Point A**

Present the reviewed commit range, test receipts, stale-file audit, rollback plan, and controlled-restart acceptance contract: one PID transition, exactly one legitimate online notice, zero duplicate or queued replays within five minutes, an empty outbound queue, resumed watchdog checks, and a warning rate near zero compared with the measured 1,791/hour baseline. Do not push, deploy, restart, or mutate credentials until the owner explicitly authorizes Hold Point A.
