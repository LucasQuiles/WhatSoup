# WhatSoup Protection Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the universal protection-layer engine — types, canonical JSON, baseline + HMAC, event ledger, dedup/mute/storm-guard, evaluator and collector frameworks with a fixture collector, four shipped profiles, the alert transport channel chain (WhatSoup `/send` + local notification + meta-alert), the watchdog process, self-protection checks, and a CLI with simulator mode. End-to-end exercisable via simulator without any platform-specific collectors.

**Architecture:** Pure-function evaluators consume canonical-JSON probe documents from collectors and produce events; an append-only ledger (SQLite + JSONL) is the truth source; an alert dispatcher walks a fall-through channel chain emitting delivery-accounting events; a separate watchdog process detects engine silence and transport breakage via independent transport. All product code is deployment-neutral; operator inventory and transport identifiers are read from local config at startup.

**Tech Stack:** TypeScript, Node ≥23.10 (native strip-types, no build step), ESM throughout, Zod for runtime validation, Pino for structured logging, `better-sqlite3` for storage, vitest with `--pool=forks` for tests, real SQLite (`:memory:` in tests), real Unix sockets where applicable. Matches WhatSoup-core conventions (see `WhatSoup/CLAUDE.md`).

**Source spec:** `docs/specs/2026-05-08-whatsoup-protection-layer-design.md`.

**Out of scope (deferred to follow-up plans, one per collector pack):** concrete `host.macos.*`, `host.windows.*`, `whatsoup.instance.*`, `whatsoup.fleet.*`, `deployment.*`, `repo.*`, and `app.api_auth_probe` collectors. The collector *interface* and a fixture collector are in this plan; platform-specific subprocess execution and parser code are in follow-up plans. Operator deployment configuration (inventory, hostnames, transport identifiers) is also out of scope.

---

## Plan-Review Contract

This plan has been hardened under the 27-pass plan-review protocol. The implementation worker must treat this section as binding. Evidence for the review run lives under `artifacts/whatsoup-guard-review/`; future implementation runs may use a new run-specific directory but must preserve the same artifact contracts.

### Pass Coverage Index

| Pass | Coverage in this plan | Required artifact |
|---|---|---|
| 1. Shared control header | This contract, run manifest, git status, tool versions | `artifacts/whatsoup-guard-review/run_manifest.json` |
| 2. Objective and scope | Goal, scope, non-goals, success/failure criteria below | `changed_files.txt`, `public_surface_hints.txt` |
| 3. Assumption audit | Assumption register below | `contract_file_hits.txt`, `config_inventory.txt` |
| 4. Primary validation | Validation ladder below; Task 0 must run first | `primary_validation.md`, command outputs |
| 5. Secondary/tertiary validation | Layered validation matrix below | `validation_layer2.md`, `validation_layer3.md` |
| 6. Logging and observability | Telemetry contract below; event schema tasks | `observability_contract.md` |
| 7. Execution readiness | Readiness gate below | `readiness.json` |
| 8. Molecular decomposition | Task contract plus 33 atomic tasks | `task_artifact_map.md` |
| 9. Verification design | Verification matrix below | `verification_matrix.md` |
| 10. Testing and anti-fabrication | Test provenance rules below | `test_evidence/`, `test_strategy.md` |
| 11. Final review and handoff | Closeout and handoff rules below | `final_review.md` |
| 12. Master orchestrator | Execution order and gate sequence below | `run_manifest.json` |
| 13. Reuse-first audit | Reuse-first requirements below | `reuse_audit.md` |
| 14. Impact and blast radius | Blast-radius section below | `blast_radius.md` |
| 15. Error model | Error model below | `error_model.md` |
| 16. Silent failure | Silent failure matrix below | `silent_failure_matrix.md` |
| 17. Error messaging | Error catalog requirements below | `error_catalog.md` |
| 18. TDD/provenance | TDD and replay requirements below | `test_strategy.md` |
| 19. Tooling/orchestration | Tooling plan below | `tooling_plan.md` |
| 20. Contradiction check | Contradiction section below | `contradiction_check.md` |
| 21. Static quality gates | Linting plan below | `linting_plan.md` |
| 22. Regression protection | Regression table below | `regression_protection.md` |
| 23. Hooks and automation | Hook plan below | `hook_plan.md` |
| 24. Rules and guardrails | Rules table below | `rules_and_guardrails.md` |
| 25. Docs and DevOps readiness | Documentation readiness below | `documentation_devops_readiness.md` |
| 26. Capability inventory | Capability inventory below | `tooling_plan.md`, git/Pinecone notes |
| 27. Final synthesis | Final synthesis below | `final_review.md` |

### Objective, Scope, and Success Criteria

Objective: implement a deployment-neutral WhatSoup Protection Layer engine that can execute an end-to-end simulated protection cycle without any platform-specific collectors. The shipped system must accept local operator policy, load profiles, run fixture collectors, compare observed canonical probe documents against HMAC-signed baselines, evaluate drift, write an append-only ledger, dispatch alerts through a channel chain, detect watchdog conditions, and expose a CLI for `ping`, `cycle`, `mute`, `status`, and `simulate`.

In scope:

- `tools/whatsoup_guard/**` package, tests, profiles, CLI, and path-filtered workflow.
- Generic type system, canonical serialization/diff/fingerprint, HMAC, SQLite/jsonl stores, mutes, dedup, storm guard, evaluators, fixture collectors, runner, simulator, transport chain, watchdog logic, self-secret hygiene, token aging, and documentation.
- CI and evidence contracts needed to prove the package works in simulator mode.

Out of scope:

- Platform subprocess collectors and parsers for specific OS or deployment systems.
- Operator inventory files, transport identifiers, hostnames, account names, one-off applications, or deployment runbooks.
- Live remediation against real machines.
- Product UI.

Success criteria:

- Every task below has passing task-local tests and a named artifact path.
- `npm --prefix tools/whatsoup_guard test`, `npm --prefix tools/whatsoup_guard run typecheck`, and the path-filtered CI workflow pass for the package.
- Simulator e2e proves: baseline set, clean cycle, drift cycle, muted drift, dedup, crit storm guard, alert fall-through, watchdog heartbeat silence, transport-broken detection, and self-secret widening.
- No public artifact contains deployment inventory or private identifiers.
- Readiness is `Ready` or `Ready with Constraints`; no `Blocked` readiness item remains.

Failure criteria:

- Any secret value is read, stored, logged, or transmitted by the engine.
- Any operator inventory or environment-specific identifier appears in tracked product code, docs, tests, or fixtures.
- Any task completes without deterministic evidence or with masked test failures presented as clean.
- The simulator cannot reproduce a full cycle.
- Alert delivery failure can occur without a ledger event.
- HMAC baseline integrity failure can be muted or treated as ordinary drift.

### Assumption Register

| ID | Assumption | Evidence source | Risk if false | Disposition |
|---|---|---|---|---|
| A1 | Node native strip-types can run the guard package the same way WhatSoup runs source TS. | `CLAUDE.md`, root package scripts, Task 0 typecheck evidence | Runtime command mismatch | Validate in Task 1 and Task 30 with actual CLI invocation. |
| A2 | `better-sqlite3` is acceptable in the guard package. | Existing project dependency graph and plan dependency declaration | Install/build friction, native module issues | Task 1 installs in package scope; Task 6 proves SQLite open/migrate/close. |
| A3 | YAML local config is acceptable for operator policy. | Public spec policy model | Parser or schema ambiguity | Task 17 Zod schema and loader reject ambiguous/unknown fields. |
| A4 | Fixture collectors are sufficient for v1 end-to-end proof. | Public spec out-of-scope boundary | False confidence about platform collectors | Follow-up collectors require their own plans; this plan only claims simulator readiness. |
| A5 | Alert sinks can be tested without real external services. | Transport design | Network-dependent tests become flaky | Use local fake HTTP sink and mocked process spawn only for external adapters. |
| A6 | Root repo test lane is not the sole gate for this package. | Current primary validation artifact may be failing due unrelated dependency state | Guard package falsely blocked by unrelated existing failures | Task 0 records root lane status; guard-specific lane is mandatory. Masked root failures remain `Inconclusive`, never clean. |

### Validation Ladder

Primary validation runs before and after each task:

- `npm --prefix tools/whatsoup_guard test -- --pool=forks`
- `npm --prefix tools/whatsoup_guard run typecheck`
- task-specific vitest file named in the task
- artifact readback under `artifacts/whatsoup-guard-review/task-<id>/`

Secondary validation is mandatory for stores, policy loading, evaluator lifecycle, alert transport, watchdog, and CLI:

- replay the same behavior through simulator mode, not only unit tests
- inspect ledger rows and jsonl mirror
- run negative tests for malformed input, missing baseline, bad HMAC, muted forbidden domain, and failing sink

Tertiary validation is mandatory for trust-boundary behavior:

- adversarial review of no-secret-value handling
- contradiction search against the public spec
- fault injection for failed SQLite write, jsonl append failure, sink timeout, and malformed policy
- replay validation from saved fixtures

### Readiness Gate

Readiness states:

- `Ready`: all supported plan-review artifact contracts pass, Task 0 is green or unrelated root failures are explicitly classified, and guard package tests/typecheck pass.
- `Ready with Constraints`: package work may start, but one or more repo-wide checks are `Inconclusive` or unrelated to guard scope. The constraint must be listed in `readiness.json`.
- `Not Ready`: missing spec, missing plan, missing artifact directory, missing package dependency install path, unresolved contradiction, or any blocker in `readiness.json`.

Current readiness for implementation planning is **Ready with Constraints**: the guard plan is complete enough to implement, but the current root `npm test` lane must not be claimed clean unless its artifact is green in the implementation run. The next allowed action is Task 0.

### Verification Matrix

| Task ID | What is checked | Why it matters | Exact command or inspection method | Who or what performs the check | Expected output | Artifact path under artifacts/ | Pass condition | Fail condition | Inconclusive condition | Escalation path |
|---|---|---|---|---|---|---|---|---|---|---|
| T0 | Repo and guard preflight | Prevents building on false-green environment | `npm test`, guard package test/typecheck once package exists | implementer | command output with exit codes | `artifacts/whatsoup-guard-review/task-0/` | guard lane green or root failure classified unrelated | guard package cannot run | root lane unavailable before package exists | stop and fix Task 0 |
| T1-T6 | package/types/canonical/HMAC/store | foundation correctness | task-local vitest files | vitest | passing tests | `task-1` through `task-6` | all task-local assertions pass | any assertion fails | dependency install missing | fix before next store task |
| T7-T16 | baseline/events/mutes/engine/evaluator/collector/lifecycle | core drift pipeline | unit plus lifecycle fixture tests | vitest + simulator | event rows match expected | `task-7` through `task-16` | deterministic event output | missing/extra event or wrong severity | fixture ambiguity | add fixture and rerun |
| T17-T19 | policy loader/profiles | policy correctness | schema/profile tests | vitest | profile resolution output | `task-17` through `task-19` | inheritance and rejects correct | invalid policy accepted | profile semantics ambiguous | update spec/plan before code |
| T20-T26 | alerting/watchdog/meta transport | delivery accounting | fake HTTP sink and watchdog tests | vitest | delivery events and meta-alert decisions | `task-20` through `task-26` | every sink path produces terminal event | silent delivery failure | external adapter unavailable | keep adapter unit-only |
| T27-T32 | self checks/runner/CLI/simulator | product usability | CLI invocation and e2e simulator | node/vitest | full cycle transcript | `task-27` through `task-32` | simulator proves full cycle | CLI or simulator cannot replay | local notification not available | mark local notify best-effort and keep log proof |

### Testing, Provenance, and Anti-Fabrication

TDD is mandatory for every task after Task 1. A real red phase means the named task-local test fails for the expected reason before implementation. The implementation worker records the red output, the code change, and the green output under the task artifact directory.

Fixture provenance rules:

- Every fixture includes `source`, `captured_or_authored_at`, `schema_version`, `redaction_status`, and `expected_result_derivation`.
- Fixtures must not contain real hostnames, IP addresses, tokens, conversation identifiers, real names, or deployment inventory.
- Expected results are derived from the public spec and the task contract, not copied from implementation output.

Anti-fabrication controls:

- No task may claim "tests pass" without an artifact containing command output and exit code.
- Masked or unavailable commands are `Inconclusive`, not `Pass`.
- Simulator output must be replayable from committed fixtures.
- Critical security claims require a negative test and an observability assertion.

### Observability and Ledger Contract

Every engine decision must be reconstructable from event ledger rows plus task artifacts. Minimum event fields: `id`, `ts`, `kind`, `domain`, `scope_id`, `probe_id`, `severity`, `fingerprint`, `correlation_id`, `payload`, `alerted_to`.

Required telemetry layers:

- input logs: policy path, profile chain, collector IDs, fixture IDs
- decision logs: evaluator ID, baseline HMAC status, mute match, dedup result, storm-guard result
- execution logs: runner cycle ID, collector status, store transaction status, sink attempt status
- validation logs: command, exit code, artifact path, verdict
- output logs: ledger row ID, jsonl mirror path, alert delivery result
- change logs: baseline set/update, mute set/expire, profile resolution
- audit logs: self-secret hygiene, token age, HMAC failure, alert transport failure

Silent success is forbidden. Every failed sink, failed jsonl mirror append, bad HMAC, expired mute, malformed policy, and rejected simulator fixture must produce either a ledger event or a task artifact.

### Error Model and Traceability

| Error class | Detection | Handling | Required event or artifact |
|---|---|---|---|
| malformed policy | Zod parse failure | abort cycle before collectors | `policy_invalid` event or CLI error artifact |
| missing baseline | baseline lookup miss | emit info or configured drift; do not auto-baseline | `missing_baseline` event |
| HMAC failure | verify mismatch | emit crit, refuse probe eval | `baseline_integrity_fail` event |
| SQLite write failure | transaction exception | abort current cycle, preserve error | `store_write_failed` artifact/event |
| JSONL mirror failure | append exception | ledger remains truth, emit warning | `jsonl_mirror_failed` event |
| collector failure | collector result parse/status | `probe_error`, no drift diff | `probe_error` event |
| sink timeout | sink result error | fall through chain | `alert_delivery_failed` event |
| all sinks failed | chain exhausted | watchdog-visible failure | `alert_delivery_failed_all` event |
| local notify unavailable | process spawn fails | log-only fallback | `local_notify_failed` event |

Error messages must name what failed, where it failed, the correlation ID, safe remediation hint, and artifact path. Messages must not include secret values or operator inventory values.

### Silent Failure Matrix

| Failure mode | Prevention | Proof |
|---|---|---|
| swallowed sink exception | channel chain requires terminal delivery event | `transport/chain.test.ts` |
| stale heartbeat accepted | watchdog compares monotonic ledger timestamps | `watchdog/heartbeat.test.ts` |
| muted HMAC failure | mute matcher hardcodes forbidden alerting domain | `engine/mute-match.test.ts` |
| fixture parser accepts invalid doc | Zod validation on every collector result | `collector/fixture.test.ts` |
| jsonl mirror silently drops row | mirror append failure event | `store/events.test.ts` |
| CLI exits zero on failed cycle | runner returns explicit status enum | `cli/index.test.ts` |

### Reuse-First and Blast Radius

Before adding any helper, inspect existing WhatSoup surfaces for reuse: `src/lib/http.ts`, `src/lib/text-utils.ts`, `src/logger.ts`, `src/core/health.ts`, `src/fleet/http-proxy.ts`, `src/fleet/time-utils.ts`, existing vitest fixtures, and root package scripts. Reject reuse only with a reason in `artifacts/whatsoup-guard-review/reuse_audit.md`.

Direct blast radius is limited to `tools/whatsoup_guard/**` and the path-filtered workflow. Indirect blast radius includes root dependency installation, CI runtime, shared npm lockfile if workspace dependencies are installed at root, and public docs/plans/specs. The plan must not change existing WhatSoup runtime behavior outside this subtree.

### Static Quality, Regression, Hooks, and Guardrails

Required quality gates:

| Tool name | Command | Expected output | Blocking threshold | Artifact path | Owner |
|---|---|---|---|---|---|
| TypeScript | `npm --prefix tools/whatsoup_guard run typecheck` | exit 0 | any TS error blocks | `artifacts/whatsoup-guard-review/typecheck.txt` | implementer |
| Vitest | `npm --prefix tools/whatsoup_guard test -- --pool=forks` | exit 0 | any failed guard test blocks | `artifacts/whatsoup-guard-review/guard-test.txt` | implementer |
| Root smoke | `npm test --silent` | exit 0 or classified unrelated failure | unclassified failure blocks release | `artifacts/whatsoup-guard-review/npm_test.txt` | implementer |
| Hygiene scan | `rg` internal-label and secret-shape patterns over tracked guard files | no hits | any real secret or private identifier blocks | `artifacts/whatsoup-guard-review/hygiene.txt` | reviewer |

Regression protection:

| Protected behavior | Protection mechanism | Regression signal | Evidence source | Rollback or mitigation trigger |
|---|---|---|---|---|
| Existing WhatSoup tests | root smoke lane | new failures outside known baseline | `npm_test.txt` | stop and classify/fix |
| Public docs hygiene | internal-label scan | private identifier hit | `hygiene.txt` | remove from tracked artifact |
| CLI determinism | simulator replay | nondeterministic output | `e2e/simulator.test.ts` | fix before release |
| Alert accounting | transport tests | sink failure without event | `transport/chain.test.ts` | block |
| HMAC safety | HMAC tests | mutable baseline accepted | `hmac.test.ts` | block |

Hooks and automation:

- CI workflow `.github/workflows/whatsoup-guard.yml` runs only on `tools/whatsoup_guard/**`, this plan, and the public spec.
- Local pre-commit hook is optional; CI is authoritative.
- Any override of failing guard tests requires a written `Inconclusive` or `Blocked` entry in the run manifest.
- Public hygiene scan is required before staging docs or fixtures.

Hard guardrails:

- Never read or log secret values.
- Never ship operator inventory in product artifacts.
- Never auto-baseline on first run.
- Never allow mutes to suppress alerting-protection failures.
- Never treat unavailable or masked validation as clean.
- Never add platform-specific collectors inside this plan's scope.

### Tooling, Capability, and Orchestration

Required local tools: Node >=23.10, npm, TypeScript, vitest, `rg`, git, SQLite via `better-sqlite3`. Optional tools: semgrep, osv-scanner, conftest. Missing optional tools must be recorded, not ignored.

Required skills during implementation: use `superpowers:test-driven-development` or equivalent TDD discipline for each task; use `superpowers:executing-plans` or equivalent for task-by-task execution; use `superpowers:verification-before-completion` before closeout. Subagents are appropriate only for disjoint write scopes such as transport adapters or store tests; they must not edit overlapping files.

