# Open issue review registry

> Generated from `docs/triage/open-issue-registry.json`. Do not edit this view by hand.

- Pinned main revision: `a91f5301266fae2049cd1ae1b3c1b236a7ea2aa8`
- Captured at: 2026-07-26T22:07:17Z
- Open issues: 214
- Registry SHA-256: `224fd3a4976fc4fdbf11be9be006b9644e25a21676262853a251295d912fb4f6`

## #1786: Durable auth-loss rows are written but never imported or resolved after recovery

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `alerts`, `bug`, `reliability`
- Recommended labels: `alerts`, `bug`, `reliability`
- Dependencies: None

### Evidence

Pinned source contains durable auth-loss writers and a transition controller; the public issue is correctly narrowed to the still-unowned import and recovery-resolution path.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #1786 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #1869: Provider-tree reaper is PPID-scoped, not cgroup-scoped — detached workload daemons (e.g. ssh-agent) accumulate unbounded until restart

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: None
- Recommended labels: None
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
- Current labels: None
- Recommended labels: `invalid`
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
- Current labels: None
- Recommended labels: None
- Dependencies: None

### Evidence

The sentinel implementation and hardening documentation exist, but deployment and live fleet coverage are operational facts that cannot be proven from the repository snapshot.

### Suggested remediation

Collect the bounded measurement or live deployment evidence requested by the issue before implementation.

### Impact and blast radius

Unresolved scope described by issue #1876 can affect docs/sentinel behavior or maintainability. Primary boundary: docs/sentinel; broader effects remain subject to focused lead verification.

## #1964: Console test: soup-kitchen lazy Add Line wizard failed once on quality (24.x) — base-rate measurement needed before any flake/retry decision

- Classification: `measurement-only`
- Evidence state: `measurement-required`
- Confidence: `low`
- Current labels: None
- Recommended labels: `console`
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
- Current labels: `audit`
- Recommended labels: `audit`, `mcp`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #1976 can affect src/mcp behavior or maintainability. Primary boundary: src/mcp; broader effects remain subject to focused lead verification.

## #1977: QR-019: runtime.ts god-class decomposition (design-first; 10k+ lines, regressing)

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`
- Recommended labels: `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #1977 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #1978: QR-022: schedule-safe OpenCode worker dispatch (db-lock + silent memory-mcp sidecar)

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `audit`
- Recommended labels: `audit`, `mcp`
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
- Current labels: None
- Recommended labels: None
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
- Current labels: `bug`
- Recommended labels: `bug`, `transport`
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
- Current labels: None
- Recommended labels: `alerts`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2135 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2136: Correlate inline BOT ERRORS log tails before attaching them as evidence

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: `alerts`
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
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2144 can affect src/core/substrate behavior or maintainability. Primary boundary: src/core/substrate; broader effects remain subject to focused lead verification.

## #2145: durability: terminalize or recover ChatRuntime messages rejected by ChatQueue

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2145 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2147: alerts: make fault-taxonomy source-policy coverage explicit and mechanically complete

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 7 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2147 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2148: reliability: wire an external deadman alert for the turn-recovery supervisor

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2148 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2150: reliability: require active session state before claiming a turn-recovery replay

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2150 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2151: reliability: keep turn-recovery lease renewal safe across transient store failures

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2151 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2155: reliability: add an evidence-gated operator workflow for blocked-unsafe turn recoveries

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2155 can affect docs behavior or maintainability. Primary boundary: docs; broader effects remain subject to focused lead verification.

## #2160: reliability: propagate primary-model probe timeouts to queued execution-gate waits

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2160 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2164: security(logging): execute the pending WS-A06 metadata-only sink contract

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `audit`, `bug`, `security`
- Recommended labels: `audit`, `bug`, `security`
- Dependencies: None

### Evidence

The public issue body names 4 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2164 can affect docs/superpowers/plans behavior or maintainability. Primary boundary: docs/superpowers/plans; broader effects remain subject to focused lead verification.

## #2168: transport: gracefulReconnectInFlight flag can stick true, permanently blocking reconnects

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `bug`, `reliability`
- Recommended labels: `bug`, `reliability`, `transport`
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
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2169 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2170: reliability: wire shared and singleton recovery jobs into scope-native replay paths

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 8 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2170 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2189: iMessage: advertised read-receipt subscriptions never receive inbound events

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`, `transport`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2189 can affect src/transport/imessage behavior or maintainability. Primary boundary: src/transport/imessage; broader effects remain subject to focused lead verification.

## #2190: tech-debt: 240 bare catch{} blocks — enforceable via ESLint no-empty + custom ratchet rule

- Classification: `leaf`
- Evidence state: `live-revalidation-required`
- Confidence: `low`
- Current labels: `DRY`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2190 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2191: tech-debt: 30+ as any/as unknown SQLite casts — typed queryAll/queryOne wrapper with ESLint enforcement

- Classification: `leaf`
- Evidence state: `live-revalidation-required`
- Confidence: `low`
- Current labels: `DRY`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

Pinned source retains the typed-query debt while open PR #2313 explicitly owns the query wrapper and overlaps the decisive paths.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2191 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2192: tech-debt: 17+ files with direct process.env access — missing typed RuntimeConfig SSOT module

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `tech-debt`, `type-safety`
- Recommended labels: `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 9 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2192 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2193: tech-debt: ?? vs || vs truthiness inconsistency — first-principle falsy-trap pattern with ESLint enforcement

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `bug`, `tech-debt`, `type-safety`
- Recommended labels: `bug`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 4 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2193 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2194: dead-code: 4 resolve*Config functions in config.ts have zero callers — superseded by agent-config-validator.ts

- Classification: `stale`
- Evidence state: `contradicted`
- Confidence: `high`
- Current labels: `dead-code`, `tech-debt`
- Recommended labels: `dead-code`, `invalid`, `tech-debt`
- Dependencies: None

### Evidence

Current-main startup resolution directly calls all four named resolve functions, and focused configuration tests also call them. The issue claim that they have zero callers is contradicted.

### Suggested remediation

Close or rewrite the issue because its dead-code premise is false on current main.

### Impact and blast radius

Leaving the issue unchanged would direct a deletion toward live configuration resolution used by four transport and memory paths. Configuration loading for memory, iMessage, Signal, and Twilio transports.

## #2195: dead-code: auth-loss-mode-bucket-producer-artifact.ts — 0 importers, test-contract infrastructure for #1518 never wired

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `dead-code`, `tech-debt`
- Recommended labels: `bug`, `dead-code`, `tech-debt`
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
- Current labels: `dead-code`, `tech-debt`
- Recommended labels: `bug`, `dead-code`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2196 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2197: observability: detect unanswered inbound and finalization-leak episodes without per-message paging

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: None
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2197 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2200: tech-debt: no clock abstraction — 403 raw Date.now()/new Date() in src/ bypass deterministic time injection

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 8 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2200 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2201: tech-debt: three parallel connection-state unions drift independently — SSOT violation

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `SSOT`, `refactor`, `tech-debt`, `type-safety`
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
- Current labels: `DRY`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
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
- Current labels: `DRY`, `SSOT`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `SSOT`, `duplicate`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Issues #2204 and #2252 identify the same inline XDG resolution sites and the same operator divergence. #2252 is the later, more complete statement and includes the shared-ring constraint.

### Suggested remediation

Close #2204 as a duplicate of #2252 and preserve implementation evidence on #2252.

### Impact and blast radius

Keeping both open creates duplicate implementation ownership and competing remediation plans for the same paths. XDG path resolution in startup, fleet platform, and keyring code.

