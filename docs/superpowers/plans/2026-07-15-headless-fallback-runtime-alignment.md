# Headless Fallback Runtime Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every WhatSoup OpenCode fallback turn explicitly select a usable headless execution profile, prevent provider/route crossover on resume or manager reuse, and expose fail-closed capability and alignment evidence.

**Architecture:** Resolve one immutable route at turn admission and thread it through manager creation, persistence, argv/environment construction, capability admission, and health. Persist exact agent-row linkage in checkpoints, reconcile route changes at the serialized queue boundary, and keep model usability separate from real edit-plus-shell capability.

**Tech Stack:** TypeScript on pinned Node 24.15, SQLite migrations, Vitest with fork pool, Zod/config validation conventions, Pino structured logging, existing provider subprocess and health/parity infrastructure.

**Status:** source implementation start `Ready with Constraints`; source exit and fleet
rollout remain `Not Ready`

---

## Global Constraints

- Work only from the verified repository root of this isolated implementation worktree.
- Treat the reported 988-test-file / 18,809-test / 1-skipped result as a historical
  target, not current proof. Re-prove it at A00 through the pinned wrapper before calling
  the implementation tree clean.
- Write a failing behavioral test before each production change and observe the expected failure.
- Do not use text-only provider output as tool-capability proof.
- Treat command-pattern denies as OpenCode dispatcher policy, not an operating-system
  sandbox. They do not mitigate a leaked `SUDO_ASKPASS` or other privileged environment.
- Do not log provider session tokens, prompts, raw permission output, credential values, or private host identity.
- Missing, malformed, stale, timed-out, skipped, or masked evidence is non-pass.
- Keep OpenCode dispatcher policy claims distinct from operating-system isolation claims.
- Do not deploy, perform a live service restart, mutate a fleet instance, send an external
  message, or enable an alert channel from this plan. Source code may add and
  deterministically test injected drain/restart behavior without invoking it on a host.
- Update any runbook whose stated gap is closed in the same commit.
- Use `bash scripts/run-with-pinned-npm.sh` for all Node/npm commands.

## Shared Execution and Evidence Contract

- Run every implementation and verification command from the repository root. If the
  repository root or expected branch cannot be proven with `git rev-parse`, stop with
  verdict `Blocked`.
- Use `artifacts/` as the local, non-secret evidence root for this plan and
  `artifacts/run_manifest.json` as the command/provenance ledger. The manifest must
  record a run ID, UTC timestamp, baseline Git SHA, exact command, exit code, tool
  version, output path, owning task, and verdict for every claimed check.
- Use only `Pass`, `Fail`, `Inconclusive`, or `Blocked` as evidence verdicts. A zero exit
  code is `Pass` only when the expected assertions ran and the captured output proves
  the named claim.
- Capture deterministic stdout/stderr for each check under a stable task-specific path,
  for example `artifacts/task-08/dynamic-canary.txt`. Never paste credentials, provider
  session tokens, prompts, raw permission payloads, absolute private paths, or private
  host identity into evidence.
- Record an unavailable optional tool as `Inconclusive` with `not installed` and the
  affected claim. A missing required tool, repository context, expected assertion,
  current runtime observation, or evidence file is `Blocked`; do not silently skip it
  or substitute narrative judgment.
- Mark a checkbox complete only after its manifest entry names the evidence artifact and
  the artifact contains the exact command, observed result, and verdict. Stale artifacts
  from another Git SHA or runtime fingerprint are non-pass.
- Keep source completion and fleet completion separate. Repository evidence may prove
  implementation readiness; only fresh qFleet observations from every in-scope host may
  prove fleet alignment.

## Objective, Scope, and Exit Criteria

**Objective:** Change the WhatSoup agent runtime so every OpenCode fallback command uses
an explicitly configured headless execution profile, every resumable session is bound to
its persisted provider and immutable route, and fallback eligibility requires fresh
edit-plus-shell capability evidence. Expose redacted route/capability drift through the
existing health and fleet-parity surfaces.

**In scope:**

- provider command/environment construction in `src/runtimes/agent/session.ts` and
  `src/runtimes/agent/providers/`;
- route selection, manager lifecycle, queue admission, and fallback eligibility in
  `src/runtimes/agent/runtime.ts` and its extracted pure seams;
- exact-row session/checkpoint persistence in `src/runtimes/agent/session-db.ts`,
  `src/core/session-lifecycle-store.ts`, `src/core/durability.ts`, and the next SQLite
  migration;
- OpenCode tool-event parsing and client/operator error rendering in
  `src/runtimes/agent/providers/opencode-parser.ts`, `src/runtimes/agent/tool-update.ts`,
  `src/runtimes/agent/outbound-queue.ts`, and `src/core/outbound-message-safety.ts`;
- additive health/provider-status output, fleet hardening parity, configuration/public
  surface documentation, and operator runbooks under `docs/`;
- tests and guards that prove the above source behavior and produce a redacted qFleet
  deployment packet.

**Non-goals:**

- no fleet deployment, service restart, host mutation, external message, alert enablement,
  or qFleet implementation in this repository execution;
- no claim that OpenCode dispatcher permissions provide operating-system sandboxing;
- no requirement to grant Full Disk Access, Accessibility, Automation, Developer Tools,
  or other macOS TCC services unless a concrete WhatSoup operation is proven to need one;
- no acceptance of a model text response, credential presence, CLI startup, or static
  config alone as proof that edit and shell tools work headlessly;
- no migration of ambiguous legacy sessions by recency, provider-token shape, or current
  default provider; ambiguous state remains quarantined and visible.

### Measurable success and failure

| ID | Success criterion | Concrete check and threshold | Required evidence |
|---|---|---|---|
| S1 | OpenCode commands use one configured profile and one credential lane | Fresh, resumed, model-usability, and dynamic-canary argv tests all pass; each argv contains exactly one `--agent whatsoup-headless`; child-env tests expose only system/WhatSoup context actually required and the selected route credential, while excluding `SUDO_ASKPASS`, `ALLOW_M365_MUTATIONS`, `CLAUDE_CONFIG_DIR`, other credentials, and unrelated connector/provider mutation flags | `artifacts/task-01/tests.txt` and manifest entries with verdict `Pass` |
| S2 | Resume and manager identity cannot cross provider routes | Migration, exact-row lifecycle, mixed-provider token, startup/per-chat resume, and queue-reconciliation suites pass with ambiguous legacy rows non-resumable | `artifacts/tasks-05-07/tests.txt` with verdict `Pass` |
| S3 | Tool-dead fallback lanes are ineligible | Static policy/runtime attestation and disposable edit-plus-shell canary tests pass; text-only, auto-reject, timeout, stale, malformed, or fingerprint-mismatched evidence never yields `aligned` | `artifacts/task-08/attestation-tests.txt` with verdict `Pass` |
| S4 | Failures are useful without leaking internals | Parser, tool-update, outbound queue, and outbound-message-safety suites pass; no empty bullet and no client-pasteable `[internal-path]` command is rendered | `artifacts/tasks-02-10/error-tests.txt` with verdict `Pass` |
| S5 | Source emits and gates the evidence needed to observe fleet drift | Health/provider-status and parity-guard suites pass; hardened rows require A-F evidence and expose desired/observed route, runtime, profile, policy, provider role, effective plugin/hook state, config/settings fingerprints, transactional-normalization state, fresh runtime-generation receipt, reconciliation counts, and macOS TCC disposition (`not_required` unless an operation-specific denial proves otherwise). This source proof does not prove installed fleet state. | `artifacts/task-09/health-parity.txt` with verdict `Pass` |
| S6 | Repository behavior remains green | All focused suites, `typecheck:all`, named guards, full unmasked Vitest run, and branch push gate pass on the final Git SHA | `artifacts/task-11/` plus a complete `artifacts/run_manifest.json` |

Any of the following is a detectable failure: a required command exits nonzero; an
expected test/assertion does not run; an artifact is absent, stale, redacted beyond
verification, or tied to another SHA; a provider token resumes under a different route;
an OpenCode lane becomes eligible without fresh parsed edit and shell evidence; health
reports hardened while A-F evidence is incomplete; or client output presents an internal
path placeholder as executable instruction. Record the condition as `Fail` when the
assertion disproves the requirement, `Inconclusive` when evidence cannot decide it, and
`Blocked` when the next required action cannot safely proceed.

**Source exit:** all S1-S6 evidence is `Pass`, the final diff has independent requirements
and code-quality review, and no open blocker is hidden by a fallback or skipped check.
**Fleet exit:** separately, qFleet reports a fresh aligned observation for every in-scope
mini at its installed binary/profile/policy fingerprints, exact provider role/effective
plugin-hook policy, two-file normalization fingerprints, new runtime generation, and
fresh-session receipt, with TCC disposition `not_required` unless separately proven.
Until that live step occurs, fleet status remains `Inconclusive`, even when source exit
is satisfied. `Ready`, `Ready with Constraints`, and `Not Ready` are action-readiness
states; `Pass`, `Fail`, `Inconclusive`, and `Blocked` are evidence verdicts. A fleet gate
is `Not Ready` while its evidence may be `Blocked` when a required safe prerequisite is
absent, or `Inconclusive` after prerequisites are valid but the authorized live
observation has not yet run.

## Assumption Audit

Evidence quality is one of `direct`, `indirect`, `stale`, `inferred`, or `missing`.
`Unresolved` assumptions may not be promoted to facts; a critical unresolved assumption
blocks the dependent checkpoint, not unrelated source work.

| ID / category | Statement | Source location | Why it matters; risk if false | Available evidence / quality | Blast radius | Exact validation method | Evidence artifact | Owner / due checkpoint | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| A01 / runtime | Every deployed OpenCode version supports explicit agent selection with the intended argv syntax. | `src/runtimes/agent/session.ts`; installed CLI, not repository lockfile | Required to select `whatsoup-headless`; unsupported syntax must not silently use `default_agent`. | Planning-workstation OpenCode 1.17.15 help exposed `--agent`; fleet versions are unobserved / indirect | All OpenCode fallback hosts | Capture `opencode --version` and the applicable `opencode run --help` through qFleet; static attestor must classify unsupported syntax as `blocked`. The deployment owner must supply the approved qFleet selector/command rather than this plan inventing one. | `artifacts/task-08/runtime-inventory.json` | runtime owner / before any host canary | `Constrained`: unsupported or unobserved hosts are ineligible; fleet-wide support remains `Unresolved` |
| A02 / configuration | `providerConfig.executionProfile` can be added without a second configuration source of truth. | `src/config.ts`; `src/core/agent-config-validator.ts`; `src/core/provider-mcp-config.ts` | A duplicate agent selector would drift from runtime argv. | Current provider config flows through these seams and writer preserves unrelated config / direct source read | Instance load, config writer, docs | `rg -n "providerConfig|default_agent|executionProfile" src tests docs` followed by validator and writer round-trip tests. | `artifacts/task-01/config-seam.txt` | Task 1 owner / red phase | `Constrained`: one canonical WhatSoup field; never read OpenCode `default_agent` operationally |
| A03 / policy | OpenCode exposes enough stable policy/config data to prove edit and shell resolve to non-interactive allow. | proposed `opencode-capability-attestor.ts`; installed OpenCode config surfaces | Static attestation cannot be fabricated; a syntax guess could false-green the lane. | Current incident proves `ask` auto-rejects headlessly; exact cross-version inspection interface is unverified / indirect | Eligibility and fleet parity | Before production implementation, characterize the installed supported CLI/config output with sanitized fixtures; inject version-specific adapters. If no deterministic interface exists, static state is `inconclusive` and only a successful dynamic canary may establish capability. | `artifacts/task-08/static-interface.txt` | Task 8 owner / before green phase | `Unresolved`; blocks `aligned` classification, not source scaffolding |
| A04 / credentials and privilege env | Model prefix plus optional `apiKeyService` is sufficient to select exactly one credential service, and OpenCode needs no inherited privilege/mutation environment. | current mappings and `buildBaseChildEnv`/`buildChildEnv` in `src/runtimes/agent/session.ts` | An incomplete mapping can remove the needed key; the current base child env can leak `SUDO_ASKPASS`, `ALLOW_M365_MUTATIONS`, `CLAUDE_CONFIG_DIR`, or unrelated connector/provider mutation authority. Pattern-denying `sudo` does not contain a credentialed askpass. | Prefix mappings and broad base-env forwarding are directly present; the minimal WhatSoup context set remains to be characterized / direct plus unresolved | Every OpenCode model route and connector boundary | `rg -n "apiKeyService|SERVICE_ENV_MAP|SUDO_ASKPASS|ALLOW_.*MUTATION|CLAUDE_CONFIG_DIR|buildBaseChildEnv|buildChildEnv" src tests docs`; enumerate supported prefixes and all privilege/mutation/credential keys, then require an allowlist-based table case for each. | `artifacts/task-01/credential-env-map.txt` | Task 1 owner / before implementation | `Constrained`: unknown prefix or environment key is excluded and produces explicit config/attestation evidence, never a credential or authority superset |
| A05 / schema | Migration 45 is still the next free schema number at implementation time. | `src/core/database.ts`; migration files and tests | A stale number can collide with another branch. | Baseline schema was observed at 44 / direct but time-sensitive | Database startup and all instances | `rg -n "schemaVersion|user_version|migration 45|version: 45" src tests`; run migration numbering/safety suites immediately before adding the migration. | `artifacts/task-06/migration-number.txt` | Task 6 owner / immediately before edit | `Unresolved` until rechecked; choose the next free number without changing migration semantics |
| A06 / persistence | Provider session tokens are globally unique enough to identify one checkpoint. | `src/runtimes/agent/session-db.ts`; `src/core/durability.ts` | The incident disproves safe cross-provider reuse; token-only lookup can resume or update the wrong row. | Provider is stored on agent rows, but production queries/checkpoints are provider-blind / direct | Resume, close/reactivate, recovery | Mixed-provider fixtures deliberately reuse one token and assert only an exact linked row can change or resume. | `artifacts/task-06/mixed-provider-tests.txt` | Task 6 owner / red phase | `Replaced`: exact agent-row ID plus provider and route predicates are required |
| A07 / concurrency | The shared, single, and per-chat queue boundaries can serialize route replacement without terminating an admitted turn. | `src/runtimes/agent/runtime.ts`; turn coordinator and per-chat actor tests | Reconciliation at the wrong boundary can overlap or kill work. | Existing queue seams exist; all three modes have not yet proved the new transition / indirect | All runtime modes during fallback and revert | Run pure transition matrix plus an integration barrier test that changes route mid-turn and observes replacement only at the next admission. | `artifacts/task-07/reconciliation-tests.txt` | Task 7 owner / before implementation | `Unresolved`; blocks Task 7 green phase until red behavior is reproduced |
| A08 / protocol | Parsed OpenCode tool events can prove both sentinel edit and independent shell verification across supported versions. | `src/runtimes/agent/providers/opencode-parser.ts`; planned attestor | Text-only success or changed event shape would create a false pass. | Parser currently drops some rejected-tool identity/detail; successful cross-version canary shape is not inventoried / indirect | Capability admission and diagnostics | Use recorded sanitized event fixtures per supported runtime plus a real disposable canary under watchdog; require parsed edit and parsed bash events tied to the same sentinel. | `artifacts/task-08/dynamic-canary.txt` | Task 8 owner / before fail-closed rollout | `Unresolved`; missing event proof is `inconclusive`, never `aligned` |
| A09 / public surface | Additive health fields will not break consumers and can be published without sensitive data. | health source located by `tests/core/health.test.ts`; `tests/fleet/routes/provider-status.test.ts`; `docs/public-surface.md` | Consumer breakage or data leakage would make drift detection unsafe. | Existing JSON health/publication guards exist / direct; all consumers are not enumerated / indirect | Health clients, console, parity tooling | Trace health serializers and tests with `rg -n "provider-status|health" src console tests`; add exact JSON-shape, redaction, publication, and public-surface drift tests. | `artifacts/task-09/health-consumers.txt` | Task 9 owner / red phase | `Constrained`: additive, redacted fields only; unknown consumers require review |
| A10 / macOS permissions | Workspace-scoped WhatSoup edit/bash can run in the service user context without extra TCC grants. | deployment environment, outside repository | Unneeded TCC grants increase host privilege; a truly required grant could still block the canary. | No operation-specific TCC dependency has been proven / missing | macOS service lane only | qFleet deployment preflight records service user, launch context, workspace reachability, and canary result; record exact disposition `not_required`. Inspect TCC only after a denied operation identifies a protected service, then prove the minimal service/operation pair and separately authorize any grant. No blanket grant is permitted. | `artifacts/deployment/tcc-baseline.json` | fleet operator / canary deployment | `Constrained`: TCC is `not_required` unless operation-specific evidence changes the disposition; extra, unknown, or blanket grants are drift |
| A11 / reuse | Preserved cleanup worktree and resume-safety commits remain available and coherent with this branch. | `codex-runtime-cleanup-20260715`; commits `8e7daba39`, `e22a4b999`, `1767af922`, `5deed78ce`, `871669d06` | Missing or diverged source invalidates cherry-pick instructions. | Paths/commits were reported during planning but must be re-read at execution / stale | Tasks 3-4 only | `git show --stat --oneline <sha>` for each commit; `git diff --stat HEAD...<source>` and `git apply --check` on an exported combined patch. | `artifacts/tasks-03-04/reuse-audit.txt` | Tasks 3-4 owner / before any port | `Unresolved`; manual behavior-preserving implementation is the documented fallback |
| A12 / fleet orchestration | qFleet can inventory every in-scope mini and invoke the WhatSoup-owned Task 9A normalization seam with per-host evidence and bounded rollback. | external qFleet surface, not defined in this repo; `src/fleet/routes/ops.ts` currently has only non-transactional generic writes | Repository green cannot prove installed state; direct qFleet file writes or generic PATCH would bypass CAS, lifecycle, and rollback guarantees. | User requires fleet alignment; current WhatSoup generic PATCH writes settings/config separately with no restart, while exact current qFleet command/schema is missing / direct plus missing | Fleet completion | Deployment owner supplies the current qFleet contract; validate it against Task 11, require maintenance gate plus expected two-file fingerprints/idempotency, and reject any direct host write or non-Task-9A endpoint before mutation. | `artifacts/deployment/qfleet-contract.json` | fleet owner / after source exit | `Unresolved`; blocks fleet exit and all host mutation until the dedicated seam and qFleet contract are both proven |
| A13 / trust-source selection | Provider-role parity can identify the effective Claude trust/config source without exposing its path or assuming the native file wins over `CLAUDE_CONFIG_DIR`. | trust producer and instance launch environment to be identified in Task 9B | Inspecting the wrong file can report trusted while the launched runtime reads another source; publishing paths leaks private host state. | Incident shows ignored allowlist due missing trust acceptance; source-selection implementation has not been traced / indirect | Claude readiness noise, role parity, fleet reports | Trace the producer from launch environment to the selected trust file; add table tests for native, `CLAUDE_CONFIG_DIR`, missing, conflict, and redaction. Emit source kind plus normalized requested/observed state only. | `artifacts/task-09/trust-source.txt` | Task 9B owner / red phase | `Unresolved`; trust mismatch remains visible/non-hardened, while project-trust paths/state stay private and TCC remains `not_required` |

The contract/config reconnaissance artifacts for this review are
`artifacts/contract_file_hits.txt` and `artifacts/config_inventory.txt`. Optional policy
and dependency scanners do not decide these runtime assumptions; if absent, record
`not installed` and preserve `Inconclusive` for claims that depended on them.

## Existing Surface and Reuse-First Audit

Before creating a file, helper, service, adapter, schema path, endpoint, guard, fixture,
or runbook, write `artifacts/reuse_audit.md` from current-source searches. Capture the
first 300 broad findings in `artifacts/reuse_scan.txt`, but use untruncated targeted
searches for each implementation decision. At minimum run:

```bash
rg -n --hidden --glob '!.git/*' \
  "TODO|FIXME|deprecated|helper|util|shared|common|base" .
rg -n "providerConfig|resolveProviderKeyService|buildChildEnv|resolveRoute|probeBinaryCommand|killSessionProcessTree|agent_sessions|session_checkpoints|provider-status|enabledPlugins|outbound-message-safety" \
  src tests scripts docs
git log --oneline --all -- src/runtimes/agent src/core scripts/audit-instance-plugin-coverage.ts
```

The audit records the searched terms/paths, candidate surface, current callers/tests,
reuse decision, rejection rationale, consolidation plan, owner, and evidence. A broad
scan alone is insufficient. New code is `Blocked` until the relevant candidate row is
`reuse`, `extend`, or `new seam justified`; “new seam justified” must explain why the
existing owner cannot safely express the invariant and name the duplicate path removed
or prevented.

