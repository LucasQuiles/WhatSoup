# GitHub Workflow Authority and Native Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every production bead also requires superpowers:test-driven-development, superpowers:test-integrity, superpowers:writing-fail-closed-gates, and superpowers:verification-before-completion.

**Status:** Pending — reviewed; source mutation is not admitted until CP-F2f, CP-WA1, CP-F3,
CP-H1c, CP-GL1, CP-H1d, CP-F4, and CP-F5 close their foundation prerequisites with
current-head evidence.

**Goal:** Make GitHub Actions the authoritative remote execution and evidence layer for repository-owned controls without duplicating their decisions, while adding protected workflow interpretation, exact merge-result aggregation, and observed-host Linux/macOS portability.

**Architecture:** First build a strict source-wiring inventory and a data-only workflow-policy evaluator on the existing manifest, classifier, result, precondition, attempt, and native-adapter contracts. Then audit and provenance-lock the existing full-SHA workflow dependencies, remove unsafe output transport, establish an independently sourced protected evaluator, and migrate existing quality jobs behind one top-level PR/merge-result orchestrator with exact-set gates. Native portability remains a separate leaf and aggregate domain whose receipts prove observed host properties instead of trusting runner labels.

**Tech Stack:** TypeScript, Node.js 24.15.0 and Node.js 25.x validation, Vitest 4, `yaml` 2.9.0 AST parsing, Git object plumbing, GitHub Actions and reusable workflows, Linux x64 and observed native macOS execution, SHA-256 canonical evidence.

## Global Constraints

- GitHub Actions executes and transports evidence for controls the repository already owns; workflow YAML, action wrappers, and aggregate jobs must not become second policy engines.
- Inventory before adding a workflow, scanner, status, cache, artifact, or hosted rule. A new capability requires proof that no canonical implementation already owns the question.
- Preserve `repo-hygiene-guard.ts`, `publication-guard.ts`, semantic-quality policy/receipt code, `safeguard-diagnostics.ts`, test-integrity policy, and the control-plane manifest/result/classifier modules as their existing decision owners.
- CP-F2f, CP-WA1, CP-F3, CP-H1c, CP-GL1, CP-H1d, CP-F4, and CP-F5 are prerequisites. CP-GL1
  supplies coordinator-owned main/topic remote-ref-set observation before H1d transport,
  remote review, or workflow canaries. No task in this plan may become authoritative while
  workspace-transition accounting, classification, remote lineage observation, exact-ref
  execution, bounded orchestration, or manifest/self-protection parity is incomplete.
- Leaf outcomes are `PASS`, `WARN`, `BLOCK`, `INCONCLUSIVE`, or `NOT_APPLICABLE`. Aggregate authorization is only `PASS`, `BLOCK`, or `INCONCLUSIVE`; a warning never satisfies mandatory evidence.
- A not-applicable result is valid only when a trusted exact-revision classifier receipt supplies a closed reason. A skipped job or absent matrix row is not evidence.
- Require `trusted required set == trusted observed set`. Reject missing, duplicate, substituted, stale, cancelled, timed-out, malformed, nonterminal, wrong-producer, wrong-policy, wrong-platform, or wrong-revision observations.
- Producer authentication, protected-policy provenance, and observed-executor identity are independent receipt families. No App name, workflow name, runner label, signature, or status name substitutes for the other proofs.
- Candidate execution creates irreversible taint for that job, cache, and artifact. A tainted job never later receives a write token, OIDC, signing permission, publication permission, private assurance data, or production network access.
- Untrusted pull-request jobs use `contents: read`, no valuable secrets, bounded direct commands, explicit timeouts, trust-partitioned caches, and terminal attempt receipts.
- Do not run candidate code through `pull_request_target` or a privileged `workflow_run`. Do not consume a candidate artifact in a privileged job without independent producer, digest, and content verification.
- Pin each external action and reusable workflow to a reviewed full commit SHA. Record the upstream repository, reviewed release, source diff, required permissions, network behavior, update mechanism, and exact SHA in one lock registry.
- Preserve the documented Linux Node 24/25 and CodeQL status contexts unchanged while their
  current required/App bindings remain unauthenticated. Replacement gates still require
  exact PR canaries and, only on a supported and separately authorized queue topology, exact
  merge-group canaries. CodeQL ownership and event coverage require hosted readback before
  any source duplication.
- A required workflow must not use workflow-level path filters. Every stable gate always exists, has a static dependency graph, and consumes explicit not-applicable receipts. Repository-local candidate workflows may emit only distinctly named report-only canary summaries; the eventual stable required status is emitted only by the independently sourced protected producer.
- Public diagnostics are staged into a confined directory, scanned after production, and uploaded only from the accepted manifest. Scan stdout, stderr, JSON, summaries, annotations, filenames, reports, screenshots, traces, videos, source maps, archive names, metadata, and bytes.
- Reusable workflow permission chains may maintain or reduce permissions but never elevate them. Privileged release and deployment workflows remain outside the pull-request chain.
- Record observed OS, architecture, runtime, executable digests, filesystem properties, and native capabilities. Never infer native assurance from `runs-on` alone.
- Supplemental tools such as actionlint, zizmor, Dependency Review, and CodeQL are observers unless their exact rule, owner, exception, result adapter, unsafe fixture, and safe neighbor are admitted. They do not replace native repository controls.
- Do not expose `verify:portability`, `policy-gate`, or another assurance name until the named command or job produces the complete evidence its name promises.
- Every task starts from one frozen lineage lease, one writer, one dedupe key, one allowed file set, and one patch-admission packet. A changed source, remote, plan, manifest, policy, toolchain, prerequisite receipt, or hosted observation invalidates dependent evidence.
- Every blocking rule needs an unsafe fixture, adjacent safe neighbor, unavailable-evidence case, redaction test, stable location/fingerprint, renderer parity, reproduction proof, and self-removal mutation.
- Hosted rulesets, required checks, App bindings, environments, action policy, runner groups, secret scanning, push protection, and merge-queue settings remain read-only observations until a separate owner-approved hosted mutation packet exists.
- This plan authorizes source planning and later bounded source commits only. It does not authorize credentials, repository settings, artifact publication, deployment, live service changes, or external posts.

## Frozen Source Evidence

The historical admission used implementation head `1bdd8ea37c7c9f3fb600fe0f5a68901398c50ca3`
and `origin/main` `6fb5ee72e6f2ae6f4ddc858b7fc0db0fae825c0c`. Current local integration
`7f8f63c63b2561b7e0bf4a76fafee9c80dadfae8` preserves the 22-file Task 7/source-split
commit `626db87d34cb3b1d41bedd82757cb01be7035a6f` as first parent and incorporates locally
observed `origin/main` `abe6fe592a2f704deeccf8cc5338abd5a3f8997a` as second parent without
rebasing. The agent-lease delta does not change the three workflow blobs below, but it
changes foundation prerequisites: `agent:lease` is quarantined as a partial precursor and
authoritative CP-WA1 remains incomplete. Prior merge-sensitive and aggregate receipts are
invalid; no current workflow authorization or final verification is claimed. The current
three workflow blobs are:

```text
.github/workflows/quality.yml          sha256:f3edade025565d46a10037f5ca107c8081559b13ab599bc1d24625302069ece1
.github/workflows/tag-release-gate.yml sha256:48da89c6d33f7dc9fd247351567a8da49c3ba770ad5d62bc271854cecb638c45
.github/workflows/whatsoup-guard.yml   sha256:b3887b0d4c671daec96f7a9374dc94d1c60427a310dc2b3fe27dceef7be47c84
```

The following are **Proven** from those exact current source bytes:

- `quality.yml` handles `merge_group` and prevents merge-group cancellation; the other two
  workflows do not handle `merge_group`;
- all 14 direct external `uses:` references are full 40-hex SHAs; source syntax alone does
  not prove upstream provenance, reviewed-release mapping, permissions, or enforcement;
