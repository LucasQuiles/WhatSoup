# Quality Guardrails — Contributor Checklist

**Purpose**: Capture the active CI/guardrail surface + recurring failure modes discovered in production work. This is the canonical reference for "what must pass before a PR can merge" and "what hand-built rules exist that aren't enforced by the typecheck or test runner alone."

## Layer 1 — CI gates (must pass for merge)

> **This table is a curated subset.** As of 2026-07-21 the live `quality.yml` runs ~40+ steps: the full `guard:*` family, coverage (`coverage:check`), browser/Playwright suites, console design checks, mutation via `deploy/scripts/run-sentinel-tests.sh` (pytest `--cov-fail-under=98` + deployer mutation drill — note `stryker.conf.json` is dormant/unwired), and tokenomics/drills. Blocking authority for the 36-rule architectural-fitness registry (`scripts/lib/fitness/registry.ts`) lives in the **guard ring** (`verify:push:branch`), not the ESLint ring, which is warn-only. Semantic-quality (`semantic-quality-check.ts`) runs in **shadow mode** (exit 0) everywhere it is wired; its enforce path is unwired/on-demand.

The `Quality` workflow (`.github/workflows/quality.yml`) runs on every PR and
every push to `main`, with two explicit required-context jobs:

- `quality (24.x)` is the full enforcement authority. It owns all static,
  Python, guard, coverage, console-design, and browser checks listed below.
- `quality (25.x)` is the compatibility lane. It performs clean root and
  console installs, the complete non-coverage Vitest suite, and the console
  production build. It intentionally does not duplicate version-invariant
  guards, coverage, Python, lint/design, or browser work.

This split preserves both required context names while removing roughly
6.7 duplicated runner-minutes per workflow run across five recent successful
main runs. It primarily frees runner capacity; Node 24 remains the critical
path, and exact savings vary with runner scheduling and step duration.

| Step | Command | Purpose |
|---|---|---|
| Typecheck | `npm run typecheck` | src/ only (tsconfig.json) |
| Typecheck scripts/ | `npm run typecheck:scripts` | scripts/ build tooling (tsconfig.scripts.json) |
| **Typecheck (all)** | `npm run typecheck:all` | **src/ + tests/ + console/src/ (tsconfig.test.json) — broader scope than `typecheck`** |
| Repo hygiene (staged) | `npm run guard:repo:staged` | hygiene-guard.ts rules — synthetic JIDs, API-key shapes, real names, etc. |
| Repo hygiene (branch diff) | `npm run guard:repo:branch-diff` | same added-line rules over merge-base(base, HEAD)..HEAD so PR/clean-index contexts are not staged-only smoke tests, plus branch-history secret/artifact checks for add-then-remove leaks |
| Repo hygiene (commit-msg) | `npm run guard:repo:commit-msg <msg>` | hygiene rules on commit messages too |
| Documentation drift | `npm run guard:doc-drift` | docs ↔ code coupling check |
| Public surface drift | `npm run guard:public-surface-drift` | exported API surface stability check |
| Work index coverage | `npm run guard:work-index` | docs/work-index.json completeness |
| AskUser poll protocol guard | `npm run guard:agent-decision-polls` | Verifies the WhatsApp poll decision protocol remains wired across prompt guidance, MCP schema descriptions, sandbox diagnostics, docs, and release gates. |
| Safeguard diagnostics | `npm run guard:safeguard-diagnostics` | Deterministic readout of guard-chain wiring, sensitive-publication anchors, runtime-boundary anchors, public-exposure guards, and portability blockers. |
| **Test integrity baseline check** | `npm run guard:test-integrity` | Runs the baseline check for tautologies, weak assertions, raw sleeps, and assertion-free tests when the plugin is installed; skips missing-plugin cases only outside CI and when `WHATSOUP_REQUIRE_TEST_INTEGRITY` is not set. The Node 24 job installs the private `LucasQuiles/test-integrity` plugin over SSH using the read-only `TEST_INTEGRITY_DEPLOY_KEY`, fetches the exact `TEST_INTEGRITY_COMMIT`, detaches at that object, and verifies `HEAD` byte-for-byte. Pin updates are reviewed repository changes; CI never pushes or publishes plugin state. |
| Repo-hygiene tests | `npm test -- tests/scripts/repo-hygiene-guard.test.ts` | tests that the hygiene-guard itself works |
| Full test suite + coverage | `npm run coverage:check -- --pool=forks` | Node 24 runs the entire Vitest suite under V8 coverage and enforces thresholds. Node 25 separately runs `npm test -- --pool=forks` without duplicating coverage. |
| Console build | `npm --prefix console run build` | Vite production build smoke |

