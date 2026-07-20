# CI/CD Enforcement Control Plane Design

**Date:** 2026-07-20

**Status:** Approved architecture; written specification pending owner review

**Audited control source base:** `6fd773aee4832dd9b496fb696a8a789bb33660c1`

**Safety boundary:** This document authorizes specification and planning only. It does
not authorize a live deployment, credential change, deletion or rewriting of public
history, repository-rules change, or artifact promotion. Those mutations remain
separate, evidence-backed execution steps.

## 1. Decision

WhatSoup will use one version-controlled CI/CD control plane to coordinate the existing
privacy, publication, semantic-quality, repository-hygiene, test-integrity, portability,
build, deployment, and runtime controls. The control plane is an inventory and decision
layer; it does not duplicate their policy engines.

Every authoritative decision is bound to exact Git object identities and has one of
three meanings:

- `PASS` / exit `0`: every applicable requirement completed for the exact revision.
- `BLOCK` / exit `1`: a deterministic, actionable violation or failed required test
  exists.
- `INCONCLUSIVE` / exit `2`: required assurance is missing, stale, unavailable,
  malformed, cancelled, timed out, or cannot be trusted.

`INCONCLUSIVE` is never converted to a warning or pass at a merge, release, publication,
or deployment boundary. Advisory findings remain separately visible and cannot be used
as passing evidence.

The operating model is:

```text
worktree
  -> local canonical command
  -> pre-commit / commit-msg / pre-push adapter
  -> unprivileged pull-request validation
  -> protected data-only policy evaluation
  -> portability-gate
  -> policy-gate
  -> merge-group validation
  -> trusted target-specific build
  -> immutable artifact + SBOM + provenance + attestation
  -> protected deployment admission
  -> canary + health verification
  -> exact-digest promotion or receipt-bound rollback
  -> scheduled re-verification and runtime drift detection
```

## 2. Goals

The control plane must:

1. inventory every enforcement control, adapter, owner, stage, trust boundary, mode,
   severity, remediation contract, and exception policy;
2. use the same canonical implementations from local hooks and remote automation;
3. select the smallest trustworthy check set for the change's impact and risk without
   allowing uncertainty to reduce coverage;
4. make Linux and macOS portability an authoritative, required decision where applicable;
5. give operating agents specific, safe, machine-readable reasons and repair steps;
6. prevent candidate changes from silently weakening the checks that authorize them;
7. build official artifacts from the exact reviewed Git object, then promote the same
   immutable digest rather than rebuilding per environment;
8. preserve proof of source, builder, policy, artifact, approval, deployment, readback,
   and rollback;
9. continuously use later failures to improve risk classification and test selection;
10. migrate prospectively without destructive history edits or automatic mutation of
    existing public metadata.

## 3. Non-goals

- Replacing the canonical publication detector with another denylist or scanner.
- Making every advisory or experimental rule immediately blocking.
- Claiming that a client-side hook is an authoritative publication boundary.
- Requiring every expensive suite on every low-risk documentation change.
- Treating structural platform simulation as a substitute for native OS execution.
- Treating a source archive, cache, or locally rebuilt directory as a verified release
  artifact.
- Selecting a cloud, container registry, production host, or GitHub team in this design.
- Rewriting commits, deleting public refs, force-pushing, renaming published branches,
  editing existing public metadata, or automatically modifying an operator's worktree.
- Weakening an existing control, coverage threshold, required check, test-integrity
  requirement, or historical baseline to make adoption easier.

## 4. Evidence Discipline and Patch Admission

Every audit record and implementation claim is labeled:

- **Proven:** directly demonstrated by source, configuration, a hosted-settings receipt,
  or a reproducible test with valid preconditions.
- **Inconclusive:** dependent on unavailable/invalid evidence, hosted state not read back,
  an unsupported runtime, contaminated worktree, failed setup, or an incomplete result.
- **Proposed:** a design improvement not yet justified by a demonstrated reachable path.

Inference may guide a probe but may not authorize a patch. An invalid fixture or invalid
test environment is evidence about the test setup, not the product. Masked, stale,
progress-only, partial, or malformed evidence is inconclusive.

Unless a statement is explicitly labeled **Proven** or **Inconclusive**, Sections 6–23
describe the approved **Proposed** architecture. Each proposal must be relabeled through
its patch admission packet before implementation or blocking promotion.

Before each independently reviewable implementation bead, the plan must create a patch
admission packet containing:

```text
packet ID
evidence label: Proven | Inconclusive | Proposed
exact control, file, structural location, and revision
reachable bypass or failure path
synthetic unsafe fixture
adjacent safe-neighbor fixture
expected PASS | BLOCK | INCONCLUSIVE and exit 0 | 1 | 2
smallest authoritative remediation
controls and safe behavior that must remain unchanged
focused RED and regression commands
rollback/revert strategy
```

Only a `Proven` failure path may enter a blocking implementation bead. `Inconclusive`
items receive better evidence; `Proposed` items enter report-only evaluation or remain
design backlog. One owner and one dedupe key govern each packet.

Implementation follows: add the failing boundary test, prove the safe neighbor, patch one
canonical ownership point, run focused verification, run the surrounding regression
suite, obtain independent source-line review, and expand only when new evidence requires
it. Workflow security, portability, artifact identity, and deployment mutation remain
separate reviewable beads even when described by one architecture.

One owner confirmation covers the approved implementation batch. Reconfirmation is
required only when work crosses a new trust boundary, external mutation, credential use,
production deployment, hosted repository-settings change, or materially broader scope.