- no top-level `policy-gate`, `portability-gate`, exact-set aggregate, or observed-host receipt exists;
- Linux Node 24/25 owns broad quality execution, while macOS runs only the narrow BOT ERRORS clock hermeticity selection;
- the pull-request quality job executes candidate installation and scripts before receiving `TEST_INTEGRITY_DEPLOY_KEY` in the same runner;
- browser screenshots are generated after the publication scan and uploaded directly in both quality and tag-release workflows;
- setup-node and Playwright caches do not bind trust class, protected policy digest, or producer identity;
- `.github/workflows/whatsoup-guard.yml` has concurrency but no explicit job timeout;
- `ci:classify`, `guard:hooks-installed`, and `ci:ref-policy` exist but are not authoritatively joined into workflow aggregation;
- `safeguard-diagnostics.ts` owns useful YAML AST checks but maintains a separate hard-coded inventory and does not enforce full-SHA pins, `merge_group`, taint, scan-before-upload, observed-host proof, or exact-set gates;
- the only `continue-on-error` site is explicitly advisory history scanning;
- current source declares read-only workflow permissions and contains no OIDC, package publication, deployment environment, `pull_request_target`, `workflow_run`, or artifact-download promotion path.

The following remain **Inconclusive** until fresh read-only hosted receipts exist: required-check names and App bindings, CodeQL default or advanced setup and merge-group coverage, merge-queue enablement, ruleset precedence, organization-required workflows, action policy, cache visibility, fork approval, runner isolation, deploy-key scope, secret scanning, push protection, and protected environments. The tracked quality-guardrails checklist documents one classic-protection approval for non-admins, admin bypass, and merge-queue unavailability on the current user-owned repository. Those statements are documented observations, not authenticated hosted evidence consumed by this plan.

## Dependency and Promotion Order

```text
CP-F2f + CP-WA1 + CP-F3 + CP-H1c + CP-GL1 + CP-H1d + CP-F4 + CP-F5 current-head closure
  -> CP-W0 source wiring inventory
    -> CP-W1a protected data-only workflow evaluator
      -> CP-W0b immutable dependency lock + report-only inventory canary
        -> CP-W2a diagnostic/output transport + cache partitioning
          -> CP-W1b independently sourced producer declaration and canary
            -> CP-W2b untrusted PR/merge-group leaves + protected policy-gate canary
              -> CP-P1 protected observed-host Linux/macOS canary
                -> real PR canaries + synthetic/source merge-group proof
                  -> real merge-group canary only after supported topology and separate queue authorization
                  -> separate CP-G1 hosted status/private-assurance cutover request
```

Inventory, evaluators, new observers, and gates begin report-only. No new status becomes
required in this plan. Preserve the documented existing status contexts through canaries
and any later atomic cutover without asserting their required bindings before authenticated
hosted readback.

## Patch Admission Packet

Before each task, freeze and review:

```text
packet ID and dedupe key
evidence label: Proven | Inconclusive | Proposed
base, candidate, tested-merge, remote, plan, manifest, policy, toolchain OIDs/digests
prerequisite receipt digests
one writer identity and allowed source-write paths
canonical control and decision owner
exact file and structural location
reachable bypass or missing assurance
synthetic unsafe fixture
adjacent safe neighbor
unavailable-evidence fixture
expected leaf outcome and aggregate decision/exit
smallest authoritative repair
controls and behavior that remain unchanged
focused RED and GREEN commands
surrounding regression and public-output leak commands
rollback or ordinary revert strategy
hosted assumptions and stop conditions
```

---

### Task 1: CP-W0 — Canonical Source-Wiring Inventory and AST Reuse

**Files:**

- Create: `scripts/lib/ci-control/workflow-ast.ts`
- Create: `scripts/lib/ci-control/workflow-contracts.ts`
- Create: `scripts/lib/ci-control/workflow-inventory.ts`
- Create: `scripts/ci-control-workflow-inventory.ts`
- Create: `tests/scripts/ci-control-workflow-inventory.test.ts`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `scripts/lib/ci-control/manifest.ts`
- Modify: `tests/scripts/ci-control-manifest.test.ts`
- Modify: `scripts/lib/ci-control/classifier.ts`
- Modify: `tests/scripts/ci-control-classifier.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface WorkflowJobSourceV1 {
  jobId: string;
  needs: string[];
  condition: string | null;
  permissions: Record<string, string>;
  timeoutMinutes: number | null;
  runnerClaim: string;
  steps: {
    stepId: string | null;
    condition: string | null;
    actionRef: string | null;
    command: string | null;
    secrets: string[];
    caches: string[];
    artifacts: string[];
  }[];
}

export interface WorkflowSourceV1 {
  path: string;
  workflowName: string;
  triggers: WorkflowTriggerV1[];
  permissions: Record<string, string>;
  jobs: WorkflowJobSourceV1[];
  sourceBlobOid: string;
  sourceDigest: string;
}

export interface WorkflowControlWiringV1 {
  controlId: string;
  domain: string;
  decisionOwner: string;
  canonicalCommand: string;
  nativeResultSchema: string;
  localAdapters: { path: string; mode: string }[];
  remoteAdapters: { workflow: string; job: string; step: string }[];
  triggers: WorkflowTriggerV1[];
  applicability: string[];
  sourceBindings: string[];
  permissions: Record<string, string>;
  secretNames: string[];
  oidc: boolean;
  platforms: { label: string; osClaim: string; architectureClaim: string; runtimeClaim: string }[];
  timeoutMinutes: number | null;
  concurrency: { group: string | null; cancelInProgress: boolean | null };
  cacheTrustClasses: string[];
  artifactTrustClasses: string[];
  expectedStatusName: string | null;
  expectedProducer: string | null;
  evidenceOutputs: string[];
  availability: WorkflowInventoryAvailabilityV1;
  findings: string[];
  lastVerifiedOid: string;
}

export interface WorkflowInventoryV1 {
  schemaVersion: 1;
  eventRevision: EventRevisionV1;
  lineageLeaseDigest: string;
  manifestDigest: string;
  policyDigest: string;
  workflowSourceDigest: string;
  rows: WorkflowControlWiringV1[];
  views: {
    existsButNotWired: string[];
    wiredButNotOwned: string[];
    duplicated: string[];
    advisoryUsedAsBlocking: string[];
    requiredEvidenceGaps: string[];
    hostedStateUnknown: string[];
    wasteAndOverlap: string[];
  };
}

export interface WorkflowInventoryEnvelopeV1 {
  inventory: WorkflowInventoryV1;
  inventoryEvidenceDigest: string;
  observedAt: string;
}

export interface WorkflowTriggerV1 {
  event: 'pull_request' | 'merge_group' | 'push' | 'schedule' | 'workflow_dispatch' | 'release';
  types: string[];
  branches: string[];
  tags: string[];
  paths: string[];
  schedule: string[];
}

export type EventRevisionV1 =
  | { eventName: 'pull_request'; baseOid: string; headOid: string; testedMergeOid: string }
  | { eventName: 'merge_group'; baseRef: string; trustedBaseOid: string; proposedMergeOid: string; mergeGroupHeadRef: string; memberHeadOidsDigest: string }
  | { eventName: 'push'; beforeOid: string | null; pushedOid: string }
  | { eventName: 'tag'; beforeOid: string | null; pushedOid: string; tagRef: string }
  | { eventName: 'release'; trustedPredecessorOid: string | null; targetOid: string; tagRef: string; action: string }
  | { eventName: 'schedule' | 'workflow_dispatch'; trustedPredecessorOid: string | null; selectedOid: string };

export type CapabilityDeploymentStateV1 =
  | 'report-only'
  | 'advisory'
  | 'canary'
  | 'blocking'
  | 'quarantined'
  | 'deprecated';

export type WorkflowInventoryAvailabilityV1 =
  | 'absent'
  | 'planned'
  | CapabilityDeploymentStateV1;

export interface WorkflowLineageLeaseInputV1 {
  eventRevision: EventRevisionV1;
  candidateRef: string;
  remoteRef: string;
  manifestDigest: string;
  policyDigest: string;
  toolchainDigest: string;
  selectedPlanDigest: string;
  prerequisiteReceiptDigests: string[];
  createdAt: string;
}

export interface WorkflowLineageLeaseV1 extends LineageLeaseV1 {
  eventRevision: EventRevisionV1;
  eventRevisionDigest: string;
  manifestDigest: string;
}

export interface ObservedExecutorIdentityV1 {
  schemaVersion: 1;
  producer: ProducerIdentityV1;
  protectedWorkflowDigest: string;
  protectedToolDigest: string;
  terminalAttemptDigest: string;
  runnerLabelClaim: string;
  os: string;
  architecture: string;
  runtime: { name: 'node'; version: string; executableDigest: string };
  shell: { path: string; executableDigest: string; versionDigest: string };
  filesystem: {
    caseSensitive: boolean;
    symlink: boolean;
    executableMode: boolean;
    atomicRename: boolean;
    lockBehaviorDigest: string;
  };
  nativeCapabilities: string[];
  capabilityDigest: string;
  observedBeforeCandidateExecution: boolean;
  createdAt: string;
  validUntil: string;
}

export type ProtectedReceiptTransportV1 =
  | {
      kind: 'github-check-run-readback';
      repository: string;
      checkRunId: string;
      headSha: string;
      producer: ProducerIdentityV1;
      workflowSha: string;
      runId: string;
      attempt: number;
      payloadDigest: string;
      authenticatedAt: string;
    }
  | {
      kind: 'signed-attestation';
      attestationDigest: string;
      subjectDigest: string;
      producer: ProducerIdentityV1;
      workflowSha: string;
      runId: string;
      attempt: number;
      payloadDigest: string;
      authenticatedAt: string;
    };

export function parseWorkflowSource(path: string, bytes: Uint8Array, blobOid: string): WorkflowSourceV1;
export function buildWorkflowInventory(cwd: string, lease: WorkflowLineageLeaseV1): WorkflowInventoryEnvelopeV1;
export function inventoryEvidenceDigest(inventory: WorkflowInventoryV1): string;
export function acquireWorkflowLineageLease(cwd: string, input: WorkflowLineageLeaseInputV1): WorkflowLineageLeaseV1;
export function validateObservedExecutorIdentity(value: unknown): ObservedExecutorIdentityV1;
export function observedExecutorIdentityDigest(value: ObservedExecutorIdentityV1): string;
```

