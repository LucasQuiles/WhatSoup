# Fleet Charts — Standard Operating Protocol

> **HISTORICAL — superseded by PR #310 (WS ticket + rotatable tokens) and PR #287 (HTTP API token auth). For current operator commands see `docs/runbook.md` and `docs/runbooks/`. Examples below referencing `~/.config/whatsoup/fleet-token` or `/ws?token=...` reflect the pre-rotation design and should not be used as guidance.**

**Status:** deferred — inherits from parent epic `docs/sdlc/closed/fleet-charts-20260407/` (Phase 4-Execute incomplete, 11 beads unimplemented).

> **Applies to:** All agents and contributors implementing the Fleet Charts Expansion
> **Authority:** Design spec at `docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md`

---

## 1. Execution Protocol

### 1.1 Task Execution Order

Execute tasks strictly in the order defined by the implementation plan. The dependency chain is:

```
1 → 2 → 3 → 4 → 5 → (backend complete) → 6 → 7 → 8,9,10 → 11
```

Do not start a task until its predecessor is committed and passing. Tasks 8, 9, and 10 may run in parallel after Task 7 is complete, but only if working in separate worktrees or on separate files.

### 1.2 TDD Cycle

Every task follows the red-green-commit cycle:

1. **Write the test first.** The plan provides exact test code. Copy it, adapt if the surrounding code has changed, but do not skip it.
2. **Run the test and confirm it fails.** Read the failure message. If it fails for the wrong reason (import error, missing dependency, syntax error), fix the test setup before proceeding.
3. **Write the minimum implementation** to make the test pass. Do not add features, handle edge cases not covered by the test, or refactor surrounding code.
4. **Run the test and confirm it passes.** If it fails, fix the implementation — do not modify the test to make it pass.
5. **Run the full test suite** (`npx vitest run --pool=forks`) to verify no regressions.
6. **Commit.** Use the commit message provided in the plan. One commit per task.

### 1.3 Verification Before Commit

Before every commit, run these checks. All must pass.

**Backend tasks (1-5):**
```bash
cd /home/q/LAB/WhatSoup
npx vitest run --pool=forks          # all backend tests
npm run typecheck                     # TypeScript check
```

**Frontend tasks (6-11):**
```bash
cd /home/q/LAB/WhatSoup/console
npx eslint src/ --max-warnings 0     # zero ESLint violations
npx tsc --noEmit                     # TypeScript check
npm run build                        # production build
```

Do not commit if any check fails. Fix the issue first.

### 1.4 Pre-Commit Hook

The project has a husky pre-commit hook that runs `lint-staged`. For frontend files, this executes `eslint --max-warnings 0` on all staged `.ts/.tsx` files. If you touch a file that has pre-existing violations (there should be none after the design system cleanup, but verify), you must fix all violations in that file before committing.

If the hook blocks your commit, do not bypass it with `--no-verify`. Fix the violations.

### 1.5 Branch Strategy

Create a feature branch before starting:

```bash
cd /home/q/LAB/WhatSoup
git checkout -b feat/fleet-charts
```

Or use a worktree for isolation:

```bash
git worktree add ../WhatSoup-fleet-charts -b feat/fleet-charts
```

Commit to this branch throughout. Merge to main only after all 11 tasks are complete and verified.

---

## 2. Code Standards

### 2.1 Backend (TypeScript/Node)

- **No build step.** The backend uses Node 23.10's native `--experimental-strip-types`. Write TypeScript directly — no `tsc` compilation.
- **ESM throughout.** Use `import`/`export`, not `require`. File extensions in imports: `.ts` in source, `.js` in the transpiled output path (the strip-types loader handles this).
- **Zod for validation** where input is external. Internal function arguments rely on TypeScript types.
- **Pino for logging.** All structured logs use the existing Pino logger. Do not use `console.log`.
- **SQLite is synchronous.** The project uses `node:sqlite` (`DatabaseSync`). All DB operations are synchronous — no `async`/`await` for database calls.
- **Tests use real SQLite.** Create `:memory:` databases in tests, run real migrations, insert real data. Do not mock the database.

### 2.2 Frontend (React/TypeScript/Tailwind)

- **Design system tokens only.** No hardcoded colors, font sizes, spacing, or border radii. Use CSS custom properties from `index.css` or Tailwind utility classes that reference them. The ESLint config enforces this — if it compiles but ESLint rejects it, the ESLint rule is correct.
- **Typography rule:** Monospace (`font-mono`) for all data values (numbers, IDs, timestamps, statuses). Sans-serif (`font-sans`) for all UI chrome (headings, labels, button text, descriptions). No exceptions.
- **Icon sizing:** Inline button icons: `size={15} strokeWidth={1.75}`. Empty state icons: `size={40} strokeWidth={1.25}`. Navigation icons: `size={18} strokeWidth={1.75}`.
- **Component classes over inline styles.** Use CSS component classes from `index.css` (`c-btn`, `c-card`, `c-input`, `c-section`, etc.) rather than inline `style={{}}` objects. Inline styles are only acceptable for truly dynamic values computed from state/props.
- **`type="button"` on all `<button>` elements** not inside a `<form>`. ESLint enforces this.
- **Recharts for charts.** The project uses Recharts 3.x. Do not introduce a different charting library.
- **Framer Motion for animations.** Page transitions and list staggers use framer-motion. CSS transitions are used for hover/focus states.