| Concern | Existing candidate to inspect first | Required reuse decision |
|---|---|---|
| OpenCode config/profile | `src/core/provider-mcp-config.ts`, `src/core/agent-config-validator.ts`, config writer tests | Extend the canonical config flow and its merge-preserving writer; do not add a second OpenCode config writer or read `default_agent` operationally |
| Provider credential lane | `src/lib/provider-key-service.ts`, `SERVICE_ENV_MAP`, and `buildChildEnv` in `session.ts` | Reuse one model-prefix/custom-service resolver; remove the credential superset instead of creating another mapping table |
| Route resolution/identity | `route-resolution.ts`, `route-events.ts`, `route-intent.ts`, and their tests | Keep one route-decision engine. A new immutable identity seam is allowed only as the post-decision canonical value object, never as a parallel resolver |
| Child supervision | `providers/binary-preflight.ts`, `process-tree.ts`, budget and coordinator seams | Reuse `probeBinaryCommand`/generation-aware tree reaping or extract their tested primitive; no bare timeout-only child runner |
| Session persistence | `session-db.ts`, `session-lifecycle-store.ts`, `durability.ts`, migration registry and exact-row tests | Extend the existing exact-row lifecycle transaction and `CURRENT_SCHEMA_MIGRATION`; do not introduce a second store or token-only lookup |
| Health and fleet parity | `src/core/health.ts`, `src/fleet/routes/lines.ts`, `src/fleet/provider-parity.ts`, existing parity guard/tests | Add fields to existing snapshots/status/parity rows and public-surface registry; no sibling health endpoint or standalone inventory |
| Provider role/plugins | existing config/workspace settings writers and `scripts/audit-instance-plugin-coverage.ts` | Extend the current explicit true/false coverage audit with role policy; do not build another plugin scanner; keep project trust private |
| Error/redaction flow | provider parser, `tool-update.ts`, `outbound-queue.ts`, `outbound-message-safety.ts`, traced admin handoff | Extend the existing classifier/renderer/safety chain; one pre-redaction audience decision, no alternate outbound bypass |
| Preserved recovery work | runtime-cleanup worktree and commits named in A11 | Inspect final deltas, tests, overlap, and apply-check; reuse behavior only when current contracts still match, otherwise document a manual port |

DRY review must search exports and semantic behavior, not just identical names. Reject
wrappers that only rename an existing helper, duplicate state machines, speculative
generic frameworks, and one-off inventories whose data already exists. If reuse would
create an ownership cycle, unsafe compatibility coupling, or mixed abstraction level,
record that concrete cost and keep the new seam narrowly pure. Final review repeats the
search against the diff; an unlisted new abstraction, duplicate source of truth, or
unjustified alternate caller path is `Fail`.

## Impact Analysis and Blast Radius

Before each packet starts and again on the integrated diff, update
`artifacts/blast_radius.md`, `artifacts/blast_changed_files.txt`, and
`artifacts/blast_radius_hits.txt`. Trace definitions to callers and consumers with `rg`,
the compiler, tests, public-surface registry, and Git history. The artifact records direct
and indirect impact, compatibility direction, coordination owner, containment, rollback,
and the evidence that supports each conclusion. An untraced public/schema/queue/security
edge is `Blocked`; a broad text hit without caller inspection is `Inconclusive`.

| Surface | Direct change and callers/consumers | Failure and coordination radius | Containment or rollback rule |
|---|---|---|---|
| Instance config | `providerConfig.executionProfile`, provider role, and plugin policy flow through `src/config.ts`, validator, fleet create/update/load, `main.ts`, workspace/settings writer, docs and fixtures | Old writers could drop fields; unset legacy roles could be mistaken as aligned; an unavailable profile could strand fallback | Additive fields, round-trip tests, legacy/unset = non-hardened; disable affected fallback, never infer a default role/profile |
| Provider child boundary | `session.ts`, model-usability adapter, provider config merge, key-service resolver, process tree, budget/coordinator, fresh/resumed/canary children | Wrong argv affects every OpenCode turn; wrong env leaks credentials; timeout/finalization defects leak processes or lose output | Exactly one profile and credential, generation-aware reap, fallback-disabled kill switch; preserve primary lane |
| Route and queue lifecycle | `route-resolution.ts`, runtime manager creation, shared/single/per-chat admission, fallback/revert, `/model`/intent status, crash/recovery callers | Mixed-lane manager reuse can cross providers; mid-turn replacement can kill or overlap work; cached capability can survive drift | Immutable admitted route; active turn drains, mismatch applies next admission, retire idle managers, invalidate cache on identity change |
| Persistence and migration | migration registry, `agent_sessions`, `session_checkpoints`, session DB, lifecycle store, durability, startup/per-chat/crash resume | Migration runs on every database; ambiguity or old code can mutate/resume a wrong row; mixed-version rollback is hazardous | Additive transaction, unique-only backfill, quarantine ambiguity, exact-row/provider/route predicates; roll forward and never restore provider-blind code |
| Tool/error/outbound path | OpenCode parser, stream event contract, tool classifier, outbound queue, message safety, heal/admin handoff | Empty detail hides the incident; late redaction creates unusable client commands; an alternate renderer may leak paths | Non-empty safe fallback, audience classification before redaction, operator-only target command, trace every outbound bypass |
| Health and public API | `GET /health`, `GET /api/lines/:name/provider-status`, health poller, `src/fleet/provider-parity.ts`, console API type/client, provider-parity report, `docs/public-surface.md` | Schema/type drift can break UI or pollers; absent new fields could false-harden old instances; key-service metadata is already a documented observability tradeoff | Additive nullable fields, tolerant consumer fixtures, missing/stale A-F = non-hardened, retain redaction/publication guards |
| Fleet hardening and automation | role-aware plugin audit, tracked parity manifest, hardening guard, branch/release gates, qFleet deployment packet | A source-only row can masquerade as installed alignment; partial fleet normalization leaves mixed policy/profile/plugin versions | Report requested and observed separately, report-only before fail-closed, per-host evidence/rollback authority, no host mutation in this plan |
| Trust and permissions | OpenCode dispatcher policy, child credential environment, service user/workspace, provider role, project trust, macOS TCC, operator/admin audience | `ask` is auto-reject headlessly; excess TCC expands privilege; project trust or dev-only hooks can change runtime behavior; client is not a host operator | Explicit allow/deny profile with dangerous-operation denies; one credential; operation-specific TCC only; private trust evidence; `operational` role excludes test-integrity |
| Observability/alerts | Pino events, runtime health, provider status, parity reason codes, operator alerts, evidence manifest and any fleet dashboard consuming them | Missing or noisy events hide drift or flood operators; changed reason/schema can break alerting and dashboards | Additive versioned telemetry, stable reason codes, dedupe/coverage tests, alert channel remains disabled until separately authorized |

No scheduled-message, cron parser, unrelated worker, media-retention, or general fleet
CRUD change is intended. The only time-based behavior in scope is provider watchdog/reap,
capability freshness/expiry, fallback windows, route reconciliation, and existing health
polling. Any diff touching `scheduler.ts`, scheduled-message tables/routes, unrelated
retention timers, or another worker is scope expansion and requires a new blast-radius
decision before work continues.

Partial deployment is fail-closed: new source with a missing profile/policy/role stays
ineligible; old source encountering additive config must not be treated as aligned; old
consumers may ignore additive health fields but parity must treat their absence as stale
or incomplete. The additive database schema may outlive application rollback. Rollback
therefore disables OpenCode admission, retires mismatched managers, preserves new columns
and evidence, and deploys only code that retains exact-row/provider/route safeguards.
Cross-version canary evidence and the rollback binary/config fingerprint are mandatory
before fleet rollout.

## Error Model and Exception Handling

Maintain `artifacts/error_model.md` as the executable error register. Each observed or
injected failure records class, stable reason code, detection input, trace/run ID,
requested/observed identity, state transition, retry count/deadline, user-safe outcome,
operator action, containment, evidence path, owner, and verdict. Unknown exceptions are
not success: catch them only at a boundary that can add context, perform cleanup, and
either return a typed failure or rethrow. Never include credentials, raw provider output,
private paths, prompts, session tokens, or project-trust state.

| Error class | Detection and handling path | User and operator behavior | Containment, escalation, and evidence |
|---|---|---|---|
| Validation/contract | Validator/type/schema rejection, unsupported provider/profile/policy shape, malformed event/health/evidence, missing assertion | Reject before spawn/write/admission. Client sees a bounded non-technical status only when a client action caused it; operator sees field/reason code and safe expected shape | No retry of deterministic bad input; dependent packet is `Fail` or `Blocked`; capture validator/test output under `artifacts/errors/validation-*` |
| Dependency/runtime | Missing binary, profile, credential mapping/key, unsupported CLI adapter, unavailable required guard, qFleet contract, or role-policy source | Keep OpenCode ineligible and primary behavior unchanged. Client is not told to repair the host; operator receives the missing dependency and owner/checkpoint | Optional scanner = `Inconclusive`; required dependency = `Blocked`; never substitute ambient defaults; capture version/help/preflight evidence under `artifacts/errors/dependency-*` |
| Network/provider | DNS/TLS/connectivity/rate-limit/service error during model probe, provider turn, static inspection transport, or canary | Do not misclassify network failure as permission denial or capability success. Existing client fallback copy remains safe/non-command; operator sees provider, phase, retryability, and redacted status class | Capability stays `inconclusive`/ineligible; no same-turn retry storm. Retry only at the documented bounded probe cadence with jitter/dedupe; capture sanitized status/timing, never response secrets |
| Timeout/process | Five-second existing `probeBinaryCommand` deadline (unless a tested narrower caller deadline is documented), child close deadline, watchdog expiry, or missing stream settlement | User receives no raw timeout/path; if no safe reply exists, use the non-empty fallback. Operator sees child generation, phase, durations, TERM/KILL/reap result | Send TERM then use the existing two-second KILL escalation and generation-aware tree verification; an unreaped/ambiguous child is `Blocked`; artifact includes fake-clock/fault-injection and process census result |
| Retry/idempotency | Duplicate finalizer/event/request ID, migration replay, repeated reconciliation, capability cache recheck, normalization request replay | Return the already-owned result when identity/content match; expose conflict when they do not. Never repeat a client send or apply a stale config write | Use transaction/CAS/idempotency key and bounded attempts; no sleep-based test. Conflicting duplicate quarantines the operation and records before/after fingerprints in `artifacts/errors/idempotency-*` |
| Partial success | Static pass + dynamic fail, edit without bash proof, one of two role/config writes, migration ambiguity, manager drain without restart, operator handoff without delivery, or incomplete A-F row | Never render partial work as success. Client receives only the safe final status; operator sees completed and missing phases plus recovery action | Eligibility/hardening remains false; clean disposable canary state, roll back staged file changes, quarantine ambiguous sessions, and save a phase ledger under `artifacts/errors/partial-*` |
| Rollback/containment | Failure disabling fallback, retiring manager, restoring both role/config files, restarting prior generation, or validating rollback fingerprints | Client gets no host command. Operator receives a critical typed event with exact safe manual authority boundary and whether primary serving remains available | Stop further mutation, set every affected source or fleet gate `Not Ready`, preserve additive schema/evidence, disable admission when safely possible, and require the named repository or fleet owner before recovery; artifact includes both rollback attempts and observed fingerprints |
| Quarantine/dead-letter | Ambiguous/unmatched legacy checkpoint, provider/route mismatch, stale/invalid capability evidence, conflicting CAS, unreconstructable outbound/admin instruction | Quarantined sessions never resume; unsafe client command is not emitted; a generic safe status may be sent through the normal delivery path | Reuse existing durability/operator-alert quarantine where applicable; do not add a generic DLQ without reuse audit. Release requires new exact evidence and authority; record quarantine ID/reason without sensitive payload |

Retries must be finite, cancel on shutdown, respect the serialized owner, and emit attempt,
deadline, and terminal outcome. Validation errors and permission/policy denials are not
retryable. A transient network/unknown result may recheck later, but it cannot keep a user
turn open or admit fallback. A successful retry does not erase earlier evidence; link the
recovery event to the original trace.

Role/plugin normalization is a compensating two-file transaction because filesystem
renames cannot atomically commit both instance `config.json` and cwd
`.claude/settings.json`. Under a per-instance lock, require caller-supplied SHA-256 CAS
fingerprints, stage and validate both files, preserve exact prior bytes/modes, commit both,
drain managers, restart, and prove a fresh session/runtime observes the requested role.
On any write/drain/restart/postflight failure, restore both snapshots and restart the prior
generation. If either restore or prior-generation restart cannot be proven, return
`Blocked`, stop qFleet normalization for that host/cohort, and retain the failure packet.
The generic PATCH path is not evidence of this transaction.

No error path may tell a client to paste a target-host command, substitute an internal
path placeholder, treat `ask` as usable headless permission, grant blanket TCC, or expose
a project-trust path. Error-model exit requires fault-injection tests for every table row,
logger/redaction assertions, cleanup proof, and a manifest-linked artifact. Missing
user/operator behavior or containment for a reachable error is `Fail`.

## Error Messaging and Traceability Contract

Maintain `artifacts/error_catalog.md` as the versioned source for every reachable error
class. Each entry contains stable reason code, failure class, failed operation, owning
component and phase, safe user message shape, operator diagnostic shape, severity,
retryability, containment/remediation hint, required correlation fields, redaction rules,
evidence link pattern, triggering tests, and owner. Production code must use cataloged
codes; changing or deleting a code requires a schema/version update, consumer trace, and
public-surface/telemetry coverage test.

Every failure event and returned diagnostic answers: **what** failed, **where** it failed
(component plus phase, not a private filesystem path), **for which requested/observed
identity**, **with which trace or operation handle**, and **what safe next action exists**.
The envelope carries `telemetry_schema_version`, timestamp, `run_id`, `trace_id`,
operation/change ID when applicable, actor, audience, reason code, safe summary,
retryability, terminal/degraded state, evidence artifact reference, and owner/escalation
class. IDs must be generated at the entry boundary, propagated through child, queue,
persistence, health, normalization, and outbound events, and validated for syntax and
same-operation consistency; a blank, constant, reused-across-unrelated-operations, or
unlinked ID is `Fail`.

| Audience | Required message behavior | Forbidden content | Trace and remediation requirement |
|---|---|---|---|
| Client/user | Brief non-technical statement describing the affected action and safe outcome, for example that the turn could not be completed and no host action is required; never imply success | Internal paths, host/user identity, commands, provider stderr, policy detail, credentials, session/prompt content, artifact paths, stack traces | Include only an opaque support/reference handle when the normal product surface supports it; never tell the client to run a target-host command. Link the handle server-side to the operator event |
| Operator | Specific component/phase, requested/observed fingerprints or safe state, reason code, retryability, containment already performed, missing proof, and bounded next diagnostic/action | Secrets, raw permission/provider payload, prompts/messages, private trust path/state, environment values, or a credential-bearing command | Include `run_id`, `trace_id`, operation/change ID, terminal/degraded state, artifact paths under `artifacts/`, owner, and remediation/rollback checkpoint; identify any authority needed rather than implying permission |
| Audit/health | Machine-readable stable code and state transition with timestamps/freshness, schema version, requested/observed identity, evidence digest, and verdict | Free-form-only error strings or sensitive fields | Correlate to the originating operation and terminal event; consumers must be able to locate sanitized replay evidence from the manifest |

Remediation hints are conditional and authority-aware: retry only when classified
transient and bounded; otherwise name the owning subsystem/checkpoint, containment or
rollback already taken, and evidence to inspect. They must not invent qFleet commands,
request blanket TCC, bypass maintenance/CAS, expose a private path, or shift host repair
to a client. When no automated remediation is safe, say that the operation is contained
and requires the named operator decision rather than offering an unsafe workaround.

Catalog tests must cover every typed error path plus a fallback for truly unknown
exceptions. Logger spies assert audience separation, non-empty safe summaries, stable
code, correlation propagation, evidence-link existence, remediation classification, and
sensitive-field absence. Negative fixtures must reject `something went wrong`, empty
bullets/details, silent catches, uncataloged codes, no operator clue, absent/untraceable
IDs, broken artifact links, and a user message copied from operator diagnostics. An
unknown exception may render a bounded client message, but the operator event still names
the boundary/phase, unique trace handle, containment result, and sanitized evidence.

## Silent Failure, Degraded Mode, and Misleading Success Review

Maintain `artifacts/silent_failure_matrix.md` for every task and final integration run.
Each row records the silent-failure mode, falsifiable trigger, injected or replayed
fixture, detection seam, required event/reason code, freshness/correlation fields,
operator audit or alert disposition, anti-success rule, exact validation command,
artifact, owner, and verdict. Absence of an expected failure signal is not proof of
health. An unenumerated silent-failure path found by source trace is a blocking matrix row
until it has deterministic detection and containment.

| Silent failure mode | Required detection and telemetry proof | Alert/audit trail | Rule preventing false success |
|---|---|---|---|
| Swallowed exception | Inject failures at parser, finalizer, persistence, reconciler, attestor, normalizer, health serializer, and outbound boundaries; require a terminal typed result plus correlated error/change event and cleanup state | Stable reason code, trace/run ID, owning boundary, exception class, safe context, and evidence path in the append-only manifest/operator audit | A caught exception without rethrow/typed result, cleanup proof, and terminal event is `Fail`; unknown never maps to aligned, hardened, delivered, or complete |
| No-op fallback | Counterfactual route selection must prove the admitted manager/provider/profile changed, or prove primary deliberately remained selected; compare desired/observed route and child generation | Route-decision and reconciliation events, manager-retirement receipt, pending marker, and provider-status mismatch audit | A fallback/revert text notice, window toggle, or zero exit without observed route/manager transition is `Inconclusive`; tool-dead or report-only OpenCode is never admitted |
| Partial success | Record phase ledger for edit-plus-bash canary, two-file normalization, manager drain/restart, migration/backfill, outbound diversion/handoff, and A-F parity | One terminal phase event links all subphase receipts; incomplete phases emit partial/rollback/quarantine audit with owner and recovery checkpoint | Any missing phase, mixed file state, edit-only canary, undelivered handoff, or incomplete parity row keeps eligibility/hardening/completion false |
| Stale or cached success | Recompute and compare Git SHA, binary/profile/policy/route/config/settings/plugin-role fingerprints, runtime generation, `checkedAt`, `expiresAt`, and evidence digest at each admission/poll | Cache-hit/invalidation events name prior and current identity plus invalidation reason; parity downgrade is audited | Fingerprint change, TTL expiry, old runtime generation, prior-SHA evidence, or missing fresh-session receipt invalidates success immediately; stale green cannot be grandfathered |
| Dropped async work | Use deterministic barriers and fake clocks around child stdout/close, queue admission, deferred reconciliation, health polling, service restart/postflight, and outbound delivery acknowledgements; assert settled ownership/task counts | Start/settle/cancel events share operation ID; shutdown records drain/cancel result and remaining process/task census | Fire-and-forget work without owned promise/task, deadline, cancellation, terminal event, and settlement assertion is `Fail`; process exit before stream close is not completion |
| Mismatched health signal | Generate counterfactual provider-status/parity rows where process liveness is green but route, profile, policy, role/plugin, capability, generation, or receipt differs | Health snapshot and parity decision expose requested/observed fields, source timestamps, schema version, reason code, and downgrade audit | Aggregate health cannot be `healthy`/`hardened` when any required A-F or role/transaction/postflight field is missing, stale, unknown, or mismatched |
| Missing alert | Delete/suppress each mandatory event in telemetry-coverage tests and exercise critical reason codes with the external channel disabled | CI guard proves event-to-audit mapping; production alert configuration records `disabled_pending_authorization`, owner, intended severity/dedupe key, and last audit poll | This plan does not enable external alerts, but a missing local audit event/coverage row is `Fail`; disabled delivery remains an explicit rollout risk and cannot count as monitored |
| Success without validation | Mutation/counterfactual controls deliberately break each invariant; manifest verifier compares expected assertion count, raw output, final SHA, runtime fingerprint, and artifact digest | Validation event and run manifest bind command, tool version, assertions, exit, evidence, reviewer, and verdict | Zero exit, text-only `OK`, no-file/filter/skip, retry-masked result, narrative review, absent artifact, or unchecked worker claim is `Inconclusive`, never `Pass` |

The matrix must also trace degraded modes: primary-only service after fallback disablement,
report-only capability collection, quarantined resume, pending route reconciliation,
rollback to the prior runtime generation, and alert delivery disabled by policy. Every
degraded state has an explicit state name, entry reason, user-safe behavior, operator
visibility, allowed duration/checkpoint, recovery test, and exit event. It may preserve
service, but it cannot preserve a prior `aligned`, `hardened`, or fleet-complete verdict.

Task-level exit requires logger-spy coverage plus a negative control that removes the
mandatory signal or disables the invariant and observes failure. Final exit additionally
requires a telemetry coverage diff against the changed source, no unowned promises or
processes in the deterministic census, every degraded state resolved or explicitly
owned, and the matrix linked from `artifacts/run_manifest.json`. Because external alert
enablement is outside scope, missing delivery authorization remains visible as a fleet
readiness constraint; local health, audit, and guard evidence are still mandatory.

## Baseline and Setup

- [ ] Prove this plan is part of the reviewed branch history rather than only a local
  ignored file:

  ```bash
  git ls-files --error-unmatch \
    docs/superpowers/plans/2026-07-15-headless-fallback-runtime-alignment.md
  git check-ignore -v \
    docs/superpowers/plans/2026-07-15-headless-fallback-runtime-alignment.md || true
  ```

  Planning-time evidence found the target plan ignored by the broad
  `docs/superpowers/` rule and absent from `git ls-files`. Before production edits, the
  repository owner must deliberately track this exact reviewed file (via a narrowly
  reviewed ignore exception or an explicit tracked-file add), then re-run status and
  publication guards. Do not broaden `.gitignore` to admit private/local artifacts.

- [ ] Confirm the worktree is clean and on the implementation branch:

  ```bash
  git status --short --branch
  git log -2 --oneline
  ```

- [ ] Confirm pinned dependencies are present:

  ```bash
  bash scripts/run-with-pinned-npm.sh ci
  bash scripts/run-with-pinned-npm.sh --prefix console ci
  ```

- [ ] Re-run the focused existing seams before the first edit:

  ```bash
  bash scripts/run-with-pinned-npm.sh test -- \
    tests/runtimes/agent/primary-model-usability-adapters.test.ts \
    tests/runtimes/agent/opencode-child-env.test.ts \
    tests/runtimes/agent/providers/opencode-parser.test.ts \
    tests/core/session-lifecycle-store.test.ts \
    tests/runtimes/agent/provider-fallback.test.ts \
    --pool=forks
  ```

  Expected: exit 0. A failure here is a new baseline blocker and must be diagnosed before implementation.