- [ ] **Step 1: Freeze the current source-wiring characterization**

Write tests that parse the exact current three workflow blobs and assert their present jobs, typed trigger configuration including event types and filters, permissions, timeouts, concurrency, action references, cache steps, artifact steps, secret references, and command invocations. Assert the seven proven inventory views above, including `ci:classify` as available-but-unwired and the candidate-code/private-key sequence as a binding gap. Add two-member merge-group, regenerated proposed-merge OID, stale PR receipt, missing base object, moved merge-group head-ref, scheduled/manual selected OID, missing scheduled predecessor, tag push, and release-target fixtures.

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-workflow-inventory.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected RED: the workflow AST and inventory modules do not exist. The existing safeguard tests remain green when run separately.

- [ ] **Step 2: Extract the existing YAML parser without changing safeguard decisions**

Move the strict `parseDocument(..., { merge: false, stringKeys: true, uniqueKeys: true })` boundary and exact record/list helpers from `safeguard-diagnostics.ts` into `workflow-ast.ts`. Reject YAML parse errors, merge keys, duplicate keys, non-string keys, hostile aliases, unknown scalar types, and input over the declared byte/node/depth budgets before traversal. Make `safeguard-diagnostics.ts` import this module; do not change its current findings or output.

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/ci-control-workflow-inventory.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected GREEN: current safeguard snapshots remain exact; malformed, duplicate, oversized, one-node-over, alias, and merge-key fixtures fail closed.

- [ ] **Step 3: Implement the manifest-to-source join**

Read the manifest, `package.json`, hooks, workflows, dependency locks, and generated-input declarations through `git cat-file` from the exact tree named by the validated lineage lease. Parse manifest bytes with `parseControlManifestBytes()`; do not call ambient `loadControlManifest()` for authoritative inventory. Join manifest control IDs, package commands, hook adapters, workflow steps, trust inputs, and evidence outputs only after every source belongs to that tree. Multiple observers on one surface are valid; conflicting canonical decision owners are not.

Extend the canonical classifier/lease owner once for `schedule`, `workflow_dispatch`, tag, and release normalization. Scheduled/manual/release input names a selected/target OID and trusted predecessor; a missing predecessor selects system-wide coverage and remains `INCONCLUSIVE`. Do not coerce these events to PR or local semantics. Merge-group input preserves proposed merge and member-set identity. `WorkflowLineageLeaseV1` binds the complete normalized exact-revision input and `eventRevisionDigest`; every downstream receipt validator compares its event revision with that digest. The workflow layer never fabricates base/candidate/merge sentinels.

Separate a control's policy `mode` from its deployment state in the canonical manifest schema. `CapabilityDeploymentStateV1` is exported only by `manifest.ts`; `workflow-contracts.ts` imports it and owns only the derived inventory-view union. Present controls receive one reviewed `deploymentState`; planned capabilities live in a non-pass-capable roadmap catalog rather than fictional control records. Workflow inventory derives `report-only|advisory|canary|blocking|quarantined|deprecated` from that canonical field and derives `absent|planned` only from the strict capability/roadmap join. No workflow or caller may override availability.

Keep `observedAt` outside `WorkflowInventoryV1`. `inventoryEvidenceDigest()` hashes only the deterministic inventory projection so local and remote observations of the same tree compare exactly despite different observation times.

- [ ] **Step 4: Add the bounded CLI**

```text
npm run ci:workflow-inventory -- --candidate <40-hex> --json
```

The CLI uses pinned Node, accepts no caller-supplied control list or availability override, writes one canonical JSON object, and returns `0` only for a complete trusted inventory, `1` for a deterministic source contradiction, and `2` for missing or invalid evidence.

- [ ] **Step 5: Prove exact views and non-duplication**

Add fixtures for an unwired canonical command, unowned workflow command, duplicate decision owner, advisory result used as blocking, missing producer binding, hosted-state unknown, redundant duplicate suite, multiple legitimate observers, and a planned capability falsely represented as pass-capable.

- [ ] **Step 6: Verify and commit**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-workflow-inventory.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git commit -m "feat(ci): inventory workflow control wiring"
```

Rollback is an ordinary revert restoring the parser to `safeguard-diagnostics.ts` and removing only the additive inventory command. No workflow or hosted setting changes in this task.

---

### Task 2: CP-W1a — Protected Data-Only Workflow-Policy Evaluator

**Files:**

- Create: `scripts/lib/ci-control/workflow-policy.ts`
- Create: `scripts/ci-control-workflow-policy.ts`
- Create: `tests/scripts/ci-control-workflow-policy.test.ts`
- Create: `tests/fixtures/ci-control/workflow-policy-fixtures.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `package.json`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`

**Interfaces:**

```ts
export interface ProtectedWorkflowPolicyInputV1 {
  eventRevision: EventRevisionV1;
  lineageLeaseDigest: string;
  manifestDigest: string;
  protectedPolicyDigest: string;
  protectedToolDigest: string;
  protectedWorkflowDigest: string;
  receiptTransport: ProtectedReceiptTransportV1;
  observedExecutor: ObservedExecutorIdentityV1;
  observedExecutorReceiptDigest: string;
  observedExecutorTransport: ProtectedReceiptTransportV1;
}

export interface WorkflowPolicyEvaluationV1 {
  schemaVersion: 1;
  inventoryDigest: string;
  findings: ControlResultV2[];
  aggregate: ControlResultV2;
}

