# Microsoft 365 Capability Admission Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the connector mutation-deny floor on every settings admission, preserve invalid settings unchanged, pin exact plugin/tool provenance, and derive each mail operation from runtime-owned turn, actor, readiness, and payload evidence.

**Architecture:** Introduce one transactional settings reconciler and bind its receipt to readiness. Hash canonical read and mutation inventories rather than trusting counts. Verify a deterministic pinned-plugin artifact before credential lookup or spawn. Remove caller-supplied mail operation keys: prepare derives one from the admitted turn and current readiness generation, while send resolves it only from the fresh human approval and rechecks the same permit immediately before reservation and Graph transport.

**Tech Stack:** TypeScript ESM, Node.js 24.15.0, npm 11.12.1, `node:sqlite`, Zod, Vitest, the existing capability compiler/readiness manager/mail ledger.

## Global constraints

- `permissions.deny` always contains the complete Google and Microsoft 365 mutation floor, regardless of `enabledPlugins`.
- Malformed, non-object, unsafe, symlinked, or unwritable settings block startup without changing original bytes.
- Unknown settings, environment entries, unrelated hooks, caller deny ordering, and first occurrences are preserved.
- Counts are diagnostic. SHA-256 digests of exact canonical inventories/policies are authoritative.
- The MCP caller cannot supply an operation key.
- Readiness manager ID/generation, admitted turn owner/generation, durable source identity, raw/canonical actor provenance, account, conversation, and payload all affect mail identity.
- A readiness generation rollover invalidates pending confirmation before reservation or transport.
- No address, phone, chat JID, subject, body, recipient, token, credential, or raw settings content enters a key, log, health response, or public receipt in plaintext.
- Existing `unknown` and no-auto-retry semantics remain unchanged.
- Exact pinned-plugin conformance is an explicit failing release command, never an environment-skipped proof.
- This plan does not authorize plugin installation, service restart, Graph mutation, email, ClickUp write, or WhatsApp send.

---

### Task 1: Canonicalize read inventory and deny policy digests

**Files:**
- Modify: `src/core/capabilities/microsoft-365-tool-inventory.ts`
- Modify: `src/core/capabilities/types.ts`
- Modify: `src/core/capabilities/compiler.ts`
- Modify: `src/core/capabilities/microsoft-365.ts`
- Modify: `src/core/settings-template.ts`
- Modify: `tests/core/capability-compiler.test.ts`
- Modify: `tests/core/settings-template.test.ts`
- Modify: `tests/core/fixtures/microsoft-365-approved-read-tool-fixture.ts`
- Create: `tests/core/fixtures/microsoft-365-approved-read-tool-fixture.sha256`

**Exports:**

```ts
export const M365_READ_INVENTORY_SCHEMA_VERSION = 1;
export const M365_READ_INVENTORY_SHA256: string;
export const M365_MUTATION_NAMESPACES: readonly string[];
export const M365_MUTATION_ALIASES: readonly string[];
export const REQUIRED_DENY_NORMALIZATION_VERSION = 1;
export const REQUIRED_DENY_SHA256: string;
export const REQUIRED_DENY_CARDINALITIES: {
  readonly googleAliases: number;
  readonly logicalM365Mutations: number;
  readonly expandedM365Aliases: number;
};
```

- [ ] Write red tests that independently reproduce the read digest from fixed-key canonical JSON:
  `{"schemaVersion":1,"toolNames":[...sorted names]}`. Pin the current expected read digest `02c6917bffdc1ec40cd85d8343ba850302321de95553cde5904142dc72f65b76`.
- [ ] Build the deny digest from normalization version, 16 Google aliases, 112 logical M365 mutations, both namespaces, and all 224 expanded aliases. Do not hash only the expanded count.
- [ ] Prove add/remove/rename changes each digest, reordering does not, every required alias occurs once after normalization, and Unicode lookalikes do not compare equal.
- [ ] Make `applyRequiredDeny()` deduplicate all exact entries while preserving each first occurrence and caller order.
- [ ] Extend `RequiredCapabilitySurface.source` and `CompiledCapabilitySurface` with the read-inventory and deny-policy digests/cardinalities; include them in `descriptorHash`.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/core/capability-compiler.test.ts \
  tests/core/settings-template.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:all
```

```bash
git add src/core/capabilities/microsoft-365-tool-inventory.ts \
  src/core/capabilities/types.ts src/core/capabilities/compiler.ts \
  src/core/capabilities/microsoft-365.ts src/core/settings-template.ts \
  tests/core/capability-compiler.test.ts tests/core/settings-template.test.ts \
  tests/core/fixtures/microsoft-365-approved-read-tool-fixture.ts \
  tests/core/fixtures/microsoft-365-approved-read-tool-fixture.sha256
