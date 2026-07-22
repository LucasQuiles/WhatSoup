# CI/CD Control Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: The root writer uses
> superpowers:executing-plans to mutate this active worktree task-by-task. Subagents use
> read-only discovery/review unless a later packet grants a separate worktree, exact file
> scope, and writer lease. Each task requires superpowers:test-driven-development and
> superpowers:test-integrity; completion requires superpowers:verification-before-completion.

**Status:** Active

**Goal:** Add one strict control inventory, one neutral exact-evidence result contract, one exact-Git-object risk classifier, canonical fast/PR facades, and exact-ref/hook-integrity adapters without changing existing native detector decisions.

**Architecture:** New neutral modules live under `scripts/lib/ci-control/`. The manifest records orchestration metadata but imports native decisions by adapter. The classifier reads Git objects, never ambient candidate bytes. Package facades compose existing lower-level commands. Hooks become thin exact-ref adapters. Existing hard-coded safeguard inventories stay authoritative until manifest parity is proven, then ownership switches atomically.

**Tech Stack:** TypeScript, Node.js 24.15.0, Vitest 4, Git plumbing, JSON, SHA-256, Husky, repository pinned-runtime wrappers.

**Current source progress (2026-07-22):** CP-F1 is present at
`fe02ec7150b1bc1165e06d4457cd728c543b0e5b`; CP-F2 at
`1ef2e93ed4b44b279402610e62655bd5ba330ff8`; CP-F3 at
`5abc4438167a5d93fb0205e8b7083a6e77ec7691`; CP-H1a at
`e013fcd8bb1fc1933a1a7f103d9848e1d7f6c0ba`; CP-H1b/ref-policy follow-up at
`dd474cc7aed4b807a58c0cf1c22dead411709bb2` and
`e6e6c10fedb8829693d4f94b6f02cef7e4741c7e`; CP-F2e at
`1bdd8ea37c7c9f3fb600fe0f5a68901398c50ca3`; the report-only H1d-C exact-ref canary at
`5b682e90c643886603a5d11c863a69c1f8d91459`; and CP-F4a/F4b/F4c0 through the
finite-clock and canonical-decision-owner precursors at `838aced01`, `f0a23fa36`,
`24d33f302`, `3e4f6aa7b`, `518d2af78`, `58e480af6`, `5fc2d34f4`, and
`6e100ba75`. The additive change-record leaf is preserved locally at
`72f86cc145c374cbf1aefd62e482de276d08f872`, but it is quarantined and unpromoted:
independent review proved missing exact source/policy/tool/precondition/attempt bindings,
two trailer-validation bypasses, raw author-controlled output, and incomplete CLI/limit
tests. Its attempted push did not update the remote branch; the masked pipeline status is
discarded, and the remote remained `9fc8a640845d581025b6e7997c0de70b55478a1e` at the
2026-07-22 readback. CP-WA1, the P0.1 repair bead below, active H1d cutover,
CP-F4c1/c2/c3, and CP-F5 remain incomplete.
The existing branch gate is also blocked before P0.1 promotion. The preserved
`62c0523e79b906239b276900adb41217f1e40036` CP-TC1a checkpoint repairs fifteen of the
nineteen previously reproduced test-program type errors in three admitted test files, but
its compound commit command masked the direct Git/hook terminal status and CP-WA1 did not
yet exist. It is provisional evidence, not completed admission. A fresh direct
`typecheck:all` capture at those bytes leaves four `TS2345` errors in
`tests/scripts/repo-hygiene-guard.test.ts`; CP-TC1b below owns only that remaining typed
boundary repair. No later bead may use the quarantined P0.1 commit, CP-TC1a, a green
focused suite, or any test-only repair as substitute evidence for the full branch gate.
The separately reviewed workflow/portability plan is planning evidence only and cannot
begin authoritative mutation until those prerequisites close.

**Merged upstream reconciliation (2026-07-22):** merge commit
`91f550ec133bae75c7059822759b4a2973f80c3e` incorporates `origin/main`
`16c194345204c289a1541cd96399c9ad3ff365ea`. Its first-parent delta is exactly
41 paths, 4,706 insertions, and 2 deletions: 33 design-system paths plus the eight-path
guard patch. Five guard-patch paths overlap explicit plan surfaces (`.husky/pre-commit`,
`package.json`, `docs/public-surface.md`, `scripts/safeguard-diagnostics.ts`, and its
test). The guard patch added native
`guard:no-destructive-git` enforcement and wired the existing `guard:grant-resolver`,
`guard:launchd-drift`, and advisory `triage:required-suites` commands into additional
legacy surfaces. Those commands are real current-source capabilities, but they are not
yet registered in the control manifest or executable-plan inventory. The destructive-Git
guard also reads ambient filesystem bytes, uses exit `2` for both findings and failures,
prints raw exception/finding text, and accepts an inline
`# no-destructive-git:allow` bypass without the reviewed exception contract. Therefore:

- existing hook/workflow/push/release wiring remains in place as native legacy
  enforcement, and this plan does not weaken or remove it;
- none of the four commands may satisfy a common-envelope required result until exact
  source scope, native cause/outcome mapping, sanitized rendering, producer/precondition/
  terminal evidence, and truthful availability are separately proven;
- CP-F4c1a2 inventories all four commands and their closures without granting execution
  authority; `triage:required-suites` stays advisory and never satisfies mandatory work;
- CP-F5 includes manifest parity for all four commands and atomically migrates the
  destructive-Git inline bypass into the reviewed exception registry; and
- the merged workflow, hook, package, public-surface, safeguard, and test bytes invalidate
  every earlier review that depended on those inputs. Fresh exact-byte review and
  current-head integration evidence are required before the next implementation bead.

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
- Every phase binds a lineage lease containing immutable `baseOid`, current `candidateOid`,
  latest coordinator-observed `observedMainOid`, nullable `testedMergeOid`, remote topic-ref
  OID, repository/worktree/branch identity, writer session/process identity, mutation mode,
  allowed paths, expiry/heartbeat/generation, and manifest, policy, toolchain, selected-plan,
  and prerequisite-receipt digests. `baseOid` is never silently replaced when main moves.
  Any changed binding applies the dependency-aware invalidation matrix; a stale receipt
  cannot inherit or transfer a prior pass.
- Before worktree transitions, reconcile tracked, staged, unstaged, untracked, ignored, intent-to-add, generated, assume-unchanged/skip-worktree, submodule, symlink, file-type, executable-bit, and planned-patch sets. A successful stash/archive command alone is not preservation proof.
- Candidate execution, untrusted cache restore, or untrusted artifact extraction irreversibly taints the job and prevents later privilege, private assurance, signing, publication, OIDC, production network, or trusted-cache access.
- Check count and byte budgets before traversal/canonicalization. Write receipts atomically and bind their digest to the exact bytes emitted.
- Existing lower-level tests and behavior are unchanged unless the task's unsafe fixture proves a reachable defect.

## Review, Integration, and Regression Protocol

- The root controller owns the only mutation lease for the active worktree and branch.
  Luna/Tera or other worker labels are advisory routing labels, not identity proof; their
  lanes remain read-only unless a future packet grants one worker a disjoint worktree and
  exact write scope. Every worker receipt records requested role separately from observed
  runtime/tool identity, and unknown stays unknown.
- Linked worktrees share repository refs and configuration. Only the coordinator may fetch
  or update remote-tracking refs while a linked-worktree lease is active; workers and
  reviewers consume the coordinator's immutable observation receipt. An uncoordinated
  fetch is `BLOCK/1`, not a harmless refresh. A worktree lock protects against pruning or
  movement only and never substitutes for the external writer lease.
- Non-root workers and reviewers never directly fetch, commit, push, rebase, merge, switch
  branches, or update shared refs, even when a later packet grants a disjoint worktree.
  Only the coordinator/integrator may perform a specifically admitted Git mutation under
  the current writer lease and exact transition protocol.
- Freeze work on an explicit main OID, observe drift without moving that base, reconcile
  selectively, and authorize only the exact final merge result. Do not continuously rebase.
  Rebase is permitted only when the branch is unpublished, exactly one writer owns it, no
  child branch/review/receipt/artifact references its OIDs, the complete workspace state is
  accounted, and the packet explicitly accepts that all prior OID-bound evidence becomes
  stale. Otherwise preserve history and use an ordinary merge or a fresh integration branch;
  force-push is outside this source-only plan.
- Before each bead, freeze HEAD, `origin/main`, branch/ref identity, plan/manifest/policy
  digests, allowed files, and the focused RED command. A changed input invalidates the
  dependent review/test closure. Do not duplicate a quiet worker's task without terminal
  failure or an expired lease.
- Each bead proves RED, safe neighbor, unavailable-evidence inconclusive behavior,
  focused GREEN, adjacent integration, typecheck, test-integrity delta, public-output
  redaction, staged file-set equality, repository/publication guards, and independent
  source-line review before commit. Reviewers inspect exact diff bytes and source lines;
  the root adjudicates every finding against current source.
- Each review receipt binds its schema version, base/HEAD OIDs, plan and diff digests,
  exact files/source lines inspected, commands performed, read-only mode, requested role
  separately from observed reviewer tool/model identity, reviewer tool/source digest and
  self-test receipt when available, exact canonical result-byte digest, confidence, risks,
  claims requiring lead verification, findings/severity, root adjudication, unresolved
  findings, and verification rerun after corrections. The root validates the receipt
  before every bead commit. A partial, stale, malformed, unverified, or unadjudicated
  review is inconclusive.
- Before CP-WA1 is committed, record the named read-only manual Git observations in that
  packet with `GIT_OPTIONAL_LOCKS=0`, but label them provisional and inconclusive as an
  authoritative workspace receipt. Only the planning-admission commit, the test-only
  CP-TC1 bootstrap repair, and CP-WA1's first implementation commit may be intentionally
  created while that prerequisite is unavailable; each retains the manual observations,
  exact admitted file set, independent review, and explicit limitation. The already-
  preserved `72f86cc` P0.1 commit is an integrity anomaly, not a fourth exception: it used
  an unauthorized hook bypass, remains quarantined, and supplies no authorization or
  verification evidence. After CP-WA1, every commit runs `ci:workspace check` twice against the
  bead's strict patch admission: a non-authorizing `validate-unclaimed` comparison, then
  the immediately-precommit `claim` whose handle is the only eligible before evidence.
  It binds both canonical receipts and runs
  `ci:workspace transition` after commit. It accounts for tracked,
  staged, unstaged, untracked, ignored, intent-to-add, generated, assume-unchanged/
  skip-worktree, submodule, symlink, file-type, executable-bit, byte-digest, and planned-
  patch state without refreshing the index or writing Git objects. A named path omitted
  from staging/preservation or any unexpected row invalidates the bead; do not force-add
  a directory broadly.
- Immediately after commit, re-run the focused and adjacent integration commands from the
  clean committed tree, inspect the committed file set and parentage, and revalidate HEAD,
  worktree/index, hook identity, and upstream lease. A hook-bypassed, stale, partially
  verified, or unexpectedly broadened commit is preserved but not promoted.
- Every multi-command block in this plan is an ordered set of independently recorded
  commands, not one shell result. Before the bounded supervisor exists, execute a block in
  a fresh `set -euo pipefail` shell and capture each direct status; after it exists, use one
  terminal attempt per command. A trailing success, cleanup, pipeline member, or later
  command can never replace an earlier nonzero status. Expected nonzero probes use an
  explicit branch that asserts the exact status and cause.
- Angle-bracket tokens in command contracts are typed runtime bindings that the owning
  launcher must resolve and validate before execution; they are not copy-paste defaults or
  authoring placeholders. A task is incomplete if it does not name the producer and
  validation contract for each such binding.
- Run all review, test, and manual guard commands before the protected commit launcher.
  `validate-unclaimed` may compare state earlier, but every CP-WA1-and-later commit uses
  `scripts/ci-control-workspace-commit.ts`; no raw `git commit` path is admitted. Inside
  that launcher, the final `check --claim-mode claim` is the last controller action before
  trusted Git. The pre-commit hook ends with
  `ci:workspace check --claim-mode require-existing-claim`, consuming protected registry,
  writer-lease, admission, and claimed-handle descriptors inherited from the launcher. Every earlier
  hook command is an exact reviewed literal invocation with descriptors 3/4/5/6 explicitly
  closed; the launcher binds the complete commit-hook set digest from the patch admission and
  rejects any read, redirection, command, or byte substitution before the final consumer.
  The final consumer revalidates
  current HEAD, index, admission, freshness, and claim without replacing the handle. A
  missing/stale handle or hook-observed drift aborts as `INCONCLUSIVE/2`. A successful Git
  exit establishes only `commit-created-awaiting-transition`; it is not authorization or
  completion evidence. The first postcommit check and transition remain authoritative.
- The first authoritative postcommit process is a pinned `ci:workspace check` using
  `GIT_OPTIONAL_LOCKS=0`; the transition is claimed before `git status` or another command
  that may refresh the index. Human-readable Git observations run only after transition,
  with `GIT_OPTIONAL_LOCKS=0` where supported, and are never the authority.
- Foundation integration tests exercise version transitions, exact result-set equality,
  stage/classification/manifest cross-bindings, exact-ref multi-row behavior, self-removal,
  old/new parity, and the full diagnostic/redaction contract. Unit-only success cannot
  close a bead whose boundary crosses adapters or stages.
- Before a future push, the coordinator fetches through the SSH remote, classifies drift,
  and emits an observation receipt without mutating the topic branch. The integrator then
  reconciles only when required, scans every exact
  outgoing OID/ref row, revalidates each ref immediately before transport, runs the branch
  gate plus affected/full coverage required by the invalidation matrix, obtain a fresh
  independent whole-range review, then verify the pushed remote OID equals the scanned
  local OID.
- Remote publication/readback is owned by one future exact-object command:

  ```text
  ci:remote-readback --remote origin --ref refs/heads/<name> \
    --expected-oid <40-hex> --json
  ```

  It invokes `git ls-remote --exit-code --refs` through the trusted Git owner, requires
  exactly one canonical row, and binds repository/remote/ref identity plus the expected
  lowercase full OID. An absent ref, SSH/transport failure, duplicate/malformed output,
  or concurrent movement is `INCONCLUSIVE/2`; a proven different OID is `BLOCK/1`. A
  successful push without this terminal readback is never publication evidence.
- Before a future merge, the coordinator fetches again, the integrator constructs and tests
  the exact proposed merge OID, and
  requires current exact-OID terminal checks and the merge-result integration closure.
  Existing required checks stay in place through both boundaries.
- Every merge packet in this plan selects exactly one supported method: fast-forward or
  locally constructed merge. A fast-forward binds the candidate OID; a local merge binds,
  tests, and transports the exact locally created commit OID. Hosted/server-generated
  merge commits are unavailable in this plan because no independently authenticated final
  commit OID exists before `ci:remote-readback`; no hosted merge may be attempted or called
  exact. Any fetch/reconciliation change to HEAD, upstream, merge tree/OID, plan, manifest,
  policy, or prerequisite receipt restarts the invalidated review and verification closure
  before staging or claim.
- A future separately admitted hosted-merge packet must first produce a terminal
  `HostedMergeMutationReceiptV1` that independently binds repository, base/candidate OIDs,
  exact tested tree OID, merge method, final server commit OID, authenticated response
  bytes, producer/tool identity, and attempt digest. Only then may
  `ci:remote-readback --expected-oid <receipt.finalCommitOid>` plus exact fetched-object
  validation prove remote OID, tree, and method-specific parents. Missing, malformed,
  fabricated, partial, timed-out, or response/readback-mismatched evidence is not a hosted
  merge. This future packet requires separate owner authorization.
- After a future merge, read back the default-branch OID, prove the reviewed implementation
  is its ancestor, wait for current exact-OID terminal checks, run the default-branch
  integration/classifier backstop, and record regressions as new unsafe fixtures. The
  backstop binds the pre-merge default-branch OID from the frozen merge receipt as `base`,
  the read-back `origin/main` OID as `candidate`, and consumes a future
  `ExactControlManifestEvidenceV1` produced by
  `readExactControlManifestAtCommit(cwd, baseOid)`. The input is a full lowercase commit
  OID, never a ref, tree, blob, abbreviation, or caller-selected path. That API replaces
  the classifier's private `candidateManifest()` reader and composes the existing bounded
  `readExactTreeEntries()` and `readExactBlobs()` owners rather than introducing another
  Git reader. It reads the fixed `controls/ci-control-manifest.json` path from the exact
  commit, validates it through the dual-version parser, and binds source OID, tree OID,
  fixed path, required `100644` mode, blob OID, raw blob byte length and SHA-256, manifest
  schema version and semantic manifest digest, and a canonical evidence digest.
  Before any merge operation is admitted, a separately reviewed CLI adapter
  `ci:manifest-object --oid <40-hex> --json` must wrap that pure object evidence in a
  terminal attempt receipt binding trusted-lease repository identity, tool digest, unique
  attempt ID, terminal process proof, and exact serialized-byte digest, then emit it
  atomically. Missing, malformed, nonterminal, wrong-object, or wrong-digest evidence is
  `INCONCLUSIVE/2`.
  The existing classifier input keeps its semantic `manifestDigest`; the aggregate
  separately validates both object-evidence and terminal-attempt digests, proves
  `evidence.revisionOid === baseOid`, and requires the classifier's independently reread
  semantic digest to equal the evidence's semantic manifest digest. No receipt digest is
  substituted into the classifier V1 field. This plan names the required future interface but
  does not expose or claim that capability today. Rollback
  uses an ordinary reviewed revert and preserves failed evidence. Before deleting any
  superseded branch, use `git range-diff` and `git cherry -v` to prove no unique work is
  lost. This plan does not itself authorize push, merge, branch deletion, or hosted-state
  mutation.
- A failed postmerge backstop stops promotion and preserves its receipts. Under a new
  explicit owner authorization, rollback is an ordinary exact revert of the complete landed
  range—never history rewriting. The merge receipt freezes the pre-merge base, landed tip,
  exact introduced commit set, parent order, and integration method. A one-commit
  fast-forward binds that commit; a multi-commit fast-forward packet selects and validates
  the landed DAG plus an exact reverse-topological revert sequence. For every introduced
  internal merge commit, the packet freezes one retained-history parent edge and requires
  `-m <validated-parent-number>` to resolve exactly to that direct parent OID; an absent,
  ambiguous, arbitrary, or non-retained parent edge is rejected. The top-level integration
  merge separately binds its direct mainline parent to the frozen premerge default-branch
  OID. The complete constructed revert chain must restore the frozen pre-merge tree except
  for separately admitted concurrent state. Each rollback
  commit binds its exact tree, parents, message bytes, author/committer policy, signing mode,
  and tool/config evidence. The rollback packet constructs and tests the complete proposed
  revert chain before transport, then follows the same integration, exact-ref,
  terminal-check, push, and `ci:remote-readback` protocol. The rollback is not successful
  until the read-back default-branch OID equals the scanned revert OID and current checks
  are terminal; unavailable or partial recovery remains `INCONCLUSIVE`.

```ts
export interface ExactControlManifestEvidenceV1 {
  schemaVersion: 1;
  revisionOid: string;
  treeOid: string;
  path: 'controls/ci-control-manifest.json';
  mode: '100644';
  blobOid: string;
  blobByteLength: number;
  blobContentDigest: `sha256:${string}`;
  manifestSchemaVersion: 1 | 2;
  manifestDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
}

export function readExactControlManifestAtCommit(
  cwd: string,
  revisionOid: string,
): { manifest: AnyControlManifest; evidence: ExactControlManifestEvidenceV1 };
```

---

### Task 1: CP-F1 — Canonical control manifest, strict schema, and inventory

**Patch admission packet**

- Evidence: **Proven** at reconciled local base `f30052f11a86cc3ece3026ff8e8798ec207831ea`; relevant source paths are code-identical to the previously reviewed `c26cc8b2091d6b39abd0350b535c8ed551d9ab93`, `d7a443cbd329bd2d71bfe7df704f103179f59c57`, `9fc8a640845d581025b6e7997c0de70b55478a1e`, and `f43b877ffab07bd3b75f1be645c4552f3a127b18` revisions.
- Owner/location: new neutral orchestration owner; existing hard-coded inventory begins at `scripts/safeguard-diagnostics.ts:72` and fitness-only registry at `scripts/lib/fitness/registry.ts:1`.
- Reachable failure: an existing guard can be absent from orchestration, multiply registered, dependency-cyclic, unreachable, or missing remediation without one exact ownership graph rejecting it.
- Unsafe fixture: two blocking records claim different decision owners for the same
  `(policyCategory, surface)` or one required control is unreachable.
- Safe neighbor: two controls observe the same `(policyCategory, surface)` under the same
  canonical decision owner, or observe different policy categories/surfaces.
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
bash scripts/run-with-pinned-npm.sh run ci:manifest -- validate --json
bash scripts/run-with-pinned-npm.sh run ci:manifest -- inventory --json
```

Both commands use pinned Node. Validation exits `0` only for a complete valid manifest and `2` for untrusted/unparseable/schema-invalid input.

- [ ] **Step 6: Verify GREEN and surrounding regressions**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/fitness-registry.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
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

export interface ProtectedRequirementSetExecutionEvidenceV1 {
  schemaVersion: 1;
  candidateOid: string;
  mergeOid: string | null;
  manifestDigest: string;
  classifierDigest: string;
  executionPlanDigest: string;
  producerDigest: string;
  expectedChecks: readonly unknown[];
  receiptBytesUtf8: string;
  receiptBytesDigest: string;
  terminalAttempt: TerminalAttemptV1;
  terminalAttemptDigest: string;
  evidenceDigest: string;
}

export interface AuthoritativeAggregationContextV1
  extends Omit<AuthoritativeAggregationOptions, 'expectedChecks'> {
  requirementSetEvidence: ProtectedRequirementSetExecutionEvidenceV1;
  requirementSetAttemptStore: FileAttemptEvidenceStore;
  expectedRequirementSetLease: SupervisorLeaseExpectationsV1;
}

export function validateControlResult(value: unknown): ControlResultV1;
export function validatePreconditionReceipt(value: unknown): PreconditionReceiptV1;
export function validateTerminalAttempt(value: unknown): TerminalAttemptV1;
export function canonicalizeControlResult(value: ControlResultV1): Uint8Array;
export function serializeControlResult(value: ControlResultV1): string;
export function hashControlResult(value: ControlResultV1): string;
export function renderControlResult(value: ControlResultV1): string;
export function aggregateOutcomes(
  value: readonly ControlResultV1[],
  context: AuthoritativeAggregationContextV1,
): AggregateDecision;
export function exitCodeForOutcome(value: ControlOutcome): ControlExitCode;
```

