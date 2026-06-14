# Outstanding Burndown Implementation Plan

**Status:** completed/superseded — original implementation branch landed through #810, with follow-on closures in #814, #808, #813, #804, #816, #817, #818, #820, #821, #822, #823, and #825. Do not restart `chore/outstanding-specs-and-burndown`.

> **CURRENT STATE REFOCUS (2026-06-13 16:08 ET):** `origin/main` is `f65c3990f8c203978bd4b51affe7ee5f97e79024`. The original hardening branch is closed:
> - #810 closed R1-R5, H1 collector/runner, P1, and the safeguard-diagnostics fail-closed fix.
> - #814 closed the remaining no-decision residuals and several decisions after approval: `bot-errors-emit.py` parent preflight, `bot-errors-q-loop.py` exception alignment for private-dir setup, `checkBearerAuth` deletion, `guard-core.readText`, `asRecordOrEmpty`, and import-boundary fail-closed coverage.
> - #808 superseded the duplicate-helper lanes with `src/lib/private-fs.ts`, `src/core/provider-mcp-config.ts`, `src/runtimes/chat/enrichment/raw-output.ts`, and `src/lib/short-hash.ts`.
> - #815 closed the alert-pipeline review follow-ups and is now part of current `origin/main`; post-merge main CI on `13068ac9` finished 5/5 green.
> - #804, #813, #816, #817, #818, #820, #821, #822, #823, and #825 have since landed on main. #816 post-merge main CI on `218dfacd` finished 5/5 green; #817 post-merge main CI on `558730b0` finished 5/5 green; #818 post-merge main CI on `e1f07ffe` finished 5/5 green; #820 post-merge main CI on `99c7a0f2` finished 5/5 green; #821 PR CI was 6/6 green before merge and post-merge main CI on `0c17e3c1` finished 5/5 green; #822 landed as `a865276e`; #823 landed as `a9d2e53b`; #825 landed as `289c5f7b`.
>
> **Current local compose:** `integration/provider-hardening-compose-refresh-20260613T194657Z` composes the validated local hardening branches that are still not on `main`: private-fs chmod, provider errPreview redaction, heal stale reconciliation, detailed API retry shape, D18 health-poller policy, Python deploy redaction SSOT, guardrail residuals, verification reliability, process-lock ownership, pending-poll timeout normalization/clamping, provider credit taxonomy, release drift CLI, and sandbox opencode provider config. The latest code-bearing commit remains `6dcae2ea`, followed by documentation/work-index/hygiene handoff commits that were rechecked at branch `HEAD`; do not stamp a mutable branch-head hash here because this file changes during handoff refreshes. Pre-cleanup cherry proof caught two branch-tip commits that were not yet represented in the compose (`184d264a` credit-exhaustion false-positive tightening and `66e5cae3` fallback-opencode sandbox-config coverage); both are now included and `git cherry -v` shows them as represented. Compose-only fixes recorded in this branch: require BOT ERRORS helper manifest paths, classify the verification residuals plan in `docs/publication-audit.md`, preserve Python redaction contracts for `Authorization: Bearer ...` and `whatsoup@<phone>` service units, import the canonical `isRecord` helper in the runtime-manifest guard, and sanitize private host/domain/tailnet examples in public test fixtures by constructing the values dynamically.
>
> **Current proof:** `npm ci` completed in the fresh worktree with the expected Node 26 engine warning; targeted TS suite passed 612/612 before the final cherry-proof pass, then the two rescued branch tips passed their direct targeted suite (239/239); deploy Python pytest passed 302/302 under `python3.12`; changed-test Test Integrity scan had no findings; `guard:test-integrity` was clean with the existing 4-item baseline; `typecheck:all`, source-runtime/doc/work-index/public-surface/publication/runtime-manifest guards passed; `NODE_OPTIONS=--trace-warnings` runtime suite passed 216/216 with no `TimeoutNaNWarning`/`NaN` hits; full Vitest passed 590 files / 2 skipped, 9591 tests / 11 skipped at code head `6dcae2ea`; sanitized-fixture targeted tests passed 151/151 with Test Integrity clean; final exact-head `verify:push:branch` exited 0 after the handoff/hygiene commits. An earlier full-suite run failed four compose-only tests, and the fixes above are the recorded remediation.
>
> **Do next:** seek named approval before any push/PR/merge. Keep draft PRs #828 and #829 read-only/peer-owned; their topics overlap current main but `git cherry -v` still shows non-equivalent commits, so do not delete or mark superseded without `range-diff`/owner confirmation. Preserve/triage dirty parallel worktrees before cleanup. **Do not** treat the historical task checklist below as active work without first rechecking current main.