## Primary Validation Gate

Complete this gate after baseline setup and before Task 1 production edits. Write
`artifacts/primary_validation.md` with one row per question containing: validation
question, evidence reviewed, finding, severity, affected sections, required fix, status,
and final verdict.

| Check | Exact method | Expected result and verdict threshold | Artifact |
|---|---|---|---|
| Repository and runtime identity | `git rev-parse --show-toplevel && git status --short --branch && bash scripts/run-with-pinned-npm.sh exec -- node --version` | Root is this worktree, intended branch is checked out, and Node is 24.15.x; mismatch is `Blocked` | `artifacts/primary/repo-runtime.txt` |
| Baseline seams | Run the focused command in **Baseline and Setup** through `scripts/run-with-pinned-npm.sh` | All named files execute and exit 0; no-file, filtered, skipped, or masked execution is `Inconclusive`; any assertion failure is `Fail` | `artifacts/primary/focused-baseline.txt` |
| Ambient-runtime trap | Never use bare `npm test` as evidence. Confirm the pinned wrapper on `tests/scripts/run-with-pinned-node-symlink-entrypoint.test.ts` | Both wrapper-entrypoint assertions pass; ambient-only output is non-pass | `artifacts/primary/pinned-entrypoint.txt` |
| Contract and config seams | Inspect `src/config.ts`, `src/core/agent-config-validator.ts`, `src/core/provider-mcp-config.ts`, and OpenCode argv/env builders | One canonical profile field and one credential resolver are identified; an untraced alternate source is `Blocked` | `artifacts/primary/config-flow.txt` |
| Persistence identity | Trace every `agent_sessions` and checkpoint query/update plus all resume call sites | Every provider-blind production seam is listed for Task 6; a missed resume path is `Fail` | `artifacts/primary/resume-flow.txt` |
| Queue and lifecycle coupling | Trace shared, single, and per-chat admission plus spawn-per-turn `exit`/`close` ownership | Task 3 precedes route reconciliation where lifecycle semantics overlap; Task 7 covers all three admission modes | `artifacts/primary/queue-lifecycle.txt` |
| Error and redaction flow | Trace OpenCode failed-tool event through parser, classifier, outbound renderer, safety/redaction, and admin handoff | Empty detail and pasteable-placeholder paths have named failing tests; an untraced renderer is `Fail` | `artifacts/primary/error-flow.txt` |
| Fallback and rollback reality | Inspect eligibility, cache invalidation, report-only gate, fail-closed gate, and revert transition | Report-only emits evidence without admitting an unaligned lane; fail-closed admits only fresh `aligned`; rollback disables admission enforcement without deleting evidence | `artifacts/primary/fallback-rollback.txt` |

The validation artifact must answer these questions explicitly: which steps still depend
on unverified contracts; whether any precondition or dependency is missing; whether Task
3/4/5/7 runtime edits are falsely independent; whether any command can look green while
skipping assertions; whether fallback and rollback paths are executable; whether exit
conditions are measurable; and where an operator decision still lacks a recorded rule.
Hunt hidden coupling, circular dependencies, sequencing gaps, invisible manual work,
implied approvals, weak completion signals, partial-success traps, and silent failure.

Required dependency order is Task 1 before Tasks 5 and 8; Tasks 3 and 4 before Task 7;
Task 5 before Tasks 6-9; Task 6 before any provider-scoped resume claim; Tasks 7 and 8
before Task 9; and Tasks 1-10 before Task 11. Task 2 and Task 10 may be implemented in
parallel only with disjoint file ownership. Any newly discovered overlapping write seam
serializes the affected tasks and is recorded in `artifacts/primary_validation.md`.

Primary validation is `Pass` only when every table row has current evidence and no open
critical/high finding. It is `Fail` when evidence disproves a required contract,
`Inconclusive` when the check ran but cannot decide the claim, and `Blocked` when a
required prerequisite is absent. Do not begin the dependent production task until its
finding is resolved or constrained by an explicit fail-closed behavior.

## Layered Validation Escalation

Primary tests prove the intended path. Secondary validation is mandatory for every
production task and must use a different method against a different failure class.
Tertiary validation is mandatory for provider/credential boundaries, persistence and
migrations, process ownership, concurrency, fail-closed admission, client/operator
redaction, fleet hardening state, and role-scoped provider hooks.

| Trigger | Required independent method | Failure class targeted | Artifact |
|---|---|---|---|
| Any production behavior change | Secondary source-trace plus edge-case or contract re-check by an owner other than the implementer | Missed caller, stale contract, or falsely independent task | `artifacts/validation_layer2.md` |
| Task 1 profile/credential changes | Secondary argv/env matrix; tertiary representative disposable child with sanitized observed argv/env identity | Ambient default-agent use or credential bleed | `artifacts/layer3/task-01-child.txt` |
| Tasks 3-4 process/recovery changes | Secondary ownership-state review; tertiary event-order fault injection and recovery replay | Late-output loss, double finalization, stale generation, unsafe auto-resume | `artifacts/layer3/tasks-03-04-replay.txt` |
| Tasks 5-7 route/persistence changes | Secondary query/caller trace; tertiary counterfactual mixed-provider token fixtures, migration replay, and mid-turn route-change barrier | Cross-route mutation/resume, ambiguous backfill, overlapping turns | `artifacts/layer3/tasks-05-07-identity.txt` |
| Task 8 capability admission | Secondary static policy/runtime contradiction search; tertiary malformed/stale/timeout/auto-reject fault injection plus disposable edit-and-shell canary | Text-only false green, cached drift, unreaped process, headless prompt | `artifacts/layer3/task-08-capability.txt` |
| Task 9 health/parity and role-hook alignment | Secondary public-consumer/redaction review; tertiary counterfactual parity rows and requested-versus-observed runtime/profile/policy/plugin-role mismatch tests | Hardened false claim, private trust leakage, development-only hooks on an ops bot | `artifacts/layer3/task-09-parity.txt` |
| Task 10 outbound safety | Secondary message-flow trace; tertiary adversarial command/redaction corpus | Pasteable placeholder, leaked path, or missing operator handoff | `artifacts/layer3/task-10-redaction.txt` |
| Final integrated branch | Secondary independent requirements review; tertiary independent reproduction of focused suites, migration, full test lane, and guards from the final SHA | Reviewer echo, stale evidence, or integration-only regression | `artifacts/validation_layer3.md` |

Each layer artifact records: validation layer, invocation reason, methods, exact commands,
evidence reviewed, findings with severity, disposition, residual risk, and final verdict.
Repeating the primary test or paraphrasing the same code review does not satisfy another
layer. Adversarial review, edge-case review, failure-mode analysis, dependency inversion
review, contract re-check, representative dry run, contradiction search, independent
reproduction, replay validation, fault injection, and counterfactual testing count only
when the artifact states the distinct hypothesis they attempted to falsify.

A skipped mandatory layer is `Blocked`. An unavailable optional tool may be replaced by
an equivalent method only when the artifact explains equivalence; otherwise the affected
claim is `Inconclusive`. A live fleet canary may be intentionally deferred until after
source exit, but its residual risk must remain in `artifacts/validation_layer3.md` and
fleet readiness stays `Not Ready`: evidence is `Blocked` while its safe prerequisite or
authorization is missing, then `Inconclusive` if the valid live check is merely pending.
No critical/high finding may be deferred across the
dependent task's commit or converted to an accepted exception without named owner,
expiry, rollback trigger, and decision authority.

## Logging, Observability, and Replay Contract

Runtime events use the existing structured Pino path; implementation evidence uses
newline-delimited structured JSON under `artifacts/`. Every event has
`telemetry_schema_version`, `timestamp_utc`, service/environment, event/action,
`run_id`, a per-turn or per-operation `trace_id`, `span_id` when tracing exists, actor
type (`runtime`, `provider-child`, `operator`, `guard`, or `qfleet`), result verdict,
reason code, redacted requested/observed identity, and evidence references. Never emit
provider session tokens, chat/prompt contents, credentials, raw permission payloads,
private host identity, absolute private paths, or project-trust paths/state. Project
trust evidence belongs only in the private qFleet deployment record.

| Layer | Purpose and minimum fields | Required actor/correlation | Storage and replay use |
|---|---|---|---|
| Input | Record config/turn admission with config fingerprint, requested provider/model/profile/policy/plugin role, and source config generation | runtime; `run_id`, `trace_id`, route fingerprint | Pino plus `artifacts/telemetry/input.jsonl`; reconstruct desired state without message content |
| Decision | Record fallback eligibility, resume accept/quarantine, route reconciliation, capability cache use/invalidation, and parity classification with old/new state and reason code | runtime or guard; route and policy fingerprints | Pino plus task evidence; replay state-machine decisions from sanitized inputs |
| Execution | Record provider child spawn/close/timeout/reap generation, sanitized argv identity, canary phase, and duration; never raw env | runtime/provider-child; `trace_id`, child generation, runtime fingerprint | Pino plus watchdog/canary artifacts; reconstruct process ownership and late output |
| Validation | Record test/guard/attestation name, Git SHA, tool version, assertion count, artifact path, and verdict | guard or qFleet; `run_id`, route/policy/runtime fingerprints | `artifacts/run_manifest.json` and validation JSONL; reject masked or stale proof |
| Output | Record tool-result classification, non-empty fallback substitution, outbound diversion, audience (`client` or `operator`), and redaction reason | runtime; `trace_id`, safe message/event ID | Pino plus redaction fixtures; prove which safe renderer handled the event |
| Change | Record config generation, fallback/revert transition, migration, enforcement-mode change, requested plugin-role change, and rollback with before/after fingerprints | runtime/operator; `run_id`, change ID | audit log plus deployment packet; attribute confidence-affecting state changes |
| Audit | Record readiness/parity verdict, exception owner/expiry, review decision, evidence-set digest, and rollout/rollback authorization | guard/operator/qFleet; audit ID and evidence digest | append-only run manifest/private qFleet record; reproduce the final claim and authority |

Representative event shape:

```json
{
  "telemetry_schema_version": 1,
  "timestamp_utc": "2026-07-15T00:00:00Z",
  "run_id": "20260715T000000Z-abc123",
  "service": "whatsoup-agent",
  "env": "dev|ci|staging|prod",
  "trace_id": "redacted-correlation-id",
  "span_id": "present-only-when-tracing-exists",
  "event": "input|decision|execution|validation|output|change|audit",
  "action": "route-admission|resume|attest|reconcile|render|parity",
  "actor": "runtime|provider-child|operator|guard|qfleet",
  "result": "Pass|Fail|Inconclusive|Blocked",
  "reason_code": "stable_machine_readable_code",
  "identity": {
    "route_fingerprint": "sha256:redacted-example",
    "requested_profile": "whatsoup-headless",
    "observed_profile": "whatsoup-headless",
    "requested_plugin_role": "operational",
    "observed_plugin_role": "operational"
  },
  "evidence": { "artifact_paths": ["artifacts/run_manifest.json"] },
  "error": { "type": "", "safe_message": "" }
}
```

The following must never be silent: unsupported runtime/profile, missing credential
mapping, provider/route resume mismatch, ambiguous migration row, deferred or failed
reconciliation, child timeout/reap/stale generation, capability non-`aligned` state or
cache invalidation, report-only/fail-closed mode change, desired/observed plugin-role
mismatch, development-only hook observed on an operational bot, parity downgrade,
outbound command diversion, empty-detail substitution, masked/skipped evidence, and
rollback. Operator exceptions, hardened classification, alert suppression, policy/profile
changes, and evidence replacement require an audit event with owner and authority.

Logger-spy tests must assert event presence, stable reason code, correlation propagation,
requested/observed separation, and sensitive-field absence for every mandatory event.
Task 9 adds a telemetry-coverage matrix to the parity guard; deleting an event or its test
fails CI. Retain run manifests, validation outputs, replay fixtures, and evidence digests
through source review, canary, fleet normalization, and the deployment owner's documented
rollback window. If no retention owner/window or replayable evidence set exists, rollout
readiness is `Blocked`.

## Execution Readiness Gate

Use three independent gates: source implementation start, source exit, and fleet rollout.
Each writes `artifacts/readiness.json` with `gate_type`, `readiness_state`, `date`,
`evidence_reviewed`, `open_risks`, `blockers`, `decision_rationale`,
`decision_authority`, and `next_allowed_action`.

| State | Evidence threshold | Allowed follow-on action |
|---|---|---|
| `Ready` | Every applicable check below is current `Pass`; no blocker or unowned residual risk exists | Perform only the action named in the record |
| `Ready with Constraints` | No blocker prevents the named next action; all open risks are bounded by fail-closed behavior, owner, due checkpoint, and evidence path | Perform the bounded next action; do not cross the constrained checkpoint |
| `Not Ready` | Any required evidence is missing/inconclusive, any critical contract is disproved, or a blocker is open | Investigate or remediate only; no dependent implementation, merge, or rollout |

| Mandatory check | Evidence required |
|---|---|
| Stable objective and bounded scope | Objective/scope section plus `artifacts/changed_files.txt` and public-surface trace |
| Audited assumptions and critical dispositions | Assumption Audit; A01-A13 each have owner, due gate, validation, and fail-closed disposition |
| Known dependency order and real execution seams | `artifacts/primary_validation.md`, config/resume/queue/error traces, and task dependency order |
| Verified contracts | Validator/config writer tests, migration/query tests, provider argv/event fixtures, health/public-surface tests |
| Molecular tasks and explicit verification | Every task has input/precondition, one behavior change, red/green command, evidence path, rollback/containment, and owner |
| Observability and measurable signals | Mandatory event catalog, logger-spy coverage, S1-S6 success thresholds, and explicit failure conditions |
| Provider role/hook alignment | Explicit `agentOptions.providerRole: operational|development`, role-owned `enabledPlugins` policy, effective root/per-chat workspace settings, and transactional normalization evidence; `bash scripts/run-with-pinned-npm.sh run audit:instance-plugins -- --json --fail-on-gap` plus tests prove requested/observed role/plugin coverage. Operational bots explicitly disable test-integrity, carry no `pluginDirs`, and exclude test-authoring hooks. |
| Rollback/containment | OpenCode fallback kill switch, manager retirement, additive-schema retention, and no provider-blind code rollback |
| Ownership and residual risk | Repository owner decides source gates; fleet owner decides qFleet rollout; every risk has owner, expiry/checkpoint, and artifact |

Block source-task readiness on a wrong repo/runtime, failed pinned baseline, unobserved red
test, unresolved critical prerequisite without fail-closed containment, hidden overlapping
write ownership, missing required validation layer, unsafe evidence/logging, or an
unverified new dependency without a named SCA mechanism. Missing root `CODEOWNERS` is
recorded but is not by itself a blocker when the repository owner is the explicit review
authority. CI workflow discovery does not prove a check actually ran; only captured run
evidence does.

The current source-start decision is `Ready with Constraints`: the objective, scope,
source seams, dependency order, failure thresholds, and containment are explicit;
installed OpenCode policy-inspection compatibility and qFleet contracts remain unresolved
but are excluded from `aligned` and fleet-complete states. The next allowed action is to
track this currently ignored plan without widening private-artifact publication, then run
the pinned baseline and Task 1 red phase. Source exit is `Not Ready` until Tasks 1-11 and all
layered checks pass. Fleet rollout is `Not Ready` until the source exit packet, private
project-trust inventory, requested/observed provider role/plugin evidence, runtime/policy
inventory, canary, retention window, and rollback authority are current for every
in-scope mini.

Readiness is deliberately not another evidence verdict. Each readiness record must cite
the underlying four-valued verdicts and may never translate `Inconclusive` or `Blocked`
into `Ready`; `Not Ready` is the only readiness state compatible with either verdict at
the dependent checkpoint.

## Master Orchestration Contract

One lead owns orchestration, integration, permission boundaries, the manifest, readiness
decisions, and final claims. Packet owners own only the paths and evidence assigned in
A00-A29. They may not broaden scope, mutate fleet state, waive a gate, or mark another
packet complete. The lead records the following for every dispatch in
`artifacts/orchestration/task-ledger.jsonl`: packet/dedupe ID, owner, allowed paths,
predecessor evidence, expected output, validation command, lease/timeout, current state,
artifact paths, and terminal verdict.

Use these orchestration states: `pending`, `ready`, `running`, `review`, `passed`,
`failed`, `inconclusive`, and `blocked`. A packet becomes `ready` only when every named
predecessor has current final-SHA evidence and its owner/write scope does not overlap a
running packet. No quiet or slow packet may be duplicated before its lease expires and a
terminal status is recorded. A replacement owner starts from the last checked artifact,
not an assumed partial implementation.

The lead advances work through these ordered checkpoints:

1. prove repository/runtime identity and pinned baseline (A00);
2. characterize external interfaces before dependent red tests (A01, A19);
3. complete failing tests, implementation, and focused proof for A02-A26 according to
   their dependency edges, serializing all edits to `runtime.ts`, `session.ts`, config,
   health, migration, and outbound-message seams;
4. integrate on one SHA and run A27; repair the owning packet and invalidate affected
   downstream evidence on any failure;
5. obtain independently reproduced A28 review evidence;
6. validate but do not execute the A29 qFleet packet; fleet mutation requires a new,
   explicitly authorized deployment run.

At each checkpoint, the lead verifies artifact existence, SHA/runtime fingerprints,
assertion counts, verdict thresholds, and sensitive-data exclusions before accepting a
worker result. Progress-only, malformed, stale, masked, or narrative-only output is
`Inconclusive`. Conflicting results stop the dependent lane and trigger a different
validation method; they are never resolved by majority vote. A critical/high failure,
unreaped child, unexplained write, credential exposure, provider-blind resume path,
permissive capability fallback, or operational bot with a development-only hook stops
all affected packets and invokes the documented containment.

Parallel execution is allowed only for independent packets with disjoint write sets and
no shared mutable fixture/database. Task 2 and Task 10 are eligible only after the lead
proves their renderer ownership is disjoint; Tasks 3-9 are serialized at their shared
runtime/config/database seams. The lead re-runs the integration proof after every merge
of parallel results. Repository owners decide source exceptions; the fleet owner decides
rollout/rollback; neither authority may infer installed fleet state from source evidence.

## Tooling and Execution-Orchestration Plan

Maintain `artifacts/tooling_plan.md` from execution preflight through final integration.
It maps A00-A29 to required/optional tool and version, skill/plugin/MCP, lane and owner,
allowed reads/writes, dependency/lease, evidence output, validator, and terminal status.
Requested and observed runtime/tool configuration are recorded separately; a role name,
plugin presence, or configured model is not evidence of actual capability.

### Capability inventory and historical context

At A00, inventory the implementation session rather than inheriting this planning
session's tool claims. Write `artifacts/capabilities/inventory.json` with capability
class, requested/configured state, observed executable or catalog identity, version,
relevant feature probe, authority, allowed write scope, evidence path, and verdict. Save
the complete redacted skill, script, agent/role, plugin, MCP, and browser/runtime catalogs
under `artifacts/capabilities/`; never copy connector tokens, environment values, private
paths, or raw MCP configuration into evidence. A configured name without a successful
catalog/help/canary observation is `Inconclusive`.