- [ ] **Step 1: Write RED outcome, diagnostic, precondition, terminal-attempt, exact-key, freshness, native-adapter, byte-budget, and leak tests**

Include all five outcomes; aggregate conversion; required missing; missing/swapped/replayed/
candidate-derived protected requirement-set evidence; unsupported runtime; incomplete
install scope; invalid fixture; cancelled/timed-out/corrupt attempts; process exit without
terminal receipt; receipt before child-group termination; stale/malformed/wrong OID/policy/producer; valid not-applicable; multibyte-at-limit; one-byte-over; absolute-path input; and low-entropy matched-value cases.

Each warn/block/inconclusive output must contain the complete diagnostic contract from Global Constraints and identify source correction, precondition correction, evidence recovery, infrastructure retry, approval, or escalation. Assert human and machine renderings are projections of one object and contain neither the synthetic matched literal nor its raw SHA-256. Reject `CI failed`, missing owners/remediation/bindings, unknown codes, and alternate free-form catalogs.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-result.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Implement outcome, taxonomy, diagnostic, and aggregation contracts**

Use stable versioned domain codes from the design taxonomy. Codes are never repurposed. Reject outcome/exit mismatches, warnings used as required evidence, skipped jobs represented as not-applicable, subset-only aggregation, duplicate or substitute observations, and unregistered codes.

Current source accepts a bare `AuthoritativeAggregationOptions.expectedChecks`; that API
and its locally mirrored PASS fixtures are a proven follow-up defect and must be repaired
in this bead before any downstream aggregate is authoritative. The validator instead
reopens `ProtectedRequirementSetExecutionEvidenceV1` from its independent attempt store,
derives the expected set from current protected manifest, classifier, and execution-plan
evidence, and binds their exact revision, policy, producer, lease, and attempt digests. It
never copies a result's caller-controlled `requiredChecks`, accepts a caller-created mirror
array, or infers expectations from the observed result set.

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
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
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
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
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
bash scripts/run-with-pinned-npm.sh run ci:classify -- --event <closed-event> --candidate <40-hex> [--base <40-hex>] [--merge <40-hex>] --json
```

No `--risk` or caller-selected check list exists.

- [ ] **Step 7: Verify GREEN and triage non-regression**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/required-suites.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
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
the per-ref exact-set cutover only after the three additive beads pass together and a
committed CP-GL1 supplies coordinator-owned remote observation. CP-GL1 therefore precedes
H1d transport, remote review, workflow canaries, and active cutover; pre-CP-GL1 local
report-only observations cannot satisfy that dependency. The
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

H1d additionally requires current CP-GL1 remote-ref-set, writer, lineage, reviewer, workspace-accounting,
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
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
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

### Task 4.4: CP-TC1 — Restore full test-program typecheck before new authority

CP-TC1 is a bootstrap repair and a prerequisite for CP-WA1. It changes no production
implementation, control outcome, workflow, hook, manifest, package facade, or hosted
setting. It exists because the current branch gate cannot be used as admission evidence
while `typecheck:all` fails in the test program. The partial test-only commit
`62c0523e79b906239b276900adb41217f1e40036` repaired fifteen diagnostics in three
files. Preserve it as provisional CP-TC1a evidence, not completion: its controller's
compound commit command ended in `tail`, CP-WA1 accounting did not exist, and the full
gate remained red. CP-TC1b closes the four currently reproducible errors below.

**Patch admission packet**

- Evidence: **Proven** at HEAD `62c0523e79b906239b276900adb41217f1e40036`.
  A fresh direct capture of `typecheck:all` exits `2` and reports exactly four
  `TS2345` diagnostics in `tests/scripts/repo-hygiene-guard.test.ts`; captured stdout
  SHA-256 is `7036fc574d0bd8ac911088643e5bb49b5af7c9b770c362e85c339de68f93b793`
  and stderr is empty. The historical controlled with/without-P0.1 replay established the
  earlier nineteen-error baseline, but those bytes are now stale after CP-TC1a.
- Reachable failure: `verify:push:branch` reaches `typecheck:all` and blocks every later
  source bead and push. A blind cast could make the compiler green while allowing a
  generic decoded payload to supply missing or wrong binding fields.
- Unsafe fixture: each of four generic decoded payloads reaches `expectedForArtifact()`
  without runtime proof of string `toolDigest` and `policyDigest`.
- Safe neighbor: the unmodified exact-range receipt fixtures validate both required
  bindings and the complete repo-hygiene suite preserves its current assertions/count.
- Expected: current `typecheck:all` is the RED baseline; corrected test typing plus the
  repo-hygiene suite, script typecheck, and test-integrity gate pass. Any cast that hides
  an unproven branch, any removed assertion, or any changed production file is `BLOCK/1`.
- Smallest repair: repair only `tests/scripts/repo-hygiene-guard.test.ts`. Preserve the
  three CP-TC1a files, all production bytes,
  fixture behavior, test counts, assertions, and reason/decision expectations.
- Controls unchanged: classifier admission, execution-plan selection, publication
  redaction/artifact binding, repository-hygiene binding, P0.1 quarantine, hooks,
  workflows, manifest, and every native detector remain unchanged.
- Rollback: ordinary revert of CP-TC1b and, only if separately justified, CP-TC1a. If
  rollback restores a failing branch gate, later beads remain blocked rather than
  inheriting prior evidence.

**Files:**

- Modify: `tests/scripts/repo-hygiene-guard.test.ts`

- [ ] **Step 1: Freeze and reproduce the RED compiler families**

Capture `typecheck:all` stdout, stderr, and direct status without a pipeline. Assert that
the diagnostic set is exactly four `TS2345` rows in the one admitted file.
If the file set or diagnostic families differ, stop and refresh this packet rather than
silencing new errors.

```bash
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: exit `2` with exactly the current test-program error family. This is baseline
evidence, not a passing result.

- [ ] **Step 2: Apply the one smallest type-safe test repair**

Add one test helper that accepts `unknown`, proves the value is a non-null object, proves
`toolDigest` and `policyDigest` are strings in the expected SHA-256 wire shape, and
returns only those validated fields. Route the four failing generic payload call sites
through that helper before `expectedForArtifact()`. Keep
`expectedForArtifact()`'s exact typed parameter; do not add `any`, a blind cast,
`@ts-ignore`, `@ts-expect-error`, or a production change.

The machine-global secret-scanner currently blocks every normal Edit/Write of this test
file because it contains eight deliberate synthetic secret-detection fixtures. Do not use
a Bash/heredoc or another actor to route around that denial. CP-TC1b remains blocked until
the owner either applies this exact reviewed change or approves a narrow test-fixture
editing rule that is itself separately tested and does not weaken committed/public output
scanning.

- [ ] **Step 3: Prove focused runtime behavior and test integrity**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/repo-hygiene-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
git diff --check
```

Expected: every command exits zero with no retry, focus marker, skip, assertion removal,
or masked status. Compare test names/counts and decisive assertions with the frozen base.

- [ ] **Step 4: Prove the full compiler and branch-gate closure**

```bash
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run verify:push:branch
```

Expected: both commands exit zero. A branch-gate failure outside the one-file patch is
reported as a separate current blocker; it is not repaired by expanding CP-TC1.

- [ ] **Step 5: Independent review and provisional pre-WA1 commit**

Require one Luna semantic review and one Tera test-integrity review over the exact staged
diff. They verify that the runtime narrowing preserves the original binding falsifiers,
test count, assertions, and failure cause. Stage exactly the one named test file and run
the staged repository, publication, commit-message, and hook-identity guards.

Because CP-WA1 does not yet exist, record the global provisional manual workspace sets
before and immediately after staging with `GIT_OPTIONAL_LOCKS=0`, capture each direct
status, and commit through the current hooks with:

```bash
git commit -m "test(ci): restore control-plane typecheck"
```

The first postcommit actions inspect exact parentage and the committed one-path set,
repeat Steps 3 and 4 from clean committed bytes, re-run the three CP-TC1a suites
unfiltered as adjacent integration, and re-read HEAD, upstream, and remote OIDs. CP-TC1a
and CP-TC1b remain bootstrap results with provisional workspace accounting; neither can
authorize later mutations until CP-WA1 independently validates the worktree.

---

### Task 4.5: CP-WA1 — Exact workspace accounting, writer lease, and protected commit transition

CP-WA1 is a prerequisite for CP-H1d, CP-F4c1a1, and every later mutation bead. The manual
workspace commands in the global protocol remain useful operator observations until this
bead is committed, but they are not authoritative receipts: `git status` can refresh the
index, line-oriented output is unsafe for hostile paths, and the existing boundary
snapshot calls `git write-tree`. Do not reuse that mutating snapshot implementation.

**Patch admission packet**

- Evidence: **Proven**. Repository hygiene owns staged policy and publication owns a
  docs-only ignored-file check; neither reconciles all tracked, staged, unstaged,
  untracked, ignored, intent-to-add, generated, assume-unchanged/skip-worktree, submodule,
  symlink, file-type, executable-bit, and planned-patch sets. The ignored-plan incident
  proved a successful stash or clean status is insufficient preservation evidence.
- Reachable failure: a planned ignored path is omitted, a partially staged byte or mode
  change escapes review, a skip-worktree/assume-unchanged path hides drift, or a concurrent
  mutation changes HEAD/index/worktree between observation and commit.
- Unsafe fixture: an ignored named path is absent from the staged set, or a one-byte
  staged/unstaged mutation occurs between the two observation passes.
- Safe neighbor: hostile NUL-delimited path names and a declared generated output are
  represented once with exact type/mode/digest and the two observation passes are equal.
- Expected: exact match `PASS/0`; deterministic named planned-path omission `BLOCK/1`;
  missing, racy, malformed, unaccounted, over-budget, or non-read-only evidence
  `INCONCLUSIVE/2`.
- Smallest repair: one read-only workspace-accounting owner and thin CLI. Existing repo,
  publication, boundary-run, and Git-object policies remain unchanged.
- Rollback: remove the additive command/control through an ordinary revert. Do not
  substitute the mutating boundary snapshot or weaken later file-set gates.

**Files:**

- Create: `scripts/lib/ci-control/workspace-accounting.ts`
- Create: `scripts/lib/ci-control/trusted-git.ts`
- Create: `scripts/lib/ci-control/supervised-command.ts`
- Create: `scripts/ci-control-workspace.ts`
- Create: `scripts/ci-control-workspace-commit.ts`
- Create: `tests/scripts/ci-control-workspace.test.ts`
- Create: `tests/scripts/ci-control-supervised-command.test.ts`
- Create: `tests/scripts/ci-control-workspace-commit.test.ts`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `scripts/hooks-installed-guard.ts`
- Modify: `tests/scripts/hooks-installed-guard.test.ts`
- Modify: `scripts/lib/verification/boundary-run/process.ts`
- Modify: `tests/scripts/verify-boundary-run.test.ts`
- Modify: `scripts/lib/ci-control/attempt.ts`
- Modify: `tests/scripts/ci-control-attempt.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `package.json`
- Modify: `docs/public-surface.md`
- Modify: `.husky/pre-commit`

Before RED edits, run a read-only reference scan for command registration and companion
test requirements. If another production path is required, stop, add its exact path/hash
to this packet, and obtain fresh admission.

The twenty-path packet spans three independently reviewed internal subreceipts:
`CP-WA1a` for trusted Git plus the shared supervisor/attempt store, `CP-WA1b` for pure
read-only workspace accounting and registry/transition validation, and `CP-WA1c` for the
commit launcher plus hook activation. Each subreceipt has its own RED/GREEN diff digest,
review finding set, and rollback analysis. They land atomically because no intermediate
state may advertise workspace authority, change the hook, or become a second process/Git
owner; failure in any subreceipt rejects the entire activation commit. This is a deliberate
trust-boundary cutover, not permission to broaden the packet beyond the twenty named paths.

**Interfaces:**

```ts
export interface WorkspacePatchAdmissionV1 {
  schemaVersion: 1;
  repositoryId: string;
  worktreeId: string;
  baseHeadOid: string;
  baseIndexDigest: string;
  expectedStagedPaths: string[];
  expectedStagedPatchDigest: string;
  expectedUnstagedPaths: string[];
  expectedUnstagedPatchDigest: string;
  allowedUntrackedPaths: string[];
  allowedIgnoredPaths: string[];
  allowedIntentToAddPaths: string[];
  expectedNonIndexEntries: Array<{
    set: 'untracked' | 'ignored' | 'generated';
    admissionIndex: number;
    fileType: 'regular' | 'symlink' | 'directory';
    mode: number;
    size: number;
    contentOrSymlinkTargetDigest: string;
  }>;
  expectedAssumeUnchangedPaths: string[];
  expectedSkipWorktreePaths: string[];
  expectedSubmodules: Array<{ path: string; oid: string; state: 'clean' }>;
  expectedCommitMessageBytesDigest: string;
  expectedAuthorIdentityDigest: string;
  expectedCommitterIdentityDigest: string;
  expectedCommitConfigDigest: string;
  signingPolicy: 'unsigned' | 'required';
  expectedCommitHooks: Array<{
    name: 'pre-commit' | 'prepare-commit-msg' | 'commit-msg' | 'post-commit';
    state: 'absent' | 'present';
    bytesDigest: string | null;
  }>;
  writerLeaseDigest: string;
}

export interface WorkspaceWriterLeaseV1 {
  schemaVersion: 1;
  leaseId: string;
  generation: number;
  taskId: string;
  mode: 'write';
  writer: {
    sessionId: string;
    pid: number;
    parentPid: number;
    processGroupId: number;
    processStartTime: string;
    cwdDigest: string;
    toolDigest: string;
  };
  repositoryId: string;
  worktreeId: string;
  branch: string;
  baseOid: string;
  candidateOid: string;
  observedMainOid: string;
  testedMergeOid: string | null;
  remoteTopicRef: string;
  remoteTopicOid: string | null;
  manifestDigest: string;
  policyDigest: string;
  toolchainDigest: string;
  planDigest: string;
  prerequisiteReceiptDigests: string[];
  allowedPaths: string[];
  createdAt: string;
  heartbeatAt: string;
  expiresAt: string;
  leaseDigest: string;
}

export interface WorkspaceSetReceiptV1 {
  schemaVersion: 1;
  attemptId: string;
  lifecycle: 'terminal';
  createdAt: string;
  terminalAt: string;
  validUntil: string;
  decision: 'pass' | 'block' | 'inconclusive';
  exitCode: 0 | 1 | 2;
  repositoryId: string;
  worktreeId: string;
  headOid: string;
  indexDigest: string;
  stagedPatchDigest: string;
  unstagedPatchDigest: string;
  observedSetDigest: string;
  admissionDigest: string;
  writerLeaseDigest: string;
  setDigests: {
    trackedIndex: string;
    staged: string;
    unstaged: string;
    untracked: string;
    ignored: string;
    intentToAdd: string;
    generated: string;
    assumeUnchanged: string;
    skipWorktree: string;
    submodules: string;
    typesAndModes: string;
  };
  producer: {
    pinnedNodeWrapperDigest: string;
    entrypointDigest: string;
    nodeRealPath: string;
    nodeVersion: string;
    nodeDigest: string;
    gitLauncherDigest: string;
    gitImplementationDigest: string;
    gitVersion: string;
  };
  twoPassStable: boolean;
  readOnlyProof: {
    gitOptionalLocks: '0';
    indexDigestBefore: string;
    indexDigestAfter: string;
    objectCountBefore: number;
    objectCountAfter: number;
    refsDigestBefore: string;
    refsDigestAfter: string;
  };
  evidenceDigest: string;
}

export interface WorkspaceExecutionEvidenceV1 {
  schemaVersion: 1;
  receipt: WorkspaceSetReceiptV1;
  receiptBytesUtf8: string;
  receiptBytesDigest: string;
  persistedStdoutDigest: string;
  terminalAttempt: TerminalAttemptV1;
  terminalAttemptDigest: string;
}

export interface WorkspaceRegistryExpectationV1 {
  schemaVersion: 1;
  realPathDigest: string;
  device: string;
  inode: string;
  ownerUid: number;
  mode: '0700';
  expectationDigest: string;
}

export interface WorkspaceEvidenceHandleV1 {
  schemaVersion: 1;
  id: string;
  attemptId: string;
  evidenceRoot: {
    realPathDigest: string;
    device: string;
    inode: string;
    ownerUid: number;
    mode: '0700';
  };
  attemptStore: {
    relativeName: string;
    rootDigest: string;
    realPathDigest: string;
    device: string;
    inode: string;
    ownerUid: number;
    mode: '0700';
  };
  expectedLease: SupervisorLeaseExpectationsV1;
  capturedStdoutDigest: string;
  admissionDigest: string;
  writerLeaseDigest: string;
  commandDigest: string;
  cwdDigest: string;
  environmentDigest: string;
  producerDigest: string;
  toolDigest: string;
  createdAt: string;
  validUntil: string;
  handleDigest: string;
}

export interface WorkspaceEvidenceHandleReferenceV1 {
  schemaVersion: 1;
  id: string;
  registryExpectationDigest: string;
  referenceDigest: string;
}

export interface WorkspaceHandleClaimV1 {
  schemaVersion: 1;
  handleId: string;
  attemptDigest: string;
  purpose: 'precommit-before';
  claimedAt: string;
  claimDigest: string;
}

export interface WorkspaceTransitionSelectionV1 {
  schemaVersion: 1;
  id: string;
  beforeHandleId: string;
  afterHandleId: string;
  beforeAttemptDigest: string;
  afterAttemptDigest: string;
  admissionDigest: string;
  writerLeaseDigest: string;
  commitOid: string;
  launcherEvidenceHandleId: string;
  launcherReceiptDigest: string;
  launcherAttemptDigest: string;
  transitionAttemptId: string;
  createdAt: string;
  selectionDigest: string;
}

export function verifyWorkspaceCommitTransition(
  admission: WorkspacePatchAdmissionV1,
  before: WorkspaceExecutionEvidenceV1,
  after: WorkspaceExecutionEvidenceV1,
  commitOid: string,
  context: WorkspaceTransitionValidationContextV1,
): ControlResultV1;

export interface WorkspaceCommitTransitionInputV1 {
  schemaVersion: 1;
  admission: WorkspacePatchAdmissionV1;
  before: WorkspaceExecutionEvidenceV1;
  after: WorkspaceExecutionEvidenceV1;
  commitOid: string;
}

export function validateWorkspaceExecutionEvidence(
  value: unknown,
  admission: WorkspacePatchAdmissionV1,
  context: {
    attemptStore: FileAttemptEvidenceStore;
    workspaceRegistry: FileWorkspaceEvidenceRegistry;
    workspaceHandleId: string;
    expectedLease: SupervisorLeaseExpectationsV1;
    commandDigest: string;
    cwdDigest: string;
    environmentDigest: string;
    producerDigest: string;
    toolDigest: string;
    now: number;
    claimMode: 'validate-unclaimed' | 'claim' | 'require-existing-claim';
  },
): WorkspaceExecutionEvidenceV1;

export interface WorkspaceTransitionValidationContextV1 {
  registry: FileWorkspaceEvidenceRegistry;
  expectedRegistry: WorkspaceRegistryExpectationV1;
  beforeHandleId: string;
  afterHandleId: string;
  launcherEvidenceHandleId: string;
  transitionAttemptId: string;
  now: number;
}

export interface WorkspaceCommitLauncherReceiptV1 {
  schemaVersion: 1;
  operation: 'commit-created-awaiting-transition';
  priorHeadOid: string;
  commitOid: string;
  admissionDigest: string;
  writerLeaseDigest: string;
  claimedHandleReferenceDigest: string;
  gitAttemptDigest: string;
  commitObjectBytesDigest: string;
  treeOid: string;
  parentOids: string[];
  messageBytesDigest: string;
  authorIdentityDigest: string;
  committerIdentityDigest: string;
  authorTimestamp: string;
  committerTimestamp: string;
  signingState: 'unsigned' | 'verified';
  commitConfigDigest: string;
  hookSetDigest: string;
  evidenceDigest: string;
}

export interface WorkspaceCommitLauncherExecutionEvidenceV1 {
  schemaVersion: 1;
  receipt: WorkspaceCommitLauncherReceiptV1;
  receiptBytesUtf8: string;
  receiptBytesDigest: string;
  persistedStdoutDigest: string;
  terminalAttempt: TerminalAttemptV1;
  terminalAttemptDigest: string;
  writerLeaseDigest: string;
  evidenceDigest: string;
}

export interface WorkspaceCommitLauncherEvidenceHandleV1 {
  schemaVersion: 1;
  id: string;
  attemptStoreRelativeName: string;
  expectedLease: SupervisorLeaseExpectationsV1;
  capturedStdoutDigest: string;
  admissionDigest: string;
  writerLeaseDigest: string;
  commitOid: string;
  receiptDigest: string;
  handleDigest: string;
}
```

### Git lineage, drift, and integration contract

The normal command surface is deliberately small and does not expose automatic rebase:
`repo-agent start`, `status`, `checkpoint`, `sync --classify`, `handoff`, `integrate`, and
`close`. These are planned CP-GL1 interfaces, not current pass-capable commands. CP-WA1
supplies the atomic local writer lease plus workspace, process, and terminal-evidence
primitives; a separate admitted CP-GL1 bead must add coordinator-owned fetch, immutable
remote observation and drift receipts, integration-branch construction, and detached
exact-OID reviewer checkouts before any `repo-agent` command is advertised. A shared stash
is never the primary worker handoff.