export function evaluateWorkflowPolicyDataOnly(
  cwd: string,
  input: ProtectedWorkflowPolicyInputV1,
): WorkflowPolicyEvaluationV1;
```

- [ ] **Step 1: Write RED structural and self-bypass fixtures**

Cover mutable action refs, missing `merge_group`, excessive permissions, privilege after candidate execution, private material after taint, `pull_request_target` candidate checkout, privileged `workflow_run` artifact use, metadata shell interpolation, missing timeouts, unpartitioned caches, upload-before-scan, conditional mandatory gates, `continue-on-error`, ignored exits, masked pipelines, missing static `needs`, missing exact bindings, runner-label-only proof, and candidate removal of the evaluator or its fixtures.

Use named builders in `workflow-policy-fixtures.ts`: `mutableActionUnsafe`, `immutableActionSafe`, `mergeGroupMissingUnsafe`, `mergeGroupBoundSafe`, `privilegeAfterTaintUnsafe`, `unprivilegedCandidateSafe`, `uploadBeforeScanUnsafe`, `scanBeforeUploadSafe`, `maskedPipelineUnsafe`, `strictTerminalSafe`, `candidateJudgeUnsafe`, `protectedDataOnlySafe`, and `forgedProtectedReceiptUnsafe`. Each builder returns exact bytes and the closed expected code; fixture names are stable taxonomy references rather than directory glob order.

For every unsafe fixture, add a neighboring safe workflow and an unavailable protected-policy or Git-object case. Assert native granular reason codes and canonical remediation from the CP-F2 registry.

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-workflow-policy.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected RED: `evaluateWorkflowPolicyDataOnly` is absent.

- [ ] **Step 2: Implement exact Git-object evaluation**

Read candidate workflows, package scripts, hooks, manifest, and dependency lock files as Git objects. Treat their content as data only. Do not check out the candidate tree, import candidate modules, execute candidate package scripts, restore candidate caches, or consume candidate artifacts.

- [ ] **Step 3: Preserve native ownership**

Extract the existing safeguard predicates behind a native safeguard receipt owned by `safeguard-diagnostics.ts`. The protected evaluator validates and thin-adapts that native receipt; it does not copy the predicate or create another decision owner. Register actionlint and zizmor output only as supplemental native observations after validating their tool identity, exact candidate binding, schema, and evidence digest. Their adapters may preserve causes and add orchestration metadata; they may not redefine repository policy, exceptions, severity, or aggregate decisions.

- [ ] **Step 4: Bind three independent proof families**

Tests must independently remove or alter producer identity, protected policy/workflow/tool digests, observed executor identity, and authenticated transport binding. Validate the full executor receipt through the Task 1 canonical validator, hash its exact canonical bytes, and require the executor transport payload digest to match; a digest without authenticated bytes is report-only. Missing proof returns `INCONCLUSIVE`; a proven unauthorized producer, altered protected policy, prohibited executor, forged matching fields, or payload-digest mismatch returns `BLOCK`. An expected App with the wrong protected policy must never pass. A caller-supplied self-describing receipt file is report-only and cannot satisfy an authoritative row.

Register and test the first workflow-policy codes in the same bead, including
`workflow.action.reference.mutable`, `workflow.trigger.merge-group.missing`,
`workflow.permission.post-taint.elevated`, `workflow.artifact.upload.before-scan`,
`workflow.execution.exit.ignored`, `binding.policy.digest.unavailable`,
`binding.policy.digest.mismatch`, and `binding.producer.identity.unauthorized`. Unknown codes
remain `INCONCLUSIVE`; existing code meanings may not be changed.

- [ ] **Step 5: Add the source-only CLI**

```text
npm run ci:workflow-policy -- \
  --event-revision <validated-json-path> \
  --lineage-lease <validated-json-path> \
  --receipt-source report-only-file:<path> \
  --json
```

The source-only CLI is report-only until an independently sourced producer and authenticated readback transport exist. File input never upgrades itself to protected evidence. If invoked from candidate-controlled workflow bytes, its result explicitly records `trustClass: untrusted-candidate` and cannot satisfy an authoritative requirement.

- [ ] **Step 6: Verify and commit**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-workflow-policy.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/ci-control-result.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git commit -m "feat(ci): evaluate workflows as protected data"
```

This commit creates no GitHub workflow and consumes no secret. Its pass cannot authorize a pull request.

---

### Task 3: CP-W0b — Immutable Dependency Lock and Report-Only Remote Inventory

**Files:**

- Create: `.github/workflows/ci-inventory.yml`
- Create: `tests/scripts/ci-inventory-workflow.test.ts`
- Create: `controls/github-actions-lock.json`
- Create: `scripts/lib/ci-control/workflow-dependencies.ts`
- Create: `scripts/ci-control-workflow-dependencies.ts`
- Create: `tests/scripts/ci-control-workflow-dependencies.test.ts`
- Create: `.github/dependabot.yml`
- Modify: `controls/ci-control-manifest.json`
- Modify: `package.json`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `.github/workflows/quality.yml`
- Modify: `.github/workflows/tag-release-gate.yml`
- Modify: `.github/workflows/whatsoup-guard.yml`

**Interfaces:**

```ts
export interface WorkflowDependencyLockV1 {
  schemaVersion: 1;
  dependencies: {
    sourceRepository: string;
    commitSha: string;
    reviewedRelease: string;
    owner: string;
    permissions: string[];
    networkBehavior: string[];
    updateMechanism: 'dependabot-review-pr' | 'manual-review-pr';
    sourceDigest: string;
  }[];
}
```

Compatibility readers may accept `AnyControlResult`, but V1 remains historical/report-only
and is rejected from every protected required set, aggregate authorization, native-lane
satisfaction, and authoritative public projection. Fixtures must prove a schema-valid V1
receipt remains readable for history while failing both gate inputs and observed-row matching.

- Consumes: `npm run ci:workflow-inventory`, the dependency lock, exact classifier and lineage receipts, canonical `ControlResultV2`, and the latest separately authenticated read-only hosted-settings receipt when available.
- Produces: one sanitized workflow-inventory result and one non-authoritative check summary bound to the exact event revision.

- [ ] **Step 1: Write RED workflow AST tests**

Require `contents: read`, no secrets/OIDC/write permissions, explicit timeout, bounded concurrency, full-SHA action refs, a typed `EventRevisionV1`, lineage-lease input, scan-before-upload, and a report-only check name that cannot be mistaken for `policy-gate`. Reject candidate-selected controls, workflow-level required-check path filters, shell interpolation, and a success step after an ignored failure. Add lock fixtures for mutable refs, short SHAs, wrong upstream repository, force-moved release tags, workflow/lock mismatch, missing permission/network declarations, and a valid reviewed full-SHA neighbor.

- [ ] **Step 2: Audit, import, and maintain immutable action identities**

For each current external action, treat the already present 40-hex workflow reference as an
unverified input. Resolve its intended reviewed release tag and peeled commit, verify the
upstream repository and source diff, then import that identity into
`controls/github-actions-lock.json`. Modify an existing workflow reference only when this
audit proves a mismatch or an admitted update is required. The dependency lock exists before
`ci-inventory.yml` becomes its first new consumer. The packet must include the exact command
output and reviewed commit; a tag, branch, shortened SHA, unresolved annotated tag,
force-moved reviewed tag, or unexplained current pin stops the task.

```bash
git ls-remote https://github.com/actions/checkout.git 'refs/tags/v4' 'refs/tags/v4^{}'
```

Expected: one reviewed tag object and, when annotated, one peeled 40-hex commit. Repeat for every external action used by this workflow.

Add a deterministic `npm run ci:workflow-dependencies -- refresh --json` preview that never mutates active policy without a reviewed patch. A reviewer confirms upstream source, release diff, permissions, network behavior, and source digest. Configure Dependabot's `github-actions` ecosystem to open bounded review PRs; do not auto-merge them.

- [ ] **Step 3: Add the report-only workflow**

Trigger on `pull_request` changes to workflows/actions/hooks/controls/package scripts, default-branch `push`, weekly `schedule`, and `workflow_dispatch`. A path-filtered report-only workflow is allowed only while it is not required. The job checks out the exact event revision, verifies observed Git OIDs, runs the canonical inventory and dependency-lock CLIs, scans the confined result directory, and publishes the canonical summary. Failure to read hosted-state reference evidence remains `INCONCLUSIVE`.

Before Task 6 changes workflow names, events, or providers, obtain a separately authenticated read-only hosted receipt for the current required status names and expected Apps, whether CodeQL uses default or advanced setup and which events it covers, and whether merge queue is enabled. If any field is unavailable, the inventory can remain report-only, but Task 6 source migration and merge canaries stop; source inference is not hosted readback.