## 5. Observed Current State

The following are **Proven** from the audited source base:

- `repo-hygiene-guard.ts` owns repository identity and hygiene policy.
- `publication-guard.ts` owns public-surface privacy policy and exact private-registry
  integration.
- `semantic-quality-check.ts` owns semantic policy and receipt production.
- `safeguard-diagnostics.ts` structurally inspects selected workflow and safeguard wiring.
- `guard-test-coverage-check.ts` enforces companion test coverage for guard code.
- `verify:push:branch`, `verify:release`, and `verify:publish` already compose many checks
  through pinned runtime wrappers.
- `.husky` contains pre-commit, commit-message, and pre-push adapters.
- the BOT ERRORS deployment path provides a strong precedent for confined preflight,
  immutable bundles, atomic switching, receipts, readback, and rollback.
- release-snapshot planning and drift checks provide useful inventory primitives.
- no canonical control manifest, authoritative risk classifier, `verify:fast`,
  `verify:pr`, `verify:deploy`, stable `portability-gate`, or stable `policy-gate` exists;
- workflows do not handle `merge_group`;
- full validation runs on Linux, while native macOS CI covers only one narrow behavior;
- no structural invariant prevents removal or narrowing of the macOS lane;
- action references use mutable major-version tags rather than reviewed full SHAs;
- a pull-request job can execute candidate lifecycle code before later receiving private
  assurance material;
- uploaded failure artifacts do not have a proven scan-before-upload boundary;
- no repository `CODEOWNERS` file protects enforcement, build, or deployment surfaces;
- hook installation and revision identity are not verified in fresh clones/worktrees;
- source verification does not create and promote an attested immutable application
  artifact;
- snapshot planning can read ambient worktree bytes while naming another Git commit;
- application startup treats missing or malformed release identity as a warning;
- no application SBOM, provenance, artifact attestation, authoritative runtime artifact
  digest, or complete scheduled assurance workflow exists.

The following remain **Inconclusive** until a fresh read-only hosted-state receipt is
captured: current required-check App binding, merge-queue enablement, ruleset precedence,
organization-required workflows, action policy, environment protections, bypass actors,
fork approvals, and runner-group isolation. Existing hosted protections remain in place
until the new aggregate gate is proven on real revisions and explicitly enabled.

An earlier recovery lane contains unverified work that may have bypassed hooks. It is
preserved as evidence, but it is not promoted. This design is reconstructed from the
clean audited base through ordinary commits.

## 6. One Control Model

### 6.1 Canonical manifest

A single strict, reviewed, hand-authored manifest, `controls/ci-control-manifest.json`,
is the source of truth for control metadata and orchestration. A TypeScript schema and
validator own its wire contract. Generated coverage and ownership reports are derived
evidence, not an alternative authority. Workflow YAML, hooks, package scripts,
documentation, and adapters refer to control IDs; they do not redefine policy metadata.

The top-level `ControlManifestV1` contains:

```text
schemaVersion
policyVersion
controls[]
requiredSurfaces[]
riskRules[]
stages[]
trustClasses[]
canonicalCommands{}
resultSchema
exceptionSchema
```

Each control record contains exactly:

```text
id                    stable dotted identifier
domain                closed control-domain value
owner                 accountable role identifier
implementation        canonical executable and adapter contract
stages[]              closed execution stages
trustClass            input/executor/credential trust relation
mode                   assist|warn|block|quarantine|human-authorization|
                       automatic-remediation|detect-respond
severity              closed severity and promotion threshold
riskTiers[]            tiers for which the control is applicable
surfaces[]             owned input/publication surfaces
dependencies[]         prerequisite control IDs
evidence               expected schema, paths, digest, and freshness
failurePolicy          finding/crash/timeout/missing/skipped/cancelled/stale
remediation            safe explanation, ordered repair, reproduction command
exceptionPolicy        allowed scope, approver role, maximum lifetime
```

Unknown fields, duplicate control IDs, duplicate
`(policyCategory, surface, decisionOwner)` ownership keys, cycles, unreachable controls,
missing owners, missing remediation, unbounded exceptions, or unsupported enum values
return `INCONCLUSIVE` and prevent an authoritative aggregate pass. Multiple controls may
observe the same physical surface; only conflicting canonical decision ownership is
invalid.

The initial closed domains are:

```text
repository-hygiene privacy-publication source-integrity workflow-security
test-integrity functional-correctness semantic-quality portability
dependency-governance artifact-integrity supply-chain deployment-safety
runtime-assurance documentation operability
```

A rule remains owned by its existing canonical detector. The manifest records how that
detector is invoked and interpreted. A new surface normally receives a thin adapter into
an existing detector, not copied rules, duplicated serializers, another artifact identity
model, another exception system, or a second aggregate-gate implementation.

### 6.2 Trust classes

- `untrusted-candidate`: fork or same-repository candidate content and metadata;
- `reviewed-source`: source accepted by repository policy;
- `protected-policy`: validator/workflow material loaded independently of the candidate;
- `trusted-build`: isolated build of an exact accepted Git object;
- `verified-artifact`: immutable artifact whose digest and evidence passed policy;
- `authorized-release`: verified artifact approved for a named environment role;
- `observed-deployment`: running exact digest with completed health/readback evidence.

No transition is inferred. Each consumes the previous state's immutable receipt and
produces a new receipt. A cache, job name, tag, branch, signature alone, or successful
transport does not change trust class.

## 7. Exact Revision and Risk Classification