## #2205: tech-debt: 37 test files copy-paste tmpDirs/mkdtempSync/afterEach setup — extract shared helper

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `refactor`, `tech-debt`
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
- Current labels: `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2206 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2207: tech-debt: 35+ sites hardcode 60*60*1000 (1 hour) under 3 spellings — MS_PER_HOUR constant missing

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `SSOT`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `SSOT`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 16 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2207 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2209: tech-debt: 27 console.* calls in src/ bypass pino logger — structured-logging SOC violation

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `audit`, `console`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2209 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2210: tech-debt: console/src/ is invisible to ring-boundary guards — providers.ts reaches 3 layers into backend

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `audit`, `console`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 7 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2210 can affect console/src/lib behavior or maintainability. Primary boundary: console/src/lib; broader effects remain subject to focused lead verification.

## #2211: tech-debt: 26 hand-rolled typeof+trim non-empty-string checks diverge on trim behavior — extract nonEmptyString() helper

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 8 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2211 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2212: tech-debt: ValidationError and ExtractionError have byte-identical shape — extract shared EnrichmentError

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `DRY`, `SSOT`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2212 can affect src/runtimes/chat behavior or maintainability. Primary boundary: src/runtimes/chat; broader effects remain subject to focused lead verification.

## #2213: tech-debt: get*/load*/fetch* DB-read prefix inconsistent across 52 functions — naming-convention SSOT

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `refactor`, `tech-debt`
- Recommended labels: `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2213 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2214: tech-debt: 58 expect.anything() calls + 2,592 weak assertions — false-green test integrity ratchet

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `refactor`, `tech-debt`
- Recommended labels: `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 11 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2214 can affect tests/core behavior or maintainability. Primary boundary: tests/core; broader effects remain subject to focused lead verification.

## #2215: tech-debt: loadOrCreateFleetTokens exported from 2 files — public API duplication breaks drift guard

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SSOT`, `audit`, `refactor`, `tech-debt`
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
- Current labels: `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `audit`, `console`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2216 can affect console behavior or maintainability. Primary boundary: console; broader effects remain subject to focused lead verification.

## #2218: tech-debt: @deprecated symbols with zero callers are doc/code lies — TURN_WATCHDOG_MS rationale is false

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `dead-code`, `refactor`, `tech-debt`
- Recommended labels: `alerts`, `audit`, `dead-code`, `refactor`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2218 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2219: tech-debt: 81 PNG files (~4.7 MB) committed to git under artifacts/ and docs/screenshots/ — gitignore tightened but old files remain

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `refactor`, `tech-debt`
- Recommended labels: `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2219 can affect console/src behavior or maintainability. Primary boundary: console/src; broader effects remain subject to focused lead verification.

## #2222: SSOT: fitness ratchet ceilings are hand-maintained twins (.claude/fitness/baseline.json + docs/architecture/fitness-taxonomy.md)

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: `refactor`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2222 can affect docs/architecture behavior or maintainability. Primary boundary: docs/architecture; broader effects remain subject to focused lead verification.

## #2223: DRY: duplicate ps-based process-tree census (process-tree.ts vs tree-liveness.ts)

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: `refactor`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2223 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2224: tech-debt: verify:* push-gate pipelines are single-line ~4KB shell strings in package.json — unreviewable, undiffable, untimed

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2224 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2225: tech-debt: 0-byte decoy instance DBs in ~/.local/state/whatsoup mislead operators — live DBs are in ~/.local/share

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2225 can affect docs behavior or maintainability. Primary boundary: docs; broader effects remain subject to focused lead verification.

## #2235: hardening(agent): make liveness decisions generation-safe and interrupt teardown durability-proven

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: None
- Recommended labels: `reliability`
- Dependencies: None

### Evidence

Merged PR #2226 established the initial behavior, while the issue enumerates remaining liveness-generation and interrupt-durability gaps in pinned source.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2235 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2238: refactor(fleet): split route dispatch and LID conflict logic out of src/fleet/index.ts

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `audit`, `refactor`, `tech-debt`
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
- Current labels: `SOC`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `audit`, `refactor`, `tech-debt`
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
- Current labels: `DRY`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2240 can affect tests/fleet/routes behavior or maintainability. Primary boundary: tests/fleet/routes; broader effects remain subject to focused lead verification.

## #2241: SSOT: centralize transport adapter reason codes

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SSOT`, `audit`, `bug`, `refactor`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

The public issue body names 5 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2241 can affect src/transport/contract behavior or maintainability. Primary boundary: src/transport/contract; broader effects remain subject to focused lead verification.

## #2242: SOC: move generic fleet time utilities to src/lib

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 13 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2242 can affect console/src behavior or maintainability. Primary boundary: console/src; broader effects remain subject to focused lead verification.

## #2243: DRY: replace duplicated test logger fixtures with a shared logger mock

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `audit`, `refactor`, `tech-debt`
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
- Current labels: `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2244 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2245: SSOT: align provider parity snapshot validation with canonical probe states

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SSOT`, `audit`, `refactor`, `tech-debt`
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
- Current labels: `audit`, `refactor`, `tech-debt`
- Recommended labels: `audit`, `refactor`, `tech-debt`
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
- Confidence: `low`
- Current labels: `SSOT`, `audit`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2248 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2249: tech-debt: CircuitState triple-duplication across 3 files - name collision between circuit-breaker state machine and incident-rate-limit record

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SSOT`, `alerts`, `audit`, `refactor`, `tech-debt`
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
- Current labels: `SSOT`, `audit`, `refactor`, `tech-debt`, `type-safety`
- Recommended labels: `SSOT`, `audit`, `refactor`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

The public issue body names 3 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2250 can affect src/core behavior or maintainability. Primary boundary: src/core; broader effects remain subject to focused lead verification.

## #2251: tech-debt: PROBE_STATE_VALUES validator set missing 2 type members - not_required and unknown rejected despite being valid ProviderParityProbeState values

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SSOT`, `audit`, `bug`, `refactor`, `tech-debt`
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
- Current labels: `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `SOC`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Current main retains the canonical xdgDir helper and the named inline XDG reads with divergent nullish and falsy fallthrough behavior. #2204 is a narrower duplicate of this record.

### Suggested remediation

Move or expose the XDG resolver from the shared ring, migrate the named callers, and add an exact no-inline-read guard.

### Impact and blast radius

Empty XDG values can resolve differently across startup, fleet, and credential-storage paths. Startup paths, fleet configuration paths, and keyring storage resolution.

## #2253: tech-debt: asRecord/requireString validator clones across 6 files - SSOT is partial (only safe coercer, no throwing variant) forcing 6 re-implementations

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `DRY`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `SSOT`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

Current main still contains the named local validator families. Merged PR #2366 added another local asRecord implementation in safeguard diagnostics rather than extending the shared type-guards surface, so the consolidation gap survives the main delta.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2253 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2254: tech-debt: JSON.parse(JSON.stringify( used 14 times as deep-clone - use Node 22+ structuredClone() instead

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `DRY`, `audit`, `refactor`, `tech-debt`
- Recommended labels: `DRY`, `audit`, `refactor`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2254 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2257: portability: 'which' ffmpeg probe fails on minimal Linux (Alpine/busybox)

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `bug`, `linux`, `portability`, `tech-debt`
- Recommended labels: `bug`, `linux`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2257 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2258: portability: /proc/self/fd read has no platform gate — FD health metric silently null on macOS

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `bug`, `portability`, `reliability`, `tech-debt`
- Recommended labels: `bug`, `portability`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2258 can affect src/runtimes/agent behavior or maintainability. Primary boundary: src/runtimes/agent; broader effects remain subject to focused lead verification.

## #2259: portability: mktemp -t flag is GNU-deprecated and semantically different on BSD/macOS

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `bug`, `linux`, `portability`, `tech-debt`
- Recommended labels: `bug`, `linux`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Pinned main still contains three mktemp -t invocations in scripts/cutover.sh, while the broader portability PR only fixed a sibling surface.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2259 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2260: portability: safeguard-diagnostics emits GNU 'timeout' snippet unavailable on macOS

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `bug`, `portability`, `tech-debt`
- Recommended labels: `bug`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Current main still emits the exact GNU timeout command in the operator-facing Playwright remediation snippet. Merged PR #2366 rewrote the same diagnostics module but retained that command.

### Suggested remediation

Render a platform-aware bounded-time command or fail with an explicit checked prerequisite before presenting the snippet.

### Impact and blast radius

The repository can recommend a command that fails immediately on a first-class development platform. Safeguard diagnostics and operator remediation for Playwright installation.

## #2261: fix(qsesh): distill append-ordered sessions with non-monotonic timestamps

- Classification: `leaf`
- Evidence state: `live-revalidation-required`
- Confidence: `low`
- Current labels: None
- Recommended labels: None
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
- Current labels: None
- Recommended labels: `reliability`
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
- Current labels: None
- Recommended labels: `alerts`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2280 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2281: reliability(dispatcher): fence queued incident delivery by durable episode state

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: `alerts`, `reliability`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2281 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2282: observability(dispatcher): bind storm digests to immutable membership snapshots

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: None
- Recommended labels: None
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2282 can affect deploy/scripts behavior or maintainability. Primary boundary: deploy/scripts; broader effects remain subject to focused lead verification.

## #2284: fragility: imsg-port has no socket 'end'/'close' handler — pending RPCs hang 30s on graceful daemon close

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `bug`, `reliability`, `tech-debt`, `transport`
- Recommended labels: `bug`, `reliability`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