| Capability class | Planning-time availability and relevance | Required use | Evidence and ownership/write scope |
|---|---|---|---|
| Local core tools | Git, Bash, `rg`, `apply_patch`, Python 3, checksums, and the repository's pinned Node/npm wrapper are available/relevant; SQLite, TypeScript, Zod, Vitest, and Pino are repository dependencies, not ambient assumptions. | Discovery, narrowly scoped edits, canonical diffs/digests, schema replay, focused/full tests, and manifest validation. Use the pinned wrapper for every Node/npm proof. | `artifacts/capabilities/core-tools.json` records executable/version/help receipts. Lead owns manifest/Git integration; packet owners write only declared files and task-local artifacts. |
| Repository scripts and guards | `package.json` currently exposes `test`, `typecheck:all`, `typecheck:scripts`, `audit:instance-plugins`, `guard:lint:src`, boundary/config/source-runtime/fail-closed/fleet-parity/doc/publication guards, `verify:push:branch`, and browser/console checks. Re-inventory because scripts can drift. | Use exact focused commands during packets and the canonical A27 sequence; never replace a required script with a hand-written approximation or ambient `npm`. | Capture the complete script map and script-file digests in `artifacts/capabilities/repository-scripts.json`; A00 lead inventories, affected packet owner runs, A27 lead reruns. |
| Skills | Relevant installed catalogs currently include systematic debugging, TDD, hypothesis-driven investigation, progressive disclosure, fail-closed gate writing, subagent-driven development, verification-before-completion, and code-review skills. `sdlc-os`/tmup are optional high-assurance orchestration surfaces. | Read the selected skill instructions before use and record why they apply. TDD is mandatory for implementation-facing packets; deterministic verification is mandatory before any correctness claim. | `artifacts/capabilities/skills.json` records complete catalog plus selected skill path/version/digest and invocation owner. Skills grant no extra mutation authority. |
| Agents and subagent roles | One lead, bounded packet owners A00-A29, read-only scouts, and two independent final reviewers are relevant. Native sidecars, isolated process lanes, or tmup may be available only after their live catalog/contract preflight. | Use subagent-driven development only for dependency-independent packets with self-contained contracts. Effective parallelism requires disjoint writes/state, one owner/dedupe key, leases, stop conditions, and lead integration; Tasks 3-9 remain serialized. | `artifacts/capabilities/agents.json` plus the orchestration ledger record requested and observed runtime/model/tool profile separately. Subagents cannot expand scope, mutate fleet/external state, delegate further, or write shared plan/readiness/manifest files. |
| Plugins and hooks | Repository Husky/CI hooks are present; test-integrity is relevant only in development/test-authoring lanes; optional `sdlc-os` is reachable only through a proven tmup contract. Provider-role plugins/hooks are target runtime state, not implementation authority. | Use development plugins for test quality while proving operational roles exclude test-authoring hooks. Treat hook/plugin configuration as non-proof until resolved effective state and canaries are captured. | `artifacts/capabilities/plugins.json`, hook receipts, and Task 9 evidence record manifest/digest/effective state. No plugin may bypass repository, permission, or fleet gates. |
| MCPs and connectors | The configured topology may offer Playwright, Sentry, Render, Pinecone, GitHub, WhatsApp, and qFleet-related surfaces; the detailed applicability table below is authoritative. Availability and auth must be observed per session. | Use only the named read-only/local-fixture purpose. MCPs are optional unless a packet is amended to require one; no vague “use later” placeholder counts as a validation method. | `artifacts/capabilities/mcps.json` records server/tool names, capability probe, authorization class, request/receipt ID, and redacted result digest. External writes, messages, issues, PR actions, deployments, and alert enablement remain forbidden here. |
| Browser and UI tools | Playwright/browser Vitest and console lint/build are relevant only if the changed health/public contract has a console/browser consumer. | Run deterministic local DOM/schema assertions and browser checks when the changed-file/consumer trace says applicable; screenshots alone are not proof. | `artifacts/capabilities/browser.json` and `artifacts/tooling/playwright.json`; console/API owner may write only its packet files and disposable local output. |
| Runtime and DevOps surfaces | Pinned Node 24.15.x, local disposable provider children, service-manager abstractions, and fault-injected qFleet packet validation are relevant. Live qFleet, launchd, Keychain/TCC, restart, and host state require separate fleet authority and same-service-context observation. | Exercise injected/local runtime seams for source proof; validate but do not execute deployment. Missing qFleet or service-context access blocks only the dependent fleet checkpoint. | `artifacts/capabilities/runtime-devops.json`, Task 8 canary records, and deployment packet/private receipt references. Lead owns local source checks; fleet owner alone owns later host mutation. |
| Historical Pinecone context | The `pinecone-search` skill or configured read-only Pinecone MCP is optional and must be live-probed; no namespace, index, or record is assumed. | Search for prior q-pi/headless permission, fallback, resume, and fleet-alignment decisions only as hypothesis/reuse context; verify every decisive claim against current source, Git, or runtime evidence. | `artifacts/history/pinecone.json` records query, index/namespace when disclosed, returned record IDs/scores, dates, sanitization, and source-verification disposition. No indexing/write is allowed. |
| Git, prior plans, and prior-run artifacts | Git history, the preserved cleanup worktree/commits in A11, `docs/superpowers/plans/`, runbooks, and any readable prior artifact manifest are available historical paths subject to freshness checks. | Use `git log --all`, `git show`, `git blame`, `git range-diff`, `git cherry -v`, focused `rg`, and manifest/digest comparison. Prior artifacts locate candidates but never prove the current SHA/runtime. | `artifacts/history/git.txt` and `artifacts/history/prior-artifacts.md`; history scouts are read-only, and the lead verifies selected source/diff before reuse. Never delete a supposedly superseded branch without range-diff/cherry evidence. |

The inventory must explicitly map every invoked capability to a task and artifact; hidden
tool calls, unrecorded fallback tools, vague future MCP use, unbounded workers, duplicate
quiet-worker tasks, and parallel mutation of shared files/state are `Fail`. A capability
missing from the live catalog is `Blocked` only when the next required check cannot be
safely performed; optional historical/browser/MCP absence is `Inconclusive` or
`not applicable` for its narrow claim and cannot be counted as coverage.

Subagent output stays advisory until the lead checks the decisive diff/test/log/receipt.
Implementation-facing changes always follow observed red, green, and refactor evidence;
all meaningful correctness claims use fixed inputs/clocks/seeds, bounded processes,
explicit assertion/population counts, complete output, and final-SHA binding. Live
provider/network/fleet observations that cannot be made deterministic remain explicitly
`Inconclusive` or `Blocked`, never narrative `Pass`. Roll the inventory and historical
context disposition into `artifacts/capability_inventory.md` and the final
`artifacts/final_review.md`.

### Required tools

- Git, Bash, `rg`, `apply_patch`, Python 3 for evidence/contract helpers, and the
  repository-pinned Node 24.15/npm lane are required. Vitest, TypeScript, SQLite test
  helpers, Zod/config tests, publication/drift guards, and console dependencies are used
  only through `bash scripts/run-with-pinned-npm.sh`. Capture executable path, version,
  help/feature probe, and exit status before relying on a tool.
- Use `rg`/compiler/test traces for discovery, Git diff/history for provenance, and
  checksums/canonical JSON for comparison. `jq` or another optional formatter may aid
  inspection but cannot be a hidden prerequisite; record `not installed` and use a
  deterministic repository/Python equivalent.
- No bare ambient `npm`, unbounded child process, ad hoc remote shell, direct qFleet host
  write, GUI-only evidence, or command whose failure is piped/masked may establish a
  result. Every long-running subprocess has an external owner/watchdog and process-group
  reap evidence.

### Required skills

- Claude realm: use `superpowers:systematic-debugging` for reproduced defects,
  `superpowers:test-driven-development` before production changes,
  `superpowers:subagent-driven-development` only for bounded packets below, and
  `superpowers:verification-before-completion` before commit/handoff. Use the installed
  test-integrity skill only in development/test-authoring lanes, never in the operational
  bot runtime being normalized. If high-assurance `sdlc-os` is selected, record its
  workflow/run IDs and evidence; its recommendations do not waive this plan's gates.
- Codex realm: use `systematic-debugging`, `test-driven-development`,
  `hypothesis-driven`, `progressive-disclosure-coding` for large runtime/config traces,
  `writing-fail-closed-gates` for readiness/health guards, and
  `verification-before-completion` plus `requesting-code-review` for integration. Use
  `using-git-worktrees` when a write lane needs isolation. Read the installed skill file
  and record its version/path before relying on it; unavailable optional skills are
  `not installed`, not silently emulated.
- `tmup` is optional for a deliberately separate Claude/Codex runtime or independent
  final reviewer. Before use, prove its current task-DAG/runtime contract and send a
  self-contained packet; Codex process lanes additionally require the current local
  orchestration README/schema/validator. A missing or unverified contract makes that lane
  unavailable and does not block lead-only execution.

### Relevant MCPs and plugins

| Surface | Applicability and permitted use | Prohibited inference or mutation | Evidence |
|---|---|---|---|
| Playwright | Optional only if Task 9B changes a console/browser health consumer; exercise a local disposable build with deterministic screenshots/DOM assertions | No production login, messaging, or screenshot-only pass; not applicable when no UI consumer changes | `artifacts/tooling/playwright.json` or `not_applicable` |
| Sentry | Optional read-only incident/error-schema correlation when configured and authorized | No issue mutation, alert enablement, or claim that absence of events proves health | `artifacts/tooling/sentry.json` or `not installed` |
| Render | Optional read-only service/runtime metadata for a separately authorized deployment-readiness cross-check after source exit | No deploy/restart/env mutation; source tests cannot prove installed Render state | `artifacts/tooling/render.json` or `not_applicable` |
| Pinecone | Optional read-only historical/reuse search; cite retrieved record IDs and verify every decisive claim against current source/Git | No indexing/write and no treatment of semantic recall as current truth | `artifacts/tooling/pinecone.json` or `not installed` |
| GitHub/PR tooling | Optional read-only history, CI, and independent-review context after local proof | No issue/comment/review/merge/workflow rerun or repository write without separate explicit authorization | `artifacts/tooling/github.json` or `not installed` |
| WhatsApp/WhatSoup transport | Not applicable to source execution; client/admin message behavior uses local fixtures | Never send a live message or use a client thread as a test surface | `artifacts/tooling/transport.json` with `not_applicable` |
| qFleet | External deployment-owner interface used only to validate the Task 11 packet in this plan | No host mutation; no invented command or direct file write; generic PATCH is not Task 9A normalization | `artifacts/deployment/qfleet-contract.json` |

Claude/Codex plugins and MCPs are optional accelerators unless a packet explicitly names
them as required after preflight. Their output is advisory until the lead verifies the
decisive source, diff, state, or test locally. Connector credentials and raw responses
never enter artifacts.

### Subagent lanes

- A00/A27/A29, manifest/readiness decisions, shared `runtime.ts`/config/database
  integration, and final claims stay lead-owned. Tasks 3-9 remain serialized because
  their write/coupling graph overlaps.
- Task 2 and Task 10 may run in parallel only after a read-only trace proves distinct
  renderer/admin files and fixtures. If either needs the same file, event shape, or test
  fixture, the lead serializes them. A docs-only lane may follow a settled API contract
  but cannot edit the plan, manifest, public-surface registry, or code owned by another
  lane.
- Independent requirements and code-quality reviewers are read-only lanes after A27 and
  use distinct methods. A source/history/reuse scout may run read-only in parallel with
  another scout. No leaf worker delegates further, no task is duplicated before a
  terminal failure/expired lease, and effective parallelism is claimed only when lanes
  are dependency-independent with disjoint writes and disposable state.

### Ownership and write scope

Every dispatch packet names one dedupe ID and owner; baseline SHA; bounded inputs;
allowed read paths; exact allowed write paths; forbidden fleet/external mutations; tool
surface; predecessor artifacts; acceptance command/assertion count; timeout/stop
conditions; rollback; and result schema. Use an isolated worktree for concurrent writers
and per-lane temp/database/artifact directories. The lead alone integrates commits and
writes shared readiness/manifest/final-review records. Workers stop on an unexpected
dirty/overlapping path, contract mismatch, missing authority, or out-of-scope dependency;
they do not clean, reset, overwrite, or opportunistically fix another lane.

### Evidence outputs

Each lane returns status/verdict, sources and files inspected, files changed, diff/commit
identity, commands and raw outputs, assertion counts, tool/runtime receipts, provenance
and replay paths, confidence, unresolved risks, and claims needing lead verification.
Store worker records under `artifacts/orchestration/<packet-id>/`; the lead checks their
digests before adding manifest entries. Progress-only, malformed, stale, masked,
narrative-only, or missing output is `Inconclusive` and cannot release a dependent lane.

### Deterministic validation safeguards

All lanes start from the recorded baseline/predecessor SHA and lockfile digests, use the
pinned wrapper, fixed seed/clock/locale/timezone, disposable isolated state, canonical
output, explicit assertions, and packet-specific evidence paths. Workers may not share a
mutable database, service, fixture directory, cache-success record, or artifact file.
After integration the lead discards lane-local green as release proof and reruns affected
focused tests, contradiction/replay checks, typecheck/guards, full unmasked suite, and
push gate on one final SHA. A merge conflict, order-dependent result, changed runtime,
stale fingerprint, or divergent worker receipt invalidates downstream evidence and
returns the owning packet to deterministic reproduction.

## Linting, Formatting, and Static Quality Gates

Maintain `artifacts/linting_plan.md` from A00 through A27. At A00, inspect the root and
console `package.json` scripts and whether `pyproject.toml` exists; record the result with
these repository-root preflight commands rather than assuming a toolchain:

```bash
printf 'Record lint and format commands in artifacts/linting_plan.md\n' | tee artifacts/linting_plan_note.txt
test -f package.json && printf 'Inspect package.json scripts for lint/format/typecheck\n' | tee artifacts/js_quality_note.txt || true
test -f pyproject.toml && printf 'Inspect pyproject.toml for lint/format/type-check tools\n' | tee artifacts/python_quality_note.txt || true
```

The current reconnaissance found root TypeScript/Vitest quality scripts, console ESLint
and build scripts, no root or console `format` script, and no root `pyproject.toml`.
Recheck at A00 because the branch may change. Do not invent or install a formatter in
this task. Preserve surrounding style, avoid bulk reformatting, and use Git's whitespace
check as the formatting gate. If a formatter is added upstream before execution, capture
its version/config and add its check-only command here before editing.

| Tool name | Command | Expected output | Blocking threshold | Artifact path | Owner |
|---|---|---|---|---|---|
| Toolchain inventory | `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts,null,2))"` plus the three preflight commands above | Root scripts captured; console scripts captured when `console/package.json` exists; Python toolchain recorded absent or inspected | Missing/unreadable applicable manifest is `Blocked`; an absent optional Python toolchain is `not applicable`, not a pass claim | `artifacts/quality/toolchain-inventory.txt` and the three note files | A00 lead |
| Git whitespace / formatting | `git diff --check` per packet and `git diff --check <baseline-sha>...HEAD` at A27 | Exit 0 with no output | Any whitespace error or conflict marker in the packet/final diff is `Fail`; no auto-fix or bulk-format waiver | `artifacts/quality/git-diff-check.txt` | packet owner; A27 lead |
| Root source lint fitness | `bash scripts/run-with-pinned-npm.sh run guard:lint:src` | Exit 0; no lint error or new warning in changed source | Nonzero, truncated output, or any diagnostic in changed code is `Fail`; an unchanged warning must retain owner/expiry and makes the affected claim `Inconclusive`, not clean | `artifacts/quality/root-lint.txt` | packet owner for source changes; A27 lead |
| Console ESLint | `bash scripts/run-with-pinned-npm.sh --prefix console run lint` when `console/` or a consumed API type changes | Exit 0 with zero errors and zero warnings in changed files | Any error/new warning, skipped applicable run, or missing config is `Fail`; otherwise record `not applicable` with the changed-file trace | `artifacts/quality/console-lint.txt` | console owner; A27 lead |
| TypeScript compile check | `bash scripts/run-with-pinned-npm.sh run typecheck:all` | Exit 0 with no TypeScript diagnostics | Any diagnostic, no-file/masked execution, or unknown pinned runtime is `Fail` or `Blocked` according to the evidence contract | `artifacts/quality/typecheck-all.txt` | packet owner after each compile-affecting packet; A27 lead |
| Script typecheck | `bash scripts/run-with-pinned-npm.sh run typecheck:scripts` when `scripts/` or its imported contracts change | Exit 0 with no diagnostics | Any diagnostic or skipped applicable run is `Fail`; otherwise record `not applicable` | `artifacts/quality/typecheck-scripts.txt` | script owner; A27 lead |
| Console compile/build | `bash scripts/run-with-pinned-npm.sh --prefix console run build` when console code or consumed health/public API types change | TypeScript project build and Vite build exit 0 | Any compile/build diagnostic, missing generated input, or skipped applicable run is `Fail`; otherwise record `not applicable` | `artifacts/quality/console-build.txt` | console/API owner; A27 lead |
| Import boundaries | `bash scripts/run-with-pinned-npm.sh run guard:boundaries` | Exit 0 with no forbidden dependency edge | Any forbidden edge or unavailable required guard is `Fail`/`Blocked`; warnings in changed edges block | `artifacts/quality/import-boundaries.txt` | architecture owner; A27 lead |
| Runtime/config/fleet static guards | Run `guard:source-runtime-drift`, `guard:instance-config`, `guard:fail-closed-gate`, and `guard:fleet-bot-hardening-parity` through the pinned wrapper | Every command exits 0 and reports its expected checked population/fixtures | Any nonzero, zero-population/masked result, stale fixture, or warning about a changed protected surface is non-pass | `artifacts/quality/runtime-static-guards.txt` | affected packet owner; A27 lead |
| Documentation/publication guards | Run `guard:doc-drift`, `guard:public-surface-drift`, and `guard:publication -- --all` through the pinned wrapper after contract/docs changes | Every command exits 0 and enumerates the applicable documents/surfaces | Any nonzero, unregistered public change, skipped applicable guard, or changed-file warning is `Fail`; otherwise record `not applicable` | `artifacts/quality/documentation-guards.txt` | docs/public-surface owner; A27 lead |

Capture each command, exact version, start/end time, exit code, complete stdout/stderr,
checked-file or population count where available, Git SHA, artifact digest, and verdict in
the run manifest. Tool-designated errors always block. A warning in changed code blocks;
an unchanged pre-existing warning needs an owner, expiry/checkpoint, and independent
confirmation and leaves the affected gate `Inconclusive`. Never silence, filter, pipe
away, auto-fix, or baseline a diagnostic merely to obtain zero exit. Run applicable fast
gates after each packet and all rows again on the integrated A27 SHA before full tests.

## Regression Protection and Change Safety

Maintain `artifacts/regression_protection.md` and immutable, run-scoped baselines under
`artifacts/regression/`. Before production edits, bind the baseline Git SHA, lockfile and
pinned-runtime digests, focused assertion counts/raw output, representative config and
health JSON, sanitized provider-event/error fixtures, database schema/migration replay,
and a process/manager census to the manifest. A historical count or snapshot from a
different SHA is comparison context only, never current baseline proof.

| Protected behavior | Protection mechanism | Regression signal | Evidence source | Rollback or mitigation trigger |
|---|---|---|---|---|
| Primary provider remains serviceable when OpenCode is absent, unsupported, or unaligned | Existing primary/fallback-chain suites plus counterfactual capability states; report-only before fail-closed | Primary is skipped/terminated, an ineligible fallback is admitted, or a turn is left without the existing safe path | `artifacts/regression/primary-fallback-baseline.txt`, Task 8 tests, route-decision events | Disable OpenCode admission immediately, retire its idle managers, preserve primary behavior, and revert the owning packet |
| Every OpenCode command keeps the selected route/model while gaining exactly one profile | Fresh/resumed/model-usability argv matrices and immutable-route equality tests | Missing/duplicate selector, ambient `default_agent`, static-agent model override, or requested/observed route mismatch | `artifacts/task-01/`, `artifacts/task-05/`, sanitized argv snapshots | Revert Tasks 1/5 integration; keep OpenCode ineligible until exact argv/route proof returns |
| Required service context survives while credential and mutation authority do not spread | Table-driven child-env allowlist cases for every supported model/custom service plus a disposable child receipt | Missing selected credential/required socket context, any second credential, secret-shaped unknown key, `SUDO_ASKPASS`, `ALLOW_M365_MUTATIONS`, `CLAUDE_CONFIG_DIR`, or mutation flag | `artifacts/regression/child-env-baseline.json`, Task 1 red/green and layer-3 child evidence | Block spawn before provider contact; restore the prior minimal known-good allowlist only if it still excludes privileged/superset keys |
| Spawn-per-turn output, budget, process-tree cleanup, and provider session continuity retain current semantics | Late-output ordering, idempotent finalizer, stale-generation, crash ownership, budget, and process census tests | Lost final stdout, duplicate finalization, non-null clean child, leaked process, changed budget settlement, or lost provider session ID | `artifacts/regression/process-lifecycle-baseline.txt`, Task 3 replay/census | Disable affected fallback, reap the owned generation, revert Task 3 packet, and never clear a newer child |
| Automatic resume safety remains fail-closed while provider/route scoping is added | Preserved-commit delta audit, startup/per-chat/crash/replay suites, mixed-provider collision fixtures | Fenced/inconclusive recovery auto-resumes, a token-only lookup returns, or another provider row changes | `artifacts/tasks-03-04/reuse-audit.txt`, `artifacts/tasks-05-07/identity.txt` | Quarantine the session, disable automatic continuation, roll forward exact-row schema, and revert only code that does not restore provider-blind behavior |
| Route changes apply between turns without killing or overlapping an admitted turn | Pure reconciler matrix and deterministic mid-turn barrier across shared/single/per-chat modes | Active manager is killed, two turns overlap, pending mismatch is lost, or next admission retains the stale route | `artifacts/regression/queue-baseline.txt`, Task 7 red/green and event replay | Disable fallback, drain the active owner, retire mismatched manager after settlement, and revert reconciler packet |
| Database startup/migration remains additive, idempotent, and ambiguity-safe | Pre/post schema snapshots, next-number check, migration replay, unique/ambiguous/unmatched fixtures, exact-row predicates | Schema collision, non-idempotent replay, guessed backfill, ambiguous row resumed, or wrong row updated | `artifacts/regression/schema-before.sql`, `artifacts/task-06/migration-replay.txt` | Stop startup/rollout, quarantine ambiguous rows, roll forward corrective migration; never drop new columns or redeploy token-only code |
| Failed-tool and outbound behavior stays compatible for other providers and ordinary prose | Cross-provider event fixtures, 100-character bound, empty-detail negative control, adversarial prose/command corpus, publication guard | Other provider shape changes, empty bullet, leaked path, pasteable `[internal-path]`, or ordinary explanation is wrongly diverted | `artifacts/regression/error-corpus-before.json`, Tasks 2/10 tests | Revert the owning renderer/safety packet, retain safe non-command fallback, and block client delivery of unsafe content |
| Existing config/settings writers preserve unrelated settings and plugin cohorts | Full round-trip snapshots; role-owned overlay/property tests; root and fresh per-chat equivalence; generic PATCH compatibility tests | Unknown field loss, unrelated plugin flip, `pluginDirs` on operational context, dev hook survives, or generic PATCH emits a normalization receipt | `artifacts/regression/config-roundtrip-before.json`, Task 9/9A tests | Reject CAS/write, restore both exact snapshots and modes, quarantine normalization on rollback ambiguity |
| Service-manager normalization is all-or-contained across both files and runtime generation | Per-instance lock, two-file fault injection at every phase, drain/restart/postflight receipt, idempotency replay | Mixed files, stale generation, unknown owner, duplicate-content conflict, failed restart/restore, or old-runtime health | `artifacts/task-09/normalizer-red.txt`, `normalizer-green.txt`, phase ledger | Roll back both byte/mode snapshots and prior generation; on unproved rollback stop the cohort and mark evidence `Blocked` |
| Health/provider-status remains additive, redacted, and unable to false-harden old consumers | Before/after schema snapshots, tolerant-consumer and exact redaction tests, counterfactual missing/stale A-F rows, public-surface guards | Consumer failure, sensitive/private field, missing field classified hardened, stale receipt accepted, or source proof labeled fleet proof | `artifacts/regression/health-before.json`, Task 9B parity/consumer evidence | Downgrade row immediately, stop rollout cohort, keep source/fleet gates separate, and revert additive consumer change if compatibility breaks |
| Repository-wide behavior and documented contracts remain intact | Per-packet focused suites/fast gates, then final-SHA full unmasked suite, push gate, independent reproduction, and contradiction check | Any new failure, changed assertion count without explanation, masked/skipped lane, static warning, doc/publication drift, or stale evidence | `artifacts/regression/full-baseline.txt`, `artifacts/quality/`, `artifacts/task-11/` | Stop integration, attribute failure to the first owning packet with a baseline-versus-current diff, repair/revert it, and rerun all invalidated downstream evidence |
| Installed fleet stays aligned after a separately authorized rollout | Staged cohorts, fresh runtime-generation/session receipts, finite capability TTL, desired/observed parity polling, drift reason codes, and rollback-window replay | Any host becomes stale/mismatched/non-hardened, new permission prompt appears, extra TCC grant appears, stale child persists, or mixed-lane count is nonzero | Private qFleet per-host before/after receipts and `artifacts/deployment/` packet digests | Halt the cohort, exclude OpenCode, retire mismatched managers, invoke Task 9A rollback/quarantine; fleet remains `Not Ready` until every host has fresh proof |