The authoritative classifier accepts only normalized trusted inputs: event type; trusted
base OID; candidate OID; tested merge OID where applicable; exact changed path/mode/type,
rename and submodule set from Git objects; dependency/package graph digest; control
manifest digest; and classifier implementation digest.

It must not derive authoritative input from an ambient dirty worktree, shallow fallback,
PR title, branch prose, unverified archive, or candidate-produced classification file.
Pull requests record base, candidate, and tested merge OIDs. `merge_group` records its
exact proposed-merge OID. Push/tag events record the pushed OID and trusted predecessor
relation.

If a required OID, merge base, tree, graph, decoder, or policy digest is unavailable,
the executor selects the broadest `system-wide` work set so uncertainty never reduces
coverage. The final classifier decision remains `INCONCLUSIVE`; running more checks
cannot invent a trusted classification receipt.

Risk tiers are:

- `low`: documentation, comments, examples, and non-executable metadata with no
  generated, workflow, release, public-identity, or dependency effect;
- `standard`: isolated application/library code with a closed affected-component set;
- `elevated`: shared interfaces, dependencies, authentication/authorization, native
  integration, workflow, hooks, build logic, deployment, infrastructure, database
  migration, public metadata, privacy policy, or release configuration;
- `system-wide`: foundational/shared runtime, control-plane and policy sources, uncertain
  graph impact, unrecognized executable paths, or incomplete classification.

Classification uses closed path and semantic reason IDs. It never accepts a caller's
self-selected lower tier. Generated files inherit the maximum risk of their generator,
inputs, and publication surface. Low risk never skips always-on publication, privacy,
source-identity, workflow-policy, classifier, or aggregate-gate controls.

The coverage ladder is:

```text
local verify:fast -> PR affected/risk coverage -> merge-group integration
  -> default-branch backstop -> release artifact assurance
  -> scheduled broad/exploratory coverage -> runtime canary and drift
```

## 8. Canonical Commands and Local Adapters

The repository exposes these orchestration facades:

```text
verify:fast
verify:pr
verify:portability
verify:release
verify:deploy
```

- `verify:fast` runs pinned-runtime formatting/syntax, staged hygiene/publication,
  secret/privacy detection, focused type/lint checks, and fast affected tests.
- `verify:pr` consumes or creates a local exact-revision classification receipt and runs
  the PR-equivalent required controls for that tier.
- `verify:portability` runs the canonical supported-host suite and emits one result per
  OS/architecture tuple.
- `verify:release` verifies clean exact-source export, builds each declared target
  artifact once, scans actual bytes, and produces candidate release evidence.
- `verify:deploy` admits an immutable artifact for a target environment, defaults to
  dry-run, and never combines approval with mutation.

Existing lower-level scripts remain callable for focused reproduction. Hooks and CI call
these facades or the same closed lower-level control IDs; neither maintains a weaker
approximation.

Hook behavior is fast and non-destructive:

- pre-commit scans staged bytes and paths, preserving partial staging;
- commit-message scans the exact message file and trailers before commit creation;
- pre-push scans every outgoing commit/ref/tag and invokes the appropriate canonical
  command;
- `guard:hooks-installed` verifies that the active hook path and bytes are from the
  checked-out revision rather than an absolute foreign worktree;
- hook bypass remains possible by Git design, so every authoritative rule has a remote
  equivalent.

Delete-only ref updates, force-push ambiguity, missing outgoing range, or head movement
after scan are not silent exceptions. They receive exact `BLOCK` or `INCONCLUSIVE`
decisions under the ref policy.

## 9. Pull-Request and Merge Enforcement

### 9.1 Untrusted validation

Ordinary `pull_request` jobs:

- use read-only contents permission and no valuable secrets;
- run candidate source only inside the untrusted validation trust class;
- never receive a private registry, deploy key, signing identity, publication token,
  cloud identity, or production network access;
- treat event metadata as bounded data, never interpolate it into shell source;
- use explicit timeouts, constrained concurrency, and trust-partitioned caches;
- scan the exact report/archive directory before artifact upload;
- emit receipts bound to the exact candidate and tested merge OIDs.

Fork and same-repository pull requests receive the same untrusted-code treatment. Secret
availability is not a trust signal.

### 9.2 Protected data-only evaluation

Candidate changes to detectors, workflows, package scripts, policy, or test selection
cannot authorize themselves. An independently sourced protected evaluator reads the
candidate's Git objects and event fields as data without executing candidate code. It
validates:

- control-manifest/schema digests;
- required triggers, permissions, timeouts, and concurrency;
- full 40-hex action and reusable-workflow pins;
- metadata-to-command data flow;
- trust-specific cache keys and artifact flow;
- scan-before-upload ordering;
- stable gate definitions and complete `needs` coverage;
- Linux/macOS portability coverage;
- classifier and required-suite invariants;
- absence of `continue-on-error`, `|| true`, ignored exits, hidden filters, ignore paths,
  skip variables, or unexpected conditions on mandatory work.

The protected evaluator must be supplied through an independently sourced organization-
or enterprise-required workflow, or through a separately operated App that validates a
protected policy/workflow digest before evaluating candidate data. Binding its check to
the expected App/integration is an additional producer-authentication control, never a
substitute for protected policy provenance. The evaluator must not use a privileged
trigger to check out or execute candidate code, and it must not trust an unverified
candidate artifact.

### 9.3 Stable gates

`portability-gate` and `policy-gate` are always-created jobs with stable names and
`if: always()`. They cannot use `continue-on-error`.

Every potentially inapplicable lane is still created. It emits a validated
`not-applicable` result tied to the classifier receipt instead of relying on generic
skipped-success behavior.