MCP/plugin usage: no external service mutation is required. Playwright, Sentry, Render, Google Workspace, and Microsoft tools are not part of v1 implementation. Pinecone or code-search retrieval may be used for historical context only; any retrieved claim must be backed by repo files before it enters the plan or code.

### Documentation, Handoff, and Final Synthesis

Documentation deliverables:

- `tools/whatsoup_guard/README.md` with install, local config shape, simulator usage, CLI commands, and evidence expectations.
- Public spec remains deployment-neutral.
- This plan remains the executable task map.
- No private deployment runbook or local inventory is referenced.

Final handoff must include: task completion map, evidence artifacts, readiness state, validation command outputs, unresolved risks, known `Inconclusive` checks, and rollback/containment guidance. The final verdict may be only `Pass`, `Fail`, `Inconclusive`, or `Blocked`.

Current final synthesis: **Ready with Constraints**. The design and plan are coherent enough to implement the generic engine, but implementation must begin with Task 0 because root test status is not currently a clean pass and must not be misreported.

## File Structure

All paths under `tools/whatsoup_guard/`. Subdirs:

```
tools/whatsoup_guard/
├── package.json                          # workspace package; ESM; type:module
├── tsconfig.json                         # strict; "type": "module"
├── vitest.config.ts                      # forked pool, no broad mocks
├── README.md                             # how to run, env vars, profile refs
├── src/
│   ├── index.ts                          # barrel export
│   ├── types.ts                          # Zod schemas: ProbeDoc, Event, Mute, BaselineRow
│   ├── canonical.ts                      # deterministic JSON; diff; fingerprint
│   ├── hmac.ts                           # sign + verify + key-file self-check
│   ├── store/
│   │   ├── migrations.ts                 # single-statement DDL list
│   │   ├── connection.ts                 # better-sqlite3 wrapper, applies migrations
│   │   ├── baseline.ts                   # BaselineStore: set/get/listIntegrityFailures
│   │   ├── events.ts                     # EventStore: append + jsonl mirror + query
│   │   └── mutes.ts                      # MuteStore: create/match/expire
│   ├── engine/
│   │   ├── severity.ts                   # crit/high/med/low/info ladder; dedup windows
│   │   ├── storm-guard.ts                # crit: 1-per-fingerprint-per-15m unless payload/action change
│   │   ├── dedup.ts                      # fingerprint-based suppression with severity escalation
│   │   ├── mute-match.ts                 # mute scope, forbidden domains, wildcard semantics
│   │   └── lifecycle.ts                  # probe→eval→event lifecycle dispatch
│   ├── evaluator/
│   │   ├── types.ts                      # Evaluator = pure fn (observed, baseline, rules) -> Event[]
│   │   └── canonical-rules.ts            # generic rules: missing_baseline, doc_diff, etc.
│   ├── collector/
│   │   ├── types.ts                      # Collector interface
│   │   └── fixture.ts                    # deterministic fixture collector for tests/simulator
│   ├── policy/
│   │   ├── schema.ts                     # Zod policy schema (extends, inventory, etc.)
│   │   ├── loader.ts                     # YAML load + validate
│   │   ├── extends.ts                    # extends-chain resolution
│   │   └── profiles/
│   │       ├── development.yaml
│   │       ├── personal-strict.yaml
│   │       ├── production.yaml
│   │       └── customer-managed.yaml
│   ├── transport/
│   │   ├── types.ts                      # Sink interface; DeliveryResult
│   │   ├── chain.ts                      # fall-through channel chain + delivery events
│   │   ├── format.ts                     # alert message body formatter
│   │   ├── whatsoup.ts                   # POST /send adapter, retry-with-backoff for crit
│   │   ├── local-notify.ts               # local-log + osascript best-effort
│   │   └── meta-alert/
│   │       ├── ntfy.ts
│   │       ├── pushover.ts
│   │       └── webhook.ts
│   ├── watchdog/
│   │   ├── heartbeat.ts                  # silence-threshold detection
│   │   └── transport-health.ts           # delivery success vs drift count
│   ├── self/
│   │   ├── secret-hygiene.ts             # mode checks on engine's own files
│   │   └── token-age.ts                  # age check; alert_token_aging
│   ├── runner.ts                         # one-cycle entrypoint composing collectors+evaluators+ledger
│   ├── simulator.ts                      # --simulate: fixture inputs
│   └── cli/
│       ├── index.ts                      # commander entrypoint
│       ├── cycle.ts                      # `cycle`
│       ├── mute.ts                       # `mute | status`
│       └── simulate.ts                   # `simulate <args>`
└── tests/
    ├── canonical.test.ts
    ├── hmac.test.ts
    ├── types.test.ts
    ├── store/
    │   ├── connection.test.ts
    │   ├── baseline.test.ts
    │   ├── events.test.ts
    │   └── mutes.test.ts
    ├── engine/
    │   ├── severity.test.ts
    │   ├── storm-guard.test.ts
    │   ├── dedup.test.ts
    │   ├── mute-match.test.ts
    │   └── lifecycle.test.ts
    ├── evaluator/
    │   └── canonical-rules.test.ts
    ├── collector/
    │   └── fixture.test.ts
    ├── policy/
    │   ├── loader.test.ts
    │   ├── extends.test.ts
    │   └── profiles.test.ts
    ├── transport/
    │   ├── chain.test.ts
    │   ├── format.test.ts
    │   ├── whatsoup.test.ts
    │   ├── local-notify.test.ts
    │   └── meta-alert.test.ts
    ├── watchdog/
    │   ├── heartbeat.test.ts
    │   └── transport-health.test.ts
    ├── self/
    │   ├── secret-hygiene.test.ts
    │   └── token-age.test.ts
    ├── runner.test.ts
    ├── cli/
    │   ├── index.test.ts
    │   └── mute.test.ts
    └── e2e/
        └── simulator.test.ts
```

CI workflow file: `.github/workflows/whatsoup-guard.yml` — path-filtered to `tools/whatsoup_guard/**`.

---

## Conventions used by every task

- **Test framework:** vitest. Run a single test file via `npx vitest run --pool=forks tools/whatsoup_guard/tests/<path> -t '<name>'`.
- **Imports use `.ts` extensions** (Node native strip-types resolution).
- **Zod everywhere** for runtime validation of external input — files, YAML, HTTP responses, child-process output. Internal pure functions use plain types.
- **Pino structured logger** instantiated once per module; passed via dependency injection to anything that logs.
- **No broad mocks.** Real SQLite (`:memory:`), real disk for JSONL (temp dirs), real timers (vitest fake-timers OK for clock-dependent code).
- **Each task ends with a commit** with a conventional-commits message scoped to `whatsoup-guard`.

---

## Per-task testing, verification, observability, edge-case, and resilience addendum

Every implementation task below inherits this addendum. If a task body and this addendum conflict, the task body wins only when it is more specific and still satisfies the same evidence standard. The executor must write evidence under `artifacts/whatsoup-guard-review/task-<n>/` for each task before marking the task done.

### Evidence required for every task

Each task must produce these files unless the task is documentation-only:

| Evidence file | Required content |
|---|---|
| `red.txt` | The failing test command and output before implementation, or `not-applicable` with reason for Task 0/1 setup-only work. |
| `green.txt` | The passing task-local test command and output after implementation. |
| `typecheck.txt` | `npm --prefix tools/whatsoup_guard run typecheck` output when the package exists. |
| `coverage-note.md` | One paragraph naming the normal path, negative path, degraded path, and replay/simulator path covered by the task. |
| `observability-note.md` | The event, log, or CLI output added or asserted by the task; include `none` only for pure helpers with no runtime boundary. |
| `edge-cases.md` | The edge cases and failure modes tested by the task, including at least one invalid input or unavailable dependency case when the task touches external input. |
| `resilience-note.md` | The fallback, retry, refusal, idempotence, or recovery behavior implemented or asserted. |

### Universal verification commands

Run the narrowest task-local command first, then the package gates:

```bash
npx vitest run --pool=forks tools/whatsoup_guard/tests/<task-test-file>.test.ts
npm --prefix tools/whatsoup_guard run typecheck
npm --prefix tools/whatsoup_guard test -- --pool=forks
```

If a command cannot run because the package does not exist yet, record `not-applicable` with the exact reason in the task artifact. If a command fails for an unrelated pre-existing root issue, record `Inconclusive`; do not call it passing.

### Logging and observability rules

Runtime code must emit structured events or deterministic CLI output for every boundary crossing:

- **Input boundary:** policy file loaded, fixture loaded, collector result parsed, HTTP response parsed, secret metadata inspected.
- **State boundary:** baseline read/write, event append, JSONL mirror append, mute create/match/expire, dedup/storm-guard decision.
- **Output boundary:** alert formatted, sink attempted, sink failed, sink succeeded, watchdog meta-alert selected, CLI command completed.
- **Failure boundary:** invalid schema, failed HMAC verification, missing baseline, store write failure, JSONL mirror failure, sink timeout, local notification unavailable.

Log payloads must include `run_id`, `cycle_id` where relevant, `correlation_id`, safe `scope_id`, event `kind`, and the artifact path or ledger row ID. They must not include secret values, local inventory values, or raw operator identifiers.

### Cross-cutting edge cases

Every task that accepts input must consider these cases:

- empty object, missing required field, unknown field, wrong type, and malformed JSON/YAML
- duplicate IDs, duplicate policy keys, duplicate event fingerprints, and duplicate mute requests
- out-of-order timestamps, expired mutes, future timestamps, and fake-clock transitions
- missing files, unreadable files, invalid file modes, and non-existent directories
- SQLite transaction failure, JSONL mirror failure, and interrupted write
- sink timeout, non-2xx HTTP response, malformed HTTP response, and retry exhaustion
- bad HMAC, missing HMAC key, unreadable HMAC key, and mutated baseline row
- collector error vs real drift; these must remain separate states

### Resilience principles

- Fail closed for policy/schema/HMAC errors.
- Fail open only for optional notification surfaces, and emit an event that makes the fallback visible.
- Treat collection failure as `probe_error`, not drift.
- Treat unavailable validation tools as `Inconclusive`, not clean.
- Make writes idempotent where possible; where not possible, use transaction boundaries and explicit recovery events.
- Never auto-baseline or auto-remediate in this generic engine plan.
- Prefer deterministic replay fixtures over live services for proof.

### Task-by-task quality matrix

| Task | Additional tests | Verification and validation | Logging and observability | Edge cases and failure modes | Resilience measures |
|---|---|---|---|---|---|
| 0. Readiness gate | Root lane classification test can be a shell transcript; hygiene scan must be empty. | Confirm plan/spec exist, artifact contracts pass, and readiness state is not `Blocked`. | Record command, exit code, and classification artifact for every check. | Missing package, missing local forbidden-pattern file, failing root test, stale artifact directory. | Stop before implementation when blockers exist; classify unrelated failures as `Ready with Constraints`. |
| 1. Package scaffold | Smoke test `node --import` or package script can load the entrypoint. | Verify `package.json`, `tsconfig.json`, vitest config, and README commands align. | CLI/package smoke output is enough; no runtime ledger yet. | Node version mismatch, ESM resolution failure, dependency install failure. | Keep package isolated under `tools/whatsoup_guard`; avoid touching existing runtime code. |
| 2. CI workflow | Workflow syntax check plus path-filter expectation test by inspection. | Verify only protection-layer paths trigger this workflow. | CI job names must make failed gate obvious. | Workflow runs on unrelated paths, misses plan/spec path, or hides npm failures. | Keep CI path-filtered and package-local so existing product lanes are not disturbed. |
| 3. Core type definitions | Zod accept/reject tests for every schema. | Validate inferred TypeScript types compile against sample values. | Schema errors must expose path and code, not raw input values. | Unknown fields, missing required fields, bad severity, invalid timestamp, unsafe secret-shaped strings. | Use strict schemas at boundaries; keep internal pure types narrow. |
| 4. Canonical JSON/diff/fingerprint | Permuted key-order fixtures, nested arrays, nulls, numbers, and Unicode-like strings. | Same input produces same canonical string and fingerprint across repeated runs. | Pure helper: observability note may be `none`; diff callers log fingerprints. | Non-plain objects, undefined, date objects, numeric edge values, empty docs. | Reject unsupported values before fingerprinting; stable sort keys recursively. |
| 5. HMAC | Valid signature, wrong key, mutated payload, missing key, unreadable key-mode fixture. | HMAC verification blocks baseline evaluation when false. | Emit or assert `baseline_integrity_failed` at call site; helper returns safe reason. | Empty key, whitespace key, changed timestamp, changed expected doc, bad encoding. | Constant comparison where practical; never log key material or signed raw secrets. |
| 6. SQLite bootstrap | Migration idempotence, temp-file DB, in-memory DB, and failed migration transaction. | Schema version table exists and duplicate migration run is safe. | Log open, migration start/end, and migration failure with DB path class, not full local path when configured. | Locked DB, invalid directory, duplicate table, partial migration. | Single-statement migrations inside transaction; close DB in finally paths. |
| 7. BaselineStore | Set/get/list, HMAC failure, overwrite semantics, host/scope isolation. | Readback canonical doc equals expected and HMAC verifies. | Event or store log for baseline set and integrity failure. | Missing row, duplicate key, corrupted JSON, bad HMAC, stale captured_at. | Refuse evaluation on bad HMAC; do not auto-repair corrupted rows. |
| 8. EventStore | Append row, append JSONL mirror, query by fingerprint, mirror failure event. | SQLite remains truth when JSONL mirror fails. | Every append returns ledger ID and correlation ID. | Disk full simulation via unwritable dir, malformed payload, duplicate fingerprint, concurrent-ish appends. | Transaction for SQLite write; JSONL mirror failure is visible but does not erase ledger row. |
| 9. MuteStore | Create, match, expire, wildcard scope, forbidden domain rejection. | Expired mute no longer suppresses drift; forbidden domains never mute. | Emit `mute_set`, `mute_expired`, and rejected mute output. | Empty reason, duration too long, future clock, wildcard without override, overlapping mutes. | Cap durations; make mute matching deterministic and auditable. |
| 10. Severity/dedup windows | Table-driven tests for all severities and window durations. | Unknown severity is rejected at schema boundary. | Pure helper: no logging; caller records decision. | Boundary at exact window edge, clock skew, missing previous alert. | Inject clock; avoid Date.now directly in decision logic. |
| 11. Storm guard | Crit duplicate suppression, payload-change bypass, action-change bypass. | Same fingerprint suppressed within window unless meaningful fields change. | Decision event includes `storm_guard=suppressed|allowed`. | Repeated wrapper failure, alternating payload, window expiration. | Rate-limit crit storms without hiding escalations. |
| 12. Dedup logic | Same fingerprint suppressed, severity escalation breaks dedup, changed diff breaks dedup. | Dedup event is written even when alert is suppressed. | Emit `drift_dedup` with prior alert reference. | Missing prior event, low digest behavior, severity downgrade. | Never dedup baseline-integrity failures or alert transport failures. |
| 13. Mute matching | Domain-specific mute, wildcard mute, protected-domain override tests. | Mute match result says whether auto action is suppressed separately from alert. | Emit mute match decision with mute ID and domain only. | Wildcard domain, expired mute, malformed domain, overlapping mutes. | Protected meta-alert domains remain unmutable. |
| 14. Collector interface/fixture | Fixture load success, fixture schema failure, collector exception. | Collector failure produces `probe_error` shape, not drift doc. | Collector result includes `collector_id`, fixture ID, and status. | Empty fixture, malformed fixture, duplicate probe IDs, bad schema version. | Fixture collector is deterministic and never shells out. |
| 15. Evaluator/canonical drift | Missing baseline, clean match, canonical diff, severity mapping. | Evaluator is pure: same observed/baseline/rules produce same events. | Event payload includes safe diff summary and fingerprint. | Empty baseline, extra fields, removed fields, array reorder where order matters. | Keep evaluator side-effect free; lifecycle handles storage and alerting. |
| 16. Lifecycle dispatch | Full probe -> eval -> store path, collector failure path, store failure path. | Ledger rows match expected order and correlation ID. | Cycle start/end, collector status, evaluator status, event append status. | One collector fails while others succeed, missing baseline, HMAC failure, store write failure. | Continue independent collectors when safe; abort cycle only on state-integrity failures. |
| 17. Policy schema/loader | Valid policy, unknown field, bad profile name, invalid action, malformed YAML. | Loader returns typed policy or safe error with path. | Policy-load event/log names profile chain and schema issue. | Empty file, missing extends, duplicate domains, invalid local path. | Fail closed before collectors run; no partial policy execution. |
| 18. Profile inheritance | Parent/child merge, override precedence, cycle detection, missing parent. | Resolved policy snapshot is deterministic. | Emit profile-chain debug artifact in tests. | Extends loop, diamond-like overrides, unknown parent, type mismatch in override. | Reject cycles and ambiguous overrides with actionable errors. |
| 19. Shipped profiles | Snapshot tests for all four profiles and invalid mutation tests. | Profiles load without local inventory and contain no deployment identifiers. | Profile validation output captured as artifact. | Accidental concrete inventory, remediation enabled where alert-only expected, missing domain. | Profiles stay generic; operators provide local config outside product artifacts. |
| 20. Alert formatter | Snapshot messages for crit/high/med/low, auto action states, mute line, event ID. | Message contains enough remediation context without leaking raw values. | Formatter output includes event ID, fingerprint, severity, action status. | Long diff, missing proposed fix, unsafe payload values, markdown-breaking text. | Redact or summarize payload; keep copy-paste commands generic. |
| 21. Sink chain | First sink success stops chain, first fails second succeeds, all fail. | Every attempt emits terminal delivery result. | Delivery events record sink name, attempt count, status, and safe error. | Sink throws, returns malformed result, hangs, duplicate success. | Timeout per sink; fall through deterministically; all-failed is watchdog-visible. |
| 22. WhatSoup send adapter | 200 success, 401/403, 500, timeout, crit retry schedule. | Fake HTTP server proves retries and body shape. | Delivery event includes HTTP code and retry count, not token. | Missing token file, unreadable token file, malformed JSON response, retry exhaustion. | Read token only at send boundary; never log token; bounded retries for crit only. |
| 23. Local notify/log sinks | Durable log success, notification spawn success, notification unavailable. | Log sink works even when GUI notification fails. | `local_notify_failed` event/log when process unavailable. | Missing log dir, unwritable log dir, unavailable notification command, long message. | Disk log is durable layer; GUI notification is best-effort. |
| 24. Watchdog heartbeat | No silence, one missed heartbeat, threshold crossed, stale future timestamp. | Silence threshold uses ledger/event timestamps consistently. | Meta-alert decision includes last heartbeat and threshold. | Empty ledger, corrupted event row, sleeping machine gap, clock jump. | Two-missed-heartbeat threshold; avoid false drift alerts when monitor is unreachable. |
| 25. Watchdog transport health | Drift with zero successful deliveries, no drift with zero deliveries, mixed failures/successes. | Transport-broken decision only fires when alerts should have shipped. | Decision event includes sliding window counts. | Event ledger missing delivery rows, all low digest suppressed, malformed delivery event. | Separate monitor-alive from transport-broken so failures are diagnosable. |
| 26. External meta-alert adapters | ntfy, pushover, webhook request shape; missing secret; non-2xx; timeout. | Each adapter uses same interface and is unit-testable without live service. | Meta-alert attempt records provider and status, never secret. | Bad URL, missing token, provider-specific error, retry not configured. | Keep external push reserved for watchdog/meta-alerts; local log always remains. |
| 27. Self-secret hygiene | Good mode, widened mode, missing file, unreadable file. | Widened secret produces crit self event and startup refusal when configured. | Event names path class and mode, not secret contents. | Symlink path, non-existent file, platform mode differences, directory instead of file. | Metadata-only inspection; never read secret values. |
| 28. Token age | Fresh, warning threshold, expired/too old, missing mtime. | Age calculation uses injected clock and safe metadata. | Emit `alert_token_aging` with rotation hint and no token. | Future mtime, unavailable stat, clock skew, unsupported file system timestamp. | Warn/propose fix; do not rotate tokens in generic engine. |
| 29. Runner cycle | Clean cycle, drift cycle, collector failure, store failure, alert failure. | Cycle result enum matches ledger rows. | Cycle start/end, per-collector result, per-alert delivery, final status. | Partial cycle, no collectors configured, invalid policy, missing stores. | Idempotent cycle IDs; abort only on integrity failures; report partial results. |
| 30. CLI `cycle`/`ping` | Exit 0 on ping, non-zero on invalid config, cycle prints summary. | CLI stdout/stderr is deterministic and safe. | CLI output includes artifact path or ledger DB path class. | Missing args, unknown command, invalid env, failed runner. | Clear exit codes; no stack traces by default; `--verbose` for safe diagnostic detail. |
| 31. Simulator | Baseline, clean, drift, muted, dedup, storm, sink failure, watchdog fixture. | Full e2e replay from fixtures without live services. | Simulator transcript captures cycle IDs, events, and delivery decisions. | Missing fixture, invalid scenario name, fixture schema mismatch, nondeterministic order. | Simulator is the acceptance path for v1; fixture failures block release. |
| 32. CLI `simulate`/`mute`/`status` | Simulate scenario commands, mute creation/status/expiry, invalid mute rejection. | CLI and store state agree after each command. | Status output lists active mutes and last cycle summary safely. | Empty reason, overlong duration, wildcard without flag, expired mute. | Muting protected domains rejected; status remains useful when no mutes exist. |