Every production packet must first demonstrate its named negative control against the
baseline, then make the same control pass without weakening assertions. After each
packet, rerun its focused baseline, applicable fast-quality rows, caller/consumer trace,
and affected replay package; invalidate all downstream artifacts when a shared seam,
runtime fingerprint, fixture, or assertion count changes. A regression is not waived
because the intended new test passes.

The deployment packet must carry the protected-behavior rows applicable after rollout,
cohort order and stop thresholds, polling/TTL window, before/after fingerprints, rollback
authority, and evidence-retention window. Post-rollout detection is a separately
authorized qFleet responsibility, not source-plan execution. Missing qFleet monitoring
or rollback evidence leaves fleet readiness `Not Ready`; source-green evidence cannot
substitute for installed-state observation.

## Hooks, Automation, and Workflow Enforcement

Maintain `artifacts/hook_plan.md`, `artifacts/automation/hook-receipts.jsonl`, and
`artifacts/automation/bypass-ledger.jsonl`. At A00 prove the selected `core.hooksPath`,
hook file hashes/executability, relevant package scripts, and CI workflow SHA. The
current worktree resolves hooks to `.husky`; recheck rather than assuming every clone or
worker installed them. A hook's presence is not evidence that it ran.

| Hook or automation name | Trigger point | Command or policy enforced | Blocking behavior | Override behavior | Evidence artifact |
|---|---|---|---|---|---|
| Husky pre-commit identity | Before local commit object creation | `.husky/check-commit-identity.sh` exact author/committer allowlist | Nonzero stops commit; no packet may claim a commit receipt with disallowed identity | No approved bypass for this plan; `--no-verify` makes the commit non-pass until identity and full staged gates are independently rerun | `artifacts/automation/pre-commit-identity.txt` |
| Husky pre-commit staged guards | Before local commit | `guard:repo:staged`, staged publication/design-system/node-pin/Claude-settings guards, and conditional console `lint-staged` | Any hard guard or missing applicable console dependency stops commit | `WHATSOUP_SKIP_DRIFT_WARN` affects only the explicitly warn-only early drift probe; it cannot skip hard guards or support `Pass` | `artifacts/automation/pre-commit-staged.txt` |
| Pre-commit drift probe | Before local commit touching TypeScript/package/node/deploy surfaces | Warn-only `guard:node-pin-consistency`, `guard:boundaries`, and `guard:lint:src` preview | A warning does not stop the commit but blocks packet completion until the corresponding hard gate passes | Local warning suppression is logged with reason/actor/expiry; the A27 hard gate remains mandatory | `artifacts/automation/pre-commit-drift-warnings.txt` |
| Commit-message hook | Before finalizing a local commit message | `npm run guard:repo:commit-msg -- <message-file>` and repository attribution/content policy | Nonzero stops commit; prohibited attribution cannot enter handoff history | No approved bypass; a hookless commit must pass message and author scans before integration | `artifacts/automation/commit-message.txt` |
| Husky pre-push router | On every local ref update | `scripts/pre-push-guard.ts` selects branch or release verification; console design metrics/burndown enforce their documented hard conditions | Invalid ref input or any selected hard gate stops push | `--no-verify` is never evidence. Delete-only behavior and report-only metrics are recorded exactly; they do not establish source exit | `artifacts/automation/pre-push-hook.txt` |
| Canonical branch push gate | A27 before any branch push, independent of hook installation | `bash scripts/run-with-pinned-npm.sh run verify:push:branch`; the script unsets known local drift-skip variables and runs repo/publication/drift/security/lint/type/test/console gates | Any nonzero, skipped population, masked output, unknown runtime, or missing assertion blocks push/source exit | No override in this plan. If a local-only guard supports an escape hatch, using it records `Inconclusive` and requires an unskipped rerun | `artifacts/task-11/push-gate.txt` |
| Quality CI | Pull request and `main` push on both supported Node matrix lanes | `.github/workflows/quality.yml`: typechecks, boundaries, repo identity/history guards, required test-integrity install/check, lint, runtime/config/fleet/doc/public guards, full suite+coverage, drills, console lint/build/design/browser checks | Every non-advisory step and matrix lane must conclude success; cancelled, timed-out, skipped, neutral, stale-SHA, or missing check is non-pass | CI ignores documented local skip variables. `continue-on-error` history scan remains advisory, but a changed-range secret finding still blocks this plan pending review | `artifacts/automation/quality-ci.json` with run URL/ID, workflow SHA, job/check conclusions, head SHA |
| Guard test-coverage automation | Local push/release and quality CI | `guard:guard-test-coverage` proves each guard has a test wired into `verify:push:branch` | A new/changed guard without an executed guard test blocks | No narrative waiver; wire the test and rerun | `artifacts/automation/guard-coverage.txt` |
| Tag release gate | `v*` tag push | `.github/workflows/tag-release-gate.yml` release-safe type, repo, publication, doc/public, fail-closed, service, lint, console, and browser checks | Any required step blocks release; release jobs are not cancel-in-progress | Local pre-push cannot replace this hookless-server gate; no override in this source plan | `artifacts/automation/tag-release-ci.json` or `not applicable` before a release |
| WhatSoup guard CI | PR/main changes under `tools/whatsoup_guard/**` or its workflow | Dedicated Node matrix install/typecheck/test workflow | Any applicable lane failure blocks that surface | Record `not applicable` when changed-file trace proves the surface untouched | `artifacts/automation/whatsoup-guard-ci.json` |
| Operational runtime hook exclusion | Instance load, root workspace provision, and fresh sandbox-per-chat provision | Provider-role policy rejects test-integrity, `pluginDirs`, and resolved test-authoring hooks for `operational` bots while preserving unrelated plugins | Any operational effective context containing a development/test-authoring hook is drift, non-hardened, and ineligible for rollout | No local/CI test skill selection can override runtime role policy; a role change requires the versioned Task 9A transaction | `artifacts/task-09/role-hook-enforcement.txt` |

Local Git hooks are fast feedback, not the source-exit authority: existing hook scripts
invoke ambient `node`/`npm`, so A27 must run the canonical branch gate explicitly through
the pinned wrapper and record the observed runtime. CI is the independent hookless-clone
backstop. Source exit requires the local final-SHA receipt plus current CI results where
the repository policy makes them applicable; configured workflow files alone do not
prove required checks or branch protection are active. Record branch-protection/required-
check observation when the repository owner supplies a read-only receipt; otherwise the
merge authority remains an explicit unresolved control.

On any hook or CI failure, stop the commit/push/merge/release checkpoint, preserve full
output, classify the owning surface, repair or revert the first failing packet, and rerun
the failed gate plus every downstream artifact it invalidates. Do not retry until green,
use `--no-verify`, change filters, weaken assertions, add `continue-on-error`, or set a
skip variable merely to obtain a successful status.

Every bypass record includes actor/authority, UTC time, exact command/variable, reason,
scope, affected claims, expiry, compensating check, artifact, and terminal disposition.
A bypass can enable local investigation only; it cannot yield `Pass`, source exit, or
fleet alignment. CI-local escape hatches must be ignored in CI and tested as such. Any
new hook/guard must have a negative fixture, be wired into the canonical branch gate and
applicable CI workflow, and pass `guard:guard-test-coverage` before its protection is
claimed.

## Rules, Policies, and Guardrails Register

Maintain `artifacts/rules_and_guardrails.md` with stable rule IDs and one manifest-linked
result per applicable rule. This register consolidates hard constraints; it does not
weaken the more specific task, error, test, hook, or rollback contracts.

| Rule or policy | Source or rationale | Enforcement point | Blocking condition | Exception path | Evidence location |
|---|---|---|---|---|---|
| R01 — Correct repository, branch, and immutable run identity | Prevent evidence from another worktree/SHA/runtime being accepted | A00, every packet admission, A27, handoff | Root/branch mismatch, unexplained dirty overlap, stale SHA/runtime/lockfile, or missing run ID is `Blocked` | No execution exception; select the correct worktree or start a new evidence set | `artifacts/primary/repo-runtime.txt`, manifest |
| R02 — Pinned command lane and complete output | Ambient Node/npm caused inconclusive evidence; masked output can false-green | Every Node/npm/test/guard command | Bare ambient command used as proof, truncated/masked/piped-away failure, unknown version, no-file/filter/skip, or missing assertion count is non-pass | Diagnostic use may be recorded `Inconclusive`; proof must be rerun through the pinned wrapper | `artifacts/quality/`, command manifest |
| R03 — Test first for behavior changes | Prevent implementation-defined or never-red tests | Tasks 1-10 before production edit | Missing intended red failure, harness/syntax-only failure, weakened assertion, or implementation before red proof is `Blocked`/`Fail` | Documentation-only change uses contract/drift validation; any other exception requires a new owner-approved plan | `artifacts/test_evidence/<packet-id>/red/` |
| R04 — Reuse canonical owners; no parallel sources of truth | Avoid drift among config, route, persistence, health, plugin, and outbound seams | Reuse audit before file/helper/endpoint creation; final diff review | Unsearched candidate, duplicate resolver/store/writer/scanner/renderer, or unjustified abstraction is `Fail` | `new seam justified` only with concrete rejection rationale and duplicate path prevented | `artifacts/reuse_audit.md` |
| R05 — One immutable admitted route and exact-row persistence | Directly prevents cross-provider resume and mixed-lane manager reuse | Route creation, manager admission, checkpoint migration/read/write/resume | Independent provider/model/profile fields, token-only lookup/update, ambiguous backfill/resume, or provider/route mismatch | No permissive exception; quarantine ambiguity and roll forward schema | Tasks 5-7 evidence and route/checkpoint events |
| R06 — One selected credential in a fresh allowlisted environment | Dispatcher denies cannot contain leaked privilege or mutation authority | Child-env builder and pre-spawn attestation | Credential superset, unknown secret-shaped key, privileged/mutation flag, ambient env spread, or missing required selected credential | No privilege exception; characterize a required key with tests and version the allowlist | Task 1 env matrix and layer-3 child receipt |
| R07 — Headless capability requires resolved policy plus parsed edit and bash | Text success/startup/static fixture do not prove tools work | Fallback admission and capability-cache refresh | `ask`, auto-reject, unsupported inspection, text-only `OK`, missing parsed tool phase, timeout, stale/fingerprint mismatch, or unreaped child | None may become `aligned`; report-only collection may continue while primary serves | Task 8 attestation/canary evidence |
| R08 — Dispatcher policy is not OS isolation | Prevent overclaiming security and under-controlling env/access | Policy docs, attestor, health, final review | Claim of sandboxing from pattern denies or reliance on denies to offset privileged env | No exception; separately evidence any OS control | Task 1 policy contract, Task 8 attestation |
| R09 — Operational role excludes development/test-authoring hooks | Incident showed test-authoring gates blocking an ops bot | Config validation, root/per-chat provisioning, plugin audit/parity | Operational test-integrity true, any `pluginDirs`, alias-resolved test-authoring plugin/hook, or unset/unknown role classified hardened | Role may change only via declared policy and Task 9A transaction; no per-host ad hoc waiver | Task 9 role/hook evidence and parity row |
| R10 — Two-file normalization is CAS, lifecycle-aware, and compensating | Separate generic writes can leave mixed config/runtime state | Dedicated Task 9A endpoint under maintenance auth | Direct host write, generic PATCH normalization, missing lock/CAS/idempotency, partial commit, unknown manager, stale/missing postflight, or unproved rollback | No generic fallback; quarantine host/cohort and require fleet owner for recovery | Task 9A phase ledger and receipt |
| R11 — Additive, redacted public/health contracts | Preserve consumers and prevent private-state leakage | Serializer, provider-status, parity, docs/publication guards | Removed/renamed required field, sensitive path/token/prompt/env/trust state, missing field hardened, or consumer break | Versioned public-contract change requires explicit scope amendment and consumer migration | Task 9B consumer/redaction evidence |
| R12 — Audience-safe errors; client never operates target host | Prevent repeat of blank errors and personal-laptop commands | Parser through renderer, outbound safety, admin handoff | Empty detail, raw internals, client shell command/path placeholder, missing operator trace, or alternate outbound bypass | No client-command exception; authorized operator handoff remains separate and sanitized | Tasks 2/10 error catalog and corpus |
| R13 — Owned deterministic async/process work | Avoid dropped output, overlap, leaks, and sleep-based pseudo-proof | Child finalizer, queue, watchdog, normalizer, polling, tests | Unowned promise/process, fixed sleep synchronization, ambiguous generation, incomplete stream settlement, or failed reap | No release exception; disable affected lane and prove cleanup | Task 3/7/8/9 replay and process census |
| R14 — No live fleet/external mutation in source execution | Current request authorizes source hardening/packet design, not deployment or messaging | Every tool/worker dispatch and Task 11 | Service restart, host config/TCC change, qFleet mutation, external message/issue/PR/merge, or alert enablement | Requires a new current owner request naming action and target; source evidence cannot imply it occurred | Orchestration ledger, deployment packet, audit log |
| R15 — Least-privilege TCC and private trust evidence | Blanket grants add risk; trust paths are private and source-selectable | Deployment preflight/parity only | Unneeded/unknown/blanket TCC grant, unproved protected-service need, wrong trust source, or public trust path/state | Default is exactly `not_required`; a separately authorized minimal service/operation grant needs denial evidence | `artifacts/deployment/tcc-baseline.json`, private trust receipt |
| R16 — Safe Git and commit hygiene | Preserve user work/history and repository attribution policy | Every integration/commit/review | Destructive clean/reset/checkout/restore, discarded overlap, prohibited attribution, unverified cherry-pick supersession, or unrelated commit content | Use isolated worktree/stash only with ownership; manual port after diff/apply checks; no attribution waiver | Git status/diff/range evidence, commit guards |
| R17 — Independent final verification and source/fleet separation | Repository green cannot prove installed alignment; reviewer prose is advisory | A27-A29 and handoff | Missing final-SHA full/fast gates, unchecked reviewer claim, source result labeled fleet-aligned, or missing per-host receipt | No semantic waiver; unresolved live evidence keeps only its dependent gate `Not Ready` | Task 11 verification/reviews/deployment packet |

`Blocked` means the next required action cannot safely begin because a prerequisite,
authority, contract, cleanup proof, or required tool/evidence is absent. `Fail` means a
check disproved a rule. `Inconclusive` means the check ran but cannot decide it. Warnings
are informational only when the owning rule explicitly says so (currently the local
pre-commit drift preview, coverage headroom, and documented report-only metrics); they
never count as `Pass`. A warning in changed protected code, an expired warning/waiver,
or any warning without owner and checkpoint blocks the affected gate.

Permitted exceptions live under `artifacts/exceptions/<rule-id>-<exception-id>.json` and
record rule ID, actor and decision authority, rationale, exact scope, affected claims,
start/expiry, risk, compensating control, rollback trigger, evidence, and terminal
verdict. R05-R12 and R14-R15 have no exception path inside this source plan. A proposed
exception to those rules is a scope/policy change: stop, amend the plan with current owner
authorization, add adversarial proof, and rerun contradiction/readiness review.

Rule violations are detected by the named tests, guards, source/caller traces, runtime
events, parity health, hook/CI results, and independent review. Record a typed violation
with rule ID, trace/run ID, requested/observed state, owner, containment, artifact, and
verdict; stop the dependent packet, preserve evidence, contain or roll back, and
invalidate downstream proof. Repeated failure never downgrades a rule to a warning.

## Molecular Task Decomposition

The numbered Tasks 1-11 are commit-sized parents, not dispatch units. Execute the atomic
packets below in ID order subject to dependencies. Each packet has one owner, one primary
output, one validation method, and one evidence path; implementation and its proof cannot
be split across owners.

References to A00-A29 include A23a, A23b, and A23c as named subdivisions of parent A23;
they do not create additional parent checkpoints or relax their explicit dependency
edges.