`portability-gate` statically depends on the classifier and all supported-host lanes. It
requires exactly the lanes selected by the manifest and classifier:

- deterministic required-lane failure -> `BLOCK`;
- missing, cancelled, stale, timed-out, malformed, or unexpectedly skipped lane ->
  `INCONCLUSIVE`;
- intentional non-applicability -> accepted only when the trusted classification receipt
  names the closed reason and the lane emits matching evidence.

`policy-gate` statically depends on classifier, always-on policy, selected validation,
compatibility, artifact-publication checks when applicable, and `portability-gate`. It
cross-checks exact OIDs, policy/classifier digests, required check IDs, applicability,
and terminal statuses. It fails when any required result is missing, cancelled,
unexpectedly skipped, stale, masked, or unsuccessful.

Once proven and explicitly configured, `policy-gate` becomes the stable repository
required check and is bound to the expected GitHub App/integration as well as the
protected policy/workflow digest. Existing required checks remain until the new gate has
passed real PR and merge-group canaries. Workflows providing required results handle both
`pull_request` and `merge_group`.

### 9.4 Repository governance

The implementation adds reviewed `CODEOWNERS` coverage for:

```text
.github/workflows/**
.github/actions/**
.husky/**
controls/**
scripts that classify, guard, build, publish, deploy, or verify
dependency manifests and lockfiles
Docker and packaging definitions
deployment and service definitions
security/privacy policy
CODEOWNERS itself
```

Actual public owner handles are resolved and verified during implementation. Placeholder
or nonexistent owners are invalid.

The desired hosted policy requires pull requests, an approving review, code-owner review
for owned paths, dismissal of stale approvals, resolved conversations, current-head
checks, deletion/force-push protection, restricted bypass, protected release tags, and
merge-result validation. A settings verifier compares live configuration with declared
policy and returns `INCONCLUSIVE` when it cannot read it.

## 10. Linux and macOS Portability

Portability is a first-class authoritative domain.

Linux x64 remains the standard full-validation environment. macOS arm64 is a native
supported-host lane, not a structural simulation. The initial native suite includes:

- shell wrappers and pinned executable discovery;
- path, filename, case, symlink, mode, temporary-directory, socket, and lock behavior;
- process groups, signals, watchdogs, cancellation, and atomic result visibility;
- service-manager adapters and systemd/launchd rendering;
- native plist validation on macOS;
- credential/keyring adapters without reading real credentials;
- deployment preflight and rollback state machines;
- release/publication serialization and redaction;
- native dependency install/load smoke tests;
- workflow/cache key portability and Git behavior relied on by merge/snapshot controls.

Each lane executes only in hermetic temporary roots with synthetic credentials and fake
service/deployment adapters. Native portability validation may parse or query isolated
test state but may not read a real keyring, install/load a real service, select a live
release, deploy, restart, or mutate the host. Its receipt records the observed OS,
architecture, runtime, filesystem capabilities, and relevant executable versions rather
than trusting a runner label.

Portability-sensitive paths automatically require both Linux x64 and macOS arm64 on pull
requests. Executable merge-group and release changes require both. A truly low-risk
documentation-only change may emit a native-lane `not-applicable` receipt, but only after
always-on path, publication, metadata, and classifier checks prove the scope. Default
branch and scheduled workflows run broader cross-platform coverage to catch classifier
mistakes.

WhatSoup has native dependencies and OS-specific service bundles. Therefore "build once,
promote many" applies per target tuple:

```text
source OID + lock digest + toolchain + os + architecture + build configuration
  -> one immutable target artifact digest
  -> promote that same digest through every environment accepting that tuple
```

The system never presents a Linux artifact as a macOS artifact, rebuilds the same target
for staging and production, or treats a local Compose cache as a release artifact.

## 11. Result and Error Contract

### 11.1 Machine result

Every control-plane adapter and aggregate gate emits the same bounded envelope. Existing
detectors retain ownership of their native receipt schemas and serializers; an adapter
imports a native result only by exact detector ID, schema version, and evidence digest,
then translates its disposition without recomputing the policy decision.

```json
{
  "schemaVersion": 1,
  "decision": "inconclusive",
  "exitCode": 2,
  "code": "ci.required-check.missing",
  "controlId": "policy-gate",
  "stage": "pull-request",
  "eventName": "pull_request",
  "surface": "ci.required-check",
  "applicability": "required",
  "applicabilityReason": null,
  "candidateOid": "0123456789abcdef0123456789abcdef01234567",
  "baseOid": "89abcdef89abcdef89abcdef89abcdef89abcdef",
  "mergeOid": "fedcba98fedcba98fedcba98fedcba98fedcba98",
  "manifestDigest": "sha256:...",
  "policyDigest": "sha256:...",
  "classifierDigest": "sha256:...",
  "producer": {
    "appId": "expected-app",
    "workflowRef": "owner/repository/.github/workflows/policy.yml@refs/heads/main",
    "workflowSha": "abcdef01abcdef01abcdef01abcdef01abcdef01",
    "runId": "bounded-run-id",
    "attempt": 1
  },
  "tool": {
    "name": "ci-control-plane",
    "version": "schema-bound-version",
    "digest": "sha256:..."
  },
  "platform": {
    "os": "linux",
    "architecture": "x64",
    "runtime": "node@pinned-version"
  },
  "risk": {
    "tier": "elevated",
    "reasons": ["closed-reason-id"]
  },
  "requiredChecks": ["portability.native-macos"],
  "observedChecks": [
    {
      "id": "portability.native-macos",
      "applicability": "required",
      "decision": "inconclusive",
      "conclusion": "missing",
      "causeCode": "ci.portability.required-host-missing",
      "expectedPlatform": {
        "os": "macos",
        "architecture": "arm64"
      },
      "observedPlatform": null,
      "producer": null,
      "tool": null,
      "candidateOid": "0123456789abcdef0123456789abcdef01234567",
      "mergeOid": "fedcba98fedcba98fedcba98fedcba98fedcba98",
      "policyDigest": "sha256:...",
      "nativeSchemaVersion": null,
      "evidenceDigest": null,
      "createdAt": null,
      "validUntil": null
    }
  ],
  "findingId": "opaque:random-or-private-keyed-id",
  "location": {
    "kind": "closed-location-kind",
    "name": "sanitized-location"
  },
  "why": "Specific sanitized reason.",
  "guidance": ["Concrete ordered repair step."],
  "reproduce": {
    "command": "canonical repository command"
  },
  "retryable": false,
  "limitations": [],
  "evidenceDigest": "sha256:...",
  "createdAt": "2026-07-20T00:00:00Z",
  "validUntil": "2026-07-20T01:00:00Z"
}
```