Before the Node 24 toolchain setup, `scripts/ci-disk-reclaim.sh` records free
space and enforces a 30 GiB budget. Sufficient runners skip mutation with a
structured receipt. Low-space runners remove only the allowlisted unused
toolchains and Docker images, report every action, and re-measure. Malformed
disk observations are inconclusive (exit 2); a measured post-reclaim shortfall
is blocking (exit 1). Cleanup failures are never hidden with `|| true`.

## Layer 1.5 — Local pre-commit early-drift signal (warn-only)

The `.husky/pre-commit` hook first runs the deterministic
`npm run guard:git-estate -- guard --phase pre-commit` scan. It inventories every
linked worktree, local branch/upstream state, stash object identity, and conflict
identity without printing filenames or stash subjects. The commit-time scan is
one estate-wide capture and is warn-only so an unrelated lane cannot block a
local checkpoint; incomplete scans and estate growth remain visible warnings.
Pre-push retains two independent captures for race detection and applies the
same estate evaluation fail-closed.

The hook also reads the invoking worktree's atomic writer lease. Free or valid
held state is reported without prompting the agent. A stale, malformed, or
unreadable lease is warn-only at commit time and fail-closed at push time; the
hook never steals, deletes, or silently renews a lease.

The hook then hard-runs `npm run guard:repo:staged` (and console `lint-staged` for
`console/src` changes). It additionally emits a **warn-only** architectural-drift
signal when a commit stages `*.ts`, `package.json`, `.nvmrc`, or `deploy/` files:
it runs `guard:boundaries` and `guard:lint:src` and prints a warning for either
that fails, **without aborting the commit**. Node-pin consistency already ran
once as an unconditional blocking pre-commit check, so the warning phase does
not repeat it. These same guards are hard-enforced at push by
`verify:push:branch` (Layer 2); the
architectural-drift signal only surfaces drift earlier. Skip only that signal
with `WHATSOUP_SKIP_DRIFT_WARN=1`.

## Layer 2 — Local pre-push guards

Pre-push routes through `scripts/pre-push-guard.ts`. Before classifying any ref
update—including delete-only pushes—it requires a complete Git-estate scan and
compares it with the machine-local baseline under the repository's common Git
directory. It blocks newly introduced conflict instances, prunable/detached/
locked worktrees, stashes, gone-upstream branches, and new critical housekeeping
debt. New registered worktree or local-branch identities are reported as
**advisory only** and never block, in either phase — the current invoking
worktree identity and its checked-out branch identity are still evaluated
independently and exempted only when that exact branch appears in a non-delete
pre-push ref update, so the reported growth reflects only genuinely new
identities, but even unexempted growth no longer blocks. The ratchet is
repo-global while several agents work the repo concurrently, so growth is
routinely caused by an agent other than the pusher, who cannot clear it: growth
is an ID set difference, and retiring unrelated work does not offset it.

Pre-push ref updates accept object IDs at exactly the 40-character SHA-1 or
64-character SHA-256 width. Intermediate widths are malformed, and an all-zero
local object ID at either supported width is treated as a deletion. A normal
`git push -u origin HEAD` maps symbolic `HEAD` to its branch destination before
the exact invoking-lane comparison; pushing `HEAD` to a differently named
destination does not exempt the differently named local branch.

For every non-delete push, the hook also binds the verification run to one exact
candidate commit. The invoking worktree must be clean, the pushed candidate must
resolve to its current `HEAD`, the configured WhatSoup push URL must be SSH, and
the candidate must contain the live remote `main` read with `git ls-remote`.
After the branch or release composite finishes, the hook rechecks the configured
remote, `HEAD`, worktree cleanliness, and live `main`. A mid-run main advance is
a retryable **INCONCLUSIVE** result: fetch and rebase or merge the latest main,
rerun the gate, then push. The hook never rebases, stashes, or rewrites work.

