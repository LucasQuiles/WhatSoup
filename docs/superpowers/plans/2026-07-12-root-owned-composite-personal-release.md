# Root-Owned Composite Personal-Instance Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build candidate and rollback releases that include private target-local configuration and exact launch definitions, seal them below root-owned trust roots, and make the personal-instance controller activate or restore them only through a narrow privileged boundary.

**Architecture:** Keep Git checkout and dependency assembly unprivileged, then pass one verified staging payload plus schema-valid target-local inputs to a root-only composite finalizer. The finalizer renders launchd artifacts, inventories and seals code/toolchain/config/plists, applies service-UID read/execute ACLs, and publishes with no replacement. The controller retains policy and sequencing, but every production filesystem/control mutation crosses one typed privileged client. Human actor identity is journaled at inbound admission, and live main-job expectations are derived from the exact signed plist bytes.

**Tech Stack:** TypeScript ESM, Node.js 24.15.0, npm 11.12.1, `node:sqlite`, launchd/launchctl on macOS, POSIX descriptors and macOS ACL tools, Vitest, the existing release materializer and cutover controller.

## Global constraints

- The service UID never owns or can write a deployed release object, public release link, config, plist, signed plan, authoritative journal, terminal receipt, or rollback payload.
- The privileged helper accepts no shell text, credential value, token, email body, WhatsApp content, or caller-selected destination.
- Every destination is derived from a verified signed plan or exact-key descriptor below compiled root-owned prefixes.
- Candidate and rollback main expectations come only from their exact plist identities; no second editable argv or CWD contract exists.
- A required Microsoft 365 capability cannot use missing, empty, relative, user-home-equivalent, wrong-owner, or non-private `cwd`.
- LID-to-phone identity is captured in the inbound SQLite transaction and cannot be upgraded by a later mutable mapping.
- Publication is atomic no-replace, recursively durable, and followed by a complete post-link child inventory recheck.
- Before acceptance, failure restores sealed rollback through the privileged helper. After acceptance, failure contains forward.
- Unit tests cannot prove root ownership or macOS ACL behavior; a target-local root rehearsal remains a distinct required gate.
- This plan does not authorize a live restart, cutover, Graph mutation, email, ClickUp write, or WhatsApp send.

---

### Task 1: Define trusted-path and composite artifact contracts

**Files:**
- Create: `scripts/personal-release-contract.ts`
- Create: `scripts/trusted-path.ts`
- Create: `tests/scripts/personal-release-contract.test.ts`
- Create: `tests/scripts/trusted-path.test.ts`

**Interfaces:**

```ts
export type CompositeProvenance =
  | { readonly class: 'commit_derived'; readonly sourceRelativePath: string }
  | { readonly class: 'target_local'; readonly sourceIdentity: StableFilesystemIdentity; readonly sourcePathSha256: string }
  | { readonly class: 'generated'; readonly rendererSha256: string; readonly inputsSha256: string }
  | { readonly class: 'toolchain'; readonly sourceIdentity: StableFilesystemIdentity };

export interface PersonalReleaseRenderDescriptorV1 {
  readonly schemaVersion: 1;
  readonly instance: string;
  readonly finalPayloadPath: string;
  readonly installedConfigPath: string;
  readonly serviceUid: number;
  readonly health: { readonly host: '127.0.0.1'; readonly port: number };
  readonly labels: { readonly main: string; readonly watchdog: string; readonly replyGuarantee: string };
  readonly environmentKeys: readonly string[];
}

export function openStableRegularFile(filePath: string, policy: OpenPolicy): StableOpenFile;
export function recheckStableOpenFile(file: StableOpenFile): void;
export function authenticateAncestorChain(filePath: string, policy: RootPolicy): TrustedAncestorChain;
```