The program ordering is exact: `CP-WA1 + CP-F3 -> CP-GL1 -> CP-H1d -> remote review and
workflow canaries`. CP-GL1 is source-only until a later transport packet is authorized; it
must be added to the program dependency graph and ledger during Task 7 Step 8 before H1d
can claim readiness.

Every receipt declares its sensitivity as one or more of `candidate-only`,
`base-sensitive`, `merge-sensitive`, `policy-sensitive`, `toolchain-sensitive`,
`platform-sensitive`, and `artifact-sensitive`. Coordinator-observed drift is classified
without changing the frozen task base:

| Drift class | Required action | Minimum invalidated evidence |
|---|---|---|
| `NONE` | continue | none |
| `DISJOINT_METADATA` | continue, then reclassify | classification, metadata/index, merge result, aggregate |
| `DISJOINT_CODE` | normally continue | merge result and cross-component integration |
| `AFFECTED_COMPONENT` | pause before final verification and reconcile | affected build/test/integration and merge result |
| `SHARED_RUNTIME` | reconcile | every dependent component receipt |
| `DEPENDENCY` | reconcile and reinstall | install, build, security, portability, integration |
| `POLICY_OR_WORKFLOW` | immediate integrity stop | every policy-dependent receipt |
| `GENERATED_INPUT` | reconcile and regenerate | generated output, documentation, packaging |
| `CONFLICT` | integrator-only resolution | every merge-sensitive receipt |
| `UNKNOWN` | select broad coverage but remain inconclusive | final authorization |

The Git rider's uppercase labels are input aliases only; the active registry keeps the
existing lowercase four-part convention and emits exactly one canonical code:

| Rider label | Canonical code | Outcome |
|---|---|---|
| `GIT.LEASE.WRITER_CONFLICT` | `git.lease.writer.conflict` | `BLOCK` |
| `GIT.LEASE.EXPIRED_UNRECONCILED` | `git.lease.expiry.unreconciled` | `INCONCLUSIVE` |
| `GIT.HEAD.UNEXPECTED_CHANGE` | `git.lineage.head.changed` | `INCONCLUSIVE` |
| `GIT.BRANCH.REMOTE_ADVANCED` | `git.lineage.topic.remote-advanced` | `INCONCLUSIVE` |
| `GIT.BASE.DRIFT_DISJOINT` | `git.lineage.base.drift-disjoint` | `WARN` |
| `GIT.BASE.DRIFT_RELEVANT` | `git.lineage.base.drift-relevant` | `INCONCLUSIVE` |
| `GIT.BASE.DRIFT_POLICY` | `git.lineage.base.drift-policy` | `INCONCLUSIVE` |
| `GIT.REBASE.SHARED_HISTORY_PROHIBITED` | `git.rebase.shared-history.prohibited` | `BLOCK` |
| `GIT.REBASE.EVIDENCE_INVALIDATED` | `git.rebase.evidence.invalidated` | `INCONCLUSIVE` |
| `GIT.MERGE.RESULT_STALE` | `git.merge.result.stale` | `INCONCLUSIVE` |
| `GIT.MERGE.CONFLICT` | `git.merge.result.conflict` | `BLOCK` |
| `GIT.FETCH.UNCOORDINATED` | `git.fetch.coordination.prohibited` | `BLOCK` |
| `GIT.WORKTREE.WRONG_BRANCH` | `git.worktree.branch.mismatch` | `BLOCK` |
| `GIT.WORKTREE.UNACCOUNTED_STATE` | `git.worktree.state.unaccounted` | `INCONCLUSIVE` |
| `GIT.WORKTREE.IGNORED_PATH_OMITTED` | `git.worktree.ignored-path.omitted` | `BLOCK` |
| `GIT.HOOK.IDENTITY_UNPROVEN` | `git.hook.identity.unproven` | `INCONCLUSIVE` |
| `GIT.PUSH.OID_CHANGED_AFTER_SCAN` | `git.push.oid.changed-after-scan` | `BLOCK` |
| `GIT.PUSH.FORCE_UNAUTHORIZED` | `git.push.force.unauthorized` | `BLOCK` |
| `GIT.REMOTE.READBACK_MISMATCH` | `git.remote.readback.mismatch` | `BLOCK` |

The prevention and validation lifecycle is fixed:

| Boundary | Mandatory current evidence |
|---|---|
| before mutation | exclusive writer lease, exact branch/worktree/base/candidate and complete workspace accounting |
| before review dispatch | frozen OID, plan/diff/policy/tool digests and read-only detached reviewer scope |
| before commit | focused and integration tests, guards, exact staged-set admission, hook/config/message/identity bindings |
| immediately after commit | raw commit-object readback, clean after-state, transition receipt, focused/integration replay |
| before push | coordinator drift receipt, exact outgoing-ref scan, branch gate, affected/full closure, whole-range review |
| after push | SSH remote exact-OID readback and current remote check receipt |
| before merge | exact proposed-merge OID/tree/parents, candidate plus integration lanes, merge-group/current gate evidence |
| after merge | default-branch readback, ancestry, classifier/integration backstop, regression-to-fixture feedback |
| rollback | exact landed range, deterministic revert chain, same pre-push/pre-merge/post-merge protocol |

Candidate checks bind the exact topic OID and cover candidate-local format, lint, static,
focused unit, change-record, and candidate-security facts. Integration checks bind only the
exact proposed merge OID and cover compilation against observed main, cross-component and
contract tests, generated-index closure, packaging, portability, and the aggregate policy
gate. Candidate receipts are reused only when their declared sensitivity permits it;
merge-sensitive evidence is always regenerated for the final proposed merge. A merge queue
and `merge_group` execution are the future authoritative freshness boundary. They do not
authorize a hosted merge or ruleset change in this plan.

Lease takeover never follows age alone. It requires an expired heartbeat, independently
observed PID/parent/process-group/start-time/session/CWD/worktree identity, a frozen branch
and complete workspace receipt, an append-only abandoned-lease record, a new generation and
attempt ID, and revalidation of HEAD/index/worktree/remote lineage. An unexpected commit is
preserved as evidence and quarantined; it is never silently reset, absorbed, or promoted.

```ts
export interface CoordinatorRemoteObservationV1 {
  schemaVersion: 1;
  repositoryId: string;
  remoteName: 'origin';
  remoteUrlDigest: string;
  expectedRefs: Array<{
    role: 'main' | 'topic';
    ref: string;
    expectedState: 'present' | 'absent-or-present';
  }>;
  expectedRefsDigest: string;
  observedRefs: Array<{
    role: 'main' | 'topic';
    ref: string;
    state: 'present' | 'absent';
    oid: string | null;
  }>;
  observedRefsDigest: string;
  observationCloneId: string;
  producerDigest: string;
  toolDigest: string;
  fetchAttemptDigest: string;
  terminalAttemptDigest: string;
  observedAt: string;
  validUntil: string;
  evidenceDigest: string;
}
```

The producer runs in the coordinator-owned observation clone, uses the approved SSH
remote, and receives the expected main plus leased `remoteTopicRef` set from protected
coordinator policy rather than candidate input. An unpublished topic is an explicit
`state:'absent', oid:null` observation. The validator requires exact expected/observed role
and ref-set equality, binds both set digests to the direct fetch and terminal attempts,
proves the direct fetch status and ended process group, and emits append-only exact bytes.
This interface is a future CP-GL1 prerequisite for authoritative drift reuse,
integration, push, or merge. Until it exists, the root coordinator may supervise an exact
read-only `git ls-remote --exit-code --refs` observation without changing shared refs; that
manual receipt is provisional and can stop a local source-closeout commit on drift, but it
cannot authorize transport, merge, selective evidence reuse, or a current-main claim.

`ci:workspace check --input - --format json` accepts one strict bounded admission object
on stdin plus a closed trusted-argv claim mode and protected registry/handle descriptors.
Its private child emits one canonical sanitized receipt into the supervisor's bounded
capture; the public parent emits the validated `WorkspaceExecutionEvidenceV1`.
Defaults for every allowed set are empty. It uses direct executable/argument arrays, bounded buffers,
`GIT_OPTIONAL_LOCKS=0`, the repository's cleaned Git environment, and two identical probe
passes before terminal output. Extract the proven Git launcher/implementation resolver
and exact environment from `hooks-installed-guard.ts` into the one shared
`trusted-git.ts` owner; both callers consume it. The receipt binds that Git identity plus
the exact pinned-Node wrapper, observed Node, and CLI entrypoint identities. A substituted
PATH Git, launcher, implementation, wrapper, Node, or entrypoint is inconclusive. The
command never writes a receipt into the repository.

The child receipt's `evidenceDigest` covers its canonical body under the repository's
existing digest convention. It does not claim the impossible property of containing a
hash of bytes that include that same hash. CP-WA1 extracts the reusable process-group,
direct-status, bounded-capture, and close-proof mechanics from the boundary-run watchdog
into `supervised-command.ts`; boundary-run and workspace accounting then share that one
process owner. `ci-control-workspace.ts check` is the supervising parent command. It feeds
canonical admission bytes to a private child-evaluation mode by direct argv, enforces the
declared timeout/output budgets, captures exact stdout/stderr through process close, owns
and reaps the isolated process group, persists the existing append-only attempt chain in
the confined unique attempt directory, persists the exact captured stdout as a bounded
no-follow regular-file record in `FileAttemptEvidenceStore`, and constructs
`WorkspaceExecutionEvidenceV1`. `receiptBytesUtf8` carries the exact bounded child bytes;
the validator parses those bytes, requires their unique canonical projection to equal the
included receipt, recomputes `receiptBytesDigest`, and rereads equal exact bytes through
`persistedStdoutDigest` from the trusted store. Its validated `TerminalAttemptV1`
proves direct status, timeout state, and process-group termination. A standalone child
receipt, progress output, or receipt without this join is inconclusive.

`validateWorkspaceExecutionEvidence()` exact-key validates both objects and requires:
matching attempt IDs; `receiptBytesDigest` equal to captured child stdout bytes;
`terminalAttempt.evidenceBinding.resultEvidenceDigest` equal to the child receipt's
evidence digest; exact command/CWD/environment, admission, producer, tool, repository,
worktree, HEAD, freshness, direct status, and terminal-process bindings; and the complete
persisted attempt history reopened from the caller-supplied `FileAttemptEvidenceStore`
under the caller-supplied `SupervisorLeaseExpectationsV1`. The store root identity is
trusted precondition input, never read from the envelope. `claimMode:'validate-unclaimed'`
performs the complete validation, rejects already claimed evidence, writes no claim, and
is never independently authorization evidence. The preliminary precommit comparison uses
that mode. All three workspace claim modes are mediated by the caller-supplied
`FileWorkspaceEvidenceRegistry`; `FileAttemptEvidenceStore.claim()` remains unchanged for
existing non-workspace consumers and can never satisfy a workspace handle. Only the
second, immediately-precommit `check --claim-mode claim` writes an immutable
`WorkspaceHandleClaimV1` under the registry's single claim lock and consumes the selected
final before handle for workspace authorization. Transition performs its initial pure
validation without authority, then asks the registry to reacquire that same lock,
re-resolve both handles/stores/leases, require the before registry claim, require the after
to have no workspace or generic attempt claim, and repeat the exact freshness/binding/
terminal checks while the lock remains held. It then asks the registry to
write one immutable transition-selection record whose canonical body binds before/after
handle IDs and attempt digests, admission, commit OID, and transition attempt. Under one
registry-local exclusive lock, `claimTransition()` validates the append-only transition
ledger, rejects any prior record containing either handle or attempt, writes that one
owner-only record atomically, fsyncs it and the directory, and rereads its digest before
PASS. This single record consumes both handles for transition purposes and prevents a
preliminary/unclaimed handle, selected-before reuse, repeated transition, or after reuse
with another before/commit. If the record is durable but terminal result publication
fails, the attempt is `INCONCLUSIVE`, the commit is preserved but not promoted, and
manual recovery must inspect the exact record; it is never deleted, rolled back, or
silently replayed. Extend the attempt store only with bounded no-follow captured-output
and generic claim-readback methods; retain the existing claim API for current callers.
Workspace code never calls that generic claim method. Replay, wrong-root, wrong-lease,
missing/changed output, unclaimed before, generically claimed after, reused before/after,
wrong transition binding, or claim-mode mismatch is inconclusive. A mismatch is never
repaired by the child or treated as pass.

The same anchored registry owns one atomic `WorkspaceWriterLeaseV1` per
`(repositoryId, worktreeId)` and per `(repositoryId, branch)`. The strict CLI exposes
`writer-lease acquire`, `status`, `heartbeat`, `release`, and `takeover`, each using
protected canonical input/output descriptors and terminal attempts. Acquire holds one
exclusive registry lock and fails on either conflicting key. Every workspace check,
protected commit launcher, and transition consumes the exact lease through a protected
descriptor, re-observes PID/parent/process-group/start-time/CWD plus Git identities, and
requires its digest in the admission and result. Release writes append-only close evidence;
it never deletes the lease history. Takeover requires an expired heartbeat plus
independently observed dead or non-owning process identity, frozen branch/workspace
evidence, an immutable abandoned-lease record, incremented generation, and a new attempt
ID. Age, role labels, terminal names, or command strings alone never authorize takeover.
Source controls cannot prevent an arbitrary process outside the protected launcher from
editing; such drift is detected and stops admission. Strong write isolation requires a
separately permissioned clone or OS profile and remains outside this bead.

`require-existing-claim` accepts the retained opaque handle reference, canonical admission,
writer lease, and registry expectation only through inherited protected descriptors. It creates no new
handle or claim. The final line of `.husky/pre-commit` invokes this mode after every other
hook guard and requires the claimed handle to remain fresh and equal to the hook-observed
HEAD/index/admission. Direct invocation without those protected descriptors is
`INCONCLUSIVE/2`, never a silent skip; non-commit diagnostics use an explicit
non-authorizing mode and cannot satisfy commit admission.

Because check and postcommit transition are separate processes, the supervising check
also writes one `WorkspaceEvidenceHandleV1` through a protected descriptor into an
operator-chosen evidence root. `FileWorkspaceEvidenceRegistry` opens that root without
following links, requires an owner-only `0700` directory, freezes its real path/device/
inode/owner identity, allocates each attempt-store directory beneath that anchored root,
and creates immutable owner-only handle files atomically. The handle records the store's
opaque validated single-component relative name plus its root/real-path/device/inode/
owner/mode identity and binds the opaque attempt ID, full lease expectations, persisted
stdout, admission, command/CWD/environment, producer/tool, freshness, and its own
canonical digest. The later process locates the attempt store only by opening that private
relative name beneath the already validated registry descriptor and revalidating every
recorded identity; a digest alone is never treated as a locator. Before the first check,
the root controller opens the registry once, freezes `WorkspaceRegistryExpectationV1`,
and retains those canonical expectation bytes outside the registry. Each later process
receives the same expectation through `--registry-expectation-fd` on a protected control
descriptor, reopens the pathname only as a locator, and requires the reopened root to
equal the independently retained real-path/device/inode/owner/mode expectation before
handle lookup and again after all reads. Neither the expectation, handle, nor locator is
emitted in public stdout or accepted inside caller-authored admission/envelope JSON. The
opaque handle reference is returned only through its separate protected output descriptor.
Missing, swapped, forged, symlinked, stale, world/group-writable, wrong-owner, same-path
replacement, escaping/multicomponent, or device/inode-changed registry/store evidence is
inconclusive.

`scripts/ci-control-workspace-commit.ts` is the sole CP-WA1-and-later commit launcher. It
accepts bounded canonical registry-expectation, writer-lease, and admission bytes through protected input
descriptors, a separate protected before-handle output descriptor, plus a packet-approved
literal commit message whose exact UTF-8 digest equals the admission. It uses the existing trusted-
Git, supervised-command, registry, attempt, and reason owners; it does not add another Git
resolver, process supervisor, claim store, or result taxonomy. Inside the launcher, the
final `check --claim-mode claim` runs after every external review and guard. The launcher
captures the opaque claimed handle through a private pipe, creates fresh one-shot pipes
containing the retained canonical expectation, writer lease, admission, and handle bytes,
maps only those read ends to fixed child descriptors `3`, `4`, `5`, and `6`, closes every unrelated pipe
end, reconstructs the allowlisted Git environment, and directly invokes the exact trusted
Git executable with the packet-approved message and closed signing policy—never a shell
command string. Before invocation it binds the effective commit-relevant Git configuration,
approved author/committer identities, and exact absent/present bytes for `pre-commit`,
`prepare-commit-msg`, `commit-msg`, and `post-commit`. The final
`.husky/pre-commit` command consumes descriptors `3`, `4`, `5`, and `6` once through
`require-existing-claim`. Every preceding hook command explicitly closes those four
descriptors before spawning its child, and the launcher rejects a hook whose exact
admitted bytes do not preserve that closed-descriptor structure. Descriptor numbers from environment variables, argv-carried
evidence bytes, filesystem evidence paths, and public output cannot substitute.

Missing, extra, swapped, replayed, prematurely consumed, seek-drifted, or non-pipe
descriptors; one-byte admission/index drift; Git/launcher substitution; pipe or child
failure; hook bypass/nonzero; claimed-handle mismatch; or evidence leakage is
`INCONCLUSIVE/2` unless a deterministic admitted mismatch is `BLOCK/1`. A hook/config/
identity/signing change after claim is rejected. A rejected hook
must leave no commit. After a successful Git exit, the launcher writes exactly one
`WorkspaceEvidenceHandleReferenceV1` to the protected before-handle output descriptor
and closes it; it never writes the reference to stdout, stderr, argv, or the public
receipt. Output failure leaves a preserved, unpromoted commit with
`INCONCLUSIVE/2` and no transition claim. A successful Git exit plus successful private
handle delivery produces only a
`commit-created-awaiting-transition` operation receipt. After Git closes, the launcher
rereads the raw commit object through the trusted Git owner and binds exact object bytes,
tree, ordered parents, message bytes, author/committer identities and timestamps, signing
state, effective commit configuration, and complete hook-set digest. A hook-altered message,
unexpected identity/signature, wrong parent/tree, or raw-object mismatch preserves the
commit but returns `INCONCLUSIVE/2`; it never becomes transition-eligible. The receipt is not a
`ControlResultV1`, does not claim authorization, and cannot replace the first postcommit
check and transition.

For every bead, the root constructs `WorkspacePatchAdmissionV1` only from the frozen
packet, lineage receipt, exact staged/unstaged patches, and typed non-index observations,
then canonicalizes it with `serializeWorkspacePatchAdmission()`. Before the first check,
the root creates the operator-confined `0700` root outside the repository and runs the
pinned read-only registry initializer once:

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts registry-init \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-output-fd <protected-expectation-output-fd> \
  --format json
```

`registry-init` does not create, repair, chmod, or replace the root. It validates the
already opened directory before and after inspection, emits only a sanitized supervised
result on stdout, and writes the exact canonical `WorkspaceRegistryExpectationV1` only to
the protected output descriptor. The root retains those bytes and supplies an equivalent
protected input descriptor to every later check and transition; rerunning initialization
does not replace a live expectation. The canonical admission bytes and digest are part of
the review receipt. The preliminary comparison receives them on stdin; the protected
launcher receives the same retained canonical bytes on its admission descriptor:

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message <packet-approved-literal> --format json
```

The root first runs `ci-control-workspace.ts check --claim-mode validate-unclaimed`,
captures its terminal comparison receipt, then invokes the displayed launcher. The
launcher performs `--claim-mode claim` internally with identical admission bytes
immediately before trusted Git. Receipt bodies must be equal apart from attempt/time
fields. Only the launcher-created, claimed immediately-precommit handle is
eligible as transition `before` evidence, and the root receives its reference only from
the launcher's protected before-handle output descriptor after Git succeeds. The
preliminary handle is unclaimed and must be
rejected. In the same protected launcher operation, the registry persists the exact
`WorkspaceCommitLauncherExecutionEvidenceV1` bytes and terminal attempt, creates an opaque
`WorkspaceCommitLauncherEvidenceHandleV1`, and links that handle to the claimed before
handle and commit OID. The handle is never accepted from stdin or public argv/output; the
transition context resolves it independently through the retained registry expectation.
The transition-selection ledger then prevents reuse of the selected before
handle after one transition. A caller-authored alternate admission or unreviewed path
allowance is not accepted.

`ci:workspace transition --input - --format json` consumes the strict canonical
`WorkspaceCommitTransitionInputV1` on stdin plus trusted direct argv:

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <opaque-before-id> --after-handle <opaque-after-id> \
  --input - --format json
```

It resolves `WorkspaceTransitionValidationContextV1`, including the linked launcher
evidence handle, only from the protected registry expectation and that prevalidated
registry, never from the serialized envelopes. It reopens the launcher's persisted exact
stdout and append-only terminal attempt under the stored lease, verifies the receipt-byte
digest and attempt binding, and rejects missing, forged, substituted, nonterminal, or
caller-authored launcher evidence. It proves
`after.headOid === commitOid`, the resolved launcher receipt and freshly reread raw commit object
match every admitted message/identity/config/signing/hook binding, the commit's sole parent
equals `before.headOid`, committed paths/modes/blob identities equal
the supplied admission's expected staged paths and patch/index bindings, both before/after
envelopes pass `validateWorkspaceExecutionEvidence()`, the after staged/unstaged sets are
empty, and all non-transition per-set digests are unchanged. The transition's trusted
registry resolves separate before/after attempt stores and lease expectations from the
opaque handle IDs and revalidates the anchored root before and after both reads; store,
handle, root, or lease substitution is rejected. Only after those pure checks pass does
it call the registry's `claimTransition()` with the canonical before/after/admission/
commit/transition-attempt body. While holding the registry's shared workspace-claim lock,
that method re-resolves both handles, rechecks the before registry claim and after
unclaimed state, repeats binding/freshness/terminal validation, and only then writes the
selection record; any concurrent claim or record that already names either handle or
attempt is replay and no PASS is emitted. It returns `PASS/0`, deterministic
mismatch `BLOCK/1`, or unavailable/malformed/racy evidence `INCONCLUSIVE/2`.
The transition subcommand uses the same shared supervisor and its result is authoritative
only when joined to a fresh terminal attempt that binds the exact transition input/output
bytes and ended process group.

The NUL-safe probe set is exact:

```text
git status --porcelain=v2 -z --branch --show-stash --untracked-files=all
  --ignored=matching --no-renames --ignore-submodules=none
