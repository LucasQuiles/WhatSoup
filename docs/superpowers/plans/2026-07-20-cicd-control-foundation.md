# CI/CD Control Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task requires superpowers:test-driven-development and superpowers:test-integrity; completion requires superpowers:verification-before-completion.

**Status:** Active

**Goal:** Add one strict control inventory, one neutral exact-evidence result contract, one exact-Git-object risk classifier, canonical fast/PR facades, and exact-ref/hook-integrity adapters without changing existing native detector decisions.

**Architecture:** New neutral modules live under `scripts/lib/ci-control/`. The manifest records orchestration metadata but imports native decisions by adapter. The classifier reads Git objects, never ambient candidate bytes. Package facades compose existing lower-level commands. Hooks become thin exact-ref adapters. Existing hard-coded safeguard inventories stay authoritative until manifest parity is proven, then ownership switches atomically.

**Tech Stack:** TypeScript, Node.js 24.15.0, Vitest 4, Git plumbing, JSON, SHA-256, Husky, repository pinned-runtime wrappers.

**Current source progress (2026-07-21):** CP-F1 is present at `fe02ec7150b1bc1165e06d4457cd728c543b0e5b`; CP-F2 at `1ef2e93ed4b44b279402610e62655bd5ba330ff8`; CP-F3 at `5abc4438167a5d93fb0205e8b7083a6e77ec7691`; CP-H1a at `e013fcd8bb1fc1933a1a7f103d9848e1d7f6c0ba`; CP-H1b/ref-policy follow-up at `dd474cc7aed4b807a58c0cf1c22dead411709bb2` and `e6e6c10fedb8829693d4f94b6f02cef7e4741c7e`; and CP-F2e at `1bdd8ea37c7c9f3fb600fe0f5a68901398c50ca3`. CP-WA1, CP-H1c/H1d, CP-F4, and CP-F5 remain incomplete. The separately reviewed workflow/portability plan is planning evidence only and cannot begin authoritative mutation until those prerequisites close.

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
- The reason catalog is immutable-by-construction and versioned. Every active code records lifecycle, default outcome/severity, applicable stages, required confidence and identity bindings, closed retry/remediation classes, canonical owner, disclosure policy, one canonical message template, unsafe/safe/unavailable fixtures, and escalation or expiry. Existing code meanings are never repurposed; replacement uses a new four-part `<plane>.<domain>.<object>.<condition>` code plus an explicit supersession mapping.
- Every warning has an owner, repair SLA, expiry, escalation condition, and linked blocking or inconclusive successor. A warning stays visible but never satisfies mandatory evidence. Planned catalog rows are non-emitting and never pass-capable.
- The canonical result distinguishes claimed and observed scope, causal roots and dependent findings, public/private evidence references, omitted sensitive fields, closed retry/remediation classes, prohibited workarounds, next action, verification plan, and closure criteria. Scope overclaim or missing disclosure is a schema failure.
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

- [ ] **Step 9 (CP-F2e): Enrich the active taxonomy and result contract before H1c integration**

**Frozen CP-F2e admission packet**

- Evidence: **Proven** at `dd474cc7aed4b807a58c0cf1c22dead411709bb2`.
  `ReasonDefinitionV1` records only schema, code, guidance kind, and default outcome;
  `ControlResultV1` has useful bindings, preconditions, attempts, patch scope, and
  fingerprinting but lacks typed lifecycle governance, claimed/observed scope, causal
  relationships, closed retry/remediation classes, closure criteria, and separated public/
  private evidence references.
- Unsafe fixtures: concurrent writer or stale reviewer represented by an untyped generic
  prerequisite; warning without owner/expiry/escalation; free-form retry; scope overclaim;
  missing disclosure; silent V1 code rename; deprecated code emitted by a new control;
  unknown taxonomy code downgraded to warning; machine/human causal divergence.
- Safe neighbors: an active implemented four-part code with complete metadata and fixtures;
  a historical V1 code accepted for read-only evidence through an explicit deprecated/
  superseded mapping; a warning with owner, SLA, expiry, escalation, and a distinct
  successor code; exact claimed/observed scope with bounded limitations.
- Unavailable evidence: unknown code, missing writer/reviewer receipt, unproven scope,
  malformed causal graph, missing warning governance, or missing evidence-reference class
  is `INCONCLUSIVE/2`, never warning or pass.