- [ ] Write failing tests for malformed exact-key inputs, final/ancestor symlinks, hard links, mutable files, wrong owner/mode, path aliases, changed-during-read files, and ancestor drift.
- [ ] Require normalized absolute paths; no-follow opens; unique-link regular files; stable dev/inode/uid/gid/nlink; and parent identity rechecks.
- [ ] Define manifest/receipt schema v2 entries with owner, group, mode, ACL digest, flags, device, inode, size, SHA-256, and provenance.
- [ ] Keep absolute private source paths out of public receipts; bind a path digest and bounded identity instead.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/scripts/personal-release-contract.test.ts \
  tests/scripts/trusted-path.test.ts --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
```

```bash
git add scripts/personal-release-contract.ts scripts/trusted-path.ts \
  tests/scripts/personal-release-contract.test.ts tests/scripts/trusted-path.test.ts
git commit -m "feat(release): define composite trust contracts"
```

### Task 2: Render and parse canonical launchd definitions

**Files:**
- Create: `src/lib/launchd-plist.ts`
- Create: `scripts/personal-release-plist-renderer.ts`
- Create: `deploy/templates/com.whatsoup.__INSTANCE__.plist`
- Modify: `deploy/templates/com.whatsoup.__BOT_NAME__-watchdog.plist`
- Move/canonicalize: `deploy/com.whatsoup.reply-guarantee.plist` to `deploy/templates/com.whatsoup.reply-guarantee.plist`
- Modify: `deploy/templates/watchdog-script.sh`
- Create: `tests/lib/launchd-plist.test.ts`
- Create: `tests/scripts/personal-release-plist-renderer.test.ts`

**Interface:**

```ts
export interface VerifiedLaunchdDefinition {
  readonly label: string;
  readonly program: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string | null;
  readonly environmentKeys: readonly string[];
}

export function parseCanonicalLaunchdPlist(bytes: Buffer): VerifiedLaunchdDefinition;
export function renderPersonalLaunchArtifacts(
  descriptor: PersonalReleaseRenderDescriptorV1,
  paths: FinalCompositePaths,
): RenderedLaunchArtifacts;
```

- [ ] Write red tests for duplicate/missing keys, XML residue, entity abuse, empty/relative program, argv reordering, CWD drift, environment-key drift, and non-loopback health endpoints.
- [ ] Render byte-deterministically with one XML encoder and exact token exhaustion.
- [ ] Run `/usr/bin/plutil -lint`, parse the rendered bytes, and compare the full structure to the descriptor.
- [ ] Remove nvm/user-writable runtime paths from the canonical watchdog and main definitions; all runtime executables resolve inside the composite payload.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/lib/launchd-plist.test.ts \
  tests/scripts/personal-release-plist-renderer.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:all
```

### Task 3: Build the root-only composite finalizer

**Files:**
- Create: `scripts/personal-release-macos-metadata.ts`
- Create: `scripts/personal-release-finalizer.ts`
- Create: `scripts/personal-release-finalize-cli.ts`
- Modify: `scripts/release-snapshot-materialize.ts`
- Modify: `tests/scripts/release-snapshot-materialize.test.ts`
- Create: `tests/scripts/personal-release-finalizer.test.ts`
- Create: `tests/helpers/release-materialization-fixture.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface MacFilesystemMetadata {
  readonly ownerUid: number;
  readonly ownerGid: number;
  readonly mode: number;
  readonly aclSha256: string;
  readonly flags: readonly string[];
}

export function finalizeCompositePersonalRelease(
  options: FinalizeCompositePersonalReleaseOptions,
): CompositeReleaseResult;

export function checkCompositePersonalRelease(
  releasePath: string,
  options: CompositeCheckOptions,
): CompositeReleaseCheckReport;
```

- [ ] Write red tests for non-root production invocation; bad v1 staging; malformed, secret-bearing, symlinked, hard-linked, world-readable, writable, or identity-changing config/descriptor; toolchain drift; and pre-existing objects/links.
- [ ] Keep v1 materialization as unprivileged commit staging and validate it with the real checker.
- [ ] Copy commit bytes plus pinned Node into a new unpublished composite. npm remains build provenance, not a runtime dependency.
- [ ] Validate private config through `validateInstanceConfig` plus the plaintext-secret prohibition. Render main/watchdog/reply plists into fixed payload-relative paths.
- [ ] Recursively inventory and fsync; apply root ownership, immutable modes, flags, and narrow service-UID read/execute ACLs; then re-inventory.
- [ ] Publish one direct commit-named relative symlink with no replacement and emit metadata-only v2 receipts.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/scripts/release-snapshot-materialize.test.ts \
  tests/scripts/personal-release-finalizer.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