Missing or malformed baselines, malformed ref input or porcelain, Git command timeouts,
and racing or incomplete scans are **INCONCLUSIVE** and fail closed. Worktree
status scans use a four-worker bounded pool and every Git subprocess has a
bounded timeout. Inherited critical debt, dirty worktrees, untracked files,
missing upstreams, and ahead/behind/diverged branches remain explicit warnings
so an unrelated in-flight lane is visible but does not become a working
bottleneck. After reviewing the complete human snapshot, initialize or
deliberately refresh the local ratchet with:

```bash
npm run guard:git-estate -- baseline write
```

The write is refused for incomplete or racing scans and atomically replaces only
the machine-local v2 baseline; it does not clean, delete, prune, stash, or rewrite
any repository state. The reader validates an exact canonical payload schema,
safe integer counts, hashed identity shapes, sorted unique arrays, count/identity
agreement, and a SHA-256 payload binding. This detects accidental or partial
tampering; a same-user attacker who can rewrite both payload and digest is outside
this local guard's threat boundary. Baseline acceptance is therefore an explicit
owner action, not an automatic way to bless a newly observed conflict.

Linked worktrees must use a worktree-relative hook path:

```bash
git config core.hooksPath .husky
```

Do not store an absolute primary-worktree path in `core.hooksPath`: Git shares
that setting across linked worktrees, so an absolute value makes every lane run
the primary worktree's potentially stale or in-flight hook bytes.