The public issue body names 1 pinned-tree path; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2284 can affect src/transport/imessage behavior or maintainability. Primary boundary: src/transport/imessage; broader effects remain subject to focused lead verification.

## #2288: fragility: non-atomic persistence in silence-manager, incident-breaker, process-lock (silent state loss on crash)

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `bug`, `reliability`, `tech-debt`
- Recommended labels: `alerts`, `bug`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Merged PR #2338 and current main now publish silence rules through a sibling temporary file and atomic rename. The silence write still lacks file and directory fsync, while incident-breaker durability and process-lock payload fsync findings remain in current source.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2288 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2289: fragility: transport async-rejection and error-isolation gaps (rejectCall, pollOnce, imsg-port, staging cleanup)

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `bug`, `reliability`, `tech-debt`, `transport`
- Recommended labels: `bug`, `reliability`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

The public issue body names 6 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2289 can affect src/transport behavior or maintainability. Primary boundary: src/transport; broader effects remain subject to focused lead verification.

## #2290: fragility: unguarded JSON.parse in beads + stdout UTF-8 boundary corruption in agent session

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `bug`, `reliability`, `tech-debt`
- Recommended labels: `bug`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Merged PR #2382 fixed the beads JSON parse finding, leaving the separate stream UTF-8 boundary concern; the original multi-finding report is therefore partial.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2290 can affect src/core/substrate behavior or maintainability. Primary boundary: src/core/substrate; broader effects remain subject to focused lead verification.

## #2292: fragility: 16 lower-severity hygiene findings (error swallowing, resource cleanup, loop-prepared SQL)

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: `reliability`, `tech-debt`
- Recommended labels: `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2292 can affect src/core/substrate behavior or maintainability. Primary boundary: src/core/substrate; broader effects remain subject to focused lead verification.

## #2295: fragility: config validation audit — 3 HIGH (as-number cast, as-string path cast, intEnv parseInt truncation) + 11 MED + 10 LOW; keystone is Record<string,any> schema split

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `tech-debt`
- Recommended labels: `reliability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 2 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2295 can affect src behavior or maintainability. Primary boundary: src; broader effects remain subject to focused lead verification.

## #2296: portability/fragility: console/ directory audit — 6 MED (Linux-only XDG paths in wizard, clipboard insecure-context, lint-frozen Linux paths) + 11 LOW

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `tech-debt`
- Recommended labels: `console`, `portability`, `reliability`, `tech-debt`
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
- Current labels: `tech-debt`
- Recommended labels: `alerts`, `portability`, `reliability`, `tech-debt`
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
- Current labels: `tech-debt`
- Recommended labels: `portability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 8 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2298 can affect scripts behavior or maintainability. Primary boundary: scripts; broader effects remain subject to focused lead verification.

## #2299: portability: tools/ + plugins/ + phonectl/ audit — HIGH: qsesh hard-refuses Linux (single-line darwin gate on otherwise-portable tool) + 3 MED + 4 LOW

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `tech-debt`
- Recommended labels: `portability`, `tech-debt`
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
- Confidence: `low`
- Current labels: `tech-debt`
- Recommended labels: `bug`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

The public issue body names 7 pinned-tree paths; those paths were read from the pinned revision during this bounded audit.

### Suggested remediation

Use the public acceptance boundary, reconcile overlapping pull requests, and add or update focused regression coverage.

### Impact and blast radius

Unresolved scope described by issue #2300 can affect src/fleet behavior or maintainability. Primary boundary: src/fleet; broader effects remain subject to focused lead verification.

## #2301: test-portability: hardcoded /tmp paths + shared hardcoded mock paths (~45 files) instead of os.tmpdir()+mkdtempSync — collision/isolation risk

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `tech-debt`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `config`, `mcp`, `portability`, `reliability`, `security`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 6 of 6 cited file path(s) were present on pinned main; 6 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the test-portability-fragility boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span tests.

## #2302: test-fragility: external-binary deps without skip-guards (npm, sqlite3 CLI) + port-binding TOCTOU race in fleet index test

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `tech-debt`
- Recommended labels: `SSOT`, `audit`, `bug`, `chat`, `fleet`, `portability`, `tech-debt`
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
- Current labels: `tech-debt`
- Recommended labels: `SSOT`, `audit`, `bug`, `chat`, `config`, `fleet`, `portability`, `tech-debt`
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
- Confidence: `medium`
- Current labels: `tech-debt`
- Recommended labels: `SSOT`, `audit`, `bug`, `chat`, `config`, `portability`, `security`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 11 of 13 cited file path(s) were present on pinned main; 12 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the test-portability-fragility boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2321: portability/fragility: src/runtimes + docker audit — 1 HIGH (macOS -home- transcript path) + 2 MED + 1 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `audit`, `bug`, `chat`, `mcp`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 7 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the portability-audit boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2322: portability/fragility: src/transport/ audit — 2 HIGH (Linux-only /var/run lock, imsg socket leak) + 6 MED + 4 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `low`
- Current labels: None
- Recommended labels: `audit`, `bug`, `chat`, `config`, `portability`, `security`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 0 of 0 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the portability-audit boundary; impact details remain governed by the live issue acceptance contract. No decisive repository file path was safely extractable from the public issue body.

## #2323: portability/fragility: src/mcp + src/memory + src/lib audit — 3 MED (incident-breaker tmp collision, socket path-length, bot-errors-outbox silent swallow) + 4 LOW

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `config`, `mcp`, `portability`, `refactor`, `reliability`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 3 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the portability-audit boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2325: portability/fragility: src/mcp/tools full line-by-line read — 2 MED (groups chatJid!, voice unguarded writeTempFile) + 6 LOW; all 22 tool files now fully audited

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `audit`, `bug`, `chat`, `mcp`, `portability`, `tech-debt`, `type-safety`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 7 of 7 cited file path(s) were present on pinned main; 0 cited test path(s) and 3 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the portability-audit boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2327: cleanup(console): SaveContactDialog is dead code after v3.5's intentional removal; HistoryTab still shows a save toast that saves nothing

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `bug`, `chat`, `dead-code`, `tech-debt`
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
- Confidence: `medium`
- Current labels: `audit`
- Recommended labels: `audit`, `config`, `fleet`, `mcp`, `portability`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 9 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span package.json, scripts, tsconfig*.json, vitest*.config.ts.

## #2331: portability: src/ root-level entry/bootstrap files audit — 1 LOW (Obsidian hardcoded path), closes root-file coverage gap

- Classification: `tracker`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `audit`, `bug`, `config`, `fleet`, `mcp`, `portability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 13 of 14 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the portability-audit boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, src.

## #2332: durability(agent): preserve original receipt chronology across queued and replayed turns

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `bug`
- Recommended labels: `audit`, `bug`, `chat`, `security`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 8 of 8 cited file path(s) were present on pinned main; 1 cited test path(s) and 9 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the agent-runtime-reliability boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2333: ops(auth): canonicalize single-flight, state-verified interactive provider recovery

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `bug`, `ops`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `dead-code`, `ops`, `portability`, `reliability`, `security`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 3 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, docs.

## #2334: P0 agent regression: deliver authenticated inbound corrections to active turns via provider-aware steering

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `P0`, `bug`, `chat`
- Recommended labels: `P0`, `SSOT`, `alerts`, `bug`, `chat`, `reliability`, `security`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 2 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the same-chat-supersession boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2340: observability: expose content-free active execution-holder age and progress freshness

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `fleet`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2341: observability: add success-based cadence health for scheduled release-proof producers

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 6 of 6 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2342: observability: classify health-port authority drift before probing instance outage

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `config`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2343: durability: anchor maybe_sent dwell to the current ambiguity episode

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2353: test-portability: verify:push:branch suite flakes on ≤4-core hardware (maxWorkers:4 + 10s testTimeout CPU-starves phantom-deps scan)

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `portability`, `tech-debt`
- Recommended labels: `bug`, `config`, `portability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the test-portability-fragility boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span scripts, vitest.config.ts.

## #2354: agent: extended fallback windows can drop retained replay-safe turns

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`, `scheduler`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the agent-runtime-reliability boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2356: fix(bot-errors): default reminder cap disables still-open exponential backoff

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2357: Preserve human directive bodies in slash-prefixed multi-line messages

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2358: observability: separate probe provenance from target service provenance in alert envelopes

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `fleet`, `reliability`, `security`
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
- Current labels: None
- Recommended labels: `SSOT`, `audit`, `bug`, `chat`, `tech-debt`
- Dependencies: None