## Refocused Remaining Queue

| Area | Current status | Next action |
|---|---|---|
| PR #804: libsignal key-log suppression | Landed in current main as `2c7867d3` | Closed; direct console-redaction coverage landed with the branch. |
| PR #813: failure taxonomy + bounded retry | Landed in current main as `94862746` | Closed; provider retry/taxonomy adoption is now baseline context for later provider-failure work. |
| PR #816: provider-failure classification + terminal-error leak | Landed in current main as `218dfacd`; post-merge main CI 5/5 green | Closed for source durability; binding local evidence is Test Integrity, targeted parser/runtime tests, typecheck, source-runtime drift, and `verify:push:branch`. A parallel release log reached the full-suite summary and console build (`9497 passed / 1 skipped`), but no explicit exit marker was found in the retained log, so do not cite it as the binding merge gate. Live release re-cut and WhatsApp turn proof remain separate deployment work, not implied by code merge. |
| PR #817: reliability-runner tracking docs | Landed in current main as `558730b0`; post-merge main CI 5/5 green | Closed; tracked reliability-runner docs are now the current handoff source. |
| PR #818: mini1 health profile personal runtime | Landed in current main as `e1f07ffe`; post-merge main CI 5/5 green | Closed; local isolated validation passed Test Integrity, `tests/scripts/bot-errors-health-check.test.ts` (110 tests), `guard:doc-drift`, and `verify:push:branch`. |
| PR #820: Claude provider lifecycle coverage | Landed in current main as `99c7a0f2`; post-merge main CI 5/5 green | Closed; local review covered Test Integrity, targeted lifecycle tests, corrected adjacent provider tests, and `verify:push:branch`. |
| PR #821: config/model consistency | Landed in current main as `0c17e3c1`; PR CI 6/6 green before merge; post-merge main CI 5/5 green | Closed; local review covered Test Integrity, 194 focused validator tests, typecheck, lint fitness, `verify:push:branch`, and `verify:release` on rerun with Python 3.12 after host Python 3.14 caused an inconclusive node-gyp/pyexpat failure. |
| PR #822: primary-model usability probe contract | Landed in current main as `a865276e` | Closed as a contract-only slice. Follow-up before runtime/health wiring: represent OpenCode custom endpoint mode and decide explicit semantics for codex/gemini providers. |
| PR #823: release snapshot dry-run contract | Landed in current main as `a9d2e53b` | Closed as a manual dry-run contract slice. Follow-up: decide whether to wire it into an npm script or release gate. |
| PR #824: outbound terminal text dedupe | Open remote head `88c22d97`; local rebased remediation head `e1ce00ac` is not pushed | Local review found the remote branch only exercised manual `markLastTerminal()` calls; durability-mode production paths called `clearLastOpId()` and never populated the dedupe window. Local remediation wires per-chat/shared durability result completion through `markLastTerminal({ skipDurabilityMark: true })` and enables text dedupe only for suppressed terminal provider errors. Publishing requires explicit force-with-lease approval because the branch was rebased onto current `main`. |
| PR #825: publication audit summary | Landed in current main as `289c5f7b` | Closed; current tracked docs/publication summary is now the baseline. |
| PR #826: primary-model usability runtime | Open head `da9b41e6`; quality jobs failing at last inventory | Other active workstream. Treat read-only unless handed over by owner; do not merge or rebase casually. |
| PR #815: alert-pipeline review follow-ups | Landed in current main as `13068ac9`; post-merge main CI 5/5 green | Closed; keep only as baseline context for #804/#813 validation. |
| D5/R8 Python secret-redaction SSOT | Implemented in local compose; not on `main` until the compose branch lands | Compose uses manifest-tracked `deploy/scripts/lib/bot_errors_redaction.py`, migrates seven BOT ERRORS deploy consumers, adds parity/SSOT tests, and keeps TS source-diff hygiene vocabulary separate for now. |
| Python standalone deploy architecture | Decision package executed in local compose; not on `main` until the compose branch lands | Recommended direction adopted locally: a manifest-tracked `deploy/scripts/lib/` module with runtime-manifest coverage. Fallback remains N-copy equivalence guard if real-host deployment rejects shared imports. |
| Collector cooldown flake | Implemented in local compose; not on `main` until the compose branch lands | Compose adds deterministic fake-clock coverage in `deploy/scripts/tests/test_bot_errors_collector_backoff.py`; do not retry/skip/quarantine this class. |
| Older runtime decisions | Partly implemented in local compose; D20 keychain policy is now planned but not implemented | Compose includes heal stale reconciliation, process-lock ownership/TOCTOU hardening, detailed API retry-shape work, D18 health-poller policy, and provider errPreview sanitization. D20 is captured in `docs/superpowers/plans/2026-06-13-d20-provider-keychain-unlock-policy.md`; do not claim D20 closed until the observe-only/opt-in policy is implemented, manifest-verified, and gated. Reverify each runtime decision against branch `HEAD` before publishing. |
| Parallel worktrees/branches | Active preservation concern; current inventory recorded below | Preserve all named branches until owner approval; use `git cherry -v` or `git range-diff` before deleting anything claimed superseded. |

