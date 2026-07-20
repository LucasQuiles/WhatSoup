# CI/CD Control Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task requires superpowers:test-driven-development and superpowers:test-integrity; completion requires superpowers:verification-before-completion.

**Status:** Active

**Goal:** Add one strict control inventory, one neutral exact-evidence result contract, one exact-Git-object risk classifier, canonical fast/PR facades, and exact-ref/hook-integrity adapters without changing existing native detector decisions.

**Architecture:** New neutral modules live under `scripts/lib/ci-control/`. The manifest records orchestration metadata but imports native decisions by adapter. The classifier reads Git objects, never ambient candidate bytes. Package facades compose existing lower-level commands. Hooks become thin exact-ref adapters. Existing hard-coded safeguard inventories stay authoritative until manifest parity is proven, then ownership switches atomically.

**Tech Stack:** TypeScript, Node.js 24.15.0, Vitest 4, Git plumbing, JSON, SHA-256, Husky, repository pinned-runtime wrappers.

## Global Constraints

- Follow the program guardrails in `2026-07-20-cicd-enforcement-control-plane-program.md`.
- Native privacy, publication, semantic, fitness, test-integrity, deployment, and boundary-run schemas remain authoritative for their domains.
- Do not recompute a native finding in an adapter. Validate detector ID, native schema version, evidence digest, and decision mapping.
- Do not delete `required-suites.ts`; keep it explicitly advisory until exact parity and promotion evidence exists.
- Keep existing `verify:push:branch`, `verify:release`, and `verify:publish` commands available. Do not relabel current `verify:release` as artifact assurance.
- New JSON validators reject unknown keys, duplicate identities, invalid enums, cycles, unreachable required controls, missing remediation, and unbounded exceptions.
- New machine-readable commands support `--help` and JSON output; unknown or duplicate options exit `2` with a sanitized reason and exact reproduction command.
- Each control emits exactly one `PASS`, `WARN`, `BLOCK`, `INCONCLUSIVE`, or `NOT_APPLICABLE` outcome. Aggregate gates alone derive `PASS`, `BLOCK`, or `INCONCLUSIVE`; warnings remain visible but cannot satisfy required evidence, and not-applicable requires trusted classifier proof.
- One validated machine object owns every human, agent, annotation, summary, and log rendering. Non-pass results name severity/confidence, control and decision owner, domain/stage/operation/trust class, safe structural location, exact bindings, causal impact, ordered remediation, canonical implementation owner, allowed and prohibited patch scope, reproduction preconditions, focused verification, retry/exception semantics, related findings, and stable fingerprint. Generic `CI failed`, raw exceptions, absolute paths, and private matched values are forbidden.
- Every execution result includes a validated precondition receipt for runtime/package manager, tool and wrapper digests, dependency-install scopes, workspace/index state, exact OIDs, observed host capabilities, hook identity, fixture/substitute readiness, and test-selection digest. An invalid or unproven precondition is `INCONCLUSIVE`, not product `BLOCK` evidence.
- Only terminal attempt evidence is authoritative. Attempts use unique non-reused IDs, explicit lifecycle states, exact-byte digests, atomic terminal receipt publication, bounded freshness, append-only history, and proof the owned process group ended.
- Every phase binds a lineage lease containing base, candidate, tested-merge, and remote OIDs plus manifest, policy, toolchain, selected-plan, and prerequisite-receipt digests, then applies a dependency-aware invalidation matrix after any lease input changes. A changed remote, plan, or prerequisite receipt never silently preserves dependent merge, release, or push authorization.
- Before worktree transitions, reconcile tracked, staged, unstaged, untracked, ignored, intent-to-add, generated, assume-unchanged/skip-worktree, submodule, symlink, file-type, executable-bit, and planned-patch sets. A successful stash/archive command alone is not preservation proof.
- Candidate execution, untrusted cache restore, or untrusted artifact extraction irreversibly taints the job and prevents later privilege, private assurance, signing, publication, OIDC, production network, or trusted-cache access.
- Check count and byte budgets before traversal/canonicalization. Write receipts atomically and bind their digest to the exact bytes emitted.
- Existing lower-level tests and behavior are unchanged unless the task's unsafe fixture proves a reachable defect.