| Push target | Composite script | Required checks |
|---|---|---|
| Branch push | `npm run verify:push:branch` | repo hygiene staged smoke, repo hygiene branch/base diff, publication staged guard, doc drift guard, public-surface drift guard, work-index guard, node-pin guard, source-runtime drift guard, BOT ERRORS runtime-manifest guard, simulation matrix guard, Claude settings guard, AskUser poll protocol guard, safeguard diagnostics, test-integrity baseline, ring/boundary/service/config guards, `npm run typecheck:all`, the targeted guard test list below, design-system hygiene guard, harness-maintenance manifest guard, tokenomics Python tests, and console lint + build (#1105: these last four mirror blocking CI quality-job steps so console strict-tsconfig/design-system/tokenomics violations fail fast locally; the slow coverage/drills/browser tail stays in `verify:release` and CI) |
| `main` or release tag push | `npm run verify:release` | release repo hygiene, full publication audit, doc drift guard, public-surface drift guard, work-index guard, node-pin guard, source-runtime drift guard, BOT ERRORS runtime-manifest guard, simulation matrix guard, Claude settings guard, AskUser poll protocol guard, safeguard diagnostics, test-integrity baseline, ring/boundary/service/config guards, tokenomics/drills, `tools/whatsoup_guard` install/typecheck/test, console dependency install/lint/build, `npm run typecheck:all`, full Vitest suite with `--pool=forks --fileParallelism=false`, and coverage thresholds |
| Delete-only push | metadata-only dispatcher path | `design:metrics` and `design:burndown`, each once through the pinned npm wrapper; content verification and console dependency prerequisites are skipped |

Before branch or release verification starts, the dispatcher checks that the
installed console package exposes executable `eslint`, `tsc`, and `vite`
entrypoints, then uses the pinned npm wrapper to validate the complete installed
package graph in offline, lifecycle-script-disabled mode. A missing or invalid
package, plugin, or transitive dependency fails before the expensive composite
with the remediation `npm ci --prefix console`. Child output is suppressed so
the diagnostic stays bounded and cannot echo package-manager configuration.
Delete-only pushes bypass this prerequisite so the file-based metadata checks
remain runnable without console dependencies. Branch and release composites
already include those metadata checks through `verify:console-design`; the hook
does not repeat them.

The "ring/boundary/service/config guards" phrasing above folds in several named
guards that `verify:push:branch` runs. Spelled out:

| Guard | Command | Purpose | Also in CI (`quality.yml`)? |
|---|---|---|---|
| Git estate awareness | `npm run guard:git-estate -- guard --phase pre-push` | Snapshot all linked worktrees twice plus branch/upstream state, stash object identity, and conflict-instance identity; fail closed on malformed porcelain, timeouts, incomplete/racing scans, invalid v2 local baselines, new conflicts, and new critical housekeeping debt; new worktree/branch identities are reported advisory-only and never block — the ratchet is repo-global while several agents work the repo concurrently, so growth is routinely caused by an agent other than the pusher, who cannot clear it (growth is an ID set difference; retiring unrelated work does not offset it). | no (local estate only) |
| Service unit validity | `npm run guard:service-units` | Validate launchd plists / systemd units (label == filename stem, no bare/`env` node, no unexpanded `${VAR}`, node-pin match, absolute well-formed paths, valid plist structure). | yes |
| Instance config integrity | `npm run guard:instance-config` | Verify instance `config.json` files for memory-config integrity (non-empty `memory.pinecone.expectedHostSuffix`, no UUID-shaped `projectId` host trap) and per-host health-port map integrity. | yes |
| Fail-closed gate | `npm run guard:fail-closed-gate` | Reject fail-open shell gate shapes: a probe that substitutes a sentinel on failure (`\|\| echo "000"`, `\|\| true`) then gates only on success, and the `grep -c ... \|\| echo 0` double-zero shape. | yes |
| Fleet bot-hardening parity | `npm run guard:fleet-bot-hardening-parity` | Verify the redacted fleet bot-hardening parity manifest and its source anchors stay aligned with the A–D provider-resilience standard. | yes |
| ARC binding drift | `npm run guard:arc-binding-drift` | Verify the tracked `.arc/` shim. Always-on vendored-pin check (`.arc/.canonical-sha` vs the payload sha in `arc.toml`/`ARC_BINDING.md`) hard-blocks a stale `.arc/` even in CI without the sibling repo; when the sibling agent-runtime-protocol is reachable (via `ARC_REPO_DIR`), additionally runs the full byte-for-byte adopt-generator comparison and cross-checks the pin against the live sha. | yes |
| Guard test coverage (meta-guard) | `npm run guard:guard-test-coverage` | Meta-guard: every guard-family script (`scripts/*guard*.ts`, `scripts/check-*.ts`) must ship a companion test wired into `verify:push:branch`, or carry a `// meta-guard:no-test <reason>` opt-out. | no (pre-push only) |

### Regenerating the ARC binding shim (`.arc/`)

The tracked `.arc/` shim (`arc.toml`, `ARC_BINDING.md`) is **generated output** of
the canonical ARC adopt tool, which lives in the sibling agent-runtime-protocol
repository — not in this repo. Do not hand-edit `.arc/`; regenerate it. When the
`guard:arc-binding-drift` guard reports drift:

```bash
python3 "$ARC_REPO_DIR/tools/adopt.py" whatsoup --output-dir .arc --force
```

`$ARC_REPO_DIR` is the sibling agent-runtime-protocol checkout (the guard also
auto-resolves `../agent-runtime-protocol`). Then update `.arc/.canonical-sha` to
the new payload sha — the guard's always-on vendored-pin check asserts that
`.arc/.canonical-sha`, the `payload_sha` line in `arc.toml`, and the `Payload SHA`
line in `ARC_BINDING.md` all agree, and hard-blocks a stale shim even in CI where
the sibling repo is absent. (When the sibling repo is reachable the guard also
cross-checks the pin against the freshly generated sha, so the pin cannot silently
go stale.)

Coverage-threshold headroom is available as an explicit diagnostic: run `npm run
coverage:check && npm run guard:coverage-headroom`. It is not part of
`verify:release` until the current tree has at least two percentage points of
headroom above every enforced V8 threshold.

`verify:push:branch` runs this targeted guard-test list:
- `repo-hygiene-guard.test.ts`
- `pre-push-alignment.test.ts`
- `pre-push-guard.test.ts`
- `git-estate-guard.test.ts`
- `doc-drift-check.test.ts`
- `public-surface-drift-check.test.ts`
- `drift-skip-ci-gating.test.ts`
- `work-index.test.ts`
- `node-pin-consistency.test.ts`
- `safeguard-diagnostics.test.ts`
- `bot-errors-simulation-matrix.test.ts`
- `check-bot-errors-runtime-manifest.test.ts`
- `claude-settings-guard.test.ts`
- `agent-decision-polls-guard.test.ts`
- `fail-closed-gate-guard.test.ts`
- `check-service-units.test.ts`
- `check-instance-config.test.ts`
- `import-boundary-check.test.ts`
- `fitness-registry.test.ts`
- `tests/deploy/preflight-check.test.ts`

## Layer 3 — Discovered hygiene rules (hygiene-guard internals)

These are not documented in CI step names but the `hygiene-guard.ts` enforces:

| Rule | Pattern blocked | Allowed alternative |
|---|---|---|
| Personal phone JIDs | Real-looking phone digits | `1555\d{4,}@s.whatsapp.net` (synthetic 555-area allowlist) |
| Real group JIDs | `120363\d{6+}` (12+ digit prefix) | `120363\d{1,11}@g.us` (≤11 total digits) |
| API-key shapes | `sk-openai-...`, `sk-ant-...` in fixtures | `OPENAI_FAKE_XXX` / `ANTHROPIC_FAKE_XXX` placeholders |
| Model attribution | Model-product-name literal in UI text (see `hygiene-guard.ts` for the exact pattern set) | Paraphrase as "agent with tool access" or a generic descriptor |
| Operator-local paths | `/home/...` in fixtures | `/var/lib/wsoup/...` or generic system paths |
| Personal emails / real names | various patterns | synthetic / generic identifiers |
| Co-authored commits | `Co-Authored-By:` lines | drop entirely (public repo policy) |

## Layer 4 — Test-author quality rules (recurring failure modes)

These patterns repeatedly cause CI failures even when local `typecheck` passes. Future test-author agents MUST verify against ALL these before declaring done:

### 4a. Mock-call destructure tuple-narrowing

❌ `mockFetch.mock.calls.find(([url]: [string]) => ...)` — tuple-arity narrowing against `any[]`
✅ `(mockFetch.mock.calls as unknown[][]).find((call) => typeof call[0] === 'string' && (call[0] as string).includes('...'))`

### 4b. Empty-array initialProps inferred as `never[]`

❌ `renderHook({ items: [] })` then `rerender({ items: ['x'] })` — TS2322 string not assignable to never
✅ `renderHook({ items: [] as string[] })`

### 4c. Nullish coalesce on boolean LHS narrows RHS to never

❌ `result.current.isPending ?? result.current.isLoading` — both boolean, `??` narrows RHS
✅ `result.current.isPending || result.current.isLoading` (semantically equivalent for boolean)

### 4d. `vi.spyOn` return-type cast mismatch

❌ `qc.invalidateQueries as MockInstance<...>` — types don't overlap
✅ Capture `const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')` as named variable, use `invalidateSpy.mock.calls` directly

### 4e. `measureElement` 1-arg call when signature is 3-arg

❌ `measureElement(el)` — TS2554
✅ `measureElement(el, undefined, undefined as any)` for the unused entry+instance params

### 4f. Status-enum mismatches in fixtures

❌ `Status='offline'` when union is `'online'|'degraded'|'unreachable'`
✅ Use a valid union member, or `as Status` cast if the test is intentionally probing — or file an F-task if the enum is genuinely missing a case

### 4g. Empty cast to tuple type

❌ `mock.calls[0] as [string, RequestInit]` when source is `unknown[][]`
✅ Double-cast: `as unknown as [string, RequestInit]`

### 4h. ResizeObserver-dependent virtualizer geometry

❌ `Object.defineProperty(el, 'scrollHeight', ...)` for `@tanstack/virtual-core` viewport
✅ `Object.defineProperty(el, 'offsetWidth'/'offsetHeight', ...)` — virtual-core reads offset, not scroll/getBoundingClientRect

### 4i. Fake-timer + `--pool=forks` + `waitFor` deadlock

❌ `vi.useFakeTimers(); await waitFor(() => ...)` — `waitFor` polls real setInterval which hangs
✅ `act(async () => { vi.advanceTimersByTime(N); await Promise.resolve(); })` — manual flush
✅ OR `vi.useRealTimers()` + immediate-resolve mocks (heavy-component test pattern)

### 4j. Weak terminal assertions

❌ `expect(screen.getByText('X')).toBeDefined()` — `getBy*` throws if missing, `.toBeDefined()` adds nothing
✅ `expect(screen.getByText('X')).toBeInTheDocument()` (jest-dom) OR bare `screen.getByText('X')` (throw IS the assertion)

### 4k. Tautological negative assertions

❌ `expect(value).not.toBe(8)` paired with `expect(value).toBe(3)` — first is guaranteed by second
✅ Drop the redundant assertion

### 4l. CSS attribute-selector case mismatch

❌ `container.querySelector('[style*="borderLeftStyle"]')` — jsdom serializes inline-style as kebab-case
✅ `container.querySelector('[style*="border-left-style"]')`

### 4m. Sub-project vitest configs

Some sub-projects (e.g. `tools/whatsoup_guard/`) have their own `vitest.config.ts`. Tests there must be run from that directory — invoking `vitest` from the repo root finds no test files.

## Layer 5 — Dialog/component conventions discovered

| Convention | Rule |
|---|---|
| `aria-label="Close"` | Reserved for icon-only X-buttons (no visible text) |
| Cancel/Close/Skip text buttons | Visible text IS the accessible name — no competing aria-label |
| `<NavLink>` `isActive` callback arg | If the className/children callback IGNORES `isActive`, the link won't get aria-current applied. Use a plain `<Link>` with manual `aria-current` instead. |
| `<MessageBubble>` `pk` states | `pk === -1` is the failed-message sentinel; other `pk < 0` is optimistic-sending. UI should distinguish them. |

## Layer 6 — Edit-tool fragment-parse hook

The test-integrity PreToolUse hook ast-parses ONLY the `new_string` fragment of an Edit. Indented `it()`-body fragments without a terminal `expect()` get rejected.

**Bypass techniques** (in order of preference):
1. Include the **complete `it()` block** with terminal `expect()` in `new_string`
2. Use `Write` tool for new files (no fragment parsing)
3. Edit a larger region that captures a complete syntax unit

## Layer 7 — Peer-review safety

Peer-review agents can fabricate claims — this happened in production work (PR #563 review reversed a correct finding).

**Anti-fabrication prompts for reviewer subagents**:
- "Verify every claim against current source via direct `grep`"
- "Cite exact line numbers for each claim"
- "Verify remote HEAD via `gh pr view <num> --json headRefOid` after any push — local commits may not have reached origin"

Main thread should `grep` to spot-check whenever a reviewer claims a previously-filed F-task is invalid.

## Branch Protection

> Verified live 2026-07-22 via `gh api .../branches/main/protection` and `.../rulesets` (originally audited 2026-07-21, `WHATSOUP-CICD-AUDIT-2026-07-21`; refreshed after the R-02 approval requirement and the `merge_group` wiring). The default branch is gated by **two overlapping surfaces** — a modern ruleset *and* classic branch protection.

**Ruleset "Lock"** (id `16319133`, enforcement `active`, `bypass_actors=[]` so it binds admins), scoped to `~DEFAULT_BRANCH`, four rules:
- `deletion` — branch deletion blocked
- `non_fast_forward` — force-pushes blocked
- `required_status_checks` — `quality (24.x)` and `quality (25.x)` must pass (strict=false; branch need not be up to date)
- `pull_request` — a PR is required, **with 0 required approvals**

**Classic branch protection** (same branch) additionally requires the **`CodeQL`** check, with `strict=true` (branch must be up to date), and — since the R-02 remediation — **`required_pull_request_reviews.required_approving_review_count = 1`** with `dismiss_stale_reviews=true` (an approval does not survive later commits). Its `enforce_admins=false`, so an admin can bypass the classic surface (including CodeQL *and* the approval requirement); the ruleset still binds admins to the quality checks, the PR requirement, and the non-fast-forward/deletion blocks.

**Net effect** — a non-admin contributor must pass `quality (24.x)` + `quality (25.x)` + `CodeQL`, have an up-to-date branch, **and obtain one approving review**; `CodeQL` and the approval are admin-bypassable. **`CodeQL` has no in-repo workflow** — it is GitHub *default code-scanning setup* (state=configured; languages actions/javascript/javascript-typescript/python/typescript; weekly + PR), so it is invisible to an in-repo-only search.

⚠️ **Admin self-merge remains possible — deliberately.** R-02 closed the self-merge gap for *non-admins* by setting 1 required approval on the classic surface. It does **not** bind admins: classic `enforce_admins=false`, and the ruleset's `pull_request` rule (which does bind admins) still requires **0** approvals. So a repo admin can still merge their own PR. This is an accepted residual — raising the ruleset's approval count would block every solo merge on a single-maintainer repo. To close it fully, set the approval count on ruleset `16319133` instead.

**Merge queue — UNAVAILABLE on this repository (platform constraint).** Do not spend time trying to turn it on. GitHub's merge queue requires an **organization-owned** repository; `LucasQuiles/WhatSoup` is public but `owner.type=User`, so the `merge_queue` ruleset rule is rejected outright:

```
PUT /repos/LucasQuiles/WhatSoup/rulesets/16319133
-> HTTP 422 {"errors":["Invalid rule 'merge_queue': "]}
```

Verified 2026-07-22: rejected **both** with explicit parameters and with none, so it is not a parameter-tuning problem. It would only become available by transferring the repo to an organization.

`quality.yml` nevertheless **does** trigger on `merge_group` and exempts queue runs from `cancel-in-progress` (cancelling a queue run reports a cancelled required check and ejects the PR). That wiring is deliberately retained: it is inert while no queue exists, and it is the correct prerequisite if the repo ever moves to an org — the trigger must be on `main` *before* a queue is enabled, or every PR stalls waiting for a check that never runs.

Two constraints to respect if a queue ever becomes possible:
- `whatsoup-guard.yml` is path-filtered and must **never** be made a required context while a queue is live — a PR not touching those paths would never report it, stalling the queue.
- `CodeQL` is GitHub-managed default setup (it runs as event `dynamic`, with no in-repo workflow), so its behaviour on a `merge_group` ref cannot be configured or verified in advance. Treat enabling a queue as a canary exercise on a single low-risk PR, not a fleet-wide switch.

**Action pinning.** All external action `uses:` refs are pinned to 40-hex commit SHAs (R-03, PR #2024) — verified 14/14 pinned, 0 mutable `@vN` tags.

To inspect: `gh api repos/LucasQuiles/WhatSoup/rulesets/16319133 | jq '.rules[].type'` and `gh api repos/LucasQuiles/WhatSoup/branches/main/protection`.
To modify the ruleset: `gh api --method PUT repos/LucasQuiles/WhatSoup/rulesets/16319133 --input <json>` (PUT replaces the whole ruleset — include all existing rules or they are dropped).

## Release Runbook

To cut a release:

1. **Verify locally** — run `npm run verify:release` on the commit you intend to tag. All steps must pass.
2. **Tag** — `git tag v<version>` on the verified commit.
3. **Push tag** — `git push origin v<version>`. The `tag-release-gate` CI workflow (`.github/workflows/tag-release-gate.yml`) will run the guard subset automatically.
4. **Wait for CI** — confirm `tag-release-gate` passes in the GitHub Actions tab before publishing any release artifacts.
5. **Publish** — run `npm run verify:publish` as a final local gate, then proceed with any deployment.

Note: the `tag-release-gate` workflow does NOT run the full test suite (those run on every PR via `quality.yml`). It runs the guard-only subset: typechecks, boundary/hygiene/drift/publication guards, ESLint fitness ring, and console lint + build.

## Maintenance

> **Last audited 2026-07-21** (CI/CD & quality-controls audit, anchored to `origin/main`; the dated audit report, control registry, and remediation-readiness specs are tracked under `docs/enforcement/2026-07-21-cicd-*.md`). This checklist and `scripts/lib/fitness/registry.ts` remain the sources of truth. Refresh this checklist when the guard/CI surface drifts materially — the Branch Protection and Layer 1 sections above were the primary drift found in that audit.

When adding a new rule to this checklist:
1. **Pre-test against current code** — run the rule against `main` to identify existing violations
2. **Ship as advisory FIRST** — block-status only after existing violations are cleaned
3. **Document the bypass** — every blocking rule should have a documented escape hatch for genuine exceptions
4. **Lint-driven damage caution** — a rule that changes generated code patterns can break unrelated PRs; prefer rules that only flag, not auto-fix