```

### Task 4: Prove crash durability and post-publication integrity

**Files:**
- Create: `scripts/personal-release-finalization-store.ts`
- Modify: `scripts/personal-release-finalizer.ts`
- Create: `tests/scripts/personal-release-finalization-recovery.test.ts`
- Modify: `tests/scripts/release-snapshot-materialize.test.ts`

**Journal:**

```ts
export type FinalizationPhase =
  | 'object_reserved'
  | 'payload_sealed'
  | 'link_published'
  | 'publication_verified';

export interface FinalizationJournalV1 {
  readonly schemaVersion: 1;
  readonly phase: FinalizationPhase;
  readonly objectIdentity: StableFilesystemIdentity;
  readonly linkIdentity: SymlinkIdentity | null;
  readonly manifestSha256: string | null;
}
```

- [ ] Inject crashes before/after object publication and link creation.
- [ ] Mutate a deep child, metadata, ACL, object ancestor, and link after publication but before completion.
- [ ] Reopen through authenticated ancestors and compare the complete public child inventory, object identity, payload identity, and link target.
- [ ] Cleanup only an unpublished object/link whose exact identity is still owned; never delete or replace a pre-existing/publicly referenced object.
- [ ] Bind recursive durability and the second inventory digest into the receipt.
- [ ] Verify and commit.

### Task 5: Upgrade the signed cutover plan to composite schema v2

**Files:**
- Modify: `scripts/personal-instance-cutover-plan.ts`
- Create: `scripts/personal-instance-cutover-trust.ts`
- Modify: `scripts/personal-instance-cutover-cli.ts`
- Modify: `tests/helpers/personal-instance-cutover-fixture.ts`
- Create: `tests/scripts/personal-instance-cutover-plan.test.ts`
- Modify: `tests/scripts/personal-instance-cutover-controller.test.ts`

- [ ] Write red tests for schema-v1 rejection, user-owned plan/control ancestors, release/config/plist lineage escape, helper/policy/trust-store drift, and candidate/rollback argv or CWD changes.
- [ ] Bump plan/journal schemas to 2. No production v1 journal exists, so reject v1 rather than add compatibility branches.
- [ ] Bind both composite releases, root-owned helper identity, fixed policy, trust store, and privileged receipt paths.
- [ ] Require config and all plists to be children of their corresponding sealed payloads.
- [ ] Remove independently editable process executable/CWD/argv expectations. Derive them with `parseCanonicalLaunchdPlist()` from the exact file identities inside the signed plan.
- [ ] Require plan, journal, completion receipt, remediation receipt, and transition nonce below a root-owned control root such as `/Library/Application Support/WhatSoup`.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/scripts/personal-instance-cutover-plan.test.ts \
  tests/scripts/personal-instance-cutover-controller.test.ts \
  tests/scripts/personal-instance-cutover-cli.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
```

### Task 6: Add the narrow privileged activation boundary

**Files:**
- Create: `scripts/personal-release-privileged-installer.ts`
- Create: `scripts/personal-release-privileged-installer-cli.ts`
- Create: `scripts/personal-release-installer-client.ts`
- Modify: `scripts/personal-instance-cutover-host.ts`
- Modify: `scripts/personal-instance-cutover-controller.ts`
- Modify: `scripts/personal-instance-cutover-production-host.ts`
- Modify: `tests/scripts/personal-instance-cutover-controller.test.ts`
- Modify: `tests/scripts/personal-instance-cutover-production-host.test.ts`

**Interfaces:**

