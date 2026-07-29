# Open issue review registry

> Generated from `docs/triage/open-issue-registry.json`. Do not edit this view by hand.

- Pinned main revision: `59166b78357e129ab8140b145e304b5426bcb209`
- Captured at: 2026-07-28T22:33:25.021Z
- Open issues: 255
- Registry SHA-256: `8723a28a46976cc174a5c86abd266159e00089047952b6daeb1f2032ff8ccbe0`

## #1786: Durable auth-loss rows are written but never imported or resolved after recovery

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P2`, `alerts`, `bug`, `reliability`
- Recommended labels: `P2`, `alerts`, `bug`, `reliability`
- Dependencies: None

### Evidence

Pinned source contains durable auth-loss writers and a transition controller; the public issue is correctly narrowed to the still-unowned import and recovery-resolution path. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #1786 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #1869: Provider-tree reaper is PPID-scoped, not cgroup-scoped — detached workload daemons (e.g. ssh-agent) accumulate unbounded until restart

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `P2`, `bug`, `portability`, `reliability`
- Recommended labels: `P2`, `bug`, `portability`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #1869 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #1874: GUI session monitor ignores best_effort policy and re-enrolls an intentionally excluded host

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`
- Recommended labels: `P2`, `SSOT`, `bug`, `invalid`
- Dependencies: None

### Evidence

Merged PR #1895 added best_effort to the canonical policy set, excluded it from GUI monitoring, rejected unknown values, and added tracked-manifest and cross-monitor tests. Eleven focused policy tests pass on current main.

### Suggested remediation

Close the reopened issue as already fixed by merged PR #1895 unless a new current-main reproduction is attached.

### Impact and blast radius

Acting on the stale body would duplicate a completed fix and could disturb the intentional best-effort exclusion. GUI-session target selection and cross-monitor membership policy.

## #1876: Fleet sentinel is undeployed, leaving no live authoritative fleet count or status snapshot

- Classification: `measurement-only`
- Evidence state: `live-revalidation-required`
- Confidence: `low`
- Current labels: `P3`, `fleet`, `ops`, `reliability`
- Recommended labels: `P3`, `fleet`, `ops`, `reliability`
- Dependencies: None

### Evidence

The sentinel implementation and hardening documentation exist, but deployment and live fleet coverage are operational facts that cannot be proven from the repository snapshot.

### Suggested remediation

Collect the bounded measurement or live deployment evidence requested by the issue before implementation.

### Impact and blast radius

Unresolved scope described by issue #1876 can affect docs/sentinel behavior or maintainability. Primary boundary: docs/sentinel; broader effects remain subject to focused lead verification.

## #1882: durability(fleet): activity feed loses health transitions between reads

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `fleet`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Pinned main contains merged PR #1906: the Ops summary now uses current line state and its focused console coverage passes. The same pinned feed route explicitly retains the accepted #1882 residual: health transitions are synthesized at request time through a process-global previousStatuses baseline, so transitions between reads, process restarts, and concurrent readers can still be lost or raced. A fully paginated 39-open-PR scan found only broad draft path collisions, not an owner for that residual. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Move health-transition emission to the observation boundary and give each transition durable identity or direct ordered broadcast semantics; keep current-state KPI derivation separate from historical transition rows.

### Impact and blast radius

Operators can miss short health cycles and receive incomplete incident history even though the current Ops summary is now accurate. Fleet health history and Ops-console summaries for every discovered instance; an incomplete fix can hide real outages or invent stale current-state counts.

## #1964: Console test: soup-kitchen lazy Add Line wizard failed once on quality (24.x) — base-rate measurement needed before any flake/retry decision

- Classification: `measurement-only`
- Evidence state: `measurement-required`
- Confidence: `low`
- Current labels: `P3`, `console`, `reliability`
- Recommended labels: `P3`, `console`, `reliability`
- Dependencies: None

### Evidence

The report is explicitly a base-rate measurement request after one failure and a passing rerun; it is not evidence of a confirmed flaky test.

### Suggested remediation

Collect the bounded measurement or live deployment evidence requested by the issue before implementation.

### Impact and blast radius

Unresolved scope described by issue #1964 can affect tests/console behavior or maintainability. Primary boundary: tests/console; broader effects remain subject to focused lead verification.

## #1976: QR-017: server-side MCP tool-surface progressive disclosure (~165 tools)

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `P3`, `audit`
- Recommended labels: `P3`, `audit`, `mcp`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A lead-integrated semantic rereview of merged PR #2490 at exact API and SSH main 4a2b1f2dcf058ed8138508dbf192643088f2fed3 confirmed that malformed JSON-RPC logging now emits only bounded structural diagnostics and adds focused private-payload byte-absence coverage. The change does not implement progressive MCP tool-surface disclosure, so the recorded partial finding, owner boundary, and dependency order survive. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #1976 can affect src/mcp behavior or maintainability. Primary boundary: src/mcp; broader effects remain subject to focused lead verification.

## #1977: QR-019: decompose AgentRuntime behind behavior-preserving ownership boundaries

- Classification: `tracker`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `audit`
- Recommended labels: `P3`, `audit`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, two current labels, timestamp, URL, and body hash while API and SSH main remained exact. At the initial audited pin the fitness baseline measured src/runtimes/agent/runtime.ts at 12,131 lines, and the AST fitness measurement reported a roughly 11,352-line AgentRuntime class with 266 methods, far beyond the registered god-class thresholds. The 3ea8934-to-6b90af2 delta intersected runtime.ts and added provider-policy responsibilities; inspection and the exact-main fitness run confirmed that the decomposition debt survived rather than relying on the old count. Main advanced to 0863ed87 with a merge-base-only, absolute-cap growth waiver that authorizes a temporary 12,131-to-12,500 ceiling allowance until 2026-08-10 and names #1977 as the payback program. Main then advanced to 9da1e885 by applying that allowance: baseline and documentation now record 12,130 measured lines and a 12,500 ceiling. The widening creates temporary headroom but does not reduce AgentRuntime, its method count, or its ownership coupling; the recorded payback still requires the ceiling to return below the original value. The exact current guard, baseline-weight, file-size, registry, SSOT, and ring-boundary suites passed 90 of 90 tests with no skips, so the decomposition finding and restoration-oriented completion criterion remain verified at the new pin. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #1977's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2597 at exact API and SSH main f0ece2d18883a66f04892a46669b3547e5bdf2b1 inspected every intersecting workflow, baseline-growth guard, and focused-test path. Its exact-revision measurement and fail-closed ancestry checks preserve existing waiver behavior and do not alter this issue’s finding, classification, owner boundary, or dependency order.

### Suggested remediation

Inventory AgentRuntime responsibilities and state edges, choose cohesive ownership boundaries, and extract one behavior-preserving slice at a time under characterization tests and the shrink-only file-size ratchet.

### Impact and blast radius

A single oversized runtime concentrates lifecycle, routing, provider, recovery, presentation, and health responsibilities, increasing review cost and the probability that unrelated changes disturb shared state. Agent runtime construction, provider routing, turn lifecycle, recovery, health, presentation, queueing, fitness enforcement, and their large behavioral test surface.

## #1978: QR-022: schedule-safe OpenCode worker dispatch (db-lock + silent memory-mcp sidecar)

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P3`, `audit`
- Recommended labels: `P3`, `audit`, `mcp`
- Dependencies: None

### Evidence

Pinned source and focused tests contain the host-wide dispatch lock and the shared memory-MCP root wiring requested by the issue, contradicting the remaining open claim.

### Suggested remediation

Close or rewrite the issue so its claim matches pinned main.

### Impact and blast radius

Unresolved scope described by issue #1978 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2085: ci-control-result.test.ts: two unpinned clock-taking validator calls (lines 1112/1115) may be masked by staleness

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P3`, `reliability`, `type-safety`
- Recommended labels: `P3`, `reliability`, `type-safety`
- Dependencies: None

### Evidence

The cited test and ci-control implementation are absent from the pinned main revision; the finding belongs to an unmerged development lane and is stale for main-bound triage.

### Suggested remediation

Close or rewrite the issue so its claim matches pinned main.

### Impact and blast radius

Unresolved scope described by issue #2085 can affect repository-maintenance behavior or maintainability. Primary boundary: repository-maintenance; broader effects remain subject to focused lead verification.

## #2121: Post-handoff session fails to rehydrate conversation from transport + brittle /model pin keyword

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `bug`
- Recommended labels: `P3`, `bug`, `transport`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2121 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2135: Bound high-cadence BOT ERRORS controller diagnostics and JSONL retention

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `console`, `reliability`
- Recommended labels: `P3`, `alerts`, `console`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2135 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2136: Correlate inline BOT ERRORS log tails before attaching them as evidence

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `bug`, `console`
- Recommended labels: `P3`, `alerts`, `bug`, `console`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2136 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2144: durability: make scheduled agent-job acknowledgement crash-safe

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2144 can affect src/core/substrate behavior or maintainability. Primary boundary: src/core/substrate; broader effects remain subject to focused lead verification.

## #2145: durability: terminalize or recover ChatRuntime messages rejected by ChatQueue

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2145 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2147: alerts: make fault-taxonomy source-policy coverage explicit and mechanically complete

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 7 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. Exact-main rereview at af753d288faab9e1f7258a318f9f739433804cfe found that PR #2451 added the v2 domain, owner, and test-reference cross-contract, while sourceDispositions and producer policies remain unchanged; PR #2577 adds only the bounded memory operation domain. The source-policy completeness gap therefore survives with adjacent groundwork. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. PR #2455's two continuity health causes widen the canonical taxonomy and health projection but do not resolve this issue's surviving cross-contract, source-policy, or health-semantics gap. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Extend the canonical registry with generated source dispositions and producer policies, enumerate every emitted source mechanically, and fail closed when source, owner, disposition, or test coverage drifts.

### Impact and blast radius

Unresolved scope described by issue #2147 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2148: reliability: wire an external deadman alert for the turn-recovery supervisor

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `PATCH READY`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2148 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2150: reliability: require active session state before claiming a turn-recovery replay

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2150 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2151: reliability: keep turn-recovery lease renewal safe across transient store failures

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2151 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2155: reliability: add an evidence-gated operator workflow for blocked-unsafe turn recoveries

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. Exact main adds an explicitly confirmed continuity-manifest recorder and aggregate health, but it records external absent/not-admitted/ambiguous receipts as generic recovery plans/runs. It does not enumerate, reassign, evidence-validate, promote, or dispatch blocked_unsafe turn-recovery jobs. The new recorder also swallows outer rollback failure, includes classification in durable identity, can cause the newest permanent started run to hide durability.lastRecoveryAt, and uses unescaped LIKE underscores. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Implement the issue's bounded dry-run-first blocked-job workflow independently; do not reuse the exact-head continuity recorder as proof that this contract is complete.

### Impact and blast radius

Unresolved scope described by issue #2155 can affect docs behavior or maintainability. Primary boundary: docs; broader effects remain subject to focused lead verification.

## #2160: reliability: propagate primary-model probe timeouts to queued execution-gate waits

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2160 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2168: transport: gracefulReconnectInFlight flag can stick true, permanently blocking reconnects

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P2`, `bug`, `reliability`
- Recommended labels: `P2`, `bug`, `reliability`, `transport`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2168 can affect src/transport behavior or maintainability. Primary boundary: src/transport; broader effects remain subject to focused lead verification.

## #2169: reliability: let cold per-chat turn recovery establish a missing session

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2169 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2170: reliability: wire shared and singleton recovery jobs into scope-native replay paths

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 8 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2170 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2189: iMessage: advertised read-receipt subscriptions never receive inbound events

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: None

### Evidence

Exact target source and focused tests show that PR #2336 stops the imsg backend from advertising read-receipt capability, but the BlueBubbles backend still advertises read-receipts while handleInboundRecord emits only text and reaction events and the focused test explicitly defers inbound read receipts. The broad finding is narrowed, not closed. API, SSH, and origin main remained exact at 487bad4e64da457f6d601168fe43fcb49d9648b4; the complete 13-file changed test set passed 188/188. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2189 can affect src/transport/imessage behavior or maintainability. Primary boundary: src/transport/imessage; broader effects remain subject to focused lead verification.

## #2190: tech-debt: 240 bare catch{} blocks — enforceable via ESLint no-empty + custom ratchet rule

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `DRY`, `P4`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P4`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, four current labels, timestamp, URL, and body hash while API and SSH main remained exact. The requested enforcement now exists: the catch-justification ESLint rule is installed, a shrink-only baseline records 126 inherited entries, a generator checks growth and stale entries, and push and release gates invoke guard:catch-ratchet. The live guard passed in the prior exact-main audit. Every decisive and test path is byte-identical from 3ea8934 to the required pin, so the implementation evidence transfers exactly and contradicts the source registry's unresolved classification. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found that package.json only adds the imsg:relay script. Catch-ratchet registration and push/release enforcement remain unchanged, so the stale fixed disposition survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2597 at exact API and SSH main f0ece2d18883a66f04892a46669b3547e5bdf2b1 inspected every intersecting workflow, baseline-growth guard, and focused-test path. Its exact-revision measurement and fail-closed ancestry checks preserve existing waiver behavior and do not alter this issue’s finding, classification, owner boundary, or dependency order.

### Suggested remediation

Close the issue as implemented after the final identity, exact-main, and complete pull-request-census gates; preserve the shrink-only baseline and focused rule/generator tests.

### Impact and blast radius

The originally reported unbounded growth path is now blocked by a checked baseline and required gates; keeping the issue open as unresolved would misstate current enforcement. ESLint fitness configuration, inherited catch debt, baseline generation, push and release verification, and guard-focused tests.

## #2191: tech-debt: 30+ as any/as unknown SQLite casts — typed queryAll/queryOne wrapper with ESLint enforcement

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `DRY`, `P4`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `P4`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. Exact main still has no queryAll/queryOne wrapper or no-raw-sqlite-cast guard. PR #2455 adds direct SQLite-result assertions, including `.all(ACTOR) as unknown as HealthRow[]` and `.get(id) as StoredPlanRow`, so the debt survives and grows. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce typed queryAll/queryOne helpers, migrate the new continuity ledger and existing high-risk readers, then enforce a shrink-only raw-cast ratchet.

### Impact and blast radius

Unresolved scope described by issue #2191 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2192: tech-debt: 17+ files with direct process.env access — missing typed RuntimeConfig SSOT module

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `SSOT`, `tech-debt`, `type-safety`
- Recommended labels: `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. PR #2455 adds no process.env access and changes only src/core/health.ts among the decisive paths. Exact main still contains 153 process.env references across 45 src TypeScript files and no typed RuntimeConfig SSOT or enforcement rule. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2192's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. Current-target recounting finds 154 direct process.env references across 47 source TypeScript files; the typed configuration boundary and shrink-only enforcement gap survives. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Create the typed RuntimeConfig boundary, migrate callers, and enforce a shrink-only direct-environment-access ratchet.

### Impact and blast radius

Unresolved scope described by issue #2192 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2193: tech-debt: ?? vs || vs truthiness inconsistency — first-principle falsy-trap pattern with ESLint enforcement

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `bug`, `tech-debt`, `type-safety`
- Recommended labels: `P3`, `bug`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 4 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2193 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2194: dead-code: 4 resolve*Config functions in config.ts have zero callers — superseded by agent-config-validator.ts

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P5`, `dead-code`, `tech-debt`
- Recommended labels: `P5`, `dead-code`, `invalid`, `tech-debt`
- Dependencies: None

### Evidence

Current-main startup resolution directly calls all four named resolve functions, and focused configuration tests also call them. The issue claim that they have zero callers is contradicted. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found that src/config.ts changes only optional knowledge-profile minScore merging within the live configuration surface. Production still calls resolveMemoryConfig, resolveTwilioSmsConfig, resolveImessageConfig, and resolveSignalConfig, and focused resolver tests remain. The zero-callers premise remains contradicted. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Close or rewrite the issue because its dead-code premise is false on current main.

### Impact and blast radius

Leaving the issue unchanged would direct a deletion toward live configuration resolution used by four transport and memory paths. Configuration loading for memory, iMessage, Signal, and Twilio transports.

## #2195: dead-code: auth-loss-mode-bucket-producer-artifact.ts — 0 importers, test-contract infrastructure for #1518 never wired

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P5`, `dead-code`, `tech-debt`
- Recommended labels: `P5`, `bug`, `dead-code`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2195 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2196: dead-code: isLoggedOutStatusCode exported but zero external callers — only self-referenced in auth-loss-signals.ts

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P5`, `dead-code`, `tech-debt`
- Recommended labels: `P5`, `bug`, `dead-code`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2196 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2197: observability: detect unanswered inbound and finalization-leak episodes without per-message paging

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`
- Recommended labels: `P2`, `SSOT`, `bug`, `console`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. PR #2455 persists only external-history absent, observed_not_admitted, and ambiguous receipts and reads only recovery_plans/recovery_runs for health. It does not query admitted inbound state, terminal records, successful terminal delivery, finalizer grace, bounded episode state, or inhibition. The requested unanswered-inbound and finalization-leak detector therefore remains absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Implement the issue-specific read-only lifecycle probe and episode state separately from the continuity-manifest ledger.

### Impact and blast radius

Unresolved scope described by issue #2197 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2200: tech-debt: introduce a deterministic clock abstraction across src/

- Classification: `tracker`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 8 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. Exact-tree measurement at af753d288faab9e1f7258a318f9f739433804cfe found 517 raw Date.now() or new Date() call sites under src/, up from 508 at the prior reviewed main; PR #2577 added nine Pinecone call sites and no injectable clock boundary. The numeric issue title is stale, but the deterministic-time debt is verified. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define one minimal clock abstraction, migrate behaviorally sensitive scheduling, timeout, retry, freshness, and persistence boundaries in bounded cohorts, and add a shrink-only guard for direct wall-clock reads.

### Impact and blast radius

Unresolved scope described by issue #2200 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2201: tech-debt: three parallel connection-state unions drift independently — SSOT violation

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2201 can affect src/fleet/routes behavior or maintainability. Primary boundary: src/fleet/routes; broader effects remain subject to focused lead verification.

## #2203: tech-debt: 4 hand-rolled shape guards bypass CLAUDE.md's Zod mandate for highest-stakes persisted files

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2203 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2204: tech-debt: 5 inline XDG_*_HOME reads bypass the xdgDir() helper — || vs ?? divergence already present

- Classification: `duplicate`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `DRY`, `P3`, `SSOT`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P3`, `SSOT`, `duplicate`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Issues #2204 and #2252 identify the same inline XDG resolution sites and the same operator divergence. #2252 is the later, more complete statement and includes the shared-ring constraint. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Close #2204 as a duplicate of #2252 and preserve implementation evidence on #2252.

### Impact and blast radius

Keeping both open creates duplicate implementation ownership and competing remediation plans for the same paths. XDG path resolution in startup, fleet platform, and keyring code.

## #2205: tech-debt: 37 test files copy-paste tmpDirs/mkdtempSync/afterEach setup — extract shared helper

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P4`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P4`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2205 can affect tests/hooks behavior or maintainability. Primary boundary: tests/hooks; broader effects remain subject to focused lead verification.

## #2206: tech-debt: instance-loader writes parsed config to process.env.INSTANCE_CONFIG — 4 readers + 1 rogue writer

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2206 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2207: tech-debt: 35+ sites hardcode 60*60*1000 (1 hour) under 3 spellings — MS_PER_HOUR constant missing

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P3`, `SSOT`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P3`, `SSOT`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 16 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found only optional minScore configuration changes in src/config.ts. A bounded comparison of the cited paths found the selected one-hour literal patterns unchanged between prior and target main; PR #2488 neither introduces the shared constant nor removes the consolidation debt. The public count remains subject to complete current-tree re-enumeration. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2207 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2209: tech-debt: 27 console.* calls in src/ bypass pino logger — structured-logging SOC violation

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `audit`, `console`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found only optional minScore configuration changes in src/config.ts. The bounded console-call inventory across all six cited paths is unchanged from prior main, so PR #2488 does not address structured-logging ownership; the public count still requires complete current-tree re-enumeration. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2209 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2210: tech-debt: console/src/ is invisible to ring-boundary guards — providers.ts reaches 3 layers into backend

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `audit`, `console`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 7 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2210 can affect console/src/lib behavior or maintainability. Primary boundary: console/src/lib; broader effects remain subject to focused lead verification.

## #2211: tech-debt: consolidate divergent hand-rolled non-empty-string validation

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `DRY`, `P4`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `P4`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, five current labels, timestamp, URL, and body hash while API and SSH main remained exact. Current source still mixes shared type guards with local nonBlankString and normalizedModelString helpers and inline typeof, trim, empty-string, and exact-whitespace checks whose accepted values and error contracts differ. The 3ea8934-to-pin delta intersects config, agent-config-validator, and fallback-chain and adds further provider-policy validation, so the title's count of 26 is no longer safely reusable. Fresh inspection verifies the consolidation debt but supports a count-free replacement title. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found that src/config.ts and tests/config.test.ts add optional numeric minScore merging and a focused positive test. They neither introduce nor consolidate a non-empty-string contract; the cited local and inline typeof-plus-trim variants remain, so the count-free consolidation finding survives unchanged. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Current-target review found another inline typeof-plus-trim nonempty-string check, strengthening the count-free consolidation finding without changing its owner boundary. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define shared named predicates for non-empty, trimmed-non-empty, and exact-trimmed strings, migrate callers according to their existing semantics, and retain caller-specific error messages at the boundary.

### Impact and blast radius

Divergent string validation can accept whitespace-only or normalized input in one configuration path while rejecting it in another, producing inconsistent runtime and operator behavior. Instance configuration, agent option validation, display names, fallback routes, auth-loss signals, fleet polling, shared type guards, and their error contracts.

## #2212: tech-debt: ValidationError and ExtractionError have byte-identical shape — extract shared EnrichmentError

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `P3`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2212 can affect src/runtimes/chat behavior or maintainability. Primary boundary: src/runtimes/chat; broader effects remain subject to focused lead verification.

## #2213: tech-debt: get*/load*/fetch* DB-read prefix inconsistent across 52 functions — naming-convention SSOT

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P3`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. PR #2455 does not add naming documentation or enforcement and introduces `readContinuityGapHealth(raw: DatabaseSync)`, a new DB-read helper outside the proposed get/load/fetch convention. Existing load-prefixed database readers remain. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Include readContinuityGapHealth in the convention decision, rename inconsistent readers, and add the documented guard and baseline.

### Impact and blast radius

Unresolved scope described by issue #2213 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2214: tech-debt: ratchet weak test assertions with reproducible integrity measurements

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, four current labels, timestamp, URL, and body hash while API and SSH main remained exact. A deterministic exact-tree literal scan finds 61 expect.anything() calls across 24 test files, not the title's 58 across 21 files. The published broad weak-assertion total is not reproducible from its stated matcher. The canonical integrity baseline contains 51 findings and the required release wrapper exists. The 3ea8934-to-pin delta intersects two named tests but a fresh scan reproduces the same 61-call and 24-file totals at both revisions, so the surviving integrity debt is current while the old measurements are contradicted. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Body-free live identity reads and all main authorities remained stable at 29fe568cdfbb25475340268571d1818da64395ef. Deterministic scans at both 4a2b1f2dcf058ed8138508dbf192643088f2fed3 and target main found exactly 61 expect.anything() calls across 24 test files. PR #2488 changes outbound-queue.test.ts but changes neither count; the integrity baseline and release wrapper are untouched. The surviving debt remains current while the published 58-call title is stale; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2214's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A deterministic target-tree scan now finds 55 expect.anything() calls across 23 test files after PR #2362 replaced six such assertions; the published title's 58-call count remains stale, while the broader reproducible weak-assertion and ratchet finding survives. Current-target recounting finds 63 expect.anything() calls across 24 test files; the broad-assertion debt remains measurable and unresolved. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Replace count prose with a checked machine-readable inventory, define each weak-assertion matcher precisely, classify intentional uses with bounded reasons, and ratchet every family down under focused mutation-resistant tests.

### Impact and blast radius

Weak or non-reproducibly measured assertions can let regressions pass while a stale headline gives false confidence about the scale and enforcement of the debt. Test-integrity baselines and gates plus the 24 current test files containing expect.anything(), with broader weak-assertion families pending a reproducible inventory.

## #2215: tech-debt: loadOrCreateFleetTokens exported from 2 files — public API duplication breaks drift guard

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2215 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2216: tech-debt: UpdateModal raw fetch bypasses arch.approved-api-client rule — enforcement gap in console ESLint scope

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `audit`, `console`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2216 can affect console behavior or maintainability. Primary boundary: console; broader effects remain subject to focused lead verification.

## #2218: tech-debt: @deprecated symbols with zero callers are doc/code lies — TURN_WATCHDOG_MS rationale is false

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P3`, `audit`, `dead-code`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `alerts`, `audit`, `dead-code`, `refactor`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. Body-free live identity reads and all main authorities remained stable at 29fe568cdfbb25475340268571d1818da64395ef. Target source retains deprecated parseEvent and TURN_WATCHDOG_MS. parseEvent has no production caller but remains exercised by compatibility tests; TURN_WATCHDOG_MS has no semantic use and only an unused test import plus documentation mention. PR #2488 adds parseEvents informational-event handling but leaves both deprecated surfaces unchanged, so it is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2218's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2218 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2219: tech-debt: 81 PNG files (~4.7 MB) committed to git under artifacts/ and docs/screenshots/ — gitignore tightened but old files remain

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2219 can affect console/src behavior or maintainability. Primary boundary: console/src; broader effects remain subject to focused lead verification.

## #2222: SSOT: fitness ratchet ceilings are hand-maintained twins (.claude/fitness/baseline.json + docs/architecture/fitness-taxonomy.md)

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `SSOT`, `refactor`
- Recommended labels: `P3`, `SSOT`, `refactor`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, three current labels, timestamp, URL, and body hash while API and SSH main remained exact. The machine baseline and architecture documentation still duplicate two file ceilings and six pattern-count values. Current documentation explicitly requires lowering a violationCount in baseline.json and the matching documentation row together; guard tests check agreement but neither surface is generated from one canonical source. Main advanced to 0863ed87 with a separate growth-waiver authority and baseline-weight parser. That change made reviewed widening fail closed, but it neither generated the documented ceilings/counts from the baseline nor removed duplicate numeric edits; the temporary absolute cap became an additional machine-readable authority rather than the canonical projection required by this issue. Main then advanced to 9da1e885 by changing the runtime line measurement and ceiling in both baseline.json and the architecture table in the same commit, directly exercising the two-file twin ceremony. The exact current guard, baseline-weight, file-size, registry, SSOT, and ring-boundary suites passed 90 of 90 tests with no skips, so the SSOT finding remains verified at the new pin. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. An exact-main semantic rereview of merged PR #2488 at API, SSH, and origin main 29fe568cdfbb25475340268571d1818da64395ef found that its docs/tools.md edit is confined to knowledge_search return documentation. The machine baseline, taxonomy twin table, twin-reading guard, growth guard, and fitness tests are unchanged. The verified finding and owner boundary survive; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2597 at exact API and SSH main f0ece2d18883a66f04892a46669b3547e5bdf2b1 inspected every intersecting workflow, baseline-growth guard, and focused-test path. Its exact-revision measurement and fail-closed ancestry checks preserve existing waiver behavior and do not alter this issue’s finding, classification, owner boundary, or dependency order.

### Suggested remediation

Make the machine-readable fitness registry canonical and generate the documented ceiling/count table, or validate documentation without storing repeated numbers.

### Impact and blast radius

A required two-file edit can drift, block legitimate ratchet-downs, or encourage stale documentation even when agreement tests catch the mismatch later. Fitness file-size ceilings, SSOT pattern counts, ring-boundary debt, baseline-growth enforcement, architecture documentation, and maintenance workflows.

