# Architectural Fitness Taxonomy

This catalog is the human-readable view of the architectural fitness registry in
`scripts/lib/fitness/registry.ts`. The registry is the source of truth for rule
metadata. This document exists so reviewers can understand why each rule exists
and which enforcement surfaces can eventually project it.

The foundation stage is intentionally non-enforcing. Later stages can project
mechanical rules into repo guards and CI, AST rules into ESLint, author-time
rules into hooks, and semantic or human rules into the SDLC review flow.

## Rule Fields

- `category`: architecture, invariant, process, hygiene, test, meta, or portability.
- `detect`: mechanical, AST, semantic, or human.
- `rings`: hook, eslint, guard, ci, or sdlc.
- `severity`: block, warn, or advisory.
- `source`: evidence that caused the rule to exist.
- `implementedBy`: what actually enforces the rule — npm script names
  (`guard:transport-patterns`, `typecheck:all`) or repo-relative test paths.
  **Required for every `severity: 'block'` rule** and asserted by
  `tests/scripts/fitness-registry-backing.test.ts`. It exists because the
  rule→enforcement link used to live only in prose here and in `rationale`: four block
  rules had no occurrence of their rule id anywhere outside the registry and this
  document, so confirming they were enforced meant archaeology rather than running a
  check.

  Entries are **alternative routes to the same detector, not a conjunction** — a rule
  is enforced on a gate path when *any* of its entries runs there. `hygiene.internal-labels`
  lists three `guard:repo` modes for this reason, and only `guard:repo:release-hygiene`
  runs on the tag gate.

  Reachability is answered **per gate path**, because the two are not equivalent:

  | path | workflow | full suite? | consequence |
  |---|---|---|---|
  | `pull-request` | `quality.yml` | yes (`coverage:check`) | a live-tree test can carry a guard with no named step |
  | `tag-release` | `tag-release-gate.yml` | **no** | a named step is the only way a check runs |

  All 17 block rules are covered on `pull-request`. **12 are not covered on
  `tag-release`**, recorded as an exact ratchet in `TAG_PATH_UNCOVERED_BLOCK_RULES` so
  the gap cannot widen — or close — unnoticed. That is second-order rather than a live
  breach (a tag is cut from a PR-gated `main`), but `enforce_admins` is false here, so
  the tag gate is the only check downstream of an admin push to `main`. Whether to make
  the tag gate mirror the PR gate is a release-engineering decision, left to whoever
  owns that workflow.

  It proves each block rule *declares* a real backstop that exists, runs somewhere, and
  is unbypassable on the PR path — not that the backstop detects what the rule
  describes. That link stays hand-asserted, in `rationale` and in each guard's own tests.

## Architecture

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `arch.file-size` | mechanical | block† | hook, eslint, guard, ci | Ratchet file line counts so known large files can shrink but not keep growing. |
| `arch.god-class` | ast | warn | eslint | Warn when a class owns too many unrelated runtime responsibilities. |
| `arch.test-colocation-churn` | mechanical | advisory | guard | Surface test files whose churn suggests an unstable production boundary. |
| `arch.defense-both-layers` | semantic | advisory | sdlc | Ensure service-layer protections are also threaded through route or caller boundaries. |
| `arch.import-boundaries` | mechanical | block | guard, ci | Ratchet import direction between src/ layers so known violations can shrink but new cross-layer reach is blocked. |
| `arch.approved-api-client` | ast | warn | eslint | Console network calls must go through the typed API client in `console/src/lib/api.ts`; direct fetch bypasses auth, timeouts, and the test surface. |
| `arch.ring-boundaries` | ast | block‡ | eslint, guard | Backend ring dependency direction is an architectural invariant; lower rings must not import higher rings. Promoted 2026-07-19 to a guard-ring count ratchet (`scripts/ring-boundary-guard.ts`); the eslint ring stays a warn-only visibility mirror. |
| `arch.sqlite-busy-timeout-ssot` | ast | warn | eslint | Numeric `PRAGMA busy_timeout` strings passed directly to SQLite `exec`/`prepare` sinks and `DatabaseSync` timeout options can drift across connections; active `src/` and `scripts/` code must use the shared constants from `src/lib/sqlite-constants.ts`. Unresolvable constructor options are findings, not silent passes. The zero-debt Vitest ratchet provides the blocking PR/CI backstop. |
| `arch.ssot-lid-reads` | mechanical | block‡ | guard, ci | Raw `lid_mappings` SQL reads outside `src/core/lid-resolver.ts` fork the LID→phone resolution discipline `resolveLid()` centralizes. |
| `arch.ssot-jid-construction` | mechanical | block‡ | guard, ci | Inline `${x}@s.whatsapp.net`-class template construction and literal `.endsWith('@lid')`-class predicates outside `src/core/jid-constants.ts` re-derive the JID domain grammar. |
| `arch.ssot-name-ladder` | mechanical | block‡ | guard, ci | SQL touching the name columns of contacts/chats/groups/chat_aliases outside `src/core/chat-display-name.ts` forks the owner-facing name ladder. |
| `arch.ssot-phone-shape` | mechanical | block‡ | guard, ci | Anchored phone-shape regex literals and `+${…phone…}` formatting outside `src/lib/phone.ts` fork the phone-identity discipline. |
| `arch.ssot-presentation-literals` | mechanical | block‡ | guard, ci | Registry-carried user-facing phrases (start narrow: the pass-through phrase, `PASSTHROUGH_PHRASE` in `command-registry.ts`) must not be re-forked as literals across render modules. |