git ls-files --cached --stage -z --full-name
git ls-files -v -z --full-name
git diff --raw -z --no-abbrev --no-renames --no-ext-diff --ignore-submodules=none
git diff --cached --raw -z --no-abbrev --no-renames --no-ext-diff --ignore-submodules=none
git diff --binary --full-index --no-renames --no-ext-diff --ignore-submodules=none
git diff --cached --binary --full-index --no-renames --no-ext-diff --ignore-submodules=none
git ls-files --others --exclude-standard -z --full-name
git ls-files --others --ignored --exclude-standard -z --full-name
```

The receipt also binds exact HEAD, refs, stash, config inputs needed by Git, index bytes,
typed non-following lstat/mode/size/content-or-symlink-target digests for every declared
untracked, ignored, and generated entry, and Git object count. It parses porcelain-v2
intent-to-add, lowercase `ls-files -v` assume-unchanged rows, `S`/`s` skip-worktree rows,
mode `160000`, and file type/executable changes. Gitlink paths come from the NUL-safe index
stream; initialized submodules and nested validated gitlinks are inspected with direct
`git -C <validated-path>` argv and NUL-safe porcelain-v2 output rather than line-oriented
`git submodule status`. Public output reports opaque finding IDs and per-set counts/
digests, not ignored path names or file contents.

- [ ] **Step 1: Write RED accounting, read-only, and race tests**

Cover partial staging, intent-to-add, ignored planned file, untracked file, assume-
unchanged only, skip-worktree only, both flags, initialized/uninitialized/dirty submodule,
symlink/type/executable-mode change, newline/tab path, missing generated output, and
one-byte staged/unstaged mutation with unchanged status class. Add one-byte allowed-
untracked and allowed-ignored mutations, malicious PATH Git, substituted Git
implementation/wrapper/Node/entrypoint, concurrent HEAD/index/worktree drift, and exact-
limit/one-over fixtures. Add child crash, timeout, cancellation, output truncation,
surviving descendant, missing close proof, attempt replay, wrong stdout digest, wrong
attempt/result/command/CWD/environment/producer/tool binding, forged-but-self-consistent
attempt, wrong attempt-store root, missing/altered persisted stdout, wrong lease
expectations, before/after store substitution, reconstructed envelope, claim-mode
mismatch, and stale envelope cases. Exercise the real cross-process boundary with a first
`check` process producing a trusted before handle, a commit fixture, a second `check`
process producing a trusted after handle, and a separate `transition` process resolving
both through the same anchored registry. Add missing, swapped, forged, and stale handles;
wrong/symlinked registry root or handle; escaping/multicomponent store locator; registry
or store device/inode replacement; same-path replacement by a new owner-controlled `0700`
root containing forged self-consistent handles; wrong owner/mode; missing, wrong, changed,
or publicly supplied registry-expectation descriptor; missing or wrong protected handle-
output descriptor; expectation, handle, or locator emitted on public stdout; handle ID
accepted from untrusted JSON; and attempt-store/lease mismatch after handle resolution.
Add registry-init cases for missing/non-directory/symlink/wrong-mode roots, replacement
during inspection, protected-output failure, public expectation leakage, and an attempted
second initialization that must not replace the retained live expectation.
Add writer-lease cases for competing worktree and branch writers, wrong branch/worktree,
PID reuse with a different start time, live process with an expired heartbeat, dead process
with unexpired heartbeat, missing/forged heartbeat, stale generation, wrong allowed path,
HEAD/candidate/observed-main/plan/policy/toolchain/prerequisite drift, release without
ownership, and takeover without an immutable abandoned-lease record. Prove two concurrent
acquires cannot both pass, age or a role label cannot authorize takeover, release preserves
history, and every check/launcher/transition rejects a missing or changed protected lease.
Cover precommit `claim` success, postcommit `validate-unclaimed` followed by transition
success, preliminary/unclaimed handle rejection, final/claimed handle selection, swapped
before handles, generically claimed-after rejection, repeated transition, reuse of one
after attempt with a different before handle/admission/commit OID, and reuse of one
selected before handle with a fresh after attempt or another same-parent/same-tree commit.
Add forged launcher-receipt, random launcher-attempt, substituted persisted bytes, missing
launcher evidence, wrong launcher lease/store, and valid exact persisted launcher-evidence
fixtures. No transition may consume launcher receipt bytes supplied in its input envelope.
Inject failure before transition-record creation and after its durable write. Prove no
partial path emits PASS, the durable record is never deleted or reused, and recovery is
manual/inconclusive rather than rollback or unchanged-input retry.
Add a real competing-process fixture that pauses transition after its initial pure
validation, attempts a registry-mediated claim of the after handle from another process,
then resumes. Exactly one registry-lock participant may win; if the competing claim wins,
transition must return `INCONCLUSIVE`, write no transition-selection record, and emit no
PASS. Direct generic attempt-store claims for a workspace handle must be structurally
rejected as authority and must never satisfy the before requirement.
Assert index bytes/mtime, refs, config, stash, and Git object count do not change. First
probe the installed Git's porcelain-v2
intent-to-add representation; if it differs from the parser assumption, correct the
fixture/parser rather than weakening the assertion.
Add pre-commit-hook fixtures for missing protected descriptors, wrong/stale/replayed
claimed handle, one-byte index drift after claim, and a valid unchanged claim. Prove the
hook runs `require-existing-claim` last and cannot create or replace a claim.
Add real launcher-to-Git-to-hook boundary fixtures for an unchanged admitted commit;
absent/swapped/replayed/early-consumed descriptors; malicious descriptor-number
environment values; one-byte admission/index drift; handle/admission leakage; hook
nonzero; trusted-Git substitution; missing/closed/swapped before-handle output FD; output
write failure after Git success; and one-byte hook mutation. Mutate every earlier hook
guard in turn to read or inherit descriptors 3/4/5/6 and require launcher/hook-structure
rejection; the unchanged hook proves those descriptors are closed for all earlier child
  processes and consumed only by the final workspace check. Prove hook rejection creates no
  commit, output failure preserves but cannot promote the unexpected commit, the retained
  before-handle reference is delivered only after Git success, and Git success remains
  `commit-created-awaiting-transition` until the separate postcommit check and transition
  consume the exact handles. Mutate `prepare-commit-msg` and `commit-msg` after claim;
  substitute author or committer identity, commit timestamps outside the admitted attempt
  window, signing state, commit-relevant configuration, and each absent/present commit hook;
  and alter the message by one byte. Require final raw commit-object reread to reject every
  mismatch. Exercise `post-commit` worktree/ref mutation and prove transition detects the
  changed after-state. No launcher test may infer success from Git's status alone.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-workspace.test.ts \
  tests/scripts/ci-control-supervised-command.test.ts \
  tests/scripts/ci-control-workspace-commit.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Implement the bounded read-only owner and CLI**

Validate counts/bytes and exact keys before traversal; preserve primary direct status;
reject partial/nonterminal output; canonicalize sets and semantic sequences correctly;
and return registered, actionable, redacted causes. The command neither stages nor
unstages, refreshes the index, creates Git objects, changes refs/config/stash, follows
untrusted symlinks, nor repairs the workspace.

First extract the smallest reusable supervisor kernel from
`scripts/lib/verification/boundary-run/process.ts` into
`scripts/lib/ci-control/supervised-command.ts`, preserving every boundary-run process,
timeout, teardown, and closeout test before workspace integration. The shared kernel owns
direct argv, reconstructed environment, timeout, byte limits, process group/session,
termination, exact captured bytes, direct status, and close proof only; native boundary
policy and workspace policy remain in their respective owners. Then implement the
supervising `check` command and strict evidence validator described above.
Extend `FileAttemptEvidenceStore` only with the captured-stdout and claim-readback
primitives required by that validator. Retain the existing `claim()` contract for current
callers and preserve confinement, no-follow, unique-inode, append-only, attempt-reuse,
history, and root-identity invariants.
Implement `FileWorkspaceEvidenceRegistry` in the admitted workspace-accounting or
supervisor owner; do not add another file without reopening admission. It owns the
anchored `0700` evidence root, allocates opaque single-component attempt-store names,
revalidates root and store identities before and after every operation, writes immutable
owner-only no-follow handle files atomically, resolves transition contexts only from
registry handles, persists and resolves launcher execution evidence linked to the claimed
before handle and exact commit OID, and owns the locked append-only transition-selection ledger plus
all workspace-handle claim state through `claimBefore()` and `claimTransition()`. Neither
method delegates authorization to `FileAttemptEvidenceStore.claim()`. It accepts the
independently retained `WorkspaceRegistryExpectationV1`
only through the protected registry-control FD and compares it before lookup and after
reads. The check command emits the opaque handle reference only through the separate
caller-provided protected handle FD. Public stdout contains only the canonical result
envelope; caller JSON cannot select an expectation, handle, locator, store, lease, or
registry identity.
Implement the `registry-init` subcommand in the same CLI. It validates but never creates
or repairs the caller-created root, writes the canonical expectation only through its
protected output FD, and publishes a sanitized terminal result through the shared
supervisor. Initialization has no mode that accepts expected identity from stdin or
public JSON, and a later initializer result cannot silently supersede the controller's
retained expectation.
Update `.husky/pre-commit` only to append the protected `require-existing-claim`
revalidation after its existing guards. Preserve every current command and order; the
hook neither creates a claim nor repairs missing evidence.
Implement `ci-control-workspace-commit.ts` as the sole protected launcher described above.
It reuses the committed workspace check child mode, registry, supervised-command, attempt,
and trusted-Git owners, retains bounded evidence bytes in memory only long enough to
create one-shot pipes, closes every unrelated descriptor, and emits no public handle,
admission, registry, or commit-message evidence.

- [ ] **Step 4: Verify GREEN, surrounding behavior, and true read-only operation**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-workspace.test.ts \
  tests/scripts/ci-control-supervised-command.test.ts \
  tests/scripts/ci-control-workspace-commit.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/repo-hygiene-guard.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/public-surface-drift-check.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
git diff --check
```

- [ ] **Step 5: Independent review, staged admission, and commit**

Require the global review receipt. Capture the provisional manual workspace observations,
stage exactly the twenty named CP-WA1 files, repeat the manual observations with
`GIT_OPTIONAL_LOCKS=0`, and prove no index/object/ref/config/stash mutation occurred. Run
the staged implementation's pinned `check` command first with `validate-unclaimed`, then
run the protected commit launcher, whose internal final action is `claim`, against the
exact same admission. Compare
their canonical receipt bodies apart from attempt/time fields and retain only the claimed
second `WorkspaceEvidenceHandleReferenceV1` as the before handle for Step 6. This self-
hosting canary is provisional and does not replace the manual observations for CP-WA1's
first implementation commit. Then run:

```bash
git diff --cached --name-status
git diff --cached --check
git diff --name-status
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:staged
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "feat(ci): account for exact workspace state" --format json
```

- [ ] **Step 6: Reverify the clean committed bead**

From the clean committed HEAD, make a new pinned `check` process the first postcommit
process and create the after handle with `--claim-mode validate-unclaimed`; claim the
transition before any human-readable Git command. Then run the Step 4 suite, required
test-integrity, repository branch-diff/commit-author/hook guards. Use the same trusted root and
protected registry expectation, the retained provisional before handle from Step 5, and
the new after handle in a separate pinned `transition` process. This proves the
real `check process -> commit process -> check process -> transition process` boundary;
do not recreate the before handle after commit. Capture the fresh postcommit receipt; the
precommit receipt remains historical transition input and is not reusable as a current-
workspace pass. In the typed integration assertion call
`verifyWorkspaceCommitTransition(admission, before, after, HEAD,
registry.resolveTransitionContext(registryExpectation, beforeHandleId, afterHandleId,
transitionAttemptId, now))` and require
the resolved context to contain the launcher-evidence handle linked to the retained before
handle and `HEAD`; require `HEAD === resolvedLauncherReceipt.commitOid`, `HEAD^` to equal
the precommit head, committed paths/modes to equal the expected staged
set, after staged/unstaged sets to be empty, and every non-transition per-set digest to be
unchanged. Verify the committed file set and revalidate `origin/main`. Drift is
inconclusive.

---

### Task 4.6: CR-P0.1 — Quarantine repair for the exact change-record leaf

The local commit `72f86cc145c374cbf1aefd62e482de276d08f872` is preserved evidence,
not an admitted result. Do not push, wire, or describe its change-record control as usable
until this bead closes every finding below from exact committed bytes. The earlier stash
is recovery evidence only and must not be replayed over the committed copy.

**Patch admission packet**

- Evidence: **Proven** by independent source review and direct falsifiers. The current CLI
  reads an ambient message/schema/record, emits no source/policy/tool/precondition/attempt
  bindings, accepts a bugfix record without `Regression-For`, accepts body fields as Git
  trailers, and repeats synthetic author-controlled values in public JSON.
- Reachable failure: a later hook or workflow could pass a record for bytes other than the
  named commit, or publish a private/hostile trailer value while claiming PASS.
- Unsafe fixtures: exact bugfix commit without `Regression-For`; body `Change-Record`
  followed by non-trailer text; one-byte schema/record substitution; raw synthetic private
  trailer value; oversized message/record set; wrong source or attempt binding.
- Safe neighbor: exact feature, bugfix, chore, docs, and refactor commits whose final Git trailer blocks, candidate
  trees, schema/record blobs, policy/tool/precondition receipts, and terminal attempts all
  match.
- Expected: exact valid committed source `PASS/0`; deterministic record/trailer policy
  violation `BLOCK/1`; missing, ambient, oversized, malformed, stale, wrong-binding,
  nonterminal, or unavailable evidence `INCONCLUSIVE/2`.
- Smallest repair: one exact-object change-record owner and thin supervised CLI. No hook,
  workflow, required status, package facade, hosted setting, or second taxonomy is added.
- Rollback: ordinary revert of this repair keeps `72f86cc` and its failed review evidence
  reachable; the leaf remains quarantined and unadvertised.

**Files:**

- Create: `scripts/lib/ci-control/change-record.ts`
- Modify: `scripts/ci-change-record.ts`
- Modify: `tests/scripts/ci-change-record.test.ts`
- Modify: `controls/schema/change-record.schema.json`
- Modify: `scripts/lib/ci-control/reasons.ts`
- Modify: `tests/scripts/ci-control-reasons.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `tests/scripts/ci-control-manifest.test.ts`
- Move: `changes/CR-bad-enum.yaml` to `tests/fixtures/ci-change-record/CR-bad-enum.yaml`
- Move: `changes/CR-malformed.yaml` to `tests/fixtures/ci-change-record/CR-malformed.yaml`
- Move: `changes/CR-record-mismatch.yaml` to `tests/fixtures/ci-change-record/CR-record-mismatch.yaml`
- Move: `changes/CR-valid-bugfix.yaml` to `tests/fixtures/ci-change-record/CR-valid-bugfix.yaml`
- Move: `changes/CR-valid-feature.yaml` to `tests/fixtures/ci-change-record/CR-valid-feature.yaml`

The fixture records never remain in the production `changes/` registry. Tests construct
temporary Git repositories, commit the chosen fixture under the exact production path,
and evaluate the resulting commit object. This admission contains thirteen logical
operations: eight single-path create/modify operations and five moves. Under the required
`--no-renames` accounting, those moves expand to five deleted sources plus five added
destinations, so staged equality is against exactly eighteen path identities. Before RED,
freeze hashes for all thirteen logical operations and all eighteen expanded identities and
revalidate that no concurrent session owns this worktree.

**Interfaces:**

```ts
export type ChangeRecordIntent =
  | 'feature'
  | 'bugfix'
  | 'chore'
  | 'docs'
  | 'refactor';

export type ChangeRecordPolicyObjectPathV1 =
  | 'controls/ci-control-manifest.json'
  | 'controls/schema/change-record.schema.json'
  | 'scripts/ci-change-record.ts'
  | 'scripts/lib/ci-control/change-record.ts'
  | 'scripts/lib/ci-control/reasons.ts'
  | 'scripts/lib/ci-control/result.ts'
  | 'scripts/lib/ci-control/preconditions.ts'
  | 'scripts/lib/ci-control/git-input.ts'
  | 'scripts/lib/ci-control/trusted-git.ts'
  | 'scripts/lib/ci-control/supervised-command.ts'
  | 'scripts/lib/ci-control/attempt.ts';

export interface ChangeRecordPolicyReceiptV1 {
  schemaVersion: 1;
  policyRevisionOid: string;
  policyTreeOid: string;
  policyDigest: string;
  manifestDigest: string;
  reasonCatalogDigest: string;
  toolDigest: string;
  objects: Array<{
    path: ChangeRecordPolicyObjectPathV1;
    mode: '100644';
    blobOid: string;
    byteLength: number;
    bytesDigest: string;
  }>;
  producerDigest: string;
  evidenceDigest: string;
}

export interface ChangeRecordPolicyExecutionEvidenceV1 {
  schemaVersion: 1;
  receipt: ChangeRecordPolicyReceiptV1;
  receiptBytesDigest: string;
  terminalAttempt: TerminalAttemptV1;
  terminalAttemptDigest: string;
  evidenceDigest: string;
}

export interface ChangeRecordPolicyValidationContextV1 {
  policyRevisionOid: string;
  policyTreeOid: string;
  policyDigest: string;
  manifestDigest: string;
  reasonCatalogDigest: string;
  toolDigest: string;
  producerDigest: string;
  expectedObjectSetDigest: string;
  attemptStore: FileAttemptEvidenceStore;
  expectedLease: SupervisorLeaseExpectationsV1;
  now: number;
}

export interface ExactChangeRecordInputV1 {
  schemaVersion: 1;
  candidateOid: string;
  policyEvidence: ChangeRecordPolicyExecutionEvidenceV1;
  preconditionReceiptDigest: string;
}

export interface ExactChangeRecordObservationV1 {
  schemaVersion: 1;
  controlId: 'source.change-record';
  outcome: ControlOutcome;
  exitCode: ControlExitCode;
  code: string;
  candidateOid: string;
  candidateTreeOid: string;
  commitObjectBytesDigest: string;
  messageBytesDigest: string;
  schemaPath: 'controls/schema/change-record.schema.json';
  schemaMode: '100644';
  schemaBlobOid: string;
  schemaBytesDigest: string;
  recordPath: string | null;
  recordMode: '100644' | null;
  recordBlobOid: string | null;
  recordBytesDigest: string | null;
  policyRevisionOid: string;
  policyDigest: string;
  manifestDigest: string;
  reasonCatalogDigest: string;
  toolDigest: string;
  preconditionReceiptDigest: string;
  claimedScope: 'exact-commit-change-record';
  observedScope: 'exact-commit-change-record';
  limitations: string[];
  evidenceDigest: string;
}

export interface ChangeRecordExecutionEvidenceV1 {
  schemaVersion: 1;
  observation: ExactChangeRecordObservationV1;
  observationBytesDigest: string;
  terminalAttempt: TerminalAttemptV1;
  terminalAttemptDigest: string;
  evidenceDigest: string;
}

