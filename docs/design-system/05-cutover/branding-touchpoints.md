# Branding Touchpoints — Exhaustive Grep Audit (T7)

Audit date: 2026-06-11, this worktree. Method: `rg -n -i` for `whatsoup`, `WhatSoup`,
`Soup Kitchen`, `SoupKitchen` across `console/` (src, index.html, public, README),
`docs/console-guide.md`, and `tests/console/`, plus a structural pass for grep-invisible brand
renders. Every hit enumerated below with a tag.

Tags:

- **UI-copy** — user-visible; flips at C4/P4 (cutover-plan §6)
- **protocol-contract** — PROTECTED; mirrors a server/system contract (paths, prefixes, unit
  names, MCP tool ids, error classes); never flipped by the rebrand
- **internal-keep** — non-user-visible internal value/fixture; keep (rename optional, never
  required)
- **docs** — documentation prose; flips at P4
- **test-assertion** — test expectation that pins UI copy or brand; flips at P4 in the same PR as
  the copy it pins
- **comment-header** — source comment; P4 optional sweep
- **identifier** — code identifier (component/file names); rename recommended at P3/P4 with blast
  radius noted
- **unknown** — needs an operator decision

Raw match totals (case-insensitive line counts): `console/src` 18 whatsoup + 9 soup-kitchen;
`tests/console` 42 whatsoup + 42 soup-kitchen; `docs/console-guide.md` + `console/README.md` +
`console/index.html` 8 combined. Plus 2 grep-invisible sites (§1 first row, §2 favicon).

---

## 1. WhatSoup / whatsoup — console/src + index.html + public