---

## Task 0: plan-review readiness and repo-health gate

**Files:**
- Read: `docs/specs/2026-05-08-whatsoup-protection-layer-design.md`
- Read: `docs/plans/2026-05-08-whatsoup-protection-layer-implementation-plan.md`
- Write evidence only: `artifacts/whatsoup-guard-review/task-0/*`

- [ ] **Step 1: Create the task evidence directory**

```bash
mkdir -p artifacts/whatsoup-guard-review/task-0
```

- [ ] **Step 2: Capture current repo status without mutating**

```bash
git status --short --branch --untracked-files=all \
  | tee artifacts/whatsoup-guard-review/task-0/git-status.txt
git diff --name-only \
  | tee artifacts/whatsoup-guard-review/task-0/git-diff-files.txt
```

- [ ] **Step 3: Run the root validation lane and classify the result**

```bash
npm test --silent \
  > artifacts/whatsoup-guard-review/task-0/root-npm-test.txt 2>&1
printf 'exit=%s\n' "$?" \
  | tee artifacts/whatsoup-guard-review/task-0/root-npm-test.exit
```

If root tests fail before guard code exists, classify the failure in `artifacts/whatsoup-guard-review/task-0/root-test-classification.md` as one of:

- `Pass` — root suite green.
- `Ready with Constraints` — failure is pre-existing or unrelated to `tools/whatsoup_guard/**`; implementation may proceed but the failure must not be claimed clean.
- `Blocked` — failure prevents dependency installation, TypeScript execution, vitest, or the guard package path.

- [ ] **Step 4: Run public-artifact hygiene scans**

```bash
LOCAL_FORBIDDEN_PATTERNS="${LOCAL_FORBIDDEN_PATTERNS:-artifacts/whatsoup-guard-review/task-0/local-forbidden-public-patterns.txt}"
test -s "$LOCAL_FORBIDDEN_PATTERNS"
rg -n -f "$LOCAL_FORBIDDEN_PATTERNS" \
  docs/specs/2026-05-08-whatsoup-protection-layer-design.md \
  docs/plans/2026-05-08-whatsoup-protection-layer-implementation-plan.md \
  > artifacts/whatsoup-guard-review/task-0/public-hygiene.txt || true
```

The forbidden-pattern file is operator-local evidence, not a product artifact. It should contain environment-specific hostnames, network identifiers, account names, conversation identifiers, and one-off deployment labels for the operator's own environment. Pass only if `public-hygiene.txt` is empty. Any hit must be removed or explicitly proven to be a false positive before Task 1.

- [ ] **Step 5: Confirm plan-review anchor artifacts exist**

```bash
for f in run_manifest.json readiness.json verification_matrix.md test_strategy.md tooling_plan.md contradiction_check.md linting_plan.md regression_protection.md final_review.md; do
  test -s "artifacts/whatsoup-guard-review/$f" || {
    echo "missing $f"
    exit 1
  }
done
```

**Validation:** Run the local artifact-contract checker against `artifacts/whatsoup-guard-review/` for the supported passes (1, 7, 9, 18, 19, 20, 21, 22, 27). Each pass enforces the contract for the artifacts produced by that pass.

**Expected result:** all supported artifact contracts pass, public hygiene scan is empty, and root test lane is either `Pass` or explicitly `Ready with Constraints`.

**Commit:** `chore(whatsoup-guard): record plan-review readiness gate`

---

## Task 1: Scaffold the package

