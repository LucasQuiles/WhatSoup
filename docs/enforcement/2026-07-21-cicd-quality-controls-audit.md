# WhatSoup CI/CD & Quality-Controls Audit

**Audit ID:** `WHATSOUP-CICD-AUDIT-2026-07-21` · **Date (UTC):** 2026-07-21 · **Class:** read-only documentation audit (no control executed, no source/hosted state mutated)

This audit inventories and classifies WhatSoup's CI/CD and quality-control estate against a pinned source generation, distinguishing *declared* from *configured*, *reachable*, and *blocking* controls. It executes no CI, browser, mutation, or deploy suite; where a claim requires runtime execution it is capped at the strongest state actually observed. Companion deliverables: the dated control registry (`docs/enforcement/2026-07-21-cicd-control-registry.md`) (the checklist refresh itself shipped as merged PR #2021).

## 1. Evidence anchor (SC-01)

| Datum | Value | Source identity |
|---|---|---|
| Repository root | `<repo-root>` | `git rev-parse --show-toplevel` |
| Object format | `sha1` | `git rev-parse --show-object-format` |
| Audit source generation (pinned) | `origin/main` @ `f66ecfdb27eb04c60bf5f1f583ec1b3ad06d29f5` | `git ls-remote origin refs/heads/main` at admission; local/remote parity verified |
| Live `origin/main` at audit close | `cb3b90b164fb1af9ad2df52798598cffae656cd8` | Drifted +1 commit during the run; independent diff shows the **only** changed file is `scripts/check-insecure-tempfile.ts` (guard implementation body). No workflow/hook/package/fitness/wiring change → zero control-classification impact. Audit remains coherently pinned at `f66ecfdb2`. |
| Checkout at admission | `feat/model-selection-ux-20260720` @ `a7732b80f3c40f216fae27e14ac6e2f8cff6068a` | All source claims read from the pinned `main` blob via `git show f66ecfdb2:<path>`, never the feature worktree. |
| Design lane (read-only) | `design/cicd-enforcement-control-plane-20260720` @ `6cc5ae433` | `git worktree list`; controls labeled `design-lane-only`, excluded from active totals. |
| GitHub repo | `LucasQuiles/WhatSoup`, default branch `main` | `gh` 2.89.0 authenticated (account `LucasQuiles`, `repo` scope); read-only, no secret value read. |
| Plan | `WHATSOUP-CICD-AUDIT-2026-07-21` v`0.3.0 (reviewed)` | source-plan sha256 `5d3ece4e…` |

**Hosted-state honesty (SC-08):** every GitHub read is an OBSERVED, timestamped receipt retained under the audit evidence root; there were **8 OBSERVED hosted claims, 0 UNKNOWN, no secret value read**. Historical exploration facts (plan §3, dated 2026-06-28…07-20) were treated as advisory and re-verified from live source/API before any promotion; several were found stale and are corrected below.

## 2. Method & topology

Discovery, classification, rendering, and verification were kept separate (SoC). A T1 lead (this session; observed runtime **UNVERIFIED** — the platform exposed conflicting `claude-opus-4-8[1m]` and `claude-fable-5` signals, recorded rather than guessed) directed two T2 Opus orchestrators (hosted-state, control-inventory) and one independent-lineage T2 verifier. **Capability finding:** the harness rejects sub-delegation ("delegated workers are leaf roles"), so the requested Opus→Sonnet→Haiku *nested* team was not instantiable; orchestrators ran collapsed-to-self and the lead mediated all tiers directly. This is reported as the hierarchy actually run, not the one requested.

Anti-bias safeguards were applied and exercised, not merely asserted: the lead replayed every decisive worker claim from raw evidence before accepting it (no self-sign-off); the independent verifier re-derived the candidate universe from source *before* seeing the producer's rows (anti-anchoring); negative statuses required complete bounded caller searches, not spot checks.