The envelope's canonical serialization, byte budgeting, hashing, CLI output, file
output, annotations, and job summaries share one control-plane serializer. Unknown keys,
unrecognized producer/policy identities, invalid freshness, and invalid decision/exit
pairs are rejected.

OID fields contain a valid 40-hex object ID or JSON `null`; string sentinels are forbidden.
Null is permitted only when the event schema declares that relation inapplicable and
`applicabilityReason` carries a closed reason. `requiredChecks` and `observedChecks` have
exact set equality at aggregation. Each observed result binds its native cause code,
schema/version, evidence digest, revision, policy, producer, and platform where relevant.
For a missing result, expected platform is present and observed producer/tool/platform,
native schema, evidence digest, and timestamps are null. Any terminal non-missing result
requires all of those fields and must match the protected manifest; null cannot satisfy a
required check.

Decision-dependent fields are exact: `pass/0` requires `findingId`, `location`, and `why`
to be `null` and `guidance` to be empty; `block/1` and `inconclusive/2` require an opaque
finding ID, sanitized location, specific reason, and non-empty ordered guidance. Every
result has bounded UTC creation/freshness timestamps. A stale result cannot pass even if
its recorded decision was pass.

### 11.2 Error taxonomy

Codes are stable, categorical, and specific:

| Family | Example code | Decision | Required response |
|---|---|---|---|
| input | `ci.input.revision-unavailable` | Inconclusive | resolve the trusted revision; do not reduce coverage |
| classification | `ci.classification.unknown-path` | Inconclusive | add a reviewed risk rule; run system-wide coverage |
| requirement | `ci.required-check.missing` | Inconclusive | produce the exact-revision result and rerun the gate |
| execution | `ci.required-check.portability-native-suite.failed` | Block | preserve the native cause code; run its canonical reproduction |
| workflow | `ci.workflow.mutable-action-ref` | Block | use a reviewed full SHA and update provenance |
| trust | `ci.workflow.credential-after-candidate-code` | Block | move assurance to a protected data-only job |
| portability | `ci.portability.required-host-missing` | Inconclusive | run the named host lane for the exact OID |
| privacy | `privacy.local-host-label` | Block | preserve the detector's granular code; never repeat the match |
| artifact | `release.source.revision-mismatch` | Inconclusive | rebuild from an exact Git-object export |
| artifact | `release.artifact.digest-mismatch` | Block | quarantine and create a new immutable artifact |
| provenance | `release.attestation.unavailable` | Inconclusive | restore the trusted verifier; do not promote |
| provenance | `release.attestation.unauthorized-producer` | Block | rebuild with an authorized source/workflow/builder |
| deployment | `deployment.approval.missing` | Inconclusive | approve the exact environment and digest |
| deployment | `deployment.target.policy-prohibited` | Block | select an allowed target or change policy through review |
| deployment | `deployment.canary.health-failed` | Block | stop promotion and use receipt-bound rollback |
| rollback | `deployment.rollback.partial` | Inconclusive | quarantine and perform controlled recovery |
| runtime | `runtime.release-drift` | Block | preserve evidence; choose reviewed recut or rollback |
| runtime | `runtime.drift-check.unavailable` | Inconclusive | restore inspection; do not infer clean state |
| policy | `ci.exception.expired` | Block | repair or approve a new narrow time-bound exception |

Each non-pass result answers, without ambiguity:

1. what control made the decision;
2. which exact revision, stage, and safe surface were evaluated;
3. whether it is a violation or missing assurance;
4. why the requirement exists in task-relevant language;
5. the ordered minimal repair;
6. the canonical reproduction command;
7. whether retry without a change is appropriate;
8. which evidence was unavailable or rejected;
9. what was intentionally not displayed for privacy or security.

Messages such as `failed`, `invalid`, `something went wrong`, `check logs`, or an exit
code without a stable category are schema failures. Stack traces may be retained in a
private diagnostic artifact, but never replace the structured public result.

### 11.3 Public-output safety

Public output never contains a matched private value, source excerpt, private absolute
path, environment dump, credential, registry content, reversible encoding, or raw hash
of a low-entropy identifier. Finding IDs are random opaque values or private keyed IDs.
The detector scans its own stdout, stderr, JSON, annotation, summary, artifact names, and
artifact bytes before publication.

A representative human result is:

```text
INCONCLUSIVE ci.portability.required-host-missing

Gate: portability-gate
Stage: pull-request
Risk: elevated
Surface: supported-host validation
Trusted base revision: 89abcdef89abcdef89abcdef89abcdef89abcdef
Candidate revision: 0123456789abcdef0123456789abcdef01234567
Tested merge revision: fedcba98fedcba98fedcba98fedcba98fedcba98
Reason: A required native host result was not produced for the evaluated revision.

Fix:
1. Run the canonical portability command for this exact revision.
2. Confirm each required host reports the same policy digest.
3. Re-run the aggregate gate after every required result is terminal.

Local reproduction:
  npm run verify:portability

No PASS is claimed. A missing or cancelled lane is not treated as skipped success.
```

## 12. Cache, Dependency, and Workflow Dependency Policy

Caches are performance inputs, never evidence or release artifacts. Cache identity binds
trust class, OS, architecture, runtime/toolchain, lockfile, build configuration, and
relevant policy digest. Privileged build, publication, and deployment jobs never restore
caches writable by untrusted pull requests. Cache hit rate and time saved are measured;
low-value caches are removed.

All third-party actions and reusable external workflows are pinned to reviewed full
commit SHAs. The source repository and update diff are recorded. Workflow permissions
default to `contents: read`; write, package, attestation, or OIDC permissions are granted
only to the narrow job that needs them. A job that executes candidate code cannot later
become privileged.

Dependency changes are elevated risk. Controls inspect direct/transitive changes, lock
integrity, registry source, install scripts, license policy, vulnerability status, and
representative compatibility. Release builders use approved registries and do not permit
mutable tool download to become an undeclared build input.

Concurrency cancels superseded pull-request runs but never merges a stale result into the
current head. Deterministic foundational failures fail fast; independent security
diagnostics continue when useful. Retry is limited to closed transient categories and
always records the initial failure.

## 13. Trusted Build and Artifact Identity

An official build:

1. starts from an isolated export of the exact accepted Git tree;
2. proves bidirectional closure between the export and that tree;
3. resolves pinned runtime, package manager, dependencies, and base-image digests;
4. performs release compilation and tests in the declared target tuple;
5. packages actual production bytes, including required generated output;
6. scans the final archive/image, member names, metadata, source maps, licenses, and
   publication output;
7. generates an artifact-derived SBOM;
8. records source OID, tree, lockfiles, toolchain, builder identity, workflow, inputs,
   target tuple, policy results, SBOM digest, and artifact digest;
9. signs or attests the immutable digest through a narrow trusted identity;
10. publishes once under an immutable digest and verifies registry readback.

The artifact manifest binds every member's path, type, mode, size, and digest. It rejects
path escapes, symlinked ancestors, devices, unsupported members, missing/extra paths,
one-byte mutation, encrypted/unknown content that cannot be scanned, and platform
substitution. Root package metadata prevents accidental package-registry publication
when no package product is declared.

Legacy snapshot manifests remain historical drift evidence. They are not authoritative
admission evidence for new deployments until upgraded to exact-source and complete
artifact contracts.

Container publication is applicable only when an official container delivery path is
declared. When used, the base image is digest-pinned, the final image—not only the
Dockerfile—is scanned, its SBOM/provenance bind the image digest, and deployment consumes
that digest rather than a mutable tag.

## 14. Protected Deployment State Machine

Deployment consumes a verified artifact; it never compiles candidate source. The state
machine is:

```text
ADMIT -> STAGE -> VERIFY -> CANARY -> PROMOTE -> READBACK -> CLOSE
                  |          |          |          |
                  +----------+----------+----------+-> ROLLBACK / QUARANTINE
```

- `ADMIT`: verify digest, source, builder/workflow identity, policy results, SBOM,
  signature/attestation, target tuple, environment authorization, and approval.
- `STAGE`: transfer by digest to a confined immutable location; preserve the current
  release and a rollback receipt.
- `VERIFY`: rehash after transfer, validate manifest closure, config/secret references,
  schema compatibility, and service-manager inputs before mutation.
- `CANARY`: atomically select the artifact on one approved low-impact target; run health,
  smoke, security, telemetry, and critical behavior checks.
- `PROMOTE`: select the exact accepted canary digest on later targets. Rebuild is
  prohibited.
- `READBACK`: verify service manager, runtime source OID, runtime artifact digest,
  health, and deployment telemetry against the receipt.
- `CLOSE`: atomically finalize immutable evidence only after every direct status is
  known.

Any failed preflight causes no deployment mutation. A canary failure prevents promotion.
A failed restart/readback invokes only the receipt-authorized rollback to the exact prior
digest. Partial rollback is `INCONCLUSIVE`, quarantines the target, and preserves both
attempts. Retrying a terminal transition uses a new attempt/run identity.

Cloud authentication, if introduced, uses short-lived OIDC bound to repository,
workflow, source ref, environment, and audience. Validation, artifact publication,
staging, and production use separate identities and permissions. Current host-local
deployment paths retain explicit owner approval until a protected environment replaces
that boundary.

## 15. Scheduled, Runtime, and Recovery Assurance

Scheduled workflows complement selective PR checks with:

- full Linux/macOS supported-runtime matrices;
- deep static analysis, dependency/license refresh, fuzzing, and mutation testing;
- package/image/SBOM/provenance/attestation re-verification;
- two-build reproducibility comparison per declared target;
- exception-expiry, action-pin, ownership, ruleset, and evidence-retention audits;
- classifier backstop runs and affected-graph calibration;
- runtime release-drift and unauthorized-deployment detection;
- synthetic interrupted deployment, rollback, cache-poisoning, and scanner-outage drills;
- separately authorized backup restoration and disaster-recovery exercises.

