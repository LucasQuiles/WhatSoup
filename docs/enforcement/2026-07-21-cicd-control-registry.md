# WhatSoup CI/CD & Quality-Control Registry — Dated Snapshot

> **Status: dated evidence index, NOT a source-of-truth.** This snapshot is a point-in-time audit
> artifact. The authoritative runtime registries remain `scripts/lib/fitness/registry.ts` (reconciled to
> `docs/architecture/fitness-taxonomy.md`) for fitness rules, and `docs/contributing/quality-guardrails-checklist.md`
> for the contributor gate narrative. This file does not enforce anything and must not be cited as a second registry.

| Field | Value |
|---|---|
| Audit | `WHATSOUP-CICD-AUDIT-2026-07-21` |
| Snapshot date (UTC) | 2026-07-21 |
| Audit source generation (pinned) | `origin/main` @ `f66ecfdb27eb04c60bf5f1f583ec1b3ad06d29f5` |
| Live `origin/main` at audit time | `cb3b90b164fb1af9ad2df52798598cffae656cd8` (1 commit ahead; sole delta `scripts/check-insecure-tempfile.ts`, guard impl body only — no control-classification impact) |
| Design lane (read-only, design-lane-only) | `design/cicd-enforcement-control-plane-20260720` @ `6cc5ae433` |
| Total canonical rows | **169** (161 active-estate + 8 design-lane-only) |
| Evidenced exclusions | 71 |
| Unclassified | **0** (computed reconciliation, independently re-verified) |
| Duplicate canonical IDs | 0 |
| Proof discipline | Static read-only audit — nothing executed. `proof_state` capped at `reachable`; `active-block` is **wiring-derived** (unconditional invocation in a fail-closed stage + reachable trigger + non-zero exit on violation), not runtime-observed. |

## Status breakdown

| Status | Count | Meaning |
|---|---|---|
| `active-block` | 106 | Wired in a fail-closed stage; blocks on violation (wiring-derived) |
| `active-warn` | 11 | Wired and runs, but non-zero exit not forced (warns) |
| `active-advisory` | 28 | Wired, advisory/report-only output |
| `shadow` | 1 | Runs but exit forced to 0 (shadow mode) |
| `on-demand` | 8 | Real control, invoked manually / not on any automatic gate |
| `orphaned` | 3 | Implementation exists but no caller reaches it |
| `dormant` | 2 | Configured but no caller and/or deps absent |
| `scheduled-external` | 2 | Runs on a host scheduler, not a repo gate |
| `design-lane-only` | 8 | Exists only in the design worktree; NOT on main |

**Completeness equation (SC-02):** candidate universe (117 package-script keys + 102 `scripts/` files + 50 config files, per source set) = classified rows ∪ evidenced exclusions, with empty intersection. Residual unclassified = **0**. Hosted source set (GitHub rulesets/policies) reconciled separately: every OBSERVED required check/policy appears once.

## Controls by ring