| ID / parent | Owner | Entry condition and inputs | Single action / primary output | Observable exit, validation, and evidence | Failure, retry, rollback, dependencies |
|---|---|---|---|---|---|
| A00 / setup | lead | Correct worktree; pinned installs | Capture pinned baseline | Named suites execute; exit 0; `artifacts/primary/focused-baseline.txt` | Any failure blocks all production packets; diagnose then rerun from clean evidence |
| A01 / T1 | provider owner | A00; installed CLI help and config flow | Characterize supported profile-selection interface | Sanitized version/argv/config fixture exists; `artifacts/task-01/interface.txt` | Unsupported remains fail-closed; blocks A03, A15 |
| A02 / T1 | test owner | A01; current argv/env seams | Add failing profile-ownership/credential-env matrix | Missing selector, non-reserved configured profile, inline-policy synthesis, credential/privilege superset, and unknown secret-key failures observed; `artifacts/task-01/red.txt` | Wrong/no failure blocks implementation; repair fixture and rerun |
| A03 / T1 | provider owner | A02 red proof | Implement the explicit reserved profile selector, preserve fleet-owned policy, and build a one-credential allowlisted env | A02 turns green; no ambient `default_agent`, inline agent policy, privileged env, unrelated mutation authority, or non-reserved configured selector; `artifacts/task-01/green.txt` | Revert packet diff if unrelated provider behavior changes; depends A01-A02 |
| A04 / T1 | docs owner | A03 green | Document selector, fleet-policy ownership, env, and non-sandbox contract | Validator/writer/doc drift tests pass; attestation exposes key names only; `artifacts/task-01/docs.txt` | Retry after contract mismatch; rollback doc plus code together |
| A05 / T2 | test owner | A00; rejected-tool fixtures | Add failing parser/render corpus | Tool identity/detail and non-empty bullet assertions fail for expected reason; `artifacts/task-02/red.txt` | Blocks A06 on fabricated/unrelated failure |
| A06 / T2 | messaging owner | A05 red proof | Implement safe failed-tool propagation | Parser/classifier/renderer corpus passes; `artifacts/task-02/green.txt` | Revert only T2 files; preserve provider event compatibility |
| A07 / T3 | lifecycle owner | A00; preserved cleanup worktree | Audit reusable finalizer delta | Coupling and rejection rationale recorded; `artifacts/task-03/reuse.txt` | Missing source selects fresh implementation; blocks blind copy |
| A08 / T3 | test owner | A07 | Add failing close-order/generation matrix | Late stdout, idempotence, clean child release, stale generation fail as expected; `artifacts/task-03/red.txt` | Wrong event order blocks A09 |
| A09 / T3 | lifecycle owner | A08 red proof | Implement one close-owned finalizer | Ownership suites pass with no stale child; `artifacts/task-03/green.txt` | Restore packet diff if budget/process-tree invariants regress; depends A08 |
| A10 / T4 | recovery owner | A09; five preserved commits | Audit resume-safety series | Commit scope, attribution, overlap, apply-check recorded; `artifacts/task-04/reuse.txt` | Manual port path replaces cherry-pick on overlap |
| A11 / T4 | recovery owner | A10; recovery fixtures | Port automatic-resume fences | All named recovery paths quarantine inconclusive inspection; `artifacts/task-04/green.txt` | Revert integrated port on replay regression; does not claim route scoping |
| A12 / T5 | test owner | A03, A11 | Add failing immutable-route matrix | Normalization/hash/invalid-input/aliasing assertions fail as expected; `artifacts/task-05/red.txt` | Blocks route implementation on nondeterministic fixture |
| A13 / T5 | route owner | A12 red proof | Implement and thread immutable route | Route/session/runtime suites pass; desired/observed logs match; `artifacts/task-05/green.txt` | Revert route packet if any manager retains split identity |
| A14 / T6 | database owner | A13; current schema scan | Reserve next migration number | Unique next number proven; `artifacts/task-06/migration-number.txt` | Recompute on branch drift; blocks schema edit |
| A15 / T6 | test owner | A14; mixed-provider/legacy fixtures | Add failing exact-row migration matrix | Idempotence, shared-token isolation, ambiguous quarantine fail as expected; `artifacts/task-06/red.txt` | Blocks A16 on weak ambiguity proof |
| A16 / T6 | database owner | A15 red proof | Implement additive exact-row persistence | Migration/lifecycle/resume suites pass; `artifacts/task-06/green.txt` | Roll forward only; never restore provider-blind code after mixed rows exist |
| A17 / T7 | test owner | A09, A11, A13, A16 | Add failing reconciliation state matrix | Shared/single/per-chat plus mid-turn barrier expose stale manager; `artifacts/task-07/red.txt` | Blocks A18 if any admission mode is absent |
| A18 / T7 | runtime owner | A17 red proof | Implement queue-boundary reconciler | Idle replace/active defer/next-admission consume pass; `artifacts/task-07/green.txt` | Kill switch disables fallback and retires OpenCode managers |
| A19 / T8 | attestation owner | A01, A03, A13 | Characterize policy/runtime inspection adapters | Supported-version fixtures or explicit unsupported classification; `artifacts/task-08/static-interface.txt` | Unknown adapter is `inconclusive`; blocks aligned state |
| A20 / T8 | test owner | A19; injected process seams | Add failing static/dynamic attestation matrix | Ask/allow/deny/path-escape/privileged-env/malformed/text-only/timeout/stale cases fail closed; `artifacts/task-08/red.txt` | Blocks A21 on missing parsed edit plus bash proof or environment isolation |
| A21 / T8 | attestation owner | A20 red proof | Implement attestor, cache, admission gate | Only fresh aligned cache admits fallback; watchdog reaps; `artifacts/task-08/green.txt` | Roll back to fallback-disabled, not permissive admission |
| A22 / T9 | config owner | A03; existing config/workspace/plugin audit | Add failing provider-role/effective-context matrix | `operational`/`development`/unset, role overlay, root settings, sandbox-per-chat propagation, and dev-hook mismatch fail as expected; `artifacts/task-09/role-red.txt` | Project trust excluded; blocks A23 |
| A23 / T9 | config owner | A22 red proof | Implement role policy and workspace propagation | Role-owned keys resolve without replacing unrelated plugin cohorts; root and fresh per-chat settings match; `artifacts/task-09/role-green.txt` | Legacy unset remains visible/non-hardened; operational clears `pluginDirs` and dev-only hooks |
| A23a / T9A | fleet config owner | A23; current PATCH/source transaction trace | Add failing CAS/rollback/restart matrix | Stale fingerprint, second-write failure, drain failure, restart failure, rollback failure, and fresh-session mismatch fail closed; `artifacts/task-09/normalizer-red.txt` | Existing generic PATCH is not accepted as normalization; blocks A23b |
| A23b / T9A | fleet config owner | A23a red proof | Implement versioned transactional normalization seam | Two files stage/commit/rollback under CAS and per-instance lock; drain/restart/postflight evidence passes; `artifacts/task-09/normalizer-green.txt` | qFleet may call only this seam; no direct file mutation; rollback failure is `Blocked` |
| A23c / T9B | health owner | A13, A16, A18, A21, A23b | Add failing requested/observed postflight and parity matrix | Cached-old-runtime, partial file state, absent fresh session, and counterfactual A-F rows fail; `artifacts/task-09/health-red.txt` | No source-only or pre-restart evidence may harden a row; blocks A24 |
| A24 / T9B | health owner | A23c red proof | Implement redacted A-F health/parity | Transaction/postflight, effective trust-source kind, TCC disposition, telemetry coverage, consumer, and public-surface tests pass; `artifacts/task-09/health-parity.txt` | Any missing A-F/role/fresh-session proof downgrades row; no trust path/state emitted |
| A25 / T10 | messaging owner | A06; traced admin handoff | Add failing redaction/target corpus | Client/operator audience assertions fail as expected; `artifacts/task-10/red.txt` | Untraced administrative path blocks A26 |
| A26 / T10 | messaging owner | A25 red proof | Implement pre-redaction command diversion | Safety, heal/admin, publication suites pass; `artifacts/task-10/green.txt` | Revert T10 packet on ordinary-prose regression |
| A27 / T11 | lead | A04, A06, A09, A11, A13, A16, A18, A21, A24, A26 | Run final integrated verification | Focused/full/guards/push gate pass on one SHA; `artifacts/task-11/verification.txt` | Any masked or stale lane is non-pass; repair owning packet and rerun affected downstream evidence |
| A28 / T11 | independent reviewers | A27 | Review requirements plus code quality | Decisive claims independently reproduced; `artifacts/task-11/reviews.md` | Advisory text without checked source/test evidence is inconclusive |
| A29 / T11 | fleet owner | A27-A28; current qFleet contract | Validate maintenance-gated Task 9A deployment packet schema | qFleet uses only the versioned transactional seam with per-host CAS, idempotency, generation/postflight, redacted requested/observed fields, and rollback controls; `artifacts/task-11/deployment-packet.json` | No host mutation; direct file writes, generic PATCH, or missing qFleet contract keep fleet `Not Ready` |

For any newly discovered packet, record Task ID, Parent Task ID, objective, preconditions,
inputs, action, expected output, observable signals, validation method, failure modes,
retry path, rollback path, evidence produced, dependencies, and blocking conditions in
the same schema. A packet is still too large when its action contains unrelated work,
mixes execution with an unnamed check, has multiple primary outputs, relies on hidden
judgment, or can partially succeed without a failing signal. The word “and” in an action
is a mandatory split review, not an automatic exemption.

## Verification Design

Maintain `artifacts/verification_matrix.md` with one row for every A00-A29 packet and
every state transition added during implementation. Each row contains Task ID, checked
claim, rationale, exact command/inspection method, checker, expected output, artifact
path, `Pass`, `Fail`, and `Inconclusive` thresholds, plus escalation. The packet owner
cannot mark completion until its row and manifest entry point to the same final-SHA
evidence.

Prefer deterministic assertions, direct state inspection, schema/contract conformance,
canonical diffs and checksums, migration/recovery replay, counterfactual fixtures, and an
independent cross-check. Emit native JSON or SARIF when a tool supports it; otherwise
retain raw output plus a normalized summary that links back to it. Human review is valid
only when it names source locations, diff, reproduced command, and decisive artifact.

Mandatory transition rows cover: primary to fallback; fallback to primary; idle route
replacement; active-route deferral; resume accept; resume quarantine; migration unique
link; migration ambiguous quarantine; capability cache hit; capability invalidation;
report-only to fail-closed; requested/observed provider-role match; development-hook
mismatch; parity harden/downgrade; client-command diversion; and rollback manager
retirement. Each state transition requires before/after state plus one stable reason code.

Reject narrative-only validation, “looks correct,” intuition as sole proof, zero-exit
output without assertion counts, filtered/no-file tests, completion without evidence,
and any check lacking explicit thresholds. Missing, stale, masked, truncated, or
unreplayable evidence is `Inconclusive`; a disproved invariant is `Fail`; inability to
perform the next required check safely is `Blocked`. Escalation goes first to the packet
owner for deterministic reproduction, then to the subsystem owner for an independent
method, and finally to the repository or fleet decision authority. There is no silent
pass path.

## Testing and Anti-fabrication Standard

Maintain `artifacts/test_strategy.md` as the plan-wide testing ledger and one provenance
record under `artifacts/test_evidence/<packet-id>/provenance.json` for each test family.
The strategy maps every A00-A29 claim to test level, red proof, deterministic checker,
negative/counterexample, deeper applicable lane, replay artifact, independent validator,
owner, and final verdict.

### TDD scope

Red-green-refactor is mandatory for every production behavior, schema/migration, config
or public contract, parser/renderer, state transition, process-lifecycle, permission/env,
health/parity, normalizer, and guard change in Tasks 1-10. Characterization tests may
capture existing behavior first, but changed behavior still requires a new failing
assertion before implementation. Pure documentation/evidence edits need contract or drift
validation rather than a fabricated unit-test red phase. Emergency implementation-first
work is outside this plan; discovering pre-existing production code for a supposedly new
behavior requires reverting/staging it out or testing from the baseline commit before the
packet may claim TDD.

### Red phase verification

A real red phase executes the narrow named test through the pinned wrapper against the
pre-production-change tree and fails the intended behavioral assertion. Record command,
Git SHA/tree fingerprint, test file and name, expected assertion, actual assertion/error,
assertion count, exit code, runtime/tool versions, and raw output under
`artifacts/test_evidence/<packet-id>/red/`. Failure from missing import/file, syntax/type
error, wrong fixture, absent dependency, timeout, no-file/filter, unrelated baseline
failure, or the harness itself is not red proof. Repair the harness, rerun, and require a
mutation control (temporarily disable or invert the invariant) to demonstrate the test
can fail for the intended reason. Only then may production code change; the same exact
test must turn green without weakening or deleting its assertion.

### Deterministic validation

Use injected clocks, seeded generators, event barriers, fake process/network/service
seams, disposable directories/databases, canonical JSON, stable sorting/hashing, explicit
locale/timezone, bounded watchdogs, and before/after state inspection. Run each critical
test at least once in isolation and once in its integration family; order dependence,
fixed sleeps, ambient credentials/config, shared mutable fixtures, live wall clock, or
uncaptured network/provider output is `Fail` until removed. Remaining live nondeterminism
is limited to installed OpenCode/fleet versions, provider/network behavior, qFleet host
state, service-context Keychain/TCC, and real canaries. Those checks use bounded capture,
fingerprints, and replay fixtures but remain `Inconclusive` or `Blocked` when they cannot
decide; they cannot be replaced by mocked green evidence.

### Test provenance

Every provenance record contains input source, provenance type (`synthetic`, `sampled`,
`captured`, or `production-derived`), capture date/runtime/schema, minimization and
sanitization method, checksum, representativeness rationale, independently derived
expected result and oracle owner/source, exact replay instructions, negative or
counterexample coverage, deterministic assertions or the explicit reason they are
unavailable, applicable mutation/contract/schema/replay lanes and outcomes, producing
Git SHA, tool/runtime version, raw-output artifact, and verdict. Captured or
production-derived fixtures must be minimized, sanitized, and checksummed; never retain
session tokens, prompts, credentials, private paths, host identity, environment values,
or project-trust state. Implementation output cannot define its own expected result.

| Category | Required coverage in this plan | Expected-result source |
|---|---|---|
| Unit | profile/credential resolver, route canonicalization, parser extraction, error formatter, reconciler, capability normalization, role policy | approved invariants and pure input/output tables, not implementation output |
| Integration | config load/write, child argv/env, lifecycle DB, resume callers, queue admission, health/parity, outbound/admin handoff | source contract plus before/after state inspection |
| End-to-end | disposable spawn-per-turn fixture and disposable edit-plus-shell provider canary; qFleet canary only after source exit | sentinel written by the test and independently verified by shell event/state |
| Negative | blank/unknown profile, ask/deny, wrong provider token, ambiguous legacy row, empty error, internal path, ops bot with dev hook | explicit fail-closed/error contract |
| Regression | characterized current seams, full unmasked suite, push gate | preserved baseline plus approved changes |
| Observability | mandatory event, reason code, correlation, redaction, requested/observed separation | telemetry event catalog |
| Adversarial | malformed provider events, token collision, hostile redaction strings, reordered lifecycle events, counterfactual parity rows | threat/failure model with expected containment |
| Stale-data | expired capability, binary/policy/role drift, prior-SHA evidence, stale child generation | cache/evidence freshness rules |
| Partial-data | legacy null provider/link, missing tool output/name, incomplete fleet row, unset role | quarantine/non-hardened rules |
| Degradation | unsupported CLI, timeout, unavailable key/service, failed canary, missing optional scanner | `Inconclusive` or `Blocked`; never implicit fallback success |

False-positive controls are mandatory: observe the red failure before production edits;
record named file and assertion counts; reject filtered, skipped, retried-away, masked,
or no-file runs; use injected clocks and event barriers instead of sleeps; make each
critical fixture prove the test fails when its invariant is deliberately disabled; and
pair mocked unit seams with process/state integration proof. A model response, log line,
zero exit code, or absence of thrown error is never sufficient tool-capability evidence.

### Independent validation

An owner other than the implementer must independently reproduce persistence/migration,
provider admission and child-env isolation, process finalization, queue concurrency,
role/plugin normalization, health/parity, outbound redaction, and final-release claims.
Use a distinct method: source/query trace plus counterexample, contract/schema checker,
mutation test, replay, fault injection, or fresh disposable integration run. A second run
of the same command by the implementer or a reviewer paraphrasing the diff is not
independent. Contradiction checks are mandatory whenever requested and observed state can
diverge, cached evidence can stale, rollback can partially succeed, or a live external
contract remains unresolved. Conflicts remain `Inconclusive` until the lead checks the
decisive source/state/artifact; majority vote cannot resolve them.

Evidence hardening requires raw output plus normalized summary, manifest command/exit
code/tool versions, final-SHA binding, checksums for captured fixtures, and independent
reproduction for persistence, provider admission, role policy, redaction, and release
claims. Use signed/attested CI output when the repository environment exposes it; if it
does not, record `not available` rather than implying attestation. Generated evidence is
immutable; annotations live in a separate review artifact.

### Replay artifacts

Mutation testing, contract testing, schema/property testing, contradiction checks, replay,
and fault injection form the deep-validation ladder. Replay and fault injection are
required here. Other unavailable lanes are recorded as `not installed`, `skipped` with
owner/rationale, or `not applicable`; none may be counted as coverage. A replay package
must include sanitized fixture, checksum, seed/clock, exact command, expected state
transition, raw result, and environment/runtime fingerprint. Store packages under
`artifacts/test_evidence/<packet-id>/replay/`; the manifest links their immutable digest
to the red/green proof and final SHA. Replay must work from a fresh disposable state and
must not depend on prior test order, ambient secrets, private host paths, or live message
content. A missing, non-reproducible, stale, or sensitive replay package is non-pass.

Only `Pass`, `Fail`, `Inconclusive`, and `Blocked` are valid. `Pass` requires the intended
assertions and replay evidence; `Fail` means an assertion disproved the claim;
`Inconclusive` means execution cannot decide it; `Blocked` means a required safe check
cannot proceed. Ambiguous green, “no errors,” or an absent failure signal is rejected.

## Cross-pass Contradiction and Integration Check

Before final synthesis, the lead must freshly reread this entire plan and write
`artifacts/contradiction_check.md`. The check must compare objective/scope, assumptions,
reuse decisions, error behavior, observability, readiness, task dependencies, testing
claims, provenance, rollback, handoff, and source-versus-fleet exit. It must contain
sections updated, major cross-pass upgrades, contradictions found, contradictions
resolved, unresolved risks, and a current verdict using only the four evidence verdicts.

| Integration question | Resolution required before final synthesis |
|---|---|
| Is the reported clean baseline current execution proof? | No. It is a historical target until A00 and final-SHA tests run through the pinned wrapper; ambient, masked, or partial results remain non-pass. |
| Does S5 source proof establish fleet alignment? | No. S5 proves the source schema and gates; only fresh qFleet observations can satisfy fleet exit. |
| Are readiness states interchangeable with evidence verdicts? | No. Readiness controls the next action; evidence records claim quality. A dependent gate is `Not Ready` for either `Blocked` or `Inconclusive` evidence. |
| Does Task 9A authorize a deployment or restart? | No. It implements and tests an injected lifecycle seam; live host mutation remains outside this run and requires a separately authorized qFleet deployment. |
| Does WhatSoup carry or install the OpenCode agent policy? | No. WhatSoup owns only the exact reserved selector and preserves the `agent` map. The fleet-policy package owns the deliberately non-deployable versioned artifact; static resolved-profile attestation plus the parsed edit-and-bash canary prove an installed lane. |
| Does use of the test-integrity skill conflict with disabling the plugin? | No. The skill is limited to development/test-authoring lanes; the operational runtime policy explicitly excludes the plugin and resolved test-authoring hooks. |
| Can existing generic PATCH or direct qFleet writes satisfy normalization? | No. Only the versioned Task 9A two-file CAS/lifecycle seam may produce a normalization receipt. |
| Can static deny patterns compensate for privileged environment inheritance? | No. A fresh allowlisted child environment is independently required; any credential superset, mutation-authority flag, or privileged key blocks admission. |
| Is this plan already durable in the feature branch because it exists in the worktree? | No. Planning-time `git ls-files`/`git check-ignore` proved it is ignored and untracked. It must be deliberately tracked and rechecked before production edits or handoff. |
| May guard-engine-specific questions in the final verification bank be silently translated into WhatSoup equivalents? | No. Preserve every question and either prove an exact applicable mapping with source evidence or record the foreign premise as `Inconclusive`; never fabricate a symbol or skip the row. |

The current contradiction verdict is `Inconclusive`: the plan is internally coherent
enough for final synthesis, but installed OpenCode/static-inspection compatibility,
private trust-source selection, exact qFleet inventory/schema, live service-context
observations, retention/rollout/rollback authority, and any operation-specific TCC need
remain external evidence. A contradiction that cannot be resolved from current source
must name its owner and dependent checkpoint and keep that checkpoint `Not Ready`; later
prose, source-green tests, or a fallback may not hide it.

## Task 1: Explicit OpenCode Execution Profile and Minimal Credential Lane

**Files:**

- Create: `src/runtimes/agent/providers/opencode-execution-profile.ts`
- Create: `tests/runtimes/agent/opencode-execution-profile.test.ts`
- Delete: `docs/reliability-runner/opencode-headless-policy.json` (duplicate policy source; fleet policy owns the artifact)
- Modify: `src/core/provider-mcp-config.ts`
- Modify: `src/runtimes/agent/session.ts`
- Modify: `src/runtimes/agent/providers/primary-model-usability-adapters.ts`
- Modify: `src/core/agent-config-validator.ts`
- Modify: `tests/runtimes/agent/opencode-child-env.test.ts`
- Modify: `tests/runtimes/agent/primary-model-usability-adapters.test.ts`
- Modify: `tests/core/agent-config-validator.test.ts`
- Modify: `docs/configuration.md`

- [ ] Add failing tests for a pure resolver whose only configured value is the reserved `providerConfig.executionProfile: "whatsoup-headless"` and whose operational contract is explicit:

  ```ts
  expect(resolveOpenCodeExecutionProfile({ executionProfile: 'whatsoup-headless' }))
    .toBe('whatsoup-headless');
  expect(() => resolveOpenCodeExecutionProfile({ executionProfile: '  ' }))
    .toThrow(/executionProfile/);
  expect(() => resolveOpenCodeExecutionProfile({ executionProfile: 'fullstack-lead' }))
    .toThrow(/whatsoup-headless/);
  expect(openCodeAgentArgs({ executionProfile: 'whatsoup-headless' }))
    .toEqual(['--agent', 'whatsoup-headless']);
  ```

- [ ] Add failing argv tests proving the selector occurs exactly once on fresh, resumed, and model-usability OpenCode commands. Expose a test-only pure spawn-per-turn argv seam rather than instantiating a real child.

- [ ] Add failing environment tests proving a configured `glm/...` route receives
  `ZAI_API_KEY` but not OpenAI, Anthropic, DeepSeek, or MiniMax keys. Add equivalent
  cases for custom `apiKeyService` and each supported model-prefix mapping. Construct the
  child environment from an allowlist, not by copying the parent and deleting known
  hazards: retain only required system process keys, required WhatSoup instance/socket
  context, and exactly one selected route credential. Negative cases must prove omission
  of `SUDO_ASKPASS`, `ALLOW_M365_MUTATIONS`, `CLAUDE_CONFIG_DIR`, every unrelated
  connector/provider mutation flag, every non-selected credential, and an injected
  unknown secret-shaped key. Attestation and logs may list allowed key **names** only;
  they must never emit values.

- [ ] Remove WhatSoup's duplicate policy template and inline `opencode.json` agent
  provisioning. The fleet-policy package is the sole owner of the versioned
  `whatsoup-headless` artifact and keeps it non-deployable until exact workspace and
  supported-version proof exist. WhatSoup must preserve unrelated and fleet-owned
  `agent` entries verbatim while refreshing MCP/custom-endpoint blocks. Add failing
  merge/write tests proving no inline policy appears. Dispatcher policy remains distinct
  from operating-system isolation and installed capability proof.

- [ ] Run the new tests and confirm failures are for missing resolver/selector and the existing credential superset.

- [ ] Implement `resolveOpenCodeExecutionProfile()` and `openCodeAgentArgs()`. Use the same helper in operational and model-usability argv; never consult `default_agent`.

- [ ] Change the OpenCode child environment to resolve exactly one credential service in this order:

  1. valid `providerConfig.apiKeyService` for a custom endpoint;
  2. mapped service for the selected model prefix;
  3. otherwise no provider credential and an explicit configuration error.

  Do not retain the existing fallback trio or OpenAI/Anthropic superset. Build a fresh
  allowlisted object rather than spreading `process.env`; retain only keys characterized
  by a table-driven test as required for the selected route and service context.

- [ ] Validate that configured `executionProfile` is exactly `whatsoup-headless` on instance load and in the runtime resolver. The first source rollout may leave absence report-only at fallback admission, but every configured command must select the reserved profile exactly once and no code may infer `default_agent`.

- [ ] Run:

  ```bash
  bash scripts/run-with-pinned-npm.sh test -- \
    tests/runtimes/agent/opencode-execution-profile.test.ts \
    tests/runtimes/agent/opencode-child-env.test.ts \
    tests/runtimes/agent/primary-model-usability-adapters.test.ts \
    tests/core/agent-config-validator.test.ts \
    --pool=forks
  bash scripts/run-with-pinned-npm.sh run typecheck:all
  ```