## Parallel Worktree Inventory

Fresh read on 2026-06-13/14 against `origin/main` `f65c3990f8c203978bd4b51affe7ee5f97e79024`; all entries below were inspected read-only.

| Surface | State | Evidence | Classification | Next action |
|---|---|---|---|---|
| `credential-write` worktree (`feat/credential-write-api`) | Clean; old upstream `origin/feat/provider-management-console` gone | `rev-list` vs main: `12/183`; `git cherry -v` shows 11 patch-positive commits and 1 already represented commit | Owner-gated feature/API branch | Keep; decide keep/land/discard with owner. Do not delete as stale merely because the old upstream is gone. |
| `alert-truth` worktree (`fix/alert-truth-corrections`) | Clean; remote branch gone | `rev-list` vs main: `6/165`; `git cherry -v` shows 6 patch-positive commits | Bot-errors reliability workstream | Keep; owner triage required before landing or pruning. |
| `soup-design` worktree (`design/soup-rebrand`) | Clean; tracks `origin/main`; diverged | `status`: ahead 69 / behind 131; `git cherry -v` shows design-program commits not on main | Long-running SOUP design branch | Preserve; rebase/land/discard only by SOUP owner decision. |
| `soup-impl` worktree (`feat/soup-v3-foundation`) | Clean; tracks `origin/main`; ahead-only at this snapshot | `status`: ahead 272; `git cherry -v` shows implementation + design commits not on main | Long-running SOUP implementation branch | Preserve; this is substantial live work, not cleanup debris. |
| Detached compose worktree for #828/#829 | Clean detached HEAD `9fac46bc` | 6 commits ahead / 0 behind main; contains PR #828 + #829 heads merged locally; changed files overlap runtime, db time parsing, and provider usability | Peer/draft integration surface | Read-only unless owner hands over. Do not delete while #828/#829 remain open drafts. |

## Guardrail Audit Addendum

| Priority | Gap | Current evidence | Next action |
|---|---|---|---|
| P0 | `guard:repo:staged` is not a PR/base diff gate in CI or post-commit pre-push contexts | `.github/workflows/quality.yml` ran the staged guard, but the guard reads `git diff --cached`; a clean CI index made added-line hygiene rules a smoke/no-op rather than PR-diff enforcement | Local branch `chore/guardrail-residuals-20260613` adds `guard:repo:branch-diff`, merge-base scanning, branch-history secret/artifact scanning for add-then-remove leaks, CI wiring, branch push wiring, public-surface docs, and chain self-tests. |
| P0 | `arch.file-size` is documented as blocking, but current enforcement is warning-count-only | `guard:lint:src` exits 0 on warnings, while `tests/scripts/fitness-file-size-warning-budget.test.ts` asserts only a max warning count, not exact file identities or line-count deltas | Decide whether file-size stays growth-fence-only or becomes blocking; then align docs, registry wording, and the budget test. |
| P1 | Release tag gate remains weaker than `verify:release` | `.github/workflows/tag-release-gate.yml` intentionally runs a guard-only subset, omitting full Vitest, coverage, test-integrity, drills, tokenomics, tools guard, and console build | Keep documented as tag-smoke unless owner approves heavier tag gating; do not cite tag CI as release verification. |
| P1 | Release snapshot dry-run contract is still manual after #823 | #823 added the script and tests, but no `package.json` or CI invocation exists yet | Decide whether to add an npm script and release-gate wiring or keep it as a manual operator tool. |
| P1 | BOT ERRORS runtime manifest integrity was covered by a large health-check test, not a fast explicit guard | `tests/scripts/bot-errors-health-check.test.ts` validates committed manifest hashes, but branch/release chains did not have a dedicated runtime-manifest guard step | Local branch `chore/guardrail-residuals-20260613` adds `guard:bot-errors-runtime-manifest`, required path inventory enforcement, CI wiring, branch/release wiring, public-surface docs, and chain self-tests. |
| P1 | WhatSoup guard watchdog treats drift-without-delivery-attempts as non-broken | `tools/whatsoup_guard` labels the state but exits 0 when no alerts are emitted | Make this state inconclusive/degraded or document why no-attempt drift is acceptable. |
| P1 | Public-surface route extraction can silently degrade to existence-only | `public-surface-drift-check.ts` skips multiline/unparseable route entries by design | Convert unsupported route shapes to fail-closed findings or add explicit tracked exceptions. |
| P1 | `test-integrity: source-string-ok` suppresses at file scope | The plugin suppresses every source-string finding when the marker appears anywhere in a file | Prefer line/block-scoped suppressions or split policy-source-string tests away from general tests. |
| P2 | Test-integrity baseline still carries parser-error blind spots | Baseline check is clean, but three parser-error exemptions plus one weak-assertion exemption remain owner-annotated | Remediate or rebaseline only after rescanning the affected files; do not call this zero-risk. |
| P2 | Import-boundary ratchet collapses duplicate file/specifier edges | A second forbidden import of the same specifier in one file is intentionally ignored once the edge is baselined | Decide whether debt-count prevention matters; if yes, track duplicate edge counts separately. |
| P2 | Fail-closed gate detector is shell-regex-narrow | It scans selected shell files and same-line sentinel patterns; TS/JS gates and multiline shell shapes are outside scope | Document scope or expand detection before relying on it as full fail-open coverage. |

