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
| `arch.file-size` | mechanical | block | hook, eslint, guard, ci | Ratchet file line counts so known large files can shrink but not keep growing. |
| `arch.god-class` | ast | warn | eslint | Warn when a class owns too many unrelated runtime responsibilities. |
| `arch.test-colocation-churn` | mechanical | advisory | guard | Surface test files whose churn suggests an unstable production boundary. |
| `arch.defense-both-layers` | semantic | advisory | sdlc | Ensure service-layer protections are also threaded through route or caller boundaries. |

## Invariant

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `invariant.seq-locality` | mechanical | warn | guard | Keep user inbound sequence and system-result state mutation in one owner module. |
| `invariant.fail-closed-scanner` | ast | warn | eslint, sdlc | Ensure scanner parse failures raise findings instead of returning clean results. |
| `invariant.fail-closed-gate` | mechanical | block | guard, hook | Prevent shell gates from masking command failures as successful readiness checks. |

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

## Meta

| id | detect | severity | rings | purpose |
|----|--------|----------|-------|---------|
| `meta.no-redundant-gates` | human | advisory | sdlc | Route new enforcement through existing guard and review surfaces instead of adding parallel gates. |

## Ratchet Baseline

Ratcheted rules are grandfathered through `.claude/fitness/baseline.json`.
Current baseline measurements:

| rule | path | lines |
|------|------|-------|
| `arch.file-size` | `src/runtimes/agent/runtime.ts` | 6359 |
| `arch.file-size` | `tests/runtimes/agent/runtime.test.ts` | 7043 |

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
| `invariant.fail-closed-scanner` | `fitness/fail-closed-scanner` | catch returning empty without rethrow/exitCode/emit |
| `test.skip-categorization` | `fitness/categorized-skips` | skip/`skipIf` must carry `@skip-env` or `@skip-timing` |

**Every eslint-ring rule reports at `warn` severity, so `guard:lint:src` exits 0
on warnings and fails only on configured errors or parser/config faults.** Two
reasons:

1. **Visibility without blocking.** Known violations (notably the `AgentRuntime`
   god-class and several oversized files) surface as warnings rather than breaking
   CI before they are refactored.
2. **No redundant block** (`meta.no-redundant-gates`). `arch.file-size` is already
   *blocked* by the guard/ci ring against the ratchet baseline above; the eslint
   copy is an advisory mirror so blocking authority is not duplicated.

Because the ring is warn-only, the known violations are intentionally **not**
baseline-suppressed here — they stay visible in the lint output. Local runs use
`node --experimental-strip-types`; Node 24/25 (the supported engines range) is
authoritative via CI.