- Smallest repair: extend only `scripts/lib/ci-control/reasons.ts`,
  `scripts/lib/ci-control/result.ts`, the shared evidence-graph budget in
  `scripts/lib/ci-control/preconditions.ts`, the existing thin native adapter, and their
  tests. Preserve the existing serializer as the sole renderer and preserve native
  granular cause codes. Existing ref-policy receipt readers also reject later-deprecated
  codes. Do not activate the rider's aspirational catalog wholesale.
- Migration: freeze all V1 meanings; add explicit lifecycle/supersession records; new
  emitters use four-part codes. Deprecated codes remain readable for bounded historical
  evidence but cannot be emitted by a new control after their acceptance deadline.
- Warning rule: escalation emits a separately registered successor finding bound to the
  protected clock, original native evidence, policy, predecessor result digest, and a new
  terminal attempt. It never mutates the warning code's default outcome or resets the
  first-observed interval.
- Stop conditions: any alternate message catalog, native-cause collapse, unbounded output,
  scope ambiguity, sensitive reference leak, or changed HEAD/index/plan invalidates the
  bead.
- Rollback: ordinary revert of the additive schema/catalog migration and tests; native
  receipts remain unchanged.

**Files:**

- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `scripts/lib/ci-control/result.ts`
- Modify: `scripts/lib/ci-control/preconditions.ts` only to give object-key and list-item
  budgets independent limits for the enriched envelope
- Modify: `scripts/lib/ci-control/native-adapter.ts` only to replace the ambiguous legacy
  warning wrapper with one implemented governed warning code
- Modify: `scripts/lib/ci-control/ref-policy.ts` only to name its bounded legacy-compatible
  receipt path explicitly while the new authoritative result envelope rejects partial
  taxonomy metadata
- Modify: `tests/scripts/ci-control-result.test.ts`
- Create: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `tests/scripts/semantic-quality-receipt-validation.test.ts` only to carry the
  complete producer identity at the existing canonical-byte adapter boundary
- Modify: `package.json` only to wire the taxonomy companion and canonical native-receipt
  byte tests into the existing branch gate

**Required enriched fields:**

```text
evidenceState rootCauseId causedBy relatedFindingIds supersedes
claimedScope observedScope scopeLimitations
retryClass remediationClass allowedPatchScope prohibitedChanges doNot
nextBestAction verificationPlan closureCriteria
sensitiveFieldsOmitted publicEvidenceRefs privateEvidenceRefs
nativeEvidence warningGovernance warningTransition
```

Validation also receives independently supplied expected envelope bindings—including
workflow ref, workflow SHA, run, and attempt—expected claimed scope, expected native
adapter evidence, warning-governance/transition receipts, and an expected bounded causal
graph. Producer identity remains complete on scanner-policy, classifier, required-check,
observed-check, native-adapter, and neutral native-evidence projections; native evidence
also preserves its policy and observed platform. An App/workflow-SHA pair cannot substitute
for the workflow ref, run, and attempt. Actual and protected-expected native evidence are
null-symmetric: either both are absent or their complete projections match exactly. Core
validation—not only rendering or aggregation—also requires the complete protected scanner-
policy receipt. Equal self-attested values are not trusted evidence.
Attempt evidence binds the entire result projection except the embedded attempt and its
digest, which are separately exact-byte validated to avoid recursion. Warning escalation
also binds the predecessor attempt digest and admits only a successor attempt created at
or after protected expiry and terminal before transition publication. Public projections
reject POSIX, drive-letter, UNC, assignment-prefixed, and `file:` absolute paths, not a
selected-root or punctuation-delimiter denylist, while preserving ordinary HTTPS URLs.

Legacy active codes remain visibly `legacy-partial` compatibility records until their
native owners receive their own admitted migration. New P0 catalog rows without executable
unsafe/safe/unavailable boundaries are `planned` and non-emittable. Only active,
implemented, complete rows may be emitted through `ControlResultV1`; legacy receipt reading
is a separate historical-only or explicitly compatible native path and cannot authorize an
aggregate. The first migrated warning is `quality.semantic.finding.warning`; it preserves
native semantic rule IDs, carries a protected first-observed/SLA/expiry projection, and
transitions atomically to `quality.semantic.warning.expired` through a new attempt-bound
result. Neither warning nor expired successor can satisfy evidence using a reset interval.
The earliest-observation/governance receipt is produced by a protected append-only owner in
the dependent execution-lifecycle bead; callers may not manufacture their own matching
`expectedWarningGovernance`. This result bead validates that protected input but does not
invent a second governance store. Deprecated or superseded receipt transport is parsed
through a bounded historical-only byte boundary, retains the exact transport digest, and
returns a recursively frozen canonical view that cannot enter aggregate authorization.