### Evidence

The focused ownership test uses a fixed parent-thread wait before reading a child-created process record. The live issue includes a bounded Node 25 reproduction history and explicitly treats isolated passes as non-clean.

### Suggested remediation

Use an event-driven fixture signal or the existing bounded wait helper and preserve exact child ownership and cleanup.

### Impact and blast radius

A contention-sensitive test can fail a quality lane without proving a production ownership defect. The new-command ownership test and Node 24/25 full-suite quality lanes.

## #2373: alerts: preserve maintenance severity and fail visibly when the sink rejects an event

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `config`, `reliability`, `security`
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
- Current labels: `bug`, `reliability`, `scheduler`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `config`, `mcp`, `reliability`, `scheduler`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, src.

## #2385: observability: correlate persistent multi-asset release drift into one member-aware fleet episode

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, scripts.

## #2386: security(alerts): make BOT ERRORS evidence metadata-only at the emission boundary

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`, `security`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 9 of 9 cited file path(s) were present on pinned main; 1 cited test path(s) and 9 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2387: observability: model irreversible turn outcomes as immutable events instead of recoverable incidents

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 12 of 12 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2388: alerts: provider_unknown_terminal is incorrectly declared auth_terminal and carries auth-only recovery semantics

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 9 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2390: alerts: standing incidents can auto-close while recovery proof is still pending

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `dead-code`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 9 of 9 cited file path(s) were present on pinned main; 2 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src, tests.

## #2391: alerts: require explicit producer authority before non-service processes enqueue live BOT ERRORS

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `ops`, `reliability`, `security`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `config`, `ops`, `reliability`, `security`, `tech-debt`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 7 of 7 cited file path(s) were present on pinned main; 2 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, scripts, src, tests.

## #2392: observability(fleet): aggregate withheld recovery-clear diagnostics instead of logging every poll

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `fleet`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2393: alerts: flap-storm consolidation re-pages critical on a fixed 30-minute cadence without backoff

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `fleet`, `refactor`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2394: alerts: restart loses recovery-clear authority for process-local incident sources

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 14 of 14 cited file path(s) were present on pinned main; 1 cited test path(s) and 11 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src, tests.

## #2395: alerts: clear agent_turn_finalization_failed after all retained finalizations recover

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2397: alerts: agent_respawn_failed can be cleared by an unrelated conversation recovery

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2398: agent: finalization escapes can block a scope without a durable retry owner

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the agent-runtime-reliability boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2399: alerts: fallback prerequisite incidents have no contributor-aware recovery lifecycle

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2400: alerts: successful provider diagnostics open a separate critical incident

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 1 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2401: alerts: handoff-distill recovery is per conversation but incident identity is asset-wide

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `bug`, `chat`, `reliability`
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
- Current labels: None
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2403: alerts: flush and retry pending stale-autoclose digests without requiring another closure

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `audit`, `bug`, `dead-code`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2404: alerts: GUI-session monitor observes recovery but never clears its incident

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `config`, `portability`, `reliability`
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
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2406: alerts: substrate-inline-hook incidents never clear after verified database recovery

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src.

## #2407: alerts: operator-actionable runtime tool failures are auto-closed as self-corrected

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 2 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src, tests.

## #2408: alerts: distinguish MCP probe failures from missing tools and bind inventory expectations to a runtime contract

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `mcp`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 1 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src, tests.

## #2409: alerts: connected health degradation is blanket-downgraded without cause-aware impact classification

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `bug`, `chat`, `fleet`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2410: heal: crash single-flight conflates provider routes and retains the first route's attribution

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `bug`, `chat`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 8 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2412: alerts: pinecone_degraded lacks contributor-aware recovery across operations

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2413: alerts: auth-terminal recovery clears only the quarantine symptom and orphans the root incident

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `fleet`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 1 cited test path(s) and 4 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2414: alerts: outbound_flood can lose lifecycle ownership on failed emission or sustained-flood restart

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2415: alerts: scheduler de-link hold latches before delivery and never clears on relink

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `reliability`, `scheduler`, `transport`
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
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 1 cited test path(s) and 3 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2417: alerts: forbidden-target trigger retirement lacks recovery and failed-emission ownership

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `mcp`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2420: alerts: remote writefail harvest clears before the failed record recovers

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2421: alerts: meta dead-letter incident never closes after final audited disposition

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2422: alerts: runner drops launch exceptions before durable failure emission

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `config`, `reliability`, `security`, `tech-debt`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`, `transport`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2425: alerts: deadman records rejected notifications as sent and failed recovery as resolved

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `config`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the open-issue-high-cohort boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2428: alerts: flap detector counts delivery retries as distinct fault trips

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `chat`, `reliability`, `transport`
- Dependencies: None

### Evidence

Current dispatcher source scans every ready outbox event and unconditionally records a flap trip without retaining a durable occurrence identity. Existing flap tests exercise distinct direct trip calls, not one requeued event across repeated scans.

### Suggested remediation

Persist a bounded occurrence-identity ledger independent of notification attempt state and keep ambiguous identity fail-safe toward preserving the original alert.

### Impact and blast radius

One repeatedly rejected notification can manufacture a storm and suppress its own original alert. Dispatcher outbox scanning, flap state, storm aggregation, retry handling, and member suppression.

## #2429: alerts: destructive state replacement can orphan active incident lifecycles

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 4 of 4 cited file path(s) were present on pinned main; 2 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the controller-state-integrity boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2430: alerts: recovered-before-delivery suppression drops daily-health freshness

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 2 of 2 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, tests.

## #2431: alerts: heartbeat watchdog clears incidents outside conclusively evaluated scope

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `config`, `fleet`, `reliability`
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
- Current labels: None
- Recommended labels: `alerts`, `audit`, `bug`, `fleet`, `reliability`
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
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `reliability`, `transport`
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
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2436: deploy: macOS fleet-sentinel jobs drop supported runtime controls

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `bug`, `chat`, `config`, `fleet`, `portability`, `reliability`, `tech-debt`
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
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 1 of 1 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2438: alerts: sentinel reports a capped action-outbox depth when pruning fails

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `fleet`, `portability`, `reliability`, `security`, `tech-debt`
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
- Current labels: None
- Recommended labels: `alerts`, `bug`, `chat`, `config`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 3 of 3 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the bot-errors-lifecycle boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy, src.

## #2440: collector: recover writefail leases across processing-directory fallback changes

- Classification: `leaf`
- Evidence state: `inconclusive`
- Confidence: `medium`
- Current labels: None
- Recommended labels: `SSOT`, `alerts`, `bug`, `chat`, `reliability`, `security`
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
- Current labels: None
- Recommended labels: `bug`
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
- Confidence: `medium`
- Current labels: `bug`, `chat`
- Recommended labels: `bug`, `chat`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 0 of 5 cited file path(s) were present on pinned main; 2 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the continuity-gap-recovery boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span scripts, src, tests.

## #2445: Same-chat supersession is not fail-closed: a newer cancellation can queue while stale work continues

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `bug`, `chat`
- Recommended labels: `bug`, `chat`, `reliability`
- Dependencies: #2235, #2334

### Evidence

Live issue body was inspected in full and hashed. 6 of 6 cited file path(s) were present on pinned main; 2 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the same-chat-supersession boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span src, tests.

## #2447: Observability: runtime, durability, health, and alert taxonomies lack a canonical cross-contract and drift guard

- Classification: `tracker`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `audit`, `bug`, `reliability`
- Dependencies: #2147, #2409

### Evidence

Live issue body was inspected in full and hashed. 9 of 9 cited file path(s) were present on pinned main; 1 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the failure-taxonomy-cross-contract boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, src, tests.

## #2448: Durability: provider_stream_corrupt terminal is emitted but rejected by core finalization