export function validateChangeRecordAtCommit(
  cwd: string,
  input: ExactChangeRecordInputV1,
  context: ChangeRecordPolicyValidationContextV1,
): Promise<ExactChangeRecordObservationV1>;
```

The owner composes existing exact commit/tree/blob readers from `git-input.ts`, the one
trusted-Git owner from CP-WA1, the neutral result/reason/precondition/attempt contracts,
and the shared supervisor. It reads raw commit and message bytes plus the fixed schema and
validated single-component `changes/CR-<id>.yaml` path from the candidate tree. It also
reads the exact closed policy/tool object set from the independently frozen
`policyRevisionOid`, validates the terminal `ChangeRecordPolicyExecutionEvidenceV1`, and
recomputes the semantic manifest/reason/policy/tool digests from those exact modes, blob
OIDs, byte lengths, and bytes. The schema object and every execution owner must match the
separately supplied `ChangeRecordPolicyValidationContextV1` before the rule runs. That
context is produced from the frozen lineage and protected evaluator, never from
`ExactChangeRecordInputV1.policyEvidence`, and independently fixes the expected revision,
tree, object-set, producer, tool, lease, and attempt store. A candidate-supplied schema, manifest, reason
catalog, tool set, digest, producer, or policy revision can never select its own validator;
missing protected policy evidence is `INCONCLUSIVE/2`, and a proven candidate schema
substitution is `BLOCK/1`. It never
reads authoritative bytes from the worktree. The trailer parser invokes the exact trusted
Git implementation with `interpret-trailers --parse --no-divider` over bounded exact
message bytes; no hand-written approximation or untrusted PATH Git is allowed.

Record intent is authoritative after schema validation. Preserve this closed compatibility
matrix for all five existing values:

| Record intent | `Change-Intent` absent | matching `Change-Intent` | other `Change-Intent` | `Regression-For` |
|---|---|---|---|---|
| `bugfix` | accepted | accepted | block mismatch | exactly one nonempty value required |
| `feature` | accepted | accepted | block mismatch | optional; never changes outcome |
| `chore` | accepted | accepted | block mismatch | optional; never changes outcome |
| `docs` | accepted | accepted | block mismatch | optional; never changes outcome |
| `refactor` | accepted | accepted | block mismatch | optional; never changes outcome |

The bugfix obligation derives from the validated record even when `Change-Intent` is
absent. Trailer values are pointers, never outcome declarations. Public reasons identify
only closed field/location IDs and opaque findings; raw trailer/record values and their
unkeyed hashes never enter JSON, stderr, summaries, or fingerprints.

The CLI exposes only
`inspect --candidate <40-hex> --policy-evidence-fd <protected-fd>
--policy-expectation-fd <separate-protected-fd> --json`,
`schema --json`, and `--help`. It rejects duplicate/unknown options, a missing/non-pipe/
replayed protected policy or expectation descriptor, and arbitrary message,
record, risk, outcome, or control-list input. `inspect` supervises one private evaluator,
joins the exact precondition, captured observation bytes, and terminal-attempt evidence in
`ChangeRecordExecutionEvidenceV1`, and preserves exits `0/1/2`. The native observation
does not contain its future terminal-attempt digest; downstream validation performs the
non-circular join after process close.
Draft commit-message feedback and hook integration remain absent until a separate packet
defines their non-authorizing index/message binding.

- [ ] **Step 1: Add RED policy, exact-object, redaction, limit, and spawned-CLI tests**

Prove the two known PASS bypasses, raw-value leak, ambient-schema/record substitution,
candidate-policy self-weakening, missing/swapped/replayed protected policy evidence,
missing/swapped/candidate-derived policy expectation context,
wrong policy revision/manifest/reason/schema/tool digest, forged self-consistent policy
packet, wrong policy producer/attempt, omitted/extra/substituted protected object, wrong
OID/tree/mode/blob/length/digest,
invalid final trailer block, continuation line,
duplicate trailer, missing companion trailer, invalid record path, message/record
count/byte exact-limit and one-over, malformed YAML/schema, stale precondition, replayed
attempt, timeout/crash/live descendant, unknown CLI option, duplicate option, help/schema,
and subprocess stdout/status contracts. Exercise the full five-intent matrix, including
absent, matching, and cross-product mismatched trailers; bugfix alone requires
`Regression-For` based on the record intent. Every unsafe fixture has a nearby safe commit;
unavailable evidence is inconclusive and public output omits the synthetic value and raw
SHA-256.

- [ ] **Step 2: Prove RED from the quarantined commit**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-change-record.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-git-input.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: the new bypass, redaction, exact-binding, and spawned-CLI assertions fail against
`72f86cc`; pre-existing safe-neighbor assertions remain green.

- [ ] **Step 3: Implement the exact owner and thin supervised CLI**

Check byte/count limits before read, split, traversal, mapping, or set construction. Parse
and validate exact objects and trailers, derive outcome only from the active reason
registry, emit one canonical bounded observation, and register the control as
`report-only` with its exact decision owner and current local stage. Its manifest row may
be executable for direct exact-commit inspection but is never blocking, required, or
hook/workflow wired in this bead.

- [ ] **Step 4: Verify GREEN and adjacent ownership**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-change-record.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-git-input.test.ts \
  tests/scripts/ci-control-manifest.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
bash scripts/run-with-pinned-npm.sh run guard:publication:all
git diff --check
```

- [ ] **Step 5: Independent review, protected commit, and clean-tree replay**

Require a fresh Luna/Tera source-line review bound to the exact diff and rerun both direct
falsifiers independently. Stage exactly the admitted paths, prove the moved fixture set
and no other `changes/CR-valid-*` production rows remain, run staged repository/
publication/hook guards, then run the exact protected boundary:

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "fix(ci): bind change records to exact commits" --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-after-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <id-from-protected-before-handle-output> \
  --after-handle <id-from-protected-after-handle-output> \
  --input - --format json
```

The first postcommit process is the displayed workspace check; the before ID is read only
from the launcher's protected output, not stdout or the preliminary handle. Transition
precedes human-readable Git inspection, Step 4 replay, and current upstream/remote
readback. Do not push from this bead; the full branch gate and whole-range review remain
separate prerequisites.

---

### Task 5: CP-F4 — Canonical fast and PR facades with truthful unavailable domains

Do not begin any CP-F4 bead until CP-WA1 and CR-P0.1 have clean committed-tree receipts
for this worktree and the current plan/manifest lineage lease. CR-P0.1 shares the manifest
and adds the report-only `ci:change-record` canonical command, so A2 inventory/count/
closure evidence from a pre-CR manifest is stale.

**Patch admission packet**

- Evidence: **Proven**. Package scripts expose lower-level checks and broad push/release chains but lack `verify:fast` and exact-classification-driven `verify:pr`.
- Reachable failure: hooks, local agents, and CI can compose divergent command sets and call the advisory selector as if authoritative.
- Unsafe fixture: caller omits a required manifest control or selects a lower tier.
- Safe neighbor: facade consumes the exact classifier receipt and executes the manifest-required set exactly once.
- Expected: incomplete/divergent set `INCONCLUSIVE/2`; exact set `PASS/0` when every child passes.
- Smallest repair: one orchestration CLI plus package facades; keep lower-level commands.
- Rollback: remove facades without removing underlying checks.

**Files:**

- CP-F4c1a and CP-F4c1b own only the exact files listed in their bead sections below.
- CP-F4c2 producer files and CP-F4c3 facade/hook files require separate patch-admission
  packets after CP-F4c1 evidence exists.

**Current implemented interface:**

```ts
export function compileReportOnlyExecutionPlan(
  manifest: ControlManifestV1,
  admission: AdmittedRiskClassificationV1,
  trustedInput: ExactRevisionInput,
): ControlExecutionPlanV1;
```

No `runExecutionPlan`, package facade, or hook adapter is admitted by CP-F4c1.

#### Adjudicated CP-F4 execution sequence

CP-F4 is split at evidence-production boundaries. A manifest declaration is policy data,
not observed execution evidence, and cannot authorize a process or satisfy a required
control.

- [x] **CP-F4a:** compile a strict, digest-bound, report-only execution plan from a
  same-process classification admission (`3e4f6aa7`).
- [x] **CP-F4b:** bind classification admission to the same process (`24d33f302`).
- [x] **CP-F4c0:** admit only the compiler-produced frozen plan to a permanently
  non-spawning preflight (`58e480af`).
- [x] **CP-F4c0a:** make historical attempt digests independent of ambient freshness
  while retaining freshness at admission (`518d2af7`).
- [x] **CP-F4c0b:** reject non-finite validation clocks before any precursor or terminal
  attempt write (`5fc2d34f`).
- [x] **CP-F4c0c:** enforce one canonical decision owner per
  `(policyCategory, surface)` while permitting distinct observers (`6e100ba7`).
- [ ] **CP-F4c1a1:** add read-only V2 decoding/canonicalization compatibility while the
  active manifest remains V1.
- [ ] **CP-F4c1a2:** migrate active data to Manifest V2 policy and lane inventory without
  execution authority.
- [ ] **CP-F4c1b:** add same-process stage admission and project exact Manifest V2 policy
  and one stage lane into a new Plan V2; keep preflight non-spawning and inconclusive.
- [ ] **CP-F4c2:** produce precondition, executable-closure, lineage-lease, supervised
  process, bounded-output, and terminal-attempt evidence.
- [ ] **CP-F4c3:** after CP-F5 transfers manifest-inventory ownership, dual-run old and
  new execution results and activate only the facade/hook boundary after exact parity
  and current-revision receipts.

CP-F4c1 approval does not authorize CP-F4c2 process creation or CP-F4c3 package-script,
hook, workflow, or hosted-setting changes.

#### CP-F4c1a: Manifest V2 dual-read execution policy and lane inventory

##### CP-F4c1a1 — Strict V1/V2 compatibility reader

**Patch admission packet CP-F4c1a1**

- Evidence: **Proven**. The current reader accepts only Manifest V1. Replacing it with a
  V2-only reader would make the migration PR's V1 base object unreadable.
- Reachable failure: an exact-object classifier or pre-push canary encounters a V1 base
  and V2 candidate, or encounters V2 during the compatibility revision before every V2
  field is strictly validated.
- Unsafe fixture: unsupported V2, partially validated V2, V2-to-V1 downgrade, V3 input,
  or a V2 object containing hidden/accessor/cyclic/over-budget data.
- Safe neighbor: frozen V1 bytes retain the independently known V1 digest; a complete V2
  fixture is fully validated and canonicalized even though the checked-in manifest stays
  V1.
- Expected: valid V1/V2 read evidence follows its own version contract; unsupported,
  malformed, downgrade, or mixed-policy classification remains `INCONCLUSIVE/2`.
- Smallest repair: introduce the discriminated union, complete strict V2 schema validator,
  V2 canonicalizer, and version-dispatched exact-object readers without changing active
  data or current-source behavior.
- Unchanged behavior: no manifest row authorizes execution; current Manifest V1 loading,
  canonical detector ownership, package scripts, hooks, workflows, and native decisions
  remain unchanged.
- Rollback: before V2 evidence exists, revert the ordinary compatibility commit. Once any
  V2 evidence is emitted, retain both decoders/canonicalizers so historical evidence stays
  readable; never rewrite a V1 or V2 digest.

**CP-F4c1a1 compatibility files:**

- Modify: `scripts/lib/ci-control/manifest.ts`
- Modify: `tests/scripts/ci-control-manifest.test.ts`
- Modify: `scripts/lib/ci-control/classifier.ts`
- Modify: `tests/scripts/ci-control-classifier.test.ts`
- Modify: `scripts/lib/ci-control/pre-push-canary.ts`
- Modify: `tests/scripts/ci-control-pre-push-canary.test.ts`

CP-F4c1a1 must not modify `controls/ci-control-manifest.json`, current-source CLI
behavior, execution plans, package scripts, hooks, or workflows.

##### CP-F4c1a2 — Active report-only policy and lane inventory

**Patch admission packet CP-F4c1a2**

- Evidence: **Proven**. Manifest V1 owns canonical argv, control ownership, stages, trust
  class, and declared availability but cannot express working-directory identity,
  reconstructed environment, executable/tool closure, timeout/grace, output limits,
  irreversible taint, stage-lane identity, dedupe key, or write scope.
- Reachable failure: command-only metadata conflates one command's stage/trust lanes, an
  incomplete active migration falsely advertises executable assurance, or callers retain
  V1 argv/environment assumptions after current data becomes V2.
- Unsafe fixture: missing or extra command policy; conflicting owner for one
  `(stage, controlId)`; duplicate lane ID/dedupe key; mutable `env` entrypoint
  substitution; missing/substituted plugin, interpreter, Git, or toolchain member;
  privilege after taint; escaping write scope; or static metadata presented as authority.
- Safe neighbor: the active V2 manifest has exactly one policy per canonical command and
  exactly one lane per `(stage, controlId)` while allowing one owner across different
  lanes; its inventory says `authorization:'report-only'` and `executable:false`.
- Expected: valid current V2 source inventory `PASS/0`; incomplete policy, conflicting
  ownership, bad closure, or taint/privilege contradiction `INCONCLUSIVE/2`. A
  deterministic validator defect is blocked by self-tests, but invalid data cannot emit
  authoritative runtime evidence.
- Smallest repair: migrate active data and current-source callers only after the strict V2
  reader is committed; retain canonical argv and native decision ownership.
- Unchanged behavior: no producer, runner, plan projection, facade, hook, workflow, or
  hosted setting is admitted.
- Rollback: restore active data/current loading to the prior V1 manifest while retaining
  both version decoders and canonicalizers.

**CP-F4c1a2 active-data files:**

- Modify: `controls/ci-control-manifest.json`
- Modify: `scripts/lib/ci-control/manifest.ts` only for V2-only current loading and V2 inventory output
- Modify: `scripts/ci-control-manifest.ts`
- Modify: `tests/scripts/ci-control-manifest.test.ts`
- Modify: `scripts/ci-control-ref-policy.ts`
- Modify: `tests/scripts/ci-control-ref-policy.test.ts`
- Modify: `tests/scripts/ci-control-classifier.test.ts`
- Modify: `tests/scripts/ci-control-pre-push-canary.test.ts`
- Modify: `tests/scripts/ci-control-classification-admission.test.ts`
- Modify: `scripts/lib/ci-control/execution-plan.ts` only for manifest-union typing
- Modify: `tests/scripts/ci-control-execution-plan.test.ts` only for current V2 fixtures
- Modify: `tests/scripts/hooks-installed-guard.test.ts`
- Modify: `tests/scripts/test-integrity-ci.test.ts`
- Modify: `tests/scripts/ci-control-workspace.test.ts` only for V2 manifest/policy fixtures

This is the complete admitted A2 write set. A2 Step 1 is discovery-only. If its reference
scan identifies any other required production caller or fixture, stop without RED edits,
revise this packet with exact paths and current hashes, and obtain a fresh independent
admission before mutation.

At merged base `91f550ec133bae75c7059822759b4a2973f80c3e`, the manifest has exactly
eight canonical commands. CP-WA1 adds `ci:workspace` for nine; committed CR-P0.1 adds
`ci:change-record` for ten; A2 then adds the four upstream commands for exactly fourteen.
A2 freezes and validates that exact `8 -> 9 -> 10 -> 14` bead-bound progression. The four upstream additions use separate rows and
cannot be collapsed into safeguard diagnostics:

| Command | Canonical native owner | Declared stages | Common-envelope availability and limitation |
|---|---|---|---|
| `guard:no-destructive-git` | `process.no-destructive-git` fitness rule and native guard | pre-commit, pre-push, pull-request, default-branch, release | `planned`; existing native blocking wiring remains, but ambient scope, `2`/`2` finding/error exits, raw output, and inline bypass cannot satisfy common evidence |
| `guard:grant-resolver` | grant-resolver inventory guard | pre-push, pull-request, default-branch, release | `planned`; existing native blocking wiring remains, with its narrow inline-composition scope disclosed |
| `guard:launchd-drift` | launchd drift guard | scheduled | `planned`; macOS-host-only command with exactly one report-only, non-executable `scheduled` lane for inventory completeness; absent native host/capability/precondition/input evidence keeps preflight `INCONCLUSIVE/2` with `spawnAllowed:false` until a separate native-host packet is admitted |
| `triage:required-suites` | required-suites triage owner | pre-push, pull-request | `advisory`; always visible, never pass-capable for mandatory work, and never an authoritative classifier |
| `ci:change-record` | exact-object change-record owner | local | `report-only`; exact candidate and protected-policy evidence are required, and no hook/workflow/required-check authority exists |

The manifest records claimed and observed scope separately. In particular,
`guard:no-destructive-git` observes committed shell automation beneath `scripts/`,
`deploy/`, `tools/`, and `.husky/`; it explicitly does not cover workflow YAML or all
automation. Workflow-AST ownership remains with safeguard diagnostics. A2 must not repair
or reinterpret native results. A later separately admitted native-evidence bead must prove
exact staged/object readers, `BLOCK/1` versus unavailable `INCONCLUSIVE/2`, bounded
sanitized output, native-cause preservation, and terminal receipt production before the
row can become executable or satisfy an aggregate.

**Interfaces:**

```ts
export type AnyControlManifest = ControlManifestV1 | ControlManifestV2;

export interface ControlManifestV2
  extends Omit<ControlManifestV1, 'schemaVersion'> {
  schemaVersion: 2;
  executionPolicies: Record<string, CommandExecutionPolicyV1>;
  executionLanes: ExecutionLanePolicyV1[];
}

export interface CommandExecutionPolicyV1 {
  schemaVersion: 1;
  workingDirectory: {
    kind: 'repository-root';
    identityBinding: 'exact-precondition-receipt';
  };
  environment: {
    inheritance: 'none';
    variables: ExecutionEnvironmentVariableV1[];
  };
  executable: {
    entrypoint: {
      argvIndex: 0;
      expectedBasename: string;
      observationId: ExecutableObservationIdV1;
      identityBinding: 'exact-precondition-receipt';
    };
    closure: ExecutableClosureMemberV1[];
  };
  limits: {
    calibration: 'proposed-report-only';
    timeoutMs: number;
    killGraceMs: number;
    stdoutMaxBytes: number;
    stderrMaxBytes: number;
    stdoutMaxLines: number;
    stderrMaxLines: number;
  };
  trust: {
    taints: Array<'candidate-source' | 'untrusted-cache' | 'untrusted-artifact'>;
    privileges: Array<'repository-write' | 'package-publication' | 'oidc' |
      'signing' | 'private-assurance' | 'production-network' | 'trusted-cache'>;
    allowedWriteScopes: Array<'attempt-temp'>;
  };
}

export type ExecutionEnvironmentVariableV1 =
  | { name: 'LANG' | 'LC_ALL'; source: 'literal'; value: 'C' }
  | { name: 'TZ'; source: 'literal'; value: 'UTC' }
  | { name: 'WHATSOUP_REQUIRE_TEST_INTEGRITY'; source: 'literal'; value: '1' }
  | { name: 'HOME'; source: 'attempt-home' }
  | { name: 'TMPDIR'; source: 'attempt-temp' }
  | { name: 'PATH'; source: 'observed-manifest-path'; manifest: 'process-path' }
  | { name: 'WHATSOUP_NODE'; source: 'observed-executable-path'; executable: 'node' }
  | { name: 'TEST_INTEGRITY_BIN'; source: 'observed-executable-path'; executable: 'test-integrity-launcher' };

export type ExecutableObservationIdV1 =
  | 'bash'
  | 'node'
  | 'git'
  | 'dirname'
  | 'readlink'
  | 'basename'
  | 'tr'
  | 'grep'
  | 'cat'
  | 'sed'
  | 'mktemp'
  | 'rm'
  | 'cmp'
  | 'diff'
  | 'mkdir'
  | 'python3'
  | 'env'
  | 'test-integrity-launcher'
  | 'test-integrity-python';

export type FileObservationIdV1 = 'test-integrity-python-target';

export type ManifestObservationIdV1 =
  | 'process-path'
  | 'node-project-source'
  | 'node-project-install'
  | 'test-integrity-install';

// CP-F4c2 must produce these observations in a new versioned receipt. The existing
// PreconditionReceiptV1 cannot satisfy them and remains unchanged in CP-F4c1.
interface BaseExecutableObservationV1 {
  invokedAs: string;
  absolutePath: string;
  realPath: string;
  version: string | null;
  launcherDigest: string;
}

export interface StandardExecutableObservationV1
  extends BaseExecutableObservationV1 {
  id: Exclude<ExecutableObservationIdV1, 'git' | 'test-integrity-launcher'>;
  implementationPath: string | null;
  implementationDigest: string | null;
}

export interface GitExecutableObservationV1
  extends BaseExecutableObservationV1 {
  id: 'git';
  implementationPath: string;
  implementationDigest: string;
}

export interface TestIntegrityLauncherObservationV1
  extends BaseExecutableObservationV1 {
  id: 'test-integrity-launcher';
  interpreterChain: readonly ['env', 'bash'];
}

export type ExecutableObservationV1 =
  | StandardExecutableObservationV1
  | GitExecutableObservationV1
  | TestIntegrityLauncherObservationV1;

export interface FileObservationV1 {
  id: FileObservationIdV1;
  sourceManifest: 'test-integrity-install';
  sourceEntryIdentity: string;
  absolutePath: string;
  realPath: string;
  fileType: 'regular';
  mode: number;
  size: number;
  digest: string;
}

interface ManifestObservationBaseV1 {
  entries: Array<{ name: string; identity: string; digest: string }>;
  manifestDigest: string;
}

export type ManifestObservationV1 =
  | (ManifestObservationBaseV1 & {
      id: 'node-project-source';
      source: { kind: 'git-object'; sourceOid: string; treeOid: string };
    })
  | (ManifestObservationBaseV1 & {
      id: 'node-project-install' | 'test-integrity-install';
      source: {
        kind: 'installed-tree';
        installRootRealPath: string;
        lockDigest: string;
        attemptId: string;
      };
    })
  | (ManifestObservationBaseV1 & {
      id: 'process-path';
      source: {
        kind: 'observed-path';
        pathValueDigest: string;
        attemptId: string;
      };
    });

export type ExecutableClosureLocatorV1 =
  | { kind: 'argv-index'; index: number; executable: ExecutableObservationIdV1 }
  | { kind: 'repository-file'; path: ExecutableRepositoryPathV1 }
  | { kind: 'observed-executable'; executable: ExecutableObservationIdV1 }
  | { kind: 'observed-file'; file: FileObservationIdV1 }
  | { kind: 'observed-manifest'; manifest: ManifestObservationIdV1 };

export interface ExecutableClosureMemberV1 {
  role:
    | 'entrypoint'
    | 'wrapper'
    | 'runtime'
    | 'interpreter'
    | 'plugin'
    | 'tool'
    | 'toolchain'
    | 'target'
    | 'runtime-policy';
  locator: ExecutableClosureLocatorV1;
  identityBinding:
    | 'candidate-blob-sha256'
    | 'observed-path-version-and-sha256'
    | 'observed-file-sha256'
    | 'observed-manifest-sha256';
}

export type ExecutableRepositoryPathV1 =
  | '.nvmrc'
  | 'package.json'
  | 'package-lock.json'
  | 'eslint.config.fitness.mjs'
  | '.claude/test-integrity/baseline.json'
  | 'scripts/run-with-pinned-node.sh'
  | 'scripts/test-integrity-ci.sh'
  | 'scripts/repo-hygiene-guard.ts'
  | 'scripts/publication-guard.ts'
  | 'scripts/eslint-fitness-check.ts'
  | 'scripts/safeguard-diagnostics.ts'
  | 'scripts/no-destructive-git-guard.ts'
  | 'scripts/grant-resolver-inventory-guard.ts'
  | 'scripts/check-launchd-drift.sh'
  | 'scripts/required-suites.ts'
  | 'scripts/lib/guard-core.ts'
  | 'src/lib/git-env.ts'
  | 'deploy/scripts/render-release-drift-launchd.sh'
  | 'deploy/scripts/render-watchdog.py'
  | 'scripts/hooks-installed-guard.ts'
  | 'scripts/ci-control-ref-policy.ts'
  | 'scripts/ci-control-classify.ts'
  | 'scripts/ci-control-workspace.ts'
  | 'scripts/ci-change-record.ts'
  | 'scripts/lib/ci-control/workspace-accounting.ts'
  | 'scripts/lib/ci-control/change-record.ts'
  | 'scripts/lib/ci-control/git-input.ts'
  | 'scripts/lib/ci-control/reasons.ts'
  | 'scripts/lib/ci-control/result.ts'
  | 'scripts/lib/ci-control/preconditions.ts'
  | 'scripts/lib/ci-control/trusted-git.ts'
  | 'scripts/lib/ci-control/supervised-command.ts'
  | 'scripts/lib/ci-control/attempt.ts'
  | 'controls/schema/change-record.schema.json'
  | 'controls/ci-control-manifest.json';