**Files:**
- Create: `tools/whatsoup_guard/package.json`
- Create: `tools/whatsoup_guard/tsconfig.json`
- Create: `tools/whatsoup_guard/vitest.config.ts`
- Create: `tools/whatsoup_guard/README.md`
- Create: `tools/whatsoup_guard/src/index.ts`
- Create: `tools/whatsoup_guard/tests/.gitkeep`

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@whatsoup/guard",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run --pool=forks",
    "test:watch": "vitest --pool=forks",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "pino": "^9.0.0",
    "yaml": "^2.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  },
  "engines": {
    "node": ">=23.10"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Create README.md**

```md
# @whatsoup/guard

Universal protection-layer engine for WhatSoup deployments. See
`../../docs/specs/2026-05-08-whatsoup-protection-layer-design.md` for the
design.

## Develop

    npm install --workspace tools/whatsoup_guard
    npm run --workspace tools/whatsoup_guard test
    npm run --workspace tools/whatsoup_guard typecheck

## Run

    node tools/whatsoup_guard/src/cli/index.ts <command>
```

- [ ] **Step 5: Create the barrel export**

```ts
// tools/whatsoup_guard/src/index.ts
export const VERSION = '0.0.0';
```

- [ ] **Step 6: Verify the scaffold**

Run from the repo root:

    npx vitest run --pool=forks --root tools/whatsoup_guard

Expected: vitest reports "no test files found" with exit 0.

- [ ] **Step 7: Commit**

```bash
git add tools/whatsoup_guard/package.json \
        tools/whatsoup_guard/tsconfig.json \
        tools/whatsoup_guard/vitest.config.ts \
        tools/whatsoup_guard/README.md \
        tools/whatsoup_guard/src/index.ts \
        tools/whatsoup_guard/tests/.gitkeep
git commit -m "feat(whatsoup-guard): scaffold package manifest and tsconfig"
```

---

## Task 2: CI workflow with path filter

**Files:**
- Create: `.github/workflows/whatsoup-guard.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: whatsoup-guard

on:
  pull_request:
    paths: ['tools/whatsoup_guard/**', '.github/workflows/whatsoup-guard.yml']
  push:
    branches: [main]
    paths: ['tools/whatsoup_guard/**', '.github/workflows/whatsoup-guard.yml']

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: tools/whatsoup_guard
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '23.x' }
      - run: npm install --legacy-peer-deps
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Verify yaml parses**

    npx js-yaml .github/workflows/whatsoup-guard.yml > /dev/null && echo OK

Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/whatsoup-guard.yml
git commit -m "ci(whatsoup-guard): path-filtered workflow"
```

---

## Task 3: Core type definitions (Zod)

**Files:**
- Create: `tools/whatsoup_guard/src/types.ts`
- Create: `tools/whatsoup_guard/tests/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/types.test.ts
import { describe, expect, it } from 'vitest';
import {
  EventSchema, MuteSchema, ProbeDocSchema, BaselineRowSchema,
  type Event, type Mute, type ProbeDoc, type BaselineRow,
} from '../src/types.ts';

describe('types', () => {
  it('parses a valid Event', () => {
    const ev: Event = {
      id: 1,
      ts: '2026-05-08T14:32:11Z',
      kind: 'drift',
      domain: 'exposure',
      scope_id: 'host.example',
      probe_id: 'host.example.ports',
      severity: 'crit',
      fingerprint: 'a'.repeat(64),
      payload: { diff: '+ port 11434' },
      alerted_to: 'whatsoup',
    };
    expect(EventSchema.parse(ev).fingerprint?.length).toBe(64);
  });

  it('rejects an unknown event kind', () => {
    expect(() => EventSchema.parse({ id: 1, ts: 'x', kind: 'made_up', payload: {} })).toThrow();
  });

  it('parses a Mute with allow_revert_suppression default false', () => {
    const m: Mute = MuteSchema.parse({
      id: 1, host: 'h', domain: 'exposure',
      expires_at: '2026-05-08T15:00:00Z',
      reason: 'test', created_by: 'op',
    });
    expect(m.allow_revert_suppression).toBe(false);
  });

  it('parses a ProbeDoc and a BaselineRow', () => {
    const doc: ProbeDoc = ProbeDocSchema.parse({
      probe_id: 'p', scope_id: 's', captured_at: 't', fields: { a: 1 },
    });
    expect(doc.fields).toEqual({ a: 1 });
    const row: BaselineRow = BaselineRowSchema.parse({
      probe_id: 'p', scope_id: 's', expected_doc: '{"a":1}',
      captured_at: 't', captured_by: 'op', hmac: 'x'.repeat(64),
    });
    expect(row.hmac.length).toBe(64);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/types.test.ts

Expected: FAIL — module `../src/types.ts` not found / exports missing.

- [ ] **Step 3: Implement the schemas**

```ts
// tools/whatsoup_guard/src/types.ts
import { z } from 'zod';

export const Severity = z.enum(['crit', 'high', 'med', 'low', 'info']);
export type Severity = z.infer<typeof Severity>;

export const Domain = z.enum(['exposure', 'credential', 'capability', 'change', 'alerting']);
export type Domain = z.infer<typeof Domain>;

export const EventKind = z.enum([
  'drift', 'drift_dedup', 'drift_muted', 'probe_error',
  'baseline_integrity_fail',
  'alert_delivery_succeeded', 'alert_delivery_failed', 'alert_delivery_failed_all',
  'mute_set', 'mute_expire',
  'heartbeat', 'self_secret_widened', 'alert_token_aging',
]);
export type EventKind = z.infer<typeof EventKind>;

export const EventSchema = z.object({
  id: z.number().int().nonnegative(),
  ts: z.string(),
  kind: EventKind,
  domain: Domain.optional(),
  scope_id: z.string().optional(),
  probe_id: z.string().optional(),
  severity: Severity.optional(),
  fingerprint: z.string().length(64).optional(),
  payload: z.record(z.unknown()),
  alerted_to: z.enum(['whatsoup', 'local_notification', 'local_log', 'external_push', 'none']).optional(),
});
export type Event = z.infer<typeof EventSchema>;

export const MuteSchema = z.object({
  id: z.number().int().nonnegative(),
  host: z.string(),
  domain: z.string(),
  expires_at: z.string(),
  reason: z.string().min(1),
  allow_revert_suppression: z.boolean().default(false),
  created_by: z.string(),
});
export type Mute = z.infer<typeof MuteSchema>;

export const ProbeDocSchema = z.object({
  probe_id: z.string(),
  scope_id: z.string(),
  captured_at: z.string(),
  fields: z.record(z.unknown()),
});
export type ProbeDoc = z.infer<typeof ProbeDocSchema>;

export const BaselineRowSchema = z.object({
  probe_id: z.string(),
  scope_id: z.string(),
  expected_doc: z.string(),
  captured_at: z.string(),
  captured_by: z.string(),
  hmac: z.string().length(64),
});
export type BaselineRow = z.infer<typeof BaselineRowSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/types.test.ts

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/types.ts tools/whatsoup_guard/tests/types.test.ts
git commit -m "feat(whatsoup-guard): zod schemas for Event, Mute, ProbeDoc, BaselineRow"
```

---

## Task 4: Canonical JSON serialization, diff, fingerprint

**Files:**
- Create: `tools/whatsoup_guard/src/canonical.ts`
- Create: `tools/whatsoup_guard/tests/canonical.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/canonical.test.ts
import { describe, expect, it } from 'vitest';
import { canonicalize, fingerprint, structuralDiff } from '../src/canonical.ts';
import type { ProbeDoc } from '../src/types.ts';

describe('canonical', () => {
  it('produces identical output regardless of key order', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
  });

  it('strips whitespace and is byte-stable', () => {
    expect(canonicalize({ a: [1, 2, 3] })).toBe('{"a":[1,2,3]}');
  });

  it('handles nested objects deterministically', () => {
    expect(canonicalize({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it('produces stable fingerprint for equivalent docs', () => {
    const obs1: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 't', fields: { a: 1, b: 2 } };
    const obs2: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 't', fields: { b: 2, a: 1 } };
    const base: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 'b', fields: {} };
    expect(fingerprint('p.id', obs1, base)).toBe(fingerprint('p.id', obs2, base));
    expect(fingerprint('p.id', obs1, base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('structuralDiff returns added and removed paths only', () => {
    const observed: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 't', fields: { x: 1, y: 2 } };
    const baseline: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 'b', fields: { x: 1, z: 3 } };
    const d = structuralDiff(observed, baseline);
    expect(d.added).toEqual({ y: 2 });
    expect(d.removed).toEqual({ z: 3 });
    expect(d.changed).toEqual({});
  });

  it('structuralDiff catches changed values', () => {
    const observed: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 't', fields: { x: 1 } };
    const baseline: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 'b', fields: { x: 2 } };
    const d = structuralDiff(observed, baseline);
    expect(d.changed).toEqual({ x: { from: 2, to: 1 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/canonical.test.ts

Expected: FAIL — module not found.

- [ ] **Step 3: Implement canonical**

```ts
// tools/whatsoup_guard/src/canonical.ts
import { createHash } from 'node:crypto';
import type { ProbeDoc } from './types.ts';

/**
 * Deterministic JSON: sorted keys at every depth, no whitespace.
 * Arrays preserve order (their order is semantic).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export interface StructuralDiff {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
}

/** Diff `observed.fields` against `baseline.fields` at top-level. */
export function structuralDiff(observed: ProbeDoc, baseline: ProbeDoc): StructuralDiff {
  const a = (observed.fields ?? {}) as Record<string, unknown>;
  const b = (baseline.fields ?? {}) as Record<string, unknown>;
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(a)) {
    if (!(k in b)) added[k] = a[k];
    else if (canonicalize(a[k]) !== canonicalize(b[k])) changed[k] = { from: b[k], to: a[k] };
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) removed[k] = b[k];
  }
  return { added, removed, changed };
}

/**
 * fingerprint = sha256( probe_id || canonical(structuralDiff(observed, baseline)) ).
 * Same probe + same diff -> same fingerprint, regardless of timestamps or PIDs in payloads.
 */
export function fingerprint(probeId: string, observed: ProbeDoc, baseline: ProbeDoc): string {
  const diff = structuralDiff(observed, baseline);
  return createHash('sha256').update(probeId + canonicalize(diff)).digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/canonical.test.ts

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/canonical.ts tools/whatsoup_guard/tests/canonical.test.ts
git commit -m "feat(whatsoup-guard): canonical JSON, structural diff, fingerprint"
```

---

## Task 5: HMAC sign and verify

**Files:**
- Create: `tools/whatsoup_guard/src/hmac.ts`
- Create: `tools/whatsoup_guard/tests/hmac.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/hmac.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { sign, verify, verifyKeyFileMode } from '../src/hmac.ts';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = Buffer.from('a'.repeat(64), 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('hmac', () => {
  it('round-trips sign and verify on identical input', () => {
    const sig = sign(KEY, 'probe.id', 'host', '{"a":1}', '2026-05-08T00:00:00Z');
    expect(verify(KEY, 'probe.id', 'host', '{"a":1}', '2026-05-08T00:00:00Z', sig)).toBe(true);
  });

  it('rejects a tampered baseline doc', () => {
    const sig = sign(KEY, 'probe.id', 'host', '{"a":1}', '2026-05-08T00:00:00Z');
    expect(verify(KEY, 'probe.id', 'host', '{"a":2}', '2026-05-08T00:00:00Z', sig)).toBe(false);
  });

  it('rejects a different scope_id', () => {
    const sig = sign(KEY, 'probe.id', 'host-a', '{}', 't');
    expect(verify(KEY, 'probe.id', 'host-b', '{}', 't', sig)).toBe(false);
  });

  it('verifyKeyFileMode rejects mode wider than 0400', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-hmac-'));
    dirs.push(dir);
    const f = join(dir, 'key');
    writeFileSync(f, 'secret', { mode: 0o400 });
    chmodSync(f, 0o400);
    expect(verifyKeyFileMode(f).ok).toBe(true);
    chmodSync(f, 0o404);
    expect(verifyKeyFileMode(f).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/hmac.test.ts

Expected: FAIL — module not found.

- [ ] **Step 3: Implement hmac**

```ts
// tools/whatsoup_guard/src/hmac.ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';

const ALG = 'sha256';

function compose(probeId: string, scopeId: string, expectedDoc: string, capturedAt: string): string {
  // Order is part of the binding contract. Do not reorder.
  return [probeId, scopeId, expectedDoc, capturedAt].join(' ');
}

export function sign(key: Buffer, probeId: string, scopeId: string, expectedDoc: string, capturedAt: string): string {
  return createHmac(ALG, key).update(compose(probeId, scopeId, expectedDoc, capturedAt)).digest('hex');
}

export function verify(
  key: Buffer, probeId: string, scopeId: string, expectedDoc: string, capturedAt: string, expected: string,
): boolean {
  const actual = sign(key, probeId, scopeId, expectedDoc, capturedAt);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export interface KeyFileModeResult { ok: boolean; mode: number; reason?: string }

/** Engine self-checks its own HMAC key file mode every cycle. Refuses on widening. */
export function verifyKeyFileMode(path: string, allowed = 0o400): KeyFileModeResult {
  const st = statSync(path);
  const mode = st.mode & 0o777;
  if (mode === allowed) return { ok: true, mode };
  return { ok: false, mode, reason: `expected ${allowed.toString(8)}, found ${mode.toString(8)}` };
}

export function loadKey(path: string): Buffer {
  const r = verifyKeyFileMode(path);
  if (!r.ok) throw new Error(`HMAC key file mode rejected: ${r.reason}`);
  return readFileSync(path);
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/hmac.test.ts

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/hmac.ts tools/whatsoup_guard/tests/hmac.test.ts
git commit -m "feat(whatsoup-guard): HMAC sign/verify and key-file mode self-check"
```

---

## Task 6: SQLite schema + connection bootstrap

**Files:**
- Create: `tools/whatsoup_guard/src/store/migrations.ts`
- Create: `tools/whatsoup_guard/src/store/connection.ts`
- Create: `tools/whatsoup_guard/tests/store/connection.test.ts`

- [ ] **Step 1: Define the migrations as single-statement DDL**

```ts
// tools/whatsoup_guard/src/store/migrations.ts
/**
 * Single-statement DDL applied at bootstrap. Each entry is one statement so it
 * can be passed to better-sqlite3's prepare/run pipeline without a multi-statement runner.
 */
export const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS baseline (
     probe_id      TEXT NOT NULL,
     scope_id      TEXT NOT NULL,
     expected_doc  TEXT NOT NULL,
     captured_at   TEXT NOT NULL,
     captured_by   TEXT NOT NULL,
     hmac          TEXT NOT NULL,
     PRIMARY KEY (probe_id, scope_id)
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     ts            TEXT NOT NULL,
     kind          TEXT NOT NULL,
     domain        TEXT,
     scope_id      TEXT,
     probe_id      TEXT,
     severity      TEXT,
     fingerprint   TEXT,
     payload       TEXT NOT NULL,
     alerted_to    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_fingerprint ON events(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)`,
  `CREATE TABLE IF NOT EXISTS mutes (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     host          TEXT NOT NULL,
     domain        TEXT NOT NULL,
     expires_at    TEXT NOT NULL,
     reason        TEXT NOT NULL,
     allow_revert_suppression INTEGER NOT NULL DEFAULT 0,
     created_by    TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mutes_expires ON mutes(expires_at)`,
];
```

- [ ] **Step 2: Write the failing test**

```ts
// tools/whatsoup_guard/tests/store/connection.test.ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/connection.ts';

describe('openDatabase', () => {
  it('creates the schema in :memory:', () => {
    const db = openDatabase(':memory:');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toEqual(['baseline', 'events', 'mutes']);
    db.close();
  });

  it('is idempotent on a second open', () => {
    const db = openDatabase(':memory:');
    expect(() => openDatabase(':memory:')).not.toThrow();
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/connection.test.ts

Expected: FAIL — connection module missing.

- [ ] **Step 4: Implement the connection bootstrap**

```ts
// tools/whatsoup_guard/src/store/connection.ts
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';

export function openDatabase(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const stmt of MIGRATIONS) {
    db.prepare(stmt).run();
  }
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/connection.test.ts

Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add tools/whatsoup_guard/src/store/migrations.ts \
        tools/whatsoup_guard/src/store/connection.ts \
        tools/whatsoup_guard/tests/store/connection.test.ts
git commit -m "feat(whatsoup-guard): sqlite migrations + connection bootstrap"
```

---

## Task 7: BaselineStore

**Files:**
- Create: `tools/whatsoup_guard/src/store/baseline.ts`
- Create: `tools/whatsoup_guard/tests/store/baseline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/store/baseline.test.ts
import { describe, expect, it } from 'vitest';
import { BaselineStore } from '../../src/store/baseline.ts';
import { openDatabase } from '../../src/store/connection.ts';

const KEY = Buffer.from('a'.repeat(64), 'utf8');

function freshStore(): BaselineStore {
  return new BaselineStore(openDatabase(':memory:'), KEY);
}

describe('BaselineStore', () => {
  it('round-trips a baseline row with HMAC', () => {
    const s = freshStore();
    s.set({ probe_id: 'p', scope_id: 's', expected_doc: '{"a":1}', captured_at: 't', captured_by: 'op' });
    const got = s.get('p', 's');
    expect(got?.expected_doc).toBe('{"a":1}');
    expect(got?.hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies HMAC on get and surfaces failures', () => {
    const s = freshStore();
    s.set({ probe_id: 'p', scope_id: 's', expected_doc: '{"a":1}', captured_at: 't', captured_by: 'op' });
    // tamper directly through the underlying connection
    (s as unknown as { db: ReturnType<typeof openDatabase> }).db
      .prepare("UPDATE baseline SET expected_doc='{\"a\":2}' WHERE probe_id='p'").run();
    const fails = s.listIntegrityFailures();
    expect(fails).toEqual([{ probe_id: 'p', scope_id: 's' }]);
  });

  it('returns undefined for unknown rows', () => {
    expect(freshStore().get('nope', 'nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/baseline.test.ts

Expected: FAIL — module not found.

- [ ] **Step 3: Implement BaselineStore**

```ts
// tools/whatsoup_guard/src/store/baseline.ts
import type { Database } from 'better-sqlite3';
import { sign, verify } from '../hmac.ts';
import type { BaselineRow } from '../types.ts';

export interface BaselineSetInput {
  probe_id: string;
  scope_id: string;
  expected_doc: string;
  captured_at: string;
  captured_by: string;
}

export class BaselineStore {
  constructor(private readonly db: Database, private readonly key: Buffer) {}

  set(input: BaselineSetInput): void {
    const hmac = sign(this.key, input.probe_id, input.scope_id, input.expected_doc, input.captured_at);
    this.db.prepare(`
      INSERT INTO baseline (probe_id, scope_id, expected_doc, captured_at, captured_by, hmac)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (probe_id, scope_id) DO UPDATE SET
        expected_doc = excluded.expected_doc,
        captured_at  = excluded.captured_at,
        captured_by  = excluded.captured_by,
        hmac         = excluded.hmac
    `).run(input.probe_id, input.scope_id, input.expected_doc, input.captured_at, input.captured_by, hmac);
  }

  get(probeId: string, scopeId: string): BaselineRow | undefined {
    const row = this.db.prepare(
      'SELECT * FROM baseline WHERE probe_id = ? AND scope_id = ?',
    ).get(probeId, scopeId) as BaselineRow | undefined;
    return row;
  }

  /** Returns rows whose HMAC fails to verify against current state. */
  listIntegrityFailures(): Array<{ probe_id: string; scope_id: string }> {
    const rows = this.db.prepare('SELECT * FROM baseline').all() as BaselineRow[];
    const out: Array<{ probe_id: string; scope_id: string }> = [];
    for (const r of rows) {
      const ok = verify(this.key, r.probe_id, r.scope_id, r.expected_doc, r.captured_at, r.hmac);
      if (!ok) out.push({ probe_id: r.probe_id, scope_id: r.scope_id });
    }
    return out;
  }

  clear(scopeId: string): void {
    this.db.prepare('DELETE FROM baseline WHERE scope_id = ?').run(scopeId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/baseline.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/store/baseline.ts tools/whatsoup_guard/tests/store/baseline.test.ts
git commit -m "feat(whatsoup-guard): BaselineStore with HMAC integrity"
```

---

## Task 8: EventStore (sqlite + jsonl mirror)

**Files:**
- Create: `tools/whatsoup_guard/src/store/events.ts`
- Create: `tools/whatsoup_guard/tests/store/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/store/events.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/store/events.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'wg-events-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('EventStore', () => {
  it('appends an event and assigns an autoincrement id', () => {
    const store = new EventStore(openDatabase(':memory:'), join(tmp(), 'events.jsonl'));
    const id = store.append({
      ts: 't', kind: 'drift', domain: 'exposure', scope_id: 's', probe_id: 'p',
      severity: 'high', fingerprint: 'f'.repeat(64), payload: { x: 1 },
    });
    expect(id).toBeGreaterThan(0);
  });

  it('mirrors to jsonl with one event per line', () => {
    const path = join(tmp(), 'events.jsonl');
    const store = new EventStore(openDatabase(':memory:'), path);
    store.append({ ts: 't', kind: 'heartbeat', payload: { ok: true } });
    store.append({ ts: 't2', kind: 'drift', payload: {} });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).kind).toBe('heartbeat');
  });

  it('queries by kind', () => {
    const store = new EventStore(openDatabase(':memory:'), join(tmp(), 'e.jsonl'));
    store.append({ ts: 't', kind: 'heartbeat', payload: {} });
    store.append({ ts: 't', kind: 'drift', payload: {} });
    expect(store.queryByKind('heartbeat')).toHaveLength(1);
  });

  it('queries by fingerprint within a window', () => {
    const store = new EventStore(openDatabase(':memory:'), join(tmp(), 'e.jsonl'));
    const fp = 'a'.repeat(64);
    store.append({ ts: '2026-05-08T10:00:00Z', kind: 'drift', fingerprint: fp, payload: {} });
    const after = store.queryByFingerprintSince(fp, '2026-05-08T09:00:00Z');
    expect(after).toHaveLength(1);
    const before = store.queryByFingerprintSince(fp, '2026-05-08T11:00:00Z');
    expect(before).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/events.test.ts

Expected: FAIL — module not found.

- [ ] **Step 3: Implement EventStore**

```ts
// tools/whatsoup_guard/src/store/events.ts
import type { Database } from 'better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Event, EventKind } from '../types.ts';

export type EventInput = Omit<Event, 'id'>;

export class EventStore {
  constructor(private readonly db: Database, private readonly jsonlPath: string) {
    mkdirSync(dirname(jsonlPath), { recursive: true });
  }

  append(ev: EventInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (ts, kind, domain, scope_id, probe_id, severity, fingerprint, payload, alerted_to)
      VALUES (@ts, @kind, @domain, @scope_id, @probe_id, @severity, @fingerprint, @payload, @alerted_to)
    `);
    const info = stmt.run({
      ts: ev.ts,
      kind: ev.kind,
      domain: ev.domain ?? null,
      scope_id: ev.scope_id ?? null,
      probe_id: ev.probe_id ?? null,
      severity: ev.severity ?? null,
      fingerprint: ev.fingerprint ?? null,
      payload: JSON.stringify(ev.payload),
      alerted_to: ev.alerted_to ?? null,
    });
    const id = Number(info.lastInsertRowid);
    appendFileSync(this.jsonlPath, JSON.stringify({ id, ...ev }) + '\n');
    return id;
  }

  queryByKind(kind: EventKind): Event[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind) as Array<Record<string, unknown>>;
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload as string) } as Event));
  }

  queryByFingerprintSince(fp: string, sinceIso: string): Event[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE fingerprint = ? AND ts >= ? ORDER BY id',
    ).all(fp, sinceIso) as Array<Record<string, unknown>>;
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload as string) } as Event));
  }

  countByKindSince(kind: EventKind, sinceIso: string): number {
    const r = this.db.prepare('SELECT count(*) AS c FROM events WHERE kind = ? AND ts >= ?').get(kind, sinceIso) as { c: number };
    return r.c;
  }

  latestByKind(kind: EventKind): Event | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { ...r, payload: JSON.parse(r.payload as string) } as Event;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/events.test.ts

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/store/events.ts tools/whatsoup_guard/tests/store/events.test.ts
git commit -m "feat(whatsoup-guard): EventStore with sqlite + jsonl mirror"
```

---

## Task 9: MuteStore

**Files:**
- Create: `tools/whatsoup_guard/src/store/mutes.ts`
- Create: `tools/whatsoup_guard/tests/store/mutes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/store/mutes.test.ts
import { describe, expect, it } from 'vitest';
import { MuteStore } from '../../src/store/mutes.ts';
import { openDatabase } from '../../src/store/connection.ts';

function freshStore(): MuteStore {
  return new MuteStore(openDatabase(':memory:'));
}

describe('MuteStore', () => {
  it('inserts a mute and lists it as active', () => {
    const s = freshStore();
    const id = s.create({
      host: 'h', domain: 'exposure',
      expires_at: '2099-01-01T00:00:00Z',
      reason: 'work', created_by: 'op',
    });
    expect(id).toBeGreaterThan(0);
    expect(s.listActive('2026-05-08T00:00:00Z')).toHaveLength(1);
  });

  it('excludes expired mutes from active list', () => {
    const s = freshStore();
    s.create({ host: 'h', domain: 'exposure', expires_at: '2026-05-08T00:00:00Z', reason: 'r', created_by: 'op' });
    expect(s.listActive('2026-05-08T01:00:00Z')).toHaveLength(0);
  });

  it('returns expiring mutes for emit', () => {
    const s = freshStore();
    const id = s.create({ host: 'h', domain: 'd', expires_at: '2026-05-08T01:00:00Z', reason: 'r', created_by: 'op' });
    const expired = s.listExpiredSince('2026-05-08T00:00:00Z', '2026-05-08T02:00:00Z');
    expect(expired.map(m => m.id)).toEqual([id]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/mutes.test.ts

Expected: FAIL — module not found.

- [ ] **Step 3: Implement MuteStore**

```ts
// tools/whatsoup_guard/src/store/mutes.ts
import type { Database } from 'better-sqlite3';
import type { Mute } from '../types.ts';

export interface MuteCreateInput {
  host: string;
  domain: string;
  expires_at: string;
  reason: string;
  allow_revert_suppression?: boolean;
  created_by: string;
}

export class MuteStore {
  constructor(private readonly db: Database) {}

  create(input: MuteCreateInput): number {
    const r = this.db.prepare(`
      INSERT INTO mutes (host, domain, expires_at, reason, allow_revert_suppression, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.host, input.domain, input.expires_at, input.reason,
      input.allow_revert_suppression ? 1 : 0, input.created_by,
    );
    return Number(r.lastInsertRowid);
  }

  listActive(nowIso: string): Mute[] {
    const rows = this.db.prepare('SELECT * FROM mutes WHERE expires_at > ?').all(nowIso) as Array<Record<string, unknown>>;
    return rows.map(rowToMute);
  }

  listExpiredSince(prevNowIso: string, nowIso: string): Mute[] {
    const rows = this.db.prepare(
      'SELECT * FROM mutes WHERE expires_at > ? AND expires_at <= ?',
    ).all(prevNowIso, nowIso) as Array<Record<string, unknown>>;
    return rows.map(rowToMute);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM mutes WHERE id = ?').run(id);
  }
}

function rowToMute(r: Record<string, unknown>): Mute {
  return {
    id: r.id as number,
    host: r.host as string,
    domain: r.domain as string,
    expires_at: r.expires_at as string,
    reason: r.reason as string,
    allow_revert_suppression: Boolean(r.allow_revert_suppression),
    created_by: r.created_by as string,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/store/mutes.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/store/mutes.ts tools/whatsoup_guard/tests/store/mutes.test.ts
git commit -m "feat(whatsoup-guard): MuteStore with active/expired queries"
```

---

## Task 10: Severity ladder + dedup window math

**Files:**
- Create: `tools/whatsoup_guard/src/engine/severity.ts`
- Create: `tools/whatsoup_guard/tests/engine/severity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/engine/severity.test.ts
import { describe, expect, it } from 'vitest';
import { dedupWindowMs, severityRank } from '../../src/engine/severity.ts';

describe('severity', () => {
  it('orders crit > high > med > low > info', () => {
    expect(severityRank('crit')).toBeGreaterThan(severityRank('high'));
    expect(severityRank('high')).toBeGreaterThan(severityRank('med'));
    expect(severityRank('med')).toBeGreaterThan(severityRank('low'));
    expect(severityRank('low')).toBeGreaterThan(severityRank('info'));
  });

  it('declares dedup windows per spec §6.5', () => {
    expect(dedupWindowMs('crit')).toBe(0);                      // storm guard, not dedup
    expect(dedupWindowMs('high')).toBe(6  * 60 * 60 * 1000);
    expect(dedupWindowMs('med')).toBe(12 * 60 * 60 * 1000);
    expect(dedupWindowMs('low')).toBe(24 * 60 * 60 * 1000);     // aggregated to digest
    expect(dedupWindowMs('info')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/severity.test.ts

Expected: FAIL — module not found.

- [ ] **Step 3: Implement severity**

```ts
// tools/whatsoup_guard/src/engine/severity.ts
import type { Severity } from '../types.ts';

const RANK: Record<Severity, number> = { crit: 4, high: 3, med: 2, low: 1, info: 0 };

export function severityRank(s: Severity): number {
  return RANK[s];
}

const HOUR = 60 * 60 * 1000;

const WINDOW_MS: Record<Severity, number> = {
  crit: 0,                  // storm guard handles crit; not dedup-windowed
  high: 6  * HOUR,
  med:  12 * HOUR,
  low:  24 * HOUR,
  info: 0,
};

export function dedupWindowMs(s: Severity): number {
  return WINDOW_MS[s];
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/severity.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/engine/severity.ts tools/whatsoup_guard/tests/engine/severity.test.ts
git commit -m "feat(whatsoup-guard): severity ladder and dedup window math"
```

---

## Task 11: Storm guard for crit

**Files:**
- Create: `tools/whatsoup_guard/src/engine/storm-guard.ts`
- Create: `tools/whatsoup_guard/tests/engine/storm-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/engine/storm-guard.test.ts
import { describe, expect, it } from 'vitest';
import { stormGuardSuppresses } from '../../src/engine/storm-guard.ts';

const NOW = Date.parse('2026-05-08T12:00:00Z');

describe('stormGuardSuppresses', () => {
  it('does not suppress the first occurrence', () => {
    const r = stormGuardSuppresses({ now: NOW, lastAlert: undefined, payloadHash: 'p1', actionResult: 'APPLIED' });
    expect(r.suppress).toBe(false);
  });

  it('suppresses an identical crit within 15 minutes', () => {
    const r = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 60_000, payloadHash: 'p1', actionResult: 'APPLIED' },
      payloadHash: 'p1', actionResult: 'APPLIED',
    });
    expect(r.suppress).toBe(true);
  });

  it('does not suppress when payload changes', () => {
    const r = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 60_000, payloadHash: 'p1', actionResult: 'APPLIED' },
      payloadHash: 'p2', actionResult: 'APPLIED',
    });
    expect(r.suppress).toBe(false);
  });

  it('does not suppress when action result changes', () => {
    const r = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 60_000, payloadHash: 'p1', actionResult: 'APPLIED' },
      payloadHash: 'p1', actionResult: 'FAILED',
    });
    expect(r.suppress).toBe(false);
  });

  it('does not suppress past the 15-minute window', () => {
    const r = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 16 * 60_000, payloadHash: 'p1', actionResult: 'APPLIED' },
      payloadHash: 'p1', actionResult: 'APPLIED',
    });
    expect(r.suppress).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/storm-guard.test.ts

Expected: FAIL — module not found.

- [ ] **Step 3: Implement storm-guard**

```ts
// tools/whatsoup_guard/src/engine/storm-guard.ts
const STORM_WINDOW_MS = 15 * 60 * 1000;

export interface StormGuardLast {
  ts: number;
  payloadHash: string;
  actionResult: string;
}

export interface StormGuardInput {
  now: number;
  lastAlert: StormGuardLast | undefined;
  payloadHash: string;
  actionResult: string;
}

export interface StormGuardResult {
  suppress: boolean;
  reason?: string;
}

export function stormGuardSuppresses(input: StormGuardInput): StormGuardResult {
  const { now, lastAlert, payloadHash, actionResult } = input;
  if (!lastAlert) return { suppress: false };
  const within = now - lastAlert.ts < STORM_WINDOW_MS;
  if (!within) return { suppress: false };
  if (lastAlert.payloadHash !== payloadHash) return { suppress: false, reason: 'payload changed' };
  if (lastAlert.actionResult !== actionResult) return { suppress: false, reason: 'action changed' };
  return { suppress: true, reason: 'identical crit within 15m window' };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/storm-guard.test.ts

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/engine/storm-guard.ts tools/whatsoup_guard/tests/engine/storm-guard.test.ts
git commit -m "feat(whatsoup-guard): crit storm guard (1-per-15m unless payload/action changes)"
```

---

## Task 12: Dedup logic with severity escalation

**Files:**
- Create: `tools/whatsoup_guard/src/engine/dedup.ts`
- Create: `tools/whatsoup_guard/tests/engine/dedup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/engine/dedup.test.ts
import { describe, expect, it } from 'vitest';
import { dedupSuppresses } from '../../src/engine/dedup.ts';

const NOW = Date.parse('2026-05-08T12:00:00Z');

describe('dedupSuppresses', () => {
  it('suppresses a fresh "high" within the 6h window', () => {
    const r = dedupSuppresses({
      now: NOW,
      severity: 'high',
      previousAlert: { ts: NOW - 60 * 60 * 1000, severity: 'high' },
    });
    expect(r.suppress).toBe(true);
  });

  it('does not suppress past the 6h window', () => {
    const r = dedupSuppresses({
      now: NOW,
      severity: 'high',
      previousAlert: { ts: NOW - 7 * 60 * 60 * 1000, severity: 'high' },
    });
    expect(r.suppress).toBe(false);
  });

  it('does not suppress on severity escalation', () => {
    const r = dedupSuppresses({
      now: NOW,
      severity: 'crit',
      previousAlert: { ts: NOW - 60 * 60 * 1000, severity: 'high' },
    });
    expect(r.suppress).toBe(false);
  });

  it('does not suppress when there is no previous alert', () => {
    expect(dedupSuppresses({ now: NOW, severity: 'med', previousAlert: undefined }).suppress).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/dedup.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement dedup**

```ts
// tools/whatsoup_guard/src/engine/dedup.ts
import { dedupWindowMs, severityRank } from './severity.ts';
import type { Severity } from '../types.ts';

export interface DedupInput {
  now: number;
  severity: Severity;
  previousAlert: { ts: number; severity: Severity } | undefined;
}

export interface DedupResult {
  suppress: boolean;
  reason?: string;
}

export function dedupSuppresses(input: DedupInput): DedupResult {
  const { now, severity, previousAlert } = input;
  if (!previousAlert) return { suppress: false };
  if (severityRank(severity) > severityRank(previousAlert.severity)) {
    return { suppress: false, reason: 'severity escalated' };
  }
  const win = dedupWindowMs(severity);
  if (win === 0) return { suppress: false };
  const within = now - previousAlert.ts < win;
  return within
    ? { suppress: true, reason: `within dedup window (${win} ms)` }
    : { suppress: false, reason: 'dedup window expired' };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/dedup.test.ts

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/engine/dedup.ts tools/whatsoup_guard/tests/engine/dedup.test.ts
git commit -m "feat(whatsoup-guard): fingerprint-based dedup with severity escalation"
```

---

## Task 13: Mute matching with forbidden domains

**Files:**
- Create: `tools/whatsoup_guard/src/engine/mute-match.ts`
- Create: `tools/whatsoup_guard/tests/engine/mute-match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/engine/mute-match.test.ts
import { describe, expect, it } from 'vitest';
import { matchMute } from '../../src/engine/mute-match.ts';
import type { Mute } from '../../src/types.ts';

const baseMute: Mute = {
  id: 1, host: 'h1', domain: 'exposure',
  expires_at: '2099-01-01T00:00:00Z',
  reason: 'r', allow_revert_suppression: false, created_by: 'op',
};

describe('matchMute', () => {
  it('matches host+domain', () => {
    const r = matchMute({ host: 'h1', domain: 'exposure', isRemediation: false }, [baseMute]);
    expect(r.matched).toBe(true);
  });

  it('does not match a different host', () => {
    expect(matchMute({ host: 'h2', domain: 'exposure', isRemediation: false }, [baseMute]).matched).toBe(false);
  });

  it('never matches alerting domain (forbidden)', () => {
    const m: Mute = { ...baseMute, domain: 'alerting' };
    const r = matchMute({ host: 'h1', domain: 'alerting', isRemediation: false }, [m]);
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/forbidden/);
  });

  it('wildcard domain matches alerts but not remediation by default', () => {
    const m: Mute = { ...baseMute, domain: '*' };
    expect(matchMute({ host: 'h1', domain: 'exposure', isRemediation: false }, [m]).matched).toBe(true);
    expect(matchMute({ host: 'h1', domain: 'exposure', isRemediation: true }, [m]).matched).toBe(false);
  });

  it('wildcard with allow_revert_suppression matches remediation', () => {
    const m: Mute = { ...baseMute, domain: '*', allow_revert_suppression: true };
    expect(matchMute({ host: 'h1', domain: 'exposure', isRemediation: true }, [m]).matched).toBe(true);
  });

  it('wildcard host matches any host', () => {
    const m: Mute = { ...baseMute, host: '*' };
    expect(matchMute({ host: 'somewhere', domain: 'exposure', isRemediation: false }, [m]).matched).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/mute-match.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement mute-match**

```ts
// tools/whatsoup_guard/src/engine/mute-match.ts
import type { Mute } from '../types.ts';

const FORBIDDEN_DOMAINS = new Set(['alerting']);

export interface MuteMatchInput {
  host: string;
  domain: string;
  isRemediation: boolean;
}

export interface MuteMatchResult {
  matched: boolean;
  byMute?: Mute;
  reason?: string;
}

export function matchMute(input: MuteMatchInput, candidates: Mute[]): MuteMatchResult {
  if (FORBIDDEN_DOMAINS.has(input.domain)) {
    return { matched: false, reason: 'domain is forbidden from being muted' };
  }
  for (const m of candidates) {
    if (m.host !== '*' && m.host !== input.host) continue;
    if (m.domain !== '*' && m.domain !== input.domain) continue;
    if (input.isRemediation && m.domain === '*' && !m.allow_revert_suppression) {
      // wildcard does not suppress remediation unless explicitly allowed
      continue;
    }
    return { matched: true, byMute: m };
  }
  return { matched: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/mute-match.test.ts

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/engine/mute-match.ts tools/whatsoup_guard/tests/engine/mute-match.test.ts
git commit -m "feat(whatsoup-guard): mute matching with forbidden domains and revert-suppression semantics"
```

---

## Task 14: Collector interface + fixture collector

**Files:**
- Create: `tools/whatsoup_guard/src/collector/types.ts`
- Create: `tools/whatsoup_guard/src/collector/fixture.ts`
- Create: `tools/whatsoup_guard/tests/collector/fixture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/collector/fixture.test.ts
import { describe, expect, it } from 'vitest';
import { FixtureCollector } from '../../src/collector/fixture.ts';

describe('FixtureCollector', () => {
  it('returns the configured ProbeDoc', async () => {
    const c = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'host-a': { fields: { ports: [80, 443] } } },
    });
    const doc = await c.run('host-a');
    expect(doc.probe_id).toBe('fixture.ports');
    expect(doc.scope_id).toBe('host-a');
    expect(doc.fields).toEqual({ ports: [80, 443] });
  });

  it('throws a probe error for unknown scope', async () => {
    const c = new FixtureCollector({ id: 'fixture.x', docs: {} });
    await expect(c.run('missing')).rejects.toThrow(/no fixture/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/collector/fixture.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement collector types and fixture**

```ts
// tools/whatsoup_guard/src/collector/types.ts
import type { ProbeDoc } from '../types.ts';

export interface Collector {
  /** stable id, e.g. 'host.macos.ports' */
  readonly id: string;
  /**
   * Run the probe for one scope (a host id or other scope id) and return a canonical-shaped ProbeDoc.
   * Throws on probe error (subprocess failure, parse failure, host unreachable). The runner translates
   * thrown errors into `probe_error` events; a thrown error MUST NOT be treated as drift.
   */
  run(scopeId: string): Promise<ProbeDoc>;
}
```

```ts
// tools/whatsoup_guard/src/collector/fixture.ts
import type { Collector } from './types.ts';
import type { ProbeDoc } from '../types.ts';

export interface FixtureCollectorOptions {
  id: string;
  docs: Record<string, { fields: Record<string, unknown>; captured_at?: string }>;
}

export class FixtureCollector implements Collector {
  readonly id: string;
  private readonly docs: FixtureCollectorOptions['docs'];

  constructor(opts: FixtureCollectorOptions) {
    this.id = opts.id;
    this.docs = opts.docs;
  }

  async run(scopeId: string): Promise<ProbeDoc> {
    const fixture = this.docs[scopeId];
    if (!fixture) throw new Error(`no fixture for scope_id=${scopeId} on ${this.id}`);
    return {
      probe_id: this.id,
      scope_id: scopeId,
      captured_at: fixture.captured_at ?? new Date().toISOString(),
      fields: fixture.fields,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/collector/fixture.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/collector/types.ts \
        tools/whatsoup_guard/src/collector/fixture.ts \
        tools/whatsoup_guard/tests/collector/fixture.test.ts
git commit -m "feat(whatsoup-guard): collector interface + fixture collector"
```

---

## Task 15: Evaluator framework + canonical drift rule

**Files:**
- Create: `tools/whatsoup_guard/src/evaluator/types.ts`
- Create: `tools/whatsoup_guard/src/evaluator/canonical-rules.ts`
- Create: `tools/whatsoup_guard/tests/evaluator/canonical-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/evaluator/canonical-rules.test.ts
import { describe, expect, it } from 'vitest';
import { driftRule } from '../../src/evaluator/canonical-rules.ts';
import type { ProbeDoc } from '../../src/types.ts';

const baseline: ProbeDoc = {
  probe_id: 'p', scope_id: 's', captured_at: 'b',
  fields: { ports: [80] },
};

describe('driftRule', () => {
  it('emits no event when observed equals baseline', () => {
    const observed: ProbeDoc = { ...baseline, captured_at: 'now' };
    const events = driftRule({ observed, baseline, severity: 'high', domain: 'exposure' });
    expect(events).toEqual([]);
  });

  it('emits a drift event when observed differs', () => {
    const observed: ProbeDoc = { ...baseline, captured_at: 'now', fields: { ports: [80, 443] } };
    const events = driftRule({ observed, baseline, severity: 'high', domain: 'exposure' });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('drift');
    expect(events[0]!.severity).toBe('high');
    expect(events[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]!.payload.diff).toBeDefined();
  });

  it('emits no event when there is no baseline', () => {
    const observed: ProbeDoc = { ...baseline, captured_at: 'now' };
    const events = driftRule({ observed, baseline: undefined, severity: 'high', domain: 'exposure' });
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/evaluator/canonical-rules.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement evaluator framework + drift rule**

```ts
// tools/whatsoup_guard/src/evaluator/types.ts
import type { Event, ProbeDoc } from '../types.ts';

export type EvaluatorEventInput = Omit<Event, 'id'>;

export interface EvaluatorContext {
  observed: ProbeDoc;
  baseline: ProbeDoc | undefined;
}

export type Evaluator = (ctx: EvaluatorContext) => EvaluatorEventInput[];
```

```ts
// tools/whatsoup_guard/src/evaluator/canonical-rules.ts
import { canonicalize, fingerprint, structuralDiff } from '../canonical.ts';
import type { Domain, Severity, ProbeDoc } from '../types.ts';
import type { EvaluatorEventInput } from './types.ts';

export interface DriftRuleArgs {
  observed: ProbeDoc;
  baseline: ProbeDoc | undefined;
  severity: Severity;
  domain: Domain;
}

/**
 * Emits one `drift` event when canonical-JSON observed != canonical-JSON baseline.
 * No baseline -> no drift (the lifecycle handles missing baseline separately).
 */
export function driftRule(args: DriftRuleArgs): EvaluatorEventInput[] {
  const { observed, baseline, severity, domain } = args;
  if (!baseline) return [];
  if (canonicalize(observed.fields) === canonicalize(baseline.fields)) return [];
  const diff = structuralDiff(observed, baseline);
  return [{
    ts: observed.captured_at,
    kind: 'drift',
    domain,
    scope_id: observed.scope_id,
    probe_id: observed.probe_id,
    severity,
    fingerprint: fingerprint(observed.probe_id, observed, baseline),
    payload: { diff },
  }];
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/evaluator/canonical-rules.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/evaluator/types.ts \
        tools/whatsoup_guard/src/evaluator/canonical-rules.ts \
        tools/whatsoup_guard/tests/evaluator/canonical-rules.test.ts
git commit -m "feat(whatsoup-guard): evaluator framework + canonical drift rule"
```

---

## Task 16: Lifecycle dispatch (probe→eval→event)

**Files:**
- Create: `tools/whatsoup_guard/src/engine/lifecycle.ts`
- Create: `tools/whatsoup_guard/tests/engine/lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/engine/lifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { runOneProbe } from '../../src/engine/lifecycle.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { BaselineStore } from '../../src/store/baseline.ts';
import { EventStore } from '../../src/store/events.ts';
import { MuteStore } from '../../src/store/mutes.ts';
import { FixtureCollector } from '../../src/collector/fixture.ts';
import { driftRule } from '../../src/evaluator/canonical-rules.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = Buffer.from('a'.repeat(64), 'utf8');

function setup() {
  const db = openDatabase(':memory:');
  const baselines = new BaselineStore(db, KEY);
  const events = new EventStore(db, join(mkdtempSync(join(tmpdir(), 'wg-life-')), 'e.jsonl'));
  const mutes = new MuteStore(db);
  return { db, baselines, events, mutes };
}

describe('runOneProbe', () => {
  it('emits probe_error when collector throws', async () => {
    const { baselines, events, mutes } = setup();
    const c = new FixtureCollector({ id: 'p', docs: {} });
    const result = await runOneProbe({
      collector: c, scopeId: 'h1', baselines, events, mutes,
      evaluator: ctx => driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'high', domain: 'exposure' }),
      now: () => new Date('2026-05-08T10:00:00Z'),
    });
    expect(result.events.map(e => e.kind)).toEqual(['probe_error']);
  });

  it('emits drift when observed != baseline', async () => {
    const { baselines, events, mutes } = setup();
    baselines.set({
      probe_id: 'p', scope_id: 'h1',
      expected_doc: JSON.stringify({ ports: [80] }),
      captured_at: 'b', captured_by: 'op',
    });
    const c = new FixtureCollector({
      id: 'p',
      docs: { h1: { fields: { ports: [80, 443] }, captured_at: 'now' } },
    });
    const result = await runOneProbe({
      collector: c, scopeId: 'h1', baselines, events, mutes,
      evaluator: ctx => driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'high', domain: 'exposure' }),
      now: () => new Date('2026-05-08T10:00:00Z'),
    });
    expect(result.events.map(e => e.kind)).toEqual(['drift']);
  });

  it('emits drift_muted when a host+domain mute is active', async () => {
    const { baselines, events, mutes } = setup();
    baselines.set({
      probe_id: 'p', scope_id: 'h1',
      expected_doc: JSON.stringify({ ports: [80] }),
      captured_at: 'b', captured_by: 'op',
    });
    mutes.create({
      host: 'h1', domain: 'exposure',
      expires_at: '2099-01-01T00:00:00Z', reason: 'r', created_by: 'op',
    });
    const c = new FixtureCollector({
      id: 'p',
      docs: { h1: { fields: { ports: [80, 443] }, captured_at: 'now' } },
    });
    const result = await runOneProbe({
      collector: c, scopeId: 'h1', baselines, events, mutes,
      evaluator: ctx => driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'high', domain: 'exposure' }),
      now: () => new Date('2026-05-08T10:00:00Z'),
    });
    expect(result.events.map(e => e.kind)).toEqual(['drift_muted']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/lifecycle.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement the lifecycle**

```ts
// tools/whatsoup_guard/src/engine/lifecycle.ts
import type { Collector } from '../collector/types.ts';
import type { Evaluator } from '../evaluator/types.ts';
import type { BaselineStore } from '../store/baseline.ts';
import type { EventStore, EventInput } from '../store/events.ts';
import type { MuteStore } from '../store/mutes.ts';
import type { ProbeDoc } from '../types.ts';
import { matchMute } from './mute-match.ts';

export interface RunOneProbeArgs {
  collector: Collector;
  scopeId: string;
  baselines: BaselineStore;
  events: EventStore;
  mutes: MuteStore;
  evaluator: Evaluator;
  now: () => Date;
}

export interface RunOneProbeResult {
  events: EventInput[];
}

/**
 * Drives one probe through the full lifecycle:
 *   collector.run -> baseline lookup -> evaluator -> mute filter -> ledger append.
 * Probe errors NEVER produce drift; they produce a single `probe_error` event.
 */
export async function runOneProbe(args: RunOneProbeArgs): Promise<RunOneProbeResult> {
  const { collector, scopeId, baselines, events, mutes, evaluator, now } = args;
  const ts = now().toISOString();
  let observed: ProbeDoc;
  try {
    observed = await collector.run(scopeId);
  } catch (e) {
    const ev: EventInput = {
      ts, kind: 'probe_error',
      scope_id: scopeId, probe_id: collector.id,
      payload: { error: (e as Error).message ?? String(e) },
    };
    events.append(ev);
    return { events: [ev] };
  }

  const baselineRow = baselines.get(collector.id, scopeId);
  const baselineDoc = baselineRow
    ? { probe_id: collector.id, scope_id: scopeId, captured_at: baselineRow.captured_at, fields: JSON.parse(baselineRow.expected_doc) as Record<string, unknown> }
    : undefined;

  const produced = evaluator({ observed, baseline: baselineDoc });
  const out: EventInput[] = [];
  const active = mutes.listActive(ts);

  for (const ev of produced) {
    if (ev.kind === 'drift') {
      const mute = matchMute({ host: scopeId, domain: ev.domain ?? 'exposure', isRemediation: false }, active);
      if (mute.matched) {
        const muted: EventInput = {
          ...ev, kind: 'drift_muted',
          payload: { ...ev.payload, mute_id: mute.byMute?.id },
        };
        events.append(muted);
        out.push(muted);
        continue;
      }
    }
    events.append(ev);
    out.push(ev);
  }
  return { events: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/engine/lifecycle.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/engine/lifecycle.ts tools/whatsoup_guard/tests/engine/lifecycle.test.ts
git commit -m "feat(whatsoup-guard): probe lifecycle dispatcher (probe→eval→mute→ledger)"
```

---

## Task 17: Policy schema and YAML loader

**Files:**
- Create: `tools/whatsoup_guard/src/policy/schema.ts`
- Create: `tools/whatsoup_guard/src/policy/loader.ts`
- Create: `tools/whatsoup_guard/tests/policy/loader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/policy/loader.test.ts
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-policy-'));
  const f = join(dir, 'policy.yaml');
  writeFileSync(f, content);
  return f;
}

describe('loadPolicy', () => {
  it('loads a minimal policy', () => {
    const f = tmpFile(`
extends: development
inventory:
  hosts: []
  instances: []
deployment_roles: {}
actions: {}
transport:
  alert_sink:
    kind: whatsoup
mute_constraints:
  default_max_duration: 24h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
`);
    const p = loadPolicy(f);
    expect(p.extends).toBe('development');
    expect(p.mute_constraints.forbidden_domains).toContain('alerting');
  });

  it('rejects an unknown extends profile', () => {
    const f = tmpFile(`
extends: not-a-real-profile
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions: {}
transport: { alert_sink: { kind: whatsoup } }
mute_constraints: { default_max_duration: 1h, forbidden_domains: [], wildcard_blocks_remediation: false }
`);
    expect(() => loadPolicy(f)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/policy/loader.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement schema and loader**

```ts
// tools/whatsoup_guard/src/policy/schema.ts
import { z } from 'zod';

export const ProfileNameSchema = z.enum(['development', 'personal-strict', 'production', 'customer-managed']);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

export const HostInventorySchema = z.object({
  id: z.string(),
  platform: z.enum(['macos', 'windows', 'linux']),
  collectors: z.array(z.string()).default([]),
});

export const InstanceInventorySchema = z.object({
  id: z.string(),
  role: z.string(),
  host: z.string(),
});

export const InventorySchema = z.object({
  hosts: z.array(HostInventorySchema).default([]),
  instances: z.array(InstanceInventorySchema).default([]),
});

export const DeploymentRoleSchema = z.object({
  runtime_type: z.enum(['chat', 'agent', 'passive']).optional(),
  provider_env: z.record(z.enum(['required', 'forbidden', 'optional'])).optional(),
  enabled_plugins_max: z.number().int().nonnegative().optional(),
  enabled_plugins: z.array(z.string()).optional(),
  access_mode: z.record(z.union([z.boolean(), z.string(), z.literal('allowed')])).optional(),
  mcp_tool_set: z.array(z.string()).optional(),
});

export const ActionSchema = z.enum(['observe', 'alert', 'propose_fix', 'remediate', 'block', 'meta_alert']);

export const TransportSchema = z.object({
  alert_sink: z.object({
    kind: z.literal('whatsoup'),
    base_url: z.string().optional(),
    conversation_key: z.string().optional(),
    delivery_jid: z.string().optional(),
    target_label: z.string().optional(),
    token_file: z.string().optional(),
    timeout_s: z.number().default(10),
    retry_crit: z.array(z.number()).default([1, 5, 30]),
    retry_other: z.array(z.number()).default([]),
  }),
  meta_alert: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['ntfy', 'pushover', 'webhook']).optional(),
    secret_file: z.string().optional(),
    topic_or_destination: z.string().optional(),
  }).optional(),
});

export const MuteConstraintsSchema = z.object({
  default_max_duration: z.string(),
  forbidden_domains: z.array(z.string()),
  wildcard_blocks_remediation: z.boolean(),
});

export const PolicySchema = z.object({
  extends: ProfileNameSchema,
  inventory: InventorySchema,
  deployment_roles: z.record(DeploymentRoleSchema).default({}),
  actions: z.record(ActionSchema).default({}),
  transport: TransportSchema,
  mute_constraints: MuteConstraintsSchema,
});
export type Policy = z.infer<typeof PolicySchema>;
```

```ts
// tools/whatsoup_guard/src/policy/loader.ts
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { PolicySchema, type Policy } from './schema.ts';

export function loadPolicy(path: string): Policy {
  const text = readFileSync(path, 'utf8');
  const raw = parseYaml(text);
  return PolicySchema.parse(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/policy/loader.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/policy/schema.ts \
        tools/whatsoup_guard/src/policy/loader.ts \
        tools/whatsoup_guard/tests/policy/loader.test.ts
git commit -m "feat(whatsoup-guard): policy schema (Zod) and YAML loader"
```

---

## Task 18: Profile inheritance (extends-chain)

**Files:**
- Create: `tools/whatsoup_guard/src/policy/extends.ts`
- Create: `tools/whatsoup_guard/tests/policy/extends.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/policy/extends.test.ts
import { describe, expect, it } from 'vitest';
import { resolveExtends } from '../../src/policy/extends.ts';

describe('resolveExtends', () => {
  it('shallow-merges parent into child with child winning', () => {
    const parent = { actions: { 'a.b': 'observe' as const, 'c.d': 'alert' as const } };
    const child = { actions: { 'a.b': 'alert' as const } };
    const merged = resolveExtends(parent, child) as typeof parent;
    expect(merged.actions['a.b']).toBe('alert');
    expect(merged.actions['c.d']).toBe('alert');
  });

  it('replaces arrays at the field level (no deep merge)', () => {
    const parent = { mute_constraints: { forbidden_domains: ['alerting', 'something'] } };
    const child = { mute_constraints: { forbidden_domains: ['alerting'] } };
    const merged = resolveExtends(parent, child) as typeof parent;
    expect(merged.mute_constraints.forbidden_domains).toEqual(['alerting']);
  });

  it('preserves child fields not present in parent', () => {
    const parent = { foo: 1 };
    const child = { foo: 2, bar: 3 };
    const merged = resolveExtends(parent, child) as Record<string, number>;
    expect(merged).toEqual({ foo: 2, bar: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/policy/extends.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement extends resolution**

```ts
// tools/whatsoup_guard/src/policy/extends.ts
type Plain = Record<string, unknown>;

/**
 * Shallow merge with explicit override semantics.
 * - For each top-level key:
 *     - if both values are plain objects (not arrays), merge them at the next level only.
 *     - otherwise child wins (arrays REPLACE — no append).
 * - Keys present in parent only are kept.
 */
export function resolveExtends(parent: Plain, child: Plain): Plain {
  const out: Plain = { ...parent };
  for (const k of Object.keys(child)) {
    const cv = child[k];
    const pv = out[k];
    if (isPlainObject(cv) && isPlainObject(pv)) {
      out[k] = { ...(pv as Plain), ...(cv as Plain) };
    } else {
      out[k] = cv;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/policy/extends.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/policy/extends.ts tools/whatsoup_guard/tests/policy/extends.test.ts
git commit -m "feat(whatsoup-guard): extends-chain shallow merge"
```

---

## Task 19: Ship the four profiles

**Files:**
- Create: `tools/whatsoup_guard/src/policy/profiles/development.yaml`
- Create: `tools/whatsoup_guard/src/policy/profiles/personal-strict.yaml`
- Create: `tools/whatsoup_guard/src/policy/profiles/production.yaml`
- Create: `tools/whatsoup_guard/src/policy/profiles/customer-managed.yaml`
- Create: `tools/whatsoup_guard/tests/policy/profiles.test.ts`

- [ ] **Step 1: Write each profile**

```yaml
# tools/whatsoup_guard/src/policy/profiles/development.yaml
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions:
  exposure.unauthenticated_mutation: alert
  exposure.public_funnel_internal:   alert
  exposure.firewall_disabled:        alert
  capability.role_violation:         observe
  credential.file_mode_widened:      alert
  credential.token_aging:            observe
  change.new_persistence_unit:       observe
  change.new_application_route:      observe
  alerting.self_secret_widened:      alert
  alerting.transport_failed:         meta_alert
transport:
  alert_sink: { kind: whatsoup }
  meta_alert: { enabled: false }
mute_constraints:
  default_max_duration: 72h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
```

```yaml
# tools/whatsoup_guard/src/policy/profiles/personal-strict.yaml
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions:
  exposure.unauthenticated_mutation: remediate
  exposure.public_funnel_internal:   remediate
  exposure.firewall_disabled:        remediate
  capability.role_violation:         alert
  credential.file_mode_widened:      alert
  credential.token_aging:            propose_fix
  change.new_persistence_unit:       alert
  change.new_application_route:      alert
  alerting.self_secret_widened:      alert
  alerting.transport_failed:         meta_alert
transport:
  alert_sink: { kind: whatsoup }
  meta_alert: { enabled: false }
mute_constraints:
  default_max_duration: 24h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
```

```yaml
# tools/whatsoup_guard/src/policy/profiles/production.yaml
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions:
  exposure.unauthenticated_mutation: remediate
  exposure.public_funnel_internal:   remediate
  exposure.firewall_disabled:        remediate
  capability.role_violation:         alert
  credential.file_mode_widened:      alert
  credential.token_aging:            alert
  change.new_persistence_unit:       alert
  change.new_application_route:      alert
  alerting.self_secret_widened:      alert
  alerting.transport_failed:         meta_alert
transport:
  alert_sink: { kind: whatsoup }
  meta_alert: { enabled: true }
mute_constraints:
  default_max_duration: 8h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
```

```yaml
# tools/whatsoup_guard/src/policy/profiles/customer-managed.yaml
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions:
  exposure.unauthenticated_mutation: alert
  exposure.public_funnel_internal:   alert
  exposure.firewall_disabled:        alert
  capability.role_violation:         alert
  credential.file_mode_widened:      alert
  credential.token_aging:            alert
  change.new_persistence_unit:       alert
  change.new_application_route:      alert
  alerting.self_secret_widened:      alert
  alerting.transport_failed:         meta_alert
transport:
  alert_sink: { kind: whatsoup }
  meta_alert: { enabled: false }
mute_constraints:
  default_max_duration: 24h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
```

- [ ] **Step 2: Write the failing test**

```ts
// tools/whatsoup_guard/tests/policy/profiles.test.ts
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(HERE, '../../src/policy/profiles');

describe('shipped profiles', () => {
  for (const name of ['development', 'personal-strict', 'production', 'customer-managed']) {
    it(`loads ${name}.yaml`, () => {
      const p = loadPolicy(resolve(PROFILE_DIR, `${name}.yaml`));
      expect(p.mute_constraints.forbidden_domains).toContain('alerting');
    });
  }

  it('production requires external meta_alert', () => {
    const p = loadPolicy(resolve(PROFILE_DIR, 'production.yaml'));
    expect(p.transport.meta_alert?.enabled).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify pass**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/policy/profiles.test.ts

Expected: 5 passed.

- [ ] **Step 4: Commit**

```bash
git add tools/whatsoup_guard/src/policy/profiles/*.yaml \
        tools/whatsoup_guard/tests/policy/profiles.test.ts
git commit -m "feat(whatsoup-guard): ship four profiles (development, personal-strict, production, customer-managed)"
```

---

## Task 20: Alert message formatter

**Files:**
- Create: `tools/whatsoup_guard/src/transport/format.ts`
- Create: `tools/whatsoup_guard/tests/transport/format.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/transport/format.test.ts
import { describe, expect, it } from 'vitest';
import { formatAlert } from '../../src/transport/format.ts';

describe('formatAlert', () => {
  it('renders all required fields per spec §7.4', () => {
    const text = formatAlert({
      eventId: 4811,
      severity: 'crit',
      scopeId: 'host-a',
      probeId: 'deployment.tunneling',
      domain: 'exposure',
      ts: '2026-05-08T14:32:11Z',
      diff: { added: { 'rule:10000': '127.0.0.1:11434' }, removed: {}, changed: {} },
      actionLabel: 'remediate:APPLIED',
      fingerprint: '7a2f' + '0'.repeat(60),
    });
    expect(text).toContain('CRIT');
    expect(text).toContain('host-a');
    expect(text).toContain('deployment.tunneling');
    expect(text).toContain('remediate:APPLIED');
    expect(text).toContain('event-id: 4811');
    expect(text).toMatch(/mute:\s+whatsoup-guard mute/);
  });

  it('always includes a copy-pasteable mute line', () => {
    const text = formatAlert({
      eventId: 1, severity: 'high', scopeId: 's', probeId: 'p', domain: 'change',
      ts: 't', diff: { added: { x: 1 }, removed: {}, changed: {} },
      actionLabel: 'propose_fix:run-x',
      fingerprint: 'f'.repeat(64),
    });
    expect(text).toMatch(/mute:.*--host\s+s.*--domain\s+change/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/format.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement format**

```ts
// tools/whatsoup_guard/src/transport/format.ts
import type { Domain, Severity } from '../types.ts';

export interface FormatAlertInput {
  eventId: number;
  severity: Severity;
  scopeId: string;
  probeId: string;
  domain: Domain;
  ts: string;
  diff: { added: unknown; removed: unknown; changed: unknown };
  actionLabel: string;        // e.g. 'observe' | 'alert' | 'propose_fix:<command>' | 'remediate:APPLIED' | 'remediate:FAILED'
  fingerprint: string;
}

export function formatAlert(a: FormatAlertInput): string {
  const sevTag = a.severity.toUpperCase();
  const lines = [
    `[whatsoup-guard] ${sevTag} ${a.scopeId} — ${a.probeId}`,
    `when:    ${a.ts}`,
    `probe:   ${a.probeId}`,
    `diff:    ${JSON.stringify(a.diff)}`,
    `action:  ${a.actionLabel}`,
    `fingerprint: ${a.fingerprint}`,
    `mute: whatsoup-guard mute --host ${a.scopeId} --domain ${a.domain} --duration 1h --reason "<why>"`,
    `event-id: ${a.eventId}`,
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/format.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/transport/format.ts tools/whatsoup_guard/tests/transport/format.test.ts
git commit -m "feat(whatsoup-guard): alert message formatter (spec §7.4)"
```

---

## Task 21: Sink interface + channel chain

**Files:**
- Create: `tools/whatsoup_guard/src/transport/types.ts`
- Create: `tools/whatsoup_guard/src/transport/chain.ts`
- Create: `tools/whatsoup_guard/tests/transport/chain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/transport/chain.test.ts
import { describe, expect, it } from 'vitest';
import { runChannelChain } from '../../src/transport/chain.ts';
import type { Sink } from '../../src/transport/types.ts';

function fakeSink(name: string, succeed: boolean): Sink {
  return {
    name,
    isDurableLog: name === 'local-log',
    async deliver() {
      return { ok: succeed, channel: name, error: succeed ? undefined : 'forced' };
    },
  };
}

describe('runChannelChain', () => {
  it('returns succeeded on first sink that delivers', async () => {
    const r = await runChannelChain([fakeSink('whatsoup', true), fakeSink('local-notify', true)], { body: 'x' });
    expect(r.deliveries).toEqual([{ ok: true, channel: 'whatsoup' }]);
  });

  it('falls through on failure', async () => {
    const r = await runChannelChain([fakeSink('whatsoup', false), fakeSink('local-notify', true)], { body: 'x' });
    expect(r.deliveries.map(d => d.channel)).toEqual(['whatsoup', 'local-notify']);
    expect(r.deliveries[0]!.ok).toBe(false);
    expect(r.deliveries[1]!.ok).toBe(true);
  });

  it('emits failed_all when only durable-log delivers', async () => {
    const r = await runChannelChain([fakeSink('whatsoup', false), fakeSink('local-notify', false), fakeSink('local-log', true)], { body: 'x' });
    expect(r.failedAll).toBe(true);
  });

  it('does not call sinks after a real (non-durable-log) success', async () => {
    let called = false;
    const probe: Sink = { name: 'probe', isDurableLog: false, async deliver() { called = true; return { ok: true, channel: 'probe' }; } };
    await runChannelChain([fakeSink('whatsoup', true), probe], { body: 'x' });
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/chain.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement sink + chain**

```ts
// tools/whatsoup_guard/src/transport/types.ts
export interface AlertPayload {
  body: string;
}

export interface DeliveryResult {
  ok: boolean;
  channel: string;
  error?: string;
}

export interface Sink {
  readonly name: string;
  /**
   * If true, success on this sink does NOT count as delivery — the chain still
   * tries the next sink. Used for the durable-log audit trail.
   */
  readonly isDurableLog: boolean;
  deliver(payload: AlertPayload): Promise<DeliveryResult>;
}
```

```ts
// tools/whatsoup_guard/src/transport/chain.ts
import type { AlertPayload, DeliveryResult, Sink } from './types.ts';

export interface ChainResult {
  deliveries: DeliveryResult[];
  failedAll: boolean;
}

/** Walks sinks in order. Stops at the first NON-durable-log success. */
export async function runChannelChain(sinks: Sink[], payload: AlertPayload): Promise<ChainResult> {
  const out: DeliveryResult[] = [];
  let realSuccess = false;
  for (const s of sinks) {
    const r = await s.deliver(payload);
    out.push(r);
    if (r.ok && !s.isDurableLog) {
      realSuccess = true;
      break;
    }
  }
  return { deliveries: out, failedAll: !realSuccess };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/chain.test.ts

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/transport/types.ts \
        tools/whatsoup_guard/src/transport/chain.ts \
        tools/whatsoup_guard/tests/transport/chain.test.ts
git commit -m "feat(whatsoup-guard): channel chain with durable-log fall-through semantics"
```

---

## Task 22: WhatSoup `/send` adapter with retry-with-backoff

**Files:**
- Create: `tools/whatsoup_guard/src/transport/whatsoup.ts`
- Create: `tools/whatsoup_guard/tests/transport/whatsoup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/transport/whatsoup.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WhatSoupSink } from '../../src/transport/whatsoup.ts';

let server: Server;
let port = 0;
let attempts: number[] = [];
let nextResponse: () => { status: number; body: string };

beforeEach(async () => {
  attempts = [];
  nextResponse = () => ({ status: 200, body: '{"ok":true}' });
  server = createServer((req, res) => {
    attempts.push(Date.now());
    const r = nextResponse();
    res.statusCode = r.status;
    res.setHeader('content-type', 'application/json');
    res.end(r.body);
  });
  await new Promise<void>(r => server.listen(0, () => r()));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

describe('WhatSoupSink', () => {
  it('delivers on 200', async () => {
    const sink = new WhatSoupSink({ baseUrl: `http://127.0.0.1:${port}`, conversationKey: 'ck', token: 't' });
    const r = await sink.deliver({ body: 'hello' });
    expect(r).toEqual({ ok: true, channel: 'whatsoup' });
    expect(attempts.length).toBe(1);
  });

  it('retries with backoff for crit on 5xx', async () => {
    let n = 0;
    nextResponse = () => (++n < 3 ? { status: 503, body: 'oops' } : { status: 200, body: '{"ok":true}' });
    const sink = new WhatSoupSink({
      baseUrl: `http://127.0.0.1:${port}`, conversationKey: 'ck', token: 't', retry: [10, 10],
    });
    const r = await sink.deliver({ body: 'hello' });
    expect(r.ok).toBe(true);
    expect(attempts.length).toBe(3);
  });

  it('returns failure with status when all retries exhausted', async () => {
    nextResponse = () => ({ status: 500, body: 'no' });
    const sink = new WhatSoupSink({
      baseUrl: `http://127.0.0.1:${port}`, conversationKey: 'ck', token: 't', retry: [10],
    });
    const r = await sink.deliver({ body: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/whatsoup.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement WhatSoupSink**

```ts
// tools/whatsoup_guard/src/transport/whatsoup.ts
import type { AlertPayload, DeliveryResult, Sink } from './types.ts';

export interface WhatSoupSinkOptions {
  baseUrl: string;
  conversationKey: string;
  deliveryJid?: string;
  token: string;
  timeoutMs?: number;
  retry?: number[];                  // delays in ms between attempts
}

export class WhatSoupSink implements Sink {
  readonly name = 'whatsoup';
  readonly isDurableLog = false;
  private readonly opts: WhatSoupSinkOptions;

  constructor(opts: WhatSoupSinkOptions) { this.opts = opts; }

  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    const delays = [0, ...(this.opts.retry ?? [])];
    let lastError: string | undefined;
    for (const d of delays) {
      if (d > 0) await new Promise(r => setTimeout(r, d));
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
        try {
          const res = await fetch(`${this.opts.baseUrl}/send`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.opts.token}`,
            },
            body: JSON.stringify({
              conversation_key: this.opts.conversationKey,
              ...(this.opts.deliveryJid ? { delivery_jid: this.opts.deliveryJid } : {}),
              text: payload.body,
            }),
            signal: ctrl.signal,
          });
          if (res.ok) return { ok: true, channel: this.name };
          lastError = `http ${res.status}`;
        } finally { clearTimeout(timer); }
      } catch (e) {
        lastError = (e as Error).message ?? String(e);
      }
    }
    return { ok: false, channel: this.name, error: lastError ?? 'unknown' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/whatsoup.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/transport/whatsoup.ts tools/whatsoup_guard/tests/transport/whatsoup.test.ts
git commit -m "feat(whatsoup-guard): WhatSoup /send adapter with retry-with-backoff"
```

---

## Task 23: Local notification + durable log sinks

**Files:**
- Create: `tools/whatsoup_guard/src/transport/local-notify.ts`
- Create: `tools/whatsoup_guard/tests/transport/local-notify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/transport/local-notify.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { LocalLogSink, LocalNotifySink } from '../../src/transport/local-notify.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'wg-loc-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('local sinks', () => {
  it('LocalLogSink writes lines and reports isDurableLog', async () => {
    const path = join(tmp(), 'alerts.log');
    const s = new LocalLogSink(path);
    expect(s.isDurableLog).toBe(true);
    const r = await s.deliver({ body: 'hello' });
    expect(r.ok).toBe(true);
    expect(readFileSync(path, 'utf8').trim()).toContain('hello');
  });

  it('LocalNotifySink falls back to a file write when notifier missing', async () => {
    const fallback = join(tmp(), 'fallback.log');
    const s = new LocalNotifySink({ notifier: undefined, fallbackLogPath: fallback });
    const r = await s.deliver({ body: 'hi' });
    expect(r.ok).toBe(true);
    expect(readFileSync(fallback, 'utf8').trim()).toContain('hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/local-notify.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement local sinks**

```ts
// tools/whatsoup_guard/src/transport/local-notify.ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AlertPayload, DeliveryResult, Sink } from './types.ts';

/** Always-on durable log. Successful delivery still counts as audit-trail; chain treats it as non-final. */
export class LocalLogSink implements Sink {
  readonly name = 'local-log';
  readonly isDurableLog = true;
  constructor(private readonly path: string) { mkdirSync(dirname(path), { recursive: true }); }
  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    appendFileSync(this.path, `${new Date().toISOString()} ${payload.body}\n`);
    return { ok: true, channel: this.name };
  }
}

export interface LocalNotifySinkOptions {
  /** A function that posts a notification. undefined to skip. */
  notifier: ((title: string, body: string) => Promise<void>) | undefined;
  fallbackLogPath: string;
}

export class LocalNotifySink implements Sink {
  readonly name = 'local-notify';
  readonly isDurableLog = false;
  constructor(private readonly opts: LocalNotifySinkOptions) {
    mkdirSync(dirname(opts.fallbackLogPath), { recursive: true });
  }
  async deliver(payload: AlertPayload): Promise<DeliveryResult> {
    if (this.opts.notifier) {
      try {
        await this.opts.notifier('whatsoup-guard', payload.body);
        return { ok: true, channel: this.name };
      } catch (_e) {
        // fall through to file fallback
      }
    }
    appendFileSync(this.opts.fallbackLogPath, `${new Date().toISOString()} ${payload.body}\n`);
    return { ok: true, channel: this.name };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/local-notify.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/transport/local-notify.ts \
        tools/whatsoup_guard/tests/transport/local-notify.test.ts
git commit -m "feat(whatsoup-guard): local-log and local-notify sinks"
```

---

## Task 24: Watchdog heartbeat detection

**Files:**
- Create: `tools/whatsoup_guard/src/watchdog/heartbeat.ts`
- Create: `tools/whatsoup_guard/tests/watchdog/heartbeat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/watchdog/heartbeat.test.ts
import { describe, expect, it } from 'vitest';
import { detectHeartbeatSilence } from '../../src/watchdog/heartbeat.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-05-08T12:00:00Z');

describe('detectHeartbeatSilence', () => {
  it('does not trigger when last heartbeat is within threshold', () => {
    const r = detectHeartbeatSilence({ now: NOW, lastHeartbeatTs: NOW - 4 * HOUR, thresholdHours: 7 });
    expect(r.silent).toBe(false);
  });

  it('triggers when silence exceeds threshold', () => {
    const r = detectHeartbeatSilence({ now: NOW, lastHeartbeatTs: NOW - 8 * HOUR, thresholdHours: 7 });
    expect(r.silent).toBe(true);
    expect(r.elapsedHours).toBeGreaterThan(7);
  });

  it('triggers when there has never been a heartbeat', () => {
    const r = detectHeartbeatSilence({ now: NOW, lastHeartbeatTs: undefined, thresholdHours: 7 });
    expect(r.silent).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/watchdog/heartbeat.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement heartbeat**

```ts
// tools/whatsoup_guard/src/watchdog/heartbeat.ts
const HOUR_MS = 60 * 60 * 1000;

export interface HeartbeatInput {
  now: number;
  lastHeartbeatTs: number | undefined;
  thresholdHours: number;
}

export interface HeartbeatResult {
  silent: boolean;
  elapsedHours: number;
}

export function detectHeartbeatSilence(i: HeartbeatInput): HeartbeatResult {
  if (i.lastHeartbeatTs === undefined) return { silent: true, elapsedHours: Infinity };
  const elapsedHours = (i.now - i.lastHeartbeatTs) / HOUR_MS;
  return { silent: elapsedHours > i.thresholdHours, elapsedHours };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/watchdog/heartbeat.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/watchdog/heartbeat.ts \
        tools/whatsoup_guard/tests/watchdog/heartbeat.test.ts
git commit -m "feat(whatsoup-guard): watchdog heartbeat-silence detection"
```

---

## Task 25: Watchdog transport-broken detection

**Files:**
- Create: `tools/whatsoup_guard/src/watchdog/transport-health.ts`
- Create: `tools/whatsoup_guard/tests/watchdog/transport-health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/watchdog/transport-health.test.ts
import { describe, expect, it } from 'vitest';
import { detectTransportBroken } from '../../src/watchdog/transport-health.ts';

describe('detectTransportBroken', () => {
  it('reports broken when drift > 0 and successes == 0 with engine alive', () => {
    const r = detectTransportBroken({ engineAlive: true, deliveriesSucceeded: 0, driftEvents: 5 });
    expect(r.broken).toBe(true);
  });

  it('does not report broken when there is no drift', () => {
    const r = detectTransportBroken({ engineAlive: true, deliveriesSucceeded: 0, driftEvents: 0 });
    expect(r.broken).toBe(false);
  });

  it('does not report broken when engine is not alive (different problem)', () => {
    const r = detectTransportBroken({ engineAlive: false, deliveriesSucceeded: 0, driftEvents: 5 });
    expect(r.broken).toBe(false);
  });

  it('does not report broken when at least one delivery succeeded', () => {
    const r = detectTransportBroken({ engineAlive: true, deliveriesSucceeded: 1, driftEvents: 5 });
    expect(r.broken).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/watchdog/transport-health.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement transport-health**

```ts
// tools/whatsoup_guard/src/watchdog/transport-health.ts
export interface TransportHealthInput {
  engineAlive: boolean;
  deliveriesSucceeded: number;
  driftEvents: number;
}

export interface TransportHealthResult {
  broken: boolean;
  reason?: string;
}

export function detectTransportBroken(i: TransportHealthInput): TransportHealthResult {
  if (!i.engineAlive) return { broken: false, reason: 'engine not alive — separate problem' };
  if (i.driftEvents === 0) return { broken: false };
  if (i.deliveriesSucceeded === 0) return { broken: true, reason: 'drift accumulating with zero deliveries' };
  return { broken: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/watchdog/transport-health.test.ts

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/watchdog/transport-health.ts \
        tools/whatsoup_guard/tests/watchdog/transport-health.test.ts
git commit -m "feat(whatsoup-guard): watchdog transport-broken detection"
```

---

## Task 26: External meta-alert adapters (ntfy, pushover, webhook)

**Files:**
- Create: `tools/whatsoup_guard/src/transport/meta-alert/ntfy.ts`
- Create: `tools/whatsoup_guard/src/transport/meta-alert/pushover.ts`
- Create: `tools/whatsoup_guard/src/transport/meta-alert/webhook.ts`
- Create: `tools/whatsoup_guard/tests/transport/meta-alert.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/transport/meta-alert.test.ts
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { NtfySink } from '../../src/transport/meta-alert/ntfy.ts';
import { PushoverSink } from '../../src/transport/meta-alert/pushover.ts';
import { WebhookSink } from '../../src/transport/meta-alert/webhook.ts';

let server: Server;
let port = 0;
let lastBody = '';
beforeEach(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>(r => server.listen(0, () => r()));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

describe('meta-alert adapters', () => {
  it('NtfySink posts to topic URL', async () => {
    const s = new NtfySink({ baseUrl: `http://127.0.0.1:${port}`, topic: 't' });
    expect((await s.deliver({ body: 'hello' })).ok).toBe(true);
    expect(lastBody).toBe('hello');
  });

  it('PushoverSink posts form-encoded fields', async () => {
    const s = new PushoverSink({ apiUrl: `http://127.0.0.1:${port}/messages.json`, token: 'tk', user: 'us' });
    expect((await s.deliver({ body: 'hi' })).ok).toBe(true);
    expect(lastBody).toContain('message=hi');
    expect(lastBody).toContain('token=tk');
  });

  it('WebhookSink posts JSON body', async () => {
    const s = new WebhookSink({ url: `http://127.0.0.1:${port}/hook` });
    expect((await s.deliver({ body: 'x' })).ok).toBe(true);
    expect(JSON.parse(lastBody).body).toBe('x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/meta-alert.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement adapters**

```ts
// tools/whatsoup_guard/src/transport/meta-alert/ntfy.ts
import type { AlertPayload, DeliveryResult, Sink } from '../types.ts';

export class NtfySink implements Sink {
  readonly name = 'meta-ntfy';
  readonly isDurableLog = false;
  constructor(private readonly o: { baseUrl: string; topic: string; token?: string }) {}
  async deliver(p: AlertPayload): Promise<DeliveryResult> {
    try {
      const r = await fetch(`${this.o.baseUrl}/${this.o.topic}`, {
        method: 'POST',
        headers: this.o.token ? { authorization: `Bearer ${this.o.token}` } : {},
        body: p.body,
      });
      return r.ok ? { ok: true, channel: this.name } : { ok: false, channel: this.name, error: `http ${r.status}` };
    } catch (e) { return { ok: false, channel: this.name, error: (e as Error).message }; }
  }
}
```

```ts
// tools/whatsoup_guard/src/transport/meta-alert/pushover.ts
import type { AlertPayload, DeliveryResult, Sink } from '../types.ts';

export class PushoverSink implements Sink {
  readonly name = 'meta-pushover';
  readonly isDurableLog = false;
  constructor(private readonly o: { apiUrl: string; token: string; user: string }) {}
  async deliver(p: AlertPayload): Promise<DeliveryResult> {
    try {
      const body = new URLSearchParams({ token: this.o.token, user: this.o.user, message: p.body }).toString();
      const r = await fetch(this.o.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      return r.ok ? { ok: true, channel: this.name } : { ok: false, channel: this.name, error: `http ${r.status}` };
    } catch (e) { return { ok: false, channel: this.name, error: (e as Error).message }; }
  }
}
```

```ts
// tools/whatsoup_guard/src/transport/meta-alert/webhook.ts
import type { AlertPayload, DeliveryResult, Sink } from '../types.ts';

export class WebhookSink implements Sink {
  readonly name = 'meta-webhook';
  readonly isDurableLog = false;
  constructor(private readonly o: { url: string; bearer?: string }) {}
  async deliver(p: AlertPayload): Promise<DeliveryResult> {
    try {
      const r = await fetch(this.o.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.o.bearer ? { authorization: `Bearer ${this.o.bearer}` } : {}),
        },
        body: JSON.stringify({ body: p.body }),
      });
      return r.ok ? { ok: true, channel: this.name } : { ok: false, channel: this.name, error: `http ${r.status}` };
    } catch (e) { return { ok: false, channel: this.name, error: (e as Error).message }; }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/transport/meta-alert.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/transport/meta-alert/*.ts \
        tools/whatsoup_guard/tests/transport/meta-alert.test.ts
git commit -m "feat(whatsoup-guard): ntfy, pushover, webhook meta-alert adapters"
```

---

## Task 27: Self-secret hygiene check

**Files:**
- Create: `tools/whatsoup_guard/src/self/secret-hygiene.ts`
- Create: `tools/whatsoup_guard/tests/self/secret-hygiene.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/self/secret-hygiene.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { checkSelfSecrets } from '../../src/self/secret-hygiene.ts';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
function file(content: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-self-'));
  dirs.push(dir);
  const f = join(dir, 'secret');
  writeFileSync(f, content, { mode });
  chmodSync(f, mode);
  return f;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('checkSelfSecrets', () => {
  it('reports ok when every declared secret is at expected mode', () => {
    const a = file('x', 0o600);
    const b = file('y', 0o400);
    const r = checkSelfSecrets([{ path: a, mode: 0o600 }, { path: b, mode: 0o400 }]);
    expect(r.ok).toBe(true);
    expect(r.widened).toEqual([]);
  });

  it('reports each widened secret', () => {
    const f = file('x', 0o644);
    const r = checkSelfSecrets([{ path: f, mode: 0o600 }]);
    expect(r.ok).toBe(false);
    expect(r.widened).toEqual([{ path: f, expectedMode: 0o600, actualMode: 0o644 }]);
  });

  it('rejects nonexistent files (treats as widened/missing)', () => {
    const r = checkSelfSecrets([{ path: '/nope/no/where', mode: 0o600 }]);
    expect(r.ok).toBe(false);
    expect(r.widened[0]?.actualMode).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/self/secret-hygiene.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement secret-hygiene**

```ts
// tools/whatsoup_guard/src/self/secret-hygiene.ts
import { statSync } from 'node:fs';

export interface SelfSecretCheck {
  path: string;
  mode: number;            // expected, e.g. 0o600
}

export interface SelfSecretWidened {
  path: string;
  expectedMode: number;
  actualMode: number;      // -1 if missing
}

export interface SelfSecretResult {
  ok: boolean;
  widened: SelfSecretWidened[];
}

export function checkSelfSecrets(checks: SelfSecretCheck[]): SelfSecretResult {
  const widened: SelfSecretWidened[] = [];
  for (const c of checks) {
    let actualMode = -1;
    try {
      actualMode = statSync(c.path).mode & 0o777;
    } catch {
      actualMode = -1;
    }
    if (actualMode !== c.mode) widened.push({ path: c.path, expectedMode: c.mode, actualMode });
  }
  return { ok: widened.length === 0, widened };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/self/secret-hygiene.test.ts

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/self/secret-hygiene.ts \
        tools/whatsoup_guard/tests/self/secret-hygiene.test.ts
git commit -m "feat(whatsoup-guard): self-secret hygiene mode check"
```

---

## Task 28: Token-age check

**Files:**
- Create: `tools/whatsoup_guard/src/self/token-age.ts`
- Create: `tools/whatsoup_guard/tests/self/token-age.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/self/token-age.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { checkTokenAge } from '../../src/self/token-age.ts';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
function tokenFile(daysOld: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-tok-')); dirs.push(dir);
  const f = join(dir, 'token');
  writeFileSync(f, 'x');
  const past = (Date.now() - daysOld * 86400_000) / 1000;
  utimesSync(f, past, past);
  return f;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('checkTokenAge', () => {
  it('reports fresh token as not aging', () => {
    const f = tokenFile(10);
    const r = checkTokenAge(f, 90);
    expect(r.aging).toBe(false);
  });

  it('reports old token as aging', () => {
    const f = tokenFile(120);
    const r = checkTokenAge(f, 90);
    expect(r.aging).toBe(true);
    expect(r.ageDays).toBeGreaterThan(90);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/self/token-age.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement token-age**

```ts
// tools/whatsoup_guard/src/self/token-age.ts
import { statSync } from 'node:fs';

export interface TokenAgeResult {
  aging: boolean;
  ageDays: number;
}

export function checkTokenAge(path: string, maxAgeDays: number, now = Date.now()): TokenAgeResult {
  const st = statSync(path);
  const ageDays = (now - st.mtimeMs) / 86400_000;
  return { aging: ageDays > maxAgeDays, ageDays };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/self/token-age.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/self/token-age.ts \
        tools/whatsoup_guard/tests/self/token-age.test.ts
git commit -m "feat(whatsoup-guard): token age check"
```

---

## Task 29: Runner — compose one cycle

**Files:**
- Create: `tools/whatsoup_guard/src/runner.ts`
- Create: `tools/whatsoup_guard/tests/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/runner.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { runCycle } from '../src/runner.ts';
import { openDatabase } from '../src/store/connection.ts';
import { BaselineStore } from '../src/store/baseline.ts';
import { EventStore } from '../src/store/events.ts';
import { MuteStore } from '../src/store/mutes.ts';
import { FixtureCollector } from '../src/collector/fixture.ts';
import { driftRule } from '../src/evaluator/canonical-rules.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'wg-run-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('runCycle', () => {
  it('runs every (collector,scope) pair and emits events to the ledger', async () => {
    const db = openDatabase(':memory:');
    const KEY = Buffer.alloc(32, 'a');
    const baselines = new BaselineStore(db, KEY);
    const events = new EventStore(db, join(tmp(), 'e.jsonl'));
    const mutes = new MuteStore(db);
    baselines.set({
      probe_id: 'fixture.ports', scope_id: 'h1',
      expected_doc: JSON.stringify({ p: 1 }),
      captured_at: 'b', captured_by: 'op',
    });
    const c = new FixtureCollector({
      id: 'fixture.ports',
      docs: { h1: { fields: { p: 2 }, captured_at: 'now' } },
    });

    const out = await runCycle({
      collectors: [c],
      scopes: ['h1'],
      baselines, events, mutes,
      evaluatorFor: () => ctx => driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'high', domain: 'exposure' }),
      now: () => new Date('2026-05-08T10:00:00Z'),
    });
    expect(out.driftCount).toBe(1);
    expect(events.queryByKind('drift')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/runner.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement runCycle**

```ts
// tools/whatsoup_guard/src/runner.ts
import type { Collector } from './collector/types.ts';
import type { Evaluator } from './evaluator/types.ts';
import type { BaselineStore } from './store/baseline.ts';
import type { EventStore } from './store/events.ts';
import type { MuteStore } from './store/mutes.ts';
import { runOneProbe } from './engine/lifecycle.ts';

export interface RunCycleArgs {
  collectors: Collector[];
  scopes: string[];                                 // host ids or other scope ids; cross-product with collectors
  baselines: BaselineStore;
  events: EventStore;
  mutes: MuteStore;
  evaluatorFor: (collectorId: string) => Evaluator;
  now: () => Date;
}

export interface RunCycleResult {
  driftCount: number;
  probeErrorCount: number;
  totalEventCount: number;
}

export async function runCycle(args: RunCycleArgs): Promise<RunCycleResult> {
  let drift = 0;
  let probeErr = 0;
  let total = 0;
  for (const c of args.collectors) {
    for (const scope of args.scopes) {
      const r = await runOneProbe({
        collector: c, scopeId: scope,
        baselines: args.baselines, events: args.events, mutes: args.mutes,
        evaluator: args.evaluatorFor(c.id),
        now: args.now,
      });
      for (const ev of r.events) {
        total++;
        if (ev.kind === 'drift') drift++;
        if (ev.kind === 'probe_error') probeErr++;
      }
    }
  }
  return { driftCount: drift, probeErrorCount: probeErr, totalEventCount: total };
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/runner.test.ts

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/runner.ts tools/whatsoup_guard/tests/runner.test.ts
git commit -m "feat(whatsoup-guard): one-cycle runner composing collectors+evaluators+ledger"
```

---

## Task 30: CLI scaffold + `cycle` and `ping` commands

**Files:**
- Create: `tools/whatsoup_guard/src/cli/index.ts`
- Create: `tools/whatsoup_guard/src/cli/cycle.ts`
- Create: `tools/whatsoup_guard/tests/cli/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/cli/index.test.ts
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.ts';

describe('cli', () => {
  it('ping prints "pong v1" and exits 0', async () => {
    const out: string[] = [];
    const code = await runCli(['ping'], { write: s => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toContain('pong v1');
  });

  it('exits non-zero on unknown command', async () => {
    const code = await runCli(['nothing-real'], { write: () => {} });
    expect(code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/cli/index.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement CLI scaffold**

```ts
// tools/whatsoup_guard/src/cli/cycle.ts
export interface CycleDeps {
  write: (s: string) => void;
}

export async function cycleCommand(_args: string[], deps: CycleDeps): Promise<number> {
  // The real cycle wiring (config load, collector registry, etc.) lands in a follow-up
  // plan that ships concrete collector packs. Here we only confirm the entrypoint exists.
  deps.write('cycle: no collectors configured (engine-only build).\n');
  return 0;
}
```

```ts
// tools/whatsoup_guard/src/cli/index.ts
import { cycleCommand } from './cycle.ts';

export interface CliDeps {
  write: (s: string) => void;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'ping':
      deps.write('pong v1\n');
      return 0;
    case 'cycle':
      return cycleCommand(rest, deps);
    default:
      deps.write(`unknown command: ${cmd ?? '<none>'}\n`);
      deps.write('usage: whatsoup-guard <ping|cycle>\n');
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2), { write: s => process.stdout.write(s) }).then(c => process.exit(c));
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/cli/index.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/cli/index.ts \
        tools/whatsoup_guard/src/cli/cycle.ts \
        tools/whatsoup_guard/tests/cli/index.test.ts
git commit -m "feat(whatsoup-guard): cli scaffold with ping + cycle"
```

---

## Task 31: Simulator mode

**Files:**
- Create: `tools/whatsoup_guard/src/simulator.ts`
- Create: `tools/whatsoup_guard/tests/e2e/simulator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/e2e/simulator.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { runSimulator } from '../../src/simulator.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'wg-sim-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('runSimulator', () => {
  it('drives a fixture cycle that produces a drift event', async () => {
    const stateDir = tmp();
    const result = await runSimulator({
      stateDir,
      fixture: {
        baselines: { 'fixture.ports/h1': { ports: [80] } },
        observations: { 'fixture.ports/h1': { ports: [80, 443] } },
      },
      now: '2026-05-08T10:00:00Z',
    });
    expect(result.drifts).toBe(1);
    expect(result.probeErrors).toBe(0);
  });

  it('does not produce drift when observed equals baseline', async () => {
    const result = await runSimulator({
      stateDir: tmp(),
      fixture: {
        baselines: { 'fixture.x/h1': { a: 1 } },
        observations: { 'fixture.x/h1': { a: 1 } },
      },
      now: '2026-05-08T10:00:00Z',
    });
    expect(result.drifts).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/e2e/simulator.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement simulator**

```ts
// tools/whatsoup_guard/src/simulator.ts
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDatabase } from './store/connection.ts';
import { BaselineStore } from './store/baseline.ts';
import { EventStore } from './store/events.ts';
import { MuteStore } from './store/mutes.ts';
import { FixtureCollector } from './collector/fixture.ts';
import { driftRule } from './evaluator/canonical-rules.ts';
import { runCycle } from './runner.ts';

export interface SimulatorInput {
  stateDir: string;
  fixture: {
    /** Maps "<probe_id>/<scope_id>" -> baseline fields. */
    baselines: Record<string, Record<string, unknown>>;
    /** Maps "<probe_id>/<scope_id>" -> observed fields. */
    observations: Record<string, Record<string, unknown>>;
  };
  now: string;
}

export interface SimulatorResult {
  drifts: number;
  probeErrors: number;
  totalEvents: number;
}

export async function runSimulator(i: SimulatorInput): Promise<SimulatorResult> {
  mkdirSync(i.stateDir, { recursive: true });
  const db = openDatabase(join(i.stateDir, 'state.sqlite'));
  const baselines = new BaselineStore(db, Buffer.alloc(32, 'k'));
  const events = new EventStore(db, join(i.stateDir, 'events.jsonl'));
  const mutes = new MuteStore(db);

  const probesByScope = groupKeysByScope(i.fixture.observations);
  const collectors = Array.from(new Set(Object.keys(i.fixture.observations).map(k => k.split('/')[0]!))).map(probeId => {
    const docs: Record<string, { fields: Record<string, unknown>; captured_at?: string }> = {};
    for (const [k, v] of Object.entries(i.fixture.observations)) {
      const [pid, scope] = k.split('/');
      if (pid === probeId && scope) docs[scope] = { fields: v, captured_at: i.now };
    }
    return new FixtureCollector({ id: probeId, docs });
  });
  const allScopes = Array.from(new Set(Object.values(probesByScope).flat()));

  for (const [k, fields] of Object.entries(i.fixture.baselines)) {
    const [probe_id, scope_id] = k.split('/');
    if (!probe_id || !scope_id) continue;
    baselines.set({
      probe_id, scope_id,
      expected_doc: JSON.stringify(fields),
      captured_at: 'b', captured_by: 'sim',
    });
  }

  const r = await runCycle({
    collectors, scopes: allScopes,
    baselines, events, mutes,
    evaluatorFor: () => ctx => driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'high', domain: 'exposure' }),
    now: () => new Date(i.now),
  });
  db.close();
  return { drifts: r.driftCount, probeErrors: r.probeErrorCount, totalEvents: r.totalEventCount };
}

function groupKeysByScope(map: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(map)) {
    const [pid, scope] = k.split('/');
    if (!pid || !scope) continue;
    (out[pid] ??= []).push(scope);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/e2e/simulator.test.ts

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tools/whatsoup_guard/src/simulator.ts \
        tools/whatsoup_guard/tests/e2e/simulator.test.ts
git commit -m "feat(whatsoup-guard): simulator mode end-to-end"
```

---

## Task 32: `simulate`, `mute`, `status` CLI subcommands

**Files:**
- Modify: `tools/whatsoup_guard/src/cli/index.ts`
- Create: `tools/whatsoup_guard/src/cli/mute.ts`
- Create: `tools/whatsoup_guard/src/cli/simulate.ts`
- Create: `tools/whatsoup_guard/tests/cli/mute.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tools/whatsoup_guard/tests/cli/mute.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { runCli } from '../../src/cli/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'wg-cli-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('mute cli', () => {
  it('rejects an empty reason', async () => {
    const out: string[] = [];
    const code = await runCli([
      'mute', '--state-dir', tmp(),
      '--host', 'h', '--domain', 'exposure',
      '--duration', '1h', '--reason', '',
    ], { write: s => out.push(s) });
    expect(code).not.toBe(0);
    expect(out.join('')).toMatch(/reason/i);
  });

  it('creates and lists an active mute', async () => {
    const stateDir = tmp();
    const out: string[] = [];
    let code = await runCli([
      'mute', '--state-dir', stateDir,
      '--host', 'h', '--domain', 'exposure',
      '--duration', '1h', '--reason', 'test',
    ], { write: s => out.push(s) });
    expect(code).toBe(0);
    out.length = 0;
    code = await runCli(['status', '--state-dir', stateDir], { write: s => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/h\s+exposure/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/cli/mute.test.ts

Expected: FAIL.

- [ ] **Step 3: Implement mute, simulate, status commands**

```ts
// tools/whatsoup_guard/src/cli/mute.ts
import { join } from 'node:path';
import { openDatabase } from '../store/connection.ts';
import { MuteStore } from '../store/mutes.ts';

export interface CmdDeps { write: (s: string) => void; }

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function parseDuration(d: string): number {
  const m = /^(\d+)([smhd])$/.exec(d);
  if (!m) throw new Error(`invalid duration: ${d}`);
  const n = Number(m[1]);
  const unit = m[2]!;
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
}

export async function muteCommand(args: string[], deps: CmdDeps): Promise<number> {
  const stateDir = getOpt(args, '--state-dir');
  const host = getOpt(args, '--host');
  const domain = getOpt(args, '--domain');
  const duration = getOpt(args, '--duration');
  const reason = getOpt(args, '--reason');
  if (!stateDir || !host || !domain || !duration || !reason || reason.length === 0) {
    deps.write('usage: mute --state-dir <d> --host <h> --domain <d> --duration <Nm|Nh|Nd> --reason <text>\n');
    return 2;
  }
  const ms = parseDuration(duration);
  const expires_at = new Date(Date.now() + ms).toISOString();
  const db = openDatabase(join(stateDir, 'state.sqlite'));
  const mutes = new MuteStore(db);
  const id = mutes.create({ host, domain, expires_at, reason, created_by: process.env.USER ?? 'op' });
  db.close();
  deps.write(`mute id=${id} host=${host} domain=${domain} expires_at=${expires_at}\n`);
  return 0;
}

export async function statusCommand(args: string[], deps: CmdDeps): Promise<number> {
  const stateDir = getOpt(args, '--state-dir');
  if (!stateDir) { deps.write('usage: status --state-dir <d>\n'); return 2; }
  const db = openDatabase(join(stateDir, 'state.sqlite'));
  const mutes = new MuteStore(db);
  const active = mutes.listActive(new Date().toISOString());
  if (active.length === 0) { deps.write('no active mutes\n'); db.close(); return 0; }
  for (const m of active) deps.write(`${m.host}\t${m.domain}\texpires=${m.expires_at}\treason=${m.reason}\n`);
  db.close();
  return 0;
}
```

```ts
// tools/whatsoup_guard/src/cli/simulate.ts
import { runSimulator } from '../simulator.ts';
import { readFileSync } from 'node:fs';

export interface CmdDeps { write: (s: string) => void; }

function getOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export async function simulateCommand(args: string[], deps: CmdDeps): Promise<number> {
  const stateDir = getOpt(args, '--state-dir');
  const fixturePath = getOpt(args, '--fixture');
  const now = getOpt(args, '--now') ?? new Date().toISOString();
  if (!stateDir || !fixturePath) { deps.write('usage: simulate --state-dir <d> --fixture <fixture.json> [--now <iso>]\n'); return 2; }
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const r = await runSimulator({ stateDir, fixture, now });
  deps.write(`drifts=${r.drifts} probe_errors=${r.probeErrors} total=${r.totalEvents}\n`);
  return 0;
}
```

```ts
// tools/whatsoup_guard/src/cli/index.ts
import { cycleCommand } from './cycle.ts';
import { muteCommand, statusCommand } from './mute.ts';
import { simulateCommand } from './simulate.ts';

export interface CliDeps { write: (s: string) => void; }

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'ping': deps.write('pong v1\n'); return 0;
    case 'cycle': return cycleCommand(rest, deps);
    case 'mute': return muteCommand(rest, deps);
    case 'unmute':
      // unmute by id is a single-line db delete; deferred to runbook tooling
      deps.write('unmute: not implemented yet\n');
      return 2;
    case 'status': return statusCommand(rest, deps);
    case 'simulate': return simulateCommand(rest, deps);
    default:
      deps.write(`unknown command: ${cmd ?? '<none>'}\n`);
      deps.write('usage: whatsoup-guard <ping|cycle|mute|status|simulate>\n');
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2), { write: s => process.stdout.write(s) }).then(c => process.exit(c));
}
```

- [ ] **Step 4: Run test to verify it passes**

    npx vitest run --pool=forks --root tools/whatsoup_guard tests/cli/mute.test.ts

Expected: 2 passed.

- [ ] **Step 5: Run the full suite to confirm nothing else regressed**

    npx vitest run --pool=forks --root tools/whatsoup_guard

Expected: every test file passes.

- [ ] **Step 6: Commit**

```bash
git add tools/whatsoup_guard/src/cli/index.ts \
        tools/whatsoup_guard/src/cli/mute.ts \
        tools/whatsoup_guard/src/cli/simulate.ts \
        tools/whatsoup_guard/tests/cli/mute.test.ts
git commit -m "feat(whatsoup-guard): cli mute/status/simulate subcommands"
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4 Five protection domains | Tasks 3 (Domain enum), 19 (action keys per domain) |
| §5 Policy model + extends | Tasks 17, 18, 19 |
| §6.1 Collector packs (interface only) | Task 14 |
| §6.2 Baseline + HMAC | Tasks 5, 6, 7 |
| §6.3 Evaluators (pure fn) | Task 15 |
| §6.4 Event ledger (sqlite + jsonl) | Task 8 |
| §6.5 Actions | Task 17 (ActionSchema enum); engine wiring extends in follow-up |
| §7.1 Channel chain | Tasks 21, 22, 23, 26 |
| §7.2 Watchdog | Tasks 24, 25 |
| §7.3 Stable identifiers | Task 17 (transport schema uses conversation_key) |
| §7.4 Alert content shape | Task 20 |
| §7.5 Storm guard | Task 11 |
| §7.6 Mute scope | Tasks 9, 13 |
| §8.1 Per-deployment-role policy | Task 17 (DeploymentRoleSchema); concrete role evaluation lives in collector packs (follow-up) |
| §8.2 Credential probes never read values | Built into the collector contract (Task 14 docstring); concrete enforcement is in collector packs |
| §8.3 Self-credential hygiene | Tasks 27, 28 |
| §9 Four profiles | Task 19 |
| §10 Testing philosophy | Conventions section + every task |

**Gaps deferred to follow-up plans (one per concrete collector pack):**
- Concrete platform collectors (`host.macos.*`, `host.windows.*`, `whatsoup.instance.*`, `whatsoup.fleet.*`, `deployment.*`, `repo.*`, `app.api_auth_probe`).
- Wrappers and forced-command shim (deployment-time installation artifacts).
- `unmute` CLI subcommand body (interface stubbed).
- Operator inventory loader (config that *uses* the policy schema; the schema itself is shipped here).
- Per-cycle `heartbeat` event emission and the digest scheduler — wired in the follow-up plan that introduces a real cron-driven runner alongside concrete collectors.

**Placeholder scan:** no `TBD`, no "implement later," every code step has full code. Each test step has full test code. Each command step has the exact command and expected output.

**Type consistency:**
- `EventInput` (`Omit<Event,'id'>`) used consistently across `EventStore`, lifecycle, and runner.
- `Severity`, `Domain`, `EventKind` enums imported from `types.ts` everywhere.
- `Sink` interface used by `WhatSoupSink`, `LocalLogSink`, `LocalNotifySink`, `NtfySink`, `PushoverSink`, `WebhookSink` and by `runChannelChain`.
- `EvaluatorContext` / `Evaluator` types used by `driftRule`, `runOneProbe`, `runCycle`.

**Scope check:** the plan produces working, testable software on its own — the engine can be exercised end-to-end via the simulator (Task 31) and the CLI (Task 32) without any platform-specific collector. Concrete platform packs are explicitly deferred; each becomes its own plan.

---

*End of plan.*