git commit -m "feat(m365): bind canonical capability policy digests"
```

### Task 2: Make settings admission transactional and always on

**Files:**
- Create: `src/core/agent-settings-admission.ts`
- Modify: `src/lib/private-fs.ts`
- Modify: `src/core/workspace.ts`
- Modify: `src/fleet/routes/ops.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/core/ensure-permissions-settings.test.ts`
- Modify: `tests/core/workspace-settings.test.ts`
- Modify: `tests/core/workspace.test.ts`
- Modify: `tests/fleet/routes/ops.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`

**Interface:**

```ts
export interface AgentSettingsAdmissionReceipt {
  readonly settingsSha256: string;
  readonly requiredDenySha256: string;
  readonly totalRequiredDeny: number;
  readonly googleAliases: number;
  readonly logicalM365Mutations: number;
  readonly expandedM365Aliases: number;
  readonly changed: boolean;
}

export function reconcileAgentSettingsFile(options: {
  readonly settingsPath: string;
  readonly enabledPlugins?: Readonly<Record<string, boolean>>;
  readonly hasSandbox: boolean;
  readonly mode: 'report' | 'apply';
}): AgentSettingsAdmissionReceipt;
```

- [ ] Replace legacy expectations that settings remain unsafe without `enabledPlugins` or that corrupt JSON is overwritten. Test absent/`{}`/populated plugins, wildcard allow entries, malformed JSON, scalar/array roots, invalid permission/plugin shapes, final/parent symlinks, and unrelated hook/env preservation.
- [ ] Verify red with the focused settings/fleet/runtime tests.
- [ ] Parse and fully validate before mutation. Normalize in memory, apply the required deny floor unconditionally, strip only known orphan hooks, and preserve unknown keys.
- [ ] Add generic no-follow read and atomic no-replace/replace primitives to `private-fs.ts`. On parse, validation, serialization, fsync, rename, or parent-identity failure, original bytes remain unchanged.
- [ ] `report` computes the exact proposed result without mutation. `apply` returns the digest of persisted bytes. A second apply is byte- and inode-stable and adds no duplicate denies.
- [ ] Route `ensurePermissionsSettings`, `writePermissionsSettings`, `writeSandboxArtifacts`, and the fleet ops path through this reconciler; remove raw `JSON.parse` plus fallback-default rewrites.
- [ ] Required-capability runtime admission runs before ledger/readiness/MCP startup and stores the receipt for Task 4.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/core/ensure-permissions-settings.test.ts \
  tests/core/workspace-settings.test.ts tests/core/workspace.test.ts \
  tests/fleet/routes/ops.test.ts tests/runtimes/agent/runtime.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:all
```

```bash
git add src/core/agent-settings-admission.ts src/lib/private-fs.ts \
  src/core/workspace.ts src/fleet/routes/ops.ts src/runtimes/agent/runtime.ts \
  tests/core/ensure-permissions-settings.test.ts \
  tests/core/workspace-settings.test.ts tests/core/workspace.test.ts \
  tests/fleet/routes/ops.test.ts tests/runtimes/agent/runtime.test.ts
git commit -m "fix(settings): admit required deny policy transactionally"
```

### Task 3: Create and verify exact pinned-plugin artifact provenance

**Files:**
- Create: `src/core/capabilities/microsoft-365-plugin-artifact.ts`
- Create: `contracts/microsoft-365-plugin-artifact-v1.json`
- Create: `scripts/microsoft-365-plugin-artifact-verify.ts`
- Modify: `src/core/capabilities/microsoft-365-read-launcher.ts`
- Modify: `tests/core/microsoft-365-pinned-plugin-conformance.test.ts`
- Modify: `tests/core/microsoft-365-read-launcher-source.test.ts`
- Modify: `tests/core/microsoft-365-read-launcher-hardening.test.ts`
- Modify: `tests/core/microsoft-365-read-launcher-integration.test.ts`
- Modify: `package.json`

**Proof:**

```ts
export interface M365ReadArtifactProof {
  readonly manifestSha256: string;
  readonly sourceCommit: string;
  readonly entrypointSha256: string;
  readonly entrypointSize: number;
  readonly readInventorySchemaVersion: number;
  readonly readInventorySha256: string;
}
```

