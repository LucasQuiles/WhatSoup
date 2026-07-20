# Architectural Fitness Taxonomy

This catalog is the human-readable view of the architectural fitness registry in
`scripts/lib/fitness/registry.ts`. The registry is the source of truth for rule
metadata. This document exists so reviewers can understand why each rule exists
and which enforcement surfaces can eventually project it.

The foundation stage is intentionally non-enforcing. Later stages can project
mechanical rules into repo guards and CI, AST rules into ESLint, author-time
rules into hooks, and semantic or human rules into the SDLC review flow.

## Rule Fields

- `category`: architecture, invariant, process, hygiene, test, or meta.
- `detect`: mechanical, AST, semantic, or human.
- `rings`: hook, eslint, guard, ci, or sdlc.
- `severity`: block, warn, or advisory.
- `source`: evidence that caused the rule to exist.

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

Ratcheted rules are grandfathered through `.claude/fitness/baseline.json` (measurements-based)
or `.claude/fitness/boundary-baseline.json` (import violations).
Current baseline measurements:

| rule | path | lines | ceiling |
|------|------|-------|---------|
| `arch.file-size` | `src/runtimes/agent/runtime.ts` | 12199 | 12199 |
| `arch.file-size` | `tests/runtimes/agent/runtime.test.ts` | 16579 | 16579 |

The `ceiling` column (the `maxLines` field on each measurement in `baseline.json`) is a **blocking
growth ceiling**. `tests/scripts/fitness-file-size-warning-budget.test.ts` measures each file's
actual current line count (equivalent to `wc -l`) at test time and fails if it exceeds the recorded
ceiling — this blocks `coverage:check` and `verify:release` (both run the full test suite), so growth
past a grandfathered file's ceiling is no longer silently green. Shrinking below the ceiling never
fails and never auto-lowers it; it only prints a non-blocking WARN suggesting a human lower it.

### Bumping a ceiling (two-twin ceremony)

A ceiling bump is a conscious, reviewed act, not an automatic side effect of a file growing. To bump
one:

1. Measure the file's real current line count on the branch that needs the bump (`wc -l <path>`).
2. Edit **both** twins to that same number — a bump that touches only one is incomplete:
   - `.claude/fitness/baseline.json` — update that measurement's `lines` and `maxLines`.
   - This table — update the matching row.
3. Before bumping, consider docs/architecture/fitness-taxonomy.md twin-handler slicing before bumping runtime.ts — i.e. whether the file can be split instead of grown further. This applies
   most to `src/runtimes/agent/runtime.ts`, the largest grandfathered file and the original source
   of this ratchet (see the rule's `source` evidence in the registry).

`arch.import-boundaries` grandfathered violations are tracked in `.claude/fitness/boundary-baseline.json`.
Run `npm run guard:boundaries -- --report` to see the full edge list and `npm run guard:boundaries -- --baseline-save` to ratchet down after fixing violations.

### Pattern-Count Ratchet Baseline

The SSOT pattern rules and the promoted ring rule are **count-ratcheted**: each rule's
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
| `arch.ssot-jid-construction` | 7 | `scripts/ssot-pattern-guard.ts` |
| `arch.ssot-name-ladder` | 5 | `scripts/ssot-pattern-guard.ts` |
| `arch.ssot-phone-shape` | 7 | `scripts/ssot-pattern-guard.ts` |
| `arch.ssot-presentation-literals` | 0 | `scripts/ssot-pattern-guard.ts` (pure block) |
| `arch.ring-boundaries` | 57 | `scripts/ring-boundary-guard.ts` (ratchet, not yet a pure block) |

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
   current ceilings and the two-twin bump ceremony.

Because the ring is warn-only, the known violations are intentionally **not**
baseline-suppressed here — they stay visible in the lint output. Local runs use
`node --experimental-strip-types`; Node 24/25 (the supported engines range) is
authoritative via CI.

The ESLint ring warning count for `arch.file-size` is ratcheted by `tests/scripts/fitness-file-size-warning-budget.test.ts`.