Runtime checks compare deployed bytes and runtime-reported identity with the admitted
digest. Missing inspection is not clean. Monitoring records deployments, promotions,
rollbacks, policy drift, and repeated infrastructure failures without publishing private
machine identity.

## 16. Exceptions and Advisory Promotion

An exception is data in a reviewed registry, not an inline skip, environment variable,
workflow conditional, test filter, blanket ignore path, or `continue-on-error`.

Every exception has:

```text
id
controlId
closed surface and path scope
owner
approver role
sanitized justification
compensating controls
evidence references
creation and expiry timestamps
re-entry/reassessment trigger
```

Exceptions never contain a private matched literal. Unknown, stale, expired, overly
broad, unowned, or malformed exceptions block or render assurance inconclusive according
to the underlying control. High-risk publication, credential, artifact-integrity, and
deployment-identity controls may declare themselves non-waivable.

Newly mined patterns enter report-only evaluation first. Promotion to blocking requires:

- deterministic synthetic unsafe fixtures;
- an adjacent safe neighbor for every unsafe fixture;
- acceptable false-positive and runtime budgets;
- actionable remediation;
- a named owner and review cadence;
- cross-adapter parity where the rule applies;
- output-leak tests;
- evidence that removing the rule or adapter causes a test failure.

Advisory status, warning, skipped external verifier, or unavailable tool remains visible
in final reporting and cannot be summarized as clean.

## 17. Test Strategy

Implementation follows red-green-refactor and tests behavior at real boundaries before
production changes. The minimum families are:

1. strict schema, enum, exact-key, cycle, coverage-union, duplicate, and unreachable
   control-manifest tests;
2. exact Git-object/OID classifier tests for added, modified, renamed, copied, generated,
   deleted, submodule, dependency, unknown, shallow, and stale-head states;
3. risk-selection tests proving lower risk cannot be caller-selected and unknown expands
   coverage while remaining inconclusive;
4. hook/CI command parity and hook-installation identity tests;
5. workflow AST tests for triggers, permissions, action pins, timeouts, concurrency,
   metadata injection, cache trust, artifact flow, `if`, filters, skips,
   `continue-on-error`, `merge_group`, and stable gate dependencies;
6. self-bypass mutation tests that alter detectors, scripts, manifest, workflows,
   required lanes, result schema, and aggregate logic;
7. Linux/macOS native suite tests plus structural parity assertions;
8. gate truth-table tests for success, deterministic failure, missing, skipped,
   cancelled, timeout, stale OID, wrong policy digest, malformed receipt, and valid
   not-applicable evidence;
9. result-schema, exit-code, byte-budget, canonical serialization, and public-output leak
   tests;
10. private-registry absent/malformed/stale/symlink/owner/permission/size tests without
    committed private values;
11. exact-source export, archive closure, native target, generated-output, SBOM,
    provenance, attestation, transfer, and registry-readback tests;
12. no-mutation-on-failed-preflight, exact-digest canary/promotion, restart failure,
    rollback, partial rollback, runtime identity, and drift tests;
13. adversarial archive traversal, cache poisoning, untrusted artifact, metadata command
    injection, fake status, skipped matrix, privileged candidate execution, scanner
    outage, and action-update tests;
14. actual package, image, source-map, coverage, test-report, screenshot, summary,
    annotation, and scanner-output publication tests;
15. default-branch and scheduled backstop tests that feed escaped failures into new
    classifier fixtures.

Large, unknown, encrypted, truncated, unavailable, or over-budget input fails closed.
Counts and byte budgets are checked before traversal or canonicalization. Tests at the
limit, one byte over, multibyte boundaries, hostile accessors, concurrency, stale locks,
and partial atomic results are required.

## 18. Enforcement Self-Protection

Structural and protected-source tests fail when a candidate:

- removes a required trigger, supported OS lane, or static gate dependency;
- adds `continue-on-error`, `|| true`, ignored exits, catch-and-pass, or a silent skip;
- broadens permissions or allows a job to become privileged after candidate execution;
- replaces an immutable action reference with a tag or branch;
- moves private assurance into candidate-controlled execution;
- admits untrusted caches/artifacts into privileged jobs;
- makes a mandatory job conditional or path-filtered without trusted applicability;
- changes revision, policy, platform, trust-class, or artifact binding fields;
- disables a scanner, removes its safe-neighbor tests, or alters the result renderer in
  the same candidate lane being evaluated;
- weakens ownership or exception expiry for sensitive paths.

Sensitive workflow, policy, ownership, privacy, release, artifact, and deployment files
require specialized review. Removal or weakening of a control must be detectable through
mutation testing and protected data-only validation.

## 19. Integrity-Anomaly Stop Protocol

Execution stops immediately when:

- `HEAD` changes unexpectedly;
- the trusted remote advances during a frozen verification window;
- the worktree or index becomes dirty unexpectedly;
- the runtime or executable identity differs from the pinned toolchain;
- artifact bytes cannot be tied to reviewed source;
- a test ran under an unsupported environment or invalid precondition;
- a receipt fails schema, mode, ownership, confinement, lock, or hash validation;
- a process-lane terminal result does not prove the owned process group ended.

The operator preserves the state, marks the result inconclusive, reconciles exact
lineage, and resumes from a clean verified base. It does not paper over the anomaly,
delete evidence, reuse a terminal attempt ID, or continue stacking unrelated changes.