- [ ] Write red tests for absent/malformed/dirty manifests, entrypoint size/hash drift, source-commit drift, inventory drift, source replacement during open, and zero/conditionally skipped conformance tests.
- [ ] Add `artifactManifestPath` to `M365_READ_LAUNCHER_ENV` and `M365ReadLaunchSource`.
- [ ] Attest manifest and entrypoint through descriptors; compare manifest SHA, entrypoint SHA/size, source commit, and read digest to the compiled descriptor before credential lookup or subprocess spawn.
- [ ] Replace `describe.skipIf()` release evidence with `npm run verify:m365-plugin-artifact`, which fails when exact artifact inputs are absent. Local developer tests may remain isolated, but cannot be cited as candidate proof.
- [ ] Make candidate build and canary invoke the standalone verifier explicitly.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/core/microsoft-365-pinned-plugin-conformance.test.ts \
  tests/core/microsoft-365-read-launcher-source.test.ts \
  tests/core/microsoft-365-read-launcher-hardening.test.ts \
  tests/core/microsoft-365-read-launcher-integration.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run verify:m365-plugin-artifact
npm run typecheck:all
```

### Task 4: Bind settings, inventories, artifact, and manager identity into readiness

**Files:**
- Modify: `src/core/capabilities/microsoft-365-mcp-preflight.ts`
- Modify: `src/core/capabilities/microsoft-365-readiness-manager.ts`
- Modify: `src/runtimes/agent/microsoft-365-runtime-capability.ts`
- Modify: `tests/core/microsoft-365-mcp-preflight.test.ts`
- Modify: `tests/core/microsoft-365-readiness-manager.test.ts`
- Modify: `tests/runtimes/agent/microsoft-365-runtime-capability.test.ts`

- [ ] Write red tests for missing settings receipt, deny digest/count mismatch, observed read-inventory mismatch, plugin proof mismatch, manager recreation, and generation rollover.
- [ ] Add `readInventorySha256` to `Microsoft365McpPreflightResult`, computed from the exact observed tool set.
- [ ] Give each readiness manager an opaque 32-byte random `managerId` and a one-time `bindSettingsAdmission(receipt)` call.
- [ ] Fail `start()` closed unless the settings receipt, compiled surface, MCP preflight, and plugin proof agree exactly.
- [ ] Include manager ID, generation, descriptor/authorization hashes, read digest/count, plugin manifest/entrypoint proof, deny digest/cardinalities, and expiry in `Microsoft365GateSnapshot` and `Microsoft365MailPermit`.
- [ ] Health exposes only bounded reasons, hashes, counts, manager ID, and generation.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/core/microsoft-365-mcp-preflight.test.ts \
  tests/core/microsoft-365-readiness-manager.test.ts \
  tests/runtimes/agent/microsoft-365-runtime-capability.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:all
```

### Task 5: Derive mail identity on the server and recheck it at dispatch

**Dependency:** Complete Task 9 in `2026-07-12-root-owned-composite-personal-release.md` first. This task consumes admission-time actor and inbound-row provenance; it never recomputes LID authority.

**Files:**
- Create: `src/core/m365-mail-operation-identity.ts`
- Modify: `src/mcp/tools/microsoft-365-mail.ts`
- Modify: `src/runtimes/agent/runtime-turn-coordinator.ts`
- Modify: `src/runtimes/agent/microsoft-365-runtime-capability.ts`
- Modify: `src/core/capabilities/agent365-client.ts`
- Modify: `src/core/capabilities/microsoft-365-readiness-manager.ts`
- Modify: `tests/mcp/tools/microsoft-365-mail-confirmation.test.ts`
- Modify: `tests/core/m365-mail-confirmation-ledger.test.ts`
- Modify: `tests/core/m365-mail-ledger.test.ts`
- Modify: `tests/runtimes/agent/capability-threading-current-main.test.ts`

**Interface:**

```ts
export interface Microsoft365MailOperationIdentityInput {
  readonly instanceDigest: string;
  readonly accountDigest: string;
  readonly conversationDigest: string;
  readonly sourceMessageDigest: string;
  readonly inboundSequence: number;
  readonly rawActorDigest: string;
  readonly canonicalActorDigest: string;
  readonly lidMappingGeneration: number | null;
  readonly turnManagerId: string;
  readonly turnGeneration: number;
  readonly readinessManagerId: string;
  readonly readinessGeneration: number;
  readonly descriptorHash: string;
  readonly authorizationHash: string;
  readonly payloadDigest: string;
}

export function deriveMicrosoft365MailOperationIdentity(
  input: Microsoft365MailOperationIdentityInput,
): `m365.mail.v3.${string}`;
```