Closed retry classes are `never`, `after-source-change`,
`after-precondition-repair`, `after-transient-condition`,
`after-lineage-reconciliation`, `after-evidence-regeneration`,
`after-rebase-or-merge-refresh`, `after-approval`, and `manual-recovery`.
Closed remediation classes are `source-patch`, `workflow-policy-change`,
`environment-setup`, `exact-revision-rerun`, `lineage-reconciliation`,
`artifact-quarantine`, `rollback`, `hosted-settings-change`, `owner-decision`,
`exception-renewal`, and `control-retirement`.

Focused RED/GREEN and surrounding verification:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/semantic-quality-receipt-validation.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run typecheck:scripts
git diff --check
```

Expected RED: incomplete reason records, free-form retry/remediation values, missing causal/
scope/closure fields, and deprecated emission are accepted. Expected GREEN: each is rejected
with a stable cause while complete active and historical-read fixtures remain valid.

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
- Safe neighbor: exact outgoing OID/range with current repository-owned hook bytes; a
  manifest-approved unpublished scratch ref is structurally accepted but remains
  inconclusive until protected exact-ref evidence transport exists.
- Expected: unsafe `BLOCK/1` or `INCONCLUSIVE/2` by closed cause; safe `PASS/0`.
- Smallest repair: per-ref classification/verification and hook-installation guard. No automatic hook rewrite.
- Rollback: restore prior adapters as one ordinary revert; remote gates remain authoritative.

**Adjudicated implementation sequence:** CP-H1 is four canary beads, not one authority
switch. CP-H1a adds native hook-identity evidence without changing the active hook. CP-H1b
adds the manifest-owned ref policy and strict bounded parser. CP-H1c adds exact-object
entrypoints under the existing repository-hygiene and publication owners. CP-H1d performs
the per-ref exact-set cutover only after the three additive beads pass together. The
classifier selects and binds work; it does not turn an ambient `HEAD`/index/worktree scan
into exact-object evidence.

Workspace preservation is not a pre-push responsibility. The tracked, staged, unstaged,
untracked, ignored, intent-to-add, generated, assume-unchanged/skip-worktree, submodule,
symlink, type/mode, partial-staging, and named stash/archive cases move to CP-WA1 under the
workspace-transition/precondition owner. CP-H1 may consume that receipt later but does not
implement or silently own it.

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
- Modify when the owning bead requires it: `scripts/lib/ci-control/manifest.ts`
- Modify when the owning bead requires it: `scripts/lib/ci-control/reasons.ts`
- Modify when the owning bead requires it: native repository-hygiene/publication entrypoints
  and their existing companion tests

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
export function inspectHookInstallation(cwd: string): HookIdentityReceiptV1;
```

CP-H1a emits one bounded native receipt. It must not fabricate a `ControlResultV1` before
the supervised execution kernel can construct its precondition and terminal-attempt
evidence. CP-F4 later imports the native receipt through the canonical result adapter and
renderer.

- [x] **Step 1 (CP-H1a): Write RED hook-identity tests**

Cover a foreign absolute linked-worktree path even when bytes match, canonical relative
`.husky`, absolute-current-but-nonportable, escaping path, symlinked ancestor/file, missing
installed file, byte mismatch, executable-mode mismatch, committed source omission/type/
mode error, unexpected entry, helper drift, hardlinks, host-native execute denial, `HEAD`
ABA movement, untrusted `PATH`, launcher/implementation identity, receipt tampering,
duplicate JSON keys, byte limits, public-output redaction, and proof that the guard does not
write config, copy hooks, or change modes.

- [x] **Step 2 (CP-H1a): Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/hooks-installed-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [x] **Step 3 (CP-H1a): Implement native hook-identity inspection in report-only mode**