- Classification: `leaf`
- Evidence state: `live-revalidation-required`
- Confidence: `high`
- Current labels: `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `audit`, `bug`, `reliability`, `type-safety`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 9 of 9 cited file path(s) were present on pinned main; 1 cited test path(s) and 1 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the failure-taxonomy-cross-contract boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, src, tests.

## #2453: database: make forward migration reservations machine-readable and conflict-checked

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `tech-debt`
- Recommended labels: `SSOT`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 6 of 6 cited file path(s) were present on pinned main; 1 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the migration-allocation-registry boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, src, tests.

## #2454: Guard follow-up: decide whether to require numeric validation before shell integer tests

- Classification: `measurement-only`
- Evidence state: `inconclusive`
- Confidence: `high`
- Current labels: None
- Recommended labels: `audit`, `tech-debt`
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
- Current labels: `audit`, `bug`, `reliability`, `security`
- Recommended labels: `audit`, `bug`, `ops`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 2 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the operator-cli-public-receipts boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span docs, scripts, src, tests.

## #2458: Observability: release-drift launchd logs are timestamp-free, uncorrelated, and unbounded

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
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
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the daily-health-lifecycle-census boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2461: Split BOT ERRORS contract documentation from stale deployment and topology history

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `audit`, `documentation`, `reliability`
- Recommended labels: `SSOT`, `audit`, `documentation`, `reliability`, `security`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 5 of 5 cited file path(s) were present on pinned main; 1 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. The prior delta memo was rechecked against live identity, labels, timestamps, paths, and PR state.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public leaf concern in the daily-health-lifecycle-census boundary; impact details remain governed by the live issue acceptance contract. Cited public repository paths span deploy.

## #2463: Controller state corruption silently resets lifecycle truth and then appears healed

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
- Dependencies: None

### Evidence

Current-main collector and heartbeat-watchdog loaders replace unreadable state with empty defaults, while the dispatcher archives corrupt incident state but then also continues from empty lifecycle state. Later saves can make the replacement files appear syntactically healthy.

### Suggested remediation

Use a versioned integrity-bound state envelope, retain a validated prior generation, and reconcile pending obligations before resuming mutation.

### Impact and blast radius

Open incidents, cooldowns, backoff, recovery contributors, and suppression state can disappear while fresh valid JSON appears healthy. Collector, dispatcher, heartbeat watchdog, controller health, incident lifecycle, and recovery.

## #2464: Consolidate drift-prone BOT ERRORS Python state and observability primitives

- Classification: `tracker`
- Evidence state: `inconclusive`
- Confidence: `low`
- Current labels: `audit`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `config`, `fleet`, `refactor`, `reliability`, `security`
- Dependencies: None

### Evidence

Live issue body was inspected in full and hashed. 0 of 0 cited file path(s) were present on pinned main; 0 cited test path(s) and 0 relevant pull-request overlap(s) were enumerated. No bespoke runtime falsifier was rerun, so source semantics remain conservative.

### Suggested remediation

Revalidate every published acceptance criterion and cited line against the pinned revision before implementation.

### Impact and blast radius

The issue reports a public tracker concern in the bot-errors-python-primitives boundary; impact details remain governed by the live issue acceptance contract. No decisive repository file path was safely extractable from the public issue body.

## #2465: Heartbeat watchdog silently accepts zero/unknown checks and refreshes false-green state

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `chat`, `config`, `fleet`, `reliability`
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
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `ops`, `reliability`
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
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `ops`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
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
- Current labels: `audit`, `bug`, `reliability`, `security`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`, `security`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
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
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `config`, `ops`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
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
- Current labels: `alerts`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`
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
- Current labels: `audit`, `bug`, `deploy`, `reliability`
- Recommended labels: `audit`, `bug`, `deploy`, `reliability`
- Dependencies: #2475

### Evidence

The current deployer explicitly materializes twelve managed files without restarting services, while selfcheck promotes its zero exit directly to healed. The managed set includes long-running Python daemons and one-shot or application-owned paths with different activation semantics. Current service inventory is observed before mutation and does not prove a repaired generation was loaded. Nine focused adjacent tests passed, but no materialize-to-activate generation proof exists.

### Suggested remediation

Define a versioned per-path activation manifest with authority, activation class, rollback, loaded-generation proof, and bounded unknown outcomes.

### Impact and blast radius

The filesystem can be clean while long-running processes continue executing the pre-repair generation. BOT ERRORS daemons, scheduled jobs, application release ownership, selfcheck recovery claims, and rollout evidence.

## #2478: security: sentinel pin trust does not bind the full manifest to the approved revision

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `audit`, `deploy`, `reliability`, `security`
- Recommended labels: `audit`, `deploy`, `reliability`, `security`
- Dependencies: None

### Evidence

At origin/main 6012544c84dd956de025c55d8fcf0272f51fd270, verify_pin_trust authenticates only the revision and approved core F10 hash, while verify_bundle checks only paths declared by that manifest. A fresh synthetic canary trusted and verified two distinct non-core generations under the same trust facts and accepted an unexpected regular file outside the declared set.

### Suggested remediation

Define a versioned canonical generation digest covering schema, claimed revision, the complete ordered exact path/hash set, and activation metadata. Authenticate it from the claimed Git blob or an independent non-Git approval ledger, atomically activate manifest/approval/bundle identity with rollback, fail closed on hybrid or extra content, and publish only a sanitized generation identifier.

### Impact and blast radius

Health, repair, and escalation can report trusted or healed convergence for runtime bytes that are not provenance-bound to the claimed source revision; accidental corruption, partial rollout, mixed generations, or same-authority mutation can therefore produce a security-boundary and reliability false green. BOT ERRORS sentinel pin verification, the non-Git approved-head fallback, selfcheck health and self-heal decisions, and pin-mode publication across managed deployment bundles. No live production mutation was observed or performed.

## #2479: security: sentinel bundle verification follows intermediate symlinks outside the trusted root

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `audit`, `deploy`, `reliability`, `security`
- Recommended labels: `audit`, `deploy`, `reliability`, `security`
- Dependencies: #2478

### Evidence

Current-main verify_bundle validates lexical path shape and the final leaf, then uses isfile/open operations that follow intermediate parent symlinks. Existing focused coverage rejects a final-component symlink but has no intermediate-component, root-symlink, descriptor-identity, or swap falsifier. All 24 live open PR file inventories were checked; none changes the verifier, selfcheck call sites, or focused tests. Merged PR #882 is the historical origin only.

### Suggested remediation

Introduce one descriptor-relative, no-follow bundle reader that validates the supplied root and every directory component, opens only an in-root regular final file, hashes the opened descriptor, and returns bounded root_symlink/parent_symlink/root_escape/file_kind/identity_changed/read_failed outcomes. Use it for both candidate-bundle and active-runtime observations.

### Impact and blast radius

Bundle and active-runtime verification can accept expected bytes reached through an intermediate symlink outside the claimed trusted root, producing false integrity and convergence verdicts. The shared verifier feeds both candidate bundle and active runtime checks in selfcheck; trust, repair admission, post-state verification, and recovery evidence inherit the gap.

## #2480: selfcheck: non-Git approved-head fallback is dropped during the in-lock trust recheck

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `audit`, `bug`, `deploy`, `reliability`
- Recommended labels: `audit`, `bug`, `deploy`, `reliability`
- Dependencies: None

### Evidence

At current main, the initial selfcheck observation loads approved_heads and passes it to verify_pin_trust, while the in-lock pre-heal recheck reloads only approved_f10 and omits approved_heads. A deterministic second-cycle non-Git fixture reproduced initial approved-head trust followed by action current_changed, zero deploy calls, and pin_changed_during_heal despite an unchanged manifest. Six adjacent approved-head and in-lock tests pass, but none combine the non-Git fallback with the second-cycle heal path.

### Suggested remediation

Use one load-and-verify generation primitive for initial, in-lock, and post-mutation observations; pass the same trust inputs at every stage and classify generation change separately from trust or approval failure.

### Impact and blast radius

Approved non-Git runtime trees can detect safe drift but repeatedly refuse recovery as a false current_changed condition. Host selfcheck recovery admission, approved-head fallback, heal hysteresis, recovery receipts, and operator diagnosis.

## #2481: ops: rollout proof does not block live runtimes that are missing merged health invariants

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `audit`, `deploy`, `ops`, `reliability`
- Recommended labels: `audit`, `deploy`, `ops`, `reliability`
- Dependencies: #1876, #2341

### Evidence

At exact SSH origin/main a91f5301266fae2049cd1ae1b3c1b236a7ea2aa8, the health producer degrades recently relied-on stale model evidence and publishes exact degradation causes and source commit provenance. The standalone classifier also rejects stale model evidence. The release manifest declares source commit, tracked files, and required outputs; the cutover gate admits active plus healthy with inventory, profile, health-port, and monitor-membership checks; and the sentinel reduces runtime verification to healthy/class/verifyRc. None of these rollout consumers compares an approved generation capability set with the active generation. The main change after the issue body was written touches only design-regression guard files, so it does not alter this finding. The issue body supplies two sanitized live probes, but this audit did not independently re-probe a live runtime.

### Suggested remediation

Define a versioned, metadata-only capability manifest for each approved release generation and a per-role minimum capability policy. Add one fail-closed comparator used by pre-cutover admission, active-generation readback, post-cutover invariant canaries, fleet classification, and rollback selection. Preserve approved divergent histories by comparing authenticated generation capabilities rather than requiring ancestry to main, and emit bounded unknown, missing, contradictory, exception, and rollback receipts.

### Impact and blast radius

A running runtime can remain green on behavior known to omit a merged health invariant, delaying rollout remediation and forcing manual commit comparison during incidents. Release snapshot planning, cutover and rollback admission, runtime health classification, fleet sentinel aggregation, rollout evidence, and self-heal activation proof.

## #2482: alerts: queue lifecycle renames return success without crash-durable namespace commit

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `medium`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2427

### Evidence

At pinned main, normal remote claim has two os.replace calls and no directory sync, while normal remote acknowledgement has one os.replace call and no directory sync. Dispatcher claim and reclaim each rename then sync only the destination parent; accepted, suppression, test-leak, storm-collapse, and other terminal paths lack a complete two-parent post-mutation commit, and dead-letter removes the processing claim without syncing its parent. The stronger write-failure terminal helper syncs both parents, providing a positive control. Both decisive source files are unchanged from the revision cited in the issue. No open pull request touches the decisive source or test paths; merged PR #2115 addressed save-before-terminal-move ordering but not cross-directory namespace durability.

### Suggested remediation

Introduce one shared lifecycle-transition primitive for collector and dispatcher that confines source and destination parents, handles same-filesystem and cross-filesystem moves, syncs every changed parent before durable success, returns an explicit unknown outcome after ambiguous mutations, reconciles by stable identity, and emits bounded body-free receipts. Route every mover through it and enforce the contract with structural and fault-injection tests.

### Impact and blast radius

An acknowledged remote event or accepted local notification can regain an earlier claimable name, lose its terminal disposition, or produce conflicting queue censuses after sudden failure. Blind retry can amplify the ambiguous state into duplicate delivery or duplicate terminal evidence. BOT ERRORS collector and dispatcher outbox, processing, relay-processing, relayed, sent, suppressed, quarantine, test-leak, collapsed, retry, write-failure, and dead-letter lifecycles; restart reconciliation; relay retry semantics; and public operational receipts.

## #2483: alerts: deadman and watchdog treat freshly failed dispatcher cycles as healthy

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2482

### Evidence

At pinned main, the dispatcher publishes a fresh failed cycle receipt after each caught cycle exception. A deterministic synthetic canary held service, socket, and freshness controls healthy while failed=1: heartbeat watchdog returned no dispatcher problem and deadman returned success and reported healthy, while daily queue inventory warned on the same failure evidence. Eighty relevant Python tests passed, but no existing focused test asserts the fresh-failed-cycle contradiction.

### Suggested remediation

Define one versioned dispatcher cycle receipt and parser with independent freshness and execution-verdict predicates, bounded failure stage/class, validated counts, last successful cycle, consecutive failures, queue generation, and durable lifecycle outcome. Route daily inventory, heartbeat watchdog, deadman, and status output through the same verdict and require conclusive-success hysteresis before recovery.

### Impact and blast radius

A deterministic poison event or internal error can fail every dispatcher cycle while both independent supervisors remain green, delay detection until backlog age trips, and incorrectly clear an earlier dispatcher incident from freshness alone. Dispatcher cycle-state publication, daily queue inventory, heartbeat-watchdog supervision, deadman recovery, backlog escalation, runtime manifests, and bounded operational receipts.

## #2484: security(alerts): queue consumers follow symlink entries across the claim boundary

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `reliability`, `security`
- Recommended labels: `alerts`, `audit`, `bug`, `reliability`, `security`
- Dependencies: #2482

### Evidence

Exact current-main source uses ordinary path opens before and after local and remote queue-entry renames, while health and watchdog census code filters entries with follow-symlink is_file/stat operations. A sanitized synthetic canary against those exact blobs observed all seven local-dispatcher, remote-collector, health, and watchdog follow/count outcomes as true. No delivery or live transport function was invoked. All 23 open pull requests were checked by exact changed path, including the only paginated file inventory, and none overlaps the decisive paths.

### Suggested remediation

Create one shared queue-entry admission and claim contract that validates trusted parent descriptors, opens leaves without following them, verifies regular-file identity with fstat, parses bytes from the opened descriptor, revalidates identity after a durable namespace claim, and returns bounded untrusted_entry, entry_changed, or entry_unreadable outcomes. Apply the contract to local dispatch, remote relay, queue census, reclaim, ack, quarantine, and maintenance paths; compose its namespace transition with issue #2482 and preserve issue #2386 metadata-only evidence rules.

### Impact and blast radius

A queue entry can reference bytes outside the queue and those bytes can change independently across readiness, claim, validation, classification, health observation, quarantine, and delivery. This defeats claim-as-snapshot semantics and can produce inconsistent queue state, misleading isolation, or reads outside the declared trust root. BOT ERRORS local dispatch and reclaim, remote relay claim/reclaim/ack, queue health and watchdog backlog verdicts, quarantine semantics, runtime manifests, and any maintenance consumer that inventories queue leaves. No live queue, host, transport, or production state was inspected or mutated.

## #2485: alerts: atomic state writers report success when parent-directory sync cannot start

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2463, #2464, #2482

### Evidence

At origin/main a91f5301266fae2049cd1ae1b3c1b236a7ea2aa8, a deterministic AST census found all nine principal atomic JSON writers flush and fsync file content and atomically replace the target, then mask OSError while obtaining the parent-directory descriptor: three inline and six through fsync_parent. Existing selfcheck and sentinel tests explicitly exercise the ignored-open-error contract. The only change from the issue's original pin touches design-regression files outside this evidence surface.

### Suggested remediation

Extract one versioned, deployable durable-write primitive that returns a bounded stage result and treats required parent-directory open or sync failure as durability_unproven, never ordinary success. After a rename, reconcile stable generation or event identity before retry; make best-effort persistence an explicit weaker API with metadata-only diagnostics; migrate the nine callers under one fault matrix, bundle manifest, structural drift guard, and coherent rollback contract.

### Impact and blast radius

A caller can publish queued, saved, healthy, healed, or recovered success after the target becomes visible but before the namespace update is proven durable, allowing a sudden restart or storage fault to erase state that later decisions treated as committed while producing no bounded durability diagnostic. File-backed BOT ERRORS event publication and controller state across emitter, runner, collector, dispatcher, daily health, heartbeat watchdog, q-loop, selfcheck, and sentinel; downstream queue, suppression, recovery, health, and escalation decisions can inherit the false durable-success result. No production state was inspected or mutated.

## #2486: health: unavailable active-service inventory is treated as complete empty coverage

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: None

### Evidence

At pinned main, active_whatsoup_service_names selects launchctl for both macOS and WSL, returns an ordinary empty set after a missing command or timeout, and parses stdout without rejecting a nonzero command result. unprofiled_service_inventory receives only that set and therefore cannot distinguish proven zero active services from unavailable observation. A synthetic canary confirmed WSL selected launchctl, a nonzero result with one synthetic service was accepted, and a timeout normalized to empty. The existing positive undeclared-service test passed.

### Suggested remediation

Return one versioned typed active-service observation with bounded status, backend, counts, freshness, and exit/error class; allow profile coverage to pass only from a fresh observed result. Select the backend through the same platform capability contract as per-service liveness, keep service names local to comparison, and expose only metadata-safe aggregate receipts.

### Impact and blast radius

An active undeclared runtime or stale health-profile omission can disappear whenever inventory discovery fails, while WSL can select an unsupported backend and still produce the same apparently complete empty result. Daily BOT ERRORS profile coverage, platform service-manager selection, active-runtime inventory, undeclared-service detection, fleet aggregation, and bounded daily-health evidence.

## #2487: observability: BOT ERRORS proof probes emit contradictory success from invalid or absent sources

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `audit`, `bug`, `reliability`
- Recommended labels: `audit`, `bug`, `reliability`
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
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `deploy`, `ops`, `reliability`
- Dependencies: None

### Evidence

At the pinned main revision, gather_tree_provenance records fetch_attempted and a bounded fetch_error, but provenance_findings never evaluates either field. A deterministic in-memory failed-refresh snapshot therefore produced zero findings, info severity, a clear event, clean stdout, exit zero, and no fetch outcome in the event projection. The exact focused test file passes 31 tests but contains no failed-refresh classification or event-contract regression.

### Suggested remediation

Model comparison mode and refresh verdict as separate typed dimensions, map requested refresh failure to an explicit bounded inconclusive or warning finding, qualify clear on sufficient evidence for the selected mode, project privacy-safe fetch and observation fields into JSON and events, and keep reporter mode offline and network-rejecting.

### Impact and blast radius

An explicit refresh request can falsely clear an existing provenance incident and report clean from stale cached refs after the evidence source failed to refresh, hiding network or authentication failures and misleading recovery diagnosis. The opt-in tree-provenance --fetch path, programmatic do_fetch callers, standalone event clear qualification, CLI evidence sufficiency, and runtime-manifest and runbook consistency. Scheduled reporter mode rejects fetch and is not directly affected.

## #2504: observability: manual process-code-staleness collapses probe failures into fresh/healthy

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `SSOT`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: None

### Evidence

At the pinned revision, the manual TypeScript diagnostic ignores discovery and PID command status, converts failed or malformed PID output to not-running, converts failed elapsed-time or source scans to missing timestamps while retaining stale=false, silently substitutes its own checkout when process provenance is unresolved, skips absent critical entries, and computes ok solely from boolean stale fields. Six manual-tool tests cover successful stale, fresh, exact PID zero, JSON shape, critical criterion selection, and successful discovery, while the deployed Python twin has 21 tests including typed failure cases. A content-free in-memory command-adapter matrix reproduced discovery failure, PID failure, malformed PID, elapsed-time failure, source-scan failure, and a missing critical entry as exit 0 with ok=true; affected instance results were stale=false or not-running. The byte-identical pinned Python twin raises ProbeError and exits 2 for the corresponding probe failures, confirming divergent unknown/error semantics.

### Suggested remediation

Make one typed runtime-staleness observation and verdict contract canonical. Retire the duplicate manual implementation after reference proof, or make it a thin adapter over the canonical privacy-safe result; then share one failure/conformance matrix across human and JSON surfaces. Coordinate with issue #2505 so the canonical contract also supports generation-complete recovery rather than preserving an mtime-only false-clear seam.

### Impact and blast radius

Operators and JSON consumers can receive affirmative current-code health when inventory, process age, source age, critical-source completeness, or process-source identity was never successfully observed. The documented exit-2 path is bypassed for ordinary subprocess failures, and the deployed monitor can disagree with the manual diagnostic for the same unknown state. Manual incident diagnosis, runtime-staleness JSON consumers, critical-file gating, BOT ERRORS runtime-staleness monitoring semantics, recovery decisions, and documentation that claims one conservative or single-owner contract.

## #2505: reliability: runtime-staleness emits recovery when a post-boot source file is deleted

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`
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
- Current labels: `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `reliability`, `type-safety`
- Dependencies: #2447

### Evidence

Exact pinned blobs preserve independent eventType/severity vocabularies, allow both clear spellings to carry critical severity, classify every clear as incident recovery, classify generic informational alerts as recovery-dedupe candidates, and omit error alerts from the recovery episode barrier. A write-free AST-extracted canary reproduced all three contradictory classifier outcomes and the CLI spelling mismatch. Exact changed-file pagination across all 38 open pull requests found no implementation owner; draft PR #2495 collides with dispatcher paths but preserves all five decisive classifier/formatter functions byte-for-byte.

### Suggested remediation

Introduce a versioned tagged BOT ERRORS envelope with one canonical validator and normalized semantic classifier. Validate before enqueue, quarantine unsupported schema-v1 inputs before incident mutation, give incident alerts, recoveries, and informational notices disjoint variants, normalize both clear CLI spellings, and migrate formatting, lifecycle, dedupe, storm, stale, dead-letter, replay, and metrics consumers to the shared result.

### Impact and blast radius

Contradictory or stale events can close incident state while displaying paging severity, informational notices can enter recovery-specific dedupe, and error alerts can reopen incidents without establishing the same episode barrier as warning or critical alerts. BOT ERRORS emission and durable queue ingress; dispatcher formatting, incident open/close state, recovery dedupe and storm behavior; stale, dead-letter, replay, and metrics handling; and operator-facing recovery evidence.

## #2507: alerts: lossy incident-key normalization lets distinct sources suppress or clear each other

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`, `type-safety`
- Dependencies: None