- [ ] **Step 4: Verify workflow structure and local parity**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-inventory-workflow.test.ts \
  tests/scripts/ci-control-workflow-inventory.test.ts \
  tests/scripts/ci-control-workflow-dependencies.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run ci:workflow-inventory -- --candidate "$(git rev-parse HEAD)" --json
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
```

Expected: tests pass; local and workflow inventory schemas and digests match for the same Git object. The workflow remains report-only.

- [ ] **Step 5: Commit and canary without promotion**

```bash
git commit -m "ci: pin workflow dependencies"
git commit -m "ci: add report-only workflow inventory"
```

After push authority is separately granted, observe at least one same-repository PR, one fork-equivalent synthetic fixture, and one default-branch run. A successful canary is evidence only for its exact OID and does not change required checks.

---

### Task 4: CP-W2a — Safe Diagnostic Transport and Cache Trust Partitioning

**Files:**

- Create: `scripts/lib/ci-control/public-output-transport.ts`
- Create: `scripts/ci-diagnostic-publication.ts`
- Create: `tests/scripts/ci-diagnostic-publication.test.ts`
- Create: `scripts/lib/ci-control/cache-trust.ts`
- Create: `tests/scripts/ci-control-cache-trust.test.ts`
- Modify: `.github/workflows/quality.yml`
- Modify: `.github/workflows/tag-release-gate.yml`
- Modify: `.github/workflows/whatsoup-guard.yml`
- Modify: `scripts/publication-guard.ts`
- Modify: `tests/scripts/publication-guard.test.ts`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export interface TrustedCacheIdentityV1 {
  schemaVersion: 1;
  trustClass: 'untrusted-candidate' | 'reviewed-source' | 'protected-policy' | 'trusted-build';
  eventName: EventRevisionV1['eventName'];
  os: string;
  architecture: string;
  runtimeDigest: string;
  lockDigest: string;
  policyDigest: string;
  producerReceiptDigest: string | null;
  contentManifestDigest: string;
}

export interface DiagnosticPublicationReceiptV1 {
  schemaVersion: 1;
  eventRevision: EventRevisionV1;
  lineageLeaseDigest: string;
  policyDigest: string;
  producerDigest: string;
  toolDigest: string;
  terminalAttemptDigest: string;
  inputDirectoryDigest: string;
  acceptedMembers: { path: string; type: 'file'; mode: string; size: number; digest: string }[];
  rejectedFindingIds: string[];
  manifestDigest: string;
  exactPublishedBytesDigest: string;
  createdAt: string;
  validUntil: string;
}

export interface PublicOutputTransportReceiptV1 {
  schemaVersion: 1;
  controlResultDigest: string;
  terminalAttemptDigest: string;
  channels: ('stdout' | 'stderr' | 'json' | 'summary' | 'annotation' | 'artifact-name' | 'artifact-bytes')[];
  projectedBytesDigest: string;
  omittedSensitiveFields: string[];
  publication: DiagnosticPublicationReceiptV1;
}
```

- [ ] **Step 1: Write RED output-channel, cache-taint, and artifact-order tests**

Reject upload before scan, direct upload from Playwright output, raw child stdout/stderr reaching public logs, independently authored summaries or annotations, sensitive artifact names, symlinked members, path traversal, unsupported member types, one-byte mutation, screenshots/traces/reports/source maps that fail canonical publication scanning, PR-writable cache restore in protected/default/release execution, cache identity missing a trust or policy dimension, and output publication without a terminal attempt. Test exact-limit, one-byte-over, multibyte boundary, truncated receipt, stale lock, and scanner timeout cases.

- [ ] **Step 2: Implement irreversible cache partitioning**

Build every cache key from trust class, event, observed OS/architecture, pinned runtime, dependency lock, protected policy, and producer identity. Candidate pull requests may restore/save only `untrusted-candidate` caches. Until Task 5 validates authenticated producer transport and an immutable cache-content manifest, protected, default-branch, release, publication, and deployment lanes use no cache. A later protected cache requires both `producerReceiptDigest` and `contentManifestDigest` to match authenticated readback; a key string or self-described digest is only partitioning metadata. Higher-trust lanes never consume a PR-writable cache. Copying, renaming, or changing a cache key cannot upgrade its producer receipt.

- [ ] **Step 3: Extend the canonical publication owner**

Add thin confined-file and archive adapters to `publication-guard.ts`; reuse its private-literal policy, redaction inputs, and public serializer. The adapter validates names, metadata, member types, sizes, and bytes and emits only opaque finding IDs. It must not create a second privacy catalog, fingerprint scheme, message catalog, or exception path.

- [ ] **Step 4: Implement one bounded public-output transport**

Run authoritative child commands with direct executable/argument arrays and captured stdout/stderr. Generate JSON, summaries, annotations, artifact names, and accepted files from the same validated `ControlResultV2` plus explicit redaction inputs. Sanitize exact bytes before any public projection; raw child output cannot stream directly to GitHub logs. Bind the accepted projections to producer/tool/policy, terminal attempt, event revision, lineage lease, freshness, and the digest of the exact emitted bytes. Missing or inconclusive scanning publishes only a bounded safe control-plane error and no diagnostic payload. Historical V1 may be rendered only through an explicitly non-authorizing history view.

- [ ] **Step 5: Reorder browser diagnostic publication**

In quality and tag release: run tests, collect bounded diagnostics into a new confined directory, invoke `ci-diagnostic-publication`, and upload only the accepted manifest set. Keep the scanner and upload steps under `if: always()`, but condition upload on a validated scanner pass. Missing, crashed, timed-out, or inconclusive scanning prevents upload.

- [ ] **Step 6: Add the missing explicit timeout and preserve advisory semantics**

Give `whatsoup-guard.yml` a measured explicit timeout. Preserve the existing history scan as advisory and ensure its `continue-on-error` cannot satisfy a mandatory result or mask another step.

Register and test `workflow.artifact.upload.before-scan`,
`feedback.output.data.sensitive-echo`, `feedback.output.bytes.over-budget`,
`trust.cache.class.cross-restore`, `evidence.receipt.state.nonterminal`, and
`evidence.receipt.digest.mismatch`. A warning-only history scan remains a separate advisory
observation; it cannot satisfy any required row or contribute to aggregate `PASS`.

- [ ] **Step 7: Verify and commit in two reviewable beads**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-cache-trust.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git commit -m "ci: partition workflow caches by trust"

bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-diagnostic-publication.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git commit -m "ci: scan diagnostics before upload"
```

Do not combine cache authority and public-output transport into one commit. Rollback restores the prior workflow source but never republishes a rejected artifact or allows a higher-trust lane to restore a lower-trust cache.

---

### Task 5: CP-W1b — Independently Sourced Producer Declaration and Authenticated Canary

**Files:**

- Create: `controls/protected-workflow-producers.json`
- Create: `scripts/lib/ci-control/protected-producer.ts`
- Create: `tests/scripts/ci-control-protected-producer.test.ts`
- Create: `.github/workflows/reusable-workflow-policy-canary.yml`
- Modify: `controls/ci-control-manifest.json`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`

**Interfaces:**

```ts
export interface ProtectedProducerReceiptV1 {
  schemaVersion: 1;
  transport: ProtectedReceiptTransportV1;
  credentialAudience: string;
  protectedPolicyDigest: string;
  protectedManifestDigest: string;
  protectedToolDigest: string;
  nativeEvidenceDigests: string[];
  observedExecutor: ObservedExecutorIdentityV1;
  observedExecutorReceiptDigest: string;
  observedExecutorTransport: ProtectedReceiptTransportV1;
  eventRevision: EventRevisionV1;
  lineageLeaseDigest: string;
  payloadDigest: string;
  createdAt: string;
  validUntil: string;
}
```

- [ ] **Step 1: Stop unless an independent source is declared**

The owner must choose and verify either an organization/enterprise required workflow or a separately operated GitHub App that loads protected workflow/policy/tool bytes independently of the candidate. Record its exact App identity, protected workflow commit, credential audience, authenticated receipt/readback transport, and read-only hosted receipt. A repository-local candidate workflow alone cannot satisfy this step.

Expected without that declaration: `INCONCLUSIVE binding.policy.digest-unavailable`; no source cutover and no secret movement.

- [ ] **Step 2: Write RED producer, policy, executor, and taint tests**

Cover expected App with wrong workflow SHA, expected workflow with wrong policy digest, correct producer on an unobserved host, candidate-controlled policy, forged caller file with matching fields, check-run payload digest mismatch, signed subject mismatch, replayed run/attempt, stale receipt, candidate code before private data, background child surviving into a credential step, PR-writable cache restore, and private artifact consumption.

- [ ] **Step 3: Implement the protected producer registry and validator**

Reject unknown fields, duplicate producers, mutable workflow refs, missing audiences, unbounded validity, absent policy/manifest/tool digests, unrecognized transport, or readback/payload mismatch. The registry declares expected identities; it does not mint evidence or treat a configured App as proof of execution. Authoritative acquisition is either authenticated GitHub check-run/API readback bound to repository and head SHA, or a verified signed attestation bound to the exact payload digest. Caller-supplied files remain report-only.