## #2223: DRY: duplicate ps-based process-tree census (process-tree.ts vs tree-liveness.ts)

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P4`, `refactor`
- Recommended labels: `DRY`, `P4`, `refactor`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2223 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2224: tech-debt: verify:* push-gate pipelines are single-line ~4KB shell strings in package.json — unreviewable, undiffable, untimed

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free live identity reads established the current node, title, URL, timestamp, body SHA-256, and labels. API and SSH main both resolved to the pinned revision. The exact pinned package script verify:push:branch is one 4,627-byte line containing 49 &&-delimited segments and no timeout or gtimeout boundary. The pre-push dispatcher invokes that script as one branch-mode command, so failure attribution and runtime bounding remain coupled to the monolithic shell value. The corrected decisive paths are package and gate orchestration rather than the historical record's unrelated src/main.ts mapping. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. Exact-main remeasurement at af753d288faab9e1f7258a318f9f739433804cfe found verify:push:branch is 4,627 bytes with the same 49 &&-delimited segments and zero timeout tokens. The merged alignment runner wraps this gate but does not structure or bound its internal stages. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found that package.json only adds imsg:relay; every verify:* script value is byte-for-byte unchanged. The unstructured push-gate orchestration finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. At the current target, verify:push:branch is 4,755 bytes and contains 48 command-chain operators across 49 segments, so the monolithic orchestration finding survives. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Move the branch verification chain into a structured stage manifest or runner with explicit ordering, bounded per-stage runtimes, content-free stage receipts, and focused failure tests while preserving the existing fail-closed command set.

### Impact and blast radius

A large single-line shell pipeline is difficult to review or diff, identifies failures only through nested command output, and provides no bounded completion contract for an individual stalled stage. Branch push verification, local failure attribution, guard runtime bounds, and the maintainability of the repository's largest verification pipeline.

## #2225: tech-debt: 0-byte decoy instance DBs in ~/.local/state/whatsoup mislead operators — live DBs are in ~/.local/share

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found that docs/configuration.md changes only knowledge-profile minScore documentation. The documented XDG data/state locations and bot.db placement are unchanged, so the decoy-database finding survives and still requires its issue-specific operational falsifier. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2225 can affect docs behavior or maintainability. Primary boundary: docs; broader effects remain subject to focused lead verification.

## #2235: hardening(agent): make liveness decisions generation-safe and interrupt teardown durability-proven

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `P2`, `SSOT`, `reliability`
- Recommended labels: `P2`, `SSOT`, `reliability`
- Dependencies: None

### Evidence

Merged PR #2226 established the initial behavior, while the issue enumerates remaining liveness-generation and interrupt-durability gaps in pinned source. Current-target review found the new queue halt latch adjacent to liveness and interrupt durability, but it does not establish generation-safe teardown; the remaining scope survives. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2235 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2238: refactor(fleet): split route dispatch and LID conflict logic out of src/fleet/index.ts

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2238 can affect console/src behavior or maintainability. Primary boundary: console/src; broader effects remain subject to focused lead verification.

## #2239: refactor(fleet): split auth, lifecycle, and message handlers out of routes/ops.ts

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2239 can affect console/src behavior or maintainability. Primary boundary: console/src; broader effects remain subject to focused lead verification.

## #2240: DRY: migrate fleet HTTP route tests to shared HTTP mocks

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P3`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P3`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2240 can affect tests/fleet/routes behavior or maintainability. Primary boundary: tests/fleet/routes; broader effects remain subject to focused lead verification.

## #2241: SSOT: centralize transport adapter reason codes

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Exact target review found the named adapter health reason strings still repeated across iMessage, Signal, Twilio, and the in-memory transport; the existing transport error-code registry does not govern these health reason codes. PR #2336 retains the iMessage poll-auth-failure literal and does not centralize the contract. API, SSH, and origin main remained exact at 487bad4e64da457f6d601168fe43fcb49d9648b4; the complete 13-file changed test set passed 188/188. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2241 can affect src/transport/contract behavior or maintainability. Primary boundary: src/transport/contract; broader effects remain subject to focused lead verification.

## #2242: SOC: move generic fleet time utilities to src/lib

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 13 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2242 can affect console/src behavior or maintainability. Primary boundary: console/src; broader effects remain subject to focused lead verification.

## #2243: DRY: replace duplicated test logger fixtures with a shared logger mock

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P3`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P3`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2243 can affect tests/runtimes/agent behavior or maintainability. Primary boundary: tests/runtimes/agent; broader effects remain subject to focused lead verification.

## #2244: SSOT: unify InboundStatus and InboundProcessingStatus

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2244 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2245: SSOT: align provider parity snapshot validation with canonical probe states

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2245 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2247: audit-lense: R13 batch — 4 closed issues audited, all closures still valid, latent risks noted

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2247 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2248: observability: heartbeat watchdog ignores reachable degraded runtime health

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P3`, `SSOT`, `audit`
- Recommended labels: `P3`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. PR #2455 adds continuity_gap_open and continuity_gap_unreadable as health degradation causes, while the watchdog and its decisive test are byte-identical. The unchanged test explicitly treats HTTP 200, status=degraded, connected=true, auth clean as an empty problem set. Thus the issue survives and the ignored cause set expands. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Current-target health changes add more explicit degradation causes, strengthening rather than closing the failure-vocabulary finding. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Implement the issue's cause-set episode observer and include real health-handler fixtures for continuity_gap_open and continuity_gap_unreadable.

### Impact and blast radius

Unresolved scope described by issue #2248 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2249: tech-debt: CircuitState triple-duplication across 3 files - name collision between circuit-breaker state machine and incident-rate-limit record

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SSOT`, `alerts`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2249 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2250: tech-debt: getInboundStatus widens to string - escape hatch defeats the canonical InboundStatus union at the SQL boundary

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2250 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2251: tech-debt: PROBE_STATE_VALUES validator set missing 2 type members - not_required and unknown rejected despite being valid ProviderParityProbeState values

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SSOT`, `audit`, `bug`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2251 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2252: tech-debt: xdgDir SSOT re-implemented 5 times with 3 different fallthrough operators (??, ||, truthy) - 2 sites violate XDG empty-string spec

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `P3`, `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Current main retains the canonical xdgDir helper and the named inline XDG reads with divergent nullish and falsy fallthrough behavior. #2204 is a narrower duplicate of this record. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Move or expose the XDG resolver from the shared ring, migrate the named callers, and add an exact no-inline-read guard.

### Impact and blast radius

Empty XDG values can resolve differently across startup, fleet, and credential-storage paths. Startup paths, fleet configuration paths, and keyring storage resolution.

## #2253: tech-debt: asRecord/requireString validator clones across 6 files - SSOT is partial (only safe coercer, no throwing variant) forcing 6 re-implementations

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `DRY`, `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Current main still contains the named local validator families. Merged PR #2366 added another local asRecord implementation in safeguard diagnostics rather than extending the shared type-guards surface, so the consolidation gap survives the main delta. Exact-main source enumeration at af753d288faab9e1f7258a318f9f739433804cfe found seven asRecord definitions across the cited validator family: one shared helper and six local reimplementations. The changed safeguard path still owns a local clone, so the SSOT gap is verified. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Extend the shared type-guard surface with the smallest throwing record/string primitives required by existing callers, migrate one bounded caller cohort at a time, and preserve current error contracts with focused tests.

### Impact and blast radius

Unresolved scope described by issue #2253 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2254: tech-debt: JSON.parse(JSON.stringify( used 14 times as deep-clone - use Node 22+ structuredClone() instead

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `P3`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `P3`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2254 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2257: portability: 'which' ffmpeg probe fails on minimal Linux (Alpine/busybox)

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P3`, `bug`, `linux`, `portability`, `tech-debt`
- Recommended labels: `P3`, `bug`, `invalid`, `linux`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the live metadata and exact pin. Current main no longer invokes execFileSync('which', ['ffmpeg']). Startup calls resolveBinaryPath('ffmpeg'); the shared resolver scans process.env.PATH using the platform delimiter and checks each candidate with X_OK. Focused resolver tests cover missing, non-executable, and executable PATH candidates. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta, so the fixed conclusion remains current. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Close as fixed after the focused resolver and bootstrap behavior is confirmed on the supported Linux and macOS environments.

### Impact and blast radius

The reported minimal-Linux startup failure no longer reproduces in current source because executable discovery is performed internally against PATH. Startup transcription capability discovery on minimal Linux and other hosts whose executable search path does not include an external which program.

## #2258: portability: /proc/self/fd read has no platform gate — FD health metric silently null on macOS

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P2`, `bug`, `portability`, `reliability`, `tech-debt`
- Recommended labels: `P2`, `bug`, `portability`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, five current labels, timestamp, URL, and body hash while API and SSH main remained exact. The pinned getOpenFileDescriptorCount implementation returns null before any filesystem read when process.platform is not linux. Its focused runtime test invokes the private measurement and expects null on non-Linux. The 3ea8934-to-pin delta intersects runtime.ts, but current source inspection confirms the platform gate survives unchanged in behavior. This directly contradicts the live title and the source registry's surviving finding. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2258's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Close the issue as already fixed after the final identity, exact-main, focused-test, and complete pull-request-census gates.

### Impact and blast radius

The reported portability defect is no longer present; retaining it as active implementation work would duplicate completed behavior and misdirect ownership. Agent runtime health measurement and its non-Linux focused test.

## #2259: portability: mktemp -t flag is GNU-deprecated and semantically different on BSD/macOS

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P3`, `bug`, `linux`, `portability`, `tech-debt`
- Recommended labels: `P3`, `bug`, `invalid`, `linux`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata and exact pin. All three historical mktemp -t calls in scripts/cutover.sh have been replaced by explicit ${TMPDIR:-/tmp} templates ending in XXXXXX. No mktemp -t invocation remains in cutover.sh or check-launchd-drift.sh. The focused portability test rejects mktemp -t and requires the three portable templates. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Close as fixed after rerunning the portable-template regression and shell syntax checks.

### Impact and blast radius

The reported GNU-versus-BSD mktemp flag incompatibility is absent from the current cutover and drift-check surfaces. Cutover temporary-file creation on GNU, BSD, and macOS mktemp implementations.

## #2260: portability: safeguard-diagnostics emits GNU 'timeout' snippet unavailable on macOS

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P3`, `bug`, `portability`, `tech-debt`
- Recommended labels: `P3`, `bug`, `invalid`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the live metadata and exact pin. Safeguard diagnostics and the quality workflow now resolve TIMEOUT_BIN through scripts/resolve-timeout-bin.sh. That resolver prefers gtimeout, falls back to timeout, and fails with an explicit macOS Coreutils prerequisite when neither exists. The focused test verifies resolver selection and workflow wiring. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2597 at exact API and SSH main f0ece2d18883a66f04892a46669b3547e5bdf2b1 inspected every intersecting workflow, baseline-growth guard, and focused-test path. Its exact-revision measurement and fail-closed ancestry checks preserve existing waiver behavior and do not alter this issue’s finding, classification, owner boundary, or dependency order.

### Suggested remediation

Close as fixed after the resolver test is rerun on supported macOS and Linux command surfaces.

### Impact and blast radius

The operator-facing remediation no longer blindly emits a GNU-only command on macOS. Operator remediation commands and CI browser-install time bounds across macOS and Linux.

## #2261: fix(qsesh): distill append-ordered sessions with non-monotonic timestamps

- Classification: `leaf`
- Evidence state: `live-revalidation-required`
- Confidence: `low`
- Current labels: `P3`, `bug`
- Recommended labels: `P3`, `bug`
- Dependencies: None

### Evidence

Open draft PR #1984 explicitly references this issue and changes the decisive qsesh distillation source and tests.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2261 can affect tools/qsesh/qsesh behavior or maintainability. Primary boundary: tools/qsesh/qsesh; broader effects remain subject to focused lead verification.

## #2279: durable background work: wire registration write-path + delivery daemon (PR1b)

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `reliability`
- Recommended labels: `P3`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2279 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2280: observability: require child-state proof before clearing aggregate service-health incidents

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P2`, `SSOT`, `bug`, `console`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `console`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2280 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2281: reliability(dispatcher): fence queued incident delivery by durable episode state

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P2`, `SSOT`, `reliability`
- Recommended labels: `P2`, `SSOT`, `alerts`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2281 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2282: observability(dispatcher): bind storm digests to immutable membership snapshots

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `SSOT`, `console`, `fleet`
- Recommended labels: `P3`, `SSOT`, `console`, `fleet`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2282 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2284: fragility: imsg-port has no socket 'end'/'close' handler — pending RPCs hang 30s on graceful daemon close

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `P2`, `bug`, `reliability`, `tech-debt`, `transport`
- Recommended labels: `P2`, `bug`, `invalid`, `reliability`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

PR #2336 directly fixes the headline claim: the socket connection now installs terminal error, end, and close handlers, clears timers, rejects every pending RPC immediately, and records write-phase ambiguity where applicable. Focused graceful-close and terminal-failure coverage is present, and the complete 13-file changed test set passed 188/188 at exact API, SSH, and origin main 487bad4e64da457f6d601168fe43fcb49d9648b4. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2284 can affect src/transport/imessage behavior or maintainability. Primary boundary: src/transport/imessage; broader effects remain subject to focused lead verification.

## #2288: durability: incident-breaker and process-lock state lack validated crash-safe persistence

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `bug`, `reliability`, `tech-debt`
- Recommended labels: `P2`, `audit`, `bug`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current title, labels, timestamp, body SHA-256, and exact pin. Incident-breaker uses one fixed sibling .tmp name, default creation permissions, writeFileSync, and renameSync without file or parent-directory fsync; corrupt persisted state is converted to a fresh untripped and unescalated state. Process-lock uses an exclusive mode-0600 temporary payload and atomic hard-link publication, but it does not fsync the payload before linking or the parent directory after authoritative namespace changes. Private-fs is the positive control and implements private exclusive staging, file fsync, atomic rename, and parent-directory fsync with ordering tests. Existing incident-breaker and process-lock tests cover logical persistence, exclusion, ownership, corruption, races, and reclaim behavior but not the required crash-durability ordering. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Move incident-breaker persistence onto the established private atomic writer with fail-safe corruption behavior. Preserve process-lock hard-link exclusion while fsyncing its payload before link publication and durably syncing authoritative parent-directory changes.

### Impact and blast radius

A crash or power loss can lose or ambiguously publish safety state, while corrupt breaker state can silently reset trip and escalation markers that should remain fail-safe. Crash durability and fail-safe recovery for private incident-breaker and process-lock control state.

## #2289: fragility: transport async-rejection and error-isolation gaps (rejectCall, pollOnce, imsg-port, staging cleanup)

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P2`, `bug`, `reliability`, `tech-debt`, `transport`
- Recommended labels: `P2`, `bug`, `reliability`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Exact review of PR #2336 confirms that its iMessage slice now terminates pending RPCs on socket end or close and contains poll failures inside the adapter error/state path. Those changes fix part of the multi-boundary tracker, but the auth-bond rejectCall, connection, Signal, Twilio, and staging-cleanup claims were not changed by this merge and require their named falsifiers. API, SSH, and origin main remained exact at 487bad4e64da457f6d601168fe43fcb49d9648b4; the complete 13-file changed test set passed 188/188. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2289 can affect src/transport behavior or maintainability. Primary boundary: src/transport; broader effects remain subject to focused lead verification.

## #2290: fragility: unguarded JSON.parse in beads + stdout UTF-8 boundary corruption in agent session

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `P2`, `bug`, `reliability`, `tech-debt`
- Recommended labels: `P2`, `bug`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Merged PR #2382 fixed the beads JSON parse finding, leaving the separate stream UTF-8 boundary concern; the original multi-finding report is therefore partial. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2290 can affect src/core/substrate behavior or maintainability. Primary boundary: src/core/substrate; broader effects remain subject to focused lead verification.

## #2292: fragility: 16 lower-severity hygiene findings (error swallowing, resource cleanup, loop-prepared SQL)

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `P3`, `reliability`, `tech-debt`
- Recommended labels: `P3`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2292 can affect src/core/substrate behavior or maintainability. Primary boundary: src/core/substrate; broader effects remain subject to focused lead verification.

## #2295: fragility: replace unsafe configuration coercions with one validated schema boundary

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, two current labels, timestamp, URL, and body hash while API and SSH main remained exact. Current config.ts still parses INSTANCE_CONFIG as Record<string, any>, casts path and numeric properties, and uses permissive intEnv parseInt behavior; agent-config-validator remains a separate validation surface. The 3ea8934-to-pin delta intersects both source files and adds validated provider-policy fields, but does not eliminate the named unsafe anchors. The headline's exact 3 HIGH, 11 MED, and 10 LOW inventory was not fully re-enumerated at this pin, so the tracker survives with current source anchors but its old counts remain inconclusive. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found a partial validation-surface change: optional knowledgeProfiles.*.minScore is accepted only when numeric and finite, with a positive merge test. The change does not replace the raw Record<string, any> parse, unchecked path or numeric casts, permissive intEnv parseInt behavior, or the split validator/runtime contract. The tracker remains inconclusive and its advertised severity counts remain unsafe to reuse without a complete current-tree inventory. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Parse raw instance configuration once through a strict typed schema, use full-string bounded numeric parsing, validate path strings before filesystem use, and make the validator and runtime loader share the same contract.

### Impact and blast radius

Malformed configuration can pass one validation surface and reach runtime through unchecked casts or truncated numeric parsing, causing divergent startup and operational behavior. Instance JSON parsing, paths, rate limits, model and provider options, startup validation, operator error reporting, and configuration-focused tests.

## #2296: portability/fragility: console/ directory audit — 6 MED (Linux-only XDG paths in wizard, clipboard insecure-context, lint-frozen Linux paths) + 11 LOW

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `console`, `portability`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 10 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2296 can affect console/eslint-rules behavior or maintainability. Primary boundary: console/eslint-rules; broader effects remain subject to focused lead verification.

## #2297: portability/fragility: deploy/ directory audit — 4 HIGH (repo-path hardcode, macOS-only watchdog, stat -f, GNU readlink) + 5 MED + 2 LOW

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `alerts`, `portability`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 4 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2297 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2298: portability: scripts/ + .github/workflows/ audit — 4 MED (sha256sum, find -printf, hardcoded home path, Apple-Silicon python) + 7 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 8 pinned-tree paths; those paths were read from the pinned revision during this bounded audit. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2298 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2299: portability: tools/ + plugins/ + phonectl/ audit — HIGH: qsesh hard-refuses Linux (single-line darwin gate on otherwise-portable tool) + 3 MED + 4 LOW

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 4 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2299 can affect tools/agent-runtime-probes behavior or maintainability. Primary boundary: tools/agent-runtime-probes; broader effects remain subject to focused lead verification.

## #2300: portability: src/ final sweep — MED: transcription binary resolver ignores PATH (2nd sibling of #2257, not fixed by PR #2293) + 3 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `bug`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata and exact pin. The headline MED finding is fixed: local-audio now scans PATH, verifies X_OK, and main reuses resolveBinaryPath('ffmpeg') rather than invoking an external which program. The current source therefore contradicts the title's primary open claim. The historical record did not enumerate the advertised three LOW findings as independently falsifiable partial findings, so their count and disposition cannot be carried forward without a fresh current-tree sweep. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found substantial iMessage inbound, lifecycle, and RPC-relay changes in adapter.ts, but no change to the fixed PATH-aware transcription resolver or the still-unenumerated three LOW tracker claims. The existing partial finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Remove the fixed headline item from open scope, perform a bounded current-tree re-enumeration of each LOW finding, and retain only independently reproducible portability work with focused tests.

### Impact and blast radius

Leaving the fixed headline in the tracker overstates current portability debt, while carrying an unenumerated LOW count risks scheduling stale or duplicate work. Source portability audit tracking across transcription startup and the fleet and transport adapter surfaces named by the original sweep.

## #2301: test-portability: hardcoded /tmp paths + shared hardcoded mock paths (~45 files) instead of os.tmpdir()+mkdtempSync — collision/isolation risk

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata and exact pin. All six recorded test paths exist at the pin, disproving the historical record's contradictory two-missing-path finding. Hardcoded /tmp use survives in the qsesh runner tests, BOT ERRORS health tests, heal unit and integration fixtures, and stuck-reply drain tests; media tests also retain explicit /tmp fixture assumptions. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Migrate mutable test fixtures to unique directories beneath os.tmpdir or an injected root, centralize cleanup, and add parallel collision tests before updating the repository-wide count.

### Impact and blast radius

Literal and shared temporary paths can fail on nonstandard hosts, collide under parallel execution, and leave mutable fixtures coupled across tests. Cross-platform test execution, parallel isolation, temporary-state cleanup, and reproducibility on systems whose temporary directory is not /tmp.

## #2302: test-fragility: external-binary deps without skip-guards (npm, sqlite3 CLI) + port-binding TOCTOU race in fleet index test

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `SSOT`, `audit`, `bug`, `chat`, `fleet`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 3 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the test-portability-fragility boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span tests.

## #2303: test-fragility: 9 chmod-permission tests missing root-skip guard — fail under UID 0 (containers, CI root, Docker dev)

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `SSOT`, `audit`, `bug`, `chat`, `config`, `fleet`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 10 of 10 cited file path(s) were present on pinned main; 10 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the test-portability-fragility boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span tests.

## #2304: test-portability: platform-specific assumptions (transcription skip-gate macOS-only, clipboard mock leak, /home-only path test) + timer fragility

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata and exact pin. The historical browser-motion path is corrected from a nonexistent .ts file to the present .tsx file. A new CI-runnable transcription-chain test resolves a virtual ffmpeg through PATH, fixing part of the coverage gap, while the real transcription integration still gates on /opt/homebrew/bin/ffmpeg and Homebrew whisper paths. Activity-feed tests replace navigator.clipboard through a shared global helper, build-tool-update fixtures assume /home paths for key shortening behavior, and the browser-motion helper polls with a 16 ms wall-clock sleep. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. The obsolete browser-motion exit test was replaced by b5-motion-policy.test.tsx using deterministic waitFor behavior; that timing sub-finding is fixed while the broader portability tracker survives. A final live pull-request reread corrected PR #2492 from open to merged; its path overlap remains collision-only and does not close the broader portability tracker. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the shared executable resolver in the real transcription integration gate, isolate clipboard globals, add representative home-root fixtures, and replace wall-clock polling with deterministic completion or fake-clock controls.

### Impact and blast radius

Platform-specific gates can silently skip integration coverage, leaked browser globals can couple tests, host-shaped paths can hide portability regressions, and wall-clock polling can flake under load. Cross-platform transcription integration coverage, shared browser globals, path rendering fixtures, and timer-sensitive test reliability.

## #2321: portability/fragility: src/runtimes + docker audit — 1 HIGH (macOS -home- transcript path) + 2 MED + 1 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P5`, `portability`
- Recommended labels: `P5`, `audit`, `bug`, `chat`, `mcp`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 7 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. Body-free live identity reads and all main authorities remained stable at 29fe568cdfbb25475340268571d1818da64395ef. Target session.ts still constructs Claude transcript paths with the Linux-shaped literal -home-${username}; PR #2488 touches only outbound minimal-mode presentation among this record's paths and does not alter transcript derivation or the other tracker boundaries. The confirmed macOS finding survives; remaining tracker findings still require their issue-specific falsifiers. PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2321's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the portability-audit boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2322: portability/fragility: src/transport/ audit — 2 HIGH (Linux-only /var/run lock, imsg socket leak) + 6 MED + 4 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P5`, `portability`
- Recommended labels: `P5`, `audit`, `bug`, `chat`, `config`, `portability`, `security`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Exact target review confirms that PR #2336 fixes the named iMessage socket-lifecycle HIGH finding with terminal end/close rejection and focused tests. The hard-coded system auth-lock fallback remains, and the remaining poll, blocking-wait, direct-exit, host-attribution, endpoint, and LOW tracker claims were not comprehensively revalidated by this iMessage merge. API, SSH, and origin main remained exact at 487bad4e64da457f6d601168fe43fcb49d9648b4; the complete 13-file changed test set passed 188/188. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the portability-audit boundary; impact details remain governed by the live issue acceptance contract. No decisive repository file path was safely extractable from the public issue body.

## #2323: portability/fragility: src/mcp + src/memory + src/lib audit — 3 MED (incident-breaker tmp collision, socket path-length, bot-errors-outbox silent swallow) + 4 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P5`, `portability`
- Recommended labels: `P5`, `audit`, `bug`, `mcp`, `portability`, `reliability`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata and exact pin. All four historical source paths exist, removing the old contradictory missing-path evidence. Incident-breaker still publishes through shared ${file}.tmp without private exclusive creation or durability. MCP socket-server calls listen with the configured path and has no preflight for Unix-domain path length. The current BOT ERRORS outbox no longer silently swallows its primary write failure: it attempts a durable write-failure breadcrumb and rethrows the original error. The media source delta identified by the earlier audit is unrelated to these headline findings. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2490 at exact API and SSH main 4a2b1f2dcf058ed8138508dbf192643088f2fed3 confirmed that malformed JSON-RPC logging now emits only bounded structural diagnostics and has focused private-payload byte-absence coverage. That privacy fix does not add the surviving Unix-domain socket-path length preflight, alter the incident-breaker staging finding, or change this record's owner boundary and dependency order. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use the private atomic writer for breaker state, add an explicit Unix-domain socket path-length preflight, retain outbox breadcrumb plus rethrow behavior, and separately revalidate each remaining LOW item.

### Impact and blast radius

A shared breaker temp name can collide or be redirected, and an overlong socket path fails late with platform-shaped behavior; stale outbox wording can also misstate current failure truth. Incident-breaker state publication, Unix-domain MCP socket startup, BOT ERRORS outbox failure truth, and the remaining MCP, memory, and library portability audit scope.

## #2325: portability/fragility: src/mcp/tools full line-by-line read — 2 MED (groups chatJid!, voice unguarded writeTempFile) + 6 LOW; all 22 tool files now fully audited

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P5`, `portability`
- Recommended labels: `P5`, `bug`, `mcp`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata and exact pin. All seven historical source paths exist, removing the stale one-missing-path finding. In groups, chatJid remains optional in the schema and is asserted with const jid = chatJid! before the identity guard and send. In voice, synthesis failure is caught, but writeTempFile runs outside the send try/catch and can escape the tool's structured error path. The intervening messaging change only adds trusted-peer audience handling and does not change either headline MED anchor. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. An exact-main semantic rereview of merged PR #2488 at API, SSH, and origin main 29fe568cdfbb25475340268571d1818da64395ef found that its knowledge.ts changes add score filtering and structured result metadata only. The surviving send_group_invite chatJid non-null assertion and voice writeTempFile error-boundary defects and their decisive tests are unchanged. The six LOW findings remain subject to separate live revalidation. The existing partial finding and owner boundary survive; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Add an explicit group-invite destination guard, include temp-file creation in the voice tool's structured failure boundary, prove no-send behavior under both failures, and separately revalidate the LOW inventory.

### Impact and blast radius

A missing group destination can flow through a non-null assertion into policy and send code, while a local temp-write failure can bypass the voice tool's structured failure response. MCP group-invite target validation, voice-note tool failure handling, and the broader completed line-by-line MCP tool audit inventory.

## #2327: cleanup(console): SaveContactDialog is dead code after v3.5's intentional removal; HistoryTab still shows a save toast that saves nothing

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P4`, `dead-code`, `refactor`
- Recommended labels: `P4`, `bug`, `chat`, `dead-code`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 4 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span console, docs, tests.

## #2330: audit-coverage: file-level manifest for head-to-toe inspection (anchored to 52102435)

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P3`, `audit`
- Recommended labels: `P3`, `audit`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, two current labels, timestamp, URL, and body hash while API and SSH main remained exact. The issue is a historical file-level coverage manifest explicitly anchored to 52102435, not a current-main completion receipt. The required pin contains 3,289 tracked files and thirteen current package, pinned-runner, TypeScript-config, and Vitest-config paths; the old wildcard registry paths are replaced here with exact Git paths. These decisive paths are byte-identical from 3ea8934 to the pin, but that byte proof cannot re-attest full-tree inspection or historical dependency and pull-request dispositions. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead rerun of git ls-tree at af753d288faab9e1f7258a318f9f739433804cfe counted exactly 3,281 tracked files; the historical 52102435 ledger remains partial evidence rather than a current-tree completion receipt. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. The exact e82e61fc54762f852bb480bf43eb04094141bc6f git tree contains 3,281 tracked files after PR #2452 added three continuity-audit source/test files. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. The exact 5759471a09b45d4727d9489ba0581fa23c972f30 git tree contains 3,281 tracked files after PR #2455 added three continuity-ledger source/test files. A lead-integrated semantic rereview of merged PR #2490 at exact API and SSH main 4a2b1f2dcf058ed8138508dbf192643088f2fed3 confirmed that its socket log-redaction source change and one new focused test do not alter this issue's finding, classification, owner boundary, or dependency order. A fresh git-ls-tree count at the exact pin contains 3,281 tracked files. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 counted 3,289 tracked files, seven more than parent 29fe568cdfbb25475340268571d1818da64395ef. The package.json change only registers imsg:relay and does not re-attest the historical coverage manifest; the partial tracker finding survives collision-only with its exact current-tree count updated. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A current exact-tree inventory contains 3,325 tracked paths; the historical manifest remains a partial inventory and the broader drift-control finding survives. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. The exact target tree contains 3,327 tracked files; the historical coverage manifest remains partial rather than a current-tree completion receipt. A final live pull-request reread corrected PR #2492 from open to merged; its motion-config overlap remains collision-only and does not re-attest the historical full-tree coverage manifest. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Retain the old manifest as historical evidence and generate a new exact-pin git-ls-tree coverage ledger with explicit status, owner, evidence, and dependency fields for every tracked file.

### Impact and blast radius

Treating a historical manifest as current can hide newly added or changed files and propagate stale issue, dependency, and ownership conclusions. Repository-wide audit coverage, TypeScript and Vitest configuration, pinned runtime invocation, dependency inventory, issue dispositions, and any completion claims derived from the historical manifest.

## #2331: portability: src/ root-level entry/bootstrap files audit — 1 LOW (Obsidian hardcoded path), closes root-file coverage gap

- Classification: `tracker`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P5`, `portability`
- Recommended labels: `P5`, `portability`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, two current labels, timestamp, URL, and body hash while API and SSH main remained exact. Exact git-ls-tree enumeration finds twelve root-level src files, replacing the source registry's ambiguous src/*.ts path with the explicit list. Current config.ts still defaults the memory vault to a HOME-relative Documents/Obsidian/whatsoup-memory path. The 3ea8934-to-pin delta intersects docs/configuration.md and config.ts, but fresh source inspection confirms the default remains. The prior body called the table an eleven-file inventory although it enumerated twelve; this replacement removes that internal drift while retaining the verified low-severity portability finding. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found only knowledge-profile minScore documentation, parsing, and test changes on the recorded paths. The default vaultPath still resolves to HOME/Documents/Obsidian/whatsoup-memory, so the portability finding and root-file inventory conclusions survive unchanged. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Choose a platform-neutral configured or XDG-derived memory default, preserve explicit user overrides and migration behavior, and generate the root-file audit inventory from git-ls-tree.