---

### Task 1: CP-F1 — Canonical control manifest, strict schema, and inventory

**Patch admission packet**

- Evidence: **Proven** at reconciled local base `f30052f11a86cc3ece3026ff8e8798ec207831ea`; relevant source paths are code-identical to the previously reviewed `c26cc8b2091d6b39abd0350b535c8ed551d9ab93`, `d7a443cbd329bd2d71bfe7df704f103179f59c57`, `9fc8a640845d581025b6e7997c0de70b55478a1e`, and `f43b877ffab07bd3b75f1be645c4552f3a127b18` revisions.
- Owner/location: new neutral orchestration owner; existing hard-coded inventory begins at `scripts/safeguard-diagnostics.ts:72` and fitness-only registry at `scripts/lib/fitness/registry.ts:1`.
- Reachable failure: an existing guard can be absent from orchestration, multiply registered, dependency-cyclic, unreachable, or missing remediation without one exact ownership graph rejecting it.
- Unsafe fixture: two blocking records claim the same `(policyCategory,surface,decisionOwner)` or one required control is unreachable.
- Safe neighbor: two controls observe the same surface with different decision owners and an explicit dependency.
- Expected: unsafe `INCONCLUSIVE/2`; safe `PASS/0`.
- Smallest repair: additive manifest, validator, inventory CLI, and package command. Existing safeguards remain unchanged.
- Rollback: ordinary revert of additive files and package entry.

**Files:**

- Create: `controls/ci-control-manifest.json`
- Create: `scripts/lib/ci-control/manifest.ts`
- Create: `scripts/ci-control-manifest.ts`
- Create: `tests/scripts/ci-control-manifest.test.ts`
- Modify: `package.json`
- Modify: `docs/public-surface.md`

**Interfaces:**

```ts
export type ControlDomain =
  | 'repository-hygiene' | 'privacy-publication' | 'source-integrity'
  | 'workflow-security' | 'test-integrity' | 'functional-correctness'
  | 'semantic-quality' | 'portability' | 'dependency-governance'
  | 'artifact-integrity' | 'supply-chain' | 'deployment-safety'
  | 'runtime-assurance' | 'documentation' | 'operability';

export type ControlStage =
  | 'pre-commit' | 'commit-message' | 'pre-push' | 'pull-request'
  | 'merge-group' | 'default-branch' | 'release' | 'deployment'
  | 'runtime' | 'scheduled';

export type TrustClass =
  | 'untrusted-candidate' | 'reviewed-source' | 'protected-policy'
  | 'trusted-build' | 'verified-artifact' | 'authorized-release'
  | 'observed-deployment';

export interface ControlManifestV1 {
  schemaVersion: 1;
  policyVersion: string;
  controls: ControlRecordV1[];
  requiredSurfaces: string[];
  riskRules: RiskRuleV1[];
  stages: ControlStage[];
  trustClasses: TrustClass[];
  canonicalCommands: Record<string, string[]>;
  resultSchema: 'ci-control-result-v1';
  exceptionSchema: 'ci-control-exception-v1';
}

export function loadControlManifest(cwd: string): ControlManifestV1;
export function validateControlManifest(value: unknown): ManifestIssue[];
export function digestControlManifest(manifest: ControlManifestV1): string;
export function buildControlInventory(manifest: ControlManifestV1): ControlInventoryV1;
```

- [ ] **Step 1: Write RED exact-key, duplicate-owner, cycle, reachability, and safe-neighbor tests**