- [ ] Write red tests proving both strict tool schemas reject caller `operation_key`; the server key matches `m365.mail.v3.<64 lowercase hex>`; and every identity field changes the key or denies admission.
- [ ] Extend runtime turn evidence with source message ID, inbound sequence, raw/canonical actor, mapping generation, logical turn owner/manager/generation, and conversation.
- [ ] `resolveMicrosoft365MailTurn()` requires the current active queue head to match the immutable context, inbound row, source message, actor, conversation, and logical turn exactly.
- [ ] Prepare derives the key and returns the human approval line. Send accepts the confirmation token but no operation key; it obtains the operation key only from exactly one matching approval in the current distinct human turn.
- [ ] Immediately before `prepareConfirmation`/`confirmAndReserve`, resolve the turn and permit again and compare the full snapshots. Pass an internal dispatch proof to `sendMailOnce()`, recheck once more before Graph transport, and strip proof fields from the Agent365 wire payload.
- [ ] Prove queue-head switch, prior terminal turn, actor/mapping change, manager recreation, and same-account generation rollover cause zero reservations and zero transport.
- [ ] Prove duplicate same-turn send returns the durable receipt with exactly one transport.
- [ ] Assert key, ledger, telemetry, health, and logs contain no plaintext actor/address/subject/body.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/mcp/tools/microsoft-365-mail-confirmation.test.ts \
  tests/core/m365-mail-confirmation-ledger.test.ts \
  tests/core/m365-mail-ledger.test.ts \
  tests/runtimes/agent/capability-threading-current-main.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:all
```

### Task 6: Carry the capability proof through composite release and cutover

**Dependency:** Complete Tasks 3-7 in `2026-07-12-root-owned-composite-personal-release.md` first. These files are shared and must not be edited concurrently.

**Files:**
- Modify: `scripts/release-snapshot-materialize.ts`
- Modify: `scripts/personal-release-contract.ts`
- Modify: `scripts/personal-release-finalizer.ts`
- Modify: `scripts/personal-instance-cutover-plan.ts`
- Modify: `scripts/personal-instance-cutover-host.ts`
- Modify: `scripts/personal-instance-cutover-controller.ts`
- Modify: `scripts/personal-instance-cutover-production-host.ts`
- Modify: corresponding release/cutover tests

- [ ] Add plugin manifest identity, entrypoint identity, read digest/count, deny digest/cardinalities, settings digest, descriptor hash, and authorization hash to the composite manifest and signed plan.
- [ ] Candidate assembly runs settings admission in `report` on a protected copy, applies only the exact approved normalized bytes, then runs artifact conformance against sealed bytes.
- [ ] Production readiness probes compare the complete proof tuple to the signed plan. Counts never substitute for digest equality.
- [ ] Rollback restores the sealed settings/release pair and revalidates the deny floor/artifact proof before declaring rollback active.
- [ ] Canary reruns the standalone artifact verifier and reports its metadata-only proof.
- [ ] Verify focused release/cutover tests and commit with path-specific staging.

### Task 7: Prove restart/no-resend behavior across real processes

**Files:**
- Create: `tests/core/m365-mail-restart-no-resend.test.ts`
- Modify: `tests/core/m365-mail-ledger.test.ts`
- Modify: `tests/mcp/tools/microsoft-365-mail-confirmation.test.ts`

- [ ] Process A uses a real SQLite file to prepare/confirm/reserve an operation and records either sent or unknown terminal truth, then exits.
- [ ] Process B opens the same database with a new readiness manager ID/generation. Inject transport that throws if called and submit the same approval/key path.
- [ ] Assert terminal truth is returned or stale confirmation is denied, with zero second reservations/transports. An unknown result remains quarantined and is never converted to a fresh key automatically.
- [ ] Use explicit child exit-code/stdout/stderr assertions. Truncated, timed-out, skipped, or masked output is inconclusive.
- [ ] Verify and commit.

Run:

```bash
npm test -- tests/core/m365-mail-restart-no-resend.test.ts \
  tests/core/m365-mail-ledger.test.ts \
  tests/mcp/tools/microsoft-365-mail-confirmation.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

### Task 8: Document invariants and run complete gates

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/tools.md`
- Modify: `docs/security-handoffs/2026-07-12-microsoft-365-full-read-surface.md`
- Modify: `docs/public-surface.md` when operator commands change
- Modify: `docs/publication-audit.md`

- [ ] Document always-on deny admission, invalid-byte preservation, exact artifact proof, settings/readiness binding, server-derived operation identity, generation invalidation, restart/no-resend behavior, and remaining live acceptance gates.
- [ ] Run focused tests with `--retry=0`, Test Integrity, publication/private-literal checks, public-surface drift, typecheck, lint, and complete suite.
- [ ] Treat warnings, skips, unavailable artifact inputs, truncated logs, and masked failures as explicit gaps rather than green.
- [ ] Commit docs with path-specific staging.
- [ ] Request an independent changed-file review before sealing the candidate.

Run:

```bash
npm run verify:m365-plugin-artifact
npm run typecheck:all
npm run guard:lint:src
npm run guard:test-integrity:required
npm run guard:publication:all
npm run guard:public-surface-drift
npm run guard:repo:release-hygiene
npm test -- --pool=forks --fileParallelism=false --retry=0
git diff --check
```

No canary or production action belongs to this implementation plan.