## 3. Inventory summary (SC-02 / SC-03)

**169 canonical controls** (161 active-estate + 8 design-lane-only), **71 evidenced exclusions**, **unclassified = 0**, **duplicate IDs = 0** — independently reconciled by a separate verification lineage (missing = extra = duplicate = 0; all 7 negative/gap findings independently confirmed, 0 refuted). Proof state is capped at `reachable`; `active-block` is wiring-derived (unconditional invocation in a fail-closed stage + reachable trigger + non-zero exit on violation).

| Status | Count |
|---|---|
| active-block | 106 |
| active-warn | 11 |
| active-advisory | 28 |
| on-demand | 8 |
| orphaned | 3 |
| scheduled-external | 2 |
| dormant | 2 |
| shadow | 1 |
| design-lane-only | 8 |

**Enforcement architecture (as verified):**
- **Hooks** (`core.hooksPath=.husky`, replacing machine-global hooks): `pre-commit` (fail-closed identity + staged guards, warn-only drift signal), `commit-msg` (hygiene incl. model-attribution + `Co-Authored-By` block), `pre-push` (`pre-push-guard.ts` routes branch→`verify:push:branch`, main/tags→`verify:release`). The machine-global secret-scanner pre-commit does **not** run on WhatSoup commits; the global attribution ban is bypassed but **replicated (broader)** by `guard:repo:commit-msg`.
- **ESLint fitness ring is WARN-ONLY** — `guard:lint:src` exits 0 on rule warnings and fails closed only on eslint errors/config faults. Blocking authority lives in the **guard ring** (`verify:push:branch`, ~50 guards) and **CI** (`quality.yml`), consistent with the `meta.no-redundant-gates` principle.
- **CI**: exactly three workflows — `quality.yml` (PR + push-to-main; the full gate), `tag-release-gate.yml` (v* tags, guard subset), `whatsoup-guard.yml` (path-filtered to `tools/whatsoup_guard/**`). No CODEOWNERS, no dependabot, no composite actions, no `merge_group`.
- **Fitness registry** = **36 rules** (see F-1), reconciled to the taxonomy with symmetric difference 0.

## 4. Findings register

Each finding is labeled by evidence class and cites its anchored source. "OBSERVED" = directly read from the pinned blob or a live gh receipt; "INFERRED" = reasoned from observed facts (semantics not executed); "UNKNOWN" = not verifiable within scope.

### 4.1 Corrections to stale planning facts

- **F-1 — Fitness registry is 36 rules, not 33.** [OBSERVED] `scripts/lib/fitness/registry.ts` @ f66ecfdb2 defines 36 rule ids (independently re-counted by the lead and by the independent verifier); the pinning test `tests/scripts/fitness-registry.test.ts` asserts `toHaveLength(36)`; registry↔taxonomy symmetric diff = 0. The §3 "33" figure was stale.
- **F-2 — Ratchet baseline figures moved.** [OBSERVED] `.claude/fitness/baseline.json`: `runtime.ts` ceiling **12361** (§3 said 12984), `runtime.test.ts` **16579** (§3 said 17597), `ssot-phone-shape` **9** (§3 said 7), ring-boundaries 57, boundary-baseline 31 edges. Figures were recomputed from the pinned files at audit time.

### 4.2 Hosted enforcement (branch protection) — OBSERVED live