export interface ExecutionLanePolicyV1 {
  schemaVersion: 1;
  id: string;
  stage: ControlStage;
  controlId: string;
  executionOwner: string;
  dedupeKey: string;
  mutationMode: 'read-only';
  allowedWriteScopes: Array<'attempt-temp'>;
  trustClass: TrustClass;
  lineageLease: 'required';
  terminalAttempt: 'required';
}

export interface ControlInventoryV2 {
  schemaVersion: 2;
  authorization: 'report-only';
  executable: false;
  manifestDigest: string;
  controls: Array<{
    id: string;
    owner: string;
    decisionOwner: string;
    domain: ControlDomain;
    trustClass: TrustClass;
    stages: ControlStage[];
    surfaces: string[];
    declaredAvailability: ControlAvailability;
    implementation: ControlImplementationV1;
  }>;
  executionPolicies: Record<string, CommandExecutionPolicyV1>;
  executionLanes: ExecutionLanePolicyV1[];
  requiredSurfaces: string[];
  absentCapabilityFamilies: string[];
  limitations: string[];
}
```

`ControlManifestV1` remains a real historical type. Do not rename V2 to V1, cast V2 to
V1, or ignore V2 keys. Parsing and canonicalization dispatch by `schemaVersion`; V1
canonical bytes and digests remain byte-for-byte stable. The version-dispatched loader
accepts V1 or V2. After active-data migration, `loadCurrentControlManifest()` requires V2
for current-source orchestration, while exact-Git-object base loading continues accepting
V1 or V2 for migration classification and historical verification.

`keyset(executionPolicies) == keyset(canonicalCommands)`. `canonicalCommands` remains the
only argv owner. `executionLanes` owns stage-specific execution owner, dedupe key, trust,
lease, attempt, and write scope. Lane IDs and dedupe keys are unique, and every
`(stage, controlId)` pair has exactly one lane. The same `executionOwner` may own several
different lanes; a conflicting owner for one `(stage, controlId)` is invalid.
The launchd scheduled lane satisfies inventory cardinality only. It does not assert a
runner, host availability, observed installed inputs, or PASS-capable execution. A2 tests
reject a missing/duplicate launchd lane, `executable:true`, required authorization, static
closure promoted as host proof, and any no-host receipt that does not remain
`INCONCLUSIVE/2` with `spawnAllowed:false`.

The test-integrity command moves
`WHATSOUP_REQUIRE_TEST_INTEGRITY=1` from the leading `env` argv hop into a literal
environment row; its argv becomes `['bash', 'scripts/test-integrity-ci.sh']`. This removes
an otherwise unverified `env` argv hop. `TEST_INTEGRITY_BIN` is sourced from the observed
`test-integrity-launcher` identity. The
common reconstructed environment declares `HOME` from an attempt home, `TMPDIR` from the
attempt temp, `PATH` from the observed `process-path` manifest, and `LANG=C`, `LC_ALL=C`,
and `TZ=UTC` as literals. Wrapper commands receive `WHATSOUP_NODE` from the exact observed
Node executable, so isolated `HOME` cannot make the wrapper fall back to an ambient
runtime. Unknown environment names and invalid name/source/observation combinations are
rejected. Executable, file, and manifest observation IDs are closed manifest references,
not dotted paths into the current receipt.

Entrypoint identity alone is insufficient. Each command policy declares an exact required
closure set, and validation rejects a missing, duplicate, substituted, or extra member.
Pinned-Node commands bind Bash, `scripts/run-with-pinned-node.sh`, `.nvmrc`, the
`package.json` engine rule, `package-lock.json`, the observed Node runtime, the exact target
script, the installed Node project manifest, and every wrapper utility (`dirname`,
`readlink`, `basename`, `tr`, `grep`, and `cat`). Git is required only for a command whose
frozen transitive source-reference scan proves that its target invokes Git; a command that
does not invoke Git must not claim a fabricated Git dependency.
`guard:test-integrity:required` additionally binds `scripts/test-integrity-ci.sh`, the
observed `TEST_INTEGRITY_BIN` launcher, its `/usr/bin/env` and Bash launcher chain, the
observed Python runtime and external Python target, Git, the plugin-install manifest, and
`.claude/test-integrity/baseline.json`. Every closure row identifies an argv index plus
closed executable observation, a member of the closed repository-file union, a closed
executable/file observation, or a closed manifest observation.
Role/source/observation compatibility is exact-key validated. Launcher and resolved
implementation identities are separate for Git, Node, Python, and other executables so a
PATH shim cannot stand in for the executable that actually ran. For
`test-integrity-launcher`, `launcherDigest` binds the exact executable shell launcher and
the exact `env`/Bash interpreter chain; the separately observed
`test-integrity-python-target` binds the external Python target, so no ambiguous second
launcher implementation field exists. `FileObservationV1.sourceEntryIdentity` must join
exactly one entry in the named install manifest and that entry's identity/digest must
equal the observed file identity/digest. Source manifests bind exact source/tree OIDs;
install manifests bind exact real install root, lock digest, and attempt; the PATH
manifest binds the exact PATH-value digest and attempt. The existing
`PreconditionReceiptV1` has no such observations and
cannot satisfy them. CP-F4c2 must introduce a new versioned producer/validator for the
`ExecutableObservationV1`, `FileObservationV1`, and `ManifestObservationV1` contracts;
static policy does not claim runtime closure has been proven. That future receipt uses
exact key sets, bounded absolute/real paths and versions, regular-file type/mode/size,
finite sizes, canonical sorted observation IDs, exact byte digests, an enclosing freshness
timestamp/attempt binding, and one digest over the canonical receipt bytes. Git observations
reject a missing launcher or implementation identity. Test-integrity launcher observations
require the exact `env`/Bash chain, and the Python runtime and external target remain
separate required observations. Missing Git implementation, substituted launcher/
implementation, non-regular target, absent/duplicate/wrong install-manifest entry,
entry/file digest mismatch, stale receipt, and one-byte mutation fixtures are mandatory
in CP-F4c2.

Before finalizing the fourteen post-CR policy rows, run a source reference scan from each exact argv
target and wrapper. The scan freezes one command-specific closure table in the manifest:

| Command family | Required static closure members |
|---|---|
| pinned-Node common closure | Bash; wrapper; Node; `.nvmrc`; `package.json`; `package-lock.json`; direct target; Node source/install manifests; `dirname`, `readlink`, `basename`, `tr`, `grep`, and `cat` |
| pinned-Node command-specific closure | Git launcher/implementation only where the frozen transitive target actually invokes Git; `eslint.config.fitness.mjs` and installed ESLint graph for `guard:lint:src`; installed YAML graph for safeguard diagnostics |
| `guard:no-destructive-git` and `guard:grant-resolver` | pinned-Node common closure plus their direct targets; no Git observation because neither target invokes Git |
| `triage:required-suites` | pinned-Node common closure; `scripts/required-suites.ts`; `scripts/lib/guard-core.ts`; `src/lib/git-env.ts`; Git launcher and implementation |
| `guard:launchd-drift` | Bash and `scripts/check-launchd-drift.sh`; observed `dirname`, `basename`, `cat`, `sed`, `grep`, `mktemp`, `rm`, `cmp`, `diff`, `mkdir`, and `python3`; `deploy/scripts/render-release-drift-launchd.sh`; `deploy/scripts/render-watchdog.py`; no Git observation |
| `guard:test-integrity:required` | Bash entrypoint; wrapper; Git launcher/implementation; plugin launcher; `env`/Bash launcher chain; launcher-internal PATH-resolved `dirname`; Python runtime; external Python target; plugin-install manifest; baseline file |
| `ci:workspace` | workspace CLI/accounting owner; shared trusted-Git owner and launcher/implementation; shared supervised-command owner; attempt store; exact pinned wrapper/Node/tool sources; no ambient or second process/Git implementation |
| `ci:change-record` | pinned-Node common closure; `scripts/ci-change-record.ts`; `scripts/lib/ci-control/change-record.ts`; `controls/schema/change-record.schema.json`; active reason catalog; exact-object/trusted-Git owner; protected policy-evidence schema; shared supervisor and attempt store |

Tests remove or substitute each special member in turn, including `TEST_INTEGRITY_BIN`,
its launcher, launcher-internal `dirname`, and Python interpreters, external Python target, Git launcher/implementation,
wrapper utilities, source/install manifests, and every `ci:workspace` shared supervisor/
trusted-Git/attempt/source member. The `ci:change-record` tests independently remove or
substitute its CLI, owner, schema, manifest, reason/result/precondition catalog, exact-Git,
trusted-Git, supervisor, and attempt member and prove the fourteen-row keyset/limits/
closure join cannot omit or replace that command. The four merged-command tests also remove or substitute
each command-specific transitive source and executable listed above, including the nested
launchd renderer's `mkdir`. A closure declaration remains
report-only until CP-F4c2 produces and validates the corresponding observed receipts.

Executable closure does not stand in for input evidence. The launchd native-host packet
must separately freeze the exact repository template path/digest set and the exact
installed host path/type/mode/digest observations consumed by the command. An unavailable,
extra, substituted, or unreadable template/installed input is `INCONCLUSIVE/2`; neither a
matching executable closure nor a runner label can supply the missing input evidence.

Initial limits are conservative safety ceilings labeled `proposed-report-only`, not
calibrated latency targets:

| Command | Timeout | Kill grace | stdout/stderr bytes | stdout/stderr lines |
|---|---:|---:|---:|---:|
| `guard:repo` | 120000 | 30000 | 4194304 | 20000 |
| `guard:publication` | 120000 | 30000 | 4194304 | 20000 |
| `guard:test-integrity:required` | 900000 | 30000 | 4194304 | 20000 |
| `guard:lint:src` | 600000 | 30000 | 4194304 | 20000 |
| `guard:safeguard-diagnostics` | 120000 | 30000 | 4194304 | 20000 |
| `guard:no-destructive-git` | 120000 | 30000 | 4194304 | 20000 |
| `guard:grant-resolver` | 120000 | 30000 | 4194304 | 20000 |
| `guard:launchd-drift` | 120000 | 30000 | 4194304 | 20000 |
| `triage:required-suites` | 120000 | 30000 | 4194304 | 20000 |
| `guard:hooks-installed` | 120000 | 30000 | 4194304 | 20000 |
| `ci:ref-policy` | 120000 | 30000 | 4194304 | 20000 |
| `ci:classify` | 120000 | 30000 | 4194304 | 20000 |
| `ci:workspace` | 120000 | 30000 | 4194304 | 20000 |
| `ci:change-record` | 120000 | 30000 | 4194304 | 20000 |

No blocking promotion may rely on these ceilings until representative measurements,
exact-limit/one-over tests, and an owner review calibrate them.

Schema hard bounds are independent of configured command ceilings: at most 64 environment
rows, 32 closure rows, and `MAX_CONTROL_COUNT * CONTROL_STAGES.length` lane rows; timeout
is `1..3600000` ms, kill grace is `1..60000` ms and no greater than timeout, each stream
budget is `1..16777216` bytes and `1..100000` lines, each environment value is at most
4096 UTF-8 bytes, and each repository path is at most 1024 UTF-8 bytes. Tests accept every
exact maximum and reject one-over, non-integer, and non-finite inputs before
canonicalization.

V2 canonicalization sorts command-policy map keys, lanes by ID, environment rows by name,
closure rows by role and canonical locator, taints, privileges, write scopes, and other
set-valued fields. It preserves canonical argv order, remediation-step order, and every
other sequence whose order is semantic. Reordering a set leaves the V2 digest unchanged;
changing an ordered field changes it.

- [ ] **A1 Step 1: Write RED strict V1/V2 compatibility tests**

Add fixtures proving V1-base/V2-candidate readability and system-wide inconclusive
classification, V2-base/V2-candidate exact classification, V2-base/V1 downgrade and V3
inconclusive behavior. Freeze the exact current V1 fixture bytes and independently known
digest literal
`sha256:6b119090bdc30badec3be94dbdffd254172cdf8d92c111accd35a3d6a3291dd0`;
the modified canonicalizer must reproduce that historical pre-CP-WA1 literal without
translating through V2. CP-WA1 intentionally adds its V1 control/command before A1; freeze
its exact committed V1 bytes and independently computed digest as a second fixture, and
require the modified canonicalizer to reproduce both literals without translation.
Add complete V2 exact-key, hidden/symbol/accessor, cycle, count/depth/UTF-8, policy/lane
key-set, environment source/observation compatibility, executable/tool closure,
timeout/output exact-limit, taint/privilege, write-scope, lane identity, dedupe-key,
repeated-owner safe-neighbor across distinct lane keys, duplicate `(stage, controlId)` with
the same owner, duplicate `(stage, controlId)` with different owners, and versioned
canonicalization assertions. Add a candidate that deletes or weakens its manifest
validator/policy sources and prove the trusted V1 base selects system-wide/inconclusive;
prove current-source CLI bytes and behavior remain V1 throughout A1 and no V1/V2 result or
digest is relabeled. Add exact-commit manifest-reader tests for ambient worktree divergence,
full lowercase commit OID enforcement, fixed path, `100644` regular blob mode, tree/blob
identity, raw byte length/digest, semantic digest, and evidence-digest sensitivity. Reject
refs, abbreviations, uppercase OIDs, tree/blob OIDs, missing path, directory, symlink,
executable mode, malformed JSON, V3, identity mismatch, and one-byte substitution as
inconclusive. Equivalent manifest bytes from another commit cannot satisfy a frozen base
without exact revision equality. These tests fail before any V2 reader is committed.

- [ ] **A1 Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: failures identify unsupported or incompletely validated V2 and unreadable
mixed-version classification; no active manifest, CLI, or execution-plan fixture changes.

- [ ] **A1 Step 3: Implement complete strict V2 read compatibility**

Keep independent exact top-level key sets and validators for V1 and V2. Validate bounds
before traversal and reject unknown/non-data properties, duplicate IDs/keys, missing or
extra policy rows, invalid environment/observation combinations, entrypoint or closure
mismatch, non-finite/out-of-range limits, privilege after taint, broad write scopes,
conflicting `(stage, controlId)` ownership, and incomplete stage coverage. Share only
already-proven leaf validators. `parseControlManifestBytes()` and `loadControlManifest()`
return the discriminated union; `digestControlManifest()` canonicalizes the supplied
version without translation. Current-source loading remains V1 in this bead.

Replace the classifier's private `candidateManifest()` helper with exported
`readExactControlManifestAtCommit(cwd, revisionOid)`. It composes
`readExactTreeEntries()` and `readExactBlobs()`, returns the validated manifest plus
`ExactControlManifestEvidenceV1`, and never reads the ambient worktree. Keep
`ExactRevisionInput` and existing classification receipt wire shapes stable: its
`manifestDigest` remains the semantic manifest digest. Repository identity, tool identity,
attempt lifecycle, and exact emitted-byte digest belong to the later CLI's terminal
envelope, not this pure object-read evidence.

- [ ] **A1 Step 4: Verify, review, and commit the compatibility bead**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git diff --check
```

Expected: the frozen V1 digest and every valid/invalid V2 compatibility fixture pass.
Obtain independent source-line review, confirm the checked-in manifest is still V1 and
the diff contains only CP-F4c1a1 files, stage exactly that set, capture and compare the
global frozen workspace-set receipt with the exact A1 admission through the pinned
`ci:workspace` invocation, and run:

```bash
git diff --cached --name-status
git diff --cached --check
git diff --name-status
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:staged
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "feat(ci): retain strict versioned manifest decoding" --format json
```

Expected: the staged set equals the six named A1 files and has no unstaged overlap. The
launcher performs the final claim and trusted commit; no raw commit path is permitted.

- [ ] **A1 Step 5: Reverify the clean committed bead**

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <opaque-before-id> --after-handle <opaque-after-id> \
  --input - --format json
GIT_OPTIONAL_LOCKS=0 git status --short
GIT_OPTIONAL_LOCKS=0 git diff-tree --no-commit-id --name-status -r HEAD
GIT_OPTIONAL_LOCKS=0 git diff --check HEAD^ HEAD
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
bash scripts/run-with-pinned-npm.sh run guard:repo:commit-authors
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
```

Expected: clean worktree/index, exact A1 committed file set, and the same focused tests
passing from committed bytes. Revalidate HEAD and `origin/main`; drift invalidates review.

##### CP-F4c1a2 execution steps

- [ ] **A2 Step 1: Freeze callers/closure and write RED active-migration tests**

Without editing, run exact reference scans for `loadControlManifest`, `parseControlManifestBytes`,
`digestControlManifest`, `canonicalCommands`, the test-integrity argv, every wrapper, and
every target's directly invoked external executable. Confirm the results equal the frozen
A2 file set above; any difference stops the bead for packet re-admission. Only after that
checkpoint, add RED tests for the V2-only current
loader; report-only/non-executable inventory; exact policy/lane sets; repeated owner across
different lanes; same-owner and different-owner duplicates on one `(stage, controlId)`;
missing/substituted
plugin, interpreter, Git, or source/install-manifest closure; and V1-to-V2 argv/environment parity. Add
one cross-caller fixture proving the same V2 bytes/digest are consumed by the current
loader, exact-object classifier/canary reader, ref policy, classification admission,
execution-plan fixture, hook-command fixture, and CP-WA1 workspace fixture. Swap
same-shaped policy/lane rows;
remove or add a policy, lane, closure member, observation, or canonical command; reject V1
as current while preserving exact-object V1 reads; and prove candidate self-removal cannot
inherit an old pass. Package facades and native detector behavior remain byte-for-byte
unchanged.

- [ ] **A2 Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/test-integrity-ci.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  tests/scripts/launchd-drift.test.ts \
  tests/scripts/required-suites.test.ts \
  tests/scripts/ci-control-workspace.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: current loading, inventory, closure, and parity fixtures fail while the A1
compatibility suite remains green.

- [ ] **A2 Step 3: Migrate the checked-in manifest and current-source callers**

Add the fourteen post-CR policy rows and one lane per current `(control, stage)` pair,
including `ci:workspace` with its shared supervisor/trusted-Git/attempt closure and no
second owner. Change only
the manifest's test-integrity argv/environment representation described above. Update
only the reference-scan-proven current-source callers and execution-plan fixtures to V2
without projecting policy yet. Add `loadCurrentControlManifest()` as V2-only; keep
exact-object classifier/canary readers dual-version so a V1 base remains readable.

Add an invocation-parity test proving the V1 `env WHATSOUP_REQUIRE_TEST_INTEGRITY=1 bash`
representation and the V2 fixed-environment plus `bash` representation deliver the same
exact variable to the unchanged native script. The argv/manifest digest changes
intentionally; the package script and native detector behavior do not.

Mixed V1-base/V2-candidate behavior is a classifier-only migration case and remains
system-wide/inconclusive. Execution-plan compilation continues to require the exact
base-policy manifest digest bound by the admitted classification; c1a plan fixtures use a
V2 base and matching V2 manifest, never the changed V2 candidate from a V1-bound result.

- [ ] **A2 Step 4: Verify GREEN and invalidation behavior**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/test-integrity-ci.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  tests/scripts/launchd-drift.test.ts \
  tests/scripts/required-suites.test.ts \
  tests/scripts/ci-control-workspace.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run ci:manifest -- validate --json
bash scripts/run-with-pinned-npm.sh run ci:manifest -- inventory --json
git diff --check
```

Expected: all listed tests and commands pass without retry; the current manifest emits a
report-only, non-executable V2 inventory. Historical V1 evidence remains readable and
verifiable against its original digest, but it is ineligible to authorize current V2
policy unless the exact lineage and policy digest match; no old pass transfers.

- [ ] **A2 Step 5: Independent source-line review and commit**

Review active-data exact sets, every reference-scan caller, historical digest stability,
classifier mixed-version behavior, static-versus-observed authorization, executable/tool
closure, taint, and provisional-limit disclosure. Confirm the diff contains only A2 files,
stage exactly that set, capture and compare the global frozen workspace-set receipt with
the exact A2 admission through the pinned `ci:workspace` invocation, and run:

```bash
git diff --cached --name-status
git diff --cached --check
git diff --name-status
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:staged
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "feat(ci): add report-only execution policy inventory" --format json
```

Expected: the staged set equals the frozen A2 file manifest and has no unstaged overlap.
The launcher performs the final claim and trusted commit; no raw commit path is permitted.

- [ ] **A2 Step 6: Reverify the clean committed bead**

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <opaque-before-id> --after-handle <opaque-after-id> \
  --input - --format json
GIT_OPTIONAL_LOCKS=0 git status --short
GIT_OPTIONAL_LOCKS=0 git diff-tree --no-commit-id --name-status -r HEAD
GIT_OPTIONAL_LOCKS=0 git diff --check HEAD^ HEAD
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/test-integrity-ci.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  tests/scripts/launchd-drift.test.ts \
  tests/scripts/required-suites.test.ts \
  tests/scripts/ci-control-workspace.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run ci:manifest -- validate --json