### Impact and blast radius

A desktop-specific default can create or search the wrong memory location on nonstandard, headless, or non-Obsidian installations. Root bootstrap and configuration coverage, memory-path resolution and migration, documentation, startup tests, and portability audit accounting.

## #2333: ops(auth): canonicalize single-flight, state-verified interactive provider recovery

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P3`, `bug`, `ops`
- Recommended labels: `P3`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `dead-code`, `ops`, `portability`, `reliability`, `security`, `tech-debt`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. The provider-health classifier, keychain healer, and macOS deployment runbook are byte-identical across the exact delta. PR #2455 changes only the continuity-manifest section of docs/runbook.md and adds no diagnose-before-mutation, single-flight login ownership, state verification, cancellation, or bounded restart contract. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Implement the canonical interactive provider-recovery state machine and deterministic acceptance suite.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, docs.

## #2340: observability: expose content-free active execution-holder age and progress freshness

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `fleet`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2341: observability: add success-based cadence health for scheduled release-proof producers

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 6 of 6 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2342: observability: classify health-port authority drift before probing instance outage

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `config`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30. PR #2455 changes the health payload but leaves both bot-errors health-check and heartbeat-watchdog scripts byte-identical. Exact main still has no effective-port parity or drift predicate, so profile/live disagreement can still be misclassified as an outage. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Implement the shared fail-closed effective-port authority proof before probing endpoint liveness.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2343: durability: anchor maybe_sent dwell to the current ambiguity episode

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2353: test-portability: verify:push:branch suite flakes on ≤4-core hardware (maxWorkers:4 + 10s testTimeout CPU-starves phantom-deps scan)

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P5`, `portability`, `tech-debt`
- Recommended labels: `P5`, `bug`, `config`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the test-portability-fragility boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span scripts, vitest.config.ts.

## #2354: agent: extended fallback windows can drop retained replay-safe turns

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`, `scheduler`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the agent-runtime-reliability boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2355: reliability(fleet): alert-suppression episodes mishandle clock skew and lifecycle exits

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: #2447, #2533, #2534

### Evidence

Three stable live reads spanning 26 seconds pinned open issue #2355 to node I_kwDOR1Sep88AAAABKILa9Q, the current title, four labels, update time, URL, and exact 4,145-byte body hash while local origin/main and the SSH remote main remained at 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. The current registry contains zero #2355 entries because its 2026-07-26T22:40:49Z capture predates the 2026-07-27T00:33:53Z reopen. All five decisive source and test paths are byte-identical to that pinned main. The throttle-store freshness predicate accepts any finite future timestamp because it tests only now minus timestamp below the interval; an isolated reserved-value canary loaded an entry exactly one day in the future with no load error. The poller repeats that one-sided comparison, records episode onset and duration with wall time, drains episodes only on stop, reason change, or a later unsuppressed emit attempt, and does not close them from healthy recovery, source-supersession, or asset-removal transitions. Merged PR #2389 remains a valid partial: it bounds per-poll logging to O(1) transitions but explicitly leaves delivery and clock eligibility unchanged. The three cited focused suites passed 157 of 157 tests under the repository-pinned runtime; their source covers normal forward time, stale or invalid storage, reason changes, expiry, and stop, but not future timestamps, rollback, recovery-before-expiry, supersession, removal, or remove and re-add. Direct open-PR reference search found no current implementation owner. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. LoopLagSampler now handles a discontinuity class, which is partial progress; throttle and episode-lifecycle gaps remain. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define one typed throttle-clock classifier that is shared by store load, persistence, and poller decisions; use injected monotonic time for same-process eligibility and duration, apply a bounded explicit wall-clock policy after restart, and route recovery, supersession, removal, reason change, expiry, and shutdown through one typed episode-close operation. Preserve the merged O(1) logging and ordinary alert-delivery semantics while adding bounded metadata-only skew and lifecycle transition evidence.

### Impact and blast radius

A valid timestamp left in the future after wall-clock rollback can suppress an alert far beyond the declared fifteen-minute interval, an open episode can publish negative duration, and recovery or asset removal can leave stale per-key state resident until shutdown or later key reuse, merging logically separate suppression episodes and misrepresenting active suppression. Fleet alert-throttle eligibility across restart and clock discontinuity; suppression-episode duration, recovery, source supersession, asset removal, remove and re-add, shutdown summaries, and bounded operator diagnostics.

## #2356: fix(bot-errors): default reminder cap disables still-open exponential backoff

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2357: Preserve human directive bodies in slash-prefixed multi-line messages

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2358: observability: separate probe provenance from target service provenance in alert envelopes

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `fleet`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2363: test: remove fixed-time child PID race from new-command ownership coverage

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P3`, `reliability`
- Recommended labels: `P3`, `SSOT`, `audit`, `bug`, `chat`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The focused ownership test uses a fixed parent-thread wait before reading a child-created process record. The live issue includes a bounded Node 25 reproduction history and explicitly treats isolated passes as non-clean. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use an event-driven fixture signal or the existing bounded wait helper and preserve exact child ownership and cleanup.

### Impact and blast radius

A contention-sensitive test can fail a quality lane without proving a production ownership defect. The new-command ownership test and Node 24/25 full-suite quality lanes.

## #2373: alerts: preserve maintenance severity and fail visibly when the sink rejects an event

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `config`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2384: substrate: give overdue bead proposals a bounded terminal lifecycle

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `bug`, `reliability`, `scheduler`
- Recommended labels: `P2`, `alerts`, `audit`, `bug`, `chat`, `config`, `mcp`, `reliability`, `scheduler`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, src.

## #2385: observability: correlate persistent multi-asset release drift into one member-aware fleet episode

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, scripts.

## #2386: security(alerts): make BOT ERRORS evidence metadata-only at the emission boundary

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `IN PROGRESS`, `P0`, `audit`, `bug`, `reliability`, `security`
- Recommended labels: `IN PROGRESS`, `P0`, `alerts`, `audit`, `bug`, `chat`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 9 of 9 cited file path(s) were present on pinned main; 1 cited test path(s) and 9 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2387: observability: model irreversible turn outcomes as immutable events instead of recoverable incidents

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 12 of 12 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2388: alerts: provider_unknown_terminal is incorrectly declared auth_terminal and carries auth-only recovery semantics

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, five current labels, timestamp, URL, and body hash while API and SSH main remained exact. Current taxonomy declares provider_unknown_terminal as a source and disposition of auth_terminal with confirmed-outbound-within-window recovery proof. The classifier recognizes only auth_terminal, while the turn-result handler emits provider_unknown_terminal for an explicitly unclassified terminal provider error. The 3ea8934-to-pin delta intersects runtime.ts but not the decisive registry, classifier, or handler; fresh exact-pin inspection confirms the mismatch, and the prior exact-pin taxonomy/recovery-focused suite passed while encoding current behavior. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. PR #2455's two continuity health causes widen the canonical taxonomy and health projection but do not resolve this issue's surviving cross-contract, source-policy, or health-semantics gap. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2388's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Add a distinct provider-unknown-terminal fault class with bounded evidence and explicit retry, recovery-proof, alert-clear, incident-breaker, and durability behavior; reserve auth_terminal for proved authentication loss.

### Impact and blast radius

Unclassified provider failures can be diagnosed and cleared as authentication failures, applying the wrong recovery proof and obscuring their real cause. Fault taxonomy, provider terminal handling, alerts, incident breaking, genuine recovery, durability evidence, fleet health gating, and operator diagnosis.

## #2390: alerts: standing incidents can auto-close while recovery proof is still pending

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `dead-code`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 9 of 9 cited file path(s) were present on pinned main; 2 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src, tests.

## #2392: observability(fleet): aggregate withheld recovery-clear diagnostics instead of logging every poll

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `fleet`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2393: alerts: flap-storm consolidation re-pages critical on a fixed 30-minute cadence without backoff

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `fleet`, `refactor`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2394: alerts: restart loses recovery-clear authority for process-local incident sources

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 14 of 14 cited file path(s) were present on pinned main; 1 cited test path(s) and 11 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 was semantically rereviewed across all 13 paths merged by PR #2455. The merged continuity rows persist one new incident class, but process-local incident recovery-clear authority and the alert lifecycle remain unchanged; PR #2455 is collision-only. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30: PR #2455 changes health aggregation only; it does not change any affected alert producer, process-local latch, checked-clear ownership, dispatcher reconciliation, or focused restart/retry test. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2394's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Create restart-safe exact-source recovery obligations using canonical contributor predicates. Arm ownership only after checked alert acceptance, retain it until checked clear acceptance, and allow fresh contributor-specific recovery proof to reconcile prior-process incidents without cross-clearing independent sources. Add restart, alert-rejection, clear-rejection, retry, idempotency, and bounded-evidence tests.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src, tests.

## #2395: alerts: clear agent_turn_finalization_failed after all retained finalizations recover

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2397: alerts: agent_respawn_failed can be cleared by an unrelated conversation recovery

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2398: agent: finalization escapes can block a scope without a durable retry owner

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `bug`, `reliability`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the agent-runtime-reliability boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2399: alerts: fallback prerequisite incidents have no contributor-aware recovery lifecycle

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2400: alerts: successful provider diagnostics open a separate critical incident

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 1 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2401: alerts: handoff-distill recovery is per conversation but incident identity is asset-wide

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2402: alerts: daily-health member alerts and recovery clears use divergent incident identities

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2403: alerts: flush and retry pending stale-autoclose digests without requiring another closure

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `dead-code`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2404: alerts: GUI-session monitor observes recovery but never clears its incident

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `config`, `portability`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2405: alerts: clear remote-writefail-ack-failed after all remote ack failures recover

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2406: alerts: substrate-inline-hook incidents never clear after verified database recovery

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2407: alerts: operator-actionable runtime tool failures are auto-closed as self-corrected

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 2 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src, tests.

## #2408: alerts: distinguish MCP probe failures from missing tools and bind inventory expectations to a runtime contract

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, four current labels, timestamp, URL, and body hash while API and SSH main remained exact. Current tool_inventory returns the entire REQUIRED_TOOLS list as missing when the socket is absent or json_rpc tools/list throws, so transport and protocol failure is represented as valid inventory absence. The required list is independently sourced from BOT_ERRORS_REQUIRED_TOOLS defaults rather than a runtime-exported registration contract. A deterministic prior falsifier forced json_rpc failure and reproduced both the probe failure and the full missing-tool set. All decisive and test paths are byte-identical from 3ea8934 to the required pin. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Return a typed inventory result that separates probe status from observed names and missing names, export a versioned runtime tool contract, and make health checks consume that contract fail closed.

### Impact and blast radius

Transport outages can page as tool-removal incidents, while an independently maintained expectation list can drift from the runtime and create false positives or false negatives. BOT ERRORS daily health, MCP socket and JSON-RPC probing, runtime tool registration, alert classification, operator diagnosis, and inventory regression tests.

## #2409: alerts: connected health degradation is blanket-downgraded without cause-aware impact classification

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `fleet`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. Exact-main tracing at af753d288faab9e1f7258a318f9f739433804cfe confirms that PR #2451 exports and registers bounded health causes, but deploy/scripts/bot-errors-dispatcher.py still classifies every connected health_body_degraded event as transient without consulting the cause's impact. The blanket downgrade is therefore verified. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. PR #2455's two continuity health causes widen the canonical taxonomy and health projection but do not resolve this issue's surviving cross-contract, source-policy, or health-semantics gap. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Fleet health now carries more cause-aware classification, but the dispatcher blanket downgrade remains unresolved. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Generate cause-aware alert impact from the canonical registry, require an explicit unknown/high-impact default, and add connected benign, high-impact, malformed, and multi-cause classifier tests.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2410: heal: crash single-flight conflates provider routes and retains the first route's attribution

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `bug`, `reliability`
- Recommended labels: `P2`, `SSOT`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2412: alerts: pinecone_degraded lacks contributor-aware recovery across operations

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. Exact-main tracing at af753d288faab9e1f7258a318f9f739433804cfe shows a process-wide alertedOperations set, but trackSuccess(operation) deletes one contributor and immediately clears pinecone_degraded even when another operation remains alerted. Typed safe telemetry does not repair contributor-aware recovery, so the finding is verified. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Track active Pinecone degradation contributors independently, derive shared alert state from the complete contributor set, and clear only after every active contributor has recovered or expired under an explicit policy.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2413: alerts: auth-terminal recovery clears only the quarantine symptom and orphans the root incident

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 1 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2414: alerts: outbound_flood can lose lifecycle ownership on failed emission or sustained-flood restart

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2415: alerts: scheduler de-link hold latches before delivery and never clears on relink

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `reliability`, `scheduler`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2416: alerts: llm_total_failure conflates failed chat turns with proven all-route outage

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 1 cited test path(s) and 3 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2417: alerts: forbidden-target trigger retirement lacks recovery and failed-emission ownership

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `mcp`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2419: alerts: relay_host_recovered does not close surfaced relay_host_down incidents

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2420: alerts: remote writefail harvest clears before the failed record recovers

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2421: alerts: meta dead-letter incident never closes after final audited disposition

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2422: alerts: runner drops launch exceptions before durable failure emission

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `config`, `reliability`, `security`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2424: alerts: accepted notifications can replay after crash before dispatcher state commit

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2425: alerts: deadman records rejected notifications as sent and failed recovery as resolved

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2426: alerts: browser-debug visibility loss falsely clears active unattended-session incidents

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2427: collector: require stable event identity across remote acknowledgement retries

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. Current source and history review confirms lifecycle identity is still derived across mutable queue names and lacks one canonical terminal inventory with acknowledgement retry convergence. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2428: alerts: flap detector counts delivery retries as distinct fault trips

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `chat`, `reliability`, `transport`
- Dependencies: None

### Evidence

Current dispatcher source scans every ready outbox event and unconditionally records a flap trip without retaining a durable occurrence identity. Existing flap tests exercise distinct direct trip calls, not one requeued event across repeated scans. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Persist a bounded occurrence-identity ledger independent of notification attempt state and keep ambiguous identity fail-safe toward preserving the original alert.

### Impact and blast radius

One repeatedly rejected notification can manufacture a storm and suppress its own original alert. Dispatcher outbox scanning, flap state, storm aggregation, retry handling, and member suppression.

## #2429: alerts: destructive state replacement can orphan active incident lifecycles

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 2 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the controller-state-integrity boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2430: alerts: recovered-before-delivery suppression drops daily-health freshness

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2431: alerts: heartbeat watchdog clears incidents outside conclusively evaluated scope

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `config`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2432: alerts: fleet sentinel watchdog ignores fresh non-green aggregate health

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 3 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2434: alerts: failed legacy fallback is throttled into a false success

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2435: alerts: dispatcher retries accepted email fallbacks and dead-letters them as undelivered

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2436: deploy: macOS fleet-sentinel jobs drop supported runtime controls

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P3`, `bug`, `deploy`
- Recommended labels: `P3`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `deploy`, `fleet`, `portability`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2437: alerts: malformed delivery metadata permanently blocks the dispatcher queue

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2438: alerts: sentinel reports a capped action-outbox depth when pruning fails

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `fleet`, `portability`, `reliability`, `security`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2439: alerts: verbose event formatting truncates evidence and requested action

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `config`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2440: collector: recover writefail leases across processing-directory fallback changes

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `bug`, `reliability`
- Recommended labels: `P2`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2441: collector: writefail claim collisions can acknowledge the wrong payload

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P2`, `SSOT`, `bug`, `reliability`
- Recommended labels: `P2`, `SSOT`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2444: Continuity gap: linked-device logout can lose inbound history with no detectable or supported catch-up path

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P3`, `bug`, `chat`
- Recommended labels: `P3`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Body-free live identity remained stable while API and SSH main both resolved to 5759471a09b45d4727d9489ba0581fa23c972f30. Merged PR #2452 supplies the bounded read-only independent-history audit. Merged PR #2455 adds explicitly confirmed fingerprint-only persistence for absent, observed-not-admitted, and ambiguous receipts plus content-free continuity health and exhaustive taxonomy registration. This fixes detection and lands part of durable visibility, but exact-head runtime review proved that the recorder masks outer rollback failure, classification changes create duplicate logical gap identities and inflated counts, and permanent started rows can erase the existing latest-recovery health timestamp. The merge still has no controlled normal-ingress catch-up or terminal reply closure. Issue #2444 therefore remains partial and open. Pinned Node 24 focused validation passed 188 tests with no static test-integrity findings, and all hosted checks later passed; those checks did not falsify the three runtime defects. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found only imsg:relay registration on this record's intersecting paths. The PR's iMessage transport relay does not implement WhatsApp continuity receipt identity, controlled catch-up, durable gap health, or terminal-reply closure; all existing partial findings survive collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Repair the merged continuity ledger by preserving outer rollback failures, deriving one stable logical identity per receipt, and excluding unresolved continuity rows from unrelated latest-recovery semantics. Then implement a separately confirmed catch-up lane bound to normal admission, provenance, idempotency, delivery proof, and terminal closure.

### Impact and blast radius

The issue reports a public leaf concern in the continuity-gap-recovery boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span scripts, src, tests.

## #2445: Same-chat supersession is not fail-closed: a newer cancellation can queue while stale work continues

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P3`, `bug`, `chat`
- Recommended labels: `P3`, `bug`, `chat`, `reliability`
- Dependencies: #2235, #2334

### Evidence

Live issue body was inspected in full and hashed. 6 of 6 cited file path(s) were present on pinned main; 2 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state. The queue_halted fail-closed path is adjacent partial progress, but same-chat admission, mutation, and terminal-send supersession fences remain unproven. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the same-chat-supersession boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2447: Observability: runtime, durability, health, and alert taxonomies lack a canonical cross-contract and drift guard

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`
- Dependencies: #2147, #2409

### Evidence

Live issue body was inspected in full and hashed. 9 of 9 cited file path(s) were present on pinned main; 1 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state. Exact-main rereview at af753d288faab9e1f7258a318f9f739433804cfe found that the merged taxonomy cross-contract and memory domain resolve the canonical-domain and terminal-projection portion of this tracker. Complete emitted-source policy coverage (#2147) and cause-aware alert impact (#2409) remain, so the tracker is partial and stays open. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. PR #2455's two continuity health causes widen the canonical taxonomy and health projection but do not resolve this issue's surviving cross-contract, source-policy, or health-semantics gap. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Current health changes introduce additional inline status-reason vocabulary without a single registry-derived producer and consumer contract. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Finish the remaining #2147 source-policy inventory and #2409 cause-aware alert projection against the landed v2 registry, then run the bidirectional cross-contract and consumer-specific falsifiers.

### Impact and blast radius

The issue reports a public tracker concern in the failure-taxonomy-cross-contract boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, src, tests.

## #2453: database: make forward migration reservations machine-readable and conflict-checked

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `tech-debt`
- Recommended labels: `P4`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free live reads pinned the open identity, two current labels, timestamp, URL, and body hash while API and SSH main remained exact. The current schema version is migration 47, implemented in database-migration-47.ts. Provider-event lifecycle prose now reserves forward migrations 48 and 49 after the earlier 46-to-47 advance, but no machine-readable reservation manifest or conflict guard exists in source or migration-safety tests. Every decisive and test path is byte-identical from 3ea8934 to the required pin. This verifies that the allocation numbers moved while the underlying reservation-control gap survives. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. The current schema version is 48 and the forward reservations are 49 and 50; the machine-readable reservation registry and conflict guard are still absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Add a versioned migration-reservation manifest and a guard that reconciles it with the current schema constant, migration files, pending specifications, and migration-safety tests.

### Impact and blast radius

Concurrent work can reserve or implement the same migration number, force late renumbering, or let prose allocations become stale without a failing gate. Database schema versioning, migration files, pending provider-event and terminal-recovery work, migration tests, release sequencing, and rollback planning.

## #2454: Guard follow-up: decide whether to require numeric validation before shell integer tests

- Classification: `measurement-only`
- Evidence state: `inconclusive`
- Confidence: `high`
- Current labels: `P3`, `SSOT`, `refactor`
- Recommended labels: `P3`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The bounded shell Node -e/-p measurement found no second vulnerable numeric capture. Merged pull request #2450 fixed the sole concrete defect, and exact current-main source plus a write-free FORCE_COLOR mutation canary prove the focused behavior. The remaining open record is a prevention-policy decision, not another verified implementation defect.

### Suggested remediation

Either add a narrow structural rule requiring validated numeric output before shell integer tests at machine-output boundaries, or close this measurement-only issue with the zero-additional-occurrence evidence preserved.

### Impact and blast radius

Without an explicit disposition, the repository retains an ambiguous prevention-policy task after the only demonstrated push-blocking defect has already been fixed. Cited public repository paths span console, deploy, tests.

## #2457: Operator catch-up CLI emits raw recovery identifiers despite redacted-output contract

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `IN PROGRESS`, `P0`, `audit`, `bug`, `reliability`, `security`
- Recommended labels: `IN PROGRESS`, `P0`, `SSOT`, `audit`, `bug`, `ops`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 was semantically rereviewed across all 13 paths merged by PR #2455. The new record-continuity CLI emits bounded content-free output, but it does not change the existing operator catch-up CLI that emits raw recovery identifiers; the verified privacy finding survives. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30: PR #2455 adds a separate content-free continuity recorder but leaves scripts/close-recovery-catchup.ts, src/core/recovery-catchup-closure.ts, and their focused test unchanged. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found only an unrelated imsg:relay public-surface row. The recovery catch-up CLI, closure implementation, raw-identifier output contract, and decisive test remain unchanged; the finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Preserve exact private input validation while replacing raw dry-run, confirmed, repeat, and error output identifiers with omission, bounded counts, or deterministic domain-separated fingerprints. Add byte-absence, error-path, idempotency, and public-surface drift tests.

### Impact and blast radius

The issue reports a public leaf concern in the operator-cli-public-receipts boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, scripts, src, tests.

## #2458: Observability: release-drift launchd logs are timestamp-free, uncorrelated, and unbounded

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 2 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the ops-log-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, scripts, tests.

## #2459: Terminal BOT ERRORS relay archive has no retention contract and preserves stale queued state

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the ops-log-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2460: Queue backlog health and watchdog disagree on event age after retries

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the daily-health-lifecycle-census boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2461: Split BOT ERRORS contract documentation from stale deployment and topology history

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `audit`, `documentation`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `documentation`, `reliability`, `security`
- Dependencies: #2447

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 3 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-documentation-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, docs.

## #2462: Daily health has no durable receipt separating probe execution from health verdict

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the daily-health-lifecycle-census boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2463: Controller state corruption silently resets lifecycle truth and then appears healed

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Current-main collector and heartbeat-watchdog loaders replace unreadable state with empty defaults, while the dispatcher archives corrupt incident state but then also continues from empty lifecycle state. Later saves can make the replacement files appear syntactically healthy. Current source and historical review still finds state owners that can replace unreadable primary state with empty defaults; validated previous-generation recovery and explicit state_recovery_required remain absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use a versioned integrity-bound state envelope, retain a validated prior generation, and reconcile pending obligations before resuming mutation.

### Impact and blast radius

Open incidents, cooldowns, backoff, recovery contributors, and suppression state can disappear while fresh valid JSON appears healthy. Collector, dispatcher, heartbeat watchdog, controller health, incident lifecycle, and recovery.

## #2464: Consolidate drift-prone BOT ERRORS Python state and observability primitives

- Classification: `tracker`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `audit`, `reliability`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `config`, `fleet`, `refactor`, `reliability`, `security`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata and exact pin. Exact pinned source contains ten separate atomic JSON writer definitions across collector, dispatcher, emitter, health check, heartbeat watchdog, maintenance, q-loop, runner, self-check, and sentinel, plus five private JSONL appender definitions across collector, dispatcher, health check, heartbeat watchdog, and q-loop. The atomic-write guard requires inline implementations and therefore protects implementation quality while entrenching duplication. Only q-loop rotates JSONL before append. Queue-age semantics and threshold parsing differ across health and watchdog paths; corrupt state defaults silently in some producers while dispatcher archives it. Shared redaction primitives and a runtime manifest checker already provide foundations for a versioned deployed shared module. The source and guard paths are byte-disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Merged leaf-trust work added descriptor-confined and safe-read primitives, increasing the duplicated helper surface; nine principal JSON writers still lack one versioned shared durability contract. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2595 at exact API and SSH main c37df83897ce9cd02829289f9f05b01347e4b0de inspected every intersecting runtime-manifest, sentinel-pin, and focused-test path. The optional full-manifest digest helper does not alter this issue’s finding, classification, owner boundary, or dependency order; its overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Extract the selected contracts into one versioned manifest-tracked Python module, migrate producers incrementally, replace the inline-implementation guard with an anti-clone import guard, and preserve intentional semantic differences through explicit configuration and behavior tests.

### Impact and blast radius

Repeated filesystem and observability primitives can drift in durability, rotation, age calculation, threshold parsing, corruption handling, event identity, and deployed-bundle behavior, producing inconsistent safety outcomes across one operational subsystem. BOT ERRORS Python state publication, event append and rotation, queue-age and threshold semantics, corrupt-state handling, lifecycle inventories, redaction, deployment manifests, isolated runtime bundles, and rollback.

## #2465: Heartbeat watchdog silently accepts zero/unknown checks and refreshes false-green state

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `config`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the daily-health-lifecycle-census boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2466: BOT ERRORS has no declared macOS heartbeat-watchdog schedule despite parity claim

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2465

### Evidence

Current main lists and enables the heartbeat watchdog for systemd, while the standard launchd installer renders only dispatcher, deadman, and health jobs. The 21-test service-template suite passes while asserting that smaller macOS job set, confirming the parity gap is not covered by an expected watchdog fixture.

### Suggested remediation

Define one platform-and-role schedule matrix, then either render a role-safe watchdog LaunchAgent or test the declared external observer or not-applicable disposition.

### Impact and blast radius

A supported role can lack an independently scheduled watchdog while documentation implies equivalent coverage. BOT ERRORS installation, role-specific check selection, service templates, runtime readback, and operator documentation.

## #2467: GUI-session monitor reports success and erases coverage when fleet inventory is unreadable or empty

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: None

### Evidence

Current main converts missing, malformed, or non-object fleet data to an empty object in load_fleet. The scheduled run_once path accepts zero targets, saves empty state, and returns success, while config_check rejects the same conditions. No focused test asserts scheduled runtime failure for an invalid or empty fleet.

### Suggested remediation

Return a typed inventory result, preserve last-known-good ownership on invalid input, fail the cycle visibly, and emit a bounded coverage-gap and recovery receipt.

### Impact and blast radius

All external GUI-session coverage can disappear behind a successful zero-work cycle. Fleet inventory admission, GUI-session monitoring state, scheduled exit status, incident emission, and recovery.

## #2468: alerts: selfcheck accepts any fresh file as proof of central acknowledgement

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The sentinel writes a structured acknowledgement, but current-main selfcheck uses only regular-file metadata and modification time. Its positive test writes an empty object and expects central_acked; three focused selfcheck behavior tests pass, including that permissive assertion.

### Suggested remediation

Define a versioned proof-bound acknowledgement receipt and validate file safety, bounded JSON shape, subject, observation, roster, and ordering before advancing central_acked.

### Impact and blast radius

Any recently touched file can clear the local-only timer and manufacture false central continuity. Host selfcheck, central sentinel acknowledgements, central-down lifecycle state, and recovery.

## #2469: alerts: fatal selfcheck runs leave the prior central heartbeat healthy, then degrade to generic staleness

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: #2470

### Evidence

Normal selfcheck completion publishes a heartbeat before local memory and status. The fatal main exception path writes only local status and exits nonzero, and its focused test asserts no heartbeat outcome. The central consumer therefore retains the prior heartbeat until generic staleness.

### Suggested remediation

Allocate an observation before fallible work and converge every success or failure path on one idempotent terminal receipt that the central consumer classifies without replacing a known failure with generic staleness.

### Impact and blast radius

A fatal selfcheck can remain centrally healthy until the prior heartbeat expires, then lose the known failure cause. Selfcheck execution, local and pushed heartbeat state, sentinel classification, process exit, and recovery correlation.

## #2470: security(observability): selfcheck heartbeat centrally pushes raw identity, paths, and command output

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `IN PROGRESS`, `P0`, `audit`, `bug`, `reliability`, `security`
- Recommended labels: `IN PROGRESS`, `P0`, `alerts`, `audit`, `bug`, `reliability`, `security`
- Dependencies: None

### Evidence

Current-main heartbeat_payload copies host, root, problems, bundle, mismatch, verifier, freshness, and acknowledgement detail into the optional HTTP payload. default_push_heartbeat serializes and posts that object, and its focused test asserts exact raw field preservation. The central-down artifact copies the same detailed identity and acknowledgement fields.

### Suggested remediation

Separate local forensic state from a closed, versioned central telemetry schema; reject unknown central fields and free-form detail before HTTP, sentinel, action, log, retry, or alert surfaces.

### Impact and blast radius

Central telemetry can receive raw identity, filesystem, mismatch, verifier, and free-form diagnostic detail. Selfcheck status serialization, optional HTTP push, central sentinel input, central-down artifacts, logs, and future alert relays.

## #2471: alerts: fleet-sentinel remediation and escalation outbox has no consumer

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2386

### Evidence

Current sentinel source writes remediation, escalation, recovery, and notification-budget artifacts, returns their references, and prunes the directory, but declares no claim or delivery consumer. The q-loop has no request handler, and the installer schedules only evaluator and watchdog jobs. Twenty-one focused action-outbox, Tier-2, and redemption tests pass while exercising producer and manual redemption behavior rather than an end-to-end consumer.

### Suggested remediation

Define one consumer and authority for every lane with atomic claims, leases, idempotent action identity, accepted or ambiguous outcomes, terminal-only retention, and independent consumer health.

### Impact and blast radius

Remediation tokens, heal candidates, recovery events, and human-critical eligibility can remain inert while the sentinel reports attention. Fleet sentinel action production, q-loop remediation, notification delivery, retention, scheduler health, and rollout gates.

## #2472: deploy: selfcheck scheduler masks configuration and omits supported runtime controls

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `config`, `ops`, `reliability`
- Dependencies: None

### Evidence

Current selfcheck reads five controls absent from both scheduler renderers. The systemd renderer loads the optional environment file before explicit install-time assignments for neighboring keys, so empty assignments mask later file values; launchd snapshots only its rendered subset. Shell syntax and the installer fixture pass, but that fixture injects asserted values and does not test unset-install-time precedence or complete runtime-key parity.

### Suggested remediation

Define one typed selfcheck configuration inventory, resolve precedence once, render equivalent scheduler contracts, and emit a bounded effective-configuration receipt.

### Impact and blast radius

Heartbeat, acknowledgement, manifest, and timeout controls can be configured yet disabled or defaulted in the scheduled process. Selfcheck scheduler installation, environment precedence, platform parity, runtime readback, and outage diagnosis.

## #2473: alerts: sequential sentinel sweep can publish a stale, incoherent aggregate snapshot

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2468, #2469

### Evidence

Current sentinel samples its clock once, then probes the roster serially and reuses the cycle-start value for every freshness check, transition, acknowledgement, action, and aggregate timestamp. Per-probe timeouts exist, but neither source nor scheduler defines a total cycle deadline or completed-observation interval. Twenty-one focused probe, timeout, heartbeat, and cycle tests pass without a multi-member elapsed-time coherence case.

### Suggested remediation

Define a total deadline below the freshness budget, bounded probe concurrency, per-observation timing, publication-time freshness, and a terminal partial or failed receipt when budget expires.

### Impact and blast radius

A completed aggregate can be stale at publication or accept a host signal that expired during the serial sweep. Fleet sentinel probing, aggregate heartbeat, acknowledgements, actions, instance locking, watchdog freshness, and rollout capacity.

## #2474: alerts: unlink-after-unlock splits sentinel/selfcheck advisory locks

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `alerts`, `bug`, `reliability`
- Recommended labels: `P2`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: #2464

### Evidence

Current selfcheck closes its flock descriptor before unlinking the lock path, and current sentinel explicitly unlocks and closes before unlinking. Existing focused tests prove ordinary contention, holderless-file recovery, and immediate reacquisition, but do not force a contender to acquire the old inode between release and unlink. Nine focused lock, heal, and post-deploy-adjacent tests passed.

### Suggested remediation

Keep a stable lock pathname and release only the advisory lock, distinguish contention from acquisition failure, and add deterministic handoff, crash, unsafe-path, and permission tests.

### Impact and blast radius

Two sentinel cycles or selfcheck heals can overlap while both believe they hold the exclusive lock. Sentinel state, actions, acknowledgements, selfcheck deployment, heal budgeting, and terminal receipts.

## #2475: selfcheck: deployer exit zero is reported as healed without post-mutation proof

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: #2469, #2474

### Evidence

Current selfcheck skips runtime verification on root drift, calls the deployer, and immediately records the heal and returns action healed when the command exits zero. The deployer verifies materialized files but the selfcheck does not re-run its available runtime verifier or service checks after mutation. Existing tests assert zero-exit becomes healed; nine focused relevant tests passed without post-mutation proof.

### Suggested remediation

Separate command success from content, runtime, service, and recovered-state proof; persist bounded interrupted outcomes and correlate every stage to one action and desired-state generation.

### Impact and blast radius

A no-op, partial, or false-success deployment can be reported as recovered and consume the heal budget while drift remains. Selfcheck status, heartbeat classification, process exit, heal rate limiting, service-manager attention, and recovery history.

## #2476: selfcheck: file repair is called healed without activating or proving the loaded runtime generation

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `deploy`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `deploy`, `reliability`
- Dependencies: #2475

### Evidence

The current deployer explicitly materializes twelve managed files without restarting services, while selfcheck promotes its zero exit directly to healed. The managed set includes long-running Python daemons and one-shot or application-owned paths with different activation semantics. Current service inventory is observed before mutation and does not prove a repaired generation was loaded. Nine focused adjacent tests passed, but no materialize-to-activate generation proof exists.

### Suggested remediation

Define a versioned per-path activation manifest with authority, activation class, rollback, loaded-generation proof, and bounded unknown outcomes.

### Impact and blast radius

The filesystem can be clean while long-running processes continue executing the pre-repair generation. BOT ERRORS daemons, scheduled jobs, application release ownership, selfcheck recovery claims, and rollout evidence.

## #2480: selfcheck: non-Git approved-head fallback is dropped during the in-lock trust recheck

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `deploy`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `deploy`, `reliability`
- Dependencies: None

### Evidence

At current main, the initial selfcheck observation loads approved_heads and passes it to verify_pin_trust, while the in-lock pre-heal recheck reloads only approved_f10 and omits approved_heads. A deterministic second-cycle non-Git fixture reproduced initial approved-head trust followed by action current_changed, zero deploy calls, and pin_changed_during_heal despite an unchanged manifest. Six adjacent approved-head and in-lock tests pass, but none combine the non-Git fallback with the second-cycle heal path. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2595 at exact API and SSH main c37df83897ce9cd02829289f9f05b01347e4b0de inspected every intersecting runtime-manifest, sentinel-pin, and focused-test path. The optional full-manifest digest helper does not alter this issue’s finding, classification, owner boundary, or dependency order; its overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use one load-and-verify generation primitive for initial, in-lock, and post-mutation observations; pass the same trust inputs at every stage and classify generation change separately from trust or approval failure.

### Impact and blast radius

Approved non-Git runtime trees can detect safe drift but repeatedly refuse recovery as a false current_changed condition. Host selfcheck recovery admission, approved-head fallback, heal hysteresis, recovery receipts, and operator diagnosis.

## #2481: ops: rollout proof does not block live runtimes that are missing merged health invariants

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P2`, `audit`, `deploy`, `ops`, `reliability`
- Recommended labels: `P2`, `audit`, `deploy`, `ops`, `reliability`
- Dependencies: #1876, #2341