### Evidence

At the pinned revision, incident_key applies a lossy filename sanitizer independently to machine, instance, and qualified source before joining them, while emitters accept unrestricted nonempty identity strings. Durable open, cooldown, suppression, clear, flap, stale, queued-recovery, replay, and known-event operations consume that derived key, and helpers recover source semantics by splitting it. A write-free exact-blob canary reproduced both punctuation-normalization and 80-character truncation collisions: the first synthetic alert opened one incident, a clear for a distinct raw source was actionable, and the clear removed the first source's incident. A scan of 1,106 pinned test files found incident-key coverage in 12 files but no incident-identity collision case; the 38-case dispatcher integration file also lacks one.

### Suggested remediation

Define incident identity as a versioned bounded tuple with separate display labels. Use unambiguous length-prefixed encoding or a domain-separated digest plus stored-tuple verification for compact keys; validate source and qualifier vocabularies at ingress without making validation the sole collision defense; move every dispatcher consumer away from slug and split semantics; and dual-read or quarantine legacy state without merging histories, manufacturing recovery, resetting cooldowns, or losing exact clear ownership.

### Impact and blast radius

Distinct conditions can share suppression, cooldown, inhibition, renotify, severity, and evidence history, or one condition's recovery can retire another condition without recovery proof. Long dynamic qualifiers and ordinary punctuation, Unicode, boundary, empty-image, delimiter, and underscore variants can trigger the defect. BOT ERRORS durable incident identity; open and cooldown state; duplicate, inhibition, supersession, flap, stale and recovery logic; queued recovered-before-delivery handling; writefail and replay deduplication; state migration and rollback; producer ingress contracts; and operator evidence derived from incident keys.