> **SPLIT RECONCILIATION (2026-06-13):** During pre-push review the consolidation lane was found to collide with the concurrent, more comprehensive PR #808 (`refactor/private-fs-and-mcp-writer-consolidation`), which independently lands `src/lib/private-fs.ts` (superset of F2's `privateWriteError`), `src/runtimes/chat/enrichment/raw-output.ts` (identical to F1's `truncateRaw`/fence-strip), and `src/lib/short-hash.ts`. To avoid duplicate modules and conflicting edits, this PR was split: **F1 and F2 are dropped and ceded to PR #808**; the **cosmetic F3 folds** (anonymize-private-literals.ts, work-index.ts onto guard-core git/text helpers) are also dropped (collision-free with #808 but pure DRY — re-landable later). **Kept:** R1–R5, H1, P1, the R3 staged-blob-distinct-error machinery in guard-core, and the safeguard-diagnostics fail-open→fail-closed reliability fix (a reliability fix, not consolidation; collision-free). Net shipped scope = hardening + correctness only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining review/dedup/hardening items from the 311d948f..9c729acc sweep without reopening broad cleanup or touching unrelated workstreams.

**Architecture:** Split the work into independent implementation lanes with disjoint file ownership: guard/docs/coverage, enrichment/private-write dedup, bot-errors runtime hardening, and passive health correctness. Decision-gated items remain documented but unimplemented until an owner chooses the canonical direction.

**Tech Stack:** TypeScript, Vitest, Python deploy scripts, pytest, existing `scripts/lib/guard-core.ts`, existing bot-errors redaction/private-write idioms.

---

## Historical Base And Constraints

- Historical base: `origin/main` at `9c729acc45d6d9fa34b88c7e44a26f71baf1a57d`.
- Historical work surface: isolated worktree on branch `chore/outstanding-specs-and-burndown`.
- Do not use the shared checkout; it is on another branch and ahead of `origin/main`.
- Do not touch other active worktrees or branches unless their owners explicitly hand them over.
- Do not file GitHub issues or post externally without explicit operator approval.

## Transition Inventory

The branch must preserve this plan because `docs/superpowers/` is ignored by default. Force-add this file when publishing the branch, and keep the matching `docs/publication-audit.md` and generated work-index artifacts in the same commit.

External worktrees and branches are review inputs but not write targets for this slice:

| Surface | Classification | Reason |
|---|---|---|
| Shared checkout on `fix/provider-health-fallback-cascade` | Other workstream | Shared checkout is ahead of `origin/main`; read-only here. |
| Detached fallback/failure-taxonomy worktree | Other workstream | Dirty detached work; do not absorb. |
| Detached provider-fallback worktree | Other workstream | Dirty detached provider-fallback work; do not absorb. |
| Private-fs consolidation branch | Related future input | Ahead of main with private-fs consolidation work; useful for D2/F2 review, not part of this PR. |
| Pattern/ring/provenance/unit/secret guardrail branches | Related guardrail lanes | Review evidence for future deterministic guards; ownership remains with their branches. |
| Agent-owned scratch worktrees | Agent-owned scratch | Some dirty console/bot-errors test work exists; do not clean, delete, or merge without owner handoff. |
| `preserve/*` and detached review/tmp worktrees | Archive/review surfaces | Leave untouched. |

## Item Triage

| ID | Area | Status | Risk | Decision | Implementation Lane |
|---|---|---:|---|---|---|
| R1 | Public test fixtures contain production hostnames; hygiene guard misses `deploy/scripts/tests/*.py` | Ready | OPSEC | No product decision needed | Guard/docs |
| R2 | `daily-health-fail` incidents can remain open after a later healthy daily-health summary | Ready | Alert fatigue / stale incidents | No product decision needed | Bot-errors |
| R3 | `readStagedFileContent` catch-alls hide git/blob failures as missing audit | Ready | Misleading guard failure | No product decision needed | Guard/docs |
| R4 | Tag release gate commit-author scan is intentionally range-vacuous but underdocumented | Decision-gated for behavior; docs-only ready | Misleading assurance | Need owner call before changing scan semantics | Guard/docs docs-only |
| R5 | Coverage thresholds are not scoped to `src/**` | Ready | Misleading coverage threshold | No product decision needed | Guard/docs |
| F1 | `truncateRaw` and fence stripping duplicated in enrichment modules | Ready | DRY / future divergence | No product decision needed | Enrichment |
| F2 | `privateWriteError` duplicated across private-write modules | Ready if scoped to touched files | DRY / error-shape drift | Keep behavior unchanged | Private-write |
| F3 | Guard scripts hand-roll git/text helpers despite `guard-core` | Partially ready | Drift / ENOBUFS in multiple helpers | Preserve each caller's contract; leave residuals if equivalence is not exact | Guard/docs |
| H1 | Bot-errors `atomic_write_json` helpers miss parent private-dir assertion in collector/runner and possibly emit | Ready | Symlink/private-dir regression | No product decision needed for helper-level preflight | Bot-errors |
| H2 | `bot-errors-q-loop.py` raises `OSError` where sibling private-dir helpers raise `RuntimeError` | Decision-gated | Divergent error contract / telemetry classification | Need owner call before changing exception classes | None |
| P1 | `PassiveRuntime.getHealthSnapshot()` swallows DB errors and returns healthy zero details | Ready | False healthy signal | No product decision needed | Passive runtime |
| D1 | Delete dead `checkBearerAuth` export | Decision-gated | API churn | Need owner call: delete vs keep | None |
| D2 | Adopt chmod defense in `workspace.ts` | Decision-gated unless scoped to private-write lane | Permission semantics | Need owner call: chmod on existing dirs/files? | None |
| D3 | Add `readText` to `guard-core` | Decision-gated if used as new canonical | API growth | Prefer only if >=2 callers migrate | None |
| D4 | Console `asRecord` naming | Decision-gated | Naming/API churn | Need owner call | None |
| D5 | Python deploy secret-patterns SSOT location | Decision-gated | Security-sensitive | Belongs with bot-errors workstream | None |

## Shared Acceptance Rules

- Every implementation bead starts with a failing or missing proof.
- Use exact commands and capture true exit codes. Masked failures are inconclusive.
- Run Test Integrity on changed test files.
- Run targeted tests before `npm run verify:push:branch`.
- If a branch is pushed, require CI green before merge and observe post-merge main CI.
- Update this plan or the eventual handoff with remaining decision-gated items and exact triggers.

## Task 1: Guard / Docs / Coverage

**Files:**
- Modify: `scripts/repo-hygiene-guard.ts`
- Modify: `tests/scripts/repo-hygiene-guard.test.ts`
- Modify: `scripts/lib/guard-core.ts`
- Modify: `scripts/publication-guard.ts`
- Modify: `tests/scripts/publication-guard.test.ts`
- Modify: `scripts/anonymize-private-literals.ts`
- Modify: `scripts/work-index.ts`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify if behavior can be preserved exactly: `scripts/source-runtime-drift-check.ts`
- Modify: `.github/workflows/tag-release-gate.yml`
- Modify: `tests/scripts/pre-push-guard.test.ts`
- Modify: `vitest.config.ts`
- Add or modify: `tests/scripts/guard-core.test.ts`