‡ These rules are **count-ratcheted** through `.claude/fitness/baseline.json` (see the
  Pattern-Count Ratchet Baseline section below). New violations block; shrinking counts
  require lowering the baseline in the same commit; a zero-baseline rule is a pure block.

† `arch.file-size` severity is `block` for the **hook, guard, and ci rings** (enforced via `.claude/fitness/baseline.json` ratchet:
  a per-file `maxLines` growth ceiling, checked against each file's actual line count).
  The **eslint ring** mirrors it at `warn` severity only — an advisory copy per `meta.no-redundant-gates`.
  The ESLint warning identity set must not change, and the recorded ceilings must not be exceeded; both are
  enforced by `tests/scripts/fitness-file-size-warning-budget.test.ts`.

### SQLite busy-timeout detector boundary

`arch.sqlite-busy-timeout-ssot` resolves literals, template strings, `+`
expressions, and same-scope `const` chains. Numeric SQLite syntax includes
signed, decimal, exponent, and hexadecimal forms, including SQLite's
single-quote, double-quote, backtick, and bracket value forms and numeric-prefix
conversion inside a quoted value. The scanner splits SQL statements and removes
comments only outside quoted regions, then recognizes unqualified,
schema-qualified, or quoted `busy_timeout` pragma names at the start of a
statement. A phrase embedded in a `SELECT` string literal or arbitrary prose is
not treated as a pragma. For SQL, the rule inspects the first argument of any
direct member call named `exec` or `prepare`; it does not prove that the receiver
is a SQLite object. A numeric `PRAGMA busy_timeout` statement is a finding only
when it reaches one of those method-name sinks.

For the second `DatabaseSync` argument, the detector resolves inline object
literals, same-scope `const` objects, and ordered object spreads. A `const`
binding is not assumed to make an object immutable: member assignment, update,
or deletion and `Object.assign`, `Object.defineProperty`,
`Object.defineProperties`, `Object.setPrototypeOf`, or
`Reflect.defineProperty` mutations through the binding or a same-scope `const`
alias produce `unknownOptions`. Static numeric timeout values are findings. Only
`SQLITE_BUSY_TIMEOUT_MS` imported from the canonical
`src/lib/sqlite-constants.ts` is accepted as the timeout value. An imported or
otherwise unresolvable options object, spread, computed property name, or
timeout value, and any constructor argument spread that can affect the path or
options positions, produces an explicit `unknownOptions` finding; the blocking
zero-finding ratchet cannot mistake that state for compliance. An omitted
options argument and a fully resolved object with no `timeout` property are valid,
which covers the production `READ_ONLY_DATABASE_OPTIONS` pattern.

`DatabaseSync` constructors are matched through named or namespace imports from
`node:sqlite`, including local aliases, rather than by identifier spelling.
This is deliberately intraprocedural. SQL returned by helpers, arbitrary
imported SQL strings, detached or aliased `exec`/`prepare` methods, mutation
hidden inside arbitrary helper calls, non-`const` aliases, and aliases stored
through object properties or other containers are residual dataflow limits.
Review remains responsible for those shapes until the rule grows symbol-aware
interprocedural analysis; the rule does not claim to cover them.

## Invariant

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `invariant.seq-locality` | mechanical | warn | guard | Keep user inbound sequence and system-result state mutation in one owner module. |
| `invariant.fail-closed-scanner` | ast | warn | eslint, sdlc | Ensure scanner parse failures raise findings instead of returning clean results. |
| `invariant.outbox-env-gated` | ast | warn | eslint | Bot-errors outbox writes must derive their path from `resolveBotErrorsOutbox()` so the test-redirect applies; a hardcoded outbox path literal lands in the PROD outbox even under VITEST. |
| `invariant.timer-rearm-without-clear` | ast | warn | eslint | Forward-looking guard against writing a timer handle INLINE in a `Map.set` value literal and re-arming without a clear. Catches only the inline shape (zero findings today — the codebase uses build-then-set); the field-assigned OperationTracker variant is covered by its regression test, not this lexical rule. |
| `invariant.fail-closed-gate` | mechanical | block | guard, hook | Prevent shell gates from masking command failures as successful readiness checks. |
| `invariant.no-unsafe-type-escapes` | ast | warn | eslint | `any` and TypeScript suppressions erase compiler feedback that autonomous agents depend on as operating boundaries. |

## Process

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `process.fix-cluster` | mechanical | advisory | ci | Escalate repeated fixes in one subsystem into a design review. |
| `process.canary-before-fleet` | human | advisory | sdlc | Require canary evidence before fleet rollout for timing-dependent behavior. |
| `process.deploy-sha-drift` | mechanical | advisory | guard | Surface live host drift from the reviewed or published commit. |
| `process.no-destructive-git` | mechanical | block | guard, hook | Keep destructive git cleanup commands out of committed automation. |
| `process.verify-before-claim` | human | advisory | sdlc | Require fresh evidence before completion, merge, or deployment claims. |
| `process.evidence-sha-anchor` | mechanical | warn | guard | Keep cited evidence tied to the actual reviewed commit. |
| `process.shared-checkout-safety` | human | advisory | hook, sdlc | Protect shared checkout state from cross-session cleanup or branch switching. |

## Hygiene

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `hygiene.commit-author` | mechanical | block | guard, ci | Reject placeholder or tool-generated commit author identities. |
| `hygiene.internal-labels` | mechanical | block | guard | Extend existing repo hygiene coverage for internal planning labels. |
| `hygiene.pr-scope-coherence` | semantic | advisory | sdlc | Keep PR title type and diff scope aligned. |
| `hygiene.no-wa-jid-literal-in-generic-ui` | mechanical | block | guard, ci | Block new WhatsApp JID literals (`@s.whatsapp.net`, `@g.us`) in generic UI/ops surfaces (console + deploy/scripts); existing occurrences ratchet-baselined. |
| `hygiene.no-whatsapp-copy-in-generic-ui` | mechanical | block | guard, ci | Block new WhatsApp-presuming copy in generic console components; per-transport copy variants instead. |
| `hygiene.no-health-whatsapp-key-read` | mechanical | block | guard, ci | Block new direct `health.whatsapp` key reads in console; reads go through the generic transport-health accessor with legacy fallback. |
| `hygiene.catch-justification` | ast | warn | eslint | Flag catch blocks whose bodies only swallow/no-op unless they carry a reasoned justification; 127 inherited semantic identities are shrink-only ratchet debt. |

## Portability

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `portability.no-hardcoded-platform-binaries` | mechanical | block | guard, ci | Hardcoded `/usr/bin/python`, `/usr/bin/git`, etc. break on macOS and NixOS where binaries live elsewhere. Must use env-resolved lookups. |
| `portability.platform-paths-guarded` | mechanical | block | guard, ci | `/proc/`, `/sys/`, `/run/` paths are Linux-only and must be behind a `process.platform === "linux"` guard or equivalent. |
| `portability.systemctl-guarded` | mechanical | block | guard, ci | `systemctl` is Linux-only; callers must have a macOS `launchctl` fallback or platform guard. |
| `portability.gnu-bsd-shell-flags` | mechanical | block | guard, ci | GNU-only shell flags (`readlink -f`, `sha256sum`, `stat -c`, `grep -P`, `mktemp --directory`) fail on BSD/macOS. Must use portable alternatives or platform branches. |
| `portability.editorconfig-present` | mechanical | advisory | guard | Repository must maintain `.editorconfig` for cross-platform editor consistency (LF line endings, indentation). |
| `portability.arch-blind-binary-resolution` | semantic | warn | guard, ci | Custom binary resolvers and bare `execFile()`/`spawn()` calls are architecture-blind. `process.arch` recorded in telemetry but never consumed. New binary resolution code should use or extend `resolveBinaryPath()`. |
| `portability.arch-blind-path-fallback` | mechanical | warn | guard, ci | PATH fallbacks omit `/opt/homebrew/bin` (ARM macOS Homebrew prefix). In stripped environments (launchd, minimal systemd --user), brew-installed binaries vanish on Apple Silicon. |
| `portability.hardcoded-signal-name` | mechanical | warn | guard, ci | Signal string literals (`'SIGTERM'`, `'SIGKILL'`, `'SIGINT'`) in `.kill()`, `process.on()`, and `killSignal` options must use shared constants for cross-platform portability. |
| `portability.fetch-timeout` | ast | warn | eslint | `fetch()` calls must include an `AbortSignal.timeout()` to prevent indefinite hangs on unresponsive hosts. |
| `portability.sync-exec-timeout` | ast | warn | eslint | `execSync`/`execFileSync`/`spawnSync` must include a `timeout` option to prevent event-loop blocking on hanging subprocesses. |

## Test

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `test.typecheck-all-required` | mechanical | block | guard, ci | Require the full test TypeScript config in push and merge verification. |
| `test.skip-categorization` | ast | advisory | eslint | Separate environment-dependent skips from timing-dependent skips. |
| `test.red-green-required` | semantic | advisory | sdlc | Prefer tests that prove pre-fix failure over tests that only pin current behavior. |
| `test.insecure-tempfile` | mechanical | block | guard, ci | Block `tempfile.mktemp()` and hardcoded `/tmp` write-targets in python/shell; detects creation/write only (read-only refs allowed). |

## Meta

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `meta.no-redundant-gates` | human | advisory | sdlc | Route new enforcement through existing guard and review surfaces instead of adding parallel gates. |

## Ratchet Baseline

Ratcheted rules are grandfathered through `.claude/fitness/baseline.json` (measurements-based),
`.claude/fitness/boundary-baseline.json` (import violations), or
`.claude/fitness/platform-baseline.json` (platform-pattern violations).
Current baseline measurements:

| rule | path | lines | ceiling |
|------|------|-------|---------|
| `arch.file-size` | `src/runtimes/agent/runtime.ts` | 12130 | 12500 |
| `arch.file-size` | `tests/runtimes/agent/runtime.test.ts` | 16579 | 16579 |

Historical bump (predates `guard:baseline-growth`; this path is now blocked — see
"Growing past a ceiling" below): +105 lines in
`src/runtimes/agent/runtime.ts` (12256 → 12361) for the D-4 v1.1 additions
(boot-time `consumeQueuedPollDecisions` + the textFallback branch on
`resolvePollDecisionFromConsole` — state-interleaved with the runtime's
poll-resolution machinery, deliberately reusing the existing vote/typed-answer
paths rather than new subsystems). Slicing considered; the code IS the
poll-resolution path's own class (#1977 decomposition is the separate lane).

The `ceiling` column (the `maxLines` field on each measurement in `baseline.json`) is a **blocking
growth ceiling**. `tests/scripts/fitness-file-size-warning-budget.test.ts` measures each file's
actual current line count (equivalent to `wc -l`) at test time and fails if it exceeds the recorded
ceiling — this blocks `coverage:check` and `verify:release` (both run the full test suite), so growth
past a grandfathered file's ceiling is no longer silently green. Shrinking below the ceiling never
fails and never auto-lowers it; it only prints a non-blocking WARN suggesting a human lower it.

### Growing past a ceiling (bumps are blocked; extract instead)

Raising a ceiling is no longer an available routine procedure. `guard:baseline-growth`
(`scripts/baseline-growth-guard.ts`, wired into `verify:push:branch`) weighs every registered
baseline — including each `maxLines` ceiling in `.claude/fitness/baseline.json` — at the merge
base and in the candidate, and **refuses any increase**: a baseline may only shrink. The
two-twin bump ceremony this section used to describe is exactly the edit that guard blocks.

When a change would push a grandfathered file past its ceiling:

1. **Create headroom by extraction (the sanctioned path).** Move pure, self-contained code out
   of the oversized file so the change fits under the unchanged ceiling. Precedents on
   `src/runtimes/agent/runtime.ts`: `0af939b95` (runtime leaf collaborators, net −167) and
   PR #2563 (`runtime-presentation.ts`, 7 pure module-level functions, net −65). Prove the
   move is pure — moved bodies byte-identical modulo `export`, donor diff = deletions plus the
   new import — and run the file's behavioral suite.
2. **If widening is genuinely unavoidable**, the reviewed-widening path is machine-checkable
   via a **growth waiver** (`.claude/fitness/growth-waivers.json`): first land a standalone
   PR adding an issue-linked waiver entry — that PR *is* the review — then the widening PR
   passes `guard:baseline-growth` mechanically. Waivers are fail-closed by construction:
   the guard reads them from the **merge base only** (a PR can never author its own
   authorization), `maxWeight` is an **absolute cap** (self-spending — once the widening
   lands, the cap equals the base and authorizes nothing further), they **expire**
   (`expiresAt`), only numeric weight growth is waivable (identity introductions never
   are), and a malformed waiver document is INCONCLUSIVE, not ignored. A widening remains
   an exceptional, standalone act — never a side effect of a feature branch.

Shrinking below a ceiling never auto-lowers it (only a WARN suggests it). Lowering the ceiling
to match a shrink is itself a conscious act: it permanently donates the freed headroom, so time
it deliberately — e.g. don't lower immediately after an extraction made specifically to unwedge
in-flight work.

> **TEMPORARY ALLOWANCE (2026-07-27, owner-granted): `src/runtimes/agent/runtime.ts` ceiling
> 12131 → 12500.** This is recorded debt, not room to grow. Granted via path 2 above (a
> standalone reviewed widening) for the backlog-landing window: at grant time 12 open PRs
> touched runtime.ts against 1 line of headroom. Payback is the #1977 decomposition program —
> once the backlog lands and the file is decomposed, the ceiling returns below the original
> 12131 and then ratchets down at each decomposition wave boundary. Retirement of this
> allowance is tracked in issue #1977; it must not outlive the program.

`arch.import-boundaries` grandfathered violations are tracked in `.claude/fitness/boundary-baseline.json`.
Run `npm run guard:boundaries -- --report` to see the full edge list and `npm run guard:boundaries -- --baseline-save` to ratchet down after fixing violations.

### Pattern-Count Ratchet Baseline

The portability pattern rules, SSOT pattern rules, and the promoted ring rule are **count-ratcheted**: each rule's
`violationCount` in `.claude/fitness/baseline.json` records today's surviving violations
(the allowlisted debt enumerated with reasons in the guard scripts). Enforcement
(`npm run guard:ssot-patterns` → `scripts/ssot-pattern-guard.ts`;
`npm run guard:ring-boundary-ratchet` → `scripts/ring-boundary-guard.ts`, both wired into
`verify:push:branch` with companion tests in the gate's test list):

- A finding outside the rule's allowlist **fails**, naming the primitive to rewire to.
- count **above** baseline fails (new debt, even inside allowlisted files).
- count **below** baseline fails demanding a **ratchet-down in the same commit**: lower the
  `violationCount` twin in `.claude/fitness/baseline.json` AND the matching row below, and
  drop any allowlist row whose site is gone (the guard tests fail on stale rows).
- A rule at 0 is a **pure block** (nothing left to grandfather).

This table is the doc twin of the `violationCount` entries — the guard fails when the two
disagree (`| rule | count |` rows below are machine-checked):

| rule | violations (baseline) | enforcement |
|------|-----------------------|-------------|
| `arch.ssot-lid-reads` | 6 | `scripts/ssot-pattern-guard.ts` |
| `arch.ssot-jid-construction` | 6 | `scripts/ssot-pattern-guard.ts` |
| `arch.ssot-name-ladder` | 5 | `scripts/ssot-pattern-guard.ts` |
| `arch.ssot-phone-shape` | 4 | `scripts/ssot-pattern-guard.ts` |
| `arch.ssot-presentation-literals` | 0 | `scripts/ssot-pattern-guard.ts` (pure block) |
| `arch.ring-boundaries` | 56 | `scripts/ring-boundary-guard.ts` (ratchet, not yet a pure block) |
| `portability.no-hardcoded-platform-binaries` | 3 | `scripts/platform-pattern-check.ts` |
| `portability.platform-paths-guarded` | 24 | `scripts/platform-pattern-check.ts` |
| `portability.systemctl-guarded` | 11 | `scripts/platform-pattern-check.ts` |
| `portability.gnu-bsd-shell-flags` | 7 | `scripts/platform-pattern-check.ts` |
| `portability.arch-blind-path-fallback` | 1 | `scripts/platform-pattern-check.ts` |
| `portability.hardcoded-signal-name` | 20 | `scripts/platform-pattern-check.ts` |

## ESLint Ring (live)

The `eslint` ring is enforced by `npm run guard:lint:src`
(`scripts/eslint-fitness-check.ts` + `eslint.config.fitness.mjs`), wired into
`verify:push:branch`, `verify:release`, and the CI quality workflow. The config
derives its rule set from this registry — a drift test
(`tests/scripts/eslint-fitness-check.test.ts`) asserts it enforces exactly the
rules whose `rings` include `eslint`.

| registry id | ESLint rule | notes |
|-------------|-------------|-------|
| `arch.file-size` | built-in `max-lines` (max 2000) | advisory mirror only |
| `arch.god-class` | `fitness/god-class` (maxClassLines 1200 **and** maxMethods 80) | composite — both thresholds must trip |
| `arch.approved-api-client` | `fitness/approved-api-client` | console/src/**; flags direct `fetch()` outside `console/src/lib/api.ts` |
| `arch.ring-boundaries` | `fitness/ring-boundaries` | src/**; shared→domain→adapter→runtime→composition dependency direction. Advisory mirror only since 2026-07-19 — the blocking count ratchet lives in the guard ring (`scripts/ring-boundary-guard.ts`, baseline in `.claude/fitness/baseline.json`) |
| `invariant.fail-closed-scanner` | `fitness/fail-closed-scanner` | catch returning empty without rethrow/exitCode/emit |
| `invariant.outbox-env-gated` | `fitness/outbox-direct-write` | fs write whose path literal names the bot-errors outbox/state dir without referencing the resolver |
| `invariant.timer-rearm-without-clear` | `fitness/timer-rearm-without-clear` | `map.set(key, {…setTimeout/setInterval…})` inside a function with no `clearTimeout`/`clearInterval`/`clear*()`/`.get()` guard |
| `invariant.no-unsafe-type-escapes` | `fitness/unsafe-type-escape` | src/+scripts/**; `any` and `ts-ignore`/`ts-nocheck`/`ts-expect-error` suppressions |
| `portability.fetch-timeout` | `fitness/fetch-timeout` | src/**; flags bare `fetch()` or `fetch(url, {})` without `signal` property |
| `portability.sync-exec-timeout` | `fitness/sync-exec-timeout` | src/**; flags `execSync`/`execFileSync`/`spawnSync` without `timeout` option |
| `test.skip-categorization` | `fitness/categorized-skips` | skip/`skipIf` must carry `@skip-env` or `@skip-timing` |

**Every eslint-ring rule reports at `warn` severity, so `guard:lint:src` exits 0
on warnings and fails only on configured errors or parser/config faults.** Two
reasons:

1. **Visibility without blocking.** Known violations (notably the `AgentRuntime`
   god-class and several oversized files) surface as warnings rather than breaking
   CI before they are refactored.
2. **Advisory mirror; the blocking ratchet lives beside it, not inside ESLint**
   (`meta.no-redundant-gates`). The eslint `max-lines` copy of `arch.file-size`
   stays warn-only — it is a visibility mirror, not the enforcement surface. The
   registry's `block` severity for the `guard` and `ci` rings is enforced by a
   per-file `maxLines` growth ceiling recorded in `.claude/fitness/baseline.json`
   and checked by `tests/scripts/fitness-file-size-warning-budget.test.ts`, which
   blocks `coverage:check` and `verify:release` on growth past a grandfathered
   file's recorded ceiling. See the Ratchet Baseline section above for the
   current ceilings and the extraction path for growing past one (bumps are
   blocked by `guard:baseline-growth`).

Because the ring is warn-only, the known violations are intentionally **not**
baseline-suppressed here — they stay visible in the lint output. Local runs use
`node --experimental-strip-types`; Node 24/25 (the supported engines range) is
authoritative via CI.

The ESLint ring warning count for `arch.file-size` is ratcheted by `tests/scripts/fitness-file-size-warning-budget.test.ts`.

## Non-Registry Guard: Durability-Writer Invariant (#1789)

`scripts/durability-writer-guard.ts` is **not** a `scripts/lib/fitness/registry.ts` entry — it
carries no row in the category tables above, so it does not appear under any rule id. It is
recorded here on its own so the taxonomy doesn't silently omit a fail-closed guard wired into the
push gate. Category: **invariant** (same shape as `invariant.fail-closed-gate` — a structural
completeness check, not a code-quality or process rule). Ring: **guard** only, via
`npm run guard:durability-writer`, wired into `verify:push:branch` next to the other guard
invocations; its companion test, `tests/scripts/durability-writer-guard.test.ts`, is in the
curated push-gate test list.

**Defect class it prevents:** a status-bearing durability table can be structurally incapable of
reporting bad news — the row exists, its vocabulary declares a terminal-failure value, but nothing
in production `src/` ever writes it. `auth_loss_signal` was exactly this until #1786 wired a
writer: the store, the controller, and the terminal-logout decision all existed, and none of them
were connected. No test caught it because no test asserted the surface could FAIL. This guard,
backed by the hand-curated registry `scripts/lib/durability-status-registry.ts`, makes that class
of gap impossible to reship silently.

**Checks:** (1) completeness — every table in the migrated schema snapshot classifies into exactly
one of known-status / non-status / reserved; (1b) self-provisioned discovery — a bounded static
scan for `CREATE TABLE` text under `src/**/*.ts` catches tables six `ensureXSchema`-style modules
create outside the migration registry, closing the blind spot check (1) alone would have (each such
table's DDL is also run through check (2b)'s anti-dodge regex); (2) reserved metadata — a declared
reserved exemption must carry a non-empty reason and issue, or the exemption itself fails the
guard; (2b) anti-dodge — a non-status table with a status/state/error/outcome/failed-shaped column
must carry a truthful justification, or the guard fails closed; (3) per-table writer coverage —
every status-bearing table's terminal-failure value(s) must be covered by a resolvable, non-test
`src/` writer site or a well-formed declared exception (same reason+issue rule as check (2)).

**Exit codes:** 0 pass, 1 violation, 2 inconclusive. Non-vacuity is enforced deliberately: an empty
schema snapshot, or a throw anywhere inside the scan itself, maps to exit 2 — never a silent 0 and
never an uncaught exception falling through to Node's default exit 1.

**Completeness scope, stated honestly:** the total-completeness claim covers every table
`migratedSchemaSnapshot()` returns, PLUS every table the check-1b discovery scan finds that is
registered as `SELF_PROVISIONED` (6 tables created outside the migration registry by their own
`ensureXSchema` functions) or `DISCOVERY_EXCLUSIONS` (`outbound_sends_v26`, a transient
migration-26 create→copy→rename artifact that never persists under its own name) — not "every
table" unconditionally.

**Declared exceptions (both #1789-tracked):** `sweep_runs` (`TRACKED_RESERVED` — 0-ref reserved
substrate table, no live sweep pipeline) and `beads`' `'failed'` value (`TRACKED_UNWIRED_TERMINAL`
— `update_bead` is status-protected and `transition()`'s callers only ever pass
`completed`/`cancelled`/`active`; no `fail_bead` tool exists).