## #2508: observability: BOT ERRORS controller JSONL lacks a common schema and cycle correlation

- Classification: `leaf`
- Evidence state: `partial`
- Confidence: `high`
- Current labels: `SSOT`, `alerts`, `audit`, `bug`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `reliability`, `type-safety`
- Dependencies: #2386, #2464

### Evidence

Exact pinned blobs confirm five independently shaped controller-log writers: dispatcher and collector add time and pid around caller payloads, watchdog adds time and kind, q-loop event records add ts, time, and kind, and health-check's private JSONL writer adds time and pid. None supplies a shared versioned controller-log envelope, bounded component or level vocabulary, process-run identity, per-cycle identity, or monotonic record sequence. Exact AST counts reproduce 47 dispatcher, 32 collector, 9 watchdog, 12 q-loop, and 3 deadman call sites, while the inspected focused tests assert selected record names or fields rather than one closed-world parity contract. The issue's deadman canary is not emitted-shape proof: append_deadman_log passes the caller payload to append_private_jsonl, which injects time and pid before serialization. Complete pagination across all 38 open pull requests and 1,327 changed-file entries found no implementation owner; draft PR #2495 is a collision on dispatcher, health-check, and a dispatcher test.

### Suggested remediation

Define one deployable versioned controller-log envelope builder and writer, coordinated with the shared Python primitives in #2464. Give it canonical observedAt, bounded component, recordKind, level, and outcome vocabularies, process-start runId, per-iteration cycleId, monotonic sequence, bounded safe failure classes, typed content-free correlation fields, and collision rejection. Migrate the five producers with explicit cycle start, completion, and failure receipts; preserve legacy records through an explicit legacy_unversioned parse result; and apply #2386's metadata-only boundary before serialization.

### Impact and blast radius

Controller records cannot be deterministically joined into one outage timeline or attributed to a specific iteration. Reused daemon PIDs and timestamps cannot distinguish overlapping, restarted, partial, or repeated cycles, and source-specific discriminator fields force heuristic parsing. Missing version and collision rules let record shape drift silently. Dispatcher, collector, heartbeat-watchdog, q-loop, and deadman controller diagnostics; incident investigation and cross-stream queries; inline-tail correlation for #2136; retention and ordering work for #2135; shared Python observability primitives in #2464; legacy and rotated JSONL readers; and privacy guarantees for durable diagnostic metadata.

## #2509: reliability: controller JSONL failures either disappear silently or abort completed work

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2386, #2464, #2508

### Evidence