### R1 Spec: Extend Hygiene Guard To Python Deploy Tests

- Problem: OPSEC fixture strings in `deploy/scripts/tests/*.py` are outside the current staged hygiene test coverage.
- Acceptance: staged additions under `deploy/scripts/tests/*.py` are scanned for private host labels, real-shaped JIDs, local paths, and token-like values.
- Negative test:

```ts
it('flags private host labels in deploy script Python tests', () => {
  const issues = scanAddedLines([
    { filePath: 'deploy/scripts/tests/test_example.py', line: 4, text: 'HOST = "<private-host>"' },
  ]);
  expect(issues.map((issue) => issue.code)).toContain('private-host-label');
});
```

- Implementation: update any path exclusions or test-only bypasses in `scripts/repo-hygiene-guard.ts` so deploy script tests are treated like public repo fixtures. Do not special-case the current four strings; make the rule deterministic.

### R3 Spec: Distinguish Staged Blob Git Failures

- Problem: `scripts/lib/guard-core.ts` `readStagedFileContent()` catches all `git show` failures and returns `undefined`, so broken git/index state looks like a missing audit.
- Acceptance: `guard:publication:staged` emits a distinct error code for unexpected git blob read failures, while still returning `undefined` for genuine missing staged and HEAD blobs.
- Negative test:

```ts
it('reports staged audit read errors separately from missing audit rows', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const result = runPublicationGuard(['--staged'], repoWithBrokenGitShow);
  expect(result).toBe(1);
  expect(error.mock.calls.join('\n')).toContain('audit-read-failed');
});
```

- Implementation: introduce a small result object such as `{ ok: true, content?: string } | { ok: false, error: string }` for staged audit reads, or add a new helper dedicated to publication guard. Preserve existing callers of `readStagedFileContent` unless migrated intentionally.

### R4 Spec: Document Vacuous Tag Commit Scan

- Problem: `.github/workflows/tag-release-gate.yml` runs `guard:repo:commit-authors` on a tag push. With no PR base ref, this can be vacuous by design; that is acceptable only if documented.
- Acceptance: workflow comments and guard tests state that the tag gate keeps the command wired but cannot prove a PR-range author scan. PR and local push gates remain the authoritative non-vacuous scan.
- Test: extend `tests/scripts/pre-push-guard.test.ts` or repo-hygiene tests to assert the workflow contains the explanatory comment near the tag commit-author step.
- Non-goal: do not add tag-target or history scanning in this slice. That changes release-policy semantics and needs an owner decision.

### R5 Spec: Fence Coverage Thresholds To Source

- Problem: `vitest.config.ts` coverage thresholds apply without an explicit `include`, so fixture/test churn can affect apparent threshold scope.
- Acceptance: coverage includes only `src/**` production TypeScript/TSX files unless a future decision expands it.
- Implementation:

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts', 'src/**/*.tsx'],
  reporter: ['text', 'html', 'json', 'json-summary'],
  reportsDirectory: 'coverage',
  thresholds: {
    lines: 82,
    branches: 73,
    functions: 79,
  },
}
```

### F3 Spec: Guard-Core Helper Fold

- Problem: `scripts/anonymize-private-literals.ts`, `scripts/work-index.ts`, `scripts/safeguard-diagnostics.ts`, and `scripts/source-runtime-drift-check.ts` duplicate git/text helpers already present in `scripts/lib/guard-core.ts`; several local `git()` wrappers lack the 64 MiB maxBuffer cap and one uses a smaller cap.
- Acceptance: repeated git-list and text-candidate logic is folded into guard-core exports where behavior stays equivalent.
- Equivalence caveat: `anonymize-private-literals.ts` currently treats `.example` files as text candidates; do not shrink that scan surface when moving to `guard-core`.
- Residual rule: if a caller has a materially different return contract, leave it local and record the residual instead of forcing a risky refactor.
- Tests:
  - Add `tests/scripts/guard-core.test.ts` for `gitList`, `normalizeRepoPath`, `isTextCandidate`, and any new helper.
  - Run existing tests for anonymize, work-index, safeguard diagnostics, publication guard, and pre-push guard.

## Task 2: Enrichment And Private-Write Dedup

**Files:**
- Create: `src/runtimes/chat/enrichment/json-output.ts`
- Modify: `src/runtimes/chat/enrichment/extractor.ts`
- Modify: `src/runtimes/chat/enrichment/validator.ts`
- Modify: `src/runtimes/chat/enrichment/contradiction.ts`
- Modify: `tests/runtimes/chat/enrichment/extractor.test.ts`
- Modify: `tests/runtimes/chat/enrichment/validator.test.ts`
- Modify: `tests/runtimes/chat/enrichment/contradiction.test.ts`
- Create or modify: `src/core/private-write-error.ts`
- Modify: `src/core/workspace.ts`
- Modify: `src/core/intro-sent-config.ts`
- Modify: `src/fleet/routes/ops.ts`
- Modify: existing private-write tests

### F1 Spec: Enrichment JSON Output Helpers

- Problem: enrichment modules duplicate `truncateRaw` and JSON fence stripping.
- Acceptance: one leaf helper owns raw truncation and fence stripping; extractor, validator, and contradiction import it.
- Proposed API:

```ts
export const RAW_OUTPUT_TRUNCATE = 2_000;