- [ ] **Step 4: Add the repository-local canary consumer**

The repository-local reusable workflow is named `reusable-workflow-policy-canary.yml` and consumes an authenticated protected receipt as data. It does not mint, alter, or execute the protected policy and never emits a status named `policy-gate`. It verifies repository, event revision, lineage lease, producer, protected workflow, tool, policy, payload, run/attempt, executor receipt, and freshness before producing a distinctly named canary summary. Permissions remain `contents: read`; private policy access belongs only to the independently operated producer, not the candidate-controlled consumer.

- [ ] **Step 5: Canary before removing the current private-key path**

Run old and protected evaluations in parallel on synthetic unsafe/safe revisions and real same-repository PRs. Compare native causes, exact bindings, decisions, and result sets. The protected lane must prove it cannot execute candidate code or receive candidate caches/artifacts. Register and test `binding.producer.identity.unavailable`, `binding.producer.identity.unauthorized`, `binding.policy.digest.mismatch`, `binding.executor.identity.unavailable`, `binding.agent.result.invalid-schema`, and `evidence.receipt.attempt.replayed` in the same bead.

- [ ] **Step 6: Preserve the current authority and prepare three distinct cutovers**

Do not remove `TEST_INTEGRITY_DEPLOY_KEY`, `ssh-keyscan`, or the private clone in this source task. Until a separately approved hosted cutover binds the protected producer's exact check as required and reads it back, the current candidate/private-key path remains a proven unresolved risk and the new path remains a canary. Prepare separate packets for: (1) private-assurance transport removal, (2) source workflow leaf-ownership transfer, and (3) hosted required-status/App binding. Each packet has its own current-state receipt, atomic transition, rollback receipt, and no-dual/no-zero-authority proof.

- [ ] **Step 7: Verify and stop at hosted mutation**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-protected-producer.test.ts \
  tests/scripts/ci-control-workflow-policy.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git commit -m "ci: validate protected policy canary receipts"
```

Do not configure an organization-required workflow, App, credential, or required check under this task's source authority. Do not claim the candidate/private-key path is fixed. Submit the three separate mutation packets only after authenticated canaries and current hosted readback exist.

---

### Task 6: CP-W2b — Untrusted PR/Merge Leaves and Protected Exact-Set Gate Canary

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/reusable-quality.yml`
- Create: `.github/workflows/reusable-dependency-review.yml`
- Create: `scripts/lib/ci-control/gate.ts`
- Create: `scripts/ci-control-gate.ts`
- Create: `tests/scripts/ci-control-gate.test.ts`
- Create: `tests/scripts/ci-orchestrator-workflow.test.ts`
- Modify: `.github/workflows/quality.yml`
- Modify: `controls/ci-control-manifest.json`
- Modify: `package.json`
- Modify: `scripts/lib/ci-control/result.ts`
- Modify: `tests/scripts/ci-control-result.test.ts`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`

**Interfaces:**

```ts
export interface RequiredSetReceiptV1 {
  schemaVersion: 1;
  eventRevision: EventRevisionV1;
  lineageLeaseDigest: string;
  protectedManifestDigest: string;
  classifierReceiptDigest: string;
  protectedWorkflowInventoryDigest: string;
  protectedWorkflowSourceDigest: string;
  protectedPolicyDigest: string;
  protectedToolDigest: string;
  gateId: 'policy-gate-canary' | 'portability-gate-canary';
  requiredRows: RequiredCheckV1[];
  requiredRowsDigest: string;
  producerReceiptDigest: string;
  payloadDigest: string;
  transport: ProtectedReceiptTransportV1;
}

export interface AttemptHistoryReadbackV1 {
  schemaVersion: 1;
  attemptId: string;
  controlId: string;
  eventRevisionDigest: string;
  policyDigest: string;
  toolDigest: string;
  preconditionReceiptDigest: string;
  resultEvidenceDigest: string;
  supervisorLeaseReceiptDigest: string;
  supervisorTerminalReceiptDigest: string;
  supervisorCloseReceiptDigest: string;
  terminalAttemptReceiptDigest: string;
  orderedHistoryEntryDigests: [string, string, string, string];
  exactTerminalBytesDigest: string;
  appendOnlyHistoryDigest: string;
  processGroupEnded: true;
  leaseDigest: string;
  payloadDigest: string;
  transport: ProtectedReceiptTransportV1;
}

export interface ObservedCheckReceiptV1 {
  schemaVersion: 1;
  check: ObservedCheckV1;
  controlResultDigest: string;
  attemptReadback: AttemptHistoryReadbackV1;
}

export interface ProtectedGateInputV1 {
  lineageLease: WorkflowLineageLeaseV1;
  classification: RiskClassificationV1;
  requiredSetReceipt: RequiredSetReceiptV1;
  observed: ObservedCheckReceiptV1[];
  protectedProducerReceipt: ProtectedProducerReceiptV1;
  gateAttemptReadback: AttemptHistoryReadbackV1;
}

export function buildRequiredSetReceipt(
  manifest: ControlManifestV1,
  classification: RiskClassificationV1,
  protectedInventory: WorkflowInventoryV1,
  producerReceipt: ProtectedProducerReceiptV1,
  gateId: RequiredSetReceiptV1['gateId'],
): RequiredSetReceiptV1;
export function evaluatePolicyGateCanary(input: ProtectedGateInputV1): ControlResultV2;
```

`RequiredCheckV1` and `ObservedCheckV1` are exported from the canonical result module in this bead; `gate.ts` must use its exact-set validation rather than implement a second tuple or aggregator. No public API accepts a caller-selected required array. `buildRequiredSetReceipt()` is the sole derivation owner: it joins the protected manifest, exact classifier, protected workflow inventory/source, gate ID, expected producer/platform tuples, policy/tool identity, event/lease, and exact row digest, then authenticates the exact payload through the protected transport. The receipt binds one `producerReceiptDigest`; substitution with another producer object fails.

Refactor the canonical result/attempt owners atomically so the existing local `FileAttemptEvidenceStore` adapter and the cross-job protected adapter both produce one validated `AttemptHistoryReadbackV1`. The protected payload covers exact canonical lease, supervisor-terminal, supervisor-close, terminal-attempt, and four ordered predecessor-linked history receipts plus the control/event/policy/tool/precondition/result binding. Each `ObservedCheckReceiptV1` carries one such readback, and the gate cross-checks its tuple and evidence digest against the observed check. The gate attempt has a separate readback. Do not bypass lease, terminal, process-group, replay, append-only-history, or exact-byte validation.

- [ ] **Step 1: Write RED gate truth tables and workflow mutation tests**

Cover pass, warning-only required observation, advisory warning outside the required set, deterministic block, missing result, duplicate, similarly named substitute, wrong App, wrong workflow SHA, wrong policy, wrong candidate, caller-forged required set, schema-valid historical V1 supplied as a required observation, PR-head receipt supplied for merge group, stale receipt, cancelled, timeout, skipped, malformed, nonterminal, live child, replay, mutable-latest-file replacement, wrong terminal-byte digest, broken append-only history, valid not-applicable, and invalid skipped-as-not-applicable. Mutation tests remove each trigger, fixed job dependency, result binding, and `if: always()`. A warning cannot satisfy any required row or contribute to `PASS`; warning-only mandatory evidence makes authorization `INCONCLUSIVE`.

- [ ] **Step 2: Implement one aggregate owner**

Build the canary projection from the canonical result module's exact-set aggregator. Workflow steps provide data only; they do not construct independent messages or recompute native results. The repository-local projection is named `policy-gate-canary` and is never configured as the stable required status. Only the independently sourced protected producer may later emit `policy-gate`, after the separate hosted cutover binds its expected App and reads the setting back.

- [ ] **Step 3: Convert existing quality execution into reusable leaves without changing coverage**

Characterize the existing Linux 24/25 command order, permissions, timeouts, and outputs. Copy that sequence into `reusable-quality.yml` with maintained-or-reduced permissions, then invoke it as two separately named canary jobs: `quality-linux-node24` and `quality-linux-node25`. Leave the existing `Quality / quality` commands and status behavior intact apart from the already admitted action-pin, cache, and output-transport beads. Redirecting or deleting the old job occurs only in the later source-ownership cutover. Do not depend on a matrix job's ambiguous aggregate output. Each fixed canary job emits one tuple/attempt/evidence digest. Dual-run until exact command/result parity is proven. Preserve the documented CodeQL surface unchanged; do not infer its owner or create, alter, or retire it without the Task 3 hosted receipt.

- [ ] **Step 4: Add the top-level orchestrator**

The top-level workflow handles `pull_request`, `merge_group: checks_requested`, and default-branch push. It always creates fixed jobs for inventory, classify, workflow-policy-canary, Linux Node 24, Linux Node 25, dependency-review applicability, and `policy-gate-canary`. Portability and `portability-gate-canary` do not appear until Task 7 supplies their real evidence. Every leaf consumes `EventRevisionV1` and the exact lineage lease. Superseded pull-request runs cancel; merge-group and default-branch evidence never reuses a stale PR result. `policy-gate-canary` uses `if: always()` and a static `needs` list containing every possible leaf.

- [ ] **Step 5: Add Dependency Review as a supplemental leaf**

Pin GitHub's Dependency Review Action through the existing Task 3 lock registry. Begin report-only and evaluate only the introduced dependency delta. Keep repository lockfile/install/registry policy canonical. Do not block licenses or vulnerability thresholds until owner policy, exceptions, unsafe/safe fixtures, and baseline behavior are admitted.

- [ ] **Step 6: Bind inherited merge-group source coverage without expanding legacy authority**

Current `quality.yml` already contains `merge_group` source wiring while retaining the
candidate/private-key sequence. Treat that inherited trigger as a proven source fact and a
tainted legacy risk, not as CP-W2 completion. Do not remove it merely to recreate it in the
new unprivileged canary orchestrator, and do not let it confer protected authority. Add
structural fixtures proving the legacy trigger cannot gain new privilege, producer status,
or artifact trust. The replacement protected workflow receives authoritative merge-group
ownership only during the coordinated private-assurance-removal, source-ownership, and
hosted-binding cutover. Bind every synthetic or real canary result to `proposedMergeOid` and
the merge-group member digest. If the repository remains user-owned or current required
contexts cannot produce safe merge-group evidence, queue enablement and real merge-group
canaries remain unavailable/inconclusive; use exact source inspection and synthetic event
fixtures without calling them live queue evidence. Do not change CodeQL when its
ownership/event receipt is unavailable.

Keep `whatsoup-guard.yml` unchanged and separately visible during this bead. Inventory its overlapping Node 24/25 work, path-filtered applicability, advisory history scan, and exact status identity. It remains the old source owner until a later source-ownership packet proves command/result parity and reference scans show it no longer authorizes a boundary; this plan does not silently absorb or retire it. `tag-release-gate.yml` is not part of the PR/merge orchestration bead.

Register and test the existing planned `workflow.result.requirement.missing` code plus
`workflow.result.set.mismatch`, `workflow.result.substitute.duplicate`,
`workflow.result.skip.presented-success`, `binding.merge.oid.mismatch`, and
`test.advisory.result.used-authoritatively` in the same bead.

- [ ] **Step 7: Verify local structure and report-only canaries**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-gate.test.ts \
  tests/scripts/ci-orchestrator-workflow.test.ts \
  tests/scripts/ci-control-workflow-policy.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/ci-control-workflow-dependencies.test.ts \
  tests/scripts/ci-control-cache-trust.test.ts \
  tests/scripts/ci-diagnostic-publication.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git commit -m "ci: add exact-set merge policy canary"
```