| # | Location | Content | Tag | Disposition |
|---|---|---|---|---|
| 1 | `console/src/components/Nav.tsx:39-40` | wordmark rendered as two sibling spans: `<span class=text-t2>What</span><span class=text-s-ok>Soup</span>` — **grep-invisible**: no literal "WhatSoup" string exists; found via ia-workflow-review §3.5 + structural search `>What<` adjacent to `>Soup<` | UI-copy | C4: replace with SOUP nameplate per `03-spec/brand.md` (G2 mandatory item 2: tracking/optical centering) |
| 2 | `console/src/components/UpdateModal.tsx:318` | dialog title ternary: `'Update Complete' : 'Update WhatSoup'` | UI-copy | C4 flip (paired with test-assertion #T1) |
| 3 | `console/index.html:7` | `<title>WhatSoup Console</title>` | UI-copy | C4 flip per brand spec |
| 4 | `console/src/components/wizard/ConfigStep.tsx:114` | generated agent CLAUDE.md template: "an AI agent running on WhatsApp via WhatSoup" | protocol-contract (generated artifact) | EXEMPT-PROTECTED — written into every new agent's workspace and outlives a UI-only rebrand (ia-workflow-review §3.5); changing it is an agent-contract decision requiring separate operator approval |
| 5 | `console/src/components/wizard/ConfigStep.tsx:693` | permissions template: `'mcp__whatsoup__*'` | protocol-contract | PROTECTED — MCP tool namespace of the server |
| 6 | `console/src/lib/preferences.ts:5` | `const PREFIX = 'whatsoup:'` (localStorage namespace) | protocol-contract | PROTECTED — renaming orphans every stored operator preference; guarded by soup/protected-identifiers |
| 7 | `console/src/lib/agent-cwd.ts:17` | workspace path template `~/.local/share/whatsoup/instances/<slug>/workspace` | protocol-contract | PROTECTED — server filesystem contract |
| 8 | `console/src/mock-data.ts:106` | fixture `socketPath: '/run/whatsoup/personal.sock'` | protocol-contract | PROTECTED — mirrors real socket paths; demo data must not lie about contracts |
| 9 | `console/src/mock-data.ts:152` | fixture socketPath (support) | protocol-contract | PROTECTED |
| 10 | `console/src/mock-data.ts:208` | fixture socketPath (research) | protocol-contract | PROTECTED |
| 11 | `console/src/mock-data.ts:263` | fixture socketPath (devops) | protocol-contract | PROTECTED |
| 12 | `console/src/mock-data.ts:314` | fixture socketPath (sales) | protocol-contract | PROTECTED |
| 13 | `console/src/mock-data.ts:403` | fixture socketPath (staging) | protocol-contract | PROTECTED |
| 14 | `console/src/mock-data.ts:453` | fixture socketPath (archive) | protocol-contract | PROTECTED |
| 15 | `console/src/mock-data.ts:1120` | fixture log msg `Socket path: /run/whatsoup/${lineName}.sock` | protocol-contract | PROTECTED |
| 16 | `console/src/mock-data.ts:1182` | fixture log msg socket path (intern) | protocol-contract | PROTECTED |
| 17 | `console/src/types.ts:2` | comment header "WhatSoup Console — Shared Type Definitions" | comment-header | EXEMPT-PROTECTED per T7 brief grouping (contract-adjacent file); P4-optional sweep allowed |
| 18 | `console/src/hooks/use-fleet.ts:2` | comment header "WhatSoup Console — Fleet Data Hooks" | comment-header | EXEMPT-PROTECTED per T7 brief grouping; P4-optional |
| 19 | `console/src/mock-data.ts:2` | comment header | comment-header | P4 optional |
| 20 | `console/src/hooks/use-keyboard-shortcuts.ts:2` | comment header | comment-header | P4 optional |

Related server-side identifier (outside console, listed for the protected-identifier rule):
`WhatSoupError` class `src/errors.ts:32-37`, consumed across `src/transport/connection.ts`,
`src/core/database.ts`, `src/runtimes/chat/runtime.ts` — protocol-contract, PROTECTED. The systemd
unit template `whatsoup@<name>.service` (root `CLAUDE.md`) is likewise PROTECTED and surfaces in
test fixtures (#T20).

Note on the inventory: `docs/design-system/00-inventory/inconsistency-register.md` P2-11 cites the
six literal occurrences at `:1` of each file; the literals actually sit at `:2` (line 1 is the
comment rule) and at `ConfigStep.tsx:114` / `UpdateModal.tsx:318` for the non-header cases. Same
six files, off-by-one/representative line citations. P2-11 also does not list the Nav wordmark
(no literal match); ia-workflow-review §3.5 does.

## 2. Favicon + brand assets

| # | Location | Content | Tag | Disposition |
|---|---|---|---|---|
| 21 | `console/public/favicon.svg` | purple/blue bolt-style mark (fills `#863bff`, `#7e14ff`, `#47bfff`) — contains no brand string; visually unrelated to the locked SOUP identity (Geist nameplate, teal tick, electric-blue accent) | UI-copy (asset) | C4: replace per `03-spec/brand.md` favicon spec; `console/index.html:6` link tag unchanged |
| 22 | `console/public/icons.svg` | retired orphan icon sprite; no `console/src` or `index.html` references | internal-retired | removed before C4; public SVG reachability is pinned by `tests/console/peripheral-brand-regression.test.ts` |

## 3. Soup Kitchen / SoupKitchen — console/src

| # | Location | Content | Tag | Disposition |
|---|---|---|---|---|
| 23 | `console/src/components/Nav.tsx:53` | nav label `<span>Soup Kitchen</span>` | UI-copy | C4 flip → "Fleet" (G1 locked vocabulary) |
| 24 | `console/src/components/KeyboardShortcutsHelp.tsx:8` | shortcut label `'Go to Soup Kitchen'` | UI-copy | C4 flip → "Go to Fleet" |
| 25 | `console/src/pages/Ops.tsx:119` | empty-state copy "No instances discovered. Create one from the Soup Kitchen." | UI-copy | C4 flip → Fleet + Line vocabulary ("No lines discovered. Create one from the Fleet.") |
| 26 | `console/src/pages/SoupKitchen.tsx:67` | `const SoupKitchen: FC = () => {` | identifier | rename → `Fleet` at P3/P4 (see blast radius below) |
| 27 | `console/src/pages/SoupKitchen.tsx:540` | `export default SoupKitchen;` | identifier | with #26 |
| 28 | `console/src/App.tsx:11` | `const SoupKitchen = lazy(() => import('./pages/SoupKitchen'))` | identifier | with #26 — file rename changes the import specifier |
| 29 | `console/src/App.tsx:55` | route element `<ErrorBoundary><SoupKitchen /></ErrorBoundary>` (route path is `/` — no URL change involved) | identifier | with #26 |
| 30 | `console/src/hooks/use-keyboard-shortcuts.ts:23` | comment "1 = SoupKitchen, 2 = Inbox, 3 = Ops" | comment-header | P4 optional |
| 31 | `console/src/index.css:153` | comment "SoupKitchen table column widths" (the `--sk-col-*` token block) | comment-header | P4 optional; the `--sk-*` token prefix itself is internal-keep (renaming is cosmetic churn; C0 moves these to the component tier anyway) |

### SoupKitchen rename blast radius (recommendation)

Recommend: rename file `console/src/pages/SoupKitchen.tsx` → `Fleet.tsx`, component → `Fleet`,
and the nav/route *label* → "Fleet", executed as its own sub-PR at the C3/C4 boundary (cutover-plan
§6). Direct couplings that break and must move in the same commit:

- imports/identifiers: `console/src/App.tsx:11,55`
- test file `tests/console/soup-kitchen.test.tsx` (15 matches: import `:80`, JSX `:149`, error
  text `:178`, 10 describe titles `:222,252,321,395,494,667,699,750,783`, dynamic import `:816`,
  header comments `:2,:8`) — rename file to `fleet.test.tsx` alongside
- source-string assertion `tests/console/error-boundary.test.ts:42` — asserts App source contains
  `element={<ErrorBoundary><SoupKitchen /></ErrorBoundary>}` (reads source text, not render)
- path-readers: `tests/console/design-token-classes.test.ts:26` and
  `tests/console/design-system-compliance-pages.test.ts:96` — both `read('console/src/pages/
  SoupKitchen.tsx')`; also identifier-ish matches at `design-token-classes.test.ts:25,29`,
  `design-system-compliance-pages.test.ts:94,99,100`
- mock + testid in `tests/console/app.test.tsx:54-55` (`vi.mock('../../console/src/pages/
  SoupKitchen'…)`, stub text `SoupKitchen`) and describe/assert lines `:126,160,191`
  (testid `page-soup-kitchen` may stay or rename — internal-keep)

## 4. tests/console — full enumeration

### 4a. test-assertion (flip at C4, same PR as the copy)

| # | Location | Pins | Flip |
|---|---|---|---|
| T1 | `tests/console/update-modal.test.tsx:171,173` | it-title + `getByText('Update WhatSoup')` | with #2 |
| T2 | `tests/console/nav-status.test.tsx:59-63` | "renders WhatSoup brand": `getByText('What')`, `getByText('Soup')` | with #1 (nameplate) |
| T3 | `tests/console/nav-status.test.tsx:46,48` | "renders Soup Kitchen, Inbox, and Ops links"; `getByText('Soup Kitchen')` | with #23 |
| T4 | `tests/console/nav.test.tsx:55,62,65,68,71,78,86,96` | nav link text 'Soup Kitchen' (href, aria-current, unread-badge scoping) | with #23 |
| T5 | `tests/console/app.test.tsx:326,330` | "line detail route keeps Soup Kitchen active in Nav"; `getByText('Soup Kitchen')` | with #23 |
| T6 | `tests/console/keyboard-shortcuts-help.test.tsx:164,193` | label 'Go to Soup Kitchen' | with #24 |

Assertion-site count: 6 clusters / 15 expectation lines across 5 files (within the cutover plan's
"~5-10 assertions" estimate when counted as clusters).

### 4b. test-assertion / identifier (flip with the SoupKitchen→Fleet rename, P3/P4)

| # | Location | Notes |
|---|---|---|
| T7 | `tests/console/soup-kitchen.test.tsx` (15 matches, lines in §3) | file + import + describes |
| T8 | `tests/console/error-boundary.test.ts:42` | source-string assertion on App.tsx content |
| T9 | `tests/console/design-token-classes.test.ts:25,26,29` | path-reader + var names |
| T10 | `tests/console/design-system-compliance-pages.test.ts:94,96,99,100` | path-reader + var names |
| T11 | `tests/console/app.test.tsx:54,55,126,160,191` | vi.mock path, stub text, describe titles |

### 4c. protocol-contract fixtures (PROTECTED — never flip)

| # | Location (counts are matching lines) | Contract mirrored |
|---|---|---|
| T12 | `tests/console/agent-cwd.test.ts` ×8 (`:8,53,59,99,112,123,136,149`) | `~/.local/share/whatsoup/instances/...` workspace paths |
| T13 | `tests/console/wizard-agent-cwd-default.test.ts` ×8 (`:10,14,24,64,76,81,90,97`) | same |
| T14 | `tests/console/wizard-agent-cwd-display.test.tsx:15` | same |
| T15 | `tests/console/review-step.test.tsx:191` | same (CWD display value) |
| T16 | `tests/console/mode-tab.test.tsx:246` | `/var/lib/whatsoup/...` cwd fixture |
| T17 | `tests/console/config-helpers.test.ts:324,334` | `/var/lib/whatsoup` cwd fixture |
| T18 | `tests/console/preferences.test.ts` ×9 (`:5,43,56,62,71,75,77,84,89`) | `whatsoup:` localStorage namespace (incl. `whatsoup:theme`) |
| T19 | `tests/console/preferences-csv.test.ts:216,225` | `whatsoup:metricsRange` key |
| T20 | `tests/console/alert-banner.test.tsx:55,56,61,63` | `whatsoup@a` / `whatsoup@b` line names mirroring the `whatsoup@<name>` unit naming |
| T21 | `tests/console/vite-fleet-token.test.ts:20` | `~/.config/whatsoup/` config-dir name (tmp fixture) |

### 4d. internal-keep / comment-header (tests)

| # | Location | Content |
|---|---|---|
| T22 | `tests/console/csv-export.test.ts:85` | `'blob:whatsoup-test-csv'` object-URL fixture — internal-keep |
| T23 | `tests/console/summary-tab.test.tsx:5` | comment "WhatSoup issue #352" — comment-header, keep (historical reference) |

## 5. Docs + README

| # | Location | Content | Tag | Disposition |
|---|---|---|---|---|
| D1 | `docs/console-guide.md:3` | "The WhatSoup Fleet Console is a React dashboard…" | docs | P4 flip (product name per brand spec) |
| D2 | `docs/console-guide.md:9` | section heading "Soup Kitchen (Fleet Overview)" | docs | P4 flip → "Fleet" |
| D3 | `docs/console-guide.md:110` | "…for the Soup Kitchen view" | docs | P4 flip → Fleet view |
| D4 | `docs/console-guide.md:163` | prose + `~/.config/whatsoup/fleet-tokens.json`, `~/.config/whatsoup/fleet-token` | docs + protocol-contract | P4: flip surrounding prose only; the two paths are PROTECTED |
| D5 | `console/README.md:1` | "# WhatSoup Fleet Console" | docs | P4 flip |
| D6 | `console/README.md:3` | "…operating the embedded WhatSoup fleet server" | docs | P4 flip (note: "fleet server" is the server product term — confirm whether the server keeps the WhatSoup name; if yes, this sentence is part protocol-contract). Tag the server-name question **unknown** pending operator decision |
| D7 | `console/README.md:22` | "reads the fleet token from the local WhatSoup config" | docs + protocol-contract | P4: prose flips; the config it describes stays `~/.config/whatsoup/` |

**Unknown queue (operator decisions needed):** (a) D6 — does the *server* (and its repo/product
name, error class, unit names) keep "WhatSoup" while only the console UI rebrands? This plan
assumes YES (all protocol contracts PROTECTED). (b) #4 — generated agent CLAUDE.md phrasing.
(c) Whether comment headers are swept at P4 (cosmetic) or left.

## 6. UI-copy vocabulary audit vs locked vocabulary (Fleet / Line / attention)

Locked at G1 (decision-log): Soup Kitchen → **Fleet**; single user-facing noun **Line** with
"instance" demoted to process/infra copy; Inbox/Ops kept; one unified **attention** metric.
Current user-visible drift to resolve at C3/C4 (each line is visible copy, not identifiers):

| Location | Current copy | Locked-vocabulary target |
|---|---|---|
| `console/src/pages/SoupKitchen.tsx:382` | section heading "Instances" | "Lines" |
| `console/src/pages/SoupKitchen.tsx:518` | "No instances match the current filters" | "No lines match the current filters" |
| `console/src/pages/Ops.tsx:100` | "{n} instances" toolbar label | "{n} lines" |
| `console/src/pages/Ops.tsx:119` | "No instances discovered. Create one from the Soup Kitchen." | "No lines discovered. Create one from the Fleet." |
| `console/src/pages/Ops.tsx:296` | "Select an instance to view logs" | "Select a line to view logs" |
| `console/src/pages/Ops.tsx:328` | toast "Instance re-linked!" | "Line re-linked!" |
| `console/src/components/ActivityFeed.tsx:210` | confirm label "Stop instance" | "Stop line" |
| `console/src/components/ActivityFeed.tsx:216` | "The instance will not reconnect until manually started." | Line phrasing |
| `console/src/components/Nav.tsx:153` | "{n} alert{s}" nav chip | "attention" metric phrasing per `03-spec/brand.md`/vocabulary table (one unified attention definition; also make the chip interactive — it is a dead span today, ia-workflow-review §5.2 / P2-8) |
| `console/src/components/AlertBanner.tsx:31` | "{n} alert{s}" banner count | unified attention phrasing, consistent with Nav |
| `console/src/components/UpdateModal.tsx:318` (+ phase copy around `:385-439`) | "Update WhatSoup"; per-instance restart checkboxes copy | "Update SOUP"; Line phrasing for the restart list (the internal phase id `restart-instances` is internal-keep) |

Sanctioned process-level uses of "instance" (KEEP — matches the demotion rule): socket paths,
`agentOptions` keys, `t.instance` API fields (`console/src/pages/Inbox.tsx:91`,
`console/src/components/ActivityFeed.tsx:43-46`), code comments. Rule of thumb for C3/C4 review:
if an operator can read it in the UI, it says Line/Fleet/attention; if a process or API reads it,
it stays.

Tone check (status language, action verbs, confirmations, tooltips, empty states): the audited
copy is already operational-terse and verb-first ("Re-link", "Restart Selected", "Stop instance",
"No data yet") — consistent with the locked direction; the only systematic deviations are the
instance/Line noun split and the alert/attention naming, both tabled above. Playful naming
("Soup Kitchen") exits with the C4 flip; brand playfulness is carried by the SOUP wordmark alone
(G1 decision).

## 7. Totals by category

Counted as enumerated rows above (a row spanning multiple lines counts its matching lines):

| Category | Occurrences | Where |
|---|---|---|
| UI-copy (flip C4) | 7 sites (#1, #2, #3, #21, #23, #24, #25) | console/src, index.html, favicon |
| Vocabulary drift (flip C3/C4) | 11 copy sites (§6 table) | console/src pages/components |
| protocol-contract (PROTECTED) | 14 in console/src (#4-#16 incl. generated artifact) + 37 fixture lines in tests (T12-T21) + 3 path refs in docs (D4 ×2, D7) | src, tests, docs |
| identifier (rename P3/P4) | 4 in src (#26-#29) + 28 coupled test lines (T7-T11) | SoupKitchen → Fleet |
| comment-header (P4 optional) | 6 in src (#17-#20, #30, #31) + 3 in tests (T22 is internal-keep, T23, soup-kitchen.test headers counted in T7) | — |
| test-assertion (flip C4) | 15 lines / 6 clusters (T1-T6) | 5 test files |
| docs (flip P4) | 7 lines (D1-D7, prose portions) | console-guide, README |
| unknown (operator decision) | 3 questions (§5 unknown queue) | server name, generated CLAUDE.md, comment sweep |

Cross-check against raw counts: 18 whatsoup + 9 soup-kitchen lines in `console/src` = 27, all
tagged (#1 is grep-invisible and additive; #21/#22 are assets). 42 + 42 lines in `tests/console`
all tagged across T1-T23. 8 lines in docs/index.html tagged (#3, D1-D7). No untagged hits remain.
