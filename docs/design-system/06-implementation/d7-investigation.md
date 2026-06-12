# D7 Investigation Packet — deterministic viewport + computed-box browser tests (DD-10 / DD-18r deterministic-tests leg)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict.
Source survey: `docs/design-system/06-implementation/d7-survey.md` (2026-06-12, verdict
GO) — its load-bearing claims re-verified against the impl tree for this packet
(HEAD-committed state, `8ca44a4f`; the b2/b3 falsification bar applied). **Two survey
claims falsified, one package name corrected** (§0.1, §0.2, §0.6). Targets: DD-10
(computed-box ≥24px proof for every interactive primitive), the DD-18r
deterministic-viewport-tests leg, drawer 900px squeeze proof, focus-ring visibility
proof, and honesty-label upgrades for the jsdom suites that currently carry
INCONCLUSIVE markers.

## 0. Scope confirmation (survey candidate shape → confirmed with corrections)

1. **Tooling availability — survey claim FALSIFIED, recommendation survives.** The
   survey states "vitest 3.2.6 with @vitest/browser already in the lockfile." Verified
   against `git show HEAD:package-lock.json`: **no `@vitest/browser` package exists in
   the lockfile** (no `node_modules/@vitest/browser` entry; no playwright entry
   anywhere). What the lockfile actually contains is vitest 3.2.6 declaring
   `@vitest/browser: 3.2.6` as an **optional peer dependency** — nothing is installed.
   The claim is wrong as written but the falsification is friendly: the peer pin gives
   the exact compatible version. Dependency additions (root `package.json`,
   devDependencies, exact pins):
   - `@vitest/browser@3.2.6` — peer-pinned to the installed vitest exactly; its own
     deps (`@testing-library/dom ^10.4.0`, `@vitest/mocker 3.2.6`) are satisfied by /
     consistent with the root tree (root already carries `@testing-library/dom ^10.4.1`).
   - `playwright@1.60.0` — the provider peer (`peerDependencies.playwright: "*"`,
     optional). Engines `node >=18`: compatible with the repo's Node 24 pin and the CI
     24.x/25.x matrix. Pinned EXACT (no caret) — the pin is the version-skew defense
     (§6.9).
   - `vitest-browser-react@1.0.1` — render entrypoint for browser mode. Verified
     against the registry: 1.0.1 peers `vitest ^2.1||^3||^4-0` + `@vitest/browser
     ^2.1||^3`; the current 2.x line requires vitest ^4 and is NOT usable. A vitest 4
     upgrade was considered and rejected: it would ride the entire repo suite
     (132 console test files + server tests) for a test-infra slice — out of
     proportion.
   - `tailwindcss@4.2.2` + `@tailwindcss/vite@4.2.2` — required at root so the browser
     vite server can process `console/src/index.css` (`@import "tailwindcss"`); see
     item 3 for why the console's own plugin set cannot be reused.
2. **Package name corrected:** the survey says "@playwright/test not installed (trivial
   add)." `@playwright/test` is Playwright's own test runner — installing it would add
   a second runner and contradict the survey's own "single runner" recommendation. The
   package @vitest/browser's playwright provider needs is **`playwright`** (the
   library). Trivial add stands; the name does not.