Canary sequence: same-repository PR, synthetic fork-equivalent PR, synthetic exact
merge-group event/source fixtures, and default-branch backstop. Add a real queued
merge-group revision only after authenticated hosted readback proves a supported topology
and a separate owner authorization enables the queue. Compare exact old/new result sets and
decisions. Keep all documented status contexts unchanged while their required bindings are
unverified. This commit cannot close the
protected gate row until the independent producer emits and authenticates the required-set
and final gate receipts.

---

### Task 7: CP-P1 — Observed-Host Native Linux/macOS Portability

**Files:**

- Create: `scripts/lib/ci-control/observed-host.ts`
- Create: `scripts/ci-control-portability.ts`
- Create: `tests/scripts/ci-control-portability.test.ts`
- Create: `tests/portability/observed-host.test.ts`
- Create: `tests/portability/shell-filesystem.test.ts`
- Create: `tests/portability/process-lifecycle.test.ts`
- Create: `tests/portability/service-manager-rendering.test.ts`
- Create: `tests/portability/native-adapters.test.ts`
- Create: `tests/portability/release-deployment-state.test.ts`
- Create: `.github/workflows/reusable-portability.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/quality.yml`
- Modify: `scripts/lib/ci-control/gate.ts`
- Modify: `scripts/ci-control-gate.ts`
- Modify: `tests/scripts/ci-control-gate.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `package.json`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`

**Interfaces:**

```ts
export interface ProtectedHostObservationReceiptV1 {
  schemaVersion: 1;
  executor: ObservedExecutorIdentityV1;
  transport: ProtectedReceiptTransportV1;
  eventRevision: EventRevisionV1;
  lineageLeaseDigest: string;
  observationPayloadDigest: string;
  observedBeforeCandidateExecution: true;
}

export interface PortabilityLaneReceiptV1 {
  schemaVersion: 1;
  eventRevision: EventRevisionV1;
  lineageLeaseDigest: string;
  manifestDigest: string;
  policyDigest: string;
  classificationDigest: string;
  protectedHostObservation: ProtectedHostObservationReceiptV1;
  suiteDigest: string;
  result: ControlResultV2;
  observedCheckReceipt: ObservedCheckReceiptV1;
}

export interface PortabilityGateInputV1 extends ProtectedGateInputV1 {
  laneReceipts: PortabilityLaneReceiptV1[];
}

export function evaluatePortabilityGateCanary(input: PortabilityGateInputV1): ControlResultV2;
```

- [ ] **Step 1: Write RED observed-host and applicability tests**

Cover runner label disagreeing with `uname`/Node architecture, forged candidate capability JSON, protected observer replacement, pre/post observation drift, unsupported runtime, missing native tool, wrong executable digest, case sensitivity, symlink/mode/lock/temp behavior, process-group cancellation, terminal receipt visibility, systemd/launchd rendering, native plist validation, synthetic keyring, native dependency load, release/publication serialization, Git behavior, deployment/rollback state machines, and raw-output substitution in hermetic fixtures.

- [ ] **Step 2: Implement bounded host observation**

The independently sourced protected workflow observes the host before executing candidate code and authenticates the observation through the protected transport. The repository-local workflow may consume and validate this receipt but cannot mint it. Use direct executable arguments, allowlisted environment, bounded outputs, exact executable identity, explicit timeouts, and terminal attempt receipts. Optionally repeat a post-run observation to detect drift. Never read real credentials, modify service managers, write live keychains, or perform deployment. A label, candidate-authored JSON, or unauthenticated capability claim returns `INCONCLUSIVE`.

- [ ] **Step 3: Build the risk-selected portability suite**

Consume the protected exact classifier and required-set receipts. Documentation-only changes may emit a validated not-applicable row after always-on policy and metadata checks. Dependency, native, platform, workflow, build, release, unknown/system-wide, merge-group executable, and release-candidate changes require both supported native tuples. Register and test `precondition.host.capability.unproven`, `binding.executor.identity.unavailable`, `binding.executor.host.prohibited`, and `portability.host.requirement.missing` without creating a second native policy owner.

- [ ] **Step 4: Replace the narrow macOS clock job through dual-run parity**

Keep the existing clock tests as part of the new macOS suite. Add the six exact test files above, first as a separate canary. Do not remove the old job until the new lane proves the old cases plus the additional native contract and its removal mutation fails. The repository-local reusable workflow is a canary definition; authoritative native evidence must come from the independently sourced protected workflow.

- [ ] **Step 5: Wire stable portability aggregation**

Add fixed Linux and macOS canary leaves to `ci.yml`. Extend the existing canonical gate owner and its tests with `evaluatePortabilityGateCanary()`; it reuses the same exact-set validator and requires one full authenticated protected host observation plus one per-lane observed-check/attempt readback. Cross-check executor producer/workflow/tool/freshness/event/lease identity and the lane result-evidence digest. `portability-gate-canary` always exists with static dependencies and accepts only authenticated exact observed-host receipts or protected-classifier-backed not-applicable receipts. Missing, skipped, cancelled, stale, malformed, label-mismatched, candidate-minted, or unsupported-host evidence is inconclusive. The production name `portability-gate` remains reserved for the independently sourced protected producer and later hosted cutover.