bash scripts/run-with-pinned-npm.sh run ci:manifest -- inventory --json
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
bash scripts/run-with-pinned-npm.sh run guard:repo:commit-authors
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
```

Expected: clean worktree/index, exact A2 committed set, report-only/non-executable
inventory, and every integration test passing from committed bytes. Revalidate HEAD and
`origin/main`; drift invalidates review.

#### CP-F4c1b: Trusted stage admission, exact projection, and non-spawning preflight

**Patch admission packet**

- Evidence: **Proven**. The frozen Plan V1 currently projects argv but no launch policy,
  stage, or lane; preflight truthfully lists all nine kernel contracts as unavailable.
- Reachable failure: a caller substitutes policy data, a plan omits a selected lane, or
  preflight removes a producer gap merely because static metadata exists.
- Unsafe fixture: cloned/reconstructed/proxy plan, policy row from another command,
  duplicate or absent lane, post-compile manifest mutation, or missing producer receipt.
- Safe neighbor: a same-process stage admission derives one closed stage from an exact
  event/operation pair, and the genuine frozen Plan V2 contains the exact detached policy
  and single `(stage, control)` lane covered by manifest and plan digests.
- Expected: every case remains `INCONCLUSIVE/2` with `spawnAllowed:false`; unadmitted
  input returns `ci.execution-kernel.plan-unadmitted` without property access.
- Smallest repair: add a non-authoritative same-process stage admission, then project one
  exact policy and lane into a versioned Plan V2. Preserve every runtime-observation gap.
  Do not create a producer or runner.
- Rollback: retain Plan V2 decoding for historical evidence; stop producing Plan V2 and
  return to Plan V1 preflight. Manifest V2 remains valid report-only inventory.

**Files:**

- Modify: `scripts/lib/ci-control/execution-plan.ts`
- Modify: `scripts/lib/ci-control/execution-kernel-preflight.ts`
- Create: `scripts/lib/ci-control/execution-stage-admission.ts`
- Modify: `tests/scripts/ci-control-execution-plan.test.ts`
- Create: `tests/scripts/ci-control-execution-stage-admission.test.ts`

**Interface change:**

```ts
export type ExecutionOperation =
  | 'local-fast'
  | 'pre-push'
  | 'pull-request'
  | 'merge-group'
  | 'default-branch'
  | 'release';

export interface ExecutionStageAdmissionV1 {
  readonly schemaVersion: 1;
  readonly operation: ExecutionOperation;
  readonly eventName: ExactRevisionInput['eventName'];
  readonly stage: ControlStage;
  readonly baseOid: string | null;
  readonly candidateOid: string;
  readonly mergeOid: string | null;
  readonly classificationEvidenceDigest: string;
  readonly manifestDigest: string;
  readonly evidenceDigest: string;
}

export function admitExecutionStage(
  classificationAdmission: AdmittedRiskClassificationV1,
  trustedInput: ExactRevisionInput,
  operation: ExecutionOperation,
): ExecutionStageAdmissionV1;

export function matchesSameProcessExecutionStageAdmission(
  value: unknown,
): value is ExecutionStageAdmissionV1;

export interface ControlExecutionStepV2 {
  readonly controlId: string;
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly executionPolicy: Readonly<CommandExecutionPolicyV1>;
  readonly executionLane: Readonly<ExecutionLanePolicyV1>;
  readonly dependencies: readonly string[];
  readonly availability: ControlAvailability;
  readonly disposition: ExecutionStepDisposition;
}

export interface ControlExecutionPlanV2
  extends Omit<ControlExecutionPlanV1, 'schemaVersion' | 'steps' | 'planDigest'> {
  readonly schemaVersion: 2;
  readonly executionStage: ControlStage;
  readonly stageAdmissionDigest: string;
  readonly steps: readonly ControlExecutionStepV2[];
  readonly planDigest: string;
}

export function compileReportOnlyExecutionPlanV2(
  manifest: ControlManifestV2,
  classificationAdmission: AdmittedRiskClassificationV1,
  stageAdmission: ExecutionStageAdmissionV1,
  trustedInput: ExactRevisionInput,
): ControlExecutionPlanV2;

export type KernelRuntimeEvidenceRequirementV2 =
  | 'working-directory-observation'
  | 'environment-reconstruction-receipt'
  | 'executable-closure-receipt'
  | 'timeout-enforcement-receipt'
  | 'output-budget-enforcement-receipt'
  | 'taint-write-scope-enforcement-receipt'
  | 'precondition-receipt-producer'
  | 'supervisor-process-lease-producer'
  | 'terminal-result-producer';

export interface ReportOnlyKernelPreflightV2 {
  readonly schemaVersion: 2;
  readonly authorization: 'report-only';
  readonly operation: 'evidence-collection';
  readonly outcome: 'inconclusive';
  readonly exitCode: 2;
  readonly spawnAllowed: false;
  readonly plan: ControlExecutionPlanV2;
  readonly unavailableInputs: readonly KernelRuntimeEvidenceRequirementV2[];
}
```

The stage admission permits only these pairs:

| Operation | Event | Derived stage |
|---|---|---|
| `local-fast` | `local` | `pre-commit` |
| `pre-push` | `push` | `pre-push` |
| `pull-request` | `pull_request` | `pull-request` |
| `merge-group` | `merge_group` | `merge-group` |
| `default-branch` | `push` | `default-branch` |
| `release` | `tag` | `release` |

The same-process brand prevents reconstruction but is not authorization; only the future
canonical facade may select an operation at CP-F4c3. `admitExecutionStage()` requires the
same admitted-classification object and trusted input used by the compiler and cross-checks
the exact event, base/candidate/merge OIDs, classification evidence digest, and manifest
digest before registering the final deeply frozen receipt. The compiler rejects any stage
receipt that does not satisfy `matchesSameProcessExecutionStageAdmission()` for those same
object identities and bindings. Mismatched or caller-invented pairs are inconclusive. Each
selected lane must satisfy `lane.stage == admitted stage`,
`lane.controlId == step.controlId`, `lane.trustClass == control.trustClass`, and identical
allowed-write-scope semantics between the command policy and lane.

The Plan V2 digest covers the stage admission, policy, and lane bytes. The compiler
deep-copies and deep-freezes them, and its same-process WeakMap binding retains the exact
`steps` identity. Plan V1 parsing/canonicalization is retained but never relabeled as V2.
Preflight accepts no second policy, lane, or stage argument and does not inspect ambient
CWD, environment, clock, filesystem, network, or process state.

- [ ] **Step 1: Write RED exact-projection and hostile-input tests**

Cover every allowed event/operation pair; every mismatched pair; prove a `local`
classification cannot satisfy `pre-push`; same-process stage
reconstruction; missing/substituted policy; missing/duplicate/unexpected lane; lane stage,
control, trust, or write-scope mismatch; partial selected set; Plan V1/V2 substitution;
plan clone/reconstruction/proxy; nested mutation; post-compile manifest mutation; ambient
API access; plan-digest sensitivity; unavailable controls; required suites; and exact
child-set equality. Add cross-admission fixtures where OIDs match but manifest or
classification-evidence digests differ, a stage receipt from Manifest A is used with Plan
Manifest B, and same-shaped policy/lane rows are swapped. Remove, add, duplicate, and
substitute each of the nine `unavailableInputs` independently. Prove proxy/accessor throws
remain redacted, the exact Plan V1 digest stays stable, and no safe report-only V2 plan or
preflight can return `PASS`, executable authority, or `spawnAllowed:true`.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-execution-stage-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Project and bind exact policy/lane data**

Resolve rows only from the validated Manifest V2 snapshot and the genuine stage admission.
Require exactly one matching lane for every selected step, reject missing or extra rows,
include stage admission, policy, and lane in Plan V2 canonicalization, and register only
the final deeply frozen object. V1 and V2 plan parsers have independent exact top-level key
sets; V2 canonicalization covers every inherited and added field, while V1 canonical bytes
remain stable. Exact-key, set-order, semantic-order, and digest-sensitivity fixtures cover
both versions.

- [ ] **Step 4: Preserve runtime observation and enforcement gaps**

Plan V2 distinguishes static definitions from observed enforcement. Retain explicit gaps
for `working-directory-observation`, `environment-reconstruction-receipt`,
`executable-closure-receipt`, `timeout-enforcement-receipt`,
`output-budget-enforcement-receipt`, `taint-write-scope-enforcement-receipt`,
`precondition-receipt-producer`, `supervisor-process-lease-producer`, and
`terminal-result-producer`, plus current unavailable-control, suite, classification,
stage-authority, and report-only limitations. Static projection removes no runtime
assurance requirement.

- [ ] **Step 5: Verify GREEN and surrounding contracts**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-execution-stage-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-result.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git diff --check
```

Expected: all tests pass without retry. Preflight remains
`authorization:'report-only'`, `operation:'evidence-collection'`,
`outcome:'inconclusive'`, `exitCode:2`, and `spawnAllowed:false`.

- [ ] **Step 6: Independent review, staged admission, and commit**

Require the review receipt defined by the global protocol, resolve every blocking finding,
stage exactly the five named B files, capture and compare the global frozen workspace-set
receipt with the exact B admission through the pinned `ci:workspace` invocation, and run:

```bash
git diff --cached --name-status
git diff --cached --check
git diff --name-status
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:staged
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "feat(ci): bind execution policy to report-only plans" --format json
```

- [ ] **Step 7: Reverify the clean committed bead**

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <opaque-before-id> --after-handle <opaque-after-id> \
  --input - --format json
GIT_OPTIONAL_LOCKS=0 git status --short
GIT_OPTIONAL_LOCKS=0 git diff-tree --no-commit-id --name-status -r HEAD
GIT_OPTIONAL_LOCKS=0 git diff --check HEAD^ HEAD
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-execution-stage-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-result.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
bash scripts/run-with-pinned-npm.sh run guard:repo:commit-authors
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
```

Expected: clean worktree/index, exact B committed file set, unchanged frozen V1 digest,
and every focused/adjacent test passing from committed bytes. Revalidate HEAD and
`origin/main`; drift invalidates review.

#### CP-F4c2 and CP-F4c3 admission boundary

CP-F4c2 is not executable from this plan section. A later packet must name its own files,
writer, dedupe key, allowed writes, lineage lease, RED fixtures, safe neighbors, exact
timeouts, output capture limits, process-group teardown, terminal-attempt production,
result aggregation, verification, and rollback. It must prove the producer reconstructs
the declared environment, binds every executable-closure member, enforces the provisional
ceilings, owns and reaps the process group, persists append-only evidence, and never turns
static metadata into authorization.

That later packet must also contain a distinct native-evidence admission for every merged
command whose current CLI cannot support the common contract. In particular,
`guard:no-destructive-git` remains non-executable until exact staged/object scope, native
cause preservation, deterministic finding `BLOCK/1`, unavailable/tool failure
`INCONCLUSIVE/2`, bounded redaction-safe structural output, reviewed exception lookup,
and subprocess exit tests are proven. `guard:grant-resolver` retains its narrow declared
scope; `guard:launchd-drift` requires observed macOS capability and synthetic directories;
and `triage:required-suites` remains advisory even when supervised. An exit-code-only
wrapper or a generic `test failed` adapter cannot satisfy this admission.

CP-F4c2 extends and consumes CP-WA1's committed `supervised-command.ts`; it does not create
a second process supervisor, attempt lifecycle, or terminal-evidence join. Its separate
ownership is multi-control execution planning, exact selected-set execution/aggregation,
and command-policy enforcement across the remaining controls. It also consumes CP-TR1's
generic Vitest parser and native coverage receipt without creating another runtime-count
parser or coverage launcher. Any additional generic
process primitive must be added to the CP-WA1 owner with its existing boundary-run and
workspace regressions.

CP-F4c3 is also not executable from this section. It depends on Task 6 completing the sole
manifest-inventory reachability ownership cutover. Its later packet owns only package
facade and hook activation, old/new execution-result parity, exact current-head receipts,
and rollback to the prior facade/hook adapter. It does not re-own Task 6's manifest
inventory or exception cutover. Its parity matrix must preserve or explicitly replace,
without duplicate authority, the merged baseline at
`91f550ec133bae75c7059822759b4a2973f80c3e`: the unconditional
`guard:no-destructive-git` pre-commit invocation; the unconditional workflow invocations
of `guard:no-destructive-git` and `guard:grant-resolver`; the exact push/release ordering
of both guards; all four package aliases; the explicit
`tests/scripts/no-destructive-git-guard.test.ts` membership in `verify:push:branch`;
safeguard-diagnostics' required-chain rows and mutation tests; and the four public-surface
declarations. Parity asserts every preserved alias, chain member, and explicit test occurs
exactly once. `triage:required-suites` remains advisory, and
`guard:launchd-drift` remains host-only/planned unless a separate native-host packet
promotes it. Removal, duplication, scope broadening, or conversion of any legacy row to a
common PASS without exact native evidence fails the parity canary. Until both packets are
admitted, no new package facade, hook, workflow, status check, or advertised capability
is exposed.

---

### Task 6: CP-F5 — Manifest-driven self-protection with atomic ownership cutover

**Patch admission packet**

- Evidence: **Proven partial**. `safeguard-diagnostics.ts` and `guard-test-coverage-check.ts` enforce important structures but use hard-coded inventories and candidate-controlled execution.
- Reachable failure: a required manifest control can be absent while the old hard-coded list remains green, or an inline exemption can suppress the companion-test requirement.
- Unsafe fixture: remove a required manifest control, add `continue-on-error`, make a
  blocking job conditional, add an inline `meta-guard:no-test` exemption, or use an
  unregistered `# no-destructive-git:allow` bypass.
- Safe neighbor: an advisory control remains visible and cannot satisfy a blocking dependency; a reviewed narrow exception has owner and expiry.
- Expected: unsafe `BLOCK/1` for deterministic weakening and `INCONCLUSIVE/2` for invalid inventory/evidence; safe `PASS/0`.
- Smallest repair: dual-run old/new inventories until exact parity; atomically switch ownership only after parity tests.
- Rollback: restore the hard-coded inventory and prior exception behavior together; do not leave neither owner active.

Task 6 is the sole owner of manifest-inventory reachability and exception ownership
cutover. CP-F4c3 depends on this task and may activate facades/hooks only; it must not
perform another inventory cutover.

**Files:**

- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`
- Modify: `scripts/guard-test-coverage-check.ts`
- Modify: `tests/scripts/guard-test-coverage-check.test.ts`
- Modify: `scripts/no-destructive-git-guard.ts`
- Modify: `tests/scripts/no-destructive-git-guard.test.ts`
- Create: `controls/ci-control-exceptions.json`
- Create: `scripts/lib/ci-control/exceptions.ts`
- Create: `tests/scripts/ci-control-exceptions.test.ts`
- Modify: `controls/ci-control-manifest.json`
- Modify: `docs/public-surface.md`
- Modify: `docs/contributing/quality-guardrails-checklist.md`

- [ ] **Step 1: Write RED exact-union and inline-bypass tests**

Assert:

```text
union(manifest control registrations) == canonical required control inventory
union(adapter surface declarations) == manifest required surface catalog
```

Reject missing, duplicate, unreachable, inline-exempted, expired, wildcard, unowned, and
non-waivable exceptions. Add destructive-Git fixtures proving a deterministic finding is
`BLOCK/1`, an unreadable or unavailable root is `INCONCLUSIVE/2`, a raw matched command or
exception is never echoed, and an inline/preceding-line marker absent from the reviewed
registry cannot suppress the finding.

- [ ] **Step 2: Prove RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Add registry-backed exception validation**

Every exception binds control, surface/path scope, owner, approver role, sanitized
justification, compensating controls, evidence references, creation, expiry, and
reassessment trigger. Native semantic allowlists and console waivers remain their domain
owners and are registered rather than copied. Replace the destructive-Git guard's
free-form inline bypass lookup with a registry lookup keyed by a stable opaque exception
ID; neither the marker nor public output contains the reason or matched command text.

- [ ] **Step 4: Dual-run manifest and hard-coded inventories**

Report set differences as inconclusive. Do not remove `REQUIRED_SCRIPTS`, `CHAIN_REQUIREMENTS`, or specialized workflow AST checks until characterization tests prove exact parity for two consecutive local runs and the code review verifies the source diff.

- [ ] **Step 5: Cut over atomically**

After parity, derive orchestration reachability from the manifest while retaining
specialized AST validators. Remove inline `meta-guard:no-test` and free-form
`no-destructive-git:allow <reason>` semantics; migrate any legitimate exception to the
reviewed registry in the same commit.
Update `docs/public-surface.md` and
`docs/contributing/quality-guardrails-checklist.md` in that same atomic cutover so neither
public contract continues to advertise the removed inline opt-out.

- [ ] **Step 6: Verify GREEN and mutation protection**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run guard:safeguard-diagnostics
bash scripts/run-with-pinned-npm.sh run guard:guard-test-coverage
bash scripts/run-with-pinned-npm.sh run guard:no-destructive-git
bash scripts/run-with-pinned-npm.sh run guard:grant-resolver
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git diff --check
```

- [ ] **Step 7: Independent review, staged admission, and commit**

Require the global review receipt, resolve every blocking finding, stage exactly the twelve
named Task 6 files, capture and compare the global frozen workspace-set receipt with the
exact Task 6 admission through the pinned `ci:workspace` invocation, and run:

```bash
git diff --cached --name-status
git diff --cached --check
git diff --name-status
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:staged
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "feat(ci): protect the control inventory" --format json
```

- [ ] **Step 8: Reverify the clean committed cutover**

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <opaque-before-id> --after-handle <opaque-after-id> \
  --input - --format json
GIT_OPTIONAL_LOCKS=0 git status --short
GIT_OPTIONAL_LOCKS=0 git diff-tree --no-commit-id --name-status -r HEAD
GIT_OPTIONAL_LOCKS=0 git diff --check HEAD^ HEAD
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run guard:safeguard-diagnostics
bash scripts/run-with-pinned-npm.sh run guard:guard-test-coverage
bash scripts/run-with-pinned-npm.sh run guard:no-destructive-git
bash scripts/run-with-pinned-npm.sh run guard:grant-resolver
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
bash scripts/run-with-pinned-npm.sh run guard:repo:commit-authors
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
```

Expected: clean worktree/index, exact Task 6 committed file set, one and only one active
inventory authority, and old/new parity plus exception self-protection passing from the
committed bytes. Revalidate HEAD and `origin/main`; drift invalidates review.

---

### Task 6.5: CP-TR1 — Native Vitest coverage terminal-result receipt

CP-TR1 depends on committed CP-WA1 and is a narrow prerequisite for Task 7. It owns the
native Vitest/coverage result projection only. It does not create CP-F4c2's generic
multi-control runner, select controls, add a facade, wire a hook/workflow, or authorize a
merge/release boundary.

**Patch admission packet**

- Evidence: **Proven**. `scripts/run-coverage-check.sh` runs strip-types, Vitest coverage,
  and console thresholds, but emits no exact-OID machine receipt for selected/executed/
  passed/failed/skipped/todo counts. Task 7 therefore cannot distinguish a truly complete
  suite from a green run with hidden, skipped, truncated, or stale runtime evidence.
- Reachable failure: a later successful stage masks an earlier failure, aggregate totals
  disagree with assertion rows, skipped/todo tests remain hidden, or a prior JSON report
  is replayed for another OID.
- Unsafe fixture: green thresholds plus one skipped assertion or a one-byte mutated/replayed
  JSON report.
- Safe neighbor: exact current-OID selection whose strip-types, Vitest, and threshold
  stages are terminal; aggregate and assertion rows match; failures/skips/todos/
  collection errors/unhandled errors are zero.
- Expected: exact complete runtime `PASS/0`; deterministic test/threshold failure
  `BLOCK/1`; missing, malformed, stale, replayed, truncated, timed-out, crashed,
  nonterminal, count-mismatched, or live-child evidence `INCONCLUSIVE/2`.
- Smallest repair: extract one generic Vitest JSON/count parser from the boundary owner,
  add one coverage-specific supervised orchestrator, and keep the existing
  `coverage:check` alias and shell entrypoint as the sole package surface.
- Rollback: ordinary revert restores the prior coverage launcher while Task 7 remains
  visibly inconclusive; no other control may synthesize the missing receipt.

**Files:**

- Create: `scripts/lib/ci-control/vitest-result.ts`
- Create: `scripts/ci-control-coverage.ts`
- Create: `tests/scripts/ci-control-vitest-result.test.ts`
- Create: `tests/scripts/ci-control-coverage.test.ts`
- Modify: `scripts/lib/verification/boundary-run/attempts.ts`
- Modify: `tests/scripts/verify-boundary-run.test.ts`
- Modify: `scripts/run-coverage-check.sh`
- Modify: `tests/scripts/check-coverage-thresholds.test.ts`

`package.json` is intentionally unchanged: it retains exactly one `coverage:check` alias
pointing to `scripts/run-coverage-check.sh`. The shell stays strict and becomes only a thin
pinned adapter into the TypeScript owner; it contains no second count parser or outcome
logic. `docs/public-surface.md` also remains byte-identical because no package-facing name
or assurance claim changes; its drift guard is verification, not a conditional write path.

**Interfaces:**

```ts
export interface VitestSelectionReceiptV1 {
  schemaVersion: 1;
  candidateOid: string;
  configDigest: string;
  selectionArgvDigest: string;
  selectionPolicyDigest: string;
  rosterBytesDigest: string;
  identities: string[];
  selectionDigest: string;
  collectionAttemptId: string;
  collectionAttemptDigest: string;
  evidenceDigest: string;
}

export type CoverageStageName =
  | 'strip-types' | 'collect' | 'vitest' | 'coverage-threshold';
export type CoverageTerminalStageEvidenceV1<S extends CoverageStageName> = {
  state: 'terminal';
  stage: S;
  attemptId: string;
  attemptDigest: string;
};
export type CoverageNotRunStageEvidenceV1<
  S extends Exclude<CoverageStageName, 'strip-types'>,
> = {
  state: 'not-run';
  stage: S;
  causedByStage: 'strip-types' | 'collect' | 'vitest';
  reasonCode: 'execution.stage.not-run-after-failure';
  evidenceDigest: string;
};
export type CoverageStageEvidenceV1<S extends CoverageStageName> =
  S extends 'strip-types'
    ? CoverageTerminalStageEvidenceV1<S>
    : CoverageTerminalStageEvidenceV1<S> | CoverageNotRunStageEvidenceV1<S>;
