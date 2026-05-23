# Quality Guardrails — Contributor Checklist

**Purpose**: Capture the active CI/guardrail surface + recurring failure modes discovered in production work. This is the canonical reference for "what must pass before a PR can merge" and "what hand-built rules exist that aren't enforced by the typecheck or test runner alone."

## Layer 1 — CI gates (must pass for merge)

The `Quality` workflow (`.github/workflows/quality.yml`) runs all of these on every PR and on every push to `main`:

| Step | Command | Purpose |
|---|---|---|
| Typecheck | `npm run typecheck` | src/ only (tsconfig.json) |
| Typecheck scripts/ | `npm run typecheck:scripts` | scripts/ build tooling (tsconfig.scripts.json) |
| **Typecheck (all)** | `npm run typecheck:all` | **src/ + tests/ + console/src/ (tsconfig.test.json) — broader scope than `typecheck`** |
| Repo hygiene (staged) | `npm run guard:repo:staged` | hygiene-guard.ts rules — synthetic JIDs, API-key shapes, real names, etc. |
| Repo hygiene (commit-msg) | `npm run guard:repo:commit-msg <msg>` | hygiene rules on commit messages too |
| Documentation drift | `npm run guard:doc-drift` | docs ↔ code coupling check |
| Public surface drift | `npm run guard:public-surface-drift` | exported API surface stability check |
| Work index coverage | `npm run guard:work-index` | docs/work-index.json completeness |
| AskUser poll protocol guard | `npm run guard:agent-decision-polls` | Verifies the WhatsApp poll decision protocol remains wired across prompt guidance, MCP schema descriptions, sandbox diagnostics, docs, and release gates. |
| **Test integrity baseline check** | `npm run guard:test-integrity` | Runs the baseline check for tautologies, weak assertions, raw sleeps, and assertion-free tests when the plugin is installed; skips missing-plugin cases only outside CI and when `WHATSOUP_REQUIRE_TEST_INTEGRITY` is not set. GitHub Actions installs the private `LucasQuiles/test-integrity` plugin over SSH using the `TEST_INTEGRITY_DEPLOY_KEY` secret (read-only deploy key on `LucasQuiles/test-integrity`) before running this gate. |
| Repo-hygiene tests | `npm test -- tests/scripts/repo-hygiene-guard.test.ts` | tests that the hygiene-guard itself works |
| Full test suite | `npm test -- --pool=forks` | vitest with --pool=forks for stability |
| Console build | `npm --prefix console run build` | Vite production build smoke |

## Layer 2 — Local pre-push guards

Pre-push hook routes through `scripts/pre-push-guard.ts`:

| Push target | Composite script | Required checks |
|---|---|---|
| Branch push | `npm run verify:push:branch` | repo hygiene staged smoke, doc drift guard, public-surface drift guard, work-index guard, node-pin guard, Claude settings guard, AskUser poll protocol guard, `npm run typecheck`, and the targeted guard test list below |
| `main` or release tag push | `npm run verify:release` | release repo hygiene, full publication audit, doc drift guard, public-surface drift guard, work-index guard, node-pin guard, Claude settings guard, AskUser poll protocol guard, test-integrity baseline, `tools/whatsoup_guard` install/typecheck/test, console dependency install, `npm run typecheck:all`, full Vitest suite with `--pool=forks`, and console production build |

`verify:push:branch` runs this targeted `tests/scripts/` list:
- `repo-hygiene-guard.test.ts`
- `pre-push-guard.test.ts`
- `doc-drift-check.test.ts`
- `public-surface-drift-check.test.ts`
- `drift-skip-ci-gating.test.ts`
- `work-index.test.ts`
- `node-pin-consistency.test.ts`

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

## Maintenance

When adding a new rule to this checklist:
1. **Pre-test against current code** — run the rule against `main` to identify existing violations
2. **Ship as advisory FIRST** — block-status only after existing violations are cleaned
3. **Document the bypass** — every blocking rule should have a documented escape hatch for genuine exceptions
4. **Lint-driven damage caution** — a rule that changes generated code patterns can break unrelated PRs; prefer rules that only flag, not auto-fix