```ts
export type PrivilegedCutoverRequest =
  | { readonly operation: 'activate'; readonly target: 'candidate' | 'rollback'; readonly planPath: string; readonly planDigest: string }
  | { readonly operation: 'contain'; readonly planPath: string; readonly planDigest: string }
  | { readonly operation: 'seal_terminal_receipt'; readonly terminal: 'completed' | 'rolled_back' | 'contained'; readonly planPath: string; readonly planDigest: string };

export interface PrivilegedInstallerClient {
  apply(plan: CutoverPlan, request: PrivilegedCutoverRequest): Promise<PrivilegedCutoverReceipt>;
}
```

- [ ] Write a recording-client audit test proving every production install, rollback, containment, and terminal-control write crosses this interface.
- [ ] Make the production client execute one pinned root-owned helper with `sudo -n`, canonical request bytes on a bounded pipe, a minimal environment, and bounded metadata-only response.
- [ ] The helper re-verifies the signed plan and derives every destination from it. It accepts no caller path besides the plan path and no arbitrary command.
- [ ] Replace `publishCandidateAtomically` plus `installPlistExact` with one `installCandidateControlSet`. Replace direct rollback writes with the same helper targeting rollback.
- [ ] Collapse the two old phases into `candidate_installed`; preserve pre-acceptance rollback and post-acceptance containment semantics.
- [ ] Remove production-host direct destination use of rename/symlink/unlink/chmod/chown/write operations; tests may use a fake client, not bypass the boundary.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/scripts/personal-instance-cutover-production-host.test.ts \
  tests/scripts/personal-instance-cutover-controller.test.ts \
  tests/scripts/personal-instance-cutover-cli.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
```

### Task 7: Prove exact candidate and rollback main launch admission

**Files:**
- Modify: `scripts/personal-instance-cutover-host.ts`
- Modify: `scripts/personal-instance-cutover-controller.ts`
- Modify: `scripts/personal-instance-cutover-production-host.ts`
- Modify: `tests/helpers/personal-instance-cutover-fixture.ts`
- Modify: `tests/scripts/personal-instance-cutover-controller.test.ts`
- Modify: `tests/scripts/personal-instance-cutover-production-host.test.ts`

- [ ] Add `plist` and complete ordered `programArguments` to `ProcessObservation`.
- [ ] Immediately after `launchctl bootstrap`, compare admitted plist path, program, full argv, and CWD to the parsed sealed plist before kickstart. On mismatch, boot out and fail closed.
- [ ] Candidate observation and rollback terminal proof also compare release lineage, PID/generation, and health commit.
- [ ] Test candidate and rollback argv drift independently, label/CWD drift, and repeated rollback proof without another bootstrap/kickstart.
- [ ] Verify and commit.

### Task 8: Require a private working directory for required capabilities

**Files:**
- Create: `src/core/capabilities/required-working-directory.ts`
- Modify: `src/core/agent-config-validator.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/core/agent-config-validator-capabilities.test.ts`
- Modify: `tests/runtimes/agent/microsoft-365-runtime-capability.test.ts`

**Interface:**

```ts
export function assertRequiredCapabilityWorkingDirectory(input: {
  readonly configured: boolean;
  readonly cwd: string | undefined;
  readonly home: string;
  readonly expectedUid: number;
}): string | undefined;
```

- [ ] Write red tests for missing, empty, whitespace, relative, non-directory, final symlink, physical-home equivalent, wrong-owner, and non-private CWD.
- [ ] Enforce a normalized absolute string in the shared validator only when a required capability is selected.
- [ ] Re-resolve physical CWD/home, owner, and mode at runtime before mail-ledger initialization, readiness startup, settings/MCP writes, socket creation, or session spawn.
- [ ] Keep non-capability defaults unchanged.
- [ ] Verify and commit.

**Serialization:** This task overlaps the capability-admission plan. Assign one owner and do not edit `runtime.ts` or the validator concurrently.

### Task 9: Journal immutable inbound LID provenance

**Files:**
- Create: `src/core/database-migration-42.ts`
- Create: `src/core/inbound-actor-provenance.ts`
- Modify: `src/core/database.ts`
- Modify: `src/core/lid-resolver.ts`
- Modify: `src/core/durability.ts`
- Modify: `src/core/ingest.ts`
- Modify: `src/runtimes/agent/runtime-turn-context.ts`
- Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/core/migration-safety.test.ts`
- Modify: `tests/core/lid-resolver-write-seam.test.ts`
- Create: `tests/core/inbound-actor-provenance.test.ts`
- Modify: `tests/mcp/tools/microsoft-365-mail-confirmation.test.ts`