### 2.3 Commit Messages

Use conventional commits. The plan provides exact commit messages for each task. Follow them.

```
feat(backend): add agent_token_events table and ended_at column (migration 18)
feat(backend): add token event writer and session lifecycle tracking
feat(backend): extend metrics collector with token and session metrics
feat(backend): add bucket densification and extended db-reader
feat(backend): extend fleet and per-line metrics API routes
feat(console): add fleet chart types, chart-utils, and sparkline extensions
feat(console): add ChartPanel wrapper component
feat(console): add media series to FleetMetricsChart
feat(console): add FleetTokenChart component
feat(console): add FleetSessionChart component
feat(console): integrate fleet charts into SoupKitchen page
```

---

## 3. Communication Protocol

### 3.1 Blocking Issues

If you encounter a blocker — a test that cannot pass, a schema assumption that's wrong, a dependency that doesn't exist — do not work around it silently. Report it with:

1. **What you tried** — the exact command, the exact error
2. **What you expected** — based on which plan step or spec section
3. **What actually happened** — the full error output
4. **Your assessment** — is this a plan bug, a spec bug, or an environmental issue?

### 3.2 Spec Deviations

The design spec is the source of truth. If you need to deviate from it:

1. **Document the deviation** — what changed and why
2. **Verify the deviation doesn't break downstream tasks** — check if later tasks depend on the original behavior
3. **Update the spec** — commit the spec change alongside the code change

Do not silently deviate. A "working" implementation that doesn't match the spec is a bug, even if it's arguably better.

### 3.3 Scope Creep

If you notice an improvement opportunity while implementing (better error handling, a refactor that would make the code cleaner, an edge case the spec missed):

- **If it's in the plan step you're working on:** Include it.
- **If it's in a different file or task:** Note it, finish your current task, then assess whether it's blocking or deferrable.
- **If it's a new feature:** Do not implement it. Note it as a follow-up.

The spec's "Out of Scope" section (section 13) lists known follow-ups that were deliberately excluded.

---

## 4. Quality Gates

### 4.1 Per-Task Gate

After each task, verify:
- [ ] Test passes (the one you wrote in step 1)
- [ ] Full test suite passes (`npx vitest run --pool=forks` for backend)
- [ ] TypeScript compiles (`npm run typecheck` or `npx tsc --noEmit`)
- [ ] ESLint passes (frontend only: `npx eslint src/ --max-warnings 0`)
- [ ] Commit is clean (no untracked files, no unstaged changes)

### 4.2 Backend Completion Gate (after Task 5)

Before starting frontend work:
- [ ] All 5 backend tasks committed
- [ ] Full backend test suite passes
- [ ] Fleet server restarts cleanly: `systemctl --user restart whatsoup-fleet.service`
- [ ] API returns new fields: `curl -s -H "Authorization: Bearer $(cat ~/.config/whatsoup/fleet-token)" http://localhost:9099/api/metrics?range=24h | python3 -m json.tool | head -30`
- [ ] Response includes `meta`, `tokenUsage`, `sessionActivity` keys
- [ ] `meta.hasMessageData` is `true` (instances have message history)

### 4.3 Frontend Completion Gate (after Task 11)

- [ ] `npx eslint src/ --max-warnings 0` — 0 violations
- [ ] `npx tsc --noEmit` — 0 type errors
- [ ] `npm run build` — succeeds
- [ ] Fleet server rebuilt and restarted
- [ ] Visual verification: Soup Kitchen shows 3 charts in a row
- [ ] Visual verification: Range picker switches between 24h/7d/30d
- [ ] Visual verification: KPI click expands associated chart
- [ ] Visual verification: KPI click on same card collapses back to 3-up
- [ ] Visual verification: Sparklines appear on Messages Sent, Messages Received, Agent Sessions, Media Processed KPI cards

### 4.4 Final Gate

- [ ] All per-task gates passed
- [ ] Backend and frontend completion gates passed
- [ ] No TODO/FIXME comments introduced
- [ ] No `console.log` in committed code (use Pino logger for backend, remove debug logs from frontend)
- [ ] No `any` types introduced (use proper typing)
- [ ] Design spec updated if any deviations were made

---

## 5. Rollback Procedure

If a deployment causes issues:

1. **Backend migration is forward-only.** Migration 18 adds a table and a column — both are additive. The existing code does not reference `agent_token_events` or `ended_at`, so the schema changes are safe even if the new code is reverted.

2. **Frontend can revert independently.** The console is a static SPA served by the fleet server. Reverting the `console/dist/` build to a previous version restores the old UI immediately.

3. **Metric collection is append-only.** New metrics (`agent_tokens_in`, etc.) are written to `metrics_hourly` alongside existing ones. The existing collector continues to write `messages_in/out/media` regardless of the new metrics. Reverting the collector code simply stops writing the new metrics — existing data is unaffected.

4. **API changes are additive.** The new response fields (`tokenUsage`, `sessionActivity`, `meta`) are added to the existing response. Old clients that don't read these fields are unaffected.