- [ ] Commit:

  ```bash
  git add src/runtimes/agent/providers/opencode-execution-profile.ts \
    src/runtimes/agent/session.ts \
    src/runtimes/agent/providers/primary-model-usability-adapters.ts \
    src/core/agent-config-validator.ts \
    tests/runtimes/agent/opencode-execution-profile.test.ts \
    tests/runtimes/agent/opencode-child-env.test.ts \
    tests/runtimes/agent/primary-model-usability-adapters.test.ts \
    tests/core/agent-config-validator.test.ts docs/configuration.md \
    docs/reliability-runner/opencode-headless-policy.json
  git commit -m "fix: select explicit headless fallback profile"
  ```

## Task 2: Preserve OpenCode Tool Identity and Non-empty Errors

**Files:**

- Modify: `src/runtimes/agent/providers/opencode-parser.ts`
- Modify: `src/runtimes/agent/stream-parser.ts` only if the event contract needs an additive tool-name field
- Modify: `src/runtimes/agent/tool-update.ts`
- Modify: `src/runtimes/agent/outbound-queue.ts`
- Modify: `tests/runtimes/agent/providers/opencode-parser.test.ts`
- Modify: `tests/runtimes/agent/tool-errors.test.ts`
- Modify: `tests/runtimes/agent/outbound-queue.test.ts`

- [ ] Add failing parser fixtures for completed and rejected OpenCode tool events. Assert tool name/call ID are retained and error content is extracted in priority order from structured error, output, metadata, and status.

- [ ] Add a failing tool-update test:

  ```ts
  expect(classifyToolError('edit', '').detail).toMatch(/unable|issue|failed/i);
  ```

- [ ] Add a failing outbound test proving an empty or whitespace detail cannot render `•` with no text.

- [ ] Run the three focused suites and confirm the expected failures.

- [ ] Enrich the OpenCode parser without changing other providers' event shapes. A rejected edit/bash event must be recognized as tool activity and carry a safe non-empty reason.

- [ ] Route the technical fallback in `classifyToolError` through `formatProviderErrorForUser`; preserve the existing category classification and 100-character tool-update bound.

- [ ] Add a final defensive non-empty detail substitution inside `renderToolUpdates`.

- [ ] Run focused tests and `typecheck:all`, then commit:

  ```bash
  git commit -m "fix: preserve fallback tool failure details"
  ```

## Task 3: Finalize Spawn-per-turn Children on Close Without Losing Late Output

**Files:**

- Modify: `src/runtimes/agent/session.ts`
- Modify as required by the coupled state machine: `src/runtimes/agent/process-tree.ts`
- Modify as required by the coupled state machine: `src/runtimes/agent/providers/budget.ts`
- Modify as required by the coupled state machine: `src/runtimes/agent/runtime-turn-coordinator.ts`
- Modify as required by the coupled state machine: `src/runtimes/agent/runtime.ts`
- Modify or create: `tests/runtimes/agent/session-spawn-per-turn-handlers.test.ts`
- Re-run: `tests/runtimes/agent/crash-respawn-ownership.test.ts`

- [ ] Reuse-first review: inspect, but do not copy blindly, the characterized
  `SpawnPerTurnChildState` implementation in the preserved
  `codex-runtime-cleanup-20260715` worktree. Revalidate its selected six-file diff
  against the current branch and record any coupling before editing.

- [ ] Add failing tests that deliver stdout after `exit` but before `close`, then assert
  the final event is processed exactly once and the clean OpenCode child ends as:

  ```ts
  expect(manager.getStatus()).toMatchObject({ active: true, pid: null });
  ```

- [ ] Add a superseded-generation test proving the old close/finalizer cannot clear a newer child.

- [ ] Observe the first test fail because current code finalizes on `exit`, can miss
  late stdout, and leaves the child pointer set after a clean exit.

- [ ] Implement one idempotent spawn-per-turn finalizer owned by explicit child state.
  Treat `close` as stream settlement, preserve the existing process-tree cleanup and
  budget semantics, drain late stdout, and set `this.child = null` only when child and
  generation are still current. Keep `active=true` on clean completion and preserve
  the provider session ID.

- [ ] Run both ownership suites plus the full `session.test.ts` seam and commit:

  ```bash
  git commit -m "fix: release clean fallback turn children"
  ```

## Task 4: Port the Committed Automatic-resume Safety Fences

**Files:**

- Create: `src/runtimes/agent/resume-safety.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Create: `tests/runtimes/agent/resume-safety.test.ts`
- Modify: `tests/runtimes/agent/runtime-secondhalf-branches.test.ts`

- [ ] Inspect the five preserved commits `8e7daba39`, `e22a4b999`, `1767af922`,
  `5deed78ce`, and `871669d06` with `git show` and confirm they contain no
  prohibited attribution or unrelated changes.

- [ ] Re-run `git apply --check` for the combined patch against the current branch.
  If Task 3 changed overlapping runtime lines, port the behavior manually rather than
  resolving by discarding either side.

- [ ] Add or retain failing-first coverage for proactive per-chat resume,
  shared/single startup resume, sandbox lazy resume, crash auto-respawn, and
  resume-failure replay. Each path must start fresh or quarantine continuation when
  recovery inspection is fenced/inconclusive.

- [ ] Cherry-pick the coherent series only when it still applies cleanly; otherwise
  reproduce its four-file final delta with `apply_patch`. Do not touch or clean the
  source worktree.

- [ ] Run the named resume-safety suites plus startup, crash-respawn, and per-chat
  recovery suites. Provider/route scoping remains a later task; do not claim these
  fences solve cross-provider identity.

- [ ] Preserve the original five commits when cherry-picked, or use one local commit
  if a manual integrated port is required.

## Task 5: Introduce Immutable Route Identity

**Files:**

- Create: `src/runtimes/agent/session-route.ts`
- Create: `tests/runtimes/agent/session-route.test.ts`
- Modify: `src/runtimes/agent/session.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: route/config test helpers that construct `SessionManagerOptions`

- [ ] Write failing pure tests for normalization and stable hashing:

  ```ts
  const route = createResolvedSessionRoute({
    provider: 'opencode-cli',
    model: 'glm/glm-5.2',
    executionProfile: 'whatsoup-headless',
    policyFingerprint: 'sha256:fixture',
  });
  expect(route.routeFingerprint).toMatch(/^sha256:/);
  expect(createResolvedSessionRoute({ ...sameInput })).toEqual(route);
  ```

- [ ] Add failure cases for unknown provider, blank execution profile on OpenCode, blank/invalid policy fingerprint, and mutable input aliasing.

- [ ] Implement the immutable route type and deterministic canonical digest using the repository's existing SHA-256 conventions.

- [ ] Change `SessionManagerOptions` to receive `route` instead of independent provider/model/profile values. Add `getRouteIdentity()` returning a read-only copy.

- [ ] In `AgentRuntime.createSessionManager`, resolve the route exactly once before per-chat socket wiring and pass that same object to every callback/manager field. Record desired and observed route separately in structured logs without provider tokens.

- [ ] Run route, session, per-chat actor, NL routing, and fallback configuration suites plus typecheck.

- [ ] Commit:

  ```bash
  git commit -m "refactor: bind sessions to immutable routes"
  ```

## Task 6: Add Exact-row Provider/Route Persistence

**Files:**

- Modify: `src/core/database.ts`
- Create: `src/core/database-migration-45.ts`
- Modify: `src/runtimes/agent/session-db.ts`
- Modify: `src/core/session-lifecycle-store.ts`
- Modify: `src/core/durability.ts`
- Modify: checkpoint types/readers/writers identified by the compiler
- Create: `tests/core/migration-session-route-identity.test.ts`
- Modify: `tests/core/session-lifecycle-store.test.ts`
- Modify: `tests/runtimes/agent/session-db.test.ts`

- [ ] Add failing migration tests for the four additive columns and idempotent replay.

- [ ] Add failing mixed-provider fixtures where two agent rows deliberately share the same provider token. Assert exact-row close/reactivate touches only the linked checkpoint.

- [ ] Add failing legacy fixtures for uniquely linkable, ambiguous, and unmatched checkpoints. Assert ambiguous/unmatched rows remain unlinked and non-resumable.

- [ ] Observe failures against schema 44 and provider-token checkpoint updates.

- [ ] Add migration 45. The backfill must run in one transaction, link only exact unique candidates, and leave ambiguity visible. Never choose newest-row as a substitute for proof.

- [ ] Remove or replace the current unconditional startup `backfillSessionProvider`,
  which labels every legacy null-provider row as the current primary and would violate
  the fail-closed migration rule.

- [ ] Extend fresh lifecycle writes with agent row ID, provider, and route fingerprint. Replace checkpoint updates by provider token with exact `agent_session_row_id` updates plus token/provider/fingerprint consistency predicates.

- [ ] Change `getActiveSession` and `getResumableSessionForChat` to require expected provider and route fingerprint and return the persisted route fields. No provider-blind overload remains in production code.

- [ ] Run migration numbering/safety, durability, session DB, lifecycle, startup resume, and per-chat resume suites.

- [ ] Commit:

  ```bash
  git commit -m "fix: scope persisted sessions to exact routes"
  ```

## Task 7: Reconcile Route Changes at Queue Admission

**Files:**

- Create: `src/runtimes/agent/route-reconciler.ts`
- Create: `tests/runtimes/agent/route-reconciler.test.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: focused fallback/revert/turn-queue tests

- [ ] Add a pure state-machine test matrix for `matched`, `replace_idle`, and `defer_active` decisions.

- [ ] Add integration tests proving fallback activation and reversion replace an idle manager before the next turn.

- [ ] Add a concurrency test proving a route change during an admitted turn does not kill or overlap that turn and is applied at the next serialized admission.

- [ ] Observe existing behavior retain the old manager after fallback-window state changes.

- [ ] Implement one reconciler called by shared, single, and per-chat queue admissions. It must end, un-own, and replace an idle mismatched manager; active mismatches set a pending marker consumed at the next admission.

- [ ] Remove comments and status copy claiming existing sessions remain unaffected when that would contradict the new next-turn boundary contract. Update `/model` and fallback status wording precisely.

- [ ] Run provider fallback, fallback chain, turn queue, per-chat, crash ownership, and route-intent suites.

- [ ] Commit:

  ```bash
  git commit -m "fix: reconcile provider routes between turns"
  ```

## Task 8: Add Headless Capability Attestation and Fail-closed Eligibility

**Files:**

- Create: `src/runtimes/agent/providers/headless-capability.ts`
- Create: `src/runtimes/agent/providers/opencode-capability-attestor.ts`
- Create: `tests/runtimes/agent/opencode-capability-attestor.test.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `src/runtimes/agent/providers/binary-preflight.ts` only if a reusable process-group watchdog seam is needed
- Modify: `tests/runtimes/agent/fallback-chain-selection.test.ts`
- Modify: `tests/runtimes/agent/provider-fallback.test.ts`

- [ ] Define explicit states: `aligned`, `drift`, `blocked`, `not_applicable`, and `inconclusive`, with `checkedAt`, `expiresAt`, runtime/profile/policy fingerprints, and a stable reason code.

- [ ] Add failing static-attestation tests for exact binary/profile selection, absence of
  a static agent model, normalized versioned policy hash, required edit/bash resolving to
  non-interactive allow within the approved roots, every q-pi command/tool/path deny in
  Task 1 resolving to hard deny, a read/edit path escape, privileged/unrelated environment
  key presence, malformed JSON, timeout, and unsupported CLI. Inspect the resolved
  effective profile rather than trusting the checked fixture alone. Emit requested and
  observed environment **key names** only, never values.

- [ ] Add failing dynamic-canary fixtures:

  - parsed edit plus parsed bash verification passes;
  - assistant `OK` without tool events is inconclusive;
  - auto-rejected edit/bash is blocked;
  - a credential superset or privilege-bearing environment is blocked before spawn;
  - a policy whose pattern denies exist without the required environment isolation is blocked;
  - timeout is inconclusive and reaps the process group;
  - binary/profile/policy drift invalidates a cached pass.

- [ ] Implement the attestor behind injected command/process seams. The disposable canary owns its directory and sentinel; production code never performs a dangerous deny command.

- [ ] Key the cache by route, policy, and binary fingerprint. Add a finite TTL and immediate invalidation on any identity change.

- [ ] Make OpenCode fallback selection exclude every state except a fresh `aligned`. Keep report-only rollout explicit through a config/feature gate; the fail-closed branch must already have tests.

- [ ] Run the attestor, fallback selection, model usability, process-tree, and watchdog suites.

- [ ] Commit:

  ```bash
  git commit -m "feat: attest headless fallback tool capability"
  ```

## Task 9: Define Provider Role Policy and Effective Workspace Context

**Files:**

- Create: `src/core/provider-role-policy.ts`
- Create: `tests/core/provider-role-policy.test.ts`
- Modify: `src/config.ts`
- Modify: `src/core/agent-config-validator.ts`
- Modify: `src/core/workspace.ts`
- Modify: `src/instance-loader.ts`
- Modify: `src/main.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `scripts/audit-instance-plugin-coverage.ts`
- Modify: `tests/scripts/audit-instance-plugin-coverage.test.ts`
- Modify: `tests/core/workspace.test.ts`
- Modify: focused config, instance-loader, and sandbox-per-chat tests identified by the compiler
- Modify: `docs/configuration.md`

- [ ] Add failing table tests for the exact enum `agentOptions.providerRole:
  operational|development`. Missing, legacy, or unknown values remain visible as drift
  and cannot harden. The pure resolver returns both requested and effective role policy,
  with a version and stable reason code.

- [ ] Add failing merge tests proving role policy owns only its declared plugin/hook
  keys. Preserve the complete per-instance `enabledPlugins` map and every unrelated
  plugin cohort. `operational` explicitly writes test-integrity false; `development`
  follows its declared policy. Never replace the map with a fleet-wide canonical list.

- [ ] Add adversarial effective-context tests for root and newly provisioned
  sandbox-per-chat workspaces. An operational context is drift if test-integrity is
  enabled through a direct key, an alias-resolved plugin manifest, `pluginDirs`, or a
  direct test-authoring hook class. Operational contexts carry no `pluginDirs`; rejection
  uses resolved manifest/hook identity, not filename text alone. Project trust remains a
  private deployment concern and is not read or returned by this resolver.

- [ ] Propagate the resolved role-owned `enabledPlugins` and hook policy through
  `src/main.ts`, `AgentRuntime`, and `provisionWorkspace()`. The current root-only cached
  value and sandbox provisioning without `enabledPlugins` are red-proof fixtures, not
  acceptable behavior. Prove the effective root and fresh per-chat settings match while
  unrelated per-instance settings survive round-trip.

- [ ] Extend the existing instance-plugin coverage audit rather than creating a second
  inventory. Preserve explicit true/false coverage, add requested/effective role-policy
  evaluation, and output no project-trust path/state.

- [ ] Run the role-policy, validator, instance-loader, root/per-chat workspace, runtime,
  audit, documentation, and typecheck suites.

- [ ] Commit:

  ```bash
  git commit -m "feat: enforce provider role workspace policy"
  ```

## Task 9A: Add Versioned Transactional Role/Plugin Normalization

**Files:**

- Create: `src/fleet/role-plugin-normalizer.ts`
- Create: `tests/fleet/role-plugin-normalizer.test.ts`
- Modify: `src/fleet/routes/ops.ts`
- Modify: `src/fleet/index.ts`
- Modify: `src/fleet/platform.ts`
- Modify: `tests/fleet/routes/ops.test.ts`
- Modify: `tests/fleet/platform-service-manager.test.ts`
- Modify: `src/core/private-config-file.ts` only for reusable validated staging primitives
- Modify: `docs/public-surface.md`

- [ ] Add a dedicated authenticated, versioned mutation seam, for example
  `POST /api/lines/:name/provider-role-normalizations`. Its strict request contains schema
  version, idempotency key, desired role/policy version, and expected SHA-256 fingerprints
  for instance `config.json` and cwd `.claude/settings.json`. Reject missing maintenance
  authorization, symlinks/non-regular files, mismatched fingerprints, stale generation,
  duplicate-key/content conflict, and unknown fields. The generic ops PATCH path must
  reject normalization-only fields and cannot trigger or claim normalization. qFleet may
  call only this WhatSoup-owned seam and may not write host files directly.

- [ ] Add deterministic fault-injection tests around a per-instance lock. Read and retain
  exact prior bytes and modes; compute CAS; derive the Task 9 role-owned overlay while
  preserving unrelated plugin cohorts/settings; clear operational `pluginDirs`; remove
  only role-owned or alias-resolved test-authoring hooks; stage and validate both files;
  drain/stop managers; commit both files; restart; and poll a new runtime generation for
  a fresh-session postflight receipt. A generic single-file atomic rename is not evidence
  of this two-file transaction.

- [ ] For every failure before, between, or after the two commits, restore **both** exact
  snapshots and modes, restart the prior generation, and verify rollback fingerprints.
  A failed restore/restart, unknown manager owner, or ambiguous postflight is `Blocked`,
  quarantines further normalization on that host/cohort, and emits the typed error-model
  record. Retries require the same idempotency key/content and are bounded.

- [ ] Return a redacted receipt with request/schema/policy version, idempotency digest,
  before/after config and settings fingerprints, old/new runtime generation, drain,
  restart, fresh-session postflight, rollback, and terminal status. Never return file
  bytes, private paths, plugin secrets, trust state, or environment values.

- [ ] Prove the existing generic PATCH remains behavior-compatible but cannot claim or
  trigger role normalization. Run normalizer, ops-route, symlink, config-file,
  service-manager, auth/public-surface, fault-injection, and typecheck suites.

- [ ] Commit:

  ```bash
  git commit -m "feat: normalize provider roles transactionally"
  ```

## Task 9B: Expose A-F Health and Redacted Parity Evidence

**Files:**

- Modify: health/provider-status source identified by existing tests
- Modify: `docs/runbooks/fleet-bot-hardening-standard.md`
- Modify: `docs/reliability-runner/fleet-bot-hardening-parity.json`
- Modify: `scripts/check-fleet-bot-hardening-parity.ts`
- Modify: `tests/scripts/check-fleet-bot-hardening-parity.test.ts`
- Modify: `tests/core/health.test.ts`
- Modify: `tests/fleet/routes/provider-status.test.ts`
- Modify: `docs/public-surface.md`

- [ ] Add failing health/provider-status tests for desired/observed route fingerprint,
  mismatch count, configured/observed execution profile, expected/observed policy
  fingerprint, exact runtime identity/generation, capability state/timestamps/reason,
  stale-child count, and pending reconciliation count.

- [ ] Add requested/observed provider role, role-policy version, effective plugin and hook
  classes, config/settings fingerprints, normalization transaction state, and a
  fresh-session receipt tied to the new runtime generation. The trust producer reports
  only whether the selected source was the effective `CLAUDE_CONFIG_DIR` surface or the
  native Claude surface plus normalized requested/observed state; it never reports trust
  paths. macOS TCC is exactly `not_required` unless an operation-specific denial creates
  a separately evidenced requirement.

- [ ] Extend the parity guard's required capabilities with:

  ```ts
  'headless-execution-capability'
  'provider-session-runtime-alignment'
  'provider-role-plugin-alignment'
  ```

- [ ] Update fixtures and the tracked redacted parity manifest. A row cannot be
  `hardened` unless A-F, transactional normalization, effective root/per-chat role state,
  and a fresh-generation receipt are proven. Unset/legacy role, stale receipt, missing
  trust-source selector, plugin/hook ambiguity, or unknown/extra TCC grant is non-hardened;
  accepted exceptions remain explicit and expiring.

- [ ] Implement additive JSON-safe health fields. Do not expose paths, session tokens,
  raw stderr, prompts, credentials, environment values, or private trust state. Update
  standard and public-surface docs in the same commit.

- [ ] Run health, provider-status, parity guard, audit, publication, public-surface,
  documentation drift, and typecheck gates.

- [ ] Commit:

  ```bash
  git commit -m "feat: expose fallback route alignment health"
  ```

## Task 10: Prevent Redaction-corrupted Runbook Commands

**Files:**

- Modify: `src/core/outbound-message-safety.ts`
- Modify: the administrative handoff/report path identified by focused tracing
- Modify: `tests/core/outbound-message-safety.test.ts`
- Modify: focused heal/admin report tests
- Modify: `docs/runbooks/error-response-workflows.md`

- [ ] Add failing tests proving a client-bound command containing an internal absolute path is diverted to a non-command status instead of rewritten into pasteable `[internal-path]` input.

- [ ] Add failing tests proving the authorized operator handoff retains sanitized target role, target user, working directory, and command identifier, while the client receives no target-host shell instruction.

- [ ] Implement a structured classification before path redaction: executable target-host instructions are diverted, ordinary explanatory prose remains redacted and deliverable.

- [ ] Ensure the literal placeholder is never labeled or formatted as a command a client should paste.

- [ ] Run outbound safety, messaging, heal/report, and publication suites.

- [ ] Commit:

  ```bash
  git commit -m "fix: divert redaction-corrupted runbook commands"
  ```

## Task 11: Integrated Verification and Deployment Packet

**Files:**

- Modify: `docs/superpowers/plans/2026-07-15-headless-fallback-runtime-alignment.md` to check completed boxes and append exact evidence
- Create: a redacted local verification artifact only if required by existing repository convention

- [ ] Run focused integration suites for all touched source/test files.

- [ ] Run every applicable row in **Linting, Formatting, and Static Quality Gates** on
  the integrated SHA and bind its complete output to the manifest before the full suite.

- [ ] Run mandatory repository checks:

  ```bash
  bash scripts/run-with-pinned-npm.sh run typecheck:all
  bash scripts/run-with-pinned-npm.sh run guard:fleet-bot-hardening-parity
  bash scripts/run-with-pinned-npm.sh run guard:instance-config
  bash scripts/run-with-pinned-npm.sh run guard:source-runtime-drift
  bash scripts/run-with-pinned-npm.sh run guard:fail-closed-gate
  bash scripts/run-with-pinned-npm.sh run guard:doc-drift
  bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift
  bash scripts/run-with-pinned-npm.sh run guard:publication -- --all
  ```

- [ ] Re-run the complete unmasked test suite:

  ```bash
  bash scripts/run-with-pinned-npm.sh test -- --pool=forks --silent=passed-only
  ```

- [ ] Run the branch push gate only after targeted/full tests are green:

  ```bash
  bash scripts/run-with-pinned-npm.sh run verify:push:branch
  ```

- [ ] Request an independent requirements review and code-quality review. Treat reviewer output as advisory until every decisive diff/test claim is checked locally.

- [ ] Produce and schema-validate a deployment packet for qFleet containing the exact
  Task 9A endpoint/version, maintenance-gate precondition, per-host expected config and
  settings fingerprints, idempotency key rules, desired provider role/policy version,
  requested/observed runtime/profile/policy/plugin/hook state, runtime-generation and
  fresh-session receipt requirements, capability fields, rollout checkpoints, and
  rollback/quarantine controls. qFleet may only invoke the WhatSoup-owned transactional
  seam; it may not mutate host files directly or substitute the generic PATCH endpoint.
  No host mutation occurs in this task, and a missing current qFleet contract keeps fleet
  exit `Not Ready`.

- [ ] Complete the final-SHA documentation, runbook, and DevOps review defined below;
  write `artifacts/documentation_devops_readiness.md`, run every applicable documentation
  and publication guard, and bind the artifact and raw guard output to the manifest.

- [ ] Complete **Final Capability-aware Synthesis and Closeout**, including all 320
  first-hand verification-bank records, final contradiction refresh, capability/history
  disposition, and `artifacts/final_review.md`. This planning review's artifact is not
  implementation proof and must be regenerated on the integrated SHA.

- [ ] Commit final evidence/doc updates:

  ```bash
  git commit -m "docs: record headless fallback verification"
  ```

## Documentation, Runbook, and DevOps Readiness

Before final synthesis, the documentation/publication owner and deployment owner must
review the integrated SHA against every behavioral, operational, and deployment surface
named in this plan. The review is evidence work, not a prose sign-off: it must enumerate
the exact files and surfaces inspected, cite final-SHA guard output, and write
`artifacts/documentation_devops_readiness.md`. Use only `Pass`, `Fail`, `Inconclusive`,
or `Blocked`; until source implementation, final-SHA checks, and the applicable deployment
contract evidence exist, the current review verdict remains `Inconclusive`.

| Surface | Required documentation or DevOps deliverable | Reproduction and acceptance rule | Blocking condition | Owner and evidence |
|---|---|---|---|---|
| Configuration and policy | Update `docs/configuration.md` for the exact reserved selector, fleet-owned agent policy, credential allowlist, provider role/policy version, plugin/hook exclusions, static attestation inputs, and effective workspace context. WhatSoup must not carry a second policy template or synthesize an inline agent. | A fresh operator can derive the same canonical config/settings fingerprints and distinguish requested from observed state without reading implementation code. | Undocumented field/default, duplicate/ambiguous policy ownership, secret-bearing example, or unsupported OpenCode interface is `Blocked` for rollout. | Task 1/9 owner; config diffs, schema tests, and `artifacts/task-09/config-doc-review.md` |
| Public and health contracts | Update `docs/public-surface.md` for additive A-F health, route identity, lifecycle, staleness, redaction, and readiness semantics. | Run exact-shape consumer, redaction, doc-drift, public-surface, and publication guards on the final SHA; missing/stale fields must never imply hardening. | Breaking or sensitive field, undocumented consumer impact, or nonzero/masked guard is `Fail`. | Task 9B/publication owner; `artifacts/task-09/health-consumers.txt` and documentation-guard output |
| Operator runbooks | Update `docs/runbooks/fleet-bot-hardening-standard.md` and `docs/runbooks/error-response-workflows.md` with preflight, canary, phased rollout, quarantine, rollback, recovery from mixed-lane/resume errors, non-empty client error handling, and wrong-host escalation. | A clean-room operator can follow target host/user/workspace prerequisites and stable command identifiers; client-visible text never contains a pasteable target-host command or `[internal-path]` placeholder presented as one. | Missing host/user prerequisite, direct-file workaround, destructive rollback, client shell instruction, or unowned recovery step is `Blocked`. | Tasks 9A/10 owner; runbook rehearsal and outbound-safety evidence |
| Dashboards and alerts | Register the required events, A-F capability fields, runtime generation, config/settings fingerprints, route/session correlations, reason codes, staleness window, and fleet numerator/denominator on the provider-status/parity surfaces. Define alerts for rejected tools, invalid resume identity, mixed managers, stale/unknown attestation, normalization failure, and blank client error detail. | Replay the named failure fixtures and show that each alert identifies the affected line, route, generation, stage, and safe operator action without exposing paths, prompts, tokens, or environment values. | A silent condition, false-aligned dashboard, missing correlation, unbounded-cardinality field, or sensitive output is `Fail`. | Observability and Task 9B owners; telemetry/replay records and `artifacts/task-11/dashboard-alert-review.md` |
| CI and release workflows | Confirm the existing pre-commit/pre-push and quality/tag-release workflows execute all applicable type, lint, test, guard, documentation, and publication checks through the pinned runtime; add only the minimum missing wiring. | Capture hook/CI definitions, final-SHA local equivalents, required-job names, and branch-protection applicability; a local hook alone is not CI proof. | Unwired required guard, ambient-runtime-only proof, bypass, skipped required job, or release path that omits the contract is `Fail`. | A27/release owner; `artifacts/automation/` and `artifacts/task-11/release-workflow-review.md` |
| Deployment and normalization | Publish the schema-validated qFleet packet, maintenance and CAS preconditions, host inventory, phased checkpoints, idempotency rules, fresh-generation/session receipts, quarantine controls, and rollback authority. The packet invokes only Task 9A's transactional seam. | Rehearse schema validation and dry-run/no-mutation behavior, then require per-host pre/post fingerprints and capability canaries during an authorized rollout. | Missing current qFleet contract/authority, generic PATCH/direct host mutation, partial commit, stale manager, or absent rollback receipt is `Blocked`. | Task 9A/deployment owner; deployment packet, dry-run result, and per-host receipts |
| Environment, permissions, and private state | Document service-context environment requirements and the private evidence procedure for credential superset, Keychain visibility, operation-specific TCC, project trust, and path access; public artifacts contain classifications/digests only. | Reproduce each probe in the same launchd/user/working-directory context as the service and compare requested versus observed state; terminal/SSH probes cannot substitute for service context. | Blanket TCC, leaked secret/path, wrong-user proof, unverifiable private record, or extra credential is `Fail`; unavailable authorized observation is `Blocked`. | Fleet/security owner; private deployment evidence references plus redacted manifest entries |
| Open operational risks | Carry every unresolved assumption and failure mode into the readiness artifact with severity, affected checkpoint, containment, owner, evidence needed, and due checkpoint. | Cross-check A01-A13, readiness, contradiction, regression, guardrail, and final-review records; no repository-green result closes a fleet risk. | Missing owner/containment, stale evidence, conflated source/fleet readiness, or unsupported `Pass` is `Inconclusive` or `Blocked` as applicable. | Task 11 lead; readiness and final-review artifacts |

The readiness artifact must contain the exact headings `## Sections updated`,
`## Major cross-pass upgrades`, `## Documentation and DevOps deliverables`,
`## Unresolved risks`, `## Current verdict`, and
`## Reproduction-ready deliverables`. Under those headings, map every changed behavior to
its documentation/runbook/alert/deployment consumer, list exact commands and artifact
paths needed to reproduce the decision, and record the current verdict. Documentation is
complete only when all applicable files, guards, operator steps, dashboard/alert contracts,
environment/config changes, and deployment surfaces are accounted for on the same final
SHA. Otherwise the verdict is `Inconclusive` when valid proof is pending or `Blocked`
when a safe prerequisite, interface, owner, or authority is missing.