Exact pinned blobs preserve five caller-specific failure policies around the same JSONL append boundary: heartbeat watchdog catches and discards every append exception, while q-loop, collector, dispatcher, and deadman writers propagate it. Collector daemon mode has no cycle exception boundary. Dispatcher daemon mode converts an uncaught append exception into a generic failed-cycle state even when a preceding domain transition completed. A write-free canary compiled the exact pinned writer and deadman function bodies with in-memory boundaries: one reserved OSError returned only from watchdog, propagated from the other four writers, and caused two successful synthetic deadman recovery sends across two invocations while producing zero state saves and leaving the durable incident open. Exact changed-file pagination across all 38 open pull requests found no implementation owner; draft PR #2495 collides with three affected paths.

### Suggested remediation

Build the failure contract on the versioned controller-log envelope from #2508 and the shared primitive boundary from #2464. Give each record family an explicit diagnostic-best-effort or audit-critical durability class. Best-effort append failure must preserve truthful domain outcome while updating an independent bounded metadata-only sink-health state; audit-critical intent and transition must use a durable outbox or transaction with restart reconciliation. Persist idempotency state before nonessential logging after external side effects, distinguish domain failure from diagnostic degradation and pending audit in health and exit codes, and apply one explicit daemon exception policy across all five controllers.

### Impact and blast radius

The same storage fault can erase watchdog diagnostics without any degradation signal, terminate collector operation, make dispatcher report failure after a completed move or delivery, replace a q-loop domain error with a logger exception, or repeatedly send deadman recovery while durable incident state remains open. BOT ERRORS watchdog, q-loop, collector, dispatcher, and deadman diagnostics; collector daemon continuity; dispatcher queue, delivery, incident, and cycle receipts; deadman notification idempotency; controller health and exit-code truth; restart reconciliation; and future shared logging, rotation, and retention behavior.

## #2510: alerts: capture-only sink is production-reachable while reporting durably queued

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
- Recommended labels: `alerts`, `audit`, `bug`, `config`, `deploy`, `ops`, `reliability`, `type-safety`
- Dependencies: #2391, #2447

### Evidence

Exact pinned blobs prove that any non-empty ambient WHATSOUP_ALERT_SINK enters capture before the durable outbox and legacy helper, appends one local record, and returns ok=true, channel=sink, status=durably_queued. observeAlertEmission then reduces that result to true. A write-free deterministic source canary verified the contract, found no sink validation in the managed wrapper, systemd unit, container entrypoint, bootstrap, or health projection, and checked six representative durability, incident-marker, transport-latch, scheduler-latch, and recovery-clear transitions that advance on the checked boolean. The focused sink test explicitly expects no outbox file, no helper spawn, and true. Exact pagination across all 38 open pull requests and 1,327 changed-file records found no owner or issue reference. Draft PR #2495 modifies the emitter for a separate protocol proposal but preserves the sink durably_queued result and lacks capture authority or startup exclusion. Two additional collision-only preservation PRs touch wrapper or health paths but their exact head refs contain a publication-prohibited private host label, so those ref values are withheld as null while public PR numbers, URLs, titles, states, and collision paths remain in this registry.

### Suggested remediation

Split local capture, dispatcher-owned durability, and transport acceptance into distinct typed outcomes and make each caller declare its required acceptance level. Bind capture to verifier-scoped authority that is mutually exclusive with the live producer authority from #2391; fail normal application startup before message processing when capture is ambient or unauthorized. Scrub or reject the key in managed wrappers, systemd and container entrypoints, cover deployment-owned launchd configuration, and expose only bounded route-mode and validation enums in startup and health. Preserve the no-fallthrough invariant on capture failure.

### Impact and blast radius

A production process that inherits the sink can record alert and clear obligations as satisfied while creating no dispatcher-owned event and making no operator-facing transport attempt. Lifecycle latches can suppress retries, quarantine and recovery gates can advance, and incident markers can be persisted or deleted on local capture alone. TypeScript alert emission and clear semantics; managed systemd, wrapper, container, and deployment-owned launch environments; startup and health observability; durability quarantine gates; transport and scheduler alert latches; fleet recovery clears; and restart-persistent incident ownership.

## #2511: recovery: one-shot restart marker can suppress a real crash or lose completion ownership

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `alerts`, `audit`, `bug`, `ops`, `reliability`
- Recommended labels: `SSOT`, `alerts`, `audit`, `bug`, `ops`, `reliability`
- Dependencies: #2476

### Evidence

Exact pinned blobs show the request writes one marker before the checked request alert and service-manager invocation, deliberately retains it after a fast invocation rejection, and never records the alert result. Startup independently consumes and deletes that marker before an unchecked completion alert and before a process-local three-second delayed chat handoff. The OnFailure script independently deletes the same fresh marker and exits before gathering crash evidence. Twelve write-free exact-source assertions passed, and a content-free in-memory transition canary reproduced rejected-request crash suppression, rejected-request false completion, early replacement crash after destructive consumption, and either consumer starving the other. Current tests explicitly codify rejected-invocation retention, consume-and-delete, warning-only completion-ping rejection, and crash-alert suppression. Full pagination of 38 open pull requests, 42 changed-file pages, and 1,327 changed files found no implementation owner; four open pull requests collide with decisive paths without changing this transaction.

### Suggested remediation

Replace the consume-once marker with a versioned opaque restart transaction whose phases distinguish recorded request, request-alert disposition, accepted, rejected, or unknown invocation, expected prior generation, replacement-generation and health proof, crash-classifier acknowledgement, completion-alert handoff, originating-chat journal and confirmation, retry ownership, expiry, and terminal disposition. Give each consumer an independent idempotent acknowledgement; a rejected invocation must close as failed without authorizing later crash suppression or completion.

### Impact and blast radius

A rejected restart request can suppress a later unrelated crash or be reported as completed by an unrelated startup. A genuine restart can lose crash classification or completion continuity depending on consumer order, and an early replacement-process crash can erase the only transaction evidence before either completion notification has durable ownership. Agent-triggered self-restart, service-manager invocation outcomes, startup continuity, OnFailure crash classification, BOT ERRORS request and completion alerts, originating-chat acknowledgement, retry behavior, stale-receipt expiry, and operator recovery evidence.

## #2512: guards: reject negated GitHub closing keywords in PR bodies

- Classification: `leaf`
- Evidence state: `verified`
- Confidence: `high`
- Current labels: `audit`, `bug`, `reliability`, `tech-debt`
- Recommended labels: `audit`, `bug`, `reliability`, `tech-debt`
- Dependencies: None

### Evidence

GitHub's current primary documentation enumerates nine lexical closing keywords in pull-request descriptions and commit messages, including case and colon variants, and applies them when a pull request targets the default branch. The fully paginated #2391 timeline independently records merged PR #2443 as its closer at 2026-07-26T15:30:19Z and an owner reopen four minutes later; the issue comment identifies the negated closing-keyword disclaimer as the cause. The live issue also records repaired disclaimer wording in four open drafts: #2313, #2451, #2452, and #2455. At the pinned revision, publication-guard accepts only repository all, staged, or release modes and reads no pull-request metadata; quality.yml runs that file-only mode; pre-push-guard only classifies ref-update lines before dispatching the branch gate; and repo-hygiene reads candidate commit messages but checks no closing-directive rule. Exact pinned searches found no pull-request-body or closing-keyword detector on the guard, workflow, package, or guard-test surfaces. A content-free scan of all 38 open pull-request bodies found zero remaining negated closing directives, and a scan of 7,183 locally reachable commit messages found zero. Fully paginated changed-file and reference scans across all 38 open pull requests found no implementation owner, no direct #2512 reference, and 17 collision-only path overlaps on shared workflow, package, guard, test, or public-surface paths.

### Suggested remediation

Add one bounded GitHub closing-directive parser with file/stdin and explicit commit-range modes. Treat every supported lexical keyword, tense, case, optional colon, and same- or cross-repository issue target as a directive before considering surrounding prose; reject disclaimer or negation shapes; and permit intentional closure only through a small machine-readable policy block that reports the bounded issue numbers for review. Run the same primitive in pull-request CI using the event payload, fail closed when required metadata is absent or unreadable, hard-fail default-branch targets, warn stacked targets about later retargeting, and run commit-range mode from the pre-push and server-side candidate-range gates. Emit only rule codes, counts, and issue numbers.

### Impact and blast radius

A grammatically negative disclaimer can silently become an issue-closing instruction when a pull request reaches the default branch, so a merge that passes every source and test gate can mutate unrelated planning state and falsely report broader work complete. Open-issue lifecycle integrity, pull-request descriptions, candidate commit bodies, stacked-branch retargeting, merge-queue and default-branch CI, pre-push and release gates, issue registries and ledgers, implementation scheduling, audit evidence, and any automation that trusts open or closed issue state.