- [ ] **Step 6: Verify locally and on real native runners**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-portability.test.ts \
  tests/scripts/ci-control-gate.test.ts \
  tests/scripts/ci-orchestrator-workflow.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/portability/observed-host.test.ts \
  tests/portability/shell-filesystem.test.ts \
  tests/portability/process-lifecycle.test.ts \
  tests/portability/service-manager-rendering.test.ts \
  tests/portability/native-adapters.test.ts \
  tests/portability/release-deployment-state.test.ts \
  tests/scripts/bot-errors-health-check.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
git diff --check
git commit -m "ci: add observed-host portability canary"
```

Local non-native simulation cannot close macOS. Completion requires exact-OID receipts from
both actual supported host tuples and PR canaries. A real merge-group canary is additionally
required only after authenticated hosted readback proves a supported queue topology and the
queue is separately authorized; until then, exact synthetic merge-group fixtures remain
visible but cannot close live queue evidence.

Do not add a `verify:portability` facade in this task until the command can validate both authenticated host receipts and produce the declared aggregate evidence. A source-only local simulator uses an explicitly canary/report-only name.

---

### Task 8: Canary Closeout and Hosted-Governance Handoff

**Files:**

- Create: `docs/ci-control-wiring.json`
- Create: the `ci-control-wiring.md` Markdown projection beside the JSON output under `docs/`
- Modify: `docs/publication-audit.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`
- Modify: `docs/superpowers/plans/2026-07-20-cicd-enforcement-control-plane-program.md`

- [ ] **Step 1: Generate the final exact wiring inventory**

Run the canonical inventory against the current candidate and tested merge OIDs. The generated report must distinguish absent, planned, report-only, advisory, canary, blocking, quarantined, and deprecated controls; it must not present planned artifact, deployment, hosted, or portability capabilities as current compliance.

Refresh the authenticated read-only hosted receipt first and compare it with the Task 3 prerequisite receipt. If required status names/App bindings, CodeQL ownership/events, merge queue, protected producer, or any prerequisite hosted observation changed, invalidate the dependent canaries and rerun only the declared dependency closure before continuing.

- [ ] **Step 2: Validate all source and result contracts**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-workflow-inventory.test.ts \
  tests/scripts/ci-inventory-workflow.test.ts \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-workflow-policy.test.ts \
  tests/scripts/ci-control-workflow-dependencies.test.ts \
  tests/scripts/ci-diagnostic-publication.test.ts \
  tests/scripts/ci-control-cache-trust.test.ts \
  tests/scripts/ci-control-protected-producer.test.ts \
  tests/scripts/ci-control-gate.test.ts \
  tests/scripts/ci-orchestrator-workflow.test.ts \
  tests/scripts/ci-control-portability.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/portability/observed-host.test.ts \
  tests/portability/shell-filesystem.test.ts \
  tests/portability/process-lifecycle.test.ts \
  tests/portability/service-manager-rendering.test.ts \
  tests/portability/native-adapters.test.ts \
  tests/portability/release-deployment-state.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/ci-control-result.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

Expected: all mandatory commands reach terminal exit zero without retries or masking. Advisory findings remain separately visible. The branch gate's own subset disclosure remains in the receipt.

- [ ] **Step 3: Run full unfiltered verification before a completion claim**

```bash
bash scripts/run-with-pinned-npm.sh run coverage:check -- --pool=forks --fileParallelism=false
```

Expected: complete suite and coverage thresholds pass. Any skipped, unsupported, unavailable, masked, or nonterminal lane is disclosed as inconclusive rather than clean.

- [ ] **Step 4: Prove topology-applicable canaries and exact remote identity**

For separately authorized pushes, verify remote branch OID equals the locally scanned OID. Preserve terminal receipts for same-repository PR, synthetic fork-equivalent input, merge-group proposed merge, default branch, Linux native, macOS native, protected evaluator, exact-set gates, and diagnostic rejection. No stale PR-head receipt may close a merge-group row.

- [ ] **Step 5: Refresh and adjudicate the read-only hosted-settings comparison**

Using a separately approved read-only App, refresh rulesets, required statuses, expected producers, CodeQL ownership/events, merge queue, review policy, bypass actors, force-push/deletion protection, action allowlist/SHA policy, secret scanning, push protection, protected tags, environments, runner groups, and artifact permissions. Unreadable fields are inconclusive. This refresh does not substitute for the Task 3 receipt that precedes Task 6 source migration; it detects drift and invalidates stale canaries.

- [ ] **Step 6: Stop before hosted mutation**

Prepare three distinct packets: (1) private-assurance transport removal, (2) source workflow leaf-ownership transfer, and (3) hosted required-status/App binding. Each shows current settings/source ownership, the proposed atomic cutover, prior-state rollback receipt, exact protected producer, real PR canaries, synthetic/source merge-group proof, any topology-applicable real merge-group canary, no-dual/no-zero-authority proof, and owner identities. Do not change required checks, action policy, environments, secrets, rulesets, merge queue, or the existing private-key path under this plan.

The packets execute under one coordinated, separately approved transition runbook: verify the protected producer and current hosted state; bind and read back the new required protected status while preserving old checks; transfer source leaf ownership; remove the private transport; retire the old required status only after a current-head readback; roll back in exact reverse order. A failure between steps restores the last verified authority and preserves every failed receipt. Separate approvals and receipts remain mandatory even though the order is coordinated.

- [ ] **Step 7: Publish metadata and commit the source reconciliation**

```bash
bash scripts/run-with-pinned-npm.sh run work-index:regen
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
git diff --check
git commit -m "docs(ci): record workflow authority canaries"
```

Classify the generated wiring reports and this internal plan in `docs/publication-audit.md` before staging. Because `docs/superpowers/**` is ignored, admit only this exact reviewed plan path with `git add -f`; never force-add the directory. Reconcile tracked, staged, unstaged, untracked, ignored, generated, intent-to-add, assume-unchanged/skip-worktree, submodule, symlink, mode, and partial-staging state against the patch manifest before commit.

## Definition of Done

This plan is complete only when:

- the generated inventory accounts for every manifest control, package facade, hook, workflow job/step, action dependency, permission, secret, timeout, concurrency rule, cache, artifact, status, producer, result, and known hosted dependency;
- the protected evaluator reads candidate Git objects as data and proves producer, protected policy, and observed executor independently;
- no new canary or protected job executes candidate code and later receives private assurance or privilege; source-canary completion retains one explicitly disclosed legacy `quality.yml` taint until the separately authorized private-assurance cutover;
- all external workflow dependencies are reviewed full-SHA pins with a tested update path;
- every public diagnostic channel crosses the canonical scan-after-generation boundary;
- all canary-required repository-owned providers prove exact proposed-merge handling through
  source and synthetic `merge_group` fixtures; when a supported queue topology is separately
  authorized, they also produce real merge-group receipts. Hosted CodeQL and any other
  existing required provider remain an explicit CP-G1 prerequisite when readback is
  unavailable;
- repository-local canary gates always exist with static dependencies, while only the independently sourced protected producer may emit the eventual stable required gates; both consume the canonical exact-set owner;
- Linux and macOS receipts prove observed host/runtime/tool/filesystem identity for the exact revision and policy;
- unsafe cases block, safe neighbors pass, unavailable evidence is inconclusive, warnings remain advisory, and self-removal mutations fail;
- old/new workflows demonstrate exact command, native-cause, decision, and binding parity before one atomic authority transfer;
- documented Linux and CodeQL status contexts remain preserved until authenticated hosted
  readback proves their current required bindings and a separately approved cutover is read
  back;
- the current candidate/private-key path remains explicitly unresolved until its separate atomic hosted cutover; source canaries never claim that risk is removed;
- no planned artifact, release, deployment, hosted, scheduled, or runtime capability is advertised as pass-capable before its own admitted implementation and external trust prerequisites exist.

## Primary References

- [GitHub secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub merge queue requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- [GitHub ruleset controls](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub hosted runner characteristics](https://docs.github.com/en/actions/using-jobs/choosing-the-runner-for-a-job)
- [GitHub status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Dependency Review](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review)
- [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