Use only synthetic IDs. Test that validation performs top-level count/byte checks before visiting control members and reports bounded codes such as `ci.manifest.duplicate-owner`, `ci.manifest.dependency-cycle`, and `ci.manifest.required-control-unreachable`.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: FAIL because the manifest module and CLI do not exist.

- [ ] **Step 3: Implement the strict validator and canonical digest**

Canonical serialization sorts object keys and set-like arrays according to the schema; it rejects unknown keys instead of discarding them. The digest is `sha256:<lowercase hex>` over the exact UTF-8 canonical bytes.

- [ ] **Step 4: Populate only observed controls**

Register existing lower-level commands with truthful stages, trust classes, native schemas, modes, evidence expectations, and remediation. Mark semantic shadow and history scans advisory. Mark not-yet-implemented portability, protected-policy, artifact, deployment, and scheduled rows as absent from the manifest rather than fictional pass-capable controls.

- [ ] **Step 5: Add the inventory CLI**

```text
npm run ci:manifest -- validate --json
npm run ci:manifest -- inventory --json
```

Both commands use pinned Node. Validation exits `0` only for a complete valid manifest and `2` for untrusted/unparseable/schema-invalid input.

- [ ] **Step 6: Verify GREEN and surrounding regressions**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/fitness-registry.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
git diff --check
```

- [ ] **Step 7: Independent source-line review and commit**

Review exact-key enforcement, pre-admission limits, graph reachability, ownership uniqueness, and sanitized messages. Resolve findings, stage only named files, then commit:

```bash
git commit -m "feat(ci): add canonical control inventory"
```

---

### Task 2: CP-F2 — Neutral result envelope, preconditions, terminal receipts, and canonical feedback

**Patch admission packet**

- Evidence: **Proven**. Semantic receipts and boundary-run results independently implement useful evidence, but no neutral aggregator binds their identity, freshness, revision, policy, producer, and platform.
- Reachable failure: a missing result can be collapsed into a generic error; a stale/malformed native result, invalid setup, partial log, or exited process without a terminal receipt can be interpreted as product evidence without a shared validator.
- Unsafe fixture: missing required native result represented as success or generic `CI failed`; unsupported runtime represented as `BLOCK`; terminal receipt published while an owned child remains alive.
- Safe neighbor: validated not-applicable observation with closed applicability reason and required null fields.
- Expected: unsafe `INCONCLUSIVE/2`; safe `PASS/0` only after exact schema validation.
- Smallest repair: neutral schema/serializer/renderer, precondition and terminal-attempt contracts, and thin adapters; native policy code remains unchanged.
- Rollback: remove neutral layer; retain all native receipt paths.

**Files:**

- Create: `scripts/lib/ci-control/result.ts`
- Create: `scripts/lib/ci-control/reasons.ts`
- Create: `scripts/lib/ci-control/preconditions.ts`
- Create: `scripts/lib/ci-control/attempt.ts`
- Create: `scripts/lib/ci-control/native-adapter.ts`
- Create: `tests/scripts/ci-control-result.test.ts`

**Interfaces:**

```ts
export type ControlOutcome =
  | 'pass' | 'warn' | 'block' | 'inconclusive' | 'not-applicable';
export type AggregateDecision = 'pass' | 'block' | 'inconclusive';
export type ControlExitCode = 0 | 1 | 2;
export type AttemptLifecycle =
  | 'created' | 'running' | 'finalizing' | 'terminal'
  | 'cancelled' | 'timed-out' | 'corrupt';

export interface NativeResultAdapter<T> {
  detectorId: string;
  schemaVersion: number;
  validateNative(value: unknown): T;
  evidenceDigest(value: T): string;
  outcome(value: T): ControlOutcome;
  causeCode(value: T): string | null;
}