### Evidence

At exact SSH origin/main a91f5301266fae2049cd1ae1b3c1b236a7ea2aa8, the health producer degrades recently relied-on stale model evidence and publishes exact degradation causes and source commit provenance. The standalone classifier also rejects stale model evidence. The release manifest declares source commit, tracked files, and required outputs; the cutover gate admits active plus healthy with inventory, profile, health-port, and monitor-membership checks; and the sentinel reduces runtime verification to healthy/class/verifyRc. None of these rollout consumers compares an approved generation capability set with the active generation. The main change after the issue body was written touches only design-regression guard files, so it does not alter this finding. The issue body supplies two sanitized live probes, but this audit did not independently re-probe a live runtime. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 was semantically rereviewed across all 13 paths merged by PR #2455. PR #2455 adds another merged health invariant without adding release capability admission or proving live runtimes expose it, so the rollout-proof finding survives and its blast radius grows. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30: PR #2455 supplies another concrete merged health invariant that lacks rollout capability admission. It does not implement any issue-owned release gate. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. New health invariants are adjacent evidence, but they are still not represented by a rollout-admitted contract. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define a versioned metadata-only capability manifest and per-role minimum policy. Use one fail-closed comparator for candidate admission, active-generation readback, post-cutover canaries, fleet classification, rollback selection, and the continuity-gap invariants added by PR #2455. Support approved divergent histories through authenticated generation capabilities rather than main ancestry.

### Impact and blast radius

A running runtime can remain green on behavior known to omit a merged health invariant, delaying rollout remediation and forcing manual commit comparison during incidents. Release snapshot planning, cutover and rollback admission, runtime health classification, fleet sentinel aggregation, rollout evidence, and self-heal activation proof.

## #2482: alerts: queue lifecycle renames return success without crash-durable namespace commit

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2427

### Evidence

At pinned main, normal remote claim has two os.replace calls and no directory sync, while normal remote acknowledgement has one os.replace call and no directory sync. Dispatcher claim and reclaim each rename then sync only the destination parent; accepted, suppression, test-leak, storm-collapse, and other terminal paths lack a complete two-parent post-mutation commit, and dead-letter removes the processing claim without syncing its parent. The stronger write-failure terminal helper syncs both parents, providing a positive control. Both decisive source files are unchanged from the revision cited in the issue. No open pull request touches the decisive source or test paths; merged PR #2115 addressed save-before-terminal-move ordering but not cross-directory namespace durability. Merged leaf-trust hardening improves read confinement but does not provide durable local and remote lifecycle transitions, both-parent barriers, cross-filesystem publication, or ambiguous-state reconciliation. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce one shared lifecycle-transition primitive for collector and dispatcher that confines source and destination parents, handles same-filesystem and cross-filesystem moves, syncs every changed parent before durable success, returns an explicit unknown outcome after ambiguous mutations, reconciles by stable identity, and emits bounded body-free receipts. Route every mover through it and enforce the contract with structural and fault-injection tests.

### Impact and blast radius

An acknowledged remote event or accepted local notification can regain an earlier claimable name, lose its terminal disposition, or produce conflicting queue censuses after sudden failure. Blind retry can amplify the ambiguous state into duplicate delivery or duplicate terminal evidence. BOT ERRORS collector and dispatcher outbox, processing, relay-processing, relayed, sent, suppressed, quarantine, test-leak, collapsed, retry, write-failure, and dead-letter lifecycles; restart reconciliation; relay retry semantics; and public operational receipts.

## #2483: alerts: deadman and watchdog treat freshly failed dispatcher cycles as healthy

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2482

### Evidence

At pinned main, the dispatcher publishes a fresh failed cycle receipt after each caught cycle exception. A deterministic synthetic canary held service, socket, and freshness controls healthy while failed=1: heartbeat watchdog returned no dispatcher problem and deadman returned success and reported healthy, while daily queue inventory warned on the same failure evidence. Eighty relevant Python tests passed, but no existing focused test asserts the fresh-failed-cycle contradiction. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2595 at exact API and SSH main c37df83897ce9cd02829289f9f05b01347e4b0de inspected every intersecting runtime-manifest, sentinel-pin, and focused-test path. The optional full-manifest digest helper does not alter this issue’s finding, classification, owner boundary, or dependency order; its overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define one versioned dispatcher cycle receipt and parser with independent freshness and execution-verdict predicates, bounded failure stage/class, validated counts, last successful cycle, consecutive failures, queue generation, and durable lifecycle outcome. Route daily inventory, heartbeat watchdog, deadman, and status output through the same verdict and require conclusive-success hysteresis before recovery.

### Impact and blast radius

A deterministic poison event or internal error can fail every dispatcher cycle while both independent supervisors remain green, delay detection until backlog age trips, and incorrectly clear an earlier dispatcher incident from freshness alone. Dispatcher cycle-state publication, daily queue inventory, heartbeat-watchdog supervision, deadman recovery, backlog escalation, runtime manifests, and bounded operational receipts.

## #2485: alerts: atomic state writers report success when parent-directory sync cannot start

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2463, #2464, #2482

### Evidence

At origin/main a91f5301266fae2049cd1ae1b3c1b236a7ea2aa8, a deterministic AST census found all nine principal atomic JSON writers flush and fsync file content and atomically replace the target, then mask OSError while obtaining the parent-directory descriptor: three inline and six through fsync_parent. Existing selfcheck and sentinel tests explicitly exercise the ignored-open-error contract. The only change from the issue's original pin touches design-regression files outside this evidence surface. Current review still finds principal JSON writers that can report ordinary success after parent-directory durability becomes unproven; one typed certainty and stage contract remains required. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Extract one versioned, deployable durable-write primitive that returns a bounded stage result and treats required parent-directory open or sync failure as durability_unproven, never ordinary success. After a rename, reconcile stable generation or event identity before retry; make best-effort persistence an explicit weaker API with metadata-only diagnostics; migrate the nine callers under one fault matrix, bundle manifest, structural drift guard, and coherent rollback contract.

### Impact and blast radius

A caller can publish queued, saved, healthy, healed, or recovered success after the target becomes visible but before the namespace update is proven durable, allowing a sudden restart or storage fault to erase state that later decisions treated as committed while producing no bounded durability diagnostic. File-backed BOT ERRORS event publication and controller state across emitter, runner, collector, dispatcher, daily health, heartbeat watchdog, q-loop, selfcheck, and sentinel; downstream queue, suppression, recovery, health, and escalation decisions can inherit the false durable-success result. No production state was inspected or mutated.

## #2486: health: unavailable active-service inventory is treated as complete empty coverage

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: None

### Evidence

At pinned main, active_whatsoup_service_names selects launchctl for both macOS and WSL, returns an ordinary empty set after a missing command or timeout, and parses stdout without rejecting a nonzero command result. unprofiled_service_inventory receives only that set and therefore cannot distinguish proven zero active services from unavailable observation. A synthetic canary confirmed WSL selected launchctl, a nonzero result with one synthetic service was accepted, and a timeout normalized to empty. The existing positive undeclared-service test passed. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2595 at exact API and SSH main c37df83897ce9cd02829289f9f05b01347e4b0de inspected every intersecting runtime-manifest, sentinel-pin, and focused-test path. The optional full-manifest digest helper does not alter this issue’s finding, classification, owner boundary, or dependency order; its overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Return one versioned typed active-service observation with bounded status, backend, counts, freshness, and exit/error class; allow profile coverage to pass only from a fresh observed result. Select the backend through the same platform capability contract as per-service liveness, keep service names local to comparison, and expose only metadata-safe aggregate receipts.

### Impact and blast radius

An active undeclared runtime or stale health-profile omission can disappear whenever inventory discovery fails, while WSL can select an unsupported backend and still produce the same apparently complete empty result. Daily BOT ERRORS profile coverage, platform service-manager selection, active-runtime inventory, undeclared-service detection, fleet aggregation, and bounded daily-health evidence.

## #2487: observability: BOT ERRORS proof probes emit contradictory success from invalid or absent sources

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Exact current-main source inspection and in-memory exact-blob canaries reproduced both contradictions: malformed managed-component entries become parsed zero while all seven advertised consistency checks remain green, and absent manifest/policy sources remain missing in source_status while their component evidence is unconditionally present with nonexistent references. The generic runtime-host profile is absent, while the committed tree contains role-specific profiles. Existing focused tests explicitly preserve malformed-as-empty behavior and check source status separately from component evidence.

### Suggested remediation

Introduce one versioned typed source-observation contract shared by both probes; derive source status, component evidence, references, counts, consistency, gaps, and report verdict from it. Resolve static expectations through the canonical role/profile inventory, separate report serialization success from evidence validity, and add an opt-in strict mode that fails closed.

### Impact and blast radius

Consumers can receive opposite conclusions from the same receipt: malformed or absent policy artifacts can appear as a valid empty observation or present static proof, while valid role-specific expectations appear permanently missing. This weakens automated gates, traceability, and remediation decisions. Metadata-only BOT ERRORS audit receipts, health-surface consistency summaries, proof-ladder component evidence, static expectation routing, downstream evidence consumers, and strict/gate automation. No live service, queue, credential, message, host, or private topology was observed.

## #2503: observability: tree-provenance --fetch can clear from stale refs after refresh failure

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `deploy`, `ops`, `reliability`
- Dependencies: None

### Evidence

At the pinned main revision, gather_tree_provenance records fetch_attempted and a bounded fetch_error, but provenance_findings never evaluates either field. A deterministic in-memory failed-refresh snapshot therefore produced zero findings, info severity, a clear event, clean stdout, exit zero, and no fetch outcome in the event projection. The exact focused test file passes 31 tests but contains no failed-refresh classification or event-contract regression. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2595 at exact API and SSH main c37df83897ce9cd02829289f9f05b01347e4b0de inspected every intersecting runtime-manifest, sentinel-pin, and focused-test path. The optional full-manifest digest helper does not alter this issue’s finding, classification, owner boundary, or dependency order; its overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Model comparison mode and refresh verdict as separate typed dimensions, map requested refresh failure to an explicit bounded inconclusive or warning finding, qualify clear on sufficient evidence for the selected mode, project privacy-safe fetch and observation fields into JSON and events, and keep reporter mode offline and network-rejecting.

### Impact and blast radius

An explicit refresh request can falsely clear an existing provenance incident and report clean from stale cached refs after the evidence source failed to refresh, hiding network or authentication failures and misleading recovery diagnosis. The opt-in tree-provenance --fetch path, programmatic do_fetch callers, standalone event clear qualification, CLI evidence sufficiency, and runtime-manifest and runbook consistency. Scheduled reporter mode rejects fetch and is not directly affected.

## #2505: reliability: runtime-staleness emits recovery when a post-boot source file is deleted

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2481

### Evidence

At the pinned revision, both runtime-staleness implementations derive freshness from the newest mtime among files that still exist and silently skip absent critical entries. An in-memory command/stat adapter held process boot at epoch 900, changed the observed source set from a critical file at 950 to only a remaining file at 800, and the real deployed run_once path emitted alert then clear with exit 0 for both cycles. The 21 deployed-monitor and 6 manual-tool focused cases contain no deletion, source-set-completeness, timestamp-preserving replacement, or generation-qualified recovery case. All 38 current open pull requests were scanned; their file lists and closing references were fully paginated, with no exact-path overlap or issue reference.

### Suggested remediation

Define one typed runtime-generation observation contract shared by the deployed monitor and any retained manual adapter. Bind a complete desired source-set/content digest and approved release identity to active-process generation; distinguish match, mismatch, dirty or unmanifested change, missing, unreadable, and unknown; retain mtimes only as advisory evidence; and require a coherent active-generation transition plus readback before emitting clear. Keep emitted evidence bounded and privacy-safe.

### Impact and blast radius

A deleted or timestamp-preserving changed source can make a still-running old process appear current and emit a recovery clear without restart or generation transition. This can close an actionable incident, stop recovery, and conceal disagreement between loaded behavior and disk. The automated runtime-staleness alert/clear lifecycle and manual diagnostic for every monitored long-lived runtime are affected. The defect can misclassify recovery but does not itself perform a restart or service mutation.

## #2506: observability: BOT ERRORS event envelope permits contradictory lifecycle/severity states

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`, `type-safety`
- Dependencies: #2447

### Evidence

Exact pinned blobs preserve independent eventType/severity vocabularies, allow both clear spellings to carry critical severity, classify every clear as incident recovery, classify generic informational alerts as recovery-dedupe candidates, and omit error alerts from the recovery episode barrier. A write-free AST-extracted canary reproduced all three contradictory classifier outcomes and the CLI spelling mismatch. Exact changed-file pagination across all 38 open pull requests found no implementation owner; draft PR #2495 collides with dispatcher paths but preserves all five decisive classifier/formatter functions byte-for-byte. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce a versioned tagged BOT ERRORS envelope with one canonical validator and normalized semantic classifier. Validate before enqueue, quarantine unsupported schema-v1 inputs before incident mutation, give incident alerts, recoveries, and informational notices disjoint variants, normalize both clear CLI spellings, and migrate formatting, lifecycle, dedupe, storm, stale, dead-letter, replay, and metrics consumers to the shared result.

### Impact and blast radius

Contradictory or stale events can close incident state while displaying paging severity, informational notices can enter recovery-specific dedupe, and error alerts can reopen incidents without establishing the same episode barrier as warning or critical alerts. BOT ERRORS emission and durable queue ingress; dispatcher formatting, incident open/close state, recovery dedupe and storm behavior; stale, dead-letter, replay, and metrics handling; and operator-facing recovery evidence.

## #2507: alerts: lossy incident-key normalization lets distinct sources suppress or clear each other

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`, `type-safety`
- Dependencies: None

### Evidence

At the pinned revision, incident_key applies a lossy filename sanitizer independently to machine, instance, and qualified source before joining them, while emitters accept unrestricted nonempty identity strings. Durable open, cooldown, suppression, clear, flap, stale, queued-recovery, replay, and known-event operations consume that derived key, and helpers recover source semantics by splitting it. A write-free exact-blob canary reproduced both punctuation-normalization and 80-character truncation collisions: the first synthetic alert opened one incident, a clear for a distinct raw source was actionable, and the clear removed the first source's incident. A scan of 1,106 pinned test files found incident-key coverage in 12 files but no incident-identity collision case; the 38-case dispatcher integration file also lacks one. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2595 at exact API and SSH main c37df83897ce9cd02829289f9f05b01347e4b0de inspected every intersecting runtime-manifest, sentinel-pin, and focused-test path. The optional full-manifest digest helper does not alter this issue’s finding, classification, owner boundary, or dependency order; its overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define incident identity as a versioned bounded tuple with separate display labels. Use unambiguous length-prefixed encoding or a domain-separated digest plus stored-tuple verification for compact keys; validate source and qualifier vocabularies at ingress without making validation the sole collision defense; move every dispatcher consumer away from slug and split semantics; and dual-read or quarantine legacy state without merging histories, manufacturing recovery, resetting cooldowns, or losing exact clear ownership.

### Impact and blast radius

Distinct conditions can share suppression, cooldown, inhibition, renotify, severity, and evidence history, or one condition's recovery can retire another condition without recovery proof. Long dynamic qualifiers and ordinary punctuation, Unicode, boundary, empty-image, delimiter, and underscore variants can trigger the defect. BOT ERRORS durable incident identity; open and cooldown state; duplicate, inhibition, supersession, flap, stale and recovery logic; queued recovered-before-delivery handling; writefail and replay deduplication; state migration and rollback; producer ingress contracts; and operator evidence derived from incident keys.

## #2510: alerts: capture-only sink is production-reachable while reporting durably queued

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Recommended labels: `P1`, `alerts`, `audit`, `bug`, `config`, `deploy`, `ops`, `reliability`, `type-safety`
- Dependencies: #2391, #2447

### Evidence

Exact pinned blobs prove that any non-empty ambient WHATSOUP_ALERT_SINK enters capture before the durable outbox and legacy helper, appends one local record, and returns ok=true, channel=sink, status=durably_queued. observeAlertEmission then reduces that result to true. A write-free deterministic source canary verified the contract, found no sink validation in the managed wrapper, systemd unit, container entrypoint, bootstrap, or health projection, and checked six representative durability, incident-marker, transport-latch, scheduler-latch, and recovery-clear transitions that advance on the checked boolean. The focused sink test explicitly expects no outbox file, no helper spawn, and true. Exact pagination across all 38 open pull requests and 1,327 changed-file records found no owner or issue reference. Draft PR #2495 modifies the emitter for a separate protocol proposal but preserves the sink durably_queued result and lacks capture authority or startup exclusion. Two additional collision-only preservation PRs touch wrapper or health paths but their exact head refs contain a publication-prohibited private host label, so those ref values are withheld as null while public PR numbers, URLs, titles, states, and collision paths remain in this registry. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 was semantically rereviewed across all 13 paths merged by PR #2455. Continuity health does not alter alert capture-route authority or the production-reachable capture-only sink; the verified finding survives unchanged. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30: PR #2455 does not touch the alert emitter, capture outcome taxonomy, checked wrappers, startup guard, service definitions, wrappers, container entrypoint, or focused capture tests. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Split capture, dispatcher-owned durability, and transport acceptance into typed outcomes. Require verifier-scoped capture authority mutually exclusive with #2391 live-producer authority; fail normal startup when capture is ambient, scrub managed launch paths, expose bounded route validation in health, and preserve no-fallthrough behavior.

### Impact and blast radius

A production process that inherits the sink can record alert and clear obligations as satisfied while creating no dispatcher-owned event and making no operator-facing transport attempt. Lifecycle latches can suppress retries, quarantine and recovery gates can advance, and incident markers can be persisted or deleted on local capture alone. TypeScript alert emission and clear semantics; managed systemd, wrapper, container, and deployment-owned launch environments; startup and health observability; durability quarantine gates; transport and scheduler alert latches; fleet recovery clears; and restart-persistent incident ownership.

## #2511: recovery: one-shot restart marker can suppress a real crash or lose completion ownership

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2476

### Evidence

Exact pinned blobs show the request writes one marker before the checked request alert and service-manager invocation, deliberately retains it after a fast invocation rejection, and never records the alert result. Startup independently consumes and deletes that marker before an unchecked completion alert and before a process-local three-second delayed chat handoff. The OnFailure script independently deletes the same fresh marker and exits before gathering crash evidence. Twelve write-free exact-source assertions passed, and a content-free in-memory transition canary reproduced rejected-request crash suppression, rejected-request false completion, early replacement crash after destructive consumption, and either consumer starving the other. Current tests explicitly codify rejected-invocation retention, consume-and-delete, warning-only completion-ping rejection, and crash-alert suppression. Full pagination of 38 open pull requests, 42 changed-file pages, and 1,327 changed files found no implementation owner; four open pull requests collide with decisive paths without changing this transaction. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Replace the consume-once marker with a versioned opaque restart transaction whose phases distinguish recorded request, request-alert disposition, accepted, rejected, or unknown invocation, expected prior generation, replacement-generation and health proof, crash-classifier acknowledgement, completion-alert handoff, originating-chat journal and confirmation, retry ownership, expiry, and terminal disposition. Give each consumer an independent idempotent acknowledgement; a rejected invocation must close as failed without authorizing later crash suppression or completion.

### Impact and blast radius

A rejected restart request can suppress a later unrelated crash or be reported as completed by an unrelated startup. A genuine restart can lose crash classification or completion continuity depending on consumer order, and an early replacement-process crash can erase the only transaction evidence before either completion notification has durable ownership. Agent-triggered self-restart, service-manager invocation outcomes, startup continuity, OnFailure crash classification, BOT ERRORS request and completion alerts, originating-chat acknowledgement, retry behavior, stale-receipt expiry, and operator recovery evidence.