## 20. Operability and Feedback Metrics

The control plane records bounded, non-sensitive metrics for:

- time to first actionable failure;
- pre-commit, pre-push, PR, merge-group, release, and deployment duration;
- queue time and superseded-run cancellation rate;
- cache hit rate and measured time saved;
- flake, retry, quarantine, and expired-exception rates;
- false-positive, advisory-promotion, and bypass-attempt rates;
- missing/inconclusive control frequency by category;
- default-branch/release failures attributable to selection mistakes;
- escaped defects, failed canaries, rollback rate, and rollback success;
- artifact reproducibility and provenance verification rate.

Initial implementation establishes baselines rather than inventing thresholds. A later
review promotes measured budgets. Checks with high noise, duplicated coverage, poor
actionability, excessive cost, or no owner are narrowed, moved, repaired, or retired
through a reviewed manifest change. They are not silently skipped.

## 21. Migration and Rollback

Migration is prospective and reversible:

1. freeze a source and hosted-settings inventory;
2. add the control manifest, schema, validator, result contract, and inventory reports in
   report-only mode;
3. add canonical command facades without removing existing scripts;
4. add native portability suites and aggregate-gate canaries without changing required
   hosted settings;
5. split untrusted candidate execution from protected data-only evaluation;
6. pin workflow dependencies and add `merge_group`, privacy-before-upload, and trust
   partitioning;
7. add exact-source target artifacts, SBOM, provenance, attestation, and verification;
8. add dry-run deployment admission and synthetic rollback proof;
9. enable blocking groups only after unsafe/safe-neighbor, bypass, and real-run canaries;
10. change hosted required checks only under an explicit settings receipt, preserve the
    prior settings for rollback, and verify expected App/source;
11. deprecate old adapters only after reference scans and parity tests prove they no
    longer authorize a boundary.

Rollback restores the previous manifest/workflow or hosted-settings receipt through an
ordinary reviewed change. It does not erase failed evidence, rewrite public history,
remove a public finding, or force-push. A rollback that leaves the authoritative gate
unavailable is `INCONCLUSIVE`, not successful restoration.

## 22. Definition of Done and Evidence Map

The initiative is complete only when all rows have independently verifiable current-head
evidence:

| Required outcome | Completion evidence |
|---|---|
| complete control inventory | manifest schema + generated exact coverage/ownership report |
| one owner per mechanism | registration inventory rejects duplicate policy/serializer/gate ownership |
| canonical commands | local/CI parity tests and pinned-runtime receipts |
| risk-based selection | exact-OID classifier receipt and selection truth-table tests |
| no uncertainty under-selection | system-wide execution plus inconclusive gate proof |
| fast local feedback | measured hook commands preserving staged state |
| authoritative remote equivalents | manifest coverage join across local/remote stages |
| PR trust isolation | workflow permission/secret/cache receipt and adversarial tests |
| self-bypass prevention | protected data-only check from expected App/required workflow |
| portable execution | Linux x64 and macOS arm64 receipts + stable portability gate |
| stable merge decision | always-created policy gate on pull request and merge group |
| repository governance | live readback of rules, reviews, CODEOWNERS, bypass, tag policy |
| immutable workflow dependencies | action refs full-SHA pinned with source records |
| exact trusted build | Git-tree export and bidirectional artifact closure receipt |
| actual artifact assurance | final scan, SBOM, provenance, attestation, digest, readback |
| build once/promote many | same tuple digest in canary and every promoted target receipt |
| protected deployment | admission, approval, canary, identity readback, closeout evidence |
| safe recovery | no-mutation preflight and successful synthetic rollback drills |
| runtime assurance | deployed digest/source readback and drift-monitor receipt |
| scheduled coverage | matrix/security/drift/reproducibility/recovery receipts |
| positive feedback loop | granular codes, repair, reproduction, and leak tests |
| controlled exceptions | owner/approver/expiry/re-entry validation and expiry drill |
| measured efficiency | latency, cache, cancellation, flake, false-positive, escape metrics |
| non-destructive migration | ordinary commits, preserved evidence, no history rewrite |

A locally green hook, advisory lane, skipped verifier, stale receipt, partial matrix,
masked failure, unsigned artifact, successful upload, healthy process without identity,
or deployment without readback cannot satisfy a row.

## 23. Alternatives Rejected

- **Duplicate scanners per surface:** copied rules, serializers, and decisions drift;
  thin adapters must feed canonical owners.
- **Full repository matrix on every change:** exact selection with merge/default/release/
  scheduled backstops improves feedback without accepting blind spots.
- **Hooks as authority:** hooks are bypassable and not automatically installed.
- **Candidate-controlled aggregate gate:** the change could weaken its own judge.
- **Linux simulation of macOS:** native shell, filesystem, process, keyring, dependency,
  and launchd behavior requires native execution.
- **One universal host artifact:** native dependencies and service bundles are target
  specific; the immutable unit is a declared target tuple.
- **Rebuild per environment:** environments must promote the exact admitted digest.
- **Fail-open scanner outage:** missing assurance is inconclusive at publication
  boundaries; emergency paths require explicit, narrow, expiring, audited authority.
- **Patch every plausible risk:** only proven reachable paths enter blocking beads;
  proposals begin with evidence gathering or report-only evaluation.

## 24. Primary Platform References

- [GitHub secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub merge queue requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- [GitHub ruleset controls](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [GitHub hosted runner characteristics](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [Git client-side hook behavior](https://git-scm.com/docs/githooks)