**Interface:**

```ts
export interface InboundActorProvenance {
  readonly rawJid: string;
  readonly canonicalPhoneJid: string;
  readonly normalizedLid: string | null;
  readonly lidMappingGeneration: number | null;
}

export function captureInboundActorProvenance(
  db: Database,
  rawJid: string,
): InboundActorProvenance;
```

- [ ] Migration 42 adds monotonic `lid_mappings.generation` and immutable actor-provenance columns to `inbound_events`.
- [ ] `journalInbound` captures raw JID, canonical PN JID, normalized LID, and mapping generation in the same SQLite transaction as the inbound sequence/message identity.
- [ ] Thread the admitted row through runtime context and recovery. Do not recompute authorization with current `resolvePhoneFromJid()`.
- [ ] Mail resolution queries by inbound sequence, source message, conversation, and raw sender; verifies the active queue head; and fails when provenance is absent, ambiguous, or no longer consistent.
- [ ] Prove unmapped-then-late mapping and admin/non-admin mapping flips cannot promote a prior turn.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/core/migration-safety.test.ts \
  tests/core/lid-resolver-write-seam.test.ts \
  tests/core/inbound-actor-provenance.test.ts \
  tests/mcp/tools/microsoft-365-mail-confirmation.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:all
```

**Serialization:** Complete this task before the capability plan's server-owned mail-operation identity task.

### Task 10: Prove the real chain and run the privileged target rehearsal

**Files:**
- Create: `tests/scripts/personal-instance-cutover-chain.test.ts`
- Create: `scripts/personal-release-privileged-rehearsal.ts`
- Create: `tests/scripts/personal-release-privileged-rehearsal-source.test.ts`
- Modify: `scripts/personal-instance-cutover-controller.ts`
- Modify: `package.json`
- Modify: `docs/runbooks/personal-instance-attested-cutover.md`
- Modify: `docs/public-surface.md`
- Modify: `docs/publication-audit.md`

- [ ] Add `CutoverController.dryRun(plan)` that validates bindings and simulates transitions without service or filesystem mutation.
- [ ] Build the ordinary integration chain with real code: v1 materialize → real v1 check → root-policy-simulated v2 finalizer/checker → signed-plan parser → controller dry-run. Do not insert rollback config/plists with fixture-only helpers.
- [ ] Add a separate root-only macOS rehearsal against an explicitly named disposable root. It proves service-UID read/execute but denies write, truncate, link repoint, chmod, ACL/flag change, ancestor replacement, or launch argv/CWD substitution.
- [ ] The rehearsal bootstraps, inspects, and boots out disposable launchd jobs. Any skipped command, unsupported ACL tool, masked failure, or inability to switch UID is `Inconclusive` and blocks cutover.
- [ ] Document fixed helper/sudo-policy bootstrap, staging/finalization, retention, receipts, canary sequence, residual same-UID launchctl risk, and the deferred dedicated-service-account boundary.
- [ ] Classify private plans/runbooks and update the public command surface.
- [ ] Run the complete gates.

Ordinary gates:

```bash
npm run typecheck:all
npm run guard:lint:src
npm run guard:test-integrity:required
npm run guard:public-surface-drift
npm run guard:publication:all
npm run guard:repo:release-hygiene
npm test -- --pool=forks --fileParallelism=false --retry=0
git diff --check
```

Privileged rehearsal, only on the disposable target after explicit deployment authorization:

```bash
sudo npm run rehearse:personal-release:privileged -- \
  --policy "/Library/Application Support/WhatSoup/personal-release-policy.json" \
  --service-uid "<uid>" --json
```

Do not claim the release ready for the isolated canary until that metadata-only rehearsal receipt is independently checked.