## #2512: guards: reject negated GitHub closing keywords in PR bodies

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`, `tech-debt`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Three stable body-free identity reads and matching API and SSH main reads established the current metadata, body SHA-256, labels, and exact pin. Current workflow, package, pre-push, publication, repository-hygiene, and focused-test surfaces contain no closing-keyword or pull-request-body detector. Changes since the historical registry pin add estate gating, object-ID support, catch-ratchet wiring, and triage publication classification, but none implements this issue's parser or enforcement boundary. The existing pre-push guard classifies ref updates, publication guard classifies repository file publication, and repository-hygiene reads candidate commit messages without checking closing directives. Every recorded path is disjoint from the exact 3ea893430bec8d96228da0cc2834db0eb8a13242 to pinned-revision delta. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found only the imsg:relay script entry in package.json. Closing-directive detection, PR-body enforcement, candidate-commit enforcement, and decisive tests remain unchanged; the finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact-range infrastructure is now available, but neither publication guard parses negated GitHub closing directives; the lifecycle-integrity gap survives. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2597 at exact API and SSH main f0ece2d18883a66f04892a46669b3547e5bdf2b1 inspected every intersecting workflow, baseline-growth guard, and focused-test path. Its exact-revision measurement and fail-closed ancestry checks preserve existing waiver behavior and do not alter this issue’s finding, classification, owner boundary, or dependency order.

### Suggested remediation

Add one bounded closing-directive parser for pull-request bodies and candidate commit ranges. Reject negated or disclaimer shapes, allow intentional closure only through a small machine-readable policy, fail closed on missing metadata, and emit only content-free bounded receipts.

### Impact and blast radius

A grammatically negative disclaimer can be interpreted by GitHub as an issue-closing directive when a pull request reaches the default branch, mutating planning state despite source and test gates passing. Issue lifecycle integrity for pull-request descriptions and candidate commit bodies across pre-push, pull-request CI, merge queue, default-branch integration, and release gates.

## #2513: reliability(logging): configured rolling-file sink can silently disappear or crash the process without health

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Two identical live captures established the issue identity, body hash, zero-label state, and timestamp. On pinned main, the logger swallows synchronous transport-construction failure into stdout-only operation, retains no ready/error/unexpected-close lifecycle owner, and lets a fixed timeout resolve flushLogger() without distinguishing confirmed close from timeout. Fleet log readers map a missing log directory or file to an empty result, BOT ERRORS only exposes a path hint, and top-level health has no logger-sink state. The write-free focused logger suite passed 28/28, including the silent synchronous fallback and success-shaped timeout behavior. Fully paginated file and closing-reference inventories for all 39 current open pull requests found 13 coordination collisions or references, but no open implementation owner for src/logger.ts or its focused tests; two merged logger test/serializer changes are historical attempts only. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 was semantically rereviewed across all 13 paths merged by PR #2455. Continuity health does not observe rolling-file transport construction, runtime failure, or sink disappearance; the verified logging-health finding survives unchanged. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30: No logger construction, worker lifecycle, flush result, log consumer, main startup, or focused logger test changed. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Give the rolling-file transport one explicit lifecycle owner with bounded disabled, starting, active, degraded, failed, closing, and closed states. Capture synchronous and asynchronous failures through a non-recursive receipt and health, define startup policy, return typed flush results, and qualify downstream log evidence.

### Impact and blast radius

A configured secondary sink can disappear while health remains green, leaving operators and consumers unable to distinguish legitimate empty evidence from a logger failure. An asynchronous worker failure can instead terminate the observed service, while shutdown can report completion after an unconfirmed flush. The direct boundary is TypeScript logger construction, worker lifecycle, and shutdown. Downstream effects include top-level health, fleet feed and log-data routes, BOT ERRORS evidence hints, startup admission, and any operator workflow that treats rolling files as durable diagnostics; stdout/journal logging must remain available without making sink failure recursive.

## #2514: health: database probe failures are published as measured zeros and inconsistent readiness causes

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2447

### Evidence

At the pinned revision, safeDbQuery catches every exception and returns a caller-selected fallback. The health producer uses zero for message count, pending access-list count, SQLite schema cookie, migration maximum, and past-due triggers, and null timestamps or identifiers for latest successful send; only pending polls carry an explicit readability bit. The existing focused health tests require both a dropped messages table and a successfully queried empty table to return HTTP 200 with messages_total=0. A content-free write-free canary reproduced the helper's failed and successful-empty branches as indistinguishable zero values. The pending WS-B01 plan and work index were read directly: they specify typed observations, nullable failed values, probe metadata, criticality, database-free instance liveness, and negative tests, while current source has not implemented HealthDbProbe or an instance /live route. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 was semantically rereviewed across all 13 paths merged by PR #2455. The new continuity probe has an explicit readable projection, but existing database probe fallbacks still publish measured-looking zeros and inconsistent causes; the verified finding survives. Exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30: The new continuity read is a sibling typed readable/unreadable observation and fails health closed, but every issue-owned safeDbQuery false-zero probe and its existing fallback test remains unchanged. This is not partial implementation of the existing-probe owner boundary. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2488 at target main 29fe568cdfbb25475340268571d1818da64395ef found that its sole recorded-path intersection documents unrelated knowledge-profile minScore behavior. Every decisive database-health source and test path is byte-identical, so the false-zero observation finding survives unchanged. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Public unauthenticated liveness is now database-free, but authenticated diagnostics still project fallback zeros without typed availability; the finding is partially narrowed, not closed. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Replace existing fallback-valued database reads with typed observations, null unavailable values, declare criticality, distinguish unavailable migration evidence from readable drift, add database-free process liveness, and coordinate probe vocabulary with #2447. Treat PR #2455's continuity probe as a sibling that also requires its separate defects corrected before reuse as an exemplar.

### Impact and blast radius

Operators, self-healing logic, and fleet consumers can treat unavailable database observations as measured emptiness, aggregate false zeros, erase prior-send uncertainty, or direct remediation toward schema drift when storage availability was never established. Instance health readiness and its SQLite-derived message, access-list, outbound-send, schema, migration, pending-poll, and past-due-trigger observations; fleet aggregation and self-healing consumers; instance-process liveness separation; and health-probe logging. No live database, instance, service, transport, or message state was inspected or mutated.

## #2517: security(fleet): raw exception prose and filesystem locations cross API and SSE response boundaries

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `IN PROGRESS`, `P0`, `SSOT`, `bug`, `fleet`, `security`
- Recommended labels: `IN PROGRESS`, `P0`, `SSOT`, `audit`, `bug`, `fleet`, `security`
- Dependencies: None

### Evidence

Two identical GraphQL reads established the live issue identity, title, body hash, empty label set, and timestamp while both the local SSH tracking ref and remote SSH main remained at the pinned revision. A deterministic pinned-source probe counted twelve route-local ops JSON constructions using errorMessage(), one raw child-process SSE message, three checkpoint errorMessage() responses, two raw log-detail responses, and one response each in silence and approvals; it also confirmed filesystem failures retain path plus raw prose, the generic HTTP wrapper exposes err.message, the fleet top-level catcher separately emits bounded internal error responses, the console API embeds complete non-2xx bodies in exceptions, and the operator page renders three such errors. The first ambient-runtime focused run was inconclusive because its native-module ABI did not match; the unchanged three-file suite passed 274/274 through the repository-pinned Node runtime. A complete 518-issue all-state scan and targeted historical review found closed #2178 and merged PR #2232 as normalization-only history, while merged PRs #1302 and #1818 provide narrower normalization and provider-presentation foundations. Fully paginated files and reference data for all 39 current open pull requests covered 43 changed-file pages, including four continuation pages, and found three collision-only path overlaps plus the registry pull request's issue reference, with no implementation owner. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce one fleet response-error module with a closed versioned projection for code, operation, stage, retryable, mutation_state, rollback_state, and correlation_id. Map unknown, filesystem, database, service-manager, child-process, proxy, and validation failures through explicit safe classifiers; keep raw diagnostics behind the private logging boundary. Migrate route-local JSON and SSE catches, the generic wrapper, proxy adapters, and top-level catcher without losing status or mutation truth. Change the console API to parse the projection and render registered impact and next-action text rather than arbitrary response bytes. Add reserved-marker exact-byte tests and a static construction guard, then coordinate shared vocabulary and availability semantics without merging this independently reviewable response boundary into logger or health ownership.

### Impact and blast radius

Authenticated callers can receive upstream exception prose, absolute locations, operation details, command or service context, stderr fragments, and other version-dependent content that escapes into console UI, screenshots, browser telemetry, and support artifacts. Prose-shaped responses also prevent reliable retry, rollback, and mutation-state decisions and couple the public response contract to every upstream exception producer. Authenticated fleet JSON and SSE responses, proxied error adapters, route-local validation and mutation failures, console API error parsing and operator-visible rendering, filesystem and log-source diagnostics, service and child-process operations, rollback truth, and internal response-to-diagnostic correlation. No live fleet response, service, process, queue, message, credential, configuration, or production filesystem surface was inspected or mutated.

## #2518: observability(logs): tail truncation, parse loss, and invented timestamps masquerade as complete current evidence

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `DRY`, `P2`, `SSOT`, `bug`, `console`, `reliability`
- Recommended labels: `DRY`, `P2`, `SSOT`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2447

### Evidence

Two identical GraphQL reads established the live issue node, title, body bytes and SHA-256, empty labels, URL, and timestamp. The local SSH tracking ref and exact SSH remote main both remained at the pinned revision. Every decisive source and test path is unchanged between that pin and the audit worktree. At the pin, readTailLinesDetailed reads at most the final 65,536 bytes from an arbitrary offset, decodes the buffer directly, filters split lines, and returns only ok plus lines; it exposes none of the requested coverage or fragment fields. The logs route silently skips every thrown parse or shape error, substitutes current time for missing or invalid event time, maps unknown numeric or nonnumeric severity to info, and returns a bare array. The feed parser returns the same null for malformed JSON, invalid or missing messages, declared noise, and ordinary suppressed information; its caller increments one suppressed counter for every null. It independently substitutes current time and maps an unknown numeric level to info while deriving isError from the raw threshold. The console API and UI accept only LogEntry arrays and therefore cannot render reader completeness or parser-loss provenance. A write-free in-memory canary through the real feed parser proved malformed input and intentional noise have the same result, an undated record receives observation time without a provenance field, and level 999 projects as info with isError true. A separate fail-closed pinned-source probe established the fixed window, absent receipt fields, bare-array response, parser-loss conflation, both timestamp fallbacks, severity fallback, and array-only console contract. A fully paginated all-state issue scan covered 518 issues in six pages and found adjacent but separately owned source lifecycle, response projection, client reconciliation, and realtime-poller cycle-health work rather than a duplicate owner. A fully paginated current open-pull-request scan covered 39 pull requests, 27 drafts, 43 changed-file pages, and 1,333 changed files. It found no direct #2518 reference or implementation owner; open PRs #2078, #2500, and #2501 have collision-only path overlap. Merged PRs #1334 and #1353 are issue-referenced narrower attempts that repaired rotated-file discovery and event signaling without defining reader or parser completeness. No production log, file, response, identity, message, credential, process, service, queue, or configuration surface was read or mutated. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce a bounded versioned reader-observation envelope and typed per-line parser outcomes, keep event time distinct from observation time, derive severity and error impact from one fail-visible normalization, and migrate logs, feed, console, and recovery consumers through a compatibility boundary that can never collapse incomplete or rejected evidence into successful empty state.

### Impact and blast radius

A nonempty or partially readable source can appear as a successful empty or quiet result, corruption and schema drift are indistinguishable from intentional filtering, historical undated records can be projected as current, and unknown high severity can be downgraded while still marked as an error. Operators, console consumers, automation, and recovery logic receive neither a coverage denominator nor a trustworthy distinction between empty, incomplete, rejected, and unavailable evidence. Fleet log-file tailing, log-data and feed parsing, logs API compatibility, console log and operator rendering, timestamp and severity truth, realtime invalidation consumers, recovery decisions that treat absence as evidence, bounded parser diagnostics, and shared observation taxonomy coordination.

## #2519: observability(console): WebSocket reconnect can declare live while realtime-owned caches remain stale

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2518, #2520, #2521, #2522

### Evidence

Two identical GraphQL reads established issue #2519's live node identity, title, URL, open state, empty label set, update time, and exact 9,979-byte body hash; the API body already ends in one newline and the SHA-256 was computed over those returned bytes without adding a synthetic newline. The exact SSH remote and local tracking ref both remained at pinned main a91f5301266fae2049cd1ae1b3c1b236a7ea2aa8. Eight decisive source and focused-test blobs matched that revision byte-for-byte. Eleven deterministic pinned-source assertions confirmed that socket open only sets connected and resets backoff, the client discards the timestamp-only connected frame, disconnect invalidation covers only lines, feed, and typing, the server and client contracts contain no schema version, generation, sequence, cursor, replay, or gap receipt, chats/messages/logs/feed disable fallback polling immediately when connected, access has no polling fallback, relevant hooks return no freshness result, the freshness guard retains already-compliant useLines and dead useKpis exemptions, README overstates automatic stale-data recovery, and the public-surface row advertises a metrics delta absent from the event union. Six write-free focused suites passed 162/162: the existing 128 WebSocket/event/fleet-hook cases, 16 design-hardening cases, and 18 transport-status/banner cases. Those tests explicitly pin a no-op connected frame, partial disconnect invalidation, automatic one-second reconnect, connected-state polling suppression, access with no polling interval, and a transport-only recovery toast/banner transition; they contain no reconnect-gap reconciliation proof. A fully paginated all-state scan covered 518 issues in six pages and 1,984 pull requests in twenty pages. Closed #1877 with merged PR #1908, merged PR #1934, merged PR #183, and merged PRs #1334/#1353 are narrower historical partials. Open #2518 owns log-observation completeness, while newer open #2520, #2521, and #2522 explicitly own producer truth, broadcaster delivery health, and poller-cycle coverage and directly reference this issue's integration boundary. The current open-PR scan covered all 39 pull requests, 43 changed-file pages including four continuation pages, and 1,333 changed files; it found no direct or closing #2519 reference, no implementation owner in the WebSocket hook, event mapping, fleet hooks, focused tests, or freshness guard, and 17 collision-only documentation or UI-consumer overlaps. No production socket, service, cache, query, event, database, log, identity, message, credential, process, or configuration surface was read or mutated. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged. The only recorded-path changes from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd add the triage CLI public-surface row or classify docs/triage in the publication guard; exact hunk review leaves this issue’s WebSocket, poller, silence, throttle, and missing-evidence-reference claims unchanged, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found only the public-surface registration of the unrelated imsg:relay operator command. No realtime sequencing, reconnect, cache reconciliation, producer, broadcaster, or decisive test contract changed; the finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce a versioned realtime envelope and hello receipt bound to stream generation, monotonic sequence, producer coverage, and bounded delivery outcomes. Keep transport state separate from data-reconciliation state. On every generation change, detected gap, delivery loss, or reconnect, preserve polling or another complete observation until a concurrency-bounded active-query registry has successfully reconciled each realtime-owned family or retained an explicit visible stale or unavailable result. Make replay an optimization with a complete-state fallback, consume #2518 for qualified logs/feed observations, and retire stale freshness exemptions and inaccurate documentation only after exact RED/GREEN gap tests prove the full contract.

### Impact and blast radius

The UI can remove its reconnect warning and emit a connection-restored success signal while logs, chats, messages, feed, access, or other event-owned caches still omit changes made during the disconnect. A short gap can reopen the socket before fallback polling fires, immediately disabling the backstop without a catch-up receipt. Operators then cannot distinguish no intervening changes from missed invalidations, failed reconciliation, or an unavailable producer, and stale access or incident evidence can persist until an unrelated later event, focus/remount behavior, or manual refresh happens to invalidate it. Fleet WebSocket envelope and hello semantics; producer-generation and delivery-health integration; browser transport and reconciliation state; React Query invalidation, polling, and active-cache refresh behavior; logs, feed, chats, messages, access, lines, typing, and search consumers; connection banner and recovery toast truth; query freshness and carried-state rendering; reconnect retry and request coalescing; public-surface and architecture documentation; and the design guard that governs freshness exemptions.

## #2520: reliability(fleet): failed realtime marker reads publish false domain changes twice

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `fleet`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `fleet`, `reliability`
- Dependencies: #2447

### Evidence

Two identical live captures established the issue identity, empty label state, timestamp, and body hash while SSH remote main remained at the pinned revision. At that revision, getSnapshot converts a typed getLatestMarkers failure into successful null markers; poll then compares those nulls with the prior successful markers, publishes message, chat, access, and feed invalidations, and stores the synthetic null snapshot. Unchanged recovery therefore appears to change both marker domains again. The surrounding catch cannot handle this path because no exception escapes getSnapshot. The two focused poller suites passed 24 of 24 tests, but none forces a typed marker-read failure; the green result confirms the stated coverage gap rather than the failure semantics. A fully paginated scan of 39 open pull requests and 1,333 changed-file records found four touched-path coordination overlaps, one direct documentation reference, and no open implementation owner for the marker-failure behavior. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Represent marker reads as typed available or unavailable observations, retain each instance's last successful snapshot across failures, and publish no domain invalidations for unavailable reads. Emit bounded content-free unavailable and recovered transitions once per episode; on fresh recovery compare against the last successful markers and coalesce only real changes. Add first-observation, repeated-failure, unchanged and changed recovery, restart-generation, healthy-peer, privacy, and mutation tests. Coordinate the failure vocabulary with #2447 and #2514 and the generation and sequence contract with #2519 without making either adjacent scope the implementation owner.

### Impact and blast radius

A transient marker-read failure is mislabeled as five domain changes, overwrites the last successful comparison point, and causes the same five false changes again on unchanged recovery. This pollutes operational chronology, forces needless client refetches, amplifies load during storage flaps, and can make a later reliable delivery protocol faithfully sequence false producer events. Fleet realtime marker observation, per-instance comparison state, WebSocket invalidation production, feed chronology, access and chat refreshes, recovery load, and any later sequence or reconciliation protocol that assumes producer events are truthful. No production database, transport, message, identity, service, process, or queue state was inspected or mutated.

## #2521: reliability(fleet): WebSocket broadcaster lacks heartbeat, backpressure, and async delivery outcomes

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `bug`, `fleet`, `reliability`, `transport`
- Recommended labels: `P2`, `audit`, `bug`, `fleet`, `reliability`, `transport`
- Dependencies: #2447

### Evidence

Two identical GraphQL reads established the live issue node, title, exact body bytes and SHA-256, empty labels, URL, and timestamp. The local SSH tracking ref and exact SSH remote main both remained at the pinned revision, and all decisive source and test paths are unchanged from that pin. At the pin, FleetWebSocketServer adds each accepted connection to one Set, removes it only on close, error, or synchronous send throw, sends its initial connected frame without a callback, broadcasts solely when readyState is OPEN, invokes one-argument client.send inside try/catch, and reports the raw Set size as clientCount. The source never reads bufferedAmount, supplies a send completion callback, sends ping, observes pong, terminates a half-open client, records a lifecycle state, or owns a heartbeat timer. FleetRealtimePublisher returns void, while the event poller and console protocol have no delivery-outcome or acknowledgement contract. The pinned package lock and installed package both identify ws 8.21.0. Its implementation and type surface expose send completion callbacks, bufferedAmount, ping, pong, and terminate, and its packaged documentation gives ping/pong termination as the broken-connection detection pattern. A write-free in-memory canary invoked the real broadcaster without a listener: an OPEN fake received no completion callback, and another OPEN fake with 67,108,864 buffered bytes still received an application send. A separate fail-closed source and installed-package probe established raw membership, the OPEN-only gate, one-argument send, raw clientCount, zero heartbeat or backpressure signal use, and availability of the installed callback and heartbeat APIs. The existing WebSocket test was inspected and covers a synchronous throwing fake but has no callback-failure, queue-budget, missed-pong, or half-open case. A fully paginated all-state issue scan covered 518 issues in six pages and found no duplicate owner; #2519 owns stream sequencing and client reconciliation, #2520 owns producer observation truth, and #2522 owns aggregate event-poller cycle health. A fully paginated current open-pull-request scan covered 39 pull requests, 27 drafts, 43 changed-file pages, and 1,333 changed files. It found no direct #2521 reference, implementation owner, or path collision. Merged PR #183 validates browser frames, #1333 prevents overlapping poll cycles, and #2372 detaches the shared HTTP upgrade listener during shutdown; each is an issue-referenced narrower partial that does not implement client liveness, queued-byte bounds, or asynchronous delivery outcomes. No network listener, live client, production response, identity, message, credential, service, process, queue, or configuration surface was created, read, or mutated. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Add a per-client monotonic lifecycle with pong-qualified liveness, a pre-enqueue buffered-byte budget, authoritative local send-completion outcomes, bounded episode counters, and complete shutdown cleanup; then integrate failed or dropped sequenced frames with #2519 without treating OPEN, heartbeat, or local write completion as remote application receipt.

### Impact and blast radius

A half-open client can remain counted as connected, a slow consumer can accumulate queued frames while broadcasts continue, and an asynchronous local write failure has no immediate classified outcome. Raw membership and OPEN state can therefore overclaim deliverability, memory pressure can grow during outages or reconnect storms, and future sequencing cannot deterministically distinguish a dropped client frame from healthy continuity without a bounded failure and reconciliation path. Fleet WebSocket client lifecycle and shutdown, per-client memory and queued-byte bounds, realtime publisher outcome semantics, event-poller delivery integration, console reconnect reconciliation, authorized aggregate health, failure-episode logging, and every console invalidation consumer sharing the broadcaster.

## #2522: observability(fleet): realtime poller has no cycle freshness, coverage, or stall health

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `fleet`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `fleet`, `reliability`
- Dependencies: #2447, #2520

### Evidence

Two identical live GraphQL reads established issue #2522's node identity, title, URL, open state, empty label set, update time, and exact 10,091-byte body hash. The API body already ended in one newline, and its SHA-256 was computed directly over the returned string without adding a synthetic newline. The exact SSH remote main and local tracking ref both remained at pinned revision a91f5301266fae2049cd1ae1b3c1b236a7ea2aa8, and the decisive poller blob matched that revision byte-for-byte. Thirteen deterministic pinned-source assertions confirmed that the poller stores only a timer, last-good marker and typing maps, and a private overlap latch; overlapping calls return without a receipt; per-instance database failures, absent typing ports, non-200 typing responses, and typing exceptions do not produce coverage state; stop clears internal state; sixteen lifecycle and coverage tokens are absent; and the only source-tree consumers construct, return, start, and stop the poller. Four focused write-free suites passed 48/48 tests. They prove current diff emission, duplicate-timer containment, in-flight overlap suppression, log rotation, typing last-good preservation, publisher behavior, and WebSocket behavior, but expose no cycle-health snapshot or skipped-overlap counter. A fully paginated all-state scan covered 518 issues in six pages and 1,984 pull requests in twenty pages. Closed #1087 with merged PR #1333 added the correct overlap guard; closed-unmerged PR #1628 was superseded by merged PR #1643's behavioral coverage; merged PRs #1334/#1353 and #2423 preserve narrower log and typing correctness. The current open-PR scan covered all 39 pull requests, 43 changed-file pages including every continuation page, and 1,333 changed files. It found no direct or closing #2522 reference, no open implementation owner, no open change to the poller, publisher, WebSocket server, or focused tests, sixteen shared-document collisions, and one meaningful taxonomy coordination point in PR #2451. No production service, timer, socket, database, log, identity, message, credential, process, queue, configuration, or external mutation surface was used. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged. The only recorded-path changes from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd add the triage CLI public-surface row or classify docs/triage in the publication guard; exact hunk review leaves this issue’s WebSocket, poller, silence, throttle, and missing-evidence-reference claims unchanged, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found only an unrelated imsg:relay public-surface row. Realtime poller cycle freshness, coverage, stall health, and all decisive tests remain unchanged; the finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Add a versioned read-only snapshot to the realtime poller with generation, lifecycle, monotonic sequence and lag, wall-clock correlation times, bounded scheduled/completed/skipped/failure counters, and expected/observed/unavailable source counts. Make every scheduled source end in a typed observed or unavailable outcome, preserve last-good comparison state across partial cycles, project one aggregate snapshot through health, metrics, WebSocket hello, and console reconciliation, and emit bounded failure and recovery episodes. Establish this visibility before considering a separately reviewed, explicitly authorized, rate-limited self-heal policy.

### Impact and blast radius

A live timer and quiet log can look healthy while realtime invalidation cycles are skipped, stalled, partially observed, or repeatedly failing. Operators and downstream clients cannot distinguish a current producer from stale last-good state, cannot measure how much fleet coverage is missing, and cannot prove recovery after restart. That can leave browser caches and aggregate fleet status stale while transport reachability still appears green. Fleet realtime invalidation lifecycle; message, access, log, feed, and typing source observations; timer overlap and shutdown behavior; aggregate health and metrics; WebSocket producer-state projection; console current, partial, late, stalled, and failed states; incident and recovery correlation; and public observability documentation.

## #2523: observability(console): health cause and confidence are discarded or rendered as raw codes

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2447, #2517

### Evidence

Pinned feed output already carries reason, confidence, evidence, and safe error fields, but FeedCard health presentation reads status and error while ignoring reason and confidence, DeploymentCard renders statusReason directly, and the line type leaves statusReason as free text. The local FeedCard reason map is partial rather than a canonical cross-surface contract. All four focused console suites passed 45 of 45 tests but do not assert this missing contract. The complete PR and issue scan found no owner; the broad draft PRs are collision-only and PR #2451 partially supplies the #2447 taxonomy dependency. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A target-specific re-review of PR #2451 at head 58a255718de2e11951417753591d8548128e68bf confirmed that it defines the typed health-degradation vocabulary and cross-contract tests required by the canonical-vocabulary dependency, but it does not change any console presentation path; the overlap therefore remains partial through acceptance-criteria evidence with no overlapping path. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define one typed health-presentation adapter backed by the #2447 canonical vocabulary and #2517 safe-detail rules, then make FeedCard and deployment views consume it with explicit confidence and unknown-code fallbacks.

### Impact and blast radius

Operators lose diagnostic cause and certainty precisely where they decide whether a degraded line needs intervention, and some views expose implementation codes instead of stable human text. All operator-facing health explanations in the activity feed and deployment views; inconsistent presentation can turn actionable cause and confidence into raw codes or generic unknown text.

## #2525: observability(feed): minute-bucket dedupe drops occurrences and client event keys collide

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #1882, #2447, #2518, #2519

### Evidence

Pinned server and client FeedEvent contracts have no occurrence id, generation, sequence, or cursor. The feed route deduplicates generic rows by text plus minute and sorts only by time, while ActivityFeed derives a key from instance, timestamp, type, direction, and chat; distinct generic occurrences can therefore collapse server-side or collide client-side. The three focused console suites passed 36 of 36 tests but omit identity-collision cases. The complete PR and issue scan found no owner; broad draft overlaps touch ActivityFeed or types without supplying occurrence identity. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Assign each occurrence a stable server identity plus deterministic sequence or cursor, dedupe only on that identity, define a total order for equal timestamps, and require the console to key and reconcile rows by the same identity.

### Impact and blast radius

Distinct operational events can disappear from the activity record or reuse a React key, producing incomplete incident history and unstable rendering. Fleet activity history, replay, pagination, and React rendering for all non-message and fallback feed events; collisions silently erase distinct occurrences.

## #2526: observability(logs): millisecond truncation and mutable-text collapse corrupt chronology and counts

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `DRY`, `P2`, `SSOT`, `bug`, `console`, `reliability`
- Recommended labels: `DRY`, `P2`, `SSOT`, `audit`, `bug`, `console`, `fleet`, `reliability`
- Dependencies: #2242, #2518

### Evidence

Pinned main routes generic numeric timestamps through toIsoFromUnix, which first floors millisecond values to stored epoch seconds; a write-free synthetic canary observed .676Z become .000Z. The logs route compares raw message, source, and level, then mutates that same message into a multiplication suffix, so the third identical input no longer matches the first aggregate. Existing time utility tests passed 7 of 7 but cover only whole-second millisecond values, and existing data tests pin two-record suffix behavior rather than exact structured aggregation. A complete 522-issue, 1,984-PR, and fully paginated 39-open-PR scan found no behavioral owner. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Split exact instant formatting from epoch-seconds storage normalization, record unit and precision provenance, and replace display-text mutation with a structured reducer whose immutable fingerprint, member count, first and last times, source generation, policy version, and completeness are projected only after aggregation.

### Impact and blast radius

Valid records within one second can become artificially simultaneous, and runs of repeated diagnostics are split into pairs or encoded ambiguously in presentation text, corrupting chronology and occurrence counts. Fleet log chronology, line activity projection, activity-feed ordering, and repeat-count evidence for every numeric-timestamp log producer; corruption can propagate into incident reconstruction and feed identity.

## #2527: observability(console): live-session storage read failures render as no live sessions

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2447, #2517, #2523, #2524

### Evidence

Pinned server code returns distinct HTTP-200 probeError and readError variants, but the console type requires success fields while allowing optional error flags, the query hook marks both variants freshly successful, Agents forwards only probeError, and InstancesPanel converts missing sessions to an empty list and a zero count. Three focused write-free console suites passed 141 of 141 tests but have no Agents readError case. A complete 523-issue, 1,984-PR, and fully paginated 39-open-PR scan found no owner; historical merged work is partial and current drafts only collide with adjacent paths. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Replace optional error booleans on a success interface with a runtime-validated availability union, keep query freshness separate from source availability, project bounded reasons consistently in Agents and line detail, and allow zero only after a complete observed-empty snapshot.

### Impact and blast radius

Checkpoint-storage failure appears as zero live sessions with fresh query timing, concealing unavailable evidence when an operator assesses a stalled turn or future recovery action. Operator liveness decisions for per-chat agent sessions across the Agents and line-detail surfaces; a storage outage can otherwise masquerade as a fresh authoritative zero.

## #2528: observability(console): fleet metric KPIs erase failure and partial coverage

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `fleet`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `fleet`, `reliability`
- Dependencies: #2447, #2514, #2522, #2523

### Evidence

Exact-main-identical source reduces absent metrics arrays to zero in Ops, gives its KPI cards only the reduced values, discards Fleet metrics query state in SoupKitchen, and maps one nullable token total to either an unqualified fleet sum or no-token-data copy. The producer already returns queried and failed instance counts, and the chart consumer already uses them, so adjacent chart and KPI projections can disagree. Eighteen write-free source assertions reproduced those seams. All twelve cited decisive source and test paths are byte-identical to pinned main. The five cited focused suites passed 88 of 88 tests under the repository-pinned runtime, but none asserts KPI behavior for query failure, all-failed, or partial coverage. Three live identity reads spanning 26 seconds were stable with six current labels; the node, open state, title, URL, update time, and exact body hash remained unchanged while local and SSH remote main stayed at the pin. At the reviewed cutoff, two complete captures stabilized at the same byte hash over 235 open issues, all 39 open pull requests, all changed-file pages, all closing-reference pages, and 37 labels. No open pull request references, closes, semantically owns, or implements this issue; three broad drafts collide only by path. The same-cutoff all-state search covered 528 issues and 1,984 pull requests. Later publication-time full-capture attempts detected top-level inventory drift and failed closed, so estate freshness requires the declared final rescan. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce one typed metrics observation adapter that derives complete, partial, unavailable, and not-applicable values from query state and response coverage, carries last-success freshness, and is consumed by both Ops and Fleet charts and KPI cards.

### Impact and blast radius

A failed observation can appear as a measured zero, and a partial subtotal can appear fleet-complete, causing operators or future automation to misclassify outages, capacity, and recovery. Fleet-wide message and token KPI truth, partial-coverage interpretation, query-failure and recovery presentation, incident and capacity decisions, and any later alert or self-heal policy that consumes the same console projection.

## #2529: observability(console): per-line metric availability is discarded as zero or no data

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2447, #2514, #2519, #2523, #2528

### Evidence

Exact-main-identical producer code returns availability for message statistics, sessions, chat counts, token statistics, and last activity, and the shared console type documents that unavailable must not be treated as zero. Production console source reads that map only for messageStats aggregation. The Fleet drawer renders raw fallbacks, six numeric sort keys collapse absence to zero, token and last-activity absence become an em dash, Pipeline emits raw values, and Metrics and Summary hide a zero-valued token fallback without consulting availability. Eighteen write-free source assertions reproduced those seams. All fourteen cited decisive source and test paths are byte-identical to pinned main. The six cited focused suites, including the lines-route producer suite, passed 191 of 191 tests under the repository-pinned runtime, but they cover only messageStats aggregation availability rather than the other groups or per-line presentation. Three live identity reads spanning 26 seconds were stable with five current labels; the node, open state, title, URL, update time, and exact body hash remained unchanged while local and SSH remote main stayed at the pin. At the reviewed cutoff, two complete captures stabilized at the same byte hash over 235 open issues, all 39 open pull requests, all changed-file pages, all closing-reference pages, and 37 labels. No open pull request references, closes, semantically owns, or implements this issue; three broad drafts collide only by path. The same-cutoff all-state search covered 528 issues and 1,984 pull requests. Later publication-time full-capture attempts detected top-level inventory drift and failed closed, so estate freshness requires the declared final rescan. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce one exhaustive adapter that joins each per-line database value to its availability discriminator before rendering or sorting, defines older-payload compatibility, and provides per-group coverage plus explicit recovery transitions.

### Impact and blast radius

A database fault can look like an idle line, unavailable rows can sort with confirmed empty rows, investigation can be suppressed, and recovery can be visually indistinguishable from continued unavailability. Every operator-facing per-line database metric, Fleet sorting and drill-down, line-detail diagnosis, aggregate coverage copy, compatibility behavior during mixed deployments, and any future action gate that treats a fallback value as proof of inactivity.

## #2530: observability(console): chat and message query failures render as valid empty history

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `chat`, `console`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `chat`, `console`, `reliability`
- Dependencies: #2444, #2447, #2519, #2523, #2527

### Evidence

Pinned main directly returns raw chat/message query results, while Inbox and Line Detail consume data only and coerce absent results to empty arrays; 6 issue-specific assertions within an 11-of-11 write-free source falsifier observed the claimed projection. All nine cited decisive source and test paths are byte-identical to pinned main. The four cited focused suites passed 182 of 182 tests under the repository-pinned runtime, but none covers initial/refetch chat/message failure or partial-line coverage. Three live identity reads spanning 26 seconds were stable with six current labels; the node, open state, title, URL, update time, and exact body hash remained unchanged while local and SSH remote main stayed at the pin. A 529-issue, 1,984-PR, fully paginated 39-open-PR and 1,333-path-occurrence capture found no owner; three open preservation drafts are collision-only. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce one bounded chat/message observation adapter that preserves availability, freshness, retained-after-error state, last success, and multi-line coverage; adopt it in Inbox and Line Detail, qualify partial aggregates, and reserve empty copy for complete successful reads.

### Impact and blast radius

A transport or partial-source failure is projected as domain truth, allowing operators or downstream reasoning to mistake absent rows for complete current evidence and skip necessary review or replay. Unified Inbox and per-line history inspection across every eligible fleet line; failed or stale reads can otherwise appear to prove that no conversation, unanswered message, replay work, or recovery gap exists.

## #2531: observability(console): deployment reads can fail while the surface reports healthy zero

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `deploy`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `deploy`, `reliability`
- Dependencies: #1876, #2447, #2467, #2481, #2486, #2515, #2523

### Evidence

All decisive source and focused-test blobs are byte-identical between the prior pin and 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. Pinned main consumes only fleet-line data, coerces absence to an empty array that derives healthy, and computes the card verdict without liveness or release query availability; 5 issue-specific assertions within an 11-of-11 write-free source falsifier observed the claimed composition. Two focused deployment suites passed 18 of 18 tests again at the new exact main, and the prior shared six-suite run passed 200 of 200, but none covers query failure, retained-after-error data, recovery, or required/advisory evidence composition. A historical 529-issue, 1,984-PR, fully paginated 39-open-PR and 1,333-path-occurrence capture found no owner or open changed-path overlap; publication still requires the declared fresh estate rescan. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Derive one typed deployment observation result from required current fleet and liveness evidence plus advisory release evidence, preserve availability/freshness/recovery state in the page, and render bounded unavailable, stale, inconclusive, and retry projections before numeric or healthy claims.

### Impact and blast radius

An unavailable fleet read can appear as healthy with zero lines and agents, unavailable or dead process evidence cannot demote that verdict, and a failed release query remains indistinguishable from loading. The console's deployment-wide readiness, fleet-size, agent-count, process-liveness, and release-status projections; observation outages can otherwise look like a healthy empty deployment.

## #2532: observability(console): agent query failures render as empty roster and undeclared configuration

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`, `fleet`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `fleet`, `reliability`
- Dependencies: #2447, #2517, #2523, #2527, #2531