export function validateControlResult(value: unknown): ControlResultV1;
export function validatePreconditionReceipt(value: unknown): PreconditionReceiptV1;
export function validateTerminalAttempt(value: unknown): TerminalAttemptV1;
export function canonicalizeControlResult(value: ControlResultV1): Uint8Array;
export function serializeControlResult(value: ControlResultV1): string;
export function hashControlResult(value: ControlResultV1): string;
export function renderControlResult(value: ControlResultV1): string;
export function aggregateOutcomes(value: readonly ControlResultV1[]): AggregateDecision;
export function exitCodeForOutcome(value: ControlOutcome): ControlExitCode;
```

- [ ] **Step 1: Write RED outcome, diagnostic, precondition, terminal-attempt, exact-key, freshness, native-adapter, byte-budget, and leak tests**

Include all five outcomes; aggregate conversion; required missing; unsupported runtime; incomplete install scope; invalid fixture; cancelled/timed-out/corrupt attempts; process exit without terminal receipt; receipt before child-group termination; stale/malformed/wrong OID/policy/producer; valid not-applicable; multibyte-at-limit; one-byte-over; absolute-path input; and low-entropy matched-value cases.

Each warn/block/inconclusive output must contain the complete diagnostic contract from Global Constraints and identify source correction, precondition correction, evidence recovery, infrastructure retry, approval, or escalation. Assert human and machine renderings are projections of one object and contain neither the synthetic matched literal nor its raw SHA-256. Reject `CI failed`, missing owners/remediation/bindings, unknown codes, and alternate free-form catalogs.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-result.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Implement outcome, taxonomy, diagnostic, and aggregation contracts**

Use stable versioned domain codes from the design taxonomy. Codes are never repurposed. Reject outcome/exit mismatches, warnings used as required evidence, skipped jobs represented as not-applicable, subset-only aggregation, duplicate or substitute observations, and unregistered codes.

- [ ] **Step 4: Implement precondition and terminal-attempt evidence**

Validate every declared precondition before interpreting product behavior. Lifecycle transitions are monotonic; attempt IDs cannot be reused; terminal bytes are written to a confined same-directory temporary file, hashed, atomically renamed, and accepted only after owned-process-group termination proof. Progress and mutable latest-state files are never authoritative.

- [ ] **Step 5: Implement canonical serialization, causal grouping, and rendering once**

The same canonical bytes drive the evidence digest, JSON file, output budget, human rendering, annotations, summaries, and adapter output. Group dependent symptoms beneath the primary cause and render setup repair, focused replay, and full-regression steps. No caller constructs free-form failure text for authoritative decisions.

- [ ] **Step 6: Add native adapters without recomputing policy**

Start with semantic-quality and boundary-run adapter tests. Validate their native ID/schema/digest and map only the native disposition/cause. Do not move or duplicate their rule language.

- [ ] **Step 7: Verify GREEN and native regressions**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
git diff --check
```

- [ ] **Step 8: Independent review and commit**

```bash
git commit -m "feat(ci): standardize control evidence"
```

---

### Task 3: CP-F3 — Exact-Git-object risk and impact classifier

**Patch admission packet**

- Evidence: **Proven** at `scripts/required-suites.ts:132-156` and `:180-213`.
- Reachable failure: merge-base or classifier failure can fall back while the informational CLI still exits zero; caller-provided paths can omit executable impact.
- Unsafe fixture: missing merge base or moving candidate OID while a caller requests low risk.
- Safe neighbor: exact docs-only Git-tree delta with verified base/candidate and no executable, generated, workflow, public-metadata, dependency, or policy effect.
- Expected: unsafe runs system-wide but returns `INCONCLUSIVE/2`; safe returns `PASS/0` with low risk and exact work set.
- Smallest repair: new authoritative classifier; retain `required-suites.ts` as advisory.
- Rollback: remove authoritative command and leave existing triage unchanged.

**Files:**