### ring: `hook` (11)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `design.burndown.pre-push` | Pre-push design:burndown ratchet (fail-closed, unconditional | design-system | active-block | reachable | blocking | block | pre-push-branch | yes | half-step 55, utility-smell 1, | tests/scripts/design-bur | .husky/pre-push |
| `design.metrics.pre-push` | Pre-push design:metrics gate (report-only except expired-wai | design-system | active-warn | reachable | report-only | warn | pre-push-branch | — | — | none | .husky/pre-push |
| `fitness.process.shared-checkout-safety` | process.shared-checkout-safety | process | active-advisory | declared | advisory | advisory | sdlc | — | — | none | scripts/lib/fitness/registry.ts |
| `hook.commit-msg` _(aliases: guard:repo:commit-msg)_ | Commit-message hygiene hook | hook | active-block | reachable | blocking | block | commit-msg,quality-ci | — | — | none | .husky/commit-msg |
| `hook.pre-commit` | Pre-commit hook (fail-closed orchestrator) | hook | active-block | reachable | blocking | block | pre-commit | — | — | none | .husky/pre-commit |
| `hook.pre-commit.drift-warn` | Pre-commit architectural-drift signal (warn-only) | hook | active-warn | reachable | warning | warn | pre-commit | — | — | none | .husky/pre-commit |
| `hook.pre-commit.lint-staged` | Pre-commit console lint-staged (conditional, --max-warnings  | lint | active-block | reachable | blocking | block | pre-commit | — | — | none | .husky/pre-commit |
| `hook.pre-commit.qsesh-lane` | Pre-commit qSesh Python lane (conditional) | test | active-block | reachable | blocking | block | pre-commit | — | — | none | .husky/pre-commit |
| `hook.pre-commit.theme-parity` | Pre-commit theme-parity lane (conditional) | design-system | active-block | reachable | blocking | block | pre-commit | — | — | none | .husky/pre-commit |
| `hook.pre-push` | Pre-push hook (routes to composites + design ratchets) | hook | active-block | reachable | blocking | block | pre-push-branch,release | — | — | none | .husky/pre-push |
| `identity.commit-allowlist` | Commit author/committer strict allowlist | identity | active-block | reachable | blocking | block | pre-commit | — | — | none | .husky/check-commit-identity.sh |

### ring: `eslint` (11)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `eslint.console.base-lint` _(aliases: lint)_ | Console base ESLint config | lint | active-block | reachable | blocking | block | pre-commit,pre-push-branch,release,quality-ci,tag-ci | — | — | none | console/eslint.config.js |
| `eslint.console.shadow` _(aliases: lint:shadow,lint:shadow:baseline)_ | Console shadow ESLint config + baseline | lint | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | yes | total 1 (soup/no-utility-smell | tests/scripts/shadow-bas | console/eslint.config.shadow.mjs |
| `eslint.console.soup-plugin` _(aliases: soup/icon-family,soup/no-format-bypass,soup/no-inline-dismiss-handler,soup/no-literal-status-colors,soup/protected-identifiers,soup/brand-favicon-link-required,soup/data-series-token-only,soup/focus-visible-required,soup/layer-owner-required,soup/modal-must-restore-focus,soup/motion-needs-reduced-variant,soup/no-adhoc-modal,soup/no-brand-regression,soup/no-component-local-palette,soup/no-duplicate-shell,soup/no-focus-suppression,soup/no-hover-only-content,soup/no-infinite-animation,soup/no-layout-shift-interaction,soup/no-legacy-log-lanes,soup/no-legacy-tokens,soup/no-raw-button,soup/no-raw-color,soup/no-raw-css-focus-suppression,soup/no-raw-form-control,soup/no-raw-sortable-header,soup/no-raw-table,soup/no-raw-viewport-js,soup/no-static-viewport-height,soup/no-transition-all,soup/no-unsafe-truncation,soup/no-utility-smell,soup/no-vw-font-size,soup/provider-palette-only,soup/scroll-owner-required,soup/traffic-neutrality)_ | Console soup/* design-system rule plugin (36 rules) | design-system | active-block | reachable | blocking | block | pre-commit,pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/design-lin | console/eslint-rules/index.mjs |
| `eslint.console.waiver-ledger` | Console ESLint waiver ledger | lint | active-advisory | reachable | advisory | advisory | quality-ci | — | — | tests/scripts/check-waiv | console/eslint-waivers.yaml |
| `eslint.root.fitness-config` | ESLint fitness ring config (all rules WARN) | lint | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/eslint-fit | eslint.config.fitness.mjs |
| `fitness.arch.approved-api-client` | arch.approved-api-client | architecture | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.god-class` | arch.god-class | architecture | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.invariant.fail-closed-scanner` | invariant.fail-closed-scanner | invariant | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.invariant.no-unsafe-type-escapes` | invariant.no-unsafe-type-escapes | invariant | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.invariant.outbox-env-gated` | invariant.outbox-env-gated | invariant | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.invariant.timer-rearm-without-clear` | invariant.timer-rearm-without-clear | invariant | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |

### ring: `guard` (115)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `baseline.boundary` | baseline .claude/fitness/boundary-baseline.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | 31 grandfathered cross-layer i | tests/scripts/import-bou | .claude/fitness/boundary-baseline.json |
| `baseline.design-burndown` | baseline console/design-burndown-baseline.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | categories: half-step 55, util | tests/scripts/design-bur | console/design-burndown-baseline.json |
| `baseline.design-burndown-queue` | baseline console/design-burndown-queue.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | summary total 56, blocking 0;  | tests/scripts/design-bur | console/design-burndown-queue.json |
| `baseline.design-shadow-frozen` | baseline console/design-shadow-frozen-inventory.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | tracked_rules {no-restricted-s | tests/scripts/shadow-fro | console/design-shadow-frozen-inventory.json |
| `baseline.fitness` | baseline .claude/fitness/baseline.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | file-size runtime.ts 12361/123 | tests/scripts/fitness-re | .claude/fitness/baseline.json |
| `baseline.lint-shadow` | baseline console/lint-shadow-baseline.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | total 1 (soup/no-utility-smell | tests/scripts/shadow-bas | console/lint-shadow-baseline.json |
| `baseline.service-units` | baseline scripts/service-units-baseline.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | grandfathered: [] (EMPTY — no  | tests/scripts/check-serv | scripts/service-units-baseline.json |
| `baseline.test-integrity` | baseline .claude/test-integrity/baseline.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | captured_at 2026-07-19 (sha 4b | none | .claude/test-integrity/baseline.json |
| `baseline.transport-patterns` | baseline .claude/fitness/transport-patterns-baseline.json | guard | active-block | reachable | blocking | block | pre-push-branch | yes | grandfathered violations for h | tests/scripts/transport- | .claude/fitness/transport-patterns-baseline.json |
| `build.console` _(aliases: build)_ | Console production build gate | other | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | none | console/package.json |
| `composite.verify-console-browser` _(aliases: verify:console-browser)_ | verify:console-browser composite | test | active-block | reachable | blocking | block | release,quality-ci | — | — | none | package.json#verify:console-browser |
| `composite.verify-console-design` _(aliases: verify:console-design)_ | verify:console-design composite (14 design gates + design-gu | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | none | package.json#verify:console-design |
| `composite.verify-push-branch` _(aliases: verify:push:branch)_ | verify:push:branch composite (branch pre-push gate) | meta | active-block | reachable | blocking | block | pre-push-branch | — | — | none | package.json#verify:push:branch |
| `composite.verify-semantic` _(aliases: verify:semantic)_ | verify:semantic (enforce-mode alias) — UNWIRED | semantic | on-demand | declared | none | not-applicable | manual | — | — | none | package.json |
| `coverage.console-perdir` | Console per-directory coverage ratchet | coverage | active-block | reachable | blocking | block | release,quality-ci | — | hooks 97/93, lib 84/88, primit | tests/scripts/check-cove | console/scripts/check-coverage-thresholds.mjs |
| `coverage.guard-test-coverage` _(aliases: guard:guard-test-coverage)_ | Guard-test-coverage meta-guard | test | active-block | reachable | blocking | block | pre-push-branch,release | — | — | tests/scripts/guard-test | scripts/guard-test-coverage-check.ts |
| `coverage.headroom` _(aliases: guard:coverage-headroom)_ | Coverage headroom guard (warn) | coverage | active-warn | reachable | warning | warn | quality-ci | — | — | tests/scripts/check-cove | scripts/check-coverage-headroom.ts |
| `coverage.root` _(aliases: coverage:check)_ | Root coverage gate (coverage:check) | coverage | active-block | reachable | blocking | block | release,quality-ci | — | root: lines95/branches90/funct | none | scripts/run-coverage-check.sh |
| `design-lane.architecture.fitness-lint` | [design-lane] architecture.fitness-lint | meta | design-lane-only | declared | blocking | block | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design-lane.ci.exact-revision-classifier` | [design-lane] ci.exact-revision-classifier | meta | design-lane-only | declared | blocking | block | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design-lane.ci.hooks.installed` | [design-lane] ci.hooks.installed | meta | design-lane-only | declared | advisory | advisory | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design-lane.ci.outgoing-ref-policy` | [design-lane] ci.outgoing-ref-policy | meta | design-lane-only | declared | advisory | advisory | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design-lane.privacy.publication` | [design-lane] privacy.publication | meta | design-lane-only | declared | blocking | block | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design-lane.repo.hygiene` | [design-lane] repo.hygiene | meta | design-lane-only | declared | blocking | block | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design-lane.test.integrity` | [design-lane] test.integrity | meta | design-lane-only | declared | blocking | block | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design-lane.workflow.safeguard-diagnostics` | [design-lane] workflow.safeguard-diagnostics | meta | design-lane-only | declared | blocking | block | sdlc | — | — | none | controls/ci-control-manifest.json |
| `design.brand-assets` _(aliases: design:brand-assets)_ | console design:brand-assets | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/brand-asse | console/scripts/check-brand-assets.mjs |
| `design.burndown.gate` _(aliases: design:burndown)_ | console design:burndown (in verify:console-design) | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | yes | half-step 55, utility-smell 1 | tests/scripts/design-bur | console/scripts/check-design-burndown.mjs |
| `design.color-semantics` _(aliases: design:color-semantics)_ | console design:color-semantics | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/color-sema | console/scripts/check-color-semantics.mjs |
| `design.contrast` _(aliases: design:contrast)_ | console design:contrast | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/contrast-m | console/scripts/check-contrast-matrix.mjs |
| `design.font-assets` _(aliases: design:font-assets)_ | console design:font-assets | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/font-asset | console/scripts/check-font-assets.mjs |
| `design.lint-fixtures` _(aliases: design:lint-fixtures)_ | console design:lint-fixtures | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/design-lin | console/scripts/check-design-lint-fixtures.mjs |
| `design.metrics.gate` _(aliases: design:metrics)_ | console design:metrics (in verify:console-design) | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/design-met | console/scripts/design-metrics.mjs |
| `design.raw-form-control-inventory` _(aliases: design:raw-form-control-inventory)_ | console design:raw-form-control-inventory | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/raw-form-c | console/scripts/check-raw-form-control-inventory.mjs |
| `design.regression` _(aliases: design:regression)_ | console design:regression | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/design-reg | console/scripts/design-regression.sh |
| `design.resilience` _(aliases: design:resilience)_ | console design:resilience | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/design-res | console/scripts/check-design-resilience.mjs |
| `design.shadow-frozen-inventory` _(aliases: design:shadow-frozen-inventory)_ | console design:shadow-frozen-inventory | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/shadow-fro | console/scripts/check-shadow-frozen-inventory.mjs |
| `design.theme-parity` _(aliases: design:theme-parity)_ | console design:theme-parity | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/theme-pari | console/scripts/check-theme-parity.mjs |
| `design.token-drift` _(aliases: design:token-drift)_ | console design:token-drift | design-system | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/token-spec | console/scripts/check-token-spec-drift.mjs |
| `eslint.console.waiver-sync` | Console waiver sync checker | lint | active-advisory | reachable | warning | warn | quality-ci | — | — | tests/scripts/check-waiv | console/scripts/check-waiver-sync.mjs |
| `eslint.root.fitness-runner` _(aliases: guard:lint:src)_ | guard:lint:src ESLint fitness runner | lint | active-warn | reachable | warning | warn | pre-push-branch,release,quality-ci,tag-ci | — | — | tests/scripts/eslint-fit | scripts/eslint-fitness-check.ts |
| `fitness.arch.file-size` | arch.file-size | architecture | active-block | reachable | blocking | block | release,quality-ci | yes | runtime.ts 12361/12361, runtim | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.import-boundaries` | arch.import-boundaries | architecture | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | yes | 31 grandfathered cross-layer e | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.ring-boundaries` | arch.ring-boundaries | architecture | active-block | reachable | blocking | block | pre-push-branch | yes | ring-boundaries violationCount | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.ssot-jid-construction` | arch.ssot-jid-construction | architecture | active-block | reachable | blocking | block | pre-push-branch | yes | violationCount 7 | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.ssot-lid-reads` | arch.ssot-lid-reads | architecture | active-block | reachable | blocking | block | pre-push-branch | yes | violationCount 6 | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.ssot-name-ladder` | arch.ssot-name-ladder | architecture | active-block | reachable | blocking | block | pre-push-branch | yes | violationCount 5 | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.ssot-phone-shape` | arch.ssot-phone-shape | architecture | active-block | reachable | blocking | block | pre-push-branch | yes | violationCount 9 | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.ssot-presentation-literals` | arch.ssot-presentation-literals | architecture | active-block | reachable | blocking | block | pre-push-branch | yes | violationCount 0 (pure block) | none | scripts/lib/fitness/registry.ts |
| `fitness.arch.test-colocation-churn` | arch.test-colocation-churn | architecture | active-advisory | declared | advisory | advisory | manual | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.hygiene.commit-author` | hygiene.commit-author | hygiene | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.hygiene.internal-labels` | hygiene.internal-labels | hygiene | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.hygiene.no-health-whatsapp-key-read` | hygiene.no-health-whatsapp-key-read | hygiene | active-block | reachable | blocking | block | pre-push-branch | yes | 3 grandfathered health?.whatsa | none | scripts/lib/fitness/registry.ts |
| `fitness.hygiene.no-wa-jid-literal-in-generic-ui` | hygiene.no-wa-jid-literal-in-generic-ui | hygiene | active-block | reachable | blocking | block | pre-push-branch | yes | grandfathered @s.whatsapp.net/ | none | scripts/lib/fitness/registry.ts |
| `fitness.hygiene.no-whatsapp-copy-in-generic-ui` | hygiene.no-whatsapp-copy-in-generic-ui | hygiene | active-block | reachable | blocking | block | pre-push-branch | yes | grandfathered WhatsApp-copy si | none | scripts/lib/fitness/registry.ts |
| `fitness.invariant.fail-closed-gate` | invariant.fail-closed-gate | invariant | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.invariant.seq-locality` | invariant.seq-locality | invariant | active-advisory | declared | advisory | warn | manual | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.process.deploy-sha-drift` | process.deploy-sha-drift | process | active-advisory | declared | advisory | advisory | manual | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.process.evidence-sha-anchor` | process.evidence-sha-anchor | process | active-advisory | declared | advisory | warn | manual | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.process.no-destructive-git` | process.no-destructive-git | process | active-advisory | declared | advisory | block | manual | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.test.insecure-tempfile` | test.insecure-tempfile | test | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.test.typecheck-all-required` | test.typecheck-all-required | test | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | scripts/lib/fitness/registry.ts |
| `guard.agent-decision-polls` _(aliases: guard:agent-decision-polls)_ | AskUser poll protocol guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/agent-deci | scripts/agent-decision-polls-guard.ts |
| `guard.agent-iteration-review` | Agent iteration review guard | guard | on-demand | declared | none | not-applicable | manual | — | — | tests/scripts/agent-iter | scripts/agent-iteration-review-check.ts |
| `guard.arc-binding-drift` _(aliases: guard:arc-binding-drift)_ | ARC binding drift guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/arc-bindin | scripts/arc-binding-drift-check.ts |
| `guard.bot-errors-critical-surface` _(aliases: guard:bot-errors-critical-surface)_ | BOT ERRORS critical surface guard | guard | active-block | reachable | blocking | block | pre-push-branch,quality-ci | — | — | tests/scripts/bot-errors | scripts/bot-errors-critical-surface-audit.ts |
| `guard.bot-errors-runtime-manifest` _(aliases: guard:bot-errors-runtime-manifest)_ | BOT ERRORS runtime manifest guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/check-bot- | scripts/check-bot-errors-runtime-manifest.ts |
| `guard.bot-errors-simulation-matrix` _(aliases: guard:bot-errors-simulation-matrix)_ | BOT ERRORS simulation matrix guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/bot-errors | scripts/bot-errors-simulation-matrix.ts |
| `guard.boundaries` _(aliases: guard:boundaries,guard:ring-boundaries)_ | Import boundary guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | yes | 31 grandfathered cross-layer e | tests/scripts/import-bou | scripts/import-boundary-check.ts |
| `guard.check-launchd-drift` | launchd drift check (ORPHANED/on-demand) | guard | orphaned | declared | none | not-applicable | manual | — | — | tests/scripts/launchd-dr | scripts/check-launchd-drift.sh |
| `guard.claude-settings` _(aliases: guard:claude-settings)_ | Claude settings drift guard | guard | active-block | reachable | blocking | block | pre-commit,pre-push-branch,release,quality-ci | — | — | tests/scripts/claude-set | scripts/claude-settings-guard.ts |
| `guard.deployer-static` _(aliases: guard:deployer-static)_ | Deployer static guard | guard | active-block | reachable | blocking | block | pre-push-branch | — | — | tests/scripts/deployer-s | deploy/scripts/whatsoup-bot-errors-deploy.sh |
| `guard.design-system-hygiene` _(aliases: guard:design-system-hygiene)_ | Design-system hygiene guard | guard | active-block | reachable | blocking | block | pre-commit,pre-push-branch,release,quality-ci | — | — | tests/scripts/design-sys | scripts/design-system-hygiene-guard.ts |
| `guard.doc-drift` _(aliases: guard:doc-drift)_ | Documentation drift guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/doc-drift- | scripts/doc-drift-check.ts |
| `guard.doc-tally` _(aliases: guard:doc-tally)_ | Guard-doc tally guard | guard | active-block | reachable | blocking | block | pre-push-branch,release | — | — | tests/scripts/guard-doc- | scripts/guard-doc-tally.ts |
| `guard.fail-closed-gate` _(aliases: guard:fail-closed-gate)_ | Fail-closed gate guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/fail-close | scripts/fail-closed-gate-guard.ts |
| `guard.fleet-bot-hardening-parity` _(aliases: guard:fleet-bot-hardening-parity)_ | Fleet bot-hardening parity guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/check-flee | scripts/check-fleet-bot-hardening-parity.ts |
| `guard.grant-resolver-inventory` | Grant-resolver inventory guard (ORPHANED) | guard | orphaned | declared | none | not-applicable | manual | — | — | tests/scripts/grant-reso | scripts/grant-resolver-inventory-guard.ts |
| `guard.harness-maintenance` _(aliases: guard:harness-maintenance)_ | Harness maintenance manifest guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/harness-ma | scripts/harness-maintenance-guard.ts |
| `guard.insecure-tempfile` _(aliases: guard:insecure-tempfile)_ | Insecure tempfile guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/check-inse | scripts/check-insecure-tempfile.ts |
| `guard.instance-config` _(aliases: guard:instance-config)_ | Instance config integrity guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/check-inst | scripts/check-instance-config.ts |
| `guard.node-pin-consistency` _(aliases: guard:node-pin-consistency)_ | Node pin consistency guard | guard | active-block | reachable | blocking | block | pre-commit,pre-push-branch,release,quality-ci | — | — | tests/scripts/node-pin-c | scripts/check-node-pin-consistency.ts |
| `guard.public-surface-drift` _(aliases: guard:public-surface-drift)_ | Public surface drift guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/public-sur | scripts/public-surface-drift-check.ts |
| `guard.publication` _(aliases: guard:publication,guard:publication:all,guard:publication:release,guard:publication:staged)_ | Privacy/publication guard | guard | active-block | reachable | blocking | block | pre-commit,pre-push-branch,release,quality-ci | — | — | tests/scripts/publicatio | scripts/publication-guard.ts |
| `guard.repo` _(aliases: guard:repo,guard:repo:staged,guard:repo:branch-diff,guard:repo:commit-authors,guard:repo:commit-msg,guard:repo:release-hygiene,guard:repo:scan-history)_ | Repository hygiene guard | guard | active-block | reachable | blocking | block | pre-commit,pre-push-branch,release,quality-ci | — | — | tests/scripts/repo-hygie | scripts/repo-hygiene-guard.ts |
| `guard.required-suites` | Required-suites checker (ORPHANED/on-demand) | guard | orphaned | declared | none | not-applicable | manual | — | — | tests/scripts/required-s | scripts/required-suites.ts |
| `guard.restart-preflight` | Restart preflight gate | guard | on-demand | declared | advisory | advisory | manual | — | — | tests/deploy/preflight-c | deploy/preflight-check.sh |
| `guard.ring-boundary-ratchet` _(aliases: guard:ring-boundary-ratchet)_ | Ring boundary ratchet guard | guard | active-block | reachable | blocking | block | pre-push-branch | yes | ring-boundaries violationCount | tests/scripts/ring-bound | scripts/ring-boundary-guard.ts |
| `guard.safeguard-diagnostics` _(aliases: guard:safeguard-diagnostics)_ | Safeguard diagnostics guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/safeguard- | scripts/safeguard-diagnostics.ts |
| `guard.service-units` _(aliases: guard:service-units)_ | Service unit validity guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | yes | grandfathered: [] (EMPTY) | tests/scripts/check-serv | scripts/check-service-units.ts |
| `guard.source-runtime-drift` _(aliases: guard:source-runtime-drift)_ | Source runtime drift guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | scripts/source-runtime-drift-check.ts |
| `guard.ssot-patterns` _(aliases: guard:ssot-patterns)_ | SSOT pattern guard | guard | active-block | reachable | blocking | block | pre-push-branch | yes | ssot-lid-reads 6, ssot-jid-con | tests/scripts/ssot-patte | scripts/ssot-pattern-guard.ts |
| `guard.transport-patterns` _(aliases: guard:transport-patterns)_ | Transport pattern guard | guard | active-block | reachable | blocking | block | pre-push-branch | yes | grandfathered transport-patter | tests/scripts/transport- | scripts/transport-pattern-check.ts |
| `guard.unit-drift` | Unit drift guard (systemd/launchd) | guard | on-demand | declared | none | not-applicable | manual | — | — | tests/scripts/unit-drift | scripts/check-unit-drift.sh |
| `guard.work-index` _(aliases: guard:work-index)_ | Work index coverage guard | guard | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | tests/scripts/work-index | scripts/work-index.ts |
| `guard.worker-artifacts` | Worker artifacts validation guard | guard | on-demand | declared | none | not-applicable | manual | — | — | tests/scripts/validate-w | scripts/validate-worker-artifacts.ts |
| `semantic.shadow` _(aliases: guard:semantic-quality,verify:semantic:shadow)_ | Semantic-quality gate (SHADOW — the wired mode) | semantic | shadow | reachable | shadow | advisory | pre-push-branch,release,quality-ci | — | — | tests/scripts/semantic-q | scripts/semantic-quality-check.ts |
| `testlane.bot-errors-health-hermeticity` _(aliases: test:bot-errors-health:hermeticity)_ | BOT ERRORS macOS health hermeticity | test | active-block | reachable | blocking | block | quality-ci | — | — | none | tests/scripts/bot-errors-health-check.test.ts |
| `testlane.design-guards` _(aliases: test:design-guards)_ | Design-guard test bundle | test | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | none | (vitest design-guard tests) |
| `testlane.drills` _(aliases: test:drills)_ | Failure-scenario drills | test | active-block | reachable | blocking | block | release,quality-ci | — | — | none | tests/drills/bot-errors-failure-drills.sh |
| `testlane.qsesh` _(aliases: test:qsesh,lint:qsesh)_ | qSesh Python lint+test lane | test | active-block | reachable | blocking | block | pre-commit,quality-ci | — | — | none | scripts/run-qsesh-pytests.sh |
| `testlane.test-integrity` _(aliases: guard:test-integrity,guard:test-integrity:required)_ | Test-integrity baseline gate | test | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | captured_at 2026-07-19 sha 4b9 | none | scripts/test-integrity-ci.sh |
| `testlane.tokenomics` _(aliases: test:tokenomics)_ | Tokenomics Python test lane | test | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | scripts/run-tokenomics-pytests.sh |
| `testlane.vitest-suite` _(aliases: test)_ | Root Vitest test suite (npm test) | test | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci | — | — | none | package.json |
| `tsconfig.console-app` | tsconfig console/tsconfig.app.json | typecheck | active-advisory | configured | none | not-applicable | quality-ci | — | — | none | console/tsconfig.app.json |
| `tsconfig.console-node` | tsconfig console/tsconfig.node.json | typecheck | active-advisory | configured | none | not-applicable | quality-ci | — | — | none | console/tsconfig.node.json |
| `tsconfig.console-solution` | tsconfig console/tsconfig.json | typecheck | active-advisory | configured | none | not-applicable | quality-ci | — | — | none | console/tsconfig.json |
| `tsconfig.guard` | tsconfig tools/whatsoup_guard/tsconfig.json | typecheck | active-advisory | configured | none | not-applicable | quality-ci | — | — | none | tools/whatsoup_guard/tsconfig.json |
| `tsconfig.root` | tsconfig tsconfig.json | typecheck | active-advisory | configured | none | not-applicable | quality-ci | — | — | none | tsconfig.json |
| `tsconfig.scripts` | tsconfig tsconfig.scripts.json | typecheck | active-advisory | configured | none | not-applicable | quality-ci | — | — | none | tsconfig.scripts.json |
| `tsconfig.test` | tsconfig tsconfig.test.json | typecheck | active-advisory | configured | none | not-applicable | quality-ci | — | — | none | tsconfig.test.json |
| `typecheck.all` _(aliases: typecheck:all)_ | typecheck:all (src+tests+console/src+scripts) | typecheck | active-block | reachable | blocking | block | pre-push-branch,release,quality-ci,tag-ci | — | — | none | package.json#typecheck:all |
| `vitest.browser` _(aliases: test:browser)_ | Vitest browser config | test | active-block | reachable | blocking | block | release,quality-ci,tag-ci | — | — | none | vitest.browser.config.ts |
| `vitest.browser-motion` _(aliases: test:browser:motion)_ | Vitest browser-motion config | test | active-block | reachable | blocking | block | release,quality-ci,tag-ci | — | — | none | vitest.browser.motion.config.ts |
| `vitest.node` | Vitest node/jsdom config + root coverage thresholds | coverage | active-block | reachable | blocking | block | release,quality-ci | — | lines 95, branches 90, functio | none | vitest.config.ts |

### ring: `ci` (12)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `bp.codeql-default-setup` _(aliases: CodeQL)_ | CodeQL code scanning (GitHub default setup, hosted) | static-analysis | active-block | configured | blocking | block | quality-ci,scheduled | — | — | none | hosted/receipts/codeql_default_setup.json |
| `fitness.process.fix-cluster` | process.fix-cluster | process | active-advisory | declared | advisory | advisory | manual | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.test.skip-categorization` | test.skip-categorization | test | active-advisory | declared | advisory | advisory | manual | — | — | none | scripts/lib/fitness/registry.ts |
| `mutation.run-sentinel` | BOT ERRORS sentinel + deployer mutation gate | mutation | active-block | reachable | blocking | block | quality-ci | — | 4x --cov-fail-under=98 (Python | none | deploy/scripts/run-sentinel-tests.sh |
| `typecheck.scripts` _(aliases: typecheck:scripts)_ | typecheck:scripts (scripts/ tooling) — CI-ONLY | typecheck | active-block | reachable | blocking | block | quality-ci | — | — | none | package.json#typecheck:scripts |
| `typecheck.src` _(aliases: typecheck)_ | typecheck (src only) | typecheck | active-block | reachable | blocking | block | quality-ci,tag-ci | — | — | none | package.json#typecheck |
| `vitest.guard` | Vitest config for tools/whatsoup_guard | test | active-block | reachable | blocking | block | path-ci,release | — | — | none | tools/whatsoup_guard/vitest.config.ts |
| `wf.quality.job-bot-errors-health-macos` | Quality workflow — bot-errors macOS health job | test | active-block | reachable | blocking | block | quality-ci | — | — | none | .github/workflows/quality.yml#bot-errors-health-macos |
| `wf.quality.job-quality` | Quality workflow — quality job (matrix 24.x/25.x) | workflow | active-block | reachable | blocking | block | quality-ci | — | — | none | .github/workflows/quality.yml#quality |
| `wf.quality.secret-leak-scan` | Quality — secret-leak history scan (advisory) | hygiene | active-advisory | reachable | advisory | advisory | quality-ci | — | — | none | .github/workflows/quality.yml#secret-leak-scan |
| `wf.tag-release-gate` | Tag release gate workflow (v* tags) | workflow | active-block | reachable | blocking | block | tag-ci | — | — | none | .github/workflows/tag-release-gate.yml |
| `wf.whatsoup-guard` | whatsoup-guard workflow (path-scoped) | workflow | active-block | reachable | blocking | block | path-ci | — | — | none | .github/workflows/whatsoup-guard.yml |

### ring: `branch-protection` (2)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `bp.classic-protection` | GitHub classic branch protection on main (hosted) | branch-protection | active-block | configured | blocking | block | quality-ci | — | — | none | hosted/receipts/classic_protection_main.json |
| `bp.ruleset-lock` | GitHub branch-protection ruleset 'Lock' (hosted) | branch-protection | active-block | configured | blocking | block | quality-ci | — | — | none | hosted/receipts/ruleset_16319133.json |

### ring: `release` (1)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `composite.verify-release` _(aliases: verify:release)_ | verify:release composite (release/main pre-push + tag-ci bas | meta | active-block | reachable | blocking | block | release | — | — | none | package.json#verify:release |

### ring: `publish` (1)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `composite.verify-publish` _(aliases: verify:publish)_ | verify:publish composite (final publish gate) | publication | on-demand | reachable | blocking | block | publish | — | — | none | package.json#verify:publish |

### ring: `sdlc` (11)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `checklist.layer1-ci-gates` | [checklist] Layer 1 CI gates table | process | active-advisory | declared | report-only | advisory | manual | — | — | none | docs/contributing/quality-guardrails-checklist.md |
| `checklist.layer2-pre-push` | [checklist] Layer 2 pre-push (verify:push:branch / verify:re | process | active-advisory | declared | report-only | advisory | manual | — | — | none | docs/contributing/quality-guardrails-checklist.md |
| `checklist.layer3-hygiene-internals` | [checklist] Layer 3 hygiene-guard internal rules | process | active-advisory | declared | report-only | advisory | manual | — | — | none | docs/contributing/quality-guardrails-checklist.md |
| `checklist.layer4-test-author-rules` | [checklist] Layer 4 test-author quality rules (4a-4m) | process | dormant | declared | report-only | advisory | manual | — | — | none | docs/contributing/quality-guardrails-checklist.md |
| `checklist.release-runbook` | [checklist] Release Runbook | process | active-advisory | declared | report-only | advisory | manual | — | — | none | docs/contributing/quality-guardrails-checklist.md |
| `fitness.arch.defense-both-layers` | arch.defense-both-layers | architecture | active-advisory | declared | advisory | advisory | sdlc | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.hygiene.pr-scope-coherence` | hygiene.pr-scope-coherence | hygiene | active-advisory | declared | advisory | advisory | sdlc | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.meta.no-redundant-gates` | meta.no-redundant-gates | meta | active-advisory | declared | advisory | advisory | sdlc | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.process.canary-before-fleet` | process.canary-before-fleet | process | active-advisory | declared | advisory | advisory | sdlc | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.process.verify-before-claim` | process.verify-before-claim | process | active-advisory | declared | advisory | advisory | sdlc | — | — | none | scripts/lib/fitness/registry.ts |
| `fitness.test.red-green-required` | test.red-green-required | test | active-advisory | declared | advisory | advisory | sdlc | — | — | none | scripts/lib/fitness/registry.ts |

### ring: `scheduled` (2)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `sched.bot-errors-launchd-family` | BOT ERRORS launchd service family (scheduled-external) | process | scheduled-external | configured | report-only | advisory | scheduled | — | — | none | deploy/scripts/install-bot-errors-*-launchd.sh |
| `sched.live-release-drift-alert` | Live release drift alert (scheduled-external) | process | scheduled-external | configured | report-only | advisory | scheduled | — | — | tests/scripts/release-dr | scripts/live-release-drift-alert.ts |

### ring: `none` (3)

| control_id | title | category | status | proof | enforce | sev | stages | ratchet | baseline | verifier | evidence anchor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `design.capture` | console design:capture (visual matrix capture) | design-system | on-demand | declared | none | not-applicable | manual | — | — | none | console/scripts/capture-visual-matrix.mjs |
| `design.capture-validate` | console design:capture:validate | design-system | on-demand | declared | none | not-applicable | manual | — | — | tests/scripts/visual-man | console/scripts/validate-visual-manifest.mjs |
| `mutation.stryker` | Stryker mutation config (DORMANT) | mutation | dormant | configured | none | not-applicable | manual | — | high 90, low 75, break 65 (not | none | stryker.conf.json |

## Evidenced exclusions (71)

Candidates deliberately excluded from the control registry, each with an invariant + rationale + verifier.

| exclusion group | count | rationale |
|---|---|---|
| not-a-cicd-quality-control | 30 | Operational/app or alias/duplicate script, not an independent CI/CD or quality g |
| operational-not-cicd-gate | 15 | Operational/diagnostic script (leaks:anonymize, arc:runtime-proof, audit:instanc |
| folded-into-parent-row | 10 | ESLint rule implementation file. The 8 root fitness/* rules are folded into thei |
| library-not-control | 6 | Redaction utility imported by on-demand tools (arc-runtime-proof, disposable-cli |
| on-demand-operational-not-gate | 5 | On-demand/manual operational script (migration/rollback/boundary-run CLI); exhau |
| infrastructure-helper-not-gate | 4 | Infrastructure helper: print-push-gate-scope.sh (report-only summary at end of v |
| runtime-monitoring-not-cicd-gate | 1 | The BOT ERRORS runtime monitoring/alerting daemons (collector, dispatcher, healt |

_Full per-candidate exclusion records with verifiers are retained in the audit evidence root (`exclusions.jsonl`)._

## Cross-references
- Findings, method, evidence-anchor table, and owner-gated recommendations: `docs/enforcement/2026-07-21-cicd-quality-controls-audit.md`.
- Contributor gate narrative (refresh proposed): `docs/contributing/quality-guardrails-checklist.md` (refresh shipped as merged PR #2021).