- **F-3 — Branch protection is two overlapping surfaces.** [OBSERVED] The default branch is gated by both a modern **ruleset "Lock"** (id 16319133, enforcement active, `bypass_actors=[]`) and **classic branch protection**. Direct push is blocked (PR required); force-push and deletion are blocked on both. The ruleset requires **only** `quality (24.x)` + `quality (25.x)` (strict=false) and binds admins; classic protection additionally requires **CodeQL** (strict=true) but has `enforce_admins=false`.
- **F-4 — "CodeQL required" is precise-with-caveats, not absolute.** [OBSERVED] CodeQL is GitHub **default code-scanning setup** (state=configured; languages actions/javascript/javascript-typescript/python/typescript; weekly + PR), with **no in-repo workflow file** — the "required check invisible to an in-repo-only audit." It is required **only via classic protection**, which is **admin-bypassable** (`enforce_admins=false`). So: required for a normal contributor; an admin can merge without it. The design-lane's flat "CodeQL required" and the checklist's omission of CodeQL are both imprecise.
- **F-5 — Zero required review approvals (self-merge gap).** [OBSERVED] Ruleset PR rule = 0 required approvals **and** classic `required_pull_request_reviews = null`. A PR that passes the status checks can be **self-merged unreviewed**. Peer review is a documented practice, not an enforced gate.
- **F-6 — No merge queue; action pins are mutable.** [OBSERVED] No workflow declares `merge_group:`; all **14 external `uses:` refs are mutable first-party `@vN` tags with zero SHA-pinning** (supply-chain drift exposure; INFERRED risk — not exploited).
- **F-7 — PR-secret exposure is bounded LOW.** [OBSERVED/INFERRED] `quality.yml` references `TEST_INTEGRITY_DEPLOY_KEY` in a PR-triggered job, but the trigger is `pull_request` (not `pull_request_target`), so GitHub withholds the secret from fork PRs and the step fails closed (exit 2); same-repo-PR risk is low. This narrows the design-lane's "deploy-key-in-PR-job risk" framing. Only the secret **name** was read; no value.
- **F-8 — CI health is green.** [OBSERVED] Last 10 `quality.yml` runs on main: 9 success + 1 in-progress; `whatsoup-guard` 10/10 (path-gated); `tag-release-gate` shows observed-zero on main (tag-only trigger, source-explained — not a failure).

### 4.3 Orphaned / dormant / gap controls — bounded-search verified

- **F-9 — Three orphaned controls.** [OBSERVED] `grant-resolver-inventory-guard` — its **test is wired** into `verify:push:branch` but the guard itself scans nothing / is invoked by no gate (it still satisfies the `guard-test-coverage` meta-guard, a meta-guard blind spot). `required-suites` and `check-launchd-drift` are likewise implemented but unreached by any caller. Each was confirmed by a complete caller search, not a spot check.
- **F-10 — `process.no-destructive-git` is a block-severity rule with no implementer.** [OBSERVED] It is declared `block` in the fitness registry, but an exhaustive search of `scripts/`, `eslint-rules/`, and `package.json` finds **no wired implementer**. This is why registry severity `block`=17 but status `active-block`=16 among fitness rules — one block rule does not actually block.
- **F-11 — Mutation testing: one gate is dormant, one is active.** [OBSERVED] `stryker.conf.json` is **dormant** — its only occurrence in the tree is the config file; no caller; deps uninstalled. The **active** mutation gate is `deploy/scripts/run-sentinel-tests.sh` (Python `cov-fail-under=98` on sentinel modules + deployer mutation drill), wired in `quality.yml`.
- **F-12 — Semantic-quality runs in shadow only.** [OBSERVED] `semantic-quality-check.ts` is wired in shadow mode (exit forced 0) in `verify:push:branch`, `verify:release`, and `quality.yml`; the enforce path (`verify:semantic`) has **zero gate callers** (on-demand).

### 4.4 Local-vs-CI scope gaps