- Create: `scripts/lib/ci-control/git-input.ts`
- Create: `scripts/lib/ci-control/classifier.ts`
- Create: `scripts/ci-control-classify.ts`
- Create: `tests/scripts/ci-control-classifier.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `package.json`

**Interfaces:**

```ts
export interface ExactRevisionInput {
  eventName: 'pull_request' | 'merge_group' | 'push' | 'tag' | 'local';
  baseOid: string | null;
  candidateOid: string;
  mergeOid: string | null;
  manifestDigest: string;
}

export interface RiskClassificationV1 {
  schemaVersion: 1;
  outcome: ControlOutcome;
  exitCode: ControlExitCode;
  riskTier: 'low' | 'standard' | 'elevated' | 'system-wide';
  reasons: string[];
  changed: ChangeFact[];
  requiredControls: string[];
  requiredSuites: string[];
  baseOid: string | null;
  candidateOid: string;
  mergeOid: string | null;
  manifestDigest: string;
  classifierDigest: string;
  graphDigest: string;
}

export function classifyExactRevision(cwd: string, input: ExactRevisionInput): RiskClassificationV1;
export function acquireLineageLease(cwd: string, input: ExactRevisionInput): LineageLeaseV1;
export function invalidateForLineageChange(
  lease: LineageLeaseV1,
  current: LineageLeaseV1,
): InvalidationDecisionV1;
```

- [ ] **Step 1: Write RED Git-fixture and lineage-lease tests**

Cover added, modified, deleted, renamed, copied, executable-bit, symlink, submodule, lockfile, dependency, generator/output, workflow, hook, policy, release, docs-only, unknown path, missing object, shallow/no-merge-base, head movement, remote movement, disjoint-doc movement, merge-result change, and policy/toolchain invalidation states.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-classifier.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Implement exact object loading and closed reason selection**

Use `git diff-tree`, `git cat-file`, and manifest-owned risk rules against validated OIDs. Do not read changed candidate bytes from the working tree. Verify the candidate OID still resolves to the same object immediately before writing the result.

- [ ] **Step 4: Implement fail-closed uncertainty**

Unknown path, missing graph, decoder error, unavailable base, or stale candidate selects every system-wide required control/suite and emits `ci.classification.*` inconclusive evidence. Broader execution cannot change that classifier decision to pass.

- [ ] **Step 5: Implement the lineage lease and invalidation matrix**

Bind base, candidate, tested merge, remote ref and its exact target OID, manifest, policy, toolchain, selected-plan, and prerequisite-receipt digests plus creation time. Policy/workflow/dependency/generated/shared-runtime, plan, or prerequisite-receipt changes invalidate dependent results; disjoint documentation changes may reuse unaffected receipts but require metadata and final merge-object validation. Push always revalidates outgoing ref identity. RED tests mutate each lease field independently and prove no stale dependent receipt remains pass-capable.

- [ ] **Step 6: Add the CLI**

```text
npm run ci:classify -- --event <closed-event> --candidate <40-hex> [--base <40-hex>] [--merge <40-hex>] --json
```

No `--risk` or caller-selected check list exists.

- [ ] **Step 7: Verify GREEN and triage non-regression**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/required-suites.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
git diff --check
```

- [ ] **Step 8: Independent review and commit**

```bash
git commit -m "feat(ci): classify exact revisions"
```

---

### Task 4: CP-H1 — Exact outgoing refs and repository-owned hook identity

**Patch admission packet**

- Evidence: **Proven** at `.husky/pre-push`, `scripts/pre-push-guard.ts:52-74`, and the observed absolute foreign `core.hooksPath`.
- Reachable failure: push `other-local-ref:feature/x` while safe `HEAD` is checked out; the hook verifies `HEAD`, not the outgoing OID. Delete-only public tag updates receive no content/ref decision.
- Unsafe fixture: safe `HEAD`, different unsafe outgoing OID; release-tag deletion.
- Safe neighbor: exact outgoing OID/range with current repository-owned hook bytes; deletion of a manifest-approved unpublished scratch ref.
- Expected: unsafe `BLOCK/1` or `INCONCLUSIVE/2` by closed cause; safe `PASS/0`.
- Smallest repair: per-ref classification/verification and hook-installation guard. No automatic hook rewrite.
- Rollback: restore prior adapters as one ordinary revert; remote gates remain authoritative.