### Evidence

All decisive source and focused-test blobs are byte-identical between the prior pin and 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. Exact-main Agents source destructures only data from roster, selected-line, and provider-status queries. Roster failure therefore uses an empty array, while failed detail and provider reads become undefined. The page and panels project those fallbacks as no agents, no tool knobs, runtime defaults, no plugins, no vector store, provider placeholder, and em-dash values. The sibling provider card preserves loading, error, and retry, and useLines already exposes freshness, proving the fail-visible primitives exist. Nineteen write-free source assertions reproduced the loss. The Agents and provider-card suites passed 54 of 54 tests again at the new exact main but do not distinguish query failure or retained-after-error data from successful empty state. One historical complete nested capture covered 237 open issues, all 39 open pull requests, all changed-file and closing-reference pages, and 37 labels. A required second capture failed closed because the top-level inventory changed, so no stable complete-estate claim is made. The historical capture and direct searches found no implementation owner; publication still requires the declared fresh estate rescan. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce shared query-observation adapters for roster, selected detail, and provider status, then make Agents render source-scoped availability, freshness, retained state, retry, and recovery while gating mutation claims on a fresh before and after read.

### Impact and blast radius

An unavailable fleet or configuration source can look successfully empty or unconfigured, causing false diagnosis and provider changes without a trustworthy before-state. The Agents roster, selected-agent configuration and brain panels, provider mutation before-state, stale-data interpretation, recovery proof, and any operator decision based on apparent configuration absence.

## #2533: durability(alerts): unreadable silence registry disables mutes and can be overwritten as empty

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `DRY`, `P1`, `SSOT`, `alerts`, `audit`, `bug`, `console`, `reliability`
- Recommended labels: `DRY`, `P1`, `SSOT`, `alerts`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2164, #2355, #2447, #2467, #2486, #2517

### Evidence

All decisive product and focused-test blobs are byte-identical between the prior pin and 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. The public-surface document changed only in unrelated Git-guard rows, and its silence-registry contract remains byte-for-byte unchanged. Exact-main silence-manager source returns the same empty array for first-run absence, corrupt JSON, non-array content, and other read failure, validates only that the document is an array, and casts every member. Evaluation then returns false, listing returns empty, and addSilence filters that fallback and atomically publishes a new registry. GET always returns HTTP 200 with a silences array, while Settings consumes only data and maps a missing response to No active mutes. Public documentation calls the active suppression registry safe to delete. Nineteen write-free source assertions reproduced those seams. The Settings, manager, and route suites passed 44 of 44 tests at the new exact main; they establish current behavior but do not include the removed corrupt-overwrite canary. One historical complete nested capture covered 237 open issues, all 39 open pull requests, all changed-file and closing-reference pages, and 37 labels. A required second capture failed closed on top-level inventory drift, so no stable complete-estate claim is made. The historical capture and direct searches found no owner; publication still requires the declared fresh estate rescan. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged. The only recorded-path changes from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd add the triage CLI public-surface row or classify docs/triage in the publication guard; exact hunk review leaves this issue’s WebSocket, poller, silence, throttle, and missing-evidence-reference claims unchanged, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found only an unrelated imsg:relay public-surface row. Silence-registry read validity, corrupt-state preservation, mutation basis, and decisive tests remain unchanged; the finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Replace loadRules with a strict typed store observation, preserve a bounded last-known-good evaluation basis, block ordinary mutations unless a current validated read succeeds, expose honest API and Settings states, and require separately authorized evidence-preserving repair or reset.

### Impact and blast radius

A storage incident can silently disable all mutes, affirm an empty registry, and let an ordinary add overwrite recoverable suppression state, producing alert storms and destroying evidence. Planned-maintenance suppression, alert evaluation, registry repair evidence, silence API truth, Settings operator controls, recovery signaling, and public durability guidance for the active silence artifact.

## #2534: observability(alerts): throttle-cache failure stays false-quiet and recovery is not re-read

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`, `console`, `reliability`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `console`, `reliability`
- Dependencies: #2355, #2447, #2514, #2533

### Evidence

Three live reads spanning 24 seconds pinned open issue #2534 to node I_kwDOR1Sep88AAAABKQcv3w, the current title, labels, update time, URL, and exact 9,465-byte body hash while the SSH remote main remained 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. All decisive product and focused-test blobs are byte-identical between the prior and new pins. The public-surface document changed only in unrelated Git-guard rows, and its throttle-cache contract still says deletion is safe with at most one re-fired batch. The store returns typed loadError for a non-object root without logging, the compatibility loader discards that error, and recordAlertThrottle reloads through the compatibility loader before publishing the new entry. An isolated audit canary reproduced zero malformed-root warnings and a reset artifact containing exactly the new synthetic key, then removed all audit state. The poller reads detailed cache state once in its constructor, retains only an error code, exposes no cache state through getStatus or getStatuses, and clears the code immediately after recordAlertThrottle returns without a fresh read. The existing test explicitly calls that behavior self-healing after the first successful save. The untouched throttle-store, corrupt-store, and primary poller suites passed 152 of 152 tests again at the new exact main; the prior isolated characterization canary passed 1 of 1 after an initial out-of-tree invocation was rejected by Vitest's include rule and treated as inconclusive. A historical scan of all 39 then-open PRs found no source or focused-test overlap and 16 documentation-only collisions; publication still requires the declared fresh estate rescan. Merged PRs #673, #676, #743, and #2376 and direct main-ancestor commit b044adfefe31273cc343321de034bd5b69de9860 are partial historical work. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged. The only recorded-path changes from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd add the triage CLI public-surface row or classify docs/triage in the publication guard; exact hunk review leaves this issue’s WebSocket, poller, silence, throttle, and missing-evidence-reference claims unchanged, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact review of merged PR #2336 at target main 487bad4e64da457f6d601168fe43fcb49d9648b4 found only an unrelated imsg:relay public-surface row. Alert-throttle cache availability, reset, recovery reread, and decisive tests remain unchanged; the finding survives collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2594 at exact API and SSH main 45f4889ab5f971d920ca6a05bf857d326c42b81d inspected every intersecting package, public-surface, guard-test, and recorded path. Its additive installed-hook identity guard and push-gate wiring do not alter this issue’s finding, classification, owner boundary, or dependency order; the overlap remains collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Replace fail-empty mutation with a typed cache-state machine and explicit reset transaction. Carry generation, observation time, bounded failure class, last successful read and write, retained or dropped counts, and suppression-coverage state; quarantine or preserve invalid prior artifacts long enough to declare a bounded disposition. Keep alert delivery fail-open, but require a fresh detailed read of the published generation before verified recovery. Project metadata-only state through fleet health, line APIs, and the console, emit one onset and one verified-recovery transition per episode, narrow the error-discarding compatibility loader, and correct the public artifact contract.

### Impact and blast radius

Operators can see an apparently healthy fleet while restart-surviving duplicate-alert suppression is unavailable or partially reset. A later accepted alert can replace all other eligible suppression keys, permitting a bounded but unexplained re-fire batch, and the same write is treated as recovery without proving that the published cache is readable or accounting for retained and dropped coverage. Restart-surviving duplicate-alert suppression, alert-delivery evidence, cache reset and recovery semantics, fleet health and line API projection, operator console interpretation, privacy of diagnostics, and the public compatibility contract for fleet-alert-throttle.json.

## #2535: reliability(recovery): restart-loop guard health hides state failure and ignores configured threshold

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `config`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `config`, `reliability`
- Dependencies: #2447, #2522

### Evidence

Three live reads spanning 25 seconds pinned open issue #2535 to node I_kwDOR1Sep88AAAABKQfMyA, the current title, labels, update time, URL, and exact 10,190-byte body hash while local origin/main and the SSH remote main remained 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. Exact-main source inspection shows checkAndRecordInterruptedBoot evaluates the configured maxRestarts and windowMs, while readRestartLoopGuardHealth recomputes tripped with RESTART_LOOP_GUARD_DEFAULTS.maxRestarts. The runtime passes configured windowMs into health but not configured maxRestarts. loadState collapses missing, malformed, invalid, oversized, non-private, and unreadable state to null; markBootInProgress replaces null with fresh state, ignores saveState's result, and returns false for interrupted state. An isolated exact-main canary proved a configured maxRestarts=1 decision tripped with one boot while health reported tripped=false, and proved missing and malformed state serialize to identical healthy-zero health. The untouched exact-main guard and runtime-gate suites passed 24 of 24 tests. A scan of all 38 open PRs, with full pagination of the two PRs exceeding 100 files, found no owner; every open touched-path match is classified below, while merged PRs #1929 and #1969 are partial historical work. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed the restart-loop decision, health projection, fleet, and console paths remain unchanged by the provider-policy delta. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2535's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Resolve one immutable restart-loop policy object and thread it through decision, stored state, startup notice, runtime health, fleet API, and console. Replace nullable load/save semantics with bounded typed outcomes and a tri-state prior-exit result; preserve service admission but require an explicit policy for automatic replay when protection state is unknown. Preserve or quarantine invalid state, publish generation and availability metadata, and declare recovery only after fresh readback verifies the new generation. Register bounded causes through #2447 and add the complete threshold, storage, clock, restart, projection, and privacy matrix.

### Impact and blast radius

A configured threshold can suppress proactive recovery while health says the guard is not tripped. Missing and failed state are indistinguishable from an idle healthy guard, and an unproven boot-marker write can be treated as a clean prior exit, allowing repeated automatic replay without a truthful availability or recovery signal. Agent restart admission, proactive checkpoint replay, restart-loop state persistence and recovery, startup notification truth, runtime and top-level health, fleet line projection, console diagnosis, and privacy of shared recovery diagnostics.

## #2536: docs(provenance): replace unresolved lane-artifact references with durable public evidence

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `documentation`
- Recommended labels: `P4`, `audit`, `bug`, `documentation`, `reliability`
- Dependencies: #2461

### Evidence

Three live identity reads spanning 24 seconds pinned open issue #2536 to node I_kwDOR1Sep88AAAABKQhulg, its current title, labels, update time, URL, and exact 4,669-byte body hash while the SSH remote main remained 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. All 17 decisive source and focused-test blobs are byte-identical between the prior and new pins. Exact current main contains 24 oc-re/**/*.md reference matches across 15 tracked source, console, test, and documentation files. They name 10 unique Markdown targets, and git object lookup proves all 10 are absent from the tree. No tracked oc-re path exists in repository history. The existing publication guard recognizes missing backticked or linked docs/**/*.md references only in staged Markdown additions. A corrected direct probe produced one missing-doc-ref for docs/missing.md but zero findings for an absent oc-re/specs/missing.md reference in either a Markdown file or source file. All seven decisive feature and publication-guard suites passed 99 of 99 tests at the new exact main. Merged PRs #1929, #1930, #1937, #1939, #1940, #1943, #1947, #1951, #1953, and #1969 preserve public implementation lineage but do not make the cited records resolvable. The prior complete scan found only collision-only open changes in PR #2078 and PR #2489, and both overlap identities remain current; publication still requires the declared fresh estate rescan. Issue #2461 owns a separate BOT ERRORS documentation split and remains a coordination dependency rather than a duplicate. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged. The only recorded-path changes from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd add the triage CLI public-surface row or classify docs/triage in the publication guard; exact hunk review leaves this issue’s WebSocket, poller, silence, throttle, and missing-evidence-reference claims unchanged, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final live pull-request reread corrected PR #2489 from open to merged; its animation-test overlap remains collision-only and does not close this issue’s broader browser-test isolation boundary. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Create a deterministic repair manifest for all 24 references. Replace each with the smallest durable public evidence: the merged pull request plus current source and focused tests when sufficient, or a concise newly authored topology-neutral record when normative design content still matters. Do not copy absent artifacts without publication review. After cleanup reaches zero unresolved internal references, extend the existing publication guard or add one shared checker that scans tracked text across source, tests, console, and docs, resolves repository-relative Markdown against the committed tree, recognizes canonical public references, and fails closed with reason-bearing exceptions and focused fixtures.

### Impact and blast radius

Reviewers and maintainers are directed from production comments, tests, public proposals, and conformance claims to evidence that cannot be resolved from the repository. The missing lineage cannot be checked mechanically, and copying unknown private artifacts as a repair could expose operational context. Existing enforcement allows the same unresolved internal-path pattern to be introduced again outside staged Markdown docs. Publicly reproducible design and implementation lineage for restart-loop protection, rate-limit visibility, checkpoint browsing and restore, design-debt closeouts, and proposal grounding; pre-commit and pre-push enforcement of repository-local Markdown provenance across source, tests, console code, and documentation.

## #2537: observability(console): degradation causes are transported but never rendered

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `bug`, `console`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `console`, `fleet`, `reliability`
- Dependencies: #2409, #2447, #2515, #2535, #2538

### Evidence

Three live reads spanning 25 seconds pinned open issue #2537 to node I_kwDOR1Sep88AAAABKQkZOg, the current title, labels, update time, URL, and exact 6,584-byte body hash while local origin/main and the SSH remote main remained 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. Exact-main source inspection shows core health emits degradation_causes and the fleet poller parses the vector into free-form statusEvidence while retaining the generic health_body_degraded reason. The lines route transports statusReason, statusEvidence, and raw health. Console LineInstance declares statusEvidence but its health type has no degradation_causes field; the only executable statusReason consumer is DeploymentCard, which renders the generic reason, and console source has zero degradation_causes consumers. The untouched exact-main core-health, fleet-poller, lines-route, and deployment-page suites passed 354 of 354 tests. A scan of all 38 open PRs, with full pagination of the two PRs exceeding 100 files, found no owner. Draft PR #2451 is partial vocabulary work, merged PR #2051 is partial producer/poller history, and every other open match below is collision-only. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. At af753d288faab9e1f7258a318f9f739433804cfe, the canonical registry now supplies bounded core cause vocabulary and drift checks, but fleet validation and console rendering still do not consume that vocabulary. The issue is narrowed to the producer-to-console projection gap. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Health status_reasons now traverse additional transport surfaces but still lack complete consumer rendering and handling. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Reuse the landed canonical cause registry to validate and project bounded fleet cause objects, then render accessible single, multi, stale, malformed, unknown, and recovery states in the deployment and line-detail surfaces.

### Impact and blast radius

Operators see a generic degraded label even when the backend already knows the exact causes. They cannot reliably distinguish fallback, transport, auth, schema, durability, recovery, or unknown states, determine cause freshness, or know whether one member of a multi-cause episode recovered without inspecting unstructured evidence. Fleet health classification and line API stability, console fleet/deployment/detail diagnosis, cause freshness and multi-cause recovery semantics, accessibility of operator-facing degradation state, and privacy of bounded health projections.

## #2538: observability(health): chat and passive runtime failures collapse to unclassified

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `alerts`, `bug`, `console`
- Recommended labels: `P2`, `SSOT`, `alerts`, `audit`, `bug`, `chat`, `console`, `reliability`, `type-safety`
- Dependencies: #2409, #2447, #2514

### Evidence

Three live reads spanning 25 seconds pinned open issue #2538 to node I_kwDOR1Sep88AAAABKQmX-w, the current title, labels, update time, URL, and exact 6,444-byte body hash while local origin/main and the SSH remote main remained 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. Exact-main source inspection shows RuntimeHealth contains only status and an untyped details map. Chat runtime degrades for queue backlog or stale enrichment and becomes unhealthy for database compatibility rejection without a cause. Passive runtime catches its health query failure, returns degraded, and records healthSnapshotError=db_query_failed only in details. Core health reads every runtime snapshot and propagates its status, but agentRuntimeStatus and all runtime-detail cause classification are agent-only; a degraded chat or passive snapshot therefore reaches the final empty-vector fallback as unclassified. The existing core test proves a degraded chat snapshot downgrades top-level status but does not assert a cause. The untouched exact-main core-health and chat/passive snapshot suites passed 158 of 158 tests. A scan of all 38 open PRs, fully paginating the two PRs exceeding 100 files, found no owner. Draft PR #2451 is partial vocabulary work, merged PR #2051 is partial agent-oriented causality history, and every other open touched-path match is collision-only. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. At af753d288faab9e1f7258a318f9f739433804cfe, a registered bounded core vocabulary now exists, but RuntimeHealth still exposes an untyped details map and chat/passive failures still collapse to unclassified. The issue is narrowed to producer completeness and typed health projection. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A consumer hook now exists, but chat and passive producers still omit the required reason contract. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Extend RuntimeHealth with one versioned bounded observation containing status, registered causes, observation availability, and observed_at. Adopt it in chat and passive runtimes, require every non-healthy result to carry a cause or explicit invalid-contract state, and make core validate and project that observation instead of re-deriving selected agent details. Preserve existing agent causes during migration, register the all-mode vocabulary through #2447, and add mode-local truth tables, end-to-end health fixtures, drift enforcement, and exact-byte privacy checks.

### Impact and blast radius

Known chat queue pressure, stale enrichment, compatibility rejection, and passive health-query failure collapse to unclassified at the public health boundary. Downstream alert, fleet, and console consumers cannot apply stable severity, ownership, action, freshness, or recovery policy without re-parsing mode-specific details. RuntimeHealth's shared contract, chat queue/enrichment/compatibility diagnosis, passive database-observation diagnosis, top-level health status and cause agreement, downstream fleet and alert classification, console consumption, and privacy of runtime diagnostic values.

## #2539: reliability(polls): persistence failures stay healthy and offline decisions retry only on reboot

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `audit`, `bug`, `reliability`
- Recommended labels: `P4`, `audit`, `bug`, `reliability`
- Dependencies: #2155, #2197, #2424, #2447, #2514, #2537, #2538

### Evidence

Three live identity reads spanning 23 seconds pinned open issue #2539 to node I_kwDOR1Sep88AAAABKQo6aA, its current title, P4 label, update time, URL, and exact 11,943-byte body hash while the SSH remote main remained 9a1bd7b3d3c529b276c1ad764d2c312d7f3abfc3. Exact-main source inspection confirms save and removal catch persistence errors, increment a cumulative counter, and return without a typed failure; load catches an error and returns an empty array. The runtime exposes the cumulative counter in two health detail shapes but omits it from both health-status predicates. The offline decision consumer is called once during boot, wraps the complete row loop in one outer catch, and explicitly retains failures for the next boot. Exact-main focused suites passed 218 of 218 tests across pending-poll persistence, fleet approvals, durability checkpoints, core health, and auto-compact control; two issue-specific runtime characterizations also passed. Merged PRs #700, #703, #1121, #1386, and #2002 are partial historical implementations. A fresh complete open-PR changed-file scan found 19 collision or coordination overlaps and no implementation owner; exact-term issue and pull-request searches found no additional owner. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed poll persistence, approval routing, and health predicates remain unchanged; intersecting runtime-test changes cover route policy only. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. Merged PR #2451 resolves the taxonomy prerequisite at af753d288faab9e1f7258a318f9f739433804cfe; it is removed from dependency ordering, while this issue's poll, replay, or heal outcome-truth finding remains unchanged. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2539's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce a shared typed persistence-result contract for pending polls and make runtime side effects conditional on durable success. Represent load failure separately from an empty durable set, persist current retry obligations and terminal dispositions, and derive health from unresolved work rather than cumulative errors alone. Replace the boot-only offline decision loop with a leased recurring consumer that processes rows independently, uses idempotency keys and bounded backoff, and records accepted, applied, retrying, moot, and terminal receipts through one lifecycle used by live and offline decisions.

### Impact and blast radius

A persistence failure can be represented to the runtime as success or as an empty durable set, leaving poll delivery and recovery state ambiguous while health remains green. Offline decisions can remain durable but unapplied until another reboot, and one thrown row can defer unrelated decisions behind it. Agent poll recovery, poll result delivery, fleet approval decisions accepted while an instance is offline, runtime health truth, restart behavior, and operator recovery of retained poll obligations.

## #2540: reliability(recovery): unprovable resume identities stay resumable while health remains green

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Four stable body-free identity reads pinned issue #2540 without drift while SSH and API main remained exactly 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. Exact main still selects every active or suspended checkpoint with a non-null provider session ID for proactive resume. The runtime rejects legacy, incomplete, or mismatched completed-delivery identity before creating a SessionManager, increments only a process-local cumulative counter, and leaves the durable checkpoint eligible for selection; that counter remains diagnostic rather than a current-obligation health predicate. The provider-policy delta adds a separate, narrower lifecycle: every admitted route carries a versioned policy tuple; exact compatible lifecycle rows are reactivated through workspace and conversation fences; exactly owned incompatible provider-policy resumes may be retired to ended; ambiguous ownership remains unchanged; and failed policy-metadata persistence is compensated to crashed/resume_failed plus orphaned or blocks same-manager reuse as inconclusive. Terminal bookkeeping avoids repainting session status while that cleanup is inconclusive. These new policy-specific terminal paths do not classify or remove checkpoints rejected earlier for unprovable completed-delivery identity. The focused exact-source runs passed 1,394 of 1,394 tests across 30 files with no skips. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2540's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. Recovery context tests expanded, while stable resume identity and generation binding remain unresolved. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Extend the new exact lifecycle and staged-admission pattern to completed-delivery identity admission without conflating provider-policy mismatch with delivery-identity uncertainty. Before proactive selection, persist a typed admission state and reason; atomically move unprovable or mismatched identities to bounded repair, quarantine, or terminal ownership; lease retries with attempt and next-attempt limits; and project unresolved current obligations into health while retaining cumulative rejection history separately.

### Impact and blast radius

The runtime avoids an unsafe resume but can select and reject the same legacy or mismatched checkpoint on every boot indefinitely. Because the rejection is only a process-local lifetime counter and does not affect status, an unresolved recovery obligation can remain ownerless while health reports healthy. Agent restart recovery, proactive resume admission, durable checkpoint lifecycle, health truth, operator repair workflows, and repeated boot behavior for legacy or identity-mismatched sessions.

## #2545: observability(health): one response mixes two runtime snapshot generations

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P2`, `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `P2`, `SSOT`, `audit`, `bug`, `reliability`
- Dependencies: #2473, #2514, #2522, #2538

### Evidence

Three stable live identity reads pinned open issue #2545 to node I_kwDOR1Sep88AAAABKQyDMw, its current title, P2, SSOT, audit, bug, and reliability labels, update time, URL, and exact 8,474-byte body hash while the SSH remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. The prior audited main and this revision have identical bytes for every decisive and affected path. Exact-main source inspection shows getEnrichmentStats samples runtime first, then the health handler independently samples runtime again; first-sample runtimeDegraded participates in top-level status while the second sample supplies serialized runtime data. A source-extracted exact-main canary injected a degraded first sample and healthy second sample and proved two runtime calls, the contradictory values, the source order, one generated_at timestamp, and no observation-generation binding. The exact core suite passed 144 of 144 tests. A fresh fully paginated scan covered all 36 open pull requests and 1,276 changed-file rows, found ten touched-path collisions plus taxonomy coordination in draft PR #2451, and found no implementation owner. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Public liveness now single-samples without database access, but the authenticated diagnostic path still permits mixed-generation double sampling. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Build one immutable request-scoped health observation containing the single runtime snapshot and typed independent probes, pass it to every readiness and authorized projection, and separate observation timing from serialization time. Remove duplicate runtime and database sampling and add generation, transition, concurrency, exception, mutation, and privacy tests.

### Impact and blast radius

One response can carry healthy serialized runtime state while retaining degradation from an earlier sample, or mix older enrichment fields with newer runtime state. Consumers cannot distinguish a real transition from an internally incoherent observation. Instance health readiness, cause projection, runtime and turn-capability serialization, enrichment state, database probe load, fleet and alert interpretation, and recovery-clear coherence.

## #2546: observability(provider): live-session corroboration mistakes session lifetime for evidence freshness

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: #2340, #2358, #2447, #2464

### Evidence

Three stable live identity reads pinned open issue #2546 to node I_kwDOR1Sep88AAAABKQzSxg, its current title, P1, SSOT, alerts, audit, bug, and reliability labels, update time, URL, and exact 9,949-byte body hash while the SSH remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. The prior audited main and this revision have identical bytes for every decisive and affected path. Exact-main source inspection confirms the health corroborator calculates freshness from session start age, while the database corroborator selects the newest session start or message timestamp and applies the same age limit. A direct exact-source falsifier returned fresh=false for a current provider-matched health observation with a long-lived active session and fresh=true for a recently started active session with no progress evidence. The exact bot-errors TypeScript and focused provider-probe Python suites passed 165 of 165 tests. A fresh fully paginated scan covered all 36 open pull requests and 1,276 changed-file rows, found 19 touched-path overlaps plus taxonomy coordination in draft PR #2451, and found no implementation owner. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed the provider-freshness checker is byte-identical and session-age corroboration is unchanged. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2546's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Represent observation freshness, exact-process liveness, progress or success freshness, and session lifetime independently, bind only compatible provider generations, and classify insufficient evidence as inconclusive. Correct both health and database corroboration, add deterministic time and restart matrices, and preserve bounded content-free evidence.

### Impact and blast radius

A healthy long-lived provider can stop contradicting a headless authentication false negative merely because it was not restarted recently, while a newly started but unproven child is overtrusted. Restart timing can therefore masquerade as provider recovery. Scheduled provider-probe truth, headless credential diagnosis, runtime provider evidence, restart and self-healing decisions, alert incident transitions, and confidence in shared provider health.

## #2547: docs(lifecycle): completed reliability artifacts remain executable-looking and obscure live gaps

- Classification: `tracker`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `documentation`
- Recommended labels: `P4`, `SSOT`, `audit`, `documentation`, `reliability`, `tech-debt`
- Dependencies: #2461, #2536

### Evidence

Three stable live identity reads pinned open issue #2547 to node I_kwDOR1Sep88AAAABKQ12hw, its current title, P4 label, update time, URL, and exact 7,508-byte body hash while the SSH remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. The prior audited main and this revision have identical bytes for every decisive and affected path. Exact-main object scanning reconfirmed 33 completed work-index rows, including 19 plans, with 16 completed artifacts containing 775 unchecked task boxes and zero reported index inconsistencies. The canonical policy defines work status but no orthogonal reader mode; the scanner parses status and coverage or generated drift but does not inspect unchecked tasks, execution language, residual ownership, or document mode. Merged PR #2543 only normalizes volatile last-modified metadata and leaves lifecycle semantics unchanged. A fresh fully paginated scan covered all 36 open pull requests and 1,276 changed-file rows; all nine overlaps touch only generated work-index artifacts and none owns the lifecycle contract. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. The current work index contains 81 rows: 16 active, 4 closed, 33 completed, 7 deferred, 14 pending, and 7 unknown; document kinds are 40 plans, 29 specs, 7 handoffs, 4 reviews, and 1 state record. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Add an orthogonal document-mode contract, teach work-index tooling to report lifecycle warnings separately from status and freshness drift, normalize the reliability cohort without deleting evidence, then adopt guarded enforcement only after bounded topic cohorts reduce the reviewed baseline to zero.

### Impact and blast radius

Agents and maintainers can mistake obsolete branch-era instructions or unchecked historical tasks for live work, while real residual gaps remain trapped in completed prose. The index reports internal consistency without revealing this separate lifecycle contradiction. Agent task discovery, work-index lifecycle semantics, retained planning and review evidence, reliability backlog ownership, runbook authority, and documentation maintenance across every indexed completed artifact.

## #2548: reliability(replay): access approval reports success after queued-message replay fails

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `audit`, `bug`, `reliability`
- Recommended labels: `P4`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: #2444, #2447, #2547

### Evidence

Three stable live reads pinned the open issue identity, P4 label, update time, URL, and exact body hash while SSH remote main remained at de3f69bbb5648b804ea2843d310c47dda544a056. The prior and current main revisions have no changes in any decisive or affected path. Exact-main source still persists access before invoking replay, catches replay failure, and returns HTTP success; the replay loop records each message ID before awaiting runtime admission. A 29-assertion exact-main source falsifier passed. Fourteen focused supporting suites passed 559 of 559 tests, including the route behavior that intentionally keeps HTTP 200 after callback rejection; because the audit branch differs from main in shared runtime/database paths, those executions are supporting characterization rather than exact-main runtime proof. A fully paginated stable-main capture covered 36 open pull requests, 28 drafts, 40 changed-file pages, and 1,276 file occurrences with zero declared-count mismatch. It found no direct issue reference or implementation owner; draft PR #2451 is taxonomy-only partial coordination and the remaining open overlaps are path collisions. Merged PR #741 is a valid partial historical implementation. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. Merged PR #2451 resolves the taxonomy prerequisite at af753d288faab9e1f7258a318f9f739433804cfe; it is removed from dependency ordering, while this issue's poll, replay, or heal outcome-truth finding remains unchanged. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Atomically commit access mutation with durable per-message replay work, claim and complete each item idempotently, record partial outcomes, mark completion only after durable admission, and return a typed access-versus-replay disposition.

### Impact and blast radius

Access can be durably allowed and reported successful after replay fails, while the failed message is pre-marked complete and may be excluded from retry. Newly approved direct-message senders, access state, replay ordering and deduplication, restart recovery, API truth, and operator diagnostics.

## #2549: reliability(heal): POST /heal acknowledges orphaned repair reports after dispatch no-op or failure

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `audit`, `bug`, `reliability`
- Recommended labels: `P4`, `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #1754, #2148, #2410, #2447, #2548