Use one approved absolute Git launcher and bind both launcher and selected implementation
digests. Use Git's resolved hook path, exact committed tree entries, descriptor-bound
regular-file reads, host-native read/execute authorization, single-link ownership, exact
directory-set equality for the three entrypoints plus one helper, CWD-bound child
enumeration tied back to the opened root identity, terminal inode/root revalidation, exact
40-hex object bindings, and a bounded `HEAD`/selected-ref reflog lease that detects ABA movement. A
foreign/missing/escaping/symlinked/hardlinked/mismatched installation, changed lineage, or
unavailable proof is `INCONCLUSIVE/2`; a deterministically invalid committed hook contract
is `BLOCK/1`; exact stable current-worktree identity is `PASS/0`. The embedded evidence
digest covers canonical receipt content with the digest field omitted; transport bytes are
serialized once with exactly one newline. Emit no absolute path or raw Git error. Never
install, copy, `chmod`, or change Git configuration. The canary remains report-only and
does not claim remote enforcement or resistance to a privileged actor that rewrites both a
ref and its reflog evidence.

- [x] **Step 4 (CP-H1b): Add the strict parser and manifest-owned ref policy**

Replace invalid deletion fixtures with Git's actual `(delete)` plus zero-OID shape. Add
exact-four-field, input byte/count, lowercase full-OID, zero/nonzero combination, duplicate,
remote identity, new-ref base, annotated-tag, deletion, force-update, and private/control-
character tests. Unknown policy or unavailable graph evidence is inconclusive. No scratch
deletion is safe until the manifest schema names it.

**Frozen CP-H1b admission packet**

- Evidence: **Proven** at `be8fe98706c7b761db585d7989903238339d3ed7` by three
  independent read-only Finder lanes. The current parser ignores trailing fields, reads
  unbounded stdin, accepts malformed OIDs and impossible zero combinations, discards the
  exact update set, skips every deletion-only push, ignores the remote arguments, and maps
  raw parser/tool failures to exit `1`.
- Unsafe fixtures: a fifth field, tab delimiter, missing terminal LF, byte/count overflow,
  uppercase/short/non-hex OID, duplicate destination, invalid `(delete)`/zero shape,
  protected-main or release-tag deletion, non-fast-forward branch update, wrong tag object
  or peeled target, unknown remote/namespace, moved local ref, and unavailable graph object.
- Safe neighbors: an exact four-field LF-terminated row, a manifest-authorized `origin`
  remote role and a fast-forward existing-head update. A synthetic policy fixture may
  explicitly name one unpublished scratch ref as deletable, but its public receipt remains
  inconclusive until H1d can bind the private exact ref through protected evidence. The policy evaluator also
  proves synthetic descendant branch and annotated-tag cases, but the native report-only
  CLI keeps both inconclusive until a protected exact trusted-base input exists. The live
  manifest begins with an empty deletion allowlist.
- Expected: deterministic prohibited policy is `BLOCK/1`; malformed, unclassified,
  unavailable, stale, or unbound evidence is `INCONCLUSIVE/2`; only complete policy and
  graph proof is `PASS/0`.
- Smallest repair: create `scripts/lib/ci-control/ref-policy.ts` and the additive
  `scripts/ci-control-ref-policy.ts` report-only CLI; extend the existing strict control manifest,
  reason catalog, and their tests. Do not modify `.husky/pre-push` or the default behavior
  of `scripts/pre-push-guard.ts` in this bead.
- Canonical ownership: `ci.outgoing-ref-policy` / `outgoing-ref-policy-decision-owner`. The manifest
  owns one versioned `outgoingRefPolicy` object declaring authorized normalized remote
  identities, release branches and tag prefixes, exact deletable refs, branch/release-tag
  object types, unknown-ref behavior, and non-fast-forward policy. Parser byte/count
  limits remain versioned code constants and are covered at their exact boundaries.
- Interfaces: the bounded parser preserves `RefUpdateV1[]`; the evaluator consumes only the
  reviewed manifest policy plus an exact ordered `RefGraphFactV1[]`; the CLI accepts bounded
  `--remote-name`, `--remote-location`, and `--json` only. Caller-provided policy, allow,
  force, or check-selection options are invalid.
- Privacy: public output contains update indexes and structural ref kinds, never raw input,
  raw refs, remote locations, local paths, Git exceptions, or reversible low-entropy
  fingerprints. Exact rows remain internal to the same process until H1d defines their
  protected terminal receipt transport. Consequently, H1b never emits a public deletion
  `PASS`; even a manifest-named scratch deletion is `INCONCLUSIVE/2` with
  `ci.refs.private-binding-unavailable` after its deterministic policy checks succeed.