**Files:**

- Create: `scripts/hooks-installed-guard.ts`
- Create: `tests/scripts/hooks-installed-guard.test.ts`
- Modify: `scripts/pre-push-guard.ts`
- Modify: `tests/scripts/pre-push-guard.test.ts`
- Modify: `.husky/pre-push`
- Modify: `package.json`
- Modify: `controls/ci-control-manifest.json`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`

**Interfaces:**

```ts
export interface RefUpdateV1 {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}

export interface RefVerificationV1 {
  update: RefUpdateV1;
  outcome: ControlOutcome;
  exitCode: ControlExitCode;
  commandId: string;
  classificationDigest: string | null;
  evidenceDigest: string;
}

export function parsePrePushInput(input: string): RefUpdateV1[];
export function verifyOutgoingRefs(cwd: string, updates: RefUpdateV1[]): RefVerificationV1[];
export function inspectHookInstallation(cwd: string): ControlResultV1;
```

- [ ] **Step 1: Replace skip-expecting tests with RED exact-ref, deletion-policy, and workspace-accounting tests**

Preserve parsing tests that remain valid. Add multi-ref, missing object, non-fast-forward ambiguity, ref-name privacy, head movement, foreign hooks path, byte mismatch, and repository-relative hook installation fixtures. Add an ignored named plan omitted from a stash/archive, unexpected staged/generated file, partially staged file, intent-to-add, assume-unchanged/skip-worktree, symlink/type/mode change, and exact planned-patch-set neighbor.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Implement exact per-ref verification**

Pass each `localOid`, `remoteOid`, and ref identity into the classifier and selected lower-level scanners. Revalidate the local ref still resolves to `localOid` immediately before allowing transport. Multi-ref push passes only if every row passes.

- [ ] **Step 4: Implement hook identity inspection**

Resolve `core.hooksPath`, reject missing/foreign/escaping paths or byte mismatch, and provide a non-destructive remediation command. Do not install, overwrite, or mutate hooks automatically.

- [ ] **Step 5: Implement explicit workspace-set reconciliation**

Before any transition, record all workspace sets and exact named patch members. After stash/archive/restore, prove every named member and its staged/unstaged/type/mode state survived and no unrelated ignored or generated path entered the patch. Preserve partial staging. Missing preservation evidence is inconclusive.

- [ ] **Step 6: Wire canonical commands and rich errors**

Add `guard:hooks-installed`; make the pre-push hook consume exact stdin and preserve child exit `1` versus `2`. Replace raw `Error.message` output with registered sanitized cause codes and ordered remediation.

- [ ] **Step 7: Verify GREEN and surrounding guards**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/repo-hygiene-guard.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
git diff --check
```

- [ ] **Step 8: Independent review and commit**

```bash
git commit -m "fix(ci): bind hooks to outgoing revisions"
```

---

### Task 5: CP-F4 — Canonical fast and PR facades with truthful unavailable domains

**Patch admission packet**

- Evidence: **Proven**. Package scripts expose lower-level checks and broad push/release chains but lack `verify:fast` and exact-classification-driven `verify:pr`.
- Reachable failure: hooks, local agents, and CI can compose divergent command sets and call the advisory selector as if authoritative.
- Unsafe fixture: caller omits a required manifest control or selects a lower tier.
- Safe neighbor: facade consumes the exact classifier receipt and executes the manifest-required set exactly once.
- Expected: incomplete/divergent set `INCONCLUSIVE/2`; exact set `PASS/0` when every child passes.
- Smallest repair: one orchestration CLI plus package facades; keep lower-level commands.
- Rollback: remove facades without removing underlying checks.