- **F-13 — `typecheck:scripts` is CI-only.** [OBSERVED] `typecheck:all` runs in both composites and CI, but `typecheck:scripts` (the `scripts/` build tooling typecheck) is absent from `verify:push:branch` and `verify:release` — it runs only in `quality.yml`. A `scripts/`-only type error passes the local push gate.
- **F-14 — `arch.file-size` blocks only at release/CI.** [OBSERVED] The file-size ratchet enforces at `verify:release`/full-suite CI, not at branch `verify:push:branch`; the eslint mirror is warn-only. (Consistent with the repo's own CLAUDE.md note that the local push gate is a strict subset of CI.)
- **F-15 — Checklist Layer 1 is stale.** [OBSERVED] `docs/contributing/quality-guardrails-checklist.md` (last substantive touch `8edbe5058`, 2026-06-21) documents ~13 of the ~40+ steps the live `quality.yml` now runs, and its Branch-Protection section omits classic protection, CodeQL, and the self-merge/admin-bypass facts of F-3…F-5. This is the primary refresh target (see the patch deliverable).

### 4.5 Design-lane (reference-only)

- **F-16 — Design manifest is 8 controls, not landed.** [OBSERVED] `controls/ci-control-manifest.json` @ `6cc5ae433` declares 8 controls; 3 referenced commandIds (`guard:hooks-installed`, `ci:ref-policy`, `ci:classify`) are absent from main, and `architecture.fitness-lint` is declared `block` there vs the live warn-only ring. All labeled `design-lane-only`; none counted in the active estate.

## 5. Owner-gated recommendations (this audit implements none)

Each is a proposal with owner, prerequisites, and a rollback concept; none is executed by this audit.

| ID | Recommendation | Maps findings | Risk if adopted |
|---|---|---|---|
| R-01 | Refresh the checklist: document the full `quality.yml` step set, both branch-protection surfaces, CodeQL's admin-bypassable status, and the self-merge gap. | F-3…F-5, F-15 | Doc-only; low. Shipped as merged PR #2021. |
| R-02 | Decide the self-merge gap: set ≥1 required approval on the ruleset/classic protection, or explicitly accept solo-merge. | F-5 | Process change; owner policy. |
| R-03 | SHA-pin the 14 external action refs and/or add a merge queue (`merge_group`). | F-6 | Low; supply-chain hardening. |
| R-04 | Resolve the three orphaned guards (wire, or retire with the meta-guard opt-out) and close the meta-guard blind spot. | F-9 | Low; removes dead surface. |
| R-05 | Implement or demote `process.no-destructive-git` (block-declared, no implementer). | F-10 | Low; removes a false-block. |
| R-06 | Decide whether `typecheck:scripts` and `arch.file-size` belong in the local push gate or stay CI-only. | F-13, F-14 | Low; local/CI parity. |

## 6. Reproduction appendix (SC-09)

All commands run from `<repo-root>` against the pinned OID; no fetch/checkout/mutation.

- Anchor + parity: `git ls-remote origin refs/heads/main`; `git rev-parse origin/main`.
- Source reads: `git show f66ecfdb27eb04c60bf5f1f583ec1b3ad06d29f5:<path>`; tree enumeration `git ls-tree -r --name-only f66ecfdb2 <dir>`.
- Wiring searches: `git grep -n <pattern> f66ecfdb2 -- package.json .husky scripts .github` (complete corpus; counts recorded per negative-status row).
- Fitness count: `git show f66ecfdb2:scripts/lib/fitness/registry.ts | grep -cE "^[[:space:]]*id:"` → 36; pin `tests/scripts/fitness-registry.test.ts` → `toHaveLength(36)`.
- Hosted (read-only): `gh api repos/LucasQuiles/WhatSoup/rulesets`, `.../rulesets/16319133`, `.../branches/main/protection`, `.../code-scanning/default-setup`; `gh run list --workflow <f> --branch main -L 10 --json conclusion,status,event,createdAt`.
- Tools: `git` (sha1), `gh` 2.89.0, node ambient v26.4.0 (repo pins 24.15.0 — no repo script was executed by this audit; source reads need no node).

_Error semantics: a gh auth/rate/transport/empty/parse failure makes the external claim `UNKNOWN` with its raw receipt retained; a reproducible product/policy mismatch is `FAIL`; a missing authority/prerequisite is `BLOCKED`. None of these occurred for the hosted reads (8 OBSERVED, 0 UNKNOWN)._