## Final Capability-aware Synthesis and Closeout

After A27-A29 evidence is assembled and before any `complete`, `merge-ready`, or
fleet-aligned language, the lead must freshly reread this entire plan and the complete
manifest-linked evidence tree. Write `artifacts/final_review.md`, refresh
`artifacts/contradiction_check.md`, and bind both to the same final Git SHA, capability
inventory digest, test/guard receipts, and documentation/DevOps review. This planning
revision's current final verdict is `Inconclusive`: it defines an executable closeout,
but no source implementation, final-SHA suite, remote CI, or authorized installed-fleet
observation has been completed.

### Final synthesis inputs and decision rules

| Input | Required first-hand closeout check | Non-pass condition |
|---|---|---|
| Internal consistency | Compare objective/scope, A01-A13, A00-A29 dependencies, error/telemetry contracts, readiness, contradiction, rollback, source/fleet exit, and every final checked box against the final diff and artifacts. | Contradiction, stale claim, hidden dependency, unsupported completion wording, or source/fleet conflation is `Fail` or `Inconclusive`. |
| Capability sufficiency | Re-attest required tools/scripts/skills/agents/plugins/MCPs/runtime from **Capability inventory and historical context**; compare requested and observed state. | A missing capability required for the next safe check is `Blocked`; configured-only or optional evidence remains `Inconclusive`. |
| Historical context | Run the Git audit below and perform the optional read-only Pinecone q-pi/headless/fallback search when available; record why each selected record is or is not applicable to current source. | Missing Git audit is `Blocked`; absent or unverified Pinecone context is `Inconclusive` when it could materially change reuse/risk conclusions and never current proof. |
| Deterministic validation | Reconcile TDD provenance, negative/mutation controls, replay/fault injection, assertion counts, full unmasked final-SHA tests, guards, push gate, and independent reproduction. | Mock-only, nondeterministic, masked, skipped, stale, ambient-runtime, missing-population, or artifact-free evidence cannot be `Pass`. |
| Documentation and operations | Re-run the documentation/DevOps readiness matrix, runbook rehearsal, public/consumer guards, alert replay, release workflow review, deployment-packet schema check, and private-evidence reference audit. | A changed behavior without its operator/public/deployment consumer, or an unreproducible instruction, is `Fail`/`Blocked`. |
| Open risk and authority | Reconcile every unresolved assumption/finding with owner, severity, containment, due checkpoint, evidence needed, rollout/rollback authority, and next allowed action. | Unowned or hidden risk, missing authority, unsafe workaround, or expired exception keeps the dependent gate `Not Ready`. |

Git historical evidence must capture `git status --short --branch`, `git rev-parse HEAD`,
merge bases and ahead/behind counts for `main` and `origin/main`, upstream state,
`git log --all`/`git show` for selected history, `git range-diff` and `git cherry -v`
before treating a branch as superseded, tracked/ignored status for every required plan and
artifact, and the full merge-base-to-HEAD diff. Pinecone use is read-only: record the
exact query, index/namespace when disclosed, record IDs/scores/dates, and a current-source
verification disposition; semantic retrieval never overrides Git/source/runtime proof.

Remaining live nondeterminism—installed OpenCode versions/event shapes, provider/network
behavior, same-service-context Keychain/TCC/trust, qFleet inventory, host generation,
canary result, and rollout state—must use bounded timeouts, redacted fingerprints,
freshness/expiry, replay fixtures, and per-host receipts. If it cannot decide the claim,
record `Inconclusive`; if a safe prerequisite or authority is absent, record `Blocked`.

### Mandatory first-hand verification bank

Preserve the exact 320-question A-T bank from the rendered final-review prompt as
`artifacts/final-review-bank/question-bank.md` with its digest; chat summaries or inherited
agent memory are not a substitute. Answer every ID exactly once in category artifacts
and index them in `artifacts/final-review-bank/index.json`. The incoming bank's `PARTIAL`
label is normalized to this plan's `Inconclusive`; only `Pass`, `Fail`, `Inconclusive`,
or `Blocked` may appear as the stored verdict.

```text
Question ID:
Verdict: Pass | Fail | Inconclusive | Blocked
Evidence:
- File path and reviewed Git blob/SHA:
- Line range:
- Function/class/export/test name:
- Command run and raw-output artifact:
- Output summary and assertion/population count:
- Exact plan section/task affected:
- Required plan revision (exact patch disposition or evidence-backed none):
- Follow-up owner and due checkpoint:
```

`Pass` is invalid without first-hand source, line/symbol/test, command, raw output, and
plan-disposition evidence. Ban unsupported “appears,” “probably,” “seems,” or “should.”
For questions whose premise names an absent guard-engine feature such as `runCycle`,
`EventKind`, mute/dedup/storm/watchdog/sink chains, retain the exact question and record
`Inconclusive` with complete negative symbol/path searches plus the applicable WhatSoup
scope/non-goal; do not silently rename it to an analogous feature. If an exact WhatSoup
mapping exists, state both names and prove the production call chain. Mock, simulator,
unit, integration, disposable-process, local runtime, remote CI, and live-fleet evidence
must remain separately labeled.

The bank is partitioned only for context control: A1-A15 repository/release; B16-B30
traceability; C31-H130 runtime, durable audit, delivery/suppression, fail-closed, and
watchdog premises; I131-K180 policy, collectors/runtime realism, and operator docs;
L181-P260 tests, security, resilience, DRY, and dead surfaces; Q261-Q275 simulator proof;
R276-T320 plan revision, orchestration, and merge readiness. Each bounded read-only
reviewer receives exact question text, allowed paths, output schema, lease, and no
delegation or mutation authority. Durable artifacts—not agents or transcripts—are the
handoff. The lead compares contradictions, checks decisive evidence directly, and does
not average verdicts.

The final review artifact must contain the exact headings `## Sections updated`,
`## Major cross-pass upgrades`, `## Final capability-aware synthesis`,
`## Pinecone and git historical-context summary`, `## Unresolved risks`, and
`## Reproduction and closeout steps`, plus a labeled `Final verdict:` using the four
allowed verdicts. `Pass` is allowed only when the bank is complete, every applicable
high-severity finding is closed, all final-SHA source gates and required remote CI are
green, documentation/operations are reproducible, and no unresolved risk contradicts
the claimed source gate. Fleet exit still requires the separate authorized per-host
qFleet proof.

## Final Review and Handoff

This plan file is the handoff index and single source of truth. A fresh operator must not
need the planning chat. Hand off the final Git SHA together with
`artifacts/run_manifest.json` and the evidence tree; do not hand off detached prose or
artifacts whose SHA/runtime fingerprint differs from the plan's final evidence set.

### Required handoff contents

| Handoff element | Canonical plan section or artifact | Acceptance rule |
|---|---|---|
| Objective, scope, and non-goals | **Objective, Scope, and Exit Criteria** | S1-S6 and source/fleet exit remain separately measurable |
| Assumption register | **Assumption Audit** A01-A13 | Every unresolved assumption retains owner, due checkpoint, validation, and fail-closed disposition |
| Validation findings | `artifacts/primary_validation.md`, `artifacts/validation_layer2.md`, `artifacts/validation_layer3.md` | Findings name severity, evidence, disposition, and residual risk; a skipped mandatory layer is `Blocked` |
| Readiness decision | **Execution Readiness Gate** and `artifacts/readiness.json` | Source-start, source-exit, and fleet-rollout decisions are separate and use the four allowed verdicts |
| Decomposed task map and order | **Molecular Task Decomposition** A00-A29 | Dependencies and one-owner write scopes are explicit; no unbounded packet is dispatchable |
| Verification rules | **Primary Validation Gate**, **Layered Validation Escalation**, and **Verification Design** | Every claim has an exact method, threshold, final-SHA artifact, and escalation path |
| Logging and observability | **Logging, Observability, and Replay Contract** | Mandatory events, correlations, exclusions, and replay/retention ownership are covered |
| Documentation and DevOps readiness | **Documentation, Runbook, and DevOps Readiness** and `artifacts/documentation_devops_readiness.md` | Final-SHA docs, runbooks, alerts, workflows, config/environment, deployment surfaces, reproduction steps, and unresolved risks are complete and mutually consistent |
| Capability-aware final synthesis | **Final Capability-aware Synthesis and Closeout**, `artifacts/final-review-bank/`, and `artifacts/final_review.md` | All 320 records are first-hand and indexed; capability/history/nondeterminism/docs/risks agree with final-SHA and CI evidence |
| Testing and provenance | **Testing and Anti-fabrication Standard** | Red proof, assertion counts, fixture provenance, replay inputs, raw output, and independent checks are recorded |
| Execution detail | **Baseline and Setup** plus Tasks 1-11 | Commands use the pinned wrapper and execute in dependency order |
| Open risks and blockers | A01-A13, readiness record, and final reviews | Unsupported runtime/policy interfaces, missing qFleet contract, or stale live evidence cannot be relabeled as pass |
| Rollback and containment | A18, A21, A24, A29 and task rollback clauses | Disable fallback admission and retire mismatched managers; retain additive schema/evidence and never restore provider-blind resume |

The source handoff must explicitly list remaining risks. At minimum, until fresh evidence
closes them, include installed OpenCode version/profile-policy compatibility, the exact
static inspection interface, qFleet inventory and output schema, service-context and
operation-specific TCC observations, private project-trust state, requested/observed
provider role and plugin set, evidence retention window, rollout authority, and rollback
authority. Missing live evidence blocks only the checkpoint that depends on it; it must
never be hidden by repository-green evidence.

### Reproduce this run

Start only from the intended implementation branch in this worktree with no unexplained
changes, readable lockfiles, the pinned runtime available, and permission to create a
fresh non-secret `artifacts/` directory. Required tools are Git, Bash, the repository's
pinned Node 24.15.x/npm lane, and the repository test/guard dependencies installed by the
pinned `ci` commands. Record the exact OpenCode version and supported `run --help`
surface before using its output as evidence. qFleet and macOS permission inspection are
deployment-owner tools and are not prerequisites for source-only Tasks 1-11.

Reproduce source evidence in this order, capturing each command, exit code, version,
assertion count, output path, SHA, and verdict in `artifacts/run_manifest.json`:

```bash
git rev-parse --show-toplevel
git status --short --branch
git log -2 --oneline
bash scripts/run-with-pinned-npm.sh exec -- node --version
bash scripts/run-with-pinned-npm.sh ci
bash scripts/run-with-pinned-npm.sh --prefix console ci
bash scripts/run-with-pinned-npm.sh test -- \
  tests/runtimes/agent/primary-model-usability-adapters.test.ts \
  tests/runtimes/agent/opencode-child-env.test.ts \
  tests/runtimes/agent/providers/opencode-parser.test.ts \
  tests/core/session-lifecycle-store.test.ts \
  tests/runtimes/agent/provider-fallback.test.ts \
  --pool=forks
```

Then execute A01-A29 in dependency order and finish with every Task 11 command exactly as
written. Expected handoff artifacts are the manifest; readiness, changed-file, public-
surface, primary-validation, layered-validation, verification-matrix, telemetry/replay,
per-task test-provenance, final-review, and deployment-packet records named throughout
this plan, including `artifacts/capability_inventory.md`,
`artifacts/documentation_devops_readiness.md`, the complete
`artifacts/final-review-bank/`, and `artifacts/final_review.md`. An absent artifact,
stale SHA, missing assertion count, truncated output, or
unknown tool version is non-pass. A fresh operator must create new run-scoped evidence;
never overwrite the previous evidence set or infer success from checked boxes.

Standalone SBOM creation is outside this source-change plan because it adds no new
release packaging path. Before deployment, preserve lockfile digests and verify any SBOM
or build provenance already produced by the repository release pipeline against the
final Git SHA; if that pipeline has no such output, record `not available` rather than
claiming attestation. The final branch/push-gate output, manifest digest, exact tool
versions, and qFleet deployment-packet digest are the required provenance for this work.

### Final review checklist

Before source exit, two independent reviewers must check the final diff and evidence for:

- missing dependencies, hidden write overlap, or execution-order violations;
- unresolved critical assumptions without fail-closed containment;
- weak, masked, skipped, stale, or assertion-free verification;
- vague readiness language that conflates source readiness with fleet alignment;
- unbounded tasks, missing owner/rollback logic, or partial-success paths;
- missing mandatory telemetry, correlation, redaction, retention, or replay proof;
- missing test/fixture provenance or anti-fabrication controls;
- unsupported claims about OpenCode policy, TCC, project trust, qFleet, installed state,
  provider role, plugin set, or fleet-wide alignment.
- ignored/untracked required plans, incomplete first-hand bank rows, foreign-premise
  questions silently skipped, or Pinecone/Git history treated as current behavior.

Record both reviews in `artifacts/task-11/reviews.md`, cite decisive source/tests, and
reproduce disputed claims. Handoff is complete only when a fresh operator can verify the
current decision from named artifacts and safely begin the next allowed action. Otherwise
the handoff verdict is `Inconclusive` or `Blocked`, with the exact missing evidence and
owner recorded.

## Completion Contract

Source work is complete only when this plan is tracked, all focused tests, full tests,
typecheck, guards, independent reviews, documentation/DevOps readiness, and the complete
first-hand final bank pass without masking on one reviewed SHA with required remote CI.
Fleet completion is a separate qFleet outcome and requires exact installed-runtime
evidence from every in-scope host; repository green alone must never be reported as
fleet aligned.