export function truncateRawOutput(raw: string, limit = RAW_OUTPUT_TRUNCATE): string {
  return raw.length > limit ? raw.slice(0, limit) : raw;
}

export function stripJsonFences(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fenceMatch ? fenceMatch[1].trim() : raw;
}
```

- Tests:
  - Extractor strict malformed response exposes a truncated `rawOutput`.
  - Validator strict malformed response exposes the same truncation semantics.
  - Contradiction parser accepts fenced JSON through the shared helper.

### F2 Spec: Private Write Error Factory

- Problem: `privateWriteError()` is duplicated in `workspace.ts`, `intro-sent-config.ts`, and `fleet/routes/ops.ts`.
- Acceptance: one tiny shared factory returns a `NodeJS.ErrnoException` with identical message/code behavior.
- Proposed API:

```ts
export function privateWriteError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}
```

- Keep the helper leaf-level; do not pull fleet route code into core runtime code.
- Tests: existing symlink/non-regular path tests still assert exact `.code` values.

## Task 3: Bot-Errors Runtime Hardening

**Files:**
- Modify: `deploy/scripts/bot-errors-collector.py`
- Modify: `deploy/scripts/bot-errors-runner.py`
- Modify: `deploy/scripts/bot-errors-q-loop.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Modify: `tests/scripts/bot-errors-collector.test.ts`
- Modify: `tests/scripts/bot-errors-runner.test.ts`
- Modify: `tests/scripts/bot-errors-dispatcher.test.ts`
- Modify or add: `deploy/scripts/tests/test_bot_errors_*`

### H1 Spec: Parent Private Directory Assertion Before Atomic Writes

- Problem: `bot-errors-collector.py` and `bot-errors-runner.py` have `ensure_private_dir()` but their `atomic_write_json()` implementations do not call it before creating the temporary file. `bot-errors-emit.py` also lacks helper-level preflight, though its normal caller currently reaches the helper through `safe_child_path()`. Siblings such as health-check and heartbeat-watchdog do helper-level preflight.
- Acceptance: collector and runner call `ensure_private_dir(path.parent)` before deriving/opening the temp path. Include emit only if the change is helper-local and tests prove existing caller behavior stays unchanged.
- Tests:
  - Parent directory symlink causes atomic write to fail before temp creation.
  - Missing parent directory is created private mode `0700`.

### H2 Spec: Q-Loop Private Directory Exception Class

- Problem: `bot-errors-q-loop.py` private path helpers raise `OSError`; sibling scripts raise `RuntimeError` for the same contract.
- Current verdict: decision-gated. `OSError` is currently classified as `state_integrity_failed`; changing the class can change telemetry classification and operator alerts.
- Acceptance before implementation: owner chooses either `OSError`, `RuntimeError`, or a deliberate shared `PrivatePathError`, with event-kind expectations documented.
- Non-goal: do not change q-loop exception classes in this PR.

### R2 Spec: Daily-Health-Fail Incident Recovery

- Problem: `daily-health-fail` criticals are source-qualified and visible, but later healthy `daily-health` clears only source-specific WhatsApp incident classes and do not close `daily-health-fail` records.
- Acceptance: a later healthy `daily-health` summary for the same machine/instance closes matching open `daily-health-fail:*` incidents when the probe line is healthy and created after the fail event.
- Test: create an open incident key like `host|line-a|daily-health-fail:line-a`, dispatch a healthy `daily-health` event for `line-a`, and assert the incident is closed and a recovery/clear disposition is recorded once.
- Non-goal: do not collapse `daily-health` info suppression or re-enable daily health noise posting.

## Task 4: Passive Runtime Health Correctness