- Unchanged controls: repository/publication scanners, exact-revision classifier, hook
  identity guard, active hook command selection, native detector schemas, and hosted
  settings remain unchanged.
- Rollback: ordinary revert of the additive module/CLI plus the same manifest/reason/docs
  registration. No hook or hosted setting requires rollback.
- Stop conditions: any unexpected HEAD/index/worktree/upstream movement, policy ambiguity,
  raw-output leak, unsupported object format, missing terminal result, or masked child
  status stops mutation and yields inconclusive evidence.
- Promotion limitation: this report-only bead uses each Git command's direct terminal
  status internally under a bounded timeout and records the exact trusted executable digest,
  object format, and derived graph evidence. It does not transport per-command status/signal/
  timeout observations, own a supervised attempt lifecycle, or prove process-group
  termination. CP-F4/H1d must supply that terminal execution evidence and protected exact
  trusted-base provenance before the result can authorize transport. A native receipt is
  not promoted merely because the CLI process exited.

**Files:**

- Create: `scripts/lib/ci-control/ref-policy.ts`
- Create: `scripts/ci-control-ref-policy.ts`
- Create: `tests/scripts/ci-control-ref-policy.test.ts`
- Modify: `scripts/lib/ci-control/manifest.ts`
- Modify: `tests/scripts/ci-control-manifest.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `package.json`
- Modify: `docs/public-surface.md`

**Focused RED command:**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-manifest.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: fail because the strict policy schema, parser, evaluator, and CLI do not exist.

- [ ] **Step 5 (CP-H1c): Add native exact-object entrypoints**

Extend the canonical repository-hygiene and publication owners to read explicit Git objects
and outgoing histories. Reuse their native scanners, granular codes, and exception
ownership. Both manifest rows currently declare `nativeSchemaVersion: null` and
`digestBinding: none`, and neither owner has a strict revision-bound native receipt to
reuse. This bead therefore adds each owner's first strict versioned report-only receipt
schema and validator, using the existing canonical JSON primitive for exact-byte
serialization. It does not add another scanner, taxonomy, public renderer, or exception
path. Prove a secret added then removed in the outgoing range still blocks and a safe
`HEAD` cannot authorize a different unsafe outgoing OID.

**Adjudicated H1c sequence:** H1c-G first adds only bounded, policy-neutral exact commit-
range and blob-reading primitives to `scripts/lib/ci-control/git-input.ts`; it does not
change classifier selection. H1c-R then adds the repository-hygiene receipt under
`repository-hygiene-decision-owner`. H1c-P adds the publication receipt under
`publication-decision-owner` and does not copy the hygiene owner's sensitive-artifact
policy. H1c-A finally adds thin report-only adapters and changes manifest native schema/
digest declarations only after both owner validators pass. These beads run serially under
one writer and receive independent review before the next bead begins.

H1c discovery and native RED fixtures may proceed after this packet is frozen, but neutral
receipt integration waits for CP-F2e. Each strict native receipt—not `ControlResultV1`—owns
the native detector/schema, independently derived tool/policy digests, exact base/remote/
local OIDs, ordered commit/range and observed-path/blob digests, native causes/outcome/
completeness, claimed and observed scope, limitations, safe structural references,
freshness, and an explicit `report-only` authorization value. The canonical native receipt
payload does not contain its own digest. It is serialized exactly once, and a separate
binding supplies `sha256` over those exact payload bytes; validators recompute that external
binding and reject reconstructed, reserialized, or mismatched bytes.

H1c-A returns a distinct `NativeExactRangeReportOnlyObservationV1`, not the existing
`NativeAdapterResult`/`NativeEvidenceV1`. It validates native bytes and bindings, preserves
native causes, and translates only disposition, but it has no producer or observed-platform
fields and cannot populate trusted native evidence. It reuses `ci.check.passed` and
`ci.native.receipt-unavailable`; deterministic native block observations use only the
owner-specific wrapper codes `ci.native.repository-hygiene.finding` and
`ci.native.privacy-publication.finding`. Those wrapper rows do not replace or collapse the
native cause codes. H1c never fabricates a precondition receipt, producer/platform proof,
terminal attempt or process-group proof, required/observed aggregate set, aggregate
decision, warning governance, or terminal fingerprint; CP-F4/H1d own those transitions and
may construct `NativeEvidenceV1` only after independently binding producer and platform.

The exact range starts at `remoteOid ?? baseOid`, requires full lowercase commit OIDs and
an ancestor relation to `localOid`, enumerates the complete ordered outgoing commit set,
and reads paths, modes, object types, and eligible blob bytes from Git objects only. It
must not consult ambient `HEAD`, the index, worktree bytes, environment-selected refs,
replacement objects, lazy fetch, or `core.hooksPath`. The shared Git input primitive
enforces commit/path/blob/count and byte budgets before traversal, hashes each observed
blob back to its claimed object identity, and makes missing, malformed, unsupported,
timed-out, over-budget, or partial evidence inconclusive rather than an empty pass.

Required fixtures include: safe ambient `HEAD` with a different unsafe outgoing OID; a
private value or sensitive artifact added and removed in an intermediate commit; mismatched
tree/content identity; claimed full range with partial observation; exact safe range;
reserved safe neighbor; base-only historical finding under changed-content-only mode;
missing object/graph, unsupported object format, budget overflow, policy/tool mismatch,
partial traversal, and stale binding. Redaction covers stdout, stderr, JSON, evidence
references, raw Git errors, absolute paths, matched values, and reversible low-entropy
fingerprints. Candidate scanner removal, narrowed observation, severity rewrite, or removal
of the exact-object branch test must be detected.

**H1c files:**

- H1c-G: modify `scripts/lib/ci-control/git-input.ts` and create the dedicated
  `tests/scripts/ci-control-git-input.test.ts`. Do not modify the CP-F3-owned classifier
  test to establish H1c-G behavior.
- H1c-R: modify `scripts/repo-hygiene-guard.ts` and
  `tests/scripts/repo-hygiene-guard.test.ts`.
- H1c-P: modify `scripts/publication-guard.ts` and
  `tests/scripts/publication-guard.test.ts`.
- H1c-A: modify `scripts/lib/ci-control/native-adapter.ts`,
  `scripts/lib/ci-control/reasons.ts`, `controls/ci-control-manifest.json`, and their
  existing companion tests. Modify `scripts/lib/ci-control/manifest.ts` only if the
  existing strict manifest schema cannot express the validated native receipt binding.

The current `--staged`, `--branch-diff`, `--all`, and `--release` entrypoints remain
unchanged. Exact-range receipts are additive and report-only. Publication exact-range
coverage scans transient private-literal introductions but does not claim that worktree-
dependent audit/reference validation ran; H1d must exact-set compose the distinct native
controls rather than relabel either receipt as complete publication assurance.

- [ ] **Step 6 (CP-H1d): Implement exact per-ref verification and atomic cutover**

Pass each `localOid`, `remoteOid`, and ref identity into the classifier and selected lower-level scanners. Revalidate the local ref still resolves to `localOid` immediately before allowing transport. Multi-ref push passes only if every row passes.

Require exact equality between parsed ref updates and terminal observations. Pass Git's
remote name/location as bounded data, preserve child exit `1` versus `2`, prove owned
children terminated, and revalidate each named local ref. Only this bead wires the new
authoritative path into `.husky/pre-push`; prior beads remain additive canaries.

H1d additionally requires current writer, lineage, reviewer, workspace-accounting,
precondition, CP-F2e taxonomy/result, CP-F3 claimed-scope, CP-F4 terminal-attempt, and H1c
observed-scope receipts. Warning-only evidence never authorizes transport. Pre-push produces
admission evidence only; a separately authorized push later requires exact remote-OID
readback and cannot inherit transport success as proof.

- [ ] **Step 7: Wire canonical commands and rich errors**

Add `guard:hooks-installed`; make the pre-push hook consume exact stdin and preserve child exit `1` versus `2`. Replace raw `Error.message` output with registered sanitized cause codes and ordered remediation.

- [ ] **Step 8: Verify GREEN and surrounding guards**

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

- [ ] **Step 9: Independent review and commit each canary bead**

```bash
git commit -m "feat(ci): inspect repository hook identity"
git commit -m "feat(ci): define exact ref update policy"
git commit -m "feat(ci): scan exact outgoing objects"
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