### Evidence

Three stable reads pinned the open identity, P4 label, update time, URL, and exact body hash while remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. No decisive or affected path changed from the prior audited main. Exact-main source persists pending work, conditionally invokes a void-returning runtime method, swallows dispatch failure or runtime no-op, and returns 202; it also retains separate pending_heal_reports and heal_reports lifecycles. The exact source falsifier passed. Supporting heal, schema, route, and control tests participated in a 559-of-559 focused run and prove the existing swallowed/no-op contract, not the replacement lifecycle. A fully paginated stable-main capture covered 36 open pull requests, 28 drafts, 40 file pages, and 1,276 file occurrences. It found no direct reference or implementation owner; PR #2451 is taxonomy-only partial coordination, all other open overlaps are collisions, and merged PR #1766 is a historical partial. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Exact old-pin-to-0f621d0296760919f1a49ea595ca23e55f3a89ac recorded-path and current-source review found only comment/documentation clarification, presentation-helper extraction, or trusted-internal-DM audience-redaction changes outside this issue’s decisive behavior; its classification, remediation, and dependency conclusions survive and the record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed heal queue, database, health, and tool-registration semantics remain unchanged. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. Merged PR #2451 resolves the taxonomy prerequisite at af753d288faab9e1f7258a318f9f739433804cfe; it is removed from dependency ordering, while this issue's poll, replay, or heal outcome-truth finding remains unchanged. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Exact semantic review of merged PR #2362 across its 14 changed runtime-turn ownership source and test paths at API, SSH, and origin main 5c96576ff33d569333298c84c6a5379bfd2af76f found no implementation of issue #2549's recorded owner boundary or falsifier. The intersecting changes establish fail-closed provider-turn ownership and token matching; this record's finding, state, owner, dependencies, and partial findings survive collision-only. The complete seven-file changed test set passed 453/453. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Use one canonical crash-safe repair-work ledger and typed admission result; make persistence and ownership transfer atomic, distinguish queued, started, retryable, and terminal states, resume after restart, and resolve the same row.

### Impact and blast radius

The heal endpoint can persist an unresolved record and return 202 when no capable executor starts work; that orphan can then suppress same-class retries. Self-healing admission, single-flight ownership, restart recovery, repair queues, duplicate suppression, health and alerts, and two divergent persistence tables.

## #2550: observability(console): mark-read remote outcome reaches the API and is then discarded

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `bug`, `console`, `reliability`
- Recommended labels: `P4`, `SSOT`, `audit`, `bug`, `console`, `fleet`, `reliability`, `transport`
- Dependencies: #2292, #2371, #2537

### Evidence

Three stable reads pinned the open issue identity, P4 label, update time, URL, and exact body hash while remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. No decisive or affected path changed from the prior audited main. Exact-main source returns a four-state remote receipt result and serializes it through the health and Fleet boundary, while the console client narrows the response to ok and Inbox reacts only to promise rejection after an optimistic unread reset. The exact-main source falsifier passed and the relevant supporting suites were included in a 559-of-559 focused run. A fully paginated stable-main scan covered 36 open pull requests and all 1,276 file occurrences. It found ten path collisions, no direct reference, and no open implementation owner. Merged PR #2371 is the producer-side partial. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Preserve the complete discriminated response in the console client, settle optimistic state by remote disposition, expose offline synchronization, warn and retry idempotently on failure, and reject unknown states.

### Impact and blast radius

The backend reports whether the remote receipt was acknowledged, failed, offline, or unnecessary, but the console discards that truth and treats every resolved promise as success. Inbox read-state truth, offline and failed receipt visibility, retry behavior, Fleet compatibility, UI warnings, and operator trust.

## #2551: docs(transport): stable error registry requires eight operator runbooks that do not exist

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `documentation`
- Recommended labels: `P4`, `audit`, `documentation`, `ops`, `reliability`, `transport`
- Dependencies: #2447, #2451, #2547

### Evidence

Three stable live reads pinned the open identity, P4 label, update time, URL, and exact body hash while remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. No decisive or affected path changed from the prior audited main. Exact-main inspection and a deterministic assertion counted eight registered transport error codes and zero matching transport runbook files. The exact contract-lock test was included in a supporting 559-of-559 focused run. A fully paginated stable-main capture covered 36 open pull requests, 28 drafts, 40 changed-file pages, and 1,276 file occurrences with no direct owner or touched-path overlap. Draft PR #2451 is taxonomy-only coordination; merged PR #406 is a partial historical contract lock. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define one versioned runbook schema, create one resolvable runbook per code, connect the canonical registry to those paths, and enforce completeness plus deprecation mappings.

### Impact and blast radius

The stable registry promises runbooks that do not exist, leaving operators without normative retry, containment, duplicate-risk, or clear-authority guidance. All transport failures, especially ambiguous sends, operator recovery, alert links, taxonomy evolution, and duplicate-delivery risk.

## #2552: docs(artifacts): fixed global error/readiness ledgers are stale and collision-prone

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `config`, `documentation`
- Recommended labels: `P4`, `SSOT`, `audit`, `bug`, `config`, `documentation`, `reliability`, `tech-debt`
- Dependencies: #2447, #2451, #2536, #2547, #2551

### Evidence

Three stable reads pinned the open identity, P4 label, timestamp, URL, and body hash while remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. No decisive or affected path changed from the prior audit. Exact-main artifacts still carry unqualified pass and dated readiness claims, while work-index scope remains limited to three documentation roots and excludes artifacts. The exact source assertions passed and the work-index suite participated in a supporting 559-of-559 focused run. A fully paginated stable-main scan covered 36 open pull requests and all 1,276 file occurrences. Nine PRs collide only on generated work-index files; none touches the decisive artifact or scanner paths. Draft PR #2451 coordinates taxonomy without owning artifact lifecycle. A three-read current identity audit found node, title, URL, body hash, labels, and timestamp stable. Every recorded decisive, test, and affected path is byte-identical from this record’s prior pin to 0f621d0296760919f1a49ea595ca23e55f3a89ac, so the record is safely repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Move normative taxonomy to one canonical source, convert retained artifacts into historical snapshots or generated receipts, require run-scoped manifests with revision and observation provenance, and enforce collision, staleness, and supersession rules.

### Impact and blast radius

Fixed global ledgers claim current readiness without current provenance, can be overwritten by independent runs, and are invisible to the existing work-index guard. Evidence credibility, readiness gates, taxonomy SSOT, plan traceability, parallel-agent runs, and public reproducibility claims.

## #2553: reliability(transport): ambiguous Twilio sends are retried without an idempotency boundary

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `audit`, `bug`, `reliability`, `transport`
- Recommended labels: `P4`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: #2343, #2447, #2555, #2556, #2558, #2559

### Evidence

Three fresh stable live reads pinned the post-P4 open identity, label, update time, URL, and exact 7,491-byte body hash while API main remained de3f69bbb5648b804ea2843d310c47dda544a056. Exact-main source shows OutboundQueue reuses a stable messageId, but the Twilio bridge accepts only chat and text, the adapter forwards no logical-send key, the port contract exposes no idempotency field, and the SDK call uses messages.create without one. A network-level send failure is deliberately mapped to retryable TransientProviderError even though the adapter notes that provider acceptance is ambiguous. Every decisive path is byte-equal between the pin and audit branch. The joint focused pinned-runtime run passed 721 of 721 tests across 15 files; existing tests prove stable queue identity and ambiguous transient mapping but not end-to-end provider idempotency. After discarding one drifted PR attempt, a replacement fully paginated capture produced three identical digest ed35591e6ce60081b2aa5ddf3b522718b40adb710ae8bc5119b6028944fa5300 reads across 37 open PRs, 27 drafts, and 1,402 declared and observed file rows. It found no owner; PR #2451 is a narrow taxonomy partial and every touched implementation path is a collision. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed every Twilio and outbound retry path is unchanged and no provider idempotency boundary was added. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Body-free live identity reads and API, SSH, and origin-main gates remained stable at 29fe568cdfbb25475340268571d1818da64395ef. PR #2488 changes only minimal-mode tool-progress presentation in outbound-queue.ts and its tests. The retry loop, Twilio bridge/adapter/port, declared sendText idempotency 'none', and messages.create call remain unchanged, so the ambiguous-send/idempotency finding survives and PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Thread a stable logical-send identity through the bridge, adapter, port, and provider when Twilio supports a proven idempotency boundary. Otherwise distinguish failures before provider invocation from failures after invocation, record post-call uncertainty as maybe-sent ambiguity, suppress blind retry, and reconcile using bounded provider receipt evidence.

### Impact and blast radius

A Twilio request accepted before a client-side network failure can be sent again under a new provider request, delivering duplicate SMS while the durable queue believes it is performing a safe retry. Twilio chat and agent sends, durable outbound retries, recovery classification, customer SMS billing, duplicate delivery, and operator diagnostics.

## #2554: reliability(scheduler): non-Baileys text schedules are accepted then retried as unsupported

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `audit`, `bug`, `reliability`, `scheduler`
- Recommended labels: `P4`, `audit`, `bug`, `reliability`, `scheduler`, `transport`
- Dependencies: None

### Evidence

Three stable live reads pinned the open identity, P4 label, update time, URL, and exact body hash while remote and API main remained de3f69bbb5648b804ea2843d310c47dda544a056. No decisive or affected path changed from that audited main. Observed exact-main HTTP and MCP paths share an enqueue helper that validates payload shape but receives no runtime transport or capability input. Observed scheduler text execution always calls sendRaw. Observed Twilio, Signal, and iMessage bridges all reject sendRaw, and the scheduler's general failure path resets the row to pending until its retry budget is spent. The relevant pinned-runtime suites passed 397 of 397 tests, but none proves non-Baileys schedule admission or canonical text execution. A fully paginated stable-main scan captured 36 of 36 open pull requests, 28 drafts, 41 changed-file pages, and 1,400 file occurrences with digest 74bd768b2a19609d61908feab1fc6aec9afd8cb6423e04573531631caf1a3a81. Two open PRs collide on bridge identity handling only. No open PR references or owns this fix. Merged PRs #731, #1685, #2010, and #2383 are partial producer-side context. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check found this issue stable, and every recorded decisive, test, and affected path is byte-identical from 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd to 0f621d0296760919f1a49ea595ca23e55f3a89ac; API and SSH main stayed exact, so this record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Make schedule admission transport-aware, route supported text through a transport-neutral sendText or sendMessage seam, reject unsupported content before persistence, and classify fire-time capability drift as permanent or operator-actionable rather than retryable.

### Impact and blast radius

Users receive a successful durable schedule admission on non-Baileys runtimes even though the fire-time bridge rejects the only method the scheduler calls, causing deterministic retries, delayed failure, and possible recurring-occurrence skips. Every scheduled message on Twilio, Signal, or iMessage, including one-shot and recurring row state, retry budgets, operator alerts, HTTP and MCP admission, and misleading pending status.

## #2555: reliability(twilio): limiter waits outlive send timeouts and deliver every abandoned retry

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P4`, `audit`, `bug`, `reliability`, `transport`
- Recommended labels: `P4`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: #2553

### Evidence

Three stable live reads pinned the open identity, P4 label, update time, URL, and exact body hash while remote and API main remained de3f69bbb5648b804ea2843d310c47dda544a056. No decisive or affected path changed from that audited main. Observed exact-main agent-queue code races each send promise against a 15-second timeout but neither aborts nor awaits the losing promise before retrying. Observed Twilio sendText awaits the classic limiter acquire, whose contract never rejects and whose tests prove a 50-second wait plus serialized waiters out to 120 seconds; after reservation it calls the provider without an abort signal. Inferred from those observed seams: every timed-out attempt remains queued and can later call Twilio. The shared limiter already exposes a bounded acquire used by the Baileys governor, but Twilio keeps the unbounded method. The relevant pinned-runtime suites passed 397 of 397 tests; none integrates an agent timeout with Twilio pacing. A fully paginated stable-main scan captured 36 of 36 open pull requests, 28 drafts, 41 changed-file pages, and 1,400 file occurrences with digest 74bd768b2a19609d61908feab1fc6aec9afd8cb6423e04573531631caf1a3a81. Four open PRs collide only on identity, redaction, or tool-status code. No open PR references or owns this fix. Merged PRs #731, #1652, and #1718 are partial producer-side context. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Body-free live identity reads and all main authorities remained stable at 29fe568cdfbb25475340268571d1818da64395ef. PR #2488 touches only outbound minimal-mode presentation; the 15-second Promise.race, uncancelled losing send, unbounded Twilio limiter acquire, and provider call boundary are unchanged. The late-send reservation finding survives; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Thread an AbortSignal or ownership token through the outbound queue, Messenger, Twilio bridge, adapter, limiter, and port; use bounded acquisition below the owning deadline; remove canceled FIFO reservations; and prove that abandoned attempts cannot reach the provider.

### Impact and blast radius

When a destination is rate-limited, the agent queue can declare multiple attempts timed out while all underlying limiter waits remain live; as slots open, those abandoned attempts can each reach Twilio and deliver duplicate SMS after the logical send was failed. Rate-limited Twilio agent replies and status messages, including late SMS delivery, multiplied provider calls, shutdown leakage, outbound durability ambiguity, rate-window accounting, and customer cost.

## #2556: reliability(identity): non-Baileys bridges drop trusted caller provenance and record false ambiguity

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`, `transport`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: #2517, #2553, #2555

### Evidence

Three prior stable reads plus the retry read pinned the open identity, P1 label, timestamp, URL, and body hash while remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. Exact-main SendOptions and sendTracked carry caller provenance, and Baileys consumes it, but the iMessage, Signal, and Twilio bridge methods accept only two arguments and hard-code caller agent. Their synchronous identity rejection occurs before adapter sendText, while sendTracked catches every rejection and records maybe_sent. The decisive application and test paths are byte-equal between exact main and the audit branch. A supporting focused run passed 525 of 525 tests across nine files; existing coverage proves Baileys caller forwarding and deterministic guard rejection but does not prove non-Baileys caller propagation. A fully paginated stable-main capture covered 37 open pull requests, 27 drafts, and all 1,402 declared file occurrences. It found no issue reference, closing reference, semantic owner, or partial implementation; all 15 matches are path collisions. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check found this issue stable, and every recorded decisive, test, and affected path is byte-identical from 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd to 0f621d0296760919f1a49ea595ca23e55f3a89ac; API and SSH main stayed exact, so this record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed transport provenance and durable send-disposition paths are unchanged; the durability delta adds unrelated lifecycle delegation. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Thread SendOptions through every bridge, preserve the existing trusted-call-site boundary, and classify structured pre-provider identity rejection as a definitive non-send so durability settles failed_permanent without entering ambiguity recovery.

### Impact and blast radius

Trusted infrastructure sends can be rejected as ordinary agent sends on non-Baileys transports, and the deterministic pre-provider rejection is then promoted into false delivery ambiguity. Trusted health and infrastructure sends, cold-target enforcement, iMessage, Signal, SMS, durable outbound disposition, recovery ambiguity, and operator diagnostics.

## #2557: reliability(rate-limit): retry hints are truncated below producer windows and exhausted as false ambiguity

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`, `transport`
- Recommended labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: #2447, #2553, #2555, #2558

### Evidence

Three prior stable reads plus the retry read pinned the open identity, five labels, timestamp, URL, and body hash while remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. Exact-main Signal source computes a retryAfterMs from its 60-second per-conversation window, and the transport error contract preserves that value, but OutboundQueue clamps every positive hint to its generic 8-second backoff ceiling. The queue then consumes its fixed attempts and records non-governor exhaustion as maybe_sent even though the local limiter rejected before adapter delivery. Exact-main durability has no retry_not_before or equivalent deferred-work field. An existing test explicitly requires a 999,999 ms producer hint to become 8,000 ms. The decisive application and test paths are byte-equal between exact main and the audit branch, and a supporting focused run passed 525 of 525 tests across nine files. A fully paginated stable-main capture covered 37 open pull requests, 27 drafts, and all 1,402 declared file occurrences. Draft PR #2451 partially coordinates taxonomy but does not own retry behavior; PRs #2456 and #2488 are path collisions, and no implementation owner exists. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed retry-window, queue, and transport-error paths are unchanged and no durable retry deferral field was added. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Body-free live identity reads and all main authorities remained stable at 29fe568cdfbb25475340268571d1818da64395ef. PR #2488 does not alter retry scheduling: retryAfterMs is still capped with Math.min(..., SEND_RETRY_MAX_MS), attempts remain fixed, and no durable retry-not-before field exists. The producer-window truncation finding survives; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. Live ownership refresh independently confirmed draft PR #2596 at exact head ecd105936d7d81c1d04bd4aa51effaf5f5f6e488, its direct closing reference for this three-issue cluster, the issue-specific draft comment, and one automatic timeline cross-reference. Hosted checks remain in progress, so IN PROGRESS remains and PATCH READY is not asserted. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. Exact-head lifecycle re-read confirmed every hosted check on draft PR #2596 succeeded at ecd105936d7d81c1d04bd4aa51effaf5f5f6e488, the issue-specific completion comment and one automatic timeline backlink are present, IN PROGRESS is absent, and PATCH READY is present. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Separate producer retry windows from generic backoff caps, persist a retry_not_before authority for deferred work, avoid consuming attempts until the window opens, and classify local pre-provider exhaustion as failed_permanent rather than delivery ambiguity.

### Impact and blast radius

A producer can require a wait far beyond eight seconds, yet the consumer retries early, burns all attempts inside the closed window, and records false delivery ambiguity for work that never reached the provider. Signal and future transport rate limits, agent outbound latency, retry budgets, durable queue recovery, shutdown behavior, duplicate risk, delivery-state truth, and operator telemetry.

## #2558: reliability(outbound): retryable=false transport errors are retried and persisted as ambiguous

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`, `transport`
- Recommended labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: #2447, #2553, #2554, #2557

### Evidence

Three prior stable reads plus the retry read pinned the open identity, five labels, timestamp, URL, and body hash while remote main remained de3f69bbb5648b804ea2843d310c47dda544a056. Exact-main transport errors carry retryable, scope, phase, and code; AuthRequiredError, PermanentProviderError, UnsupportedCapabilityError, and SendAmbiguousError are retryable false. Agent OutboundQueue ignores retryable and retries every caught error except only classifying governor sheds after exhaustion. Chat runtime likewise retries every send error and distinguishes only governor sheds before recording the remainder maybe_sent. Existing contract tests prove the structured false values, while runtime tests intentionally classify generic permanent failure as maybe_sent and have no retryable-false consumer assertions. The decisive application and test paths are byte-equal between exact main and the audit branch, and a supporting focused run passed 525 of 525 tests across nine files. A fully paginated stable-main capture covered 37 open pull requests, 27 drafts, and all 1,402 declared file occurrences. Draft PR #2451 partially coordinates taxonomy but does not own consumer policy; five other PRs are path collisions, and no implementation owner exists. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed both outbound loops and the structured retryability contract are unchanged. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 9da1e88507034461aad1b6c26134f6ec84f3b119 to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path byte-identical from e82e61fc54762f852bb480bf43eb04094141bc6f to 5759471a09b45d4727d9489ba0581fa23c972f30; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Body-free live identity reads and all main authorities remained stable at 29fe568cdfbb25475340268571d1818da64395ef. PR #2488 changes only minimal-mode presentation. Agent sendWithRetry and chat runtime still retry without branching on structured retryable/phase values and persist non-governor exhaustion as maybe_sent. The finding survives; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. Live ownership refresh independently confirmed draft PR #2596 at exact head ecd105936d7d81c1d04bd4aa51effaf5f5f6e488, its direct closing reference for this three-issue cluster, the issue-specific draft comment, and one automatic timeline cross-reference. Hosted checks remain in progress, so IN PROGRESS remains and PATCH READY is not asserted. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. Exact-head lifecycle re-read confirmed every hosted check on draft PR #2596 succeeded at ecd105936d7d81c1d04bd4aa51effaf5f5f6e488, the issue-specific completion comment and one automatic timeline backlink are present, IN PROGRESS is absent, and PATCH READY is present. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Create one shared transport-error disposition policy consumed by both outbound runtimes: retry only retryable errors, settle definitive not-started failures as failed_permanent, preserve provider-started ambiguity without retry, and retain bounded transient and rate-limit behavior.

### Impact and blast radius

Definitive failures can trigger duplicate or pointless provider calls, exhaust retry budgets, emit misleading user notices, and enter ambiguity recovery even when the transport contract says not to retry. Agent and chat outbound delivery, all typed transports, authentication and permanent failures, ambiguous-send handling, retry duplication, durability recovery, inbound completion, user notices, and failure telemetry.

## #2559: durability(outbound): typed transport failures collapse into raw prose before recovery

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`, `transport`
- Recommended labels: `P1`, `PATCH READY`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: #2164, #2343, #2447, #2517, #2553, #2557, #2558, #2560

### Evidence

Three stable live reads pinned the open issue identity, five labels, timestamp, URL, and exact body hash. Remote main advanced once during the audit through a presentation-only refactor; the audit failed closed on the old pin, recaptured 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd, and proved every decisive and affected path byte-identical across the advance and audit worktree. Exact-main source stores outbound failure as uncontrolled error text, accepts only strings at maybe-sent and permanent-failure transitions, omits status and error from status-based recovery rows, leaves retry_count without production attempt semantics, and receives typed transport code, retryability, and phase only before this journal boundary. A pinned Node 24.15 focused run passed all 470 tests across twelve files. The complete stable frontier contained 36 open pull requests, 27 drafts, all 1,400 declared file occurrences, and one complete closing reference; 18 open pull requests had collision or coordination overlap and none owns implementation. Draft PR #2451 explicitly names #2559 as a separate grouped slice and supplies shared taxonomy only, so it is partial rather than an owner. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed outbound schema, send pipeline, raw error persistence, and attempt accounting are unchanged. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Body-free live identity reads and all main authorities remained stable at 29fe568cdfbb25475340268571d1818da64395ef. PR #2488 changes outbound presentation only; the durability schema and transitions still persist unbounded error strings, and recovery still lacks a bounded typed transport-failure record. The finding survives; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. Recovery-run records gained adjacent bounded error context, but outbound journal rows still lack one typed failure-evidence contract and defined logical-attempt semantics. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. Live ownership refresh independently confirmed draft PR #2596 at exact head ecd105936d7d81c1d04bd4aa51effaf5f5f6e488, its direct closing reference for this three-issue cluster, the issue-specific draft comment, and one automatic timeline cross-reference. Hosted checks remain in progress, so IN PROGRESS remains and PATCH READY is not asserted. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. Exact-head lifecycle re-read confirmed every hosted check on draft PR #2596 succeeded at ecd105936d7d81c1d04bd4aa51effaf5f5f6e488, the issue-specific completion comment and one automatic timeline backlink are present, IN PROGRESS is absent, and PATCH READY is present. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce one versioned outbound failure-evidence record containing bounded code, send stage, delivery mutation state, retry decision and owner, retry-not-before time, logical and provider-submission attempts, timestamps, and evidence coverage. Require all state transitions and recovery readers to use it, scrub or isolate raw prose, treat legacy rows as unclassified, and either define or remove retry_count.

### Impact and blast radius

Recovery and operators cannot distinguish pre-I/O denial, definitive rejection, ambiguous provider handoff, crash-in-flight, or replay ownership. Raw provider prose becomes durable privacy and compatibility debt, while false ambiguity and nonexistent attempt accounting weaken safe recovery. Outbound durability schema and migrations, agent and chat send transitions, pending draining and restart recovery, health and operator diagnostics, incident grouping, runbook procedures, retention, and transport error consumers.

## #2560: observability(durability): quarantine signal reports never-sent housekeeping as message loss

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`
- Dependencies: #2343, #2413, #2447, #2559

### Evidence

Three stable live reads pinned the open issue identity, four labels, timestamp, URL, and exact body hash. After remote main advanced through a presentation-only refactor, all decisive and affected paths remained byte-identical at 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd and in the audit worktree. Exact-main durability code marks both unreconstructable rows and stale status notices quarantined, emits the same outbound_quarantined source, and aggregates every quarantined row into one health count. The status-notice branch runs before provider send and is intentionally no-send, while runbook text describes positive quarantine as lost messages. Recovery and operator retirement use different clear predicates. The pinned Node focused run passed 470 of 470 tests across twelve files. A stable complete frontier covered 36 open pull requests, 27 drafts, all 1,400 declared file occurrences, and one complete closing reference; 14 open pull requests had collision or coordination overlap and none owns implementation. Draft PR #2451 explicitly groups #2560 as a separate taxonomy slice but does not implement quarantine consequence persistence or consumer policy. A post-merge three-read identity check found this issue stable, and every recorded decisive, test, and affected path is byte-identical from 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd to 0f621d0296760919f1a49ea595ca23e55f3a89ac; API and SSH main stayed exact, so this record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed quarantine transitions, health aggregation, alerts, and clear predicates are unchanged. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Add a closed quarantine-disposition taxonomy distinguishing unsafe delivery ambiguity, stale status disposal, unreconstructable data, and other supported classes. Persist it at transition time, expose bounded counts by consequence, reserve loss alerts for real delivery risk, and define one contributor-aware onset, clear, retention, acknowledgement, and operator-action contract.

### Impact and blast radius

Harmless pre-send disposal can be reported as user-visible message loss, genuine ambiguity is indistinguishable from data incompatibility, and contradictory clear rules can leave operators and automation treating the same retained rows as both recovered and incident-active. Outbound pending drain, status-operation TTL, durability schema, restart recovery, health aggregation, alert routing and clearing, operator retirement, terminal retention, monitoring, and runbook procedures.