**Files:**
- Modify: `src/runtimes/passive/runtime.ts`
- Modify: `tests/runtimes/passive/health-snapshot.test.ts`
- Optionally modify: `tests/runtimes/passive/runtime.test.ts`

### P1 Spec: DB Error Must Not Look Healthy

- Problem: `PassiveRuntime.getHealthSnapshot()` catches DB errors and returns `status: 'healthy'` with zeroed details.
- Acceptance: DB query failures return a degraded/unhealthy status and include a non-secret reason in details.
- Proposed behavior:

```ts
return {
  status: 'degraded',
  details: {
    unreadCount,
    lastActivityAt,
    healthSnapshotError: 'db_query_failed',
  },
};
```

- Test: replace the existing “gracefully returns defaults” test with an assertion that status is `degraded` and details include `healthSnapshotError: 'db_query_failed'`.
- Logging: add a warn log with `{ err }` if the local pattern permits; do not include raw SQL parameters or message content.

## Decision-Gated Specs

### D1: `checkBearerAuth` Export

- Current evidence: `src/lib/http.ts` exports `checkBearerAuth`; `tests/lib/http.test.ts` exercises it directly.
- Decision needed: delete as dead export, keep as public utility, or move to internal-only helper.
- Do not implement until callers and public-surface expectations are rechecked.

### D2: Workspace Chmod Defense

- Current evidence: Python private-dir helpers chmod directories to `0700`; `workspace.ts` only asserts directory shape.
- Decision needed: should TypeScript private writes force chmod, warn, or fail on permissive modes?
- Security-sensitive; needs explicit compatibility call before implementation.

### D3: `guard-core.readText`

- Current evidence: `safeguard-diagnostics.ts` has a local `readText`; adding a canonical helper is only worth it if multiple guard scripts migrate.
- Decision needed: add canonical helper now or leave local until a second caller needs it.

### D4: Console `asRecord` Naming

- Decision needed: choose naming convention and scope; do not churn console code for naming only during this burndown.

### D5: Python Secret Pattern SSOT

- Current evidence: deploy scripts have divergent redaction regex sets and no `deploy/secret-patterns.json`.
- Decision needed: canonical location and loader contract. This belongs with the bot-errors workstream because it is security-sensitive and touches multiple Python entry points.

## Implementation Order For Agents

1. Normalize: each worker verifies base SHA, branch, dirty status, and file ownership before edits.
2. Frame: worker restates the specific item acceptance criteria and non-goals.
3. Scout: worker reads only owned files and adjacent tests.
4. Architect: worker confirms no cross-lane write conflict and chooses minimal helper API.
5. Execute: TDD red/green in the worker worktree.
6. Harden: worker runs Test Integrity on changed tests and checks for misleading logs/observability gaps.
7. Synthesize: conductor reviews diffs, resolves conflicts, runs integrated gates, then creates one PR only if all lanes pass.

## Integrated Verification Ladder

Run after worker integration:

```bash
npm test -- --pool=forks --fileParallelism=false \
  tests/scripts/repo-hygiene-guard.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/scripts/anonymize-private-literals.test.ts \
  tests/scripts/work-index.test.ts \
  tests/scripts/safeguard-diagnostics.test.ts \
  tests/runtimes/chat/enrichment/extractor.test.ts \
  tests/runtimes/chat/enrichment/validator.test.ts \
  tests/runtimes/chat/enrichment/contradiction.test.ts \
  tests/runtimes/passive/health-snapshot.test.ts \
  tests/scripts/bot-errors-collector.test.ts \
  tests/scripts/bot-errors-runner.test.ts \
  tests/scripts/bot-errors-dispatcher.test.ts

python3 -m pytest deploy/scripts/tests

<test-integrity>/scripts/test-integrity scan --ci \
  tests/scripts/repo-hygiene-guard.test.ts \
  tests/scripts/publication-guard.test.ts \
  tests/scripts/pre-push-guard.test.ts \
  tests/runtimes/chat/enrichment/extractor.test.ts \
  tests/runtimes/chat/enrichment/validator.test.ts \
  tests/runtimes/chat/enrichment/contradiction.test.ts \
  tests/runtimes/passive/health-snapshot.test.ts \
  tests/scripts/bot-errors-collector.test.ts \
  tests/scripts/bot-errors-runner.test.ts \
  tests/scripts/bot-errors-dispatcher.test.ts

npm run verify:push:branch
```

If Python or full push gates fail for unrelated active bot-errors flakes, capture the true failing command and log path; do not mark it clean.