**Files:**

- Create: `scripts/ci-control-run.ts`
- Create: `tests/scripts/ci-control-run.test.ts`
- Modify: `package.json`
- Modify: `controls/ci-control-manifest.json`
- Modify: `.husky/pre-commit`
- Modify: `.husky/pre-push`

**Interfaces:**

```ts
export type CanonicalCommandId = 'verify:fast' | 'verify:pr';
export function buildExecutionPlan(
  manifest: ControlManifestV1,
  classification: RiskClassificationV1,
  command: CanonicalCommandId,
): ControlExecutionPlanV1;
export function runExecutionPlan(plan: ControlExecutionPlanV1): Promise<ControlResultV1>;
```

- [ ] **Step 1: Write RED exact-set, execution-kernel, taint, masked-failure, and safe low-risk tests**

Use fake executable adapters. Cover early shell failure followed by success output, failing producer piped to a successful filter, cleanup masking primary failure, surviving background child, timeout after partial cleanup, truncated output, missing terminal receipt, output over budget, unexpected environment inheritance, wrong executable digest, untrusted-cache/artifact taint before privilege, duplicate/unexpected observations, and a safe direct-argv neighbor. Do not make unit tests run the whole repository suite.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-run.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Implement the bounded runner**

Run direct executable/argument arrays with a reconstructed allowlisted environment, controlled working directory, verified executable identity, per-control timeout, pre-admission count/byte limits, captured direct status, owned process group, and atomic terminal receipt. Preserve the primary exit across cleanup and require every child to be reaped. Reject shell interpolation, caller-selected controls, output substitution, missing results, privilege after candidate/cache/artifact taint, and success without terminal proof.

- [ ] **Step 4: Add package facades and thin hooks**

`verify:fast` covers staged/publication/hygiene plus fast manifest-selected checks. `verify:pr` consumes a valid exact classifier receipt or creates one through the canonical exact-revision classifier when none is supplied; it never accepts caller-selected risk or control lists. Register `verify:portability` and `verify:deploy` as unsupported only after their commands exist; until then do not expose names that imply assurance.

- [ ] **Step 5: Verify GREEN and parity**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-run.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
git diff --check
```

- [ ] **Step 6: Independent review and commit**

```bash
git commit -m "feat(ci): add canonical verification facades"
```

---

### Task 6: CP-F5 — Manifest-driven self-protection with atomic ownership cutover

**Patch admission packet**

- Evidence: **Proven partial**. `safeguard-diagnostics.ts` and `guard-test-coverage-check.ts` enforce important structures but use hard-coded inventories and candidate-controlled execution.
- Reachable failure: a required manifest control can be absent while the old hard-coded list remains green, or an inline exemption can suppress the companion-test requirement.
- Unsafe fixture: remove a required manifest control, add `continue-on-error`, make a blocking job conditional, or add an inline `meta-guard:no-test` exemption.
- Safe neighbor: an advisory control remains visible and cannot satisfy a blocking dependency; a reviewed narrow exception has owner and expiry.
- Expected: unsafe `BLOCK/1` for deterministic weakening and `INCONCLUSIVE/2` for invalid inventory/evidence; safe `PASS/0`.
- Smallest repair: dual-run old/new inventories until exact parity; atomically switch ownership only after parity tests.
- Rollback: restore the hard-coded inventory and prior exception behavior together; do not leave neither owner active.

**Files:**

- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`
- Modify: `scripts/guard-test-coverage-check.ts`
- Modify: `tests/scripts/guard-test-coverage-check.test.ts`
- Create: `controls/ci-control-exceptions.json`
- Create: `scripts/lib/ci-control/exceptions.ts`
- Create: `tests/scripts/ci-control-exceptions.test.ts`
- Modify: `controls/ci-control-manifest.json`

- [ ] **Step 1: Write RED exact-union and inline-bypass tests**