export type CoverageStageSequenceV1 = readonly [
  CoverageStageEvidenceV1<'strip-types'>,
  CoverageStageEvidenceV1<'collect'>,
  CoverageStageEvidenceV1<'vitest'>,
  CoverageStageEvidenceV1<'coverage-threshold'>,
];

export interface VitestRunReceiptV1 {
  schemaVersion: 1;
  repositoryId: string;
  worktreeId: string;
  candidateOid: string;
  runArgvDigest: string;
  selectionPolicyDigest: string;
  cwdDigest: string;
  environmentDigest: string;
  toolDigest: string;
  configDigest: string;
  selectionDigest: string;
  selected: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  nativePending: number;
  collectionErrors: number;
  unhandledErrors: number;
  rawReportBytesDigest: string;
  selectionReceiptDigest: string;
  coverageSummaryDigest: string;
  runAttemptId: string;
  runAttemptDigest: string;
  evidenceDigest: string;
}

export interface CoverageThresholdReceiptV1 {
  schemaVersion: 1;
  coverageSummaryDigest: string;
  thresholdPolicyDigest: string;
  thresholdReportBytesDigest: string;
  thresholdAttemptId: string;
  thresholdAttemptDigest: string;
  evidenceDigest: string;
}

export interface CoverageObservationV1 {
  schemaVersion: 1;
  authorization: 'report-only';
  operation: 'foundation-coverage-evidence';
  result: ControlResultV1;
  resultBytesDigest: string;
  selectionReceipt: VitestSelectionReceiptV1 | null;
  runReceipt: VitestRunReceiptV1 | null;
  thresholdReceipt: CoverageThresholdReceiptV1 | null;
  stageEvidence: CoverageStageSequenceV1;
  preconditionReceiptDigest: string;
  evidenceDigest: string;
}

export interface CoverageExecutionEvidenceV1 {
  schemaVersion: 1;
  authorization: 'report-only';
  operation: 'foundation-coverage-execution';
  observation: CoverageObservationV1;
  observationBytesUtf8: string;
  observationBytesDigest: string;
  persistedStdoutDigest: string;
  terminalAttempt: TerminalAttemptV1;
  terminalAttemptDigest: string;
  evidenceDigest: string;
}

export interface CoverageExecutionValidationContextV1 {
  attemptStore: FileAttemptEvidenceStore;
  expectedOuterLease: SupervisorLeaseExpectationsV1;
  expectedStageLeases: Record<CoverageStageName, SupervisorLeaseExpectationsV1>;
  commandDigest: string;
  cwdDigest: string;
  environmentDigest: string;
  producerDigest: string;
  toolDigest: string;
  now: number;
}

export function parseVitestResult(
  bytes: Uint8Array,
  expectations: VitestResultExpectationsV1,
): VitestRunReceiptV1;

export function validateVitestRunReceipt(
  value: unknown,
  expectations: VitestRunReceiptExpectationsV1,
): VitestRunReceiptV1;

export function validateCoverageExecutionEvidence(
  value: unknown,
  context: CoverageExecutionValidationContextV1,
): CoverageExecutionEvidenceV1;
```

The selection digest covers the canonically sorted repository-relative file plus full
test-name identities, not totals. It comes from a separately supervised pinned
`vitest list --json` collection using the same exact candidate OID, config, environment,
and normalized closed no-filter selection policy as the later run. List and run have
distinct exact argv digests because their native subcommands differ; both receipts bind the
same `selectionPolicyDigest`, which covers every selection-affecting option while excluding
only the fixed `list` versus `run` operation token. The collection bytes and terminal attempt
produce `VitestSelectionReceiptV1`; its collection attempt ID and digest must equal the
ordered `collect` stage. The run attempt ID/digest and raw report must equal the ordered
`vitest` stage, and `CoverageThresholdReceiptV1` must bind the ordered threshold attempt
to the exact run coverage-summary digest and threshold-report bytes. The run must match that independently captured roster
exactly. A roster derived from run JSON, caller filters, mutable status, or claimed totals
is invalid. The parser exact-key validates bounded raw Vitest JSON
before traversal and requires `selected == passed + failed + skipped + todo`,
`executed == passed + failed`, `nativePending == skipped + todo`, report totals equal assertion rows, no duplicate assertion
identity, and no missing/extra expected identity. PASS additionally requires zero failed,
skipped, todo, collection-error, and unhandled-error rows plus terminal direct-status and
ended-process-group proof for strip-types, collection, Vitest, and threshold stages.

Extract only generic Vitest shape, identity, and count reconciliation from
`boundary-run/attempts.ts`; boundary marker/roster semantics remain there and delegate to
the new parser. The public `ci-control-coverage.ts run` command is the named outer
supervising parent. It invokes a private, non-public evaluator child and each exact native
stage through CP-WA1's
shared supervisor and attempt store, writes the JSON reporter output only to its confined
attempt directory, rereads/hash-validates exact bounded bytes, and emits one canonical
observation after joining the selection receipt and ordered stage evidence. The parent
persists and rereads the child's exact stdout and alone emits the outer execution evidence
after the coverage process is terminal. `validateCoverageExecutionEvidence()` reopens
those bytes, the outer attempt, and every terminal-stage attempt named by a terminal row
from the trusted store; a `not-run` row has no attempt and must never cause one to be
fabricated. The validator checks the
stored leases/producer/tool/command/environment bindings, and requires the outer attempt's
result-evidence binding to name the exact observation digest. It preserves the
current fail-fast sequence: a deterministic earlier failure records every later stage as
typed `not-run` caused by that failure, while a crash, timeout, missing terminal receipt,
or invalid precondition produces an inconclusive result. It never runs thresholds against
stale or failed test output merely to manufacture all-stage attempts.
`CoverageObservationV1` is the inner exact join from native receipts to the canonical
result/reason owner and owns the sole exactly-four-row ordered `stageEvidence` tuple. A
terminal successful `collect`, `vitest`, or `coverage-threshold` row requires its matching
non-null receipt; a `not-run` row requires that receipt and every downstream receipt to be
null. No upstream receipt may be reconstructed from later output. The run receipt does
not duplicate that array. The caller invokes the complete coverage command through the
CP-WA1 supervisor and, only after process close and ended-process-group proof, constructs
`CoverageExecutionEvidenceV1` from the exact captured and persisted observation bytes and the outer
terminal attempt. The child cannot include or predict its own outer attempt digest. PASS is
report-only Task 7 evidence; it never authorizes
transport, merge, release, or deployment. It neither accepts a caller-selected control
list nor exposes a generic command runner.

The CLI has one strict surface:
`run --pool forks --file-parallelism false --retry 0 --json`, plus `schema --json`
and `--help`. The shell adapter maps only the existing equivalent package arguments to
that closed form. Unknown/duplicate options, name/file/project/shard/changed filters,
arbitrary reporter/output paths, retry other than zero, or positional control/test lists
exit `2` with sanitized JSON. Spawned-process tests cover help/schema, exact stdout/stderr
budgets, direct exits `0/1/2`, and prove no native filter can underselect Task 7.

- [ ] **Step 1: Characterize the current native stages and prove RED**

Freeze the exact shell/package/Vitest/config/threshold identities. Add fixtures for zero
collection; list/run mismatch; omitted file/test; duplicate or one-byte-mutated roster;
selection-policy mismatch despite individually valid list/run argv; swapped list/run argv
digests; reordered/missing/duplicate stages; swapped or unresolvable stage attempts;
invalid collection/run/threshold joins; every fail-fast receipt-nullability branch;
missing/extra/duplicate assertion identities; skipped/todo/pending rows;
aggregate/assertion mismatch; malformed/truncated/oversized/multibyte-boundary JSON;
wrong OID/selection/config/tool; stale/replayed attempt; timeout/crash/live descendant;
threshold failure after green tests; explicit not-run stage rows after earlier deterministic
failure; later-success masking earlier failure; one-byte report/coverage mutation; strict
CLI option/help/schema/output behavior; duplicate/split stage evidence; outer receipt before
process close; missing/wrong outer attempt/store/lease; altered persisted stdout; and raw failure/private-value output. Preserve existing
boundary-specific roster behavior as the safe neighbor.

- [ ] **Step 2: Run RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-vitest-result.test.ts \
  tests/scripts/ci-control-coverage.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  tests/scripts/check-coverage-thresholds.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

- [ ] **Step 3: Implement the one parser and coverage orchestrator**

Reuse CP-WA1 supervisor/attempt storage and the active result/reason/precondition owners.
Keep private native report bytes separate from public sanitized results. Preserve the
primary nonzero stage status across cleanup, reject receipt publication while descendants
live, and never reconstruct digest bytes from parsed JSON. Update boundary-run to call the
generic parser without moving its domain-specific policy.

- [ ] **Step 4: Verify GREEN and native regressions**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-vitest-result.test.ts \
  tests/scripts/ci-control-coverage.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  tests/scripts/check-coverage-thresholds.test.ts \
  tests/scripts/ci-control-supervised-command.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-result.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
git diff --check
```

- [ ] **Step 5: Independent review, protected commit, and postcommit replay**

Stage only the admitted CP-TR1 paths, run staged repository/publication/hook guards, and
run:

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "feat(ci): bind coverage to terminal runtime evidence" --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-after-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <id-from-protected-before-handle-output> \
  --after-handle <id-from-protected-after-handle-output> \
  --input - --format json
```

The first postcommit process is the displayed workspace check and transition precedes
human-readable Git inspection. Then inspect the exact committed file set, rerun Step 4,
and run one complete `coverage:check` from the clean committed OID; validate its own
current-OID receipt rather than precommit output. Missing receipt keeps Task 7 blocked.

CP-F4c2 consumes this parser, supervisor, and native coverage receipt without duplicating
them. Its ownership remains multi-control exact-set selection, execution, and aggregation.

---

### Task 7: Admitted foundation-wave closeout, publication metadata, and next-plan admission

This task closes only the implemented F1/F2/F3/CP-TC1/WA1/CR-P0.1/F4c1/F5/CP-TR1 source beads. Active H1d
exact-ref cutover is not closed here, so this task cannot authorize a feature-branch push.
CP-F4c2's bounded
execution kernel, CP-F4c3's canonical facades/hook activation, protected workflow
evaluation, portability, artifacts, and deployment remain explicitly incomplete. Neither
this task nor a green regression bundle may advertise or authorize those capabilities.

**Files:**

- Modify: `docs/publication-audit.md`
- Modify: `docs/superpowers/plans/2026-07-20-cicd-enforcement-control-plane-program.md`
- Modify: `docs/superpowers/plans/2026-07-20-cicd-workflow-portability.md`
- Regenerate: `docs/work-index.json`
- Regenerate: `docs/work-index.md`

- [ ] **Step 0: Freeze entry lineage before consuming any prior evidence**

```bash
GIT_OPTIONAL_LOCKS=0 git rev-parse HEAD
GIT_OPTIONAL_LOCKS=0 git rev-parse origin/main
GIT_OPTIONAL_LOCKS=0 git rev-list --left-right --count origin/main...HEAD
GIT_OPTIONAL_LOCKS=0 git diff --name-status HEAD..origin/main
```

Before these local observations, consume a fresh coordinator-produced
`CoordinatorRemoteObservationV1` from an isolated observation clone when CP-GL1 exists.
During this pre-CP-GL1 local source closeout, the root coordinator instead supervises one
exact read-only `git ls-remote --exit-code --refs origin refs/heads/main` call through the
trusted Git/process owners and records its direct terminal bytes as explicitly provisional
observation; no worker runs `git fetch`. Record direct statuses and exact output bytes and require the local
remote-tracking OID either to equal the coordinator observation or to enter the drift/
integrator protocol. The provisional path can stop the commit but cannot authorize push,
merge, or selective evidence reuse. Bind HEAD, observed main, local `origin/main`, plan, manifest,
policy, toolchain, CP-WA1, CR-P0.1, CP-F4c1, CP-F5, and CP-TR1 receipt digests into the
Task 7 lineage lease. Any unexpected remote movement, overlapping incoming path, dirty
workspace set, or stale prerequisite review stops Step 1 until the delta is reconciled
through an ordinary reviewed Git operation.

- [ ] **Step 1: Run the complete focused foundation suite**

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-git-input.test.ts \
  tests/scripts/ci-control-workspace.test.ts \
  tests/scripts/ci-control-supervised-command.test.ts \
  tests/scripts/ci-control-workspace-commit.test.ts \
  tests/scripts/ci-change-record.test.ts \
  tests/scripts/ci-control-vitest-result.test.ts \
  tests/scripts/ci-control-coverage.test.ts \
  tests/scripts/check-coverage-thresholds.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-execution-stage-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  tests/scripts/test-integrity-ci.test.ts \
  tests/scripts/required-suites.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  tests/scripts/launchd-drift.test.ts \
  tests/scripts/repo-hygiene-guard.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-quality-receipt-validation.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:no-destructive-git
bash scripts/run-with-pinned-npm.sh run guard:grant-resolver
bash scripts/run-with-pinned-npm.sh run guard:safeguard-diagnostics
bash scripts/run-with-pinned-npm.sh run guard:guard-test-coverage
```

Expected: every listed test passes without retries or filters that mask mandatory work; both typechecks pass.

- [ ] **Step 1a: Revalidate and admit the existing workflow/portability plan and CP-GL1 ordering**

Rehash and re-review the already tracked
`docs/superpowers/plans/2026-07-20-cicd-workflow-portability.md`; do not recreate a second
plan. Refresh its current prerequisite/status and dependency statements, then update the
program dependency graph and ledger with the exact
`CP-WA1 + CP-F3 -> CP-GL1 -> CP-H1d -> CP-W1/workflow canaries` ordering and a separate
CP-GL1 admission-plan requirement. Add missing/extra/duplicate/role-swapped main/topic ref
set fixtures to that admission. These plan changes occur before metadata regeneration,
staging, the protected closeout commit, and the exact postcommit replay. Hosted settings,
`CODEOWNERS`, artifact publication, and deployment remain separate confirmation boundaries.

- [ ] **Step 2: Regenerate and verify repository metadata**

```bash
bash scripts/run-with-pinned-npm.sh run work-index:regen
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
git diff --check
```

- [ ] **Step 3: Run the existing branch gate and CP-F4c1 regression bundle**

```bash
bash scripts/run-with-pinned-npm.sh run verify:push:branch
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-execution-stage-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
```

Expected: every command exits zero. The branch gate's printed scope remains a subset
disclosure. The explicit test list is only the CP-F4c1 regression bundle; it does not
produce terminal-attempt evidence, exact observed-result-set aggregation, an execution
kernel, canonical facades, or CP-F4 completion. Required test-integrity closes only its
declared current gate. Do not claim full-suite, CP-F4, release, or deployment assurance
from this step.

- [ ] **Step 4: Run unfiltered full verification before completion claim**

```bash
bash scripts/run-with-pinned-npm.sh run coverage:check -- --pool=forks --fileParallelism=false
```

Expected: the complete suite and coverage thresholds pass. The coverage launcher must
also produce bounded machine-readable selected/executed/passed/failed/skipped/todo counts
bound to the exact OID and selection digest. Missing, truncated, malformed, skipped, todo,
or count-mismatched runtime evidence is `INCONCLUSIVE/2`; the static test-integrity gate
cannot substitute for it. CP-TR1 is a Task 7 prerequisite: a green coverage exit without
its validated terminal receipt blocks Task 7 rather than becoming partial completion.

- [ ] **Step 5: Validate agent/reviewer supply-chain receipts and all-channel redaction**

Require each worker/reviewer result to bind task and scope, read-only/mutation mode, sources, commands, changes, schema version, exact result digest, observed model/tool identity when available, confidence, risks, and lead-verification claims. Verify reviewer tool self-tests and source digest before use. Scan stdout, stderr, JSON, annotations, summaries, artifact names, reports, screenshots, coverage, source maps, archives, and scanner output with synthetic private values.

- [ ] **Step 6: Re-freeze upstream, review, and commit; stop at the remote-write boundary**

Task 7 entry first consumes and inspects a coordinator remote observation; Step 6 consumes
a fresh observation again. Neither step fetches from the linked worker worktree.
If either reconciliation changes HEAD, upstream, the merge result, plan, manifest, policy,
or a prerequisite receipt, restart Steps 1–5 and obtain a new exact-byte review before
staging. Then obtain
independent code review, stage only the named closeout files, capture and compare the global frozen
workspace-set receipt with the exact closeout admission through the pinned `ci:workspace`
invocation, and run:

```bash
git diff --cached --name-status
git diff --cached --check
git diff --name-status
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:staged
bash scripts/run-with-pinned-npm.sh run guard:publication:staged
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace-commit.ts \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --admission-fd <protected-admission-fd> \
  --before-handle-output-fd <protected-before-handle-output-fd> \
  --message "docs(ci): close admitted control foundation wave" --format json
```

Expected: the staged set equals the named closeout metadata files and the unstaged diff is
empty. The launcher performs the final claim and trusted hook-bound commit; no raw commit
path is permitted. The remote-write boundary stops here; no completion claim is allowed
until Step 7 passes. This task does not push or merge: a later packet requires
completed H1d, a current owner request that authorizes the exact branch action, SSH
transport, the exact scanned OID, and terminal `ci:remote-readback`. Do not change hosted
required checks in this task.

- [ ] **Step 7: Reverify the clean foundation closeout commit**

The first postcommit process captures a fresh `ci:workspace check` receipt for the clean
state and claims the single allowed HEAD/index transition from the staged closeout
receipt. The precommit receipt cannot be reused as current-workspace evidence. Feed the
strict empty-worktree admission on stdin, complete transition, and only then run human-
readable Git observations and guards:

```bash
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts check \
  --trusted-evidence-root <operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --handle-output-fd <protected-handle-fd> --claim-mode validate-unclaimed \
  --input - --format json
bash scripts/run-with-pinned-node.sh scripts/ci-control-workspace.ts transition \
  --trusted-evidence-root <same-operator-confined-root> \
  --registry-expectation-fd <protected-registry-fd> \
  --writer-lease-fd <protected-writer-lease-fd> \
  --before-handle <opaque-before-id> --after-handle <opaque-after-id> \
  --input - --format json
GIT_OPTIONAL_LOCKS=0 git status --short
GIT_OPTIONAL_LOCKS=0 git diff-tree --no-commit-id --name-status -r HEAD
GIT_OPTIONAL_LOCKS=0 git diff --check HEAD^ HEAD
bash scripts/run-with-pinned-npm.sh run guard:work-index
bash scripts/run-with-pinned-npm.sh run guard:publication:all
bash scripts/run-with-pinned-npm.sh run guard:doc-drift
bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
bash scripts/run-with-pinned-npm.sh run guard:doc-tally
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh run guard:repo:branch-diff
bash scripts/run-with-pinned-npm.sh run guard:repo:commit-authors
bash scripts/run-with-pinned-npm.sh run guard:hooks-installed
```

Then rerun the exact immutable Step 1, Step 3, and Step 4 commands from the clean committed
HEAD, capturing each direct exit status and terminal evidence:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-reasons.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-git-input.test.ts \
  tests/scripts/ci-control-workspace.test.ts \
  tests/scripts/ci-control-supervised-command.test.ts \
  tests/scripts/ci-control-workspace-commit.test.ts \
  tests/scripts/ci-change-record.test.ts \
  tests/scripts/ci-control-vitest-result.test.ts \
  tests/scripts/ci-control-coverage.test.ts \
  tests/scripts/check-coverage-thresholds.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-execution-stage-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/ci-control-exceptions.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/scripts/guard-test-coverage-check.test.ts \
  tests/scripts/test-integrity-ci.test.ts \
  tests/scripts/required-suites.test.ts \
  tests/scripts/no-destructive-git-guard.test.ts \
  tests/scripts/grant-resolver-inventory-guard.test.ts \
  tests/scripts/launchd-drift.test.ts \
  tests/scripts/repo-hygiene-guard.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/semantic-quality-check.test.ts \
  tests/scripts/semantic-quality-receipt-validation.test.ts \
  tests/scripts/verify-boundary-run.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:no-destructive-git
bash scripts/run-with-pinned-npm.sh run guard:grant-resolver
bash scripts/run-with-pinned-npm.sh run guard:safeguard-diagnostics
bash scripts/run-with-pinned-npm.sh run guard:guard-test-coverage
bash scripts/run-with-pinned-npm.sh run verify:push:branch
bash scripts/run-with-pinned-npm.sh run guard:test-integrity:required
bash scripts/run-with-pinned-npm.sh test -- \
  tests/scripts/ci-control-manifest.test.ts \
  tests/scripts/ci-control-result.test.ts \
  tests/scripts/ci-control-attempt.test.ts \
  tests/scripts/ci-control-classifier.test.ts \
  tests/scripts/ci-control-classification-admission.test.ts \
  tests/scripts/ci-control-pre-push-canary.test.ts \
  tests/scripts/ci-control-ref-policy.test.ts \
  tests/scripts/ci-control-execution-stage-admission.test.ts \
  tests/scripts/ci-control-execution-plan.test.ts \
  tests/scripts/hooks-installed-guard.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  --pool=forks --fileParallelism=false --retry=0
bash scripts/run-with-pinned-npm.sh run coverage:check -- --pool=forks --fileParallelism=false
```

Do not reuse the precommit suite or coverage result: the closeout commit changed HEAD and
invalidated it.

Expected: clean worktree/index, exact closeout metadata file set, every post-commit guard,
the complete focused foundation suite, the CP-F4c1 regression bundle, and unfiltered full
coverage plus its CP-TR1 terminal receipt all pass from committed bytes. Revalidate HEAD and `origin/main`; any drift
invalidates the closeout receipt. This is completion evidence only for the implemented
source beads named above; CP-F4c2/c3 and later trust layers remain incomplete.