## #2561: durability(tools): raw inputs and results persist while error status lacks a bounded failure taxonomy

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `IN PROGRESS`, `P1`, `audit`, `bug`, `reliability`, `security`
- Recommended labels: `IN PROGRESS`, `P1`, `audit`, `bug`, `reliability`, `security`
- Dependencies: #2164, #2386, #2407, #2447, #2517, #2570

### Evidence

Three stable live reads pinned the open issue identity, five labels, timestamp, URL, and exact body hash. The remote-main advance to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd changed only agent presentation files; every decisive and affected path remained byte-identical across the advance and audit worktree. Exact-main tool_calls stores serialized input for most tools and complete success or error result text, while terminal error is correctly excluded from recovery and included in retention. The schema has no bounded failure class, stage, retry or actionability decision, or evidence coverage, and health has no separate tool-failure or telemetry-loss aggregate. The published metadata-only plan remains documentation, names an already-consumed migration, and shows a stale string-prefix completion contract. A pinned Node 24.15 run passed all 470 focused tests across twelve files, including 37 current tool-durability, retention, and erasure-registry tests. The stable frontier contained 36 open pull requests, 27 drafts, all 1,400 declared file occurrences, and one complete closing reference; 19 open pull requests had collision or coordination overlap and none owns implementation. PR #2451 comments explicitly assign #2561 a separate slice, and the later #2570 comment plus cross-reference establishes memory-telemetry coordination without adding implementation. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed tool-ledger schema, persistence, retention, and health behavior are unchanged; the documentation delta covers provider policy only. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. Exact-main rereview at af753d288faab9e1f7258a318f9f739433804cfe confirms that the memory_write surface is now confidential and bounded, while the generic tool_calls journal still persists raw inputs/results without a generic bounded outcome contract. The issue is partially resolved and remains open. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. An exact-main semantic rereview of merged PR #2488 at API, SSH, and origin main 29fe568cdfbb25475340268571d1818da64395ef inspected all 18 changed paths and the intersecting memory-write source, test, and configuration paths. The merge admits pinned-conversation global memory_write calls but does not change the generic tool_calls journal, which still persists serialized inputs and complete results without bounded stage, failure, or evidence-coverage fields. The existing partial finding, owner boundary, and dependency order survive; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define a generic durable tool-call outcome envelope with bounded tool class, stage, status, failure code, retryability, and evidence coverage; redact or encrypt raw inputs/results according to an explicit privileged-diagnostics policy.

### Impact and blast radius

Tool parameters, results, and exception prose remain a durable content archive during retention while operators lack stable failure classes. Migration guidance is stale, diagnosis depends on raw content, and loss of telemetry is indistinguishable from successful evidence capture. tool_calls schema and migration reservation, MCP registry execution and denial paths, durability and restart recovery, retention, health and alerts, tool-group vocabulary, documentation, backups, and every tool that returns or throws content-bearing results.

## #2562: security(audit): outbound send ledger leaks raw metadata, erases ambiguity, and grows unbounded

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `IN PROGRESS`, `P1`, `audit`, `bug`, `reliability`, `security`
- Recommended labels: `IN PROGRESS`, `P1`, `audit`, `bug`, `reliability`, `security`
- Dependencies: #2559

### Evidence

Three stable live reads pinned the open identity, five labels, update time, URL, and exact body hash while API main remained de3f69bbb5648b804ea2843d310c47dda544a056. All 14 affected paths, including 12 decisive source and test paths, matched that exact revision. Seven deterministic issue-specific source assertions passed. Observed exact-main schema stores raw destination identity, alias, profile, message-derived hash and length, free-form error text, and provider transport identifier. The writer's error sanitizer only truncates to 1,000 characters, and the global read tool returns raw chat identity, profile, transport identifier, and error text. The status CHECK permits only intent, sent, and failed; the send pipeline converts every thrown transport result into failed, so it cannot preserve provider-call ambiguity. The canonical retention sweep does not delete outbound_sends, while public documentation explicitly declares retention unbounded and offers a manual SQL deletion recipe. Five focused pinned-source suites passed 98 of 98 tests, including tests that assert the raw fields, generic failed collapse, and lack of message bodies, but none proves bounded metadata, ambiguous delivery truth, or automatic retention. A fully paginated retry after one correctly rejected drifting attempt completed with stable opening and closing inventories: 37 open pull requests, 27 drafts, 42 changed-file pages, 37 closing-reference pages, and all 1,402 declared file occurrences, digest e3f2a6c9ca59810e38935fdc0bd7d5494e6967a2f36c91595476fed037cafd4b. No open pull request references, closes, or owns this issue; 14 are path collisions. Merged PR #57 introduced the current audit surface and is historical partial context. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed the only intersecting file change documents provider data policy; outbound audit, ambiguity, and retention behavior remain unchanged. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A lead-integrated semantic rereview of merged PR #2452 at exact API and SSH main e82e61fc54762f852bb480bf43eb04094141bc6f confirmed that its read-only continuity-manifest and operator-documentation changes do not alter this issue's finding, classification, owner boundary, or dependency order. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. An exact-main semantic rereview of merged PR #2488 at API, SSH, and origin main 29fe568cdfbb25475340268571d1818da64395ef found only documentation intersections in the knowledge-search sections; the outbound audit schema, projection, delivery-state model, and retention paths are unchanged. Minimal-mode progress suppression does not provide bounded retention or a safe audit projection. The verified finding, owner boundary, and dependency order survive; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Replace the append-forever raw row with a versioned audit projection built from a closed allowlist: opaque non-reversible destination correlation, bounded caller and outcome taxonomy, no free-form error or provider identifier, and explicit confirmed-sent, confirmed-not-sent, ambiguous, and reconciled states. Feed terminal rows into the canonical database-retention sweep while preserving unresolved reconciliation and idempotency evidence. Migrate legacy rows transactionally by redacting or tombstoning unsafe fields, then expose only an authorized bounded read projection.

### Impact and blast radius

A routine audit row can retain and re-expose destination identity, routing aliases, profile names, provider identifiers, message-derived fingerprints, and arbitrary exception text indefinitely. At the same time, a post-provider-call rejection is flattened to failed, which can authorize an unsafe resend even though delivery may have occurred. The result combines privacy exposure, unbounded storage growth, misleading operator evidence, and duplicate-delivery risk. Every MCP, authenticated health, and Reply Guarantee Protocol send audited through outbound_sends; local database backups and retention; global read_outbound_sends callers; delivery reconciliation and retry decisions; operator investigations; migration compatibility; and any consumer that treats failed as proof that no provider-side effect occurred.

## #2564: security(heal): replace raw forensic context with a bounded private evidence projection

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`, `security`
- Recommended labels: `P1`, `audit`, `bug`, `reliability`, `security`
- Dependencies: #2561

### Evidence

Three fresh stable reads pinned the open identity, five labels, update time, URL, exact body hash, one comment, and all 15 timeline items while API main and the SSH origin main ref remained de3f69bbb5648b804ea2843d310c47dda544a056. The comment digest is 9b4f4e2e33d374b6ce47119bc4ce89b97bdb27baa2cdf9f748ca7adc719b543d and the timeline digest is 1ffe7dfa4ce837b26a0545dc477eb0ed79c189a6cfd3b099dcd958064981bd5b; the stable comment expands this issue's owner boundary to pending heal and control-message persistence, and the only later target dependency cross-reference is #2561. All 16 affected paths matched the exact revision. Nine deterministic source falsifiers passed: raw report persistence and dispatch, stderr and recent-log rendering, unbounded protocol strings, raw POST /heal persistence and spreading, full control-message storage, diagnosis retransmission, and missing retention for heal and control tables. Seven focused suites passed 111 of 111 tests. A fresh fully paginated capture covered 37 open pull requests, 27 drafts, 42 changed-file pages, 37 closing-reference pages, and all 1,402 declared file occurrences. The target-semantic digest, including heads, bases, states, body hashes, labels, files, and closing references, is 9f88de63d98aba876de8f8eae0ad74ac421795041e1a4da5da6cb03992196f15. No open pull request references or closes #2564; 16 touch affected paths. PR #2451's latest verified update time is 2026-07-27T04:04:36Z; its head remains f50086344f8013850e568dc60aaece528850a9fd, body hash 07f71027d737fbae5bb9fa155b06c33b56567445c7dbea9dc5e8792d66c6a097, P3 label, 13 files, open draft state, main base, and closing reference #2448 remained unchanged. All four post-frontier comments and eight timeline items were enumerated; they concern only #2567 through #2570 and none references or claims #2564. Merged PRs #273, #1766, and #2132 are historical partial context. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged. Claim-specific inspection confirmed the only intersecting file change documents provider data policy; consolidation health and recovery behavior remain unchanged. The exact-pin cohort tests passed without skips, and API and SSH main stayed exact, so the record is repinned from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. An exact-main semantic rereview of merged PR #2488 at API, SSH, and origin main 29fe568cdfbb25475340268571d1818da64395ef found only unrelated configuration and knowledge-tool documentation intersections. Heal schemas, raw context persistence, retransmission, control traffic, and retention paths are unchanged. The verified finding, owner boundary, and dependency order survive; PR #2488 is collision-only. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define one versioned, strict, closed heal-evidence projection shared by HTTP ingestion, protocol validation, persistence, runtime dispatch, control messages, fallbacks, human reports, and operator notifications. Permit only bounded low-cardinality reason and diagnosis codes plus an opaque reference to a separately authorized private artifact; validate before persistence, eliminate object spreading and free-form retransmission, add transactional retention, and irreversibly redact or expire legacy raw context.

### Impact and blast radius

A crash, operator request, or provider failure can persist and retransmit raw stderr, recent logs, chat identity, free-form diagnosis, paths, tokens, secrets, and other forensic context across database rows, control messages, runtime dispatch, and operator notifications. Those stores are outside canonical retention, extending exposure through backups and routine operations. Every crash and operator-triggered heal entering POST /heal or the heal protocol; heal_reports, pending_heal_reports, and control_messages persistence; runtime dispatch; operator notifications; fallback and human reports; local backups and retention; and downstream agents receiving repair evidence.

## #2565: reliability(enrichment): failed cycles record success or stay healthy after restart

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: #2212, #2447, #2514, #2538, #2567, #2568

### Evidence

Three restarted target-frontier reads pinned the open identity, labels, 2026-07-27T03:54:15Z update time, URL, and exact 10,972-byte body hash while API main remained de3f69bbb5648b804ea2843d310c47dda544a056. All two declared comments were retrieved on every read: their normalized digest was 471ad3bc31cf2083f24051584b963a3f4bc46c291b9da37061f5e2ae8e007a29, the complete timeline digest was bcffb6e526b165153f16db1ea8e22a058dc860be7cda987c56033eb63ebcb147, and the issue/comment/timeline relationship digest was eba7219016b5e65d53d96978266cf92ef5b2a78e731b47ad4914b87c664a1ac9. The new relationships explicitly preserve separate owners: #2567 owns downstream fact-export queue claim, lease, remote confirmation, acknowledgement, retention, and health; #2568 owns consolidation-cycle truth but should reuse this issue's run-ledger vocabulary with distinct counters. Exact-main source records escaped outer-cycle failures and freezes lastRunAt, but caught segment and accounting failures still flow into a success-shaped enrichment_runs row and advance lastRunAt. The ledger has no typed outcome or production health reader, and restart discards the process-local freshness input despite durable failures. Every decisive path is byte-equal between the pin and audit branch; the pinned-runtime focused run passed 721 of 721 tests across 15 files. A fresh complete internally stable capture covered 37 open PRs, 27 drafts, and 1,402 declared and observed file rows with digest 4f77de36c8bd3b1ba922f365f057e5fc39a666fa55a977743e3bb0029fbb59d9. Its target semantic projection digest was 874e971708149cd36bd3b56bb5462079b1bcdf953243ed0836f80121b05a3133. It found no owner; PR #2451 is a narrow taxonomy partial and all other matches are collisions, so no implementation cohort is proposed without an owner PR. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define a typed durable enrichment-cycle outcome with source, stage, bounded cause, attempt freshness, success freshness, counts, and evidence coverage. Make segment and accounting failures explicit, hydrate health from a fail-closed durable reader, distinguish no-work and unreadable observation, split extracted, queued, remotely confirmed, and acknowledged milestones at the #2567 boundary, and share only the run-ledger vocabulary with #2568 while retaining producer-specific counters.

### Impact and blast radius

Completely or partially failed enrichment can be recorded as success, refresh the apparent success clock, or restart into healthy/null while durable failure evidence is ignored; queue admission can also be mistaken for exported memory. Chat enrichment extraction and validation, message accounting, fact-export handoff, backfill and consolidation interoperability, runtime and top-level health, restart behavior, retention, alerts, console projections, and operator recovery decisions.

## #2566: durability(substrate): trigger execution has no durable in-flight owner or recurring liveness

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`, `scheduler`
- Dependencies: #2144, #2417, #2447

### Evidence

Three fresh stable live reads pinned the open identity, labels, update time, URL, and exact 11,519-byte body hash while API main remained de3f69bbb5648b804ea2843d310c47dda544a056. Exact-main processTrigger awaits the executor before inserting trigger_runs; after execution it inserts running and terminalizes the row in one transaction. The schema has no owner, lease, heartbeat, generation, or occurrence identity, attempt is always one, and finishRun updates by row ID without a fencing predicate. The poller's timer does recur, but its liveness watchdog runs after the same sequential execution loop, counts only triggers that have never fired, and publishes no independent durable cycle freshness. Existing tests prove timer rescheduling and terminal run rows but not a committed in-flight row, restart reclamation, or recurring post-success liveness. Every decisive path is byte-equal between the pin and audit branch. The joint focused pinned-runtime run passed 721 of 721 tests across 15 files. A replacement fully paginated capture produced three identical digest ed35591e6ce60081b2aa5ddf3b522718b40adb710ae8bc5119b6028944fa5300 reads across 37 open PRs, 27 drafts, and 1,402 declared and observed file rows. It found no owner; PR #2451 is a narrow taxonomy partial and every other match is a collision. A post-merge three-read revalidation found the live identity unchanged and every recorded decisive, test, and affected path byte-identical from de3f69bbb5648b804ea2843d310c47dda544a056 to 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd; API and SSH main stayed exact, so this record is repinned to the latter revision. A post-merge three-read identity check found this issue stable, and every recorded decisive, test, and affected path is byte-identical from 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd to 0f621d0296760919f1a49ea595ca23e55f3a89ac; API and SSH main stayed exact, so this record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Atomically create and commit a stable occurrence claim before execution, transition through fenced lease generations with bounded renewal, compare-and-swap terminalization, and reconcile expired claims on restart according to executor mutation evidence. Run liveness observation independently of executor progress, count recurring missed occurrences, separate execution from notification delivery, and add redacted history plus bounded retention.

### Impact and blast radius

A crash or hang during trigger execution leaves no durable proof or recovery owner, can replay ambiguous side effects after restart, blocks later triggers, and can remain healthy after the trigger previously fired once. All substrate trigger kinds, scheduled agent jobs, side-effect replay, notification delivery, restart recovery, poller availability, health and alerts, operator history, and database retention.

## #2567: reliability(memory): fact export queue has no verified drain, lease, or health contract

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: #1445, #2412, #2447, #2514, #2565

### Evidence

Three fresh stable reads pinned the open identity, empty labels, update time, URL, and exact 11,993-byte body hash while API and SSH main remained 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd. The main advance from the prior audit pin changed only agent runtime presentation files outside this target; all 21 jointly audited target paths remained byte-identical to the new pin. Exact-main claimPendingFacts selects pending rows without changing ownership, lease, attempt, or retry state, so concurrent consumers can receive the same row. markFactsExported returns no outcome, suppresses per-row write failures, and acknowledges only pending rows without lease fencing. The schema has no state constraint or consumer evidence, retention deletes only exported rows, and runtime health observes source-message enrichment rather than queue or consumer state. Production-source search found no caller for either bridge helper. The fresh pinned-runtime target suite passed 329 of 329 tests across five files; existing tests accept repeated claims, silent unknown acknowledgements, retained pending rows, and health without an export observer. Two complete stable open-PR captures each covered 36 PRs, 27 drafts, 41 changed-file pages, 36 closing-reference pages, and 1,400 declared and observed file rows with digest 45f3020487252dad754621ccfb40b858489e9ceea677b206c451158438fa3dfb. No PR body or closing reference owns this target. PR #2451's fixed head, body hash, state, labels, 13 files, and closing reference #2448 were rechecked with all 31 comments and 73 timeline items; its target comments propose vocabulary and grouping but explicitly add no implementation and retain the architecture gate, so it is partial rather than an owner. A post-merge three-read identity check and exact-main diff review found the only intersecting changes were trusted-internal-DM audience-redaction wiring or its configuration documentation, leaving this issue’s recorded retry, delivery, ledger, heal, enrichment, and queue control-flow claims unchanged. A detached exact-main run passed 890 of 890 tests across the union of 29 decisive test files; API and SSH main stayed exact, so this record is repinned to 0f621d0296760919f1a49ea595ca23e55f3a89ac. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Choose and document an owned in-process drainer or a required versioned external-consumer capability, then implement an enforced queue state machine with atomic leased claims, attempt and backoff evidence, fenced per-ID acknowledgements, idempotent remote identity, and crash reconciliation. Separate queued, claimed, remotely confirmed, and durably acknowledged milestones; minimize identifiers and payloads; add bounded terminal and quarantine retention; and project a redacted restart-aware queue and consumer reader into runtime health and alerts.

### Impact and blast radius

Queue admission can be mistaken for durable external memory while no consumer exists, duplicate consumers can repeat remote writes, acknowledgement failures can silently diverge local and remote state, sensitive pending or quarantined payloads can persist indefinitely, and runtime health can stay green throughout. Chat enrichment completion semantics, fact-export queue rows and identifiers, external memory writes, bridge deployment topology, retry and crash recovery, runtime and top-level health, alerts, retention, operator triage, and migration of legacy rows.

## #2568: reliability(memory): consolidation failures and hung runs report success or remain invisible

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `PATCH READY`, `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `PATCH READY`, `SSOT`, `audit`, `bug`, `reliability`, `scheduler`
- Dependencies: #2323, #2412, #2447, #2514, #2565, #2567

### Evidence

Three fresh stable reads pinned the open identity, empty labels, update time, URL, and exact 12,547-byte body hash while API and SSH main remained 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd. The main advance from the prior audit pin changed only agent runtime presentation files outside this target; all 21 jointly audited target paths remained byte-identical to the new pin. Exact-main consolidateCluster converts provider rejection and parse failure into the ordinary empty result and validates only the two top-level arrays. runConsolidation calls the lossy search API, increments processed before outcome is known, uses promoted for dry-run intent, and cannot distinguish the swallowed failure from a valid no-promotion decision. runOnce returns void and logs resolved reports as complete; a hung run makes later ticks skip, while stop can time out with the active promise retained and no cancellation or post-stop mutation fence. No durable run receipt or consolidation health reader exists. The fresh pinned-runtime target suite passed 253 of 253 tests across six files, including accepted failure-to-empty, skipped-overlap, and stop-timeout behavior. Two complete stable open-PR captures each covered 36 PRs, 27 drafts, 41 changed-file pages, 36 closing-reference pages, and 1,400 declared and observed file rows with digest 45f3020487252dad754621ccfb40b858489e9ceea677b206c451158438fa3dfb. No PR body or closing reference owns this target. PR #2451's fixed head, body hash, state, labels, 13 files, and closing reference #2448 were rechecked with all 31 comments and 73 timeline items; its target comments propose vocabulary and grouping but explicitly add no implementation, so it is partial rather than an owner. A post-merge three-read identity check found this issue stable, and every recorded decisive, test, and affected path is byte-identical from 160a2c2fb2bfeda3189d70ba5bb9c5dd5f9799cd to 0f621d0296760919f1a49ea595ca23e55f3a89ac; API and SSH main stayed exact, so this record is repinned to the latter revision. A further three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 0f621d0296760919f1a49ea595ca23e55f3a89ac to 7c2843ee70e1947627a45a0256b3e8be996d90fd; API and SSH main stayed exact, so it is repinned to the latter revision. A final three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 7c2843ee70e1947627a45a0256b3e8be996d90fd to 3ea893430bec8d96228da0cc2834db0eb8a13242; API and SSH main stayed exact, so it is repinned to the latter revision. A current three-read identity audit found this record unchanged, and every recorded decisive, test, and affected path is byte-identical from 3ea893430bec8d96228da0cc2834db0eb8a13242 to 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed; API and SSH main stayed exact, so it is repinned to the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final live metadata reread confirmed this issue was newly claimed with IN PROGRESS and has no current implementation pull-request owner; PATCH READY is not asserted. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Define strict bounded cluster and run schemas with explicit mode, status, stage, cause, coverage, and separate intent, attempted-write, confirmed-write, discard, failure, and skipped counters. Consume status-preserving search, propagate deadlines and cancellation, fence writes after stop, return the typed report from runOnce, persist content-free bounded receipts, rehydrate health across restart, and alert on repeated skips and oldest-active age without exposing source or model content.

### Impact and blast radius

Provider outages and malformed output can look identical to valid no-promotion decisions, dry-run intent can look committed, a hung operation can suppress all later cycles without health evidence, shutdown can return while an expired operation may still mutate remote memory, and restart erases the only attempt and failure state. Memory search, clustering, model validation, promotion and discard writes, dry-run reporting, scheduler overlap and shutdown, restart recovery, runtime and top-level health, alerts, durable evidence retention, operator diagnosis, and provider failure taxonomy.

## #2569: correctness(memory): promote-only consolidation reprocesses sources without durable lineage

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `P1`, `SSOT`, `audit`, `bug`, `reliability`
- Dependencies: #2412, #2447, #2567, #2568, #2570

### Evidence

Three body-free live reads agreed on the open issue identity, empty labels, update time, URL, 13,463-byte body length, and body hash while API and SSH main both resolved to the exact pin. At exact main, runConsolidation performs an unfiltered semantic search, selects up to 100 recent records, and never marks, supersedes, or checkpoints the source records it processes. Each confirmed promotion writes a newly current user_fact with a claim-derived identifier and a fresh createdAt, but sourceMessagePks stays empty and the only lineage is a comma-joined provider-supplied evidence string. The DurableKnowledge model declares observation count and first, last, and promotion times, but the persisted promotion path does not populate that contract. A later run can therefore select the same unsuperseded sources and newly promoted output again, while overwrite, rewording, partial-write, and source-membership history remain unauditable. The exact-pin union falsifier run passed 455 of 455 tests across ten files with no skips; the consolidation suites preserve current promote-only and reprocessing behavior rather than disproving it. Three complete stable open-PR captures each enumerated 32 PRs, 26 drafts, 36 changed-file pages, 32 closing-reference pages, and 1,152 file rows with digest 0b0a74fc0fe95b70e7c03b96002dac4708e3cf9a0324bb553527f8ce69db0995. No open PR body or closing reference owns this target. PR #2451 has one target-specific coordination comment in the fully paginated 32-comment and 77-item timeline frontier, but its 13-file taxonomy-only change adds no consolidation lineage implementation, so it is partial rather than an owner. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Introduce a durable versioned consolidation decision ledger keyed by scoped source generation and algorithm version. Validate provider output structurally and require every source ID to be a unique member of the input cluster; atomically reserve or checkpoint source generations before remote mutation, use idempotent promotion generations, and record confirmed, rejected, retriable, partial, and superseded outcomes. Exclude durable outputs and completed unchanged sources from subsequent candidate selection while preserving explicit correction and replay paths, bounded retention, privacy-safe health, and migration behavior.

### Impact and blast radius

Repeated cycles can spend model and remote-write capacity on the same evidence, overwrite promotion history under a stable claim-derived ID, amplify a promoted record as if it were new evidence, and leave operators unable to prove which source generation produced or superseded durable knowledge. Memory candidate selection, scoped clustering, model-output validation, durable promotion identity, source provenance, retries and partial writes, correction and deletion propagation, scheduler health, retention, operator audit, and migration of existing promoted records.

## #2572: reliability(memory): startup readiness and context failures remain invisible to health

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `P1`, `SSOT`, `audit`, `bug`, `config`, `reliability`
- Recommended labels: `P1`, `SSOT`, `audit`, `bug`, `chat`, `config`, `reliability`
- Dependencies: #2412, #2447, #2514, #2538, #2565, #2567, #2568, #2570

### Evidence

Three body-free live reads agreed on the open issue identity, empty labels, update time, URL, 12,307-byte body length, and body hash while API and SSH main both resolved to the exact pin. Exact main performs one Pinecone readiness probe during startup and logs its state, but does not pass that state or a refreshable memory-capability reader to the health server. A failed startup probe only prevents consolidation from starting; chat enrichment is enabled by a nonempty index string, and runtime health can remain healthy with no successful memory evidence. Search and entity-search failures are converted to empty result sets with status and raw error data discarded by loadContext. The chat runtime separately converts rejected or timed-out context retrieval to null and continues, but records no bounded outcome, consecutive-failure count, freshness, or recovery transition. Chat health observes queue and enrichment timing only, so startup auth, index, project, network, breaker, retrieval, and context-loss states remain absent after restart and during turns. The exact-pin union falsifier run passed 455 of 455 tests across ten files with no skips; readiness tests stop at startup classification and health tests contain no end-to-end memory-capability contract. Three complete stable open-PR captures each enumerated 32 PRs, 26 drafts, 36 changed-file pages, 32 closing-reference pages, and 1,152 file rows with digest 0b0a74fc0fe95b70e7c03b96002dac4708e3cf9a0324bb553527f8ce69db0995. No open PR body or closing reference owns this target. PR #2451's target comment in the fully paginated 32-comment and 77-item frontier coordinates taxonomy and health projection but does not implement the provider-to-context observation path; all other matches are changed-path collisions. A final path-level audit found every recorded decisive, test, and affected path byte-identical from 6b90af2d51d71f19e3c50af8e5d829ed6d1889ed to 9da1e88507034461aad1b6c26134f6ec84f3b119; API and SSH main stayed exact, so this record is repinned to the latter revision. A lead-integrated semantic rereview of every recorded path changed from 9da1e88507034461aad1b6c26134f6ec84f3b119 to af753d288faab9e1f7258a318f9f739433804cfe confirmed that the merged guard, failure-taxonomy, and memory-telemetry changes do not alter this issue's recorded finding, classification, owner boundary, or dependency order; API and SSH main matched the latter revision. At af753d288faab9e1f7258a318f9f739433804cfe, provider detailed results and logging now expose safe bounded outcomes, but loadContext still consumes lossy array-only APIs and converts failures to empty context without durable or health-visible observation. The finding is narrowed but remains verified. A final path-level audit found every recorded decisive, test, and affected path byte-identical from af753d288faab9e1f7258a318f9f739433804cfe to e82e61fc54762f852bb480bf43eb04094141bc6f; API and SSH main matched the latter revision, so this record is safely repinned. A lead-integrated semantic rereview of merged PR #2455 at exact API and SSH main 5759471a09b45d4727d9489ba0581fa23c972f30 inspected every intersecting continuity-ledger, health, taxonomy, documentation, package, and test path. The merge does not close this issue's recorded finding or change its owner boundary or dependency order; where present, the overlap remains partial or collision-only. Exact-head review also found masked outer rollback failure, duplicate logical gaps across classification transitions, and corruption of the existing latest-recovery health signal, so hosted green checks are not treated as proof that those defects are absent. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 5759471a09b45d4727d9489ba0581fa23c972f30 to 4a2b1f2dcf058ed8138508dbf192643088f2fed3 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 4a2b1f2dcf058ed8138508dbf192643088f2fed3 to 29fe568cdfbb25475340268571d1818da64395ef delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 29fe568cdfbb25475340268571d1818da64395ef to 487bad4e64da457f6d601168fe43fcb49d9648b4 delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 487bad4e64da457f6d601168fe43fcb49d9648b4 to 5c96576ff33d569333298c84c6a5379bfd2af76f delta; API, SSH, and origin main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 6e1672766027c16ecb06f5e122b491c0e5a0a83f to 45f4889ab5f971d920ca6a05bf857d326c42b81d delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact 45f4889ab5f971d920ca6a05bf857d326c42b81d to c37df83897ce9cd02829289f9f05b01347e4b0de delta; API and SSH main matched the latter revision, so this record is safely repinned. A final path-level audit found every recorded decisive, test, and affected path disjoint from the exact c37df83897ce9cd02829289f9f05b01347e4b0de to f0ece2d18883a66f04892a46669b3547e5bdf2b1 delta; API and SSH main matched the latter revision, so this record is safely repinned.

### Suggested remediation

Wire detailed provider outcomes into context assembly and a restart-aware memory-capability observation model, then project bounded stage, cause, freshness, coverage, consecutive outcomes, and recovery through chat and top-level health.

### Impact and blast radius

Instances can advertise healthy chat service while memory authentication, index selection, project isolation, network access, breaker state, retrieval, or context assembly is unavailable. Operators cannot distinguish intentionally empty context from silent memory loss, cannot see persistent degradation across turns or restart, and cannot verify recovery. Startup gating, Pinecone authentication and project guard, memory and entity search, context assembly, chat responses, consolidation enablement, runtime and top-level health, alerts, restart evidence, operator recovery, and public health privacy.