Assert:

```text
union(manifest control registrations) == canonical required control inventory
union(adapter surface declarations) == manifest required surface catalog
```

Reject missing, duplicate, unreachable, inline-exempted, expired, wildcard, unowned, and non-waivable exceptions.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Add registry-backed exception validation**

Every exception binds control, surface/path scope, owner, approver role, sanitized justification, compensating controls, evidence references, creation, expiry, and reassessment trigger. Native semantic allowlists and console waivers remain their domain owners and are registered rather than copied.

- [ ] **Step 4: Dual-run manifest and hard-coded inventories**

Report set differences as inconclusive. Do not remove `REQUIRED_SCRIPTS`, `CHAIN_REQUIREMENTS`, or specialized workflow AST checks until characterization tests prove exact parity for two consecutive local runs and the code review verifies the source diff.

- [ ] **Step 5: Cut over atomically**

After parity, derive orchestration reachability from the manifest while retaining specialized AST validators. Remove inline `meta-guard:no-test`; migrate any legitimate exception to the reviewed registry in the same commit.

- [ ] **Step 6: Verify GREEN and mutation protection**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run guard:safeguard-diagnostics
npm run guard:guard-test-coverage
npm run typecheck:scripts
git diff --check
```

- [ ] **Step 7: Independent review and commit**

```bash
git commit -m "feat(ci): protect the control inventory"
```

---

### Task 7: Foundation closeout, publication metadata, and next-plan admission

**Files:**

- Modify: `docs/publication-audit.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`
- Modify: `docs/public-surface.md` when new package scripts are public interfaces

- [ ] **Step 1: Run the complete focused foundation suite**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/ci-control-run.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  tests/scripts/required-suites.test.ts \
  tests/scripts/repo-hygiene-guard.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
npm run typecheck:all
```

Expected: every listed test passes without retries or filters that mask mandatory work; both typechecks pass.

- [ ] **Step 2: Regenerate and verify repository metadata**

```bash
npm run work-index:regen
npm run guard:work-index
npm run guard:publication:all
npm run guard:doc-drift
npm run guard:public-surface-drift
npm run guard:doc-tally
git diff --check
```

- [ ] **Step 3: Run the authoritative existing branch gate**

```bash
npm run verify:push:branch
```

Expected: exit zero. Its printed scope remains a subset disclosure; do not claim full-suite or release assurance from it.

- [ ] **Step 4: Run unfiltered full verification before completion claim**

```bash
npm run coverage:check -- --pool=forks --fileParallelism=false
```

Expected: the complete suite and coverage thresholds pass. Any skipped, masked, unsupported-runtime, or missing test-integrity lane is disclosed as inconclusive rather than clean.

- [ ] **Step 5: Validate agent/reviewer supply-chain receipts and all-channel redaction**

Require each worker/reviewer result to bind task and scope, read-only/mutation mode, sources, commands, changes, schema version, exact result digest, observed model/tool identity when available, confidence, risks, and lead-verification claims. Verify reviewer tool self-tests and source digest before use. Scan stdout, stderr, JSON, annotations, summaries, artifact names, reports, screenshots, coverage, source maps, archives, and scanner output with synthetic private values.

- [ ] **Step 6: Re-freeze upstream, review, and commit; stop at the remote-write boundary**

Fetch and inspect `origin/main`, reconcile without destructive Git, obtain independent code review, and commit only named files through hooks. Local source completion stops here. Push or merge only when the current owner request explicitly authorizes or clearly entails that exact WhatSoup branch action; when authorized, use the SSH remote, push the exact scanned OID, and verify remote readback. Do not change hosted required checks in this task.

- [ ] **Step 7: Write and admit the workflow/portability plan**

Convert the proven CI-W1/W2/P1 findings into a separate detailed plan. Hosted settings, `CODEOWNERS`, artifact publication, and deployment remain separate confirmation boundaries.