3. **Config split discovered (not in the survey): root vitest runs vite 7, console
   runs vite 8.** Root lockfile: vitest 3.2.6 depends on `vite ^5||^6||^7` and resolves
   `vite@7.3.5`. Console lockfile: `vite@8.0.11`, `@vitejs/plugin-react@6.0.1` (peer
   `vite ^8.0.0` — INCOMPATIBLE with the root's vite 7), `@tailwindcss/vite@4.2.2`
   (peer `^5.2||^6||^7||^8` — compatible). Consequence: the browser-mode config CANNOT
   import the console's `vite.config.ts` or its react plugin. Resolution: the browser
   config follows the root `vitest.config.ts` precedent — **esbuild JSX transform, no
   @vitejs/plugin-react** (already proven by 132 console component test files running
   under root vitest today), plus `@tailwindcss/vite` at root (vite-7-compatible) for
   the CSS pipeline. No console-side config is touched.
4. **CI claim VERIFIED.** `.github/workflows/quality.yml`: `runs-on: ubuntu-latest`,
   Node matrix `['24.x', '25.x']`, root `npm ci` runs before the test suite and the
   console install (`npm --prefix console ci`) runs after — so a browser-test step
   placed after "Test suite" needs only root devDependencies. Headless chromium on
   ubuntu requires `npx playwright install --with-deps chromium` (system libraries).
5. **"No scripted browser tests exist anywhere today" — VERIFIED.** No
   `@vitest/browser`/playwright in either lockfile; `tools/whatsoup_guard/vitest.config.ts`
   is a node-environment guard suite; all 132 `tests/console/*` files run under jsdom
   via per-file `@vitest-environment jsdom` pragmas.
6. **DD-10 Pill claim DISENTANGLED — the survey conflates two different mechanisms.**
   The survey names "the removable-Pill pseudo-element hit area." Verified against
   `console/src/styles/primitives.css`:
   - The pseudo-element hit-area expansion exists on the **sm INTERACTIVE pill**, not
     the removable variant: `button.soup-pill--sm::before` /
     `.soup-pill--sm.soup-pill--interactive::before` (lines 486–491) — `inset:
     calc(-1 * var(--sp-0h)) 0`, i.e. 20px visual + 2×3px ≥ 24px vertical target.
     `elementFromPoint` probing is the right technique here (pseudo-elements hit-test
     as their originating element; the rect alone reads 20px).
   - The **removable pill's remove button has NO expansion mechanism.**
     `.soup-pill__remove.soup-actbtn` (lines 546–553) forces `min-height: 16px;
     min-width: 16px; padding: 0` with negative horizontal margins. The CSS comment
     claims "Padded to 24px visual hit area via negative margin trick" — **the code
     does not implement what the comment claims**: negative margins shrink the layout
     footprint, they do not expand the target; the rendered box computes ~16×16 (X icon
     is 12px). The D7 measurement is expected to **FAIL** this case. The debt register
     row already anticipates the pair ("incl. sm pill + removable X"). Remediation
     pre-decided as C-D7-2 (§13): a pseudo-element expansion band mirroring the sm-pill
     precedent, landed in the same slice so the suite ships green and DD-10's
     expiration condition is met honestly — not by skipping the case.
7. **No-backend strategy — DECIDED: component/route mounts with the established
   hoisted-mock harness; no console dev server; no app mock mode.** Full analysis in
   §0.8; this is the packet's load-bearing design decision.
8. **How the app behaves with no backend (investigated, drives §0.7).**
   `console/vite.config.ts` proxies `/api` (and `/api/lines` with SSE handling +
   per-request token auth via `vite.proxy-auth.ts`) to `http://127.0.0.1:9099`. With no
   fleet server: proxied requests fail (502/ECONNREFUSED). `console/src/lib/api.ts` has
   a **mock-data fallback**: `mockFallbackEnabled()` returns true in any non-PROD
   build, auto-activating mock data when the fleet probe or an API call fails
   (production requires `VITE_MOCK_MODE=1`). Additionally `RealtimeProvider`
   (`console/src/hooks/use-websocket.tsx`) opens a WebSocket with exponential-backoff
   reconnect timers. Three candidate strategies were evaluated:
   - **(a) Drive the real dev server + mock fallback — REJECTED.** The fallback is
     failure-triggered: every case pays a failed probe/request before data appears
     (ordering and timing nondeterminism, React Query `retry: 1` delays); the mock
     dataset is a fixed demo corpus, not per-case fixtures (no long-name line, no
     ≥20-chat list, no MCP-mode line on demand); the WebSocket reconnect loop runs
     timers for the whole session; and the test would depend on a second server
     process whose lifecycle nobody in the runner owns.
   - **(b) `VITE_MOCK_MODE=1` build + static serve — REJECTED.** Same fixture problem
     as (a), plus a build step per run and zero per-test data control.
   - **(c) CHOSEN: vitest browser mode mounts components/routes directly**
     (`vitest-browser-react` render) **with the same hoisted `vi.mock` harness the
     jsdom suites use** (proven pattern: `tests/console/line-detail-tabs.test.tsx`
     stubs `hooks/use-fleet`, `hooks/use-metrics`, `lib/api`, `react-router-dom`
     params, lazy `RelinkModal`, wrapped in MemoryRouter + QueryClientProvider +
     ToastContext). Module mocking works in browser mode via `@vitest/mocker`, which
     ships as a dependency of `@vitest/browser@3.2.6` (verified in its registry
     manifest). Zero network: the harness stubs every data hook AND `lib/api`;
     `RealtimeProvider`/`use-websocket` is stubbed at module level so no socket ever
     opens. Vitest owns its own vite server for serving test modules (no console dev
     server, no proxy config, no 9099 dependency — the proxy implication dissolves
     entirely). A setup-file **network sentinel** patches `window.fetch` and
     `WebSocket` to throw loudly on any `/api`/`/ws` access, so an unmocked path fails
     the test with a named cause instead of silently exercising the mock-fallback.
     No dedicated test-entry/fixture **page** is needed — per-test mounts ARE the
     fixture pages, with full CSS (item 9).
9. **CSS fidelity requirements (new facts the survey did not cover):** computed-box
   tests are only as honest as the stylesheet pipeline. The browser config must
   (a) process `console/src/index.css` (tailwind v4 plugin — item 1/3); (b) serve the
   self-hosted Geist woff2 (`publicDir: 'console/public'`; `fonts.css` references
   `/fonts/...`) and await `document.fonts.ready` in setup — self-hosted fonts make
   text metrics identical on macOS-local and ubuntu-CI; (c) neutralize entry animations
   deterministically via the playwright context option `reducedMotion: 'reduce'`
   (the global reduced-motion CSS policy then renders end-states instantly — D7
   asserts geometry, never motion, so this is honest).
10. **Out of scope:** visual screenshot diffing — deferred WITH REASON: it requires
    baseline image management plus cross-platform rendering tolerance (font
    antialiasing, scrollbar chrome differ macOS↔ubuntu), the highest-flake test class,
    and every D7 proof obligation (boxes, flips, overflow, rings) is expressible as a
    geometry/computed-style assertion that needs no pixel baseline. Perf testing — not
    a D7 obligation. Both stay manual-QA territory; revisit only if a future obligation
    is genuinely un-assertable as geometry.

## 1. Gate 0 output

PLACEHOLDER — integrator fills at dispatch: worktree/branch state, origin/main delta +
merge, post-merge lint + test counts, worktree inventory. Notes for the integrator at
packet-writing time (2026-06-12, `soup-impl` @ `8ca44a4f`, branch
`feat/soup-v3-foundation`):

- **B3-wave work is in flight in `soup-impl`**: `Modal.tsx`, `Inbox.tsx`,
  `SoupKitchen.tsx`, `RelinkModal.tsx`, `CreateGroupModal.tsx`, `primitives.css`,
  `tokens.component.css` modified; `SaveContactDialog.tsx` untracked. D7's
  implementation files (root configs, `tests/browser/` subtree, CI workflow) do not
  overlap, but the **honesty-label edits** (§3) touch `tests/console/*` files and the
  C-D7-2 fix touches `primitives.css` — dispatch after the in-flight commits land, or
  accept a rebase on those two surfaces.
- **B4 has not landed** (packet `Ready with Constraints`; Inbox has no collapse logic
  at HEAD). The Inbox viewport rows are SEQUENCED behind B4 (§7, C-D7-4).
- **DD-23/DD-24 are proposed, not yet filed** in the register (B2/B4 acceptance
  pending) — §12 dependency note.

## 2. frontend-design pre-implementation checkpoint

This is a test-infrastructure slice: **zero intended visual change**, with one
exception and one nuance.

- **Exception (C-D7-2):** the removable-Pill remove-button hit-area fix is a
  pseudo-element band — invisible by construction (transparent expanded target,
  sm-pill precedent at `primitives.css:486`). The false CSS comment at line 550 is
  corrected in the same diff. PASS expected; glance at the live checkpoint that chip
  rows (TagInput, picker chips) did not gain spacing side effects, since the existing
  negative margins interact with the new band's geometry. INCONCLUSIVE until that
  glance.
- **Nuance:** browser tests will render both themes only where a proof obligation
  needs it (focus-ring visibility reads `--focus-ring` resolution per theme — §8.4);
  D7 adds no theme surface of its own.
- Density/motion/tokens: untouched. PASS by construction.

Checkpoint verdict: PASS with one INCONCLUSIVE row (chip-row spacing after C-D7-2) —
resolved at the live checkpoint mid-slice.

## 3. Files inspected and classification

Verification evidence (run 2026-06-12 against `soup-impl` HEAD `8ca44a4f`):

- `git show HEAD:package-lock.json` → no `@vitest/browser`, no `playwright` entries;
  vitest 3.2.6 with optional peer `@vitest/browser: 3.2.6`; root `vite@7.3.5`.
  **Survey lockfile claim FALSIFIED (§0.1).**
- `git show HEAD:console/package-lock.json` → `vite@8.0.11`,
  `@vitejs/plugin-react@6.0.1` (peer vite ^8), `@tailwindcss/vite@4.2.2` (peer
  ^5.2||^6||^7||^8). **Vite split confirmed (§0.3).**
- `npm view @vitest/browser@3.2.6` → peers playwright `*` (optional), vitest `3.2.6`;
  deps include `@vitest/mocker 3.2.6`. `npm view playwright` → 1.60.0, node ≥18.
  `npm view vitest-browser-react` → 2.2.0 needs vitest ^4; 1.0.1 supports vitest ^3.
- `grep -rn "INCONCLUSIVE" tests/` → the honesty-label inventory in the table below.
- `primitives.css` 445–553 (Pill band), 1175–1250 (Drawer band incl.
  `@container (min-width: 900px)` squeeze), `composites.css` focus-visible recipes,
  `SoupKitchen.tsx:720` (`flex-col lg:flex-row` Fleet stacking — tailwind `lg` =
  64rem = 1024px, viewport-driven, browser-testable via `page.viewport`).

| File | Class | Current invariant | D7 invariant | Changes? |
|---|---|---|---|---|
| `package.json` / `package-lock.json` | config | no browser tooling | + 5 devDeps (§0.1, exact pins for @vitest/browser + playwright); + `test:browser` script (`vitest run --config vitest.browser.config.ts`) | YES |
| `vitest.config.ts` | config (producer) | `include: tests/**/*.test.ts(x)` — would swallow a browser subtree into jsdom/node runs | + `exclude: ['tests/browser/**']` (one line; everything else byte-identical) | YES |
| `vitest.browser.config.ts` | config (NEW) | does not exist | browser-mode config: esbuild JSX + root-alias block shared with the base config via `mergeConfig` import, `@tailwindcss/vite` plugin, `publicDir: 'console/public'`, `test.include: tests/browser/**`, `browser: { enabled, provider: 'playwright', headless, instances: [{ browser: 'chromium' }] }`, `providerOptions.context.reducedMotion: 'reduce'`, `fileParallelism: false`, `screenshotFailures: true`, setup file | NEW |
| `.github/workflows/quality.yml` | CI | no browser step; console deps installed after tests | + playwright browser cache (keyed on lockfile playwright version) + `npx playwright install --with-deps chromium` + `npm run test:browser` placed after "Test suite" (root deps suffice, §0.4) + `actions/upload-artifact` of the failure-screenshot dir with `if: failure()` | YES |
| `tests/browser/setup.ts` | fixture (NEW) | — | `document.fonts.ready` await; network sentinel (fetch/WebSocket throw on `/api`, §0.8c) | NEW |
| `tests/browser/harness.tsx` | fixture (NEW) | — | shared providers + route-mount helper porting the line-detail-tabs hoisted-mock pattern (documented deviation from per-file factories, §5) | NEW |
| `tests/browser/computed-box.test.tsx` | evidence (NEW) | — | DD-10 suite (§8.1) | NEW |
| `tests/browser/viewport-matrix.test.tsx` | evidence (NEW) | — | surface × viewport suite (§8.2) | NEW |
| `tests/browser/drawer-squeeze.test.tsx` | evidence (NEW) | — | 900px container flip (§8.3) | NEW |
| `tests/browser/focus-ring.test.tsx` | evidence (NEW) | — | focus-ring visibility (§8.4) | NEW |
| `console/src/styles/primitives.css` | producer | `.soup-pill__remove` 16px min + false comment (550) | C-D7-2 pseudo-element hit-area band + comment corrected | YES |
| `tests/console/primitives-drawer.test.tsx` | honesty upgrade | INCONCLUSIVE: squeeze flip not testable in jsdom (lines 20, 382–383) | label points at `tests/browser/drawer-squeeze.test.tsx`; jsdom cases unchanged | YES (comments) |
| `tests/console/primitives-table.test.tsx` | honesty upgrade | INCONCLUSIVE: computed overflow/ellipsis (22, 356) | label points at the viewport-matrix truncation cases | YES (comments) |
| `tests/console/primitives-button.test.tsx` | honesty upgrade | "class contract since jsdom does not compute … heights" (70–75) | label points at the computed-box suite | YES (comments) |
| `tests/console/line-detail-tabs.test.tsx` | honesty upgrade | "class-only; box metrics are D7" (246), governed x-scroll class contract (219) | labels point at viewport-matrix LineDetail cases | YES (comments) |
| `tests/console/soup-kitchen.test.tsx` | honesty upgrade | "requires visual QA" truncation note (1039) | label points at viewport-matrix Fleet cases | YES (comments) |
| `tests/console/primitives-popover.test.tsx` | honesty upgrade | max-height/scroll "class-level, noted" (21) | label points at the computed-box popover case | YES (comments) |
| `tests/console/primitives-log-stream.test.tsx` | NOT upgraded | aria-live reorder semantics INCONCLUSIVE (314) | unchanged — announcement semantics are not a geometry fact; D7 does NOT claim it (named non-goal) | NO |
| `console/vite.config.ts`, console package files | out of scope | dev-server proxy to 9099 | untouched (§0.8c) | NO |
| `docs/design-system/06-implementation/design-debt-register.md` | register | DD-10 open, DD-18r open | deltas per §12 | YES |

**Exact new files:** `vitest.browser.config.ts`, `tests/browser/setup.ts`,
`tests/browser/harness.tsx`, `tests/browser/computed-box.test.tsx`,
`tests/browser/viewport-matrix.test.tsx`, `tests/browser/drawer-squeeze.test.tsx`,
`tests/browser/focus-ring.test.tsx`, `d7-evidence.md` (at acceptance), this packet.
The Inbox collapse file (`tests/browser/inbox-collapse.test.tsx`) is named here but
lands as a B4-sequenced follow-up commit (C-D7-4). Any file beyond this table is added
here before commit.

## 4. Patterns to replace

(a) **INCONCLUSIVE-by-tooling honesty labels** — six jsdom files assert class contracts
and explicitly disclaim box/flip/overflow proof. Replaced by: jsdom contract layer
KEPT (fast, deterministic, runs everywhere) + browser computed layer ADDED + each
disclaimer comment rewritten to point at the browser case that resolves it (the
survey's upgrade-not-replace rule, confirmed correct).
(b) **Manual-session-only responsive QA** — the qa-hardening fallback (manual
observations as durable record) for viewport behavior. Replaced by the deterministic
matrix for the obligations it can express; manual QA remains for visual/judgment rows.
(c) **A hit-area contract that is false in code** — the removable-X 16×16 box behind a
comment claiming 24px (C-D7-2).
(d) **Nothing else** — no production component logic changes in this slice.

## 5. Fixture and data review

- **Harness:** the jsdom convention is per-file factories; D7 deviates with ONE shared
  `tests/browser/harness.tsx` because every page-level browser test needs the identical
  provider stack + module-mock set (MemoryRouter, QueryClientProvider, ToastContext,
  stubbed `use-fleet`/`use-metrics`/`lib/api`/`use-websocket`/lazy modals — inventory
  ported from `line-detail-tabs.test.tsx`). Recorded as a documented interpretation:
  page mounts are integration fixtures, not unit factories. Per-case DATA fixtures stay
  per-file (convention kept).
- **vi.mock-in-browser-mode proof obligation:** module mocking in browser mode rides
  `@vitest/mocker` (ships with @vitest/browser — §0.8c). This is dependency-verified
  but not yet locally executed; Task 1 is a smoke test (mount LineDetail with the
  ported harness, assert one tab box) BEFORE any suite is built — fail-fast gate on
  the whole approach (C-D7-1).
- **Data fixtures needed:** long-name line (≥40 chars — LineDetail h1 truncation);
  MCP-capable line (9-tab row — widest tab strip for x-scroll at 390); ≥20-chat Inbox
  list (post-B4); long message + outgoing bubble (post-B4 hover-card edges, if pulled
  in); KPI/metrics stub for Fleet (Fleet page renders charts — `recharts` resolves
  from root aliases already).
- **Primitive mounts** (computed-box suite) need no harness: primitives are
  presentational; mount directly with minimal props inside a positioned container so
  `elementFromPoint` coordinates are stable.
- **Fonts:** `document.fonts.ready` await in setup (§0.9) — width-sensitive assertions
  (truncation, overflow) are otherwise racy against late Geist swap-in.

## 6. Reliability answers (each becomes code, test, rule, DD, or non-goal)

1. **Flake policy — no sleeps, ever:** assertions use @vitest/browser's auto-retrying
   `expect.element` / `expect.poll` (locator-based, built-in polling); reveal/measure
   sequencing waits on those, not timers; `document.fonts.ready` awaited once in
   setup; entry animations neutralized via `reducedMotion: 'reduce'` context (§0.9) so
   geometry is end-state on first paint. Fake timers are NOT used in browser suites
   (they fight the real event loop); anything needing timer control stays in the jsdom
   layer. → rule in setup + config; test-integrity scan must pass on the new subtree.
2. **Dev-server lifecycle ownership:** vitest browser mode starts and owns its own vite
   server per run — no `npm run dev`, no proxy, no port-9099 dependency, nothing for CI
   to start or tear down. The console dev server and its `/api` proxy are simply not in
   the execution path (§0.8c). → config by construction; documented rule.
3. **Parallelism/determinism:** `fileParallelism: false` + a single chromium instance —
   one browser, files sequential (the survey's "deterministic with single-worker"
   confirmed as config reality). Viewport is set explicitly per test/`beforeEach`
   (`page.viewport(w, h)`), never inherited across cases. Estimated cost at this scale
   (≈4 suites) fits the survey's +30–60s; revisit parallel instances only if runtime
   triples. → config + rule.
4. **What a CI failure looks like:** vitest reports the failing assertion with measured
   numbers (rects/computed styles — self-explanatory failure text);
   `screenshotFailures: true` writes a PNG per failure; the workflow uploads the
   screenshot directory as an artifact `if: failure()`. No video/trace machinery this
   slice (screenshot + numeric assertion suffices for geometry). → CI config.
5. **Local↔CI browser version skew:** `playwright` pinned EXACT in devDependencies;
   `npx playwright install chromium` resolves the chromium build from the installed
   playwright version — local and CI download the same build by construction. Residual
   OS-level deltas: fonts (eliminated — self-hosted Geist, §0.9) and scrollbar chrome
   (ubuntu classic vs macOS overlay) — overflow assertions therefore compare
   `scrollWidth` vs `clientWidth` on the SAME element (both sides scrollbar-adjusted in
   the same environment) and never assert absolute page widths. → rule + technique.
6. **Unmocked network path:** the setup sentinel throws a named error on any
   `/api`/WebSocket access (§0.8c) — a missing stub fails loudly at the call site
   instead of nondeterministically exercising the dev-mode mock fallback in
   `lib/api.ts`. → code (setup) + negative test (sentinel itself is tested).
7. **CI minutes / footprint:** chromium download ~170MB mitigated by an actions cache
   keyed on the playwright version; the step runs on BOTH matrix legs (24.x/25.x) —
   the engines range applies to test tooling too; if budget pressure appears, dropping
   to one leg is a one-line change recorded then, not silently now. → CI config +
   documented rule.
8. **Suite half-life as components migrate (B3/B4 in flight):** browser suites bind to
   primitives and stable page anatomy (roles, soup-* classes), not to WIP dialog
   internals; the Inbox suite is explicitly sequenced behind B4 (C-D7-4). → sequencing
   rule.
9. **Container vs viewport queries:** the drawer flip is a CONTAINER query — viewport
   resizing alone cannot prove it; the squeeze suite drives a width-controlled wrapper
   (899px/900px) instead. Conversely Fleet stacking is a VIEWPORT media query
   (`lg:` = 1024px) — proven via `page.viewport` at 1023/1024. Mixing these up would
   produce vacuously-green tests. → technique, encoded per case in §8.

## 7. Responsive decision note

The viewport matrix is 390/768/1024/1280/1440 wide (heights fixed for determinism:
390×844, 768×1024, 1024×768, 1280×800, 1440×900) plus the short-height 1440×500 row —
the exact set the C2.3/B1 live QA used, now deterministic. Boundary probes are added at
the two flip points: 1023/1024 (tailwind `lg`, Fleet stacking) and 899/900 (drawer
container squeeze — driven by wrapper width, not viewport, §6.9). Surfaces × matrix:

- **Fleet (SoupKitchen):** stacking flip (`flex-col` ↔ `lg:flex-row`,
  `SoupKitchen.tsx:720`) — computed `flex-direction` per side of 1024; no horizontal
  page overflow at every width; 1440×500 → page scrolls (scrollHeight >
  clientHeight) with the KPI band reachable.
- **LineDetail:** long-name h1 actually truncates (computed `text-overflow: ellipsis` +
  `scrollWidth > clientWidth` on the h1 with the ≥40-char fixture); 9-tab row at 390 is
  a real x-scroll region (computed `overflow-x: auto` + `scrollWidth > clientWidth`);
  no page-level horizontal overflow at every width. (Resolves B1's §7 "jsdom cannot
  prove scroll/truncation boxes; computed proof remains D7.")
- **Ops:** no-horizontal-overflow sweep only (cheap; the page is in the QA matrix; no
  named DD legs).
- **Inbox:** SEQUENCED BEHIND B4 (C-D7-4). At HEAD the page has zero collapse logic
  (three `flex-shrink-0` panes) — narrow-width rows would fail against known-open debt,
  proving nothing. Once B4 lands: contact-pane `display: none` below the 1080px
  container threshold, no horizontal overflow at the full matrix, hover-card edge
  placements (B4 §6.7 names D7 as the deterministic backstop).
- **Drawer squeeze (primitive-level):** wrapper at 899px → `.soup-drawer` computed
  `position: absolute` + scrim visible; at 900px → `position: static` + scrim
  `display: none` (`primitives.css:1235`); plus one Fleet-page integration case (drawer
  open at 1440 → squeeze; at 768 → overlay + scrim). Resolves
  `primitives-drawer.test.tsx:382–383`.

## 8. Targeted test plan

1. **DD-10 computed-box suite** (`computed-box.test.tsx`) — enumeration source: every
   interactive element exported from `console/src/components/primitives/index.ts` plus
   `shared/SearchInput`. Measurement technique PER CASE:
   | Case | Technique | Floor |
   |---|---|---|
   | Button — all 6 variants × 3 sizes | `getBoundingClientRect().height` | xs ≥24, others per size token |
   | ActionButton (incl. Modal/Drawer close) | rect height AND width | ≥28 (`--input-btn`) |
   | Pill `variant=interactive` md | rect height | =24 |
   | Pill `variant=interactive` sm | rect height =20 **+** `elementFromPoint(cx, rect.top−2)` and `(cx, rect.bottom+2)` both resolve to the button (pseudo-element hit area, §0.6) **+** `getComputedStyle(el, '::before')` content present | effective ≥24 |
   | Pill removable — remove X | rect (expected FAIL pre-fix) + post-C-D7-2 `elementFromPoint` probes | effective ≥24 |
   | Tabs — tab element | rect height | ≥24 |
   | ToolbarTimeRange — each seg button | rect height | ≥24 |
   | Table — header sort buttons | rect height | ≥24 |
   | Popover — trigger + option rows | rect height; option rows | ≥24 (spec 28px rows) |
   | SearchInput (+ endAdornment buttons when provided by callers) | rect height | ≥24 input / ≥24 adornment buttons |
   Each case ends on a numeric assert (weak-terminal-assertion rule honored).
2. **Viewport matrix suite** (`viewport-matrix.test.tsx`): the §7 grid; every cell ends
   on a computed-value assert (`scrollWidth`/`clientWidth`/`getComputedStyle`).
3. **Drawer squeeze suite** (`drawer-squeeze.test.tsx`): §7 drawer rows; computed
   `position` + scrim `display`, both sides of 900.
4. **Focus-ring suite** (`focus-ring.test.tsx`): real keyboard focus (browser-mode
   `userEvent.tab()` produces genuine `:focus-visible` — jsdom cannot) on: Button,
   ActionButton, interactive Pill, a Tab, a Table sort button, the composer textarea
   (its ring is the `composites.css:956` box-shadow recipe — assert `boxShadow`, not
   `outline`); assert computed `outlineWidth`/`outlineStyle` (or boxShadow) non-none
   AND the resolved color equals the theme's `--focus-ring` resolution — run in BOTH
   themes (theme class on root); plus the B1 manual case made deterministic: a focused
   tab inside the governed x-scroll region is fully inside the scrollport
   (rect within scroller rect) after `userEvent.tab()` reaches it.
5. **Honesty-label upgrades** (comment edits, §3 table): drawer/table/button/
   line-detail-tabs/soup-kitchen/popover files — each INCONCLUSIVE/class-only
   disclaimer rewritten to name the resolving browser case;
   `primitives-log-stream.test.tsx:314` explicitly NOT claimed (announcement
   semantics ≠ geometry).
6. **Infrastructure negative tests:** the network sentinel throws on a deliberate
   `/api` fetch; the harness smoke (C-D7-1) proves vi.mock interception in browser
   mode before anything else builds on it.

## 9. Observability plan

Test-output observability only: numeric rect/computed-style values in assertion
messages (self-diagnosing failures), `screenshotFailures` PNGs as CI artifacts, the
sentinel's named error for unmocked network. No production code instrumentation; no
`console.*` (repo guard); no new data attributes (role/class queries + computed styles
suffice).

## 10. Enforcement plan

- **No new lint selectors** — browser-vs-jsdom test placement is not
  selector-expressible without false positives; review culture + this packet's
  subtree rule (`tests/browser/` = browser mode only, pragma-free) govern it.
- **CI is the enforcement surface:** the `test:browser` step is a required part of the
  quality job — DD-10/DD-18r regressions (a primitive shrinking below floor, a surface
  regaining horizontal overflow, a flip threshold drifting) now FAIL CI rather than
  waiting for live QA.
- **Honesty-label rule carried forward:** new jsdom tests that punt on geometry must
  name the browser case (or D-debt row) that owns the proof — checked at review, same
  bar this slice applies retroactively to the six files in §3.
- Existing ratchets unaffected: no `console/src` TSX changes (C-D7-2 is CSS-only), so
  the shadow-lint baseline does not move. The repo guards (`guard:work-index`,
  `guard:doc-drift`, test-integrity baseline) run against the new files at Gate 1 —
  any required index registrations land in the deps+config commit.

## 11. Rollback strategy

Commit 1 = **deps + config in one commit** (package.json/lockfile, vitest.config
exclude, vitest.browser.config.ts, setup/harness skeleton, CI step) — independently
revertible with zero effect on existing suites (nothing imports the new subtree).
Commits 2..5 = one suite per commit (computed-box; viewport-matrix + drawer-squeeze;
focus-ring; honesty-label comment edits), each additive and independently revertible.
C-D7-2 (Pill CSS fix + its computed-box case flipping to the strict floor) is its own
commit — revertible without touching the suite skeleton. Inbox collapse suite is a
B4-sequenced follow-up commit (C-D7-4). No cross-commit coupling beyond all suites
depending on commit 1.

## 12. Debt register deltas planned

Close at acceptance with proof: **DD-10** — expiration condition "computed-box evidence
for every interactive primitive" met by §8.1 incl. the sm-pill pseudo-element probes
and the removable-X case (green only via C-D7-2; the register row's "incl. sm pill +
removable X" wording satisfied verbatim). **DD-18r narrows, does not close**: the
"deterministic viewport tests" leg closes (suites + CI step are the evidence); the
drawer-squeeze INCONCLUSIVE inherited from C2.3 gets deterministic proof; remaining
legs re-scoped in the row — Inbox three-pane collapse path (B4 + the sequenced D7
suite), legacy modal sizing SSOT (B3), nav width pressure, side-panel law for non-Fleet
surfaces. **DD-23 dependency note:** the popover bottom-fold row is proposed by B2 §12
but NOT yet filed in the register — when filed, its expiry names "D7 viewport tests";
the 1440×500 matrix row plus a popover-near-fold case is added to the viewport suite AT
THAT TIME (not silently pre-claimed here). New debt: none anticipated; if C-D7-2 is
vetoed at the live checkpoint, the removable-X failure becomes a new DD row with the
measured 16×16 evidence instead of a silent skip. Anything else discovered lands as a
DD entry, not prose.

## 13. Constraints / open items

- **C-D7-1 (approach gate):** vi.mock module interception in browser mode is
  dependency-verified (§0.8c) but not yet executed in this repo — Task 1 is the harness
  smoke test; if the mocker misbehaves under browser mode, STOP and re-plan (fallback
  direction: prop-injection fixture components instead of module mocks) before any
  suite is written.
- **C-D7-2 (the one production change):** removable-X hit-area pseudo-element band +
  correcting the false "padded to 24px" comment (`primitives.css:550`). Invisible by
  design; chip-row spacing glanced at the live checkpoint (§2). If vetoed → DD row
  with evidence (§12), the computed-box case asserts the documented-defect state.
- **C-D7-3 (version posture):** vitest stays 3.2.6; `@vitest/browser` pinned exactly
  to it; `vitest-browser-react@1.0.1` (the vitest-3 line — 2.x needs vitest 4);
  playwright exact-pinned as the skew defense. Any future vitest 4 upgrade re-pins all
  three together (rule recorded for the register).
- **C-D7-4 (B4 sequencing):** the Inbox collapse/viewport suite lands only after B4 —
  asserting today's collapse-less Inbox at 390 would fail against known-open debt.
  The drawer/Fleet/LineDetail/Ops suites have no B4 dependency.
- **C-D7-5 (worktree contention):** honesty-label edits touch `tests/console` files
  and C-D7-2 touches `primitives.css` while B3-wave work is in flight in `soup-impl`
  (§1) — Gate 0 must find those landed or shelved.
- **C-D7-6 (scrollbar/OS rule):** overflow assertions always same-element
  scrollWidth-vs-clientWidth; never absolute pixel widths of the page (§6.5) — encoded
  as a comment rule in the suite header.

## 14. Strong-claim audit

The survey's headline tooling claim was falsified, not trusted: `@vitest/browser` is
NOT in the lockfile (optional peer only — §0.1); `@playwright/test` was the wrong
package name (§0.2); "removable-Pill pseudo-element hit area" conflated the sm-pill
mechanism with the removable-X, whose 24px comment the code does not implement — D7
expects to MEASURE that failure, and this packet pre-decides the remediation rather
than letting a red case rot (§0.6, C-D7-2). The GO verdict survives all three
corrections. Unexecuted-claim discipline: vi.mock-in-browser and the
`reducedMotion`/viewport provider options are dependency- and API-verified but not yet
run in this repo — both are gated behind the Task 1 smoke (C-D7-1) instead of being
asserted as working. "Deterministic" in this packet means: pinned browser build,
self-hosted fonts awaited, reduced-motion end-states, single instance, no sleeps,
explicit per-test viewport — each of those is a checkable config/code fact, not a vibe.
At slice end, grep the diff for done/complete/enforced/canonical/single/only/never/
guaranteed/final/deterministic/proves and verify each against code, tests, or evidence
before commit (A0 requirement carried into A6). The evidence packet must not claim
DD-18r closed — only its deterministic-tests leg — and must not claim the log-stream
aria-live INCONCLUSIVE resolved (§8.5).

## Verdict: **Ready with Constraints** (C-D7-1 smoke gate before suite build-out; C-D7-2 resolved at live checkpoint or converted to a DD row; C-D7-4 Inbox suite sequenced behind B4; C-D7-5 is a Gate-0 condition for the integrator). Implementation may begin once Gate 0 confirms the in-flight worktree overlap is resolved.
