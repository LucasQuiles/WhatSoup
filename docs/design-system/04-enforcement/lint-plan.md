# Lint Plan — SOUP Design System v3 Enforcement (T7)

Status: living enforcement registry, originally authorized by G2 (Option A conditional lock of
"SOUP — v2 (Blend)", `docs/design-system/02-directions/decision-log.md`). Executable by a fresh
implementation agent during driver phase P6 (enforcement), with early rules landing alongside P1/P2
as noted per rule. Historical file:line citations were verified against the tree on 2026-06-11;
later changelog entries record implementation deltas.

---

## 1. Enforcement home

| Surface | Home | Mode |
|---|---|---|
| Design rules (TSX/TS) | `console/eslint.config.js` — flat config, `no-restricted-syntax` today (106 selectors: global set `console/eslint.config.js:76-584`, scheduled/groups ratchet `:586-656` scoped to the file list at `:689-702`) | error severity; this is the blocking wall |
| Custom AST rules | NEW `console/eslint-rules/` local plugin (`index.mjs` exporting a `rules` map, registered in `console/eslint.config.js` via `plugins: { soup: soupPlugin }`). **Note:** no `eslint-rules/` directory exists in the repo today — the T7 brief's reference to an existing plugin is stale; P6 creates it. The existing config structure (`defineConfig` + per-file-list rule blocks, `console/eslint.config.js:658-707`) is the pattern to follow for scoping. |
| CSS-file policy | Stylelint — **reference-only candidate** (synthesis-seed-4 precedent: custom rules, naming patterns, autofix, staged rollout). Not adopted now. Until adopted, CSS-side checks run as `rg` scripts (section 5) because `no-restricted-syntax` cannot see `console/src/index.css` (duplication-register DUP-01 "Guarded by lint? Unguarded — nothing inspects index.css"). |
| Fitness registry | `scripts/lib/fitness/registry.ts` stays warn-only/registry-driven (taxonomy: `docs/architecture/fitness-taxonomy.md`). Design rules do NOT route through it — error-severity design rules live in `console/eslint.config.js` only. The registry may *mirror* design-debt counts for trend lines, never gate. |
| CI/pre-push | `console/.husky/pre-commit` → `lint-staged` → `eslint --max-warnings 0` (`console/package.json:6-10`); root `.husky/pre-commit` runs the same when `console/src` TS/TSX is staged; root `.husky/pre-push` runs `scripts/pre-push-guard.ts`; `verify:release` runs `npm --prefix console ci` + `npm --prefix console run build` (root `package.json:51`). Section 5 adds the design-regression check suite to these hooks. |

Layer ownership map (adopted from synthesis-seed-2; rules cite the layer they defend):

- tokens own values, not structure
- primitives own layout + accessible behavior, not screen semantics
- components own reusable units, not workflow logic
- patterns own validated compositions, not business rules
- screens own orchestration, never raw values or style forks

## 2. Progressive lifecycle (merged ladder)

Merged from the plan's state machine and the seed-2/seed-3 enforcement ladders:

1. **proposed** — rule drafted in this catalog; no tooling.
2. **shadow / report-only** — rule runs repo-wide, output collected to a baseline file
   (`console/eslint-baselines/<rule>.json`), never fails anything. Purpose: count violations,
   calibrate false positives, freeze the baseline.
3. **warn-on-changed-files** — warn severity via lint-staged (changed files only). Existing
   violations in untouched files stay silent.
4. **scoped-error** — error severity for an explicit directory/file list (the per-file-list block
   pattern already used at `console/eslint.config.js:688-706`). The list grows as P2/P3 migration
   lands per directory.
5. **global-error** — error severity for all of `console/src`; baseline file deleted.
6. **deprecated** — rule superseded (e.g. a grep check replaced by an AST rule); kept one phase as
   warn for stragglers.
7. **removed** — deleted from config; decision recorded in this file's changelog.

Promotion gate: a rule may move up one state only when (a) its baseline count is zero or fully
waivered, and (b) it has run one full phase at the current state without a false-positive report.
Demotion: two confirmed false positives in a week demote one state and open a fix task.

Fixture gate: implemented `soup/*` rules must have a true-positive fixture, a false-positive fixture,
and a lifecycle row before promotion. Promoted selector rules must also have an error-severity path
probe proving the rule fires under the default config, not only in the shadow config. The gate is
`npm --prefix console run design:lint-fixtures`, backed by
`console/scripts/check-design-lint-fixtures.mjs`; it derives implemented rule ids from
`console/eslint-rules/design-selectors.mjs`, `console/eslint.config.shadow.mjs`, and
`console/eslint-rules/index.mjs`, then verifies coverage in `tests/console/design-lints.test.ts`.
Stub rules are not required to fire, but they must remain documented in this plan until implemented
or removed.

### Per-rule lifecycle tracking table

This table is the registry. P6 updates the State column in place; every change is a one-line diff.

| Rule id | State (current — see changelog) | Target | Owning phase | Notes |
|---|---|---|---|---|
| soup/no-brand-regression | shadow | global-error | P4 | flips to error the same PR as the P4 copy flip |
| soup/no-channel-specific-copy | proposed | global-error | P4/G7 | flags generic visible "WhatsApp" copy after the multi-channel positioning lock; protocol/runtime prompts stay allowlisted |
| soup/protected-identifiers | scoped-error | global-error | P1 | cheap, zero current violations — start strict |
| soup/no-raw-button | scoped-error (M list) | scoped-error per dir | P2 | 24 raw buttons today (control-catalogue §1b) |
| soup/no-raw-form-control | scoped-error (non-primitives) | scoped-error per dir | P2 | zero outside `components/primitives/**`; generated raw-form inventory remains the mechanical count authority |
| soup/no-adhoc-modal | scoped-error (M list) | global-error | P2 | 11 surfaces to absorb (control-catalogue §9) |
| soup/no-legacy-tokens | scoped-error (primitives tier) | global-error | P2+ complete | enabled only after alias layer + primitives land |
| soup/no-raw-color | scoped-error (already live) | global-error | P1 | exists as selectors `console/eslint.config.js:110-117,576-583`; port to soup/* + close template-literal gap. Hex-in-string selector tightened to CSS-color-valid lengths only (6/8 hex digits, or 3 hex digits containing an a–f letter); pure-decimal `#NNNN` runs (order/build numbers in copy, e.g. `#4921`) no longer false-flag — proof fixtures in `tests/console/design-lints.test.ts`. |
| soup/no-untokenized-values | scoped-error (already live) | global-error | P1 | exists `console/eslint.config.js:157-191,227-229`; close 3 evasion shapes (DUP-08) |
| soup/no-transition-all | global-error (already live) | keep | P5 | `console/eslint.config.js:126-128` |
| soup/no-infinite-animation | shadow | global-error | P5 | 4 current infinite animations to disposition |
| soup/no-focus-suppression | scoped-error (console-wide) | global-error | P2 | 0 TSX `outline-none` occurrences today; composer carve-outs retired |
| soup/focus-visible-required | shadow | scoped-error (primitives) | P2 | primitives-first; screens inherit |
| soup/modal-must-restore-focus | proposed | scoped-error (Modal) | P2 | enforceable once Modal primitive exists |
| soup/motion-needs-reduced-variant | shadow | global-error | P5 | 1 of ~6 animation families has a reduced variant today |
| soup/no-literal-status-colors | global-error | global-error | P2 | Implemented 2026-06-14; flags duplicated status-keyed color maps/switches outside shared helpers |
| soup/provider-palette-only | blocking script | scoped-error / blocking script | P4/G5 | provider identity must consume `--provider-*`; no status/mode/data/literal colours |
| soup/data-series-token-only | blocking script | scoped-error / blocking script | P4/G5 | non-provider chart dimensions must consume `--data-*`; FleetMetricsChart is message-volume data, not provider identity |
| soup/traffic-neutrality | blocking script | scoped-error / blocking script | P4/G5 | sent/received/sessions/media quantities stay neutral ink unless reclassified as status |
| soup/no-component-local-palette | blocking script | keep blocking script / later scoped-error | P4/G5 | component-local colour maps collapse into documented provider/data/status token maps or explicit exceptions |
| soup/tabular-nums-required | proposed | scoped-error (Table/metric) | P4 | zero current usage — needs spec landing first |
| soup/no-unsafe-truncation | package-script fail-on-rule | scoped-error / blocking script | P4/G7 | truncation needs full-value access or documented exception |
| soup/scroll-owner-required | package-script fail-on-rule | scoped-error / blocking script | P4/G7 | scrollable regions need axis min-size proof and one declared owner |
| soup/no-layout-shift-interaction | package-script fail-on-rule | scoped-error / blocking script | P4/G7 | hover/focus/active states must not change layout dimensions |
| soup/no-hover-only-content | package-script fail-on-rule | scoped-error / blocking script | P4/G7 | hover-revealed content needs keyboard/focus parity |
| soup/no-vw-font-size | package-script fail-on-rule | global-error | P4/G7 | typography must use tokenized type scale, not viewport width |
| soup/no-static-viewport-height | package-script fail-on-rule | scoped-error / blocking script | P4/G7 | full-height surfaces use `dvh`, not static `vh` / `h-screen` |
| soup/layer-owner-required | blocking script | scoped-error / blocking script | P4/G7 | z-index uses `--z-*` layer tokens or a documented owner |
| soup/no-raw-viewport-js | package-script fail-on-rule | scoped-error / blocking script | P4/G7 | viewport branching must route through `useBreakpoint` / `useViewportPlacement`, not local `window.innerWidth` or `matchMedia` reads |
| soup/no-duplicate-shell | shadow (advisory) | warn-on-changed-files | P2 | heuristic; routes to duplication-register, never error |
| soup/theme-parity (script) | CI-blocking script | CI-blocking script | P1 | not an ESLint rule; section 5 |
| soup/icon-family | scoped-error | global-error | P1 | zero current violations (lucide-react only) |
| soup/no-utility-smell | scoped-error (primitives tier) | warn-on-changed-files | P2 | G2 mandatory item 3 tripwire |
| soup/no-format-bypass | global-error | global-error | P3 | date/time/count formatting must go through `console/src/lib` helpers |
| soup/no-inline-dismiss-handler | global-error | global-error | P2 | document-level Escape dismissal must go through `useDismissable` |
| soup/no-raw-table | global-error (outside primitives) | keep | C2.3/D6 | added post-T7 (C2.3 tripwire → D6 flip); Group S, design-selectors.mjs |
| soup/no-raw-sortable-header | global-error (outside primitives) | keep | C2.3/D6 | added post-T7 (C2.3 tripwire → D6 flip); Group S, design-selectors.mjs |
| soup/no-legacy-log-lanes | global-error (outside primitives) | keep | C2.3/D6 | added post-T7 (C2.3 tripwire → D6 flip); Group S, design-selectors.mjs |

## 3. Rule catalog

Conventions for every entry: **id** (soup/*), purpose, mechanism sketch (AST selector or grep),
scope + exemptions, violation/valid pair, false-positive (FP) strategy, autofix feasibility,
owning migration phase, lifecycle entry state. "Selector" means a `no-restricted-syntax` selector
addable today; "custom rule" means an `console/eslint-rules/` AST rule (needed where selectors
cannot express the check).

### soup/no-brand-regression

- **Purpose:** prevent "WhatSoup" re-entering user-facing UI after the P4 branding flip; the locked
  vocabulary is SOUP / Fleet / Line (`docs/design-system/02-directions/decision-log.md`, G1/C3).
- **Mechanism:** custom rule. Flag the string `WhatSoup` (case-sensitive) when it appears in
  (a) `JSXText`, (b) a `Literal`/`TemplateLiteral` assigned to a JSX attribute that is not in the
  identifier allowlist, (c) `document.title` assignments. Also flag adjacent split-text spans whose
  concatenated text is `WhatSoup` — the current Nav wordmark renders `What` + `Soup` as two sibling
  spans (`console/src/components/Nav.tsx:39-40`) and is invisible to a naive single-string check;
  detect `JSXText` equal to `What` whose next JSX sibling element's text is `Soup`.
- **Scope:** `console/src/**` TSX/TS. Tests get the same rule at P4 (the assertions flip in the
  same PR; see `docs/design-system/05-cutover/branding-touchpoints.md`).
- **Current-occurrence disposition (6 literal hits in console/src, verified):**
  | Site | Disposition |
  |---|---|
  | `console/src/components/wizard/ConfigStep.tsx:114` (generated agent CLAUDE.md: "via WhatSoup") | EXEMPT-PROTECTED — this string is written into agent workspaces and outlives a UI rebrand (ia-workflow-review §3.5); changing it is a product/agent-contract decision, not a UI copy flip |
  | `console/src/types.ts:2` (comment header) | EXEMPT-PROTECTED — comments excluded from rule scope by construction |
  | `console/src/hooks/use-fleet.ts:2` (comment header) | EXEMPT-PROTECTED — same |
  | `console/src/mock-data.ts:2`, `console/src/hooks/use-keyboard-shortcuts.ts:2` (comment headers) | exempt (comments); optional sweep at P4 |
  | `console/src/components/UpdateModal.tsx:318` ("Update WhatSoup" dialog title) | UI copy — flips at P4 |
  Plus the split wordmark `console/src/components/Nav.tsx:39-40` (UI copy, flips at P4) and
  `console/index.html:7` (`<title>WhatSoup Console</title>` — covered by the section 5 grep, not
  ESLint, since index.html is not linted).
- **Violation / valid:** `<span>Update WhatSoup</span>` → `<span>Update SOUP</span>` (or the
  locked nameplate treatment per the T6 `03-spec/brand.md`).
- **FP strategy:** comments and import paths excluded by node-type selection; identifier allowlist
  (`WhatSoupError`, `mcp__whatsoup__`, `whatsoup:` prefix, path segments `/run/whatsoup/`,
  `~/.local/share/whatsoup/`, `whatsoup@` unit names) shared with soup/protected-identifiers.
- **Autofix:** none (copy changes need human/spec review).
- **Phase:** P4. **Entry state:** shadow (baseline = the dispositions above).

### soup/no-channel-specific-copy

- **Purpose:** preserve the C3 follow-on decision #5: SOUP is multi-channel/global. Generic
  user-visible copy must not position the product as WhatsApp-only; it must say conversational
  agents, Lines, channels, or Fleet operations. Technical substrate names remain allowed where they
  describe a concrete integration/runtime path.
- **Mechanism:** custom rule paired with the section 5 grep. Flag the string `WhatsApp`
  (case-sensitive) when it appears in JSX text, user-visible JSX attributes (`title`, `aria-label`,
  button labels, placeholders, document titles), or copy-bearing string literals used by rendered
  UI. Do not flag comments, import paths, protocol helpers, or generated agent/system prompt
  templates.
- **Scope:** `console/src/**` TSX/TS plus `console/index.html` via the regression script. Tests flip
  in the same G7 copy packet. Future explicit channel-picker labels may be allowlisted only when the
  UI is naming a concrete channel option rather than describing the product.
- **Protected contexts:** generated prompts in `console/src/components/wizard/ConfigStep.tsx`
  (`You are ... on WhatsApp`, `running on WhatsApp via WhatSoup`, delivered via WhatsApp);
  protocol/runtime vocabulary (`@s.whatsapp.net`, Baileys, JID, `conversation_key`); and any
  future setup copy that is explicitly scoped to a selected WhatsApp channel integration.
- **Violation / valid:** `operations console for WhatsApp agents` →
  `operations console for conversational agents`; `Provision WhatsApp agents` → `Provision Lines`.
- **FP strategy:** the rule must carry true-positive fixtures for visible copy and false-positive
  fixtures for ConfigStep prompt templates, Baileys/JID/protocol literals, comments, and explicit
  channel-option labels before promotion beyond shadow/proposed.
- **Autofix:** none (word choice is semantic copy work). **Phase:** P4/G7. **Entry state:** proposed.

### soup/protected-identifiers

- **Purpose:** inverse guard — prevent an over-eager rebrand from renaming protocol contracts.
  The console talks to a server whose error class is `WhatSoupError` (`src/errors.ts:32-37`), whose
  systemd unit template is `whatsoup@<name>.service` (root `CLAUDE.md`), whose sockets live at
  `/run/whatsoup/*.sock` (mirrored in `console/src/mock-data.ts:106` etc.), whose agent workspaces
  are `~/.local/share/whatsoup/instances/...` (`console/src/lib/agent-cwd.ts:17`), whose
  localStorage namespace is `whatsoup:` (`console/src/lib/preferences.ts:5`), whose config dir is
  `~/.config/whatsoup/` (`docs/console-guide.md:163`), and whose MCP tool prefix is
  `mcp__whatsoup__*` (`console/src/components/wizard/ConfigStep.tsx:693`). Channel substrate
  identifiers are protected too: `@s.whatsapp.net`, Baileys, JID, and `conversation_key`.
- **Mechanism:** custom rule with a frozen contract list. Two checks: (a) error if any contract
  string is *edited into a near-miss* — i.e. a literal matching `soup:`/`/run/soup/`/`SoupError`/
  `~/.local/share/soup/` appears where the contract list expects the whatsoup form; (b) a
  companion grep in section 5 asserts the contract strings still exist at their home sites
  (presence check, since ESLint cannot see deletions).
- **Scope:** `console/src/**` + `tests/console/**`. Exemptions: none — this rule is the exemption
  mechanism for the other brand rules.
- **Violation / valid:** `const PREFIX = 'soup:'` in `console/src/lib/preferences.ts` → keep
  `'whatsoup:'` (a migration of stored keys is a separate, explicitly-approved server+client task).
- **FP strategy:** exact-literal matching against the frozen list only.
- **Autofix:** none. **Phase:** P1 (land before any rename work starts). **Entry:** scoped-error.

### soup/no-raw-button

- **Purpose:** all buttons render through the P2 `Button` primitive. Today: 135 `<button>` across
  42 files, 24 raw outside `c-btn`/`c-tab` in ~8 ad-hoc recipes (control-catalogue §1b);
  inconsistency-register P1-1.
- **Mechanism:** selector `JSXOpeningElement[name.name="button"]` scoped per directory; once the
  primitive exists, also custom-rule check that `Button` is imported from
  `console/src/components/primitives/`.
- **Scope:** per-directory enablement that tracks P2 migration order (shared → wizard → modals →
  pages; see cutover plan §3 P2). Permanent exemption: `components/primitives/**` (the primitive
  itself must render `<button>`).
- **Violation / valid:** `<button className="c-btn c-btn-sm">…</button>` →
  `<Button size="sm">…</Button>`; `<button className="c-hover …">` (e.g. raw icon button
  `console/src/pages/LineDetail.tsx:140`) → `<Button variant="ghost" size="xs" icon>`.
- **FP strategy:** directory scoping means a file is only flagged after its directory migrated;
  the type-attribute rule already live (`console/eslint.config.js:556-558`) stays until absorbed
  by the primitive (Button always sets `type`).
- **Autofix:** partial codemod feasible for the `c-btn` + variant-class cases (mechanical class →
  prop mapping); raw recipes need hand migration.
- **Phase:** P2. **Entry:** shadow (baseline 135/24 counts above).

### soup/no-raw-form-control

- **Purpose:** `input`, `select`, `textarea` render through the promoted FormControl primitive
  (`console/src/components/primitives/FormControl.tsx`) and the P2 `Select` policy. File upload
  controls route through `FileInput`; primitive-owned renderers such as `ToolbarSearch` stay inside
  `components/primitives/**`.
- **Mechanism:** promoted selector `JSXOpeningElement[name.name=/^(input|select|textarea)$/]`,
  carried by `rawFormControlSelectors` in `console/eslint-rules/design-selectors.mjs` and re-carried
  by each non-primitives flat-config block in `console/eslint.config.js`. The census is mechanical through
  `npm --prefix console run design:raw-form-control-inventory`, which derives findings from
  `console/eslint.config.shadow.mjs` JSON output; after promotion the shadow run receives the
  selector through `baseSyntaxSelectors` and keeps baseline continuity without a duplicate
  shadow-only copy. The inventory classifies each hit as either consumer-migration or
  exemption-movement. The package script compares the live scan to
  `console/design-raw-form-control-inventory.json`; packets update that generated inventory with
  `npm --prefix console run design:raw-form-control-inventory -- --update`, never with copied
  package-script counts.
- **Scope/exemptions:** `components/primitives/**` exempt because the primitive tier owns the raw
  renderers; consumer inventory is currently zero.
- **Violation / valid:** bare `<input className="c-input …">` → `<TextInput …>` or
  `<FileInput …>` for uploads; bare `<select className="c-input …">` → `<SelectInput …>`;
  bare `<textarea className="c-input …">` → `<TextArea …>`.
- **FP strategy:** directory scoping plus the deterministic inventory gate. Current generated
  manifest is empty. D4.2 intentionally
  cleared the former 5 form-kit self-hits by moving the canonical primitive under
  `components/primitives/**`; D4.3a cleared the shared
  `SearchInput` producer, D4.3b cleared `UnlockScreen`, and D4.3c cleared `TagInput` by routing
  each through `TextInput`; D4.3j cleared `ModelAuthStep` by routing API-key input through
  `TextInput` and auth-method radios through `RadioField`; D4.3k cleared `GroupDetailModal` by
  routing subject/description/ephemeral controls through `TextInput`, `TextArea`, and `SelectInput`;
  D4.3l cleared the ConfigStep enabled-plugin checkbox through `CheckboxField`; D4.3m cleared
  ScheduleComposerModal by routing its text, media, datetime, and cron fields through `TextInput`
  and `TextArea`; D4.3n cleared `HistoryTab` by routing its reply composer through `TextArea`;
  D4.3o cleared `Inbox` by routing its message composer through `TextArea`; D4.3p cleared
  `ConfigEditDialog` by routing boolean, number, enum, text, long-text, and JSON inspection fields
  through `CheckboxField`, `NumberInput`, `SelectInput`, `TextInput`, and `TextArea`.
  Remaining count movement must be classified as exemption-movement vs consumer-migration before
  any inventory or baseline ratchet.
- **Autofix:** no (prop surfaces differ). **Phase:** P2. **Entry:** shadow.

### soup/no-adhoc-modal

- **Purpose:** all dialog surfaces render through the P2 `Modal` primitive (+ `useDismissable`).
  Today 11 dialog surfaces, 9 hand-rolled Escape effects, 3 surfaces with no Escape, 0 focus traps,
  double-close on stacked modals (inconsistency-register P1-2; control-catalogue §9 table).
- **Mechanism:** two selectors + one custom check: (a) `Literal[value=/c-dialog-backdrop/]` outside
  the Modal primitive file; (b) `JSXAttribute[name.name="role"][value.value="dialog"]` outside
  primitives; (c) custom rule flags `fixed inset-0` + overlay-background class combinations
  (catches the hand-rolled backdrop, `console/src/components/KeyboardShortcutsHelp.tsx:20-22`).
- **Scope:** `console/src/**` minus `components/primitives/Modal.tsx`. Per-surface enablement as
  each of the 11 migrates (list in cutover plan §3 P2).
- **Violation / valid:** `<div className="c-dialog-backdrop" onClick=…><div role="dialog" …>` →
  `<Modal width="confirm" onClose=…>…</Modal>`.
- **FP strategy:** the three detection prongs each anchor on dialog-specific markers; non-modal
  overlays (toasts, dropdown panels) match none of them. Toast stack keeps its own waiver until
  the z-index token fix lands (`console/src/hooks/use-toast.tsx:44` hardcodes `z-[110]`,
  control-catalogue §10).
- **Autofix:** no. **Phase:** P2. **Entry:** shadow.

### soup/no-legacy-tokens

- **Purpose:** after P1/P2, the legacy dark-only vocabulary is dead: `var(--color-d0..d6)`,
  `var(--color-t1..t5)`, `var(--b1..b4)` raw refs and the generated utilities `bg-d*`, `text-t*`
  (token-census §1, §2, §8 — `--b1..--b4` are white-alpha, dark-only by construction,
  `console/src/index.css:73-76`). New code must use the v2 semantic vocabulary
  (`--surface-base/raised/inset/overlay`, `--text-1..3`, `--border-hairline/subtle/strong`, status
  `--ok/--warn/--crit` families — names verified in `docs/design-system/02-directions/iterations/v2.html`).
- **Mechanism:** selectors `Literal[value=/var\(--color-[dt]\d\)/]`,
  `Literal[value=/var\(--b[1-4]\)/]`, `Literal[value=/\b(bg-d[0-6]|text-t[1-5]|border-t[1-5])\b/]`;
  template-literal variants via custom rule (the className-in-template-literal evasion, DUP-08).
- **Scope:** `console/src/**`. **Enabled only at P2+ completion** — during P0/P1 the legacy names
  are the *alias layer* and must keep working (cutover plan §3 P0). Enabling earlier would fight
  the migration.
- **Violation / valid:** `className="bg-d2 c-border rounded-lg"` →
  `className="surface-raised border-hairline rounded-md"` (exact utility names per T6
  `03-spec/tokens.md`).
- **FP strategy:** the regexes anchor on the exact legacy namespace; `--dot-*`, `--sp-*` etc. do
  not match. CSS-side equivalents covered by the section 5 grep (ESLint cannot see index.css).
- **Autofix:** yes — mechanical alias rewrite, ideal codemod (cutover plan: codemods/token adapters
  are the only allowed migration mechanics).
- **Phase:** P2-complete gate, enforced through P3. **Entry:** proposed.

### soup/no-raw-color

- **Purpose:** no hex/rgb()/rgba()/hsl() literals outside token source files. Largely live today:
  hex (`console/eslint.config.js:115-117`), rgba (`:111-113`), hsl + hsl-template
  (`:576-583`), named keywords (`:562-564`), plus the stricter hex-anywhere ratchet selector
  (`:590-593`).
- **Mechanism:** port the existing selectors into the soup/* namespace unchanged; add the
  template-literal and ConditionalExpression shapes (current selectors match `Literal` only —
  duplication-register DUP-08 evasion paths 1 and 3).
- **Scope:** all TSX/TS. Token source exemption: `console/src/index.css` (CSS not linted by ESLint
  anyway) and any generated token TS module the P1 work introduces.
- **Violation / valid:** `color: '#fc8181'` → `color: 'var(--crit)'` (v2 vocabulary).
- **FP strategy:** mature — these selectors have been live with `--max-warnings 0`; known
  legitimate escapes are documented block-scoped lint-suppression directives with reason + expiry
  (`console/src/lib/chart-utils.ts:10,:14`; `console/src/components/QrDisplay.tsx:17`), which
  migrate to the waiver registry (section 4).
- **Autofix:** partial (exact-value → token table lookup, like the cheat sheet at
  `console/eslint.config.js:12-74`). **Phase:** P1 (re-pointed at the new token names). **Entry:**
  scoped-error (already live).

### soup/no-untokenized-values

- **Purpose:** no hardcoded spacing/sizing/radius/shadow/z-index/opacity/filter/type-size values. The 106
  existing selectors already cover the `Literal`/`style`-attribute shapes
  (`console/eslint.config.js:157-191` spacing/sizing, `:95-106` radius, `:459-466` shadow,
  `:481-488` z-index, `:544-551` opacity, `:227-229` arbitrary px utilities). DUP-08's observed
  evasion shapes are closed: `HeartbeatStrip.tsx` is tokenized, `Skeleton.tsx` uses tokenized
  widths, `PipelineTab.tsx` uses tokenized padding, `ChartPanel.tsx` uses tokenized body heights,
  and selector coverage pins re-entry for template-literal, conditional, dimensional-const, and
  inline Recharts `wrapperStyle`/`contentStyle` fontSize branches.
- **CSS-side coverage:** `check-design-burndown.mjs` owns CSS-only gaps that ESLint cannot see,
  including `raw-font-size-css` (zero ceiling) for non-token `font-size:` literals and `font:`
  shorthands outside the primitive type scale and `transition-all-css` (zero ceiling) for CSS
  shorthand/longhand
  transition declarations that target `all`. It also tracks `raw-dimension-css` for direct raw
  CSS layout/spacing/radius lengths outside token files, ignoring `var()` fallbacks so resilient
  token fallbacks do not dominate the debt signal.
- **Mechanism:** keep the selector wall; `TemplateLiteral` quasis now catch arbitrary utility values
  with non-`var()` payloads and hardcoded dimensional px formulas, and `ConditionalExpression`
  branches now catch static hardcoded px values in dimensional style positions. Dimensional consts
  initialized from raw numeric conditional branches are rejected before they flow into style props.
  Inline Recharts `wrapperStyle`/`contentStyle` fontSize objects are included in the style-prop
  attribute set; shared chart style helpers remain explicit waiver-tracked constants where Recharts
  cannot accept classes.
- **Scope:** all TSX. Exemptions stay where they are today via documented waivers (recharts
  `CHART_MARGIN`, QR `margin: 2`).
- **Violation / valid:** `const height = expanded ? 240 : 140; … style={{ height }}` →
  `style={{ height: expanded ? 'var(--chart-h-lg)' : 'var(--chart-h-sm)' }}` with the two tokens
  added to the spec.
- **FP strategy:** one-hop-only identifier resolution keeps the rule predictable; everything it
  cannot prove is ignored (under-blocking beats false positives — the section 5 greps backstop).
- **Autofix:** no for evasion shapes; yes for the existing exact-value selectors (cheat-sheet
  mapping). **Phase:** P1. **Entry:** scoped-error (already live for Literal shapes).

### soup/no-transition-all

- **Purpose:** `transition-all` repaints everything and bypasses the motion token contract; banned.
  Already live: `console/eslint.config.js:126-128` (plus `transition-colors` `:122-124`,
  `transition-opacity` `:130-132`, `duration-*` `:134-136`).
- **Mechanism:** keep existing selectors; add `TemplateLiteral` quasi variant; CSS-side
  parser-backed `transition-all-css` burndown category for `transition: all` and
  `transition-property: all`.
- **Scope:** all TSX + CSS check. No exemptions.
- **Violation / valid:** `className="transition-all hover:bg-d3"` → motion class from the v3
  interaction spec (`c-hover` family today; `03-spec/motion.md` names at P5).
- **FP strategy:** word-boundary regex, mature in production. **Autofix:** yes (class
  substitution). **Phase:** P5 re-validation. **Entry:** global-error (already live).

### soup/no-infinite-animation

- **Purpose:** the locked motion strategy allows exactly one ambient animation budget: ok-breathing
  (decision-log G2: "single ambient budget on ok-breathing, crit-blink rejected"; ambient band
  1200-2400ms per synthesis-seed-3). Current infinite animations in CSS:
  `console/src/index.css:308` (`breathe-ring 3s … infinite`), `:328` (`typing-bounce 1.2s …
  infinite`), `:332` (`breathe 3s … infinite`), `:730` (`shimmer 1.5s infinite`).
- **Mechanism:** TSX side — selector `Property[key.name="animation"][value.value=/infinite/]` plus
  `Literal[value=/animate-(breathe|shimmer|spin|pulse)/]` allowlist check; CSS side — section 5
  `rg` for `infinite` with an allowlist file listing the sanctioned token (the ok-breathing
  keyframe name fixed by `03-spec/motion.md`).
- **Scope:** all TSX + CSS. **Exemptions:** the single sanctioned ok-breathing token; the loading
  shimmer and typing indicator need explicit spec disposition at P5 (either absorbed into the
  sanctioned set with named tokens or replaced) — until then they hold waivers with expiry.
- **Violation / valid:** new `animation: pulse 1s infinite` → use the sanctioned ambient token or
  no ambient motion.
- **FP strategy:** allowlist by keyframe name, not by duration. **Autofix:** no. **Phase:** P5.
  **Entry:** shadow.

### soup/no-focus-suppression

- **Purpose:** never remove focus affordance without a focus-visible replacement. Current state:
  TSX-level `outline-none` has been zeroed; the former Inbox and HistoryTab chat-composer carve-outs
  were retired by routing those composers through primitives without outline suppression. CSS-side
  raw `outline:none`/`outline:0` is also zeroed unless paired with a tokenized `:focus-visible`
  outline replacement.
- **Mechanism:** selector `Literal[value=/\boutline-none\b/]` (+ template-literal variant) flagging
  unless the same className string contains `focus-visible:`; CSS-side
  `soup/no-raw-css-focus-suppression` in `check-design-resilience.mjs`, promoted by
  `design:resilience`, rejects raw suppression unless every selector in the reset has a
  `:focus-visible` block with `outline: ... var(--focus-ring)` and `outline-offset`.
- **Scope:** TSX className utilities plus CSS under `console/src`. Exemption: none beyond the
  focus-visible-pairing escape.
- **Violation / valid:** `className="… outline-none …"` →
  `className="… focus-visible:ring-[var(--focus-ring)] …"` or rely on the global ring by not
  suppressing. `.bad { outline: none; }` → `.bad:focus-visible { outline: 2px solid
  var(--focus-ring); outline-offset: var(--bw-focus); }`.
- **FP strategy:** string-pairing check is conservative; composite classes that embed their own
  ring get registered in the rule's allowlist as primitives land. CSS selector matching is exact and
  intentionally conservative for grouped resets.
- **Autofix:** no. **Phase:** P2. **Entry:** TSX scoped-error plus CSS design-resilience error.

### soup/focus-visible-required

- **Purpose:** every interactive component must show a focus-visible treatment (seed-3 rule intent
  `interactive-needs-focus-visible`; WCAG 2.2 24px target floor travels with it per seed-2).
- **Mechanism:** custom rule, primitives-first: in `components/primitives/**`, any component
  rendering an interactive element (`button`, `a`, `input`, `select`, `textarea`, `[role=tab]`,
  `[role=menuitem]`) must either rely on the documented global ring (no suppression detected) or
  declare a `focus-visible:` class. Outside primitives the rule only fires on raw interactive
  elements — which soup/no-raw-button/-form-control already squeeze toward zero, so the closed
  system makes coverage structural rather than per-call-site.
- **Scope:** `components/primitives/**` strict; elsewhere advisory until raw-control bans reach
  global-error.
- **Violation / valid:** a custom `div role="button" tabIndex={0}` with no focus treatment →
  use `Button`, or add the ring class + key handlers.
- **FP strategy:** primitives-first scoping avoids whole-tree heuristics.
- **Autofix:** no. **Phase:** P2. **Entry:** shadow.

### soup/modal-must-restore-focus

- **Purpose:** focus returns to the invoking element on close (seed-3 rule intent
  `modal-must-restore-focus`). Today zero dialogs implement a focus trap or restore
  (control-catalogue §9: "No focus trap exists anywhere"; only `autoFocus` at
  `console/src/components/line-detail/CreateGroupModal.tsx:105`, `console/src/pages/Inbox.tsx:644`).
- **Mechanism:** structural, not heuristic: the `Modal` primitive owns trap + restore (via
  `useDismissable`), and a custom rule asserts (a) `Modal.tsx` contains the restore call (an exact
  marker function, e.g. `restoreFocusOnClose`) — a presence check pinned by unit test rather than
  AST cleverness; (b) soup/no-adhoc-modal guarantees no dialog exists outside Modal. The rule
  therefore reduces to "Modal exists, is tested, and is the only door."
- **Scope:** `components/primitives/Modal.tsx` + hook. Companion tests required (cutover plan §3
  P2 acceptance): trap cycles Tab, Escape closes one layer only (fixes the GroupDetailModal +
  ConfirmDialog double-close, ia-workflow-review §5.1), focus restores to invoker.
- **Violation / valid:** Modal without restore marker → implement per `03-spec/interaction.md`.
- **FP strategy:** n/a (presence check). **Autofix:** no. **Phase:** P2. **Entry:** proposed.

### soup/motion-needs-reduced-variant

- **Purpose:** every animation has reduced-motion behavior; the locked rule is off-and-instant,
  not slower (decision-log G2; seed-2). Today only the feed family is covered
  (`console/src/index.css:485-486`); breathe/breathe-ring/typing/shimmer/msg-slide-in/wizard-check
  are not inside any `prefers-reduced-motion` guard.
- **Mechanism:** CSS-side script (section 5): parse `console/src/index.css` (and successor token
  files) for `@keyframes` names and `animation:` properties; assert each animated class either
  appears inside a `prefers-reduced-motion: reduce` override or matches the global kill rule the
  P5 work introduces (spec direction: one global `@media (prefers-reduced-motion: reduce)` block
  zeroing animation/transition durations, with the allowlist for opacity-only fades). TSX-side:
  framer-motion usage (dependency present, `console/package.json` deps) must pass
  `useReducedMotion` gating — custom rule flags `motion.` component usage in files that never
  import `useReducedMotion`.
- **Scope:** CSS + TSX. Exemption: opacity-only fades under 200ms (seed-2 `linear` opacity rule).
- **Violation / valid:** new keyframe with no reduced handling → covered by the global kill block
  or explicit override.
- **FP strategy:** global-kill-block design makes per-animation false negatives structurally
  impossible; the script just proves the block exists and is last in cascade.
- **Autofix:** no. **Phase:** P5. **Entry:** shadow.

### soup/no-literal-status-colors

- **Purpose:** status is rendered only via semantic status tokens + canonical helpers; no
  per-domain status color tables. `status-severity.ts` owns reusable severity → color/wash/class
  helpers (`statusColorToken`, `statusWashToken`, `statusBadgeStyle`,
  `statusTextClassForSeverity`), while `status-map.ts` owns the shape-law renderer map.
- **Mechanism:** custom rule flags duplicated status-keyed object maps and status-like switch
  returns that contain status color literals (`var(--color-s-*)`, `var(--status-*)`,
  `var(--s-*-wash/ring/soft)`, or `text/bg/border-s-*`) outside the shared status helpers and
  primitives.
- **Scope:** `console/src/**` minus `lib/status-map.ts`, `lib/status-severity.ts`, and
  `components/primitives/**`.
- **Violation / valid:** `const colorMap = { online: 'var(--color-s-ok)', … }` → import
  `statusColorToken()`/`statusBadgeStyle()` from `lib/status-severity.ts`.
- **FP strategy:** the key-shape heuristic requires ALL keys to be from a status union and ALL
  values color-like — partial matches ignored.
- **Autofix:** no. **Phase:** P2. **Entry:** global-error.

### soup/provider-palette-only

- **Purpose:** keep provider identity out of status, mode, action, and chart data channels. Provider
  colours are the constrained exception in `color.md` §2.1 and must consume `--provider-*`.
- **Mechanism:** blocking source audit through `console/scripts/check-color-semantics.mjs` via
  `--fail-on-rule soup/provider-palette-only`. A later packet may port the stable cases to custom
  ESLint selectors, but the package script is already fail-closed for this zeroed lane.
- **Scope:** provider metadata, provider display contexts, provider legends, and provider-scoped
  chart series. Exempt token definition files; token values are governed by `tokens-v3.md` +
  contrast checks.
- **Violation / valid:** `PROVIDER_COLORS.codex.fill = 'var(--color-s-ok)'` →
  `PROVIDER_COLORS.codex.fill = 'var(--provider-codex)'`.
- **FP strategy:** true-positive and false-positive fixtures live in
  `tests/scripts/color-semantics.test.ts`; the package-script config is pinned to include this rule.
- **Autofix:** no. **Phase:** P4/G5. **Entry:** blocking script.

### soup/data-series-token-only

- **Purpose:** separate data dimensions from provider identity and status/mode semantics.
  FleetMetricsChart is fleet-aggregate message-volume data; it must not consume provider tokens.
- **Mechanism:** blocking source audit through `console/scripts/check-color-semantics.mjs` via
  `--fail-on-rule soup/data-series-token-only`. A later custom rule can replace the script after the
  chart category classifier stabilizes further.
- **Scope:** chart and heatmap components. Provider-scoped series may use `--provider-*`; message
  volume, token input/output, active-hour intensity, and other non-provider dimensions use
  `--data-*`.
- **Violation / valid:** `stroke="var(--color-m-cht)"` for inbound messages →
  `stroke="var(--data-inbound)"`.
- **FP strategy:** fixtures distinguish non-provider chart dimensions from lawful `--data-*` paths;
  later provider-legend/status-chart fixtures must accompany any classifier expansion.
- **Autofix:** no. **Phase:** P4/G5. **Entry:** blocking script.

### soup/traffic-neutrality

- **Purpose:** traffic quantities are neutral operational ink. Chromatic treatment is reserved for
  status/severity or explicitly classified data visualization, not raw volume numbers.
- **Mechanism:** blocking source audit through `console/scripts/check-color-semantics.mjs` via
  `--fail-on-rule soup/traffic-neutrality`; sent/received/sessions/media surfaces are now
  neutralized and covered by the scanner's metric classification.
- **Scope:** KPI strip, fleet table traffic columns, line summary traffic rows, and adjacent
  traffic counters. Lines connected, need attention, unread, failed, warning, and health metrics
  stay outside this rule because they carry status/severity.
- **Violation / valid:** `Messages Sent` with `color="text-m-cht"` → `color="neutral"` on
  `KpiCard`, direct semantic `--text-2` styling for raw values, or the approved neutral metric
  primitive.
- **FP strategy:** fixtures prove chromatic traffic KPIs fail while neutral traffic paths stay
  silent; status/severity KPI expansion needs its own paired fixture before scanner broadening.
- **Autofix:** no. **Phase:** P4/G5. **Entry:** blocking script.

### soup/no-component-local-palette

- **Purpose:** prevent duplicated colour truth in components after provider/data/status helpers
  exist.
- **Mechanism:** blocking slice of `console/scripts/check-color-semantics.mjs` via
  `--fail-on-rule soup/no-component-local-palette`. The package script also fail-closes the zeroed
  provider, data-series, and traffic lanes.
- **Scope:** all `console/src/**` TS/TSX files. Exempt the canonical transitional helper
  `console/src/lib/color-semantics.ts` and documented one-off visual test fixtures.
- **Violation / valid:** component `const colorMap = { 'text-s-ok': 'var(--color-s-ok)' }` →
  import the documented status/provider/data token helper. The transitional component-to-token
  SSOT is `console/src/lib/color-semantics.ts`; component and page files must not carry local
  colour maps while legacy token replacement is still in flight.
- **FP strategy:** `data-local-palette-exception` is temporary evidence only; durable exceptions
  require a lint-plan row and QA-hardening debt entry before promotion.
- **Autofix:** no. **Phase:** P4/G5. **Entry:** blocking script.

### soup/tabular-nums-required

- **Purpose:** tabular numerals in tables/dashboards/logs/metrics is v3 law (synthesis-seed-3
  typography). Current usage: zero occurrences of `tabular-nums` anywhere in `console/src` —
  whole-surface gap, not drift.
- **Mechanism:** practical enforcement is at the primitive layer: the `Table`, `KpiCard`,
  `LogStream` primitives bake `font-variant-numeric: tabular-nums` (or Tailwind `tabular-nums`)
  into their cell/value styles; custom rule asserts the marker class exists in those primitive
  files (presence check) and section 5 greps that metric-rendering composites (`c-data`,
  `c-kpi-value` successors) carry it. Per-call-site enforcement is not attempted.
- **Scope:** `components/primitives/Table.tsx`, `KpiCard`, `LogStream`, numeric typography
  composites. **Violation / valid:** numeric cell without tabular-nums → add to primitive style.
- **FP strategy:** presence-check design. **Autofix:** yes (add class). **Phase:** P4 (screens) /
  spec at T6. **Entry:** proposed.

### soup/no-unsafe-truncation

- **Purpose:** truncated text must still expose the full value. Long IDs, names, timestamps, and
  provider/model labels are operational data, not decorative copy.
- **Mechanism:** package-script fail-on-rule resilience script. Flag `truncate`, `whitespace-nowrap`, and
  ellipsis patterns unless the same element or adjacent wrapper provides `title`, `aria-label`,
  `data-full-value`, or a documented `data-truncation-exception` / `data-wrap-exception`.
  Generic `aria-describedby` helper/error text is not a proven full-value path; if a described
  node carries the full value, mark that node with `data-full-value`.
- **Scope:** `console/src/**` TSX/CSS. Exempt purely decorative brand marks and intentionally clipped
  generated visual assets when the exception names the visual proof artifact.
- **Violation / valid:** `className="truncate"` on a line name → add a full-value path, wrapping
  strategy, or primitive that owns the disclosure.
- **FP strategy:** fixtures must include a valid `title`/`data-full-value` case, a generic
  `aria-describedby` false-negative trap, an invalid bare truncation case, and an allowed
  visual-brand exception.
- **Autofix:** no. **Phase:** P4/G7. **Entry:** package-script fail-on-rule; promoted
  2026-06-14 after the inventory reached zero.

### soup/scroll-owner-required

- **Purpose:** every scrollable space must have exactly one visible owner and axis min-size proof so
  panels do not create hidden nested scroll traps.
- **Mechanism:** package-script fail-on-rule resilience script. Flag `overflow-auto`, `overflow-scroll`,
  `overflow-x-*`, and `overflow-y-*` without `min-h-0` / `min-w-0` proof or a
  `data-scroll-owner` / `soup-scroll-owner-ok` exception.
- **Scope:** scroll containers in route shells, modals, drawers, lists, tables, logs, and wizard
  panes. Tiny icon scrollers are not exempt unless documented as non-content controls.
- **Violation / valid:** `<div className="overflow-y-auto">` → `<div data-scroll-owner="inbox-list"
  className="min-h-0 overflow-y-auto">`.
- **FP strategy:** fixtures must distinguish axis-specific x/y scroll, nested scroll with one named
  owner, and invalid unnamed nested scroll.
- **Autofix:** partial (`min-h-0`/`min-w-0` suggestions only). **Phase:** P4/G7. **Entry:**
  package-script fail-on-rule; promoted 2026-06-14 after the inventory reached zero.

### soup/no-layout-shift-interaction

- **Purpose:** hover, focus, active, selected, and pressed states must not change component geometry.
  Stable controls are required for dense operational scanning and keyboard use.
- **Mechanism:** package-script fail-on-rule resilience script. Flag hover/focus/active classes or
  CSS selectors that change width, height, min/max dimensions, margin, padding, gap, basis, grid
  tracks, or border width.
- **Scope:** buttons, cards, rows, tabs, chips, toolbar controls, table rows, and list items. Motion
  transforms are evaluated separately by reduced-motion rules.
- **Violation / valid:** `hover:px-[var(--sp-4)]` → reserve the expanded width up front or reveal
  affordances with opacity/transform inside stable bounds.
- **FP strategy:** fixtures must include stable opacity/transform reveal, invalid padding growth, and
  a tokenized exception for deliberate drag/resize handles.
- **Autofix:** no. **Phase:** P4/G7. **Entry:** package-script fail-on-rule; promoted
  2026-06-14 after the inventory reached zero.

### soup/no-hover-only-content

- **Purpose:** content revealed on hover must also be reachable by keyboard, touch, and assistive
  technology. Hover-only commands are hidden commands.
- **Mechanism:** package-script fail-on-rule resilience script. Flag `hover:` / `group-hover:` reveal patterns
  without `focus:`, `focus-visible:`, `group-focus-within:`, always-visible small-screen handling,
  or `data-hover-only-exception`.
- **Scope:** row actions, card actions, toolbars, copy buttons, menus, popovers, and inline metadata.
- **Violation / valid:** `group-hover:opacity-100 opacity-0` → pair with
  `group-focus-within:opacity-100` and a real focusable trigger.
- **FP strategy:** fixtures must include hover+focus parity, hover-only invalid reveal, and a
  documented decorative-only exception.
- **Autofix:** partial suggestion only. **Phase:** P4/G7. **Entry:** package-script fail-on-rule;
  promoted 2026-06-14 after the inventory reached zero.

### soup/no-vw-font-size

- **Purpose:** type follows the tokenized type scale. Viewport-width font sizing breaks dense panels,
  long labels, reduced-height views, and user zoom.
- **Mechanism:** package-script fail-on-rule resilience script. Flag `text-[...vw]`,
  `font-size: ...vw`, `clamp(...vw...)`, and equivalent viewport-relative type declarations.
- **Scope:** `console/src/**` and checked-in brand assets. Exempt generated bitmap proofs; SVG/HTML
  identity assets still need tokenized min/max sizing if they are product UI.
- **Violation / valid:** `font-size: 8vw` → tokenized display/body scale with container max width and
  line-height tokens.
- **FP strategy:** fixtures must include invalid viewport type, valid tokenized clamp without vw, and
  a non-UI generated artifact exception.
- **Autofix:** no. **Phase:** P4/G7. **Entry:** package-script fail-on-rule; promoted
  2026-06-14 after the inventory reached zero.

### soup/no-static-viewport-height

- **Purpose:** full-height surfaces must account for mobile dynamic browser chrome. Static `vh` and
  Tailwind `h-screen` shorthands can clip modal footers, unlock screens, and other fixed-height
  surfaces when the browser viewport expands or contracts.
- **Mechanism:** package-script fail-on-rule resilience script. Flag raw `Nvh` values and
  `h-screen` / `min-h-screen` / `max-h-screen`; `dvh` forms are valid.
- **Scope:** `console/src/**` CSS/TS/TSX.
- **Violation / valid:** `min-h-screen` or `max-h-[85vh]` -> `min-h-dvh` or `max-h-[85dvh]`.
- **FP strategy:** fixtures cover invalid Tailwind screen-height shorthand, invalid arbitrary/static
  `vh`, valid `dvh`, and the real-source inventory pinned to zero.
- **Autofix:** mechanical when the value maps directly (`vh` -> `dvh`, `*-h-screen` -> `*-h-dvh`).
  **Phase:** P4/G7. **Entry:** package-script fail-on-rule; promoted 2026-06-15 after the two
  outliers migrated and the inventory reached zero.

### soup/layer-owner-required

- **Purpose:** layering must use the `--z-*` contract so modals, popovers, toasts, drawers, and
  sticky bars do not fight through raw z-index literals.
- **Mechanism:** resilience script promoted in the package script with
  `--fail-on-rule soup/layer-owner-required`. Flag `z-[...]`, `z-50`-style utilities, and raw
  `z-index` declarations unless they use a `--z-*` token or carry `data-layer-owner` /
  `soup-layer-ok` evidence. All current `check-design-resilience.mjs` lanes are now promoted with
  explicit `--fail-on-rule` flags after their inventories reached zero.
- **Scope:** overlay, sticky, floating, and portal surfaces in `console/src/**`.
- **Violation / valid:** `className="z-[999]"` → `className="z-[var(--z-modal)]"` or a primitive
  prop that owns the layer.
- **FP strategy:** fixtures must include valid tokenized layer, invalid literal layer, and a portal
  fixture that proves the owner annotation is not a bypass for arbitrary literals.
- **Autofix:** partial literal-to-token suggestions only when mapping is exact. **Phase:** P4/G7.
  **Entry:** blocking script.

### soup/no-raw-viewport-js

- **Purpose:** viewport branching has one owner. Components must not hand-roll breakpoint or placement
  decisions from `window.innerWidth`, `window.innerHeight`, `window.matchMedia`, or global
  `matchMedia`; those reads belong in a sanctioned `useBreakpoint` / `useViewportPlacement` helper.
- **Mechanism:** package-script fail-on-rule resilience script plus an exact real-source inventory
  test. The package script fails on new component-local raw viewport reads.
- **Scope:** `console/src/**`, excluding the sanctioned hook/helper owners
  `console/src/hooks/useBreakpoint.*` and `console/src/hooks/useViewportPlacement.*`.
- **Violation / valid:** `const clipped = rect.left + w > window.innerWidth` in a component ->
  delegate to a viewport placement helper; raw viewport reads inside the helper are valid.
- **FP strategy:** fixtures cover invalid component-local reads, valid sanctioned-owner hook reads,
  and the real-tree inventory pinned to zero.
- **Autofix:** no. **Phase:** P4/G7. **Entry:** package-script fail-on-rule; promoted 2026-06-15
  after the `MessageBubble` placement read migrated to `useViewportPlacement` and the real-source
  count reached zero.

### soup/no-duplicate-shell

- **Purpose:** stop new panel/toolbar/modal shells re-rolling existing primitives — the dominant
  historical failure (duplication-register DUP-04/05: 5 ad-hoc `bg-d2` dialog shells, 4 card
  recipes; "class-string combinations of approved utilities are invisible to all selectors").
- **Mechanism:** advisory custom rule (warn ceiling, never error): flag className strings
  containing a surface class + border class + radius class together (`(bg-d\d|surface-\w+).*
  (c-border|border-hairline).*(rounded-(md|lg))` and permutations) outside primitives, with the
  message routing to the duplication register: "this composes a panel shell — use Card/Panel/Modal
  or file a new-primitive request (cutover plan §7)".
- **Scope:** screens and components outside `components/primitives/**` and the migrated composites.
- **FP strategy:** warn-only forever; heuristic by design. Promotion ceiling is
  warn-on-changed-files.
- **Autofix:** no. **Phase:** P2. **Entry:** shadow (advisory).

### soup/theme-parity (script, not ESLint)

- **Purpose:** every semantic token is defined in both theme scopes; dual-theme is the core v3
  mandate (inconsistency-register P1-3). Scriptable as a grep/parse pass because tokens live in
  CSS.
- **Mechanism:** node script `console/scripts/check-theme-parity.mjs` (P6): extract `--token:`
  names from the dark scope and the light scope (`[data-theme="dark"]` / `[data-theme="light"]`
  or `:root` + override block, per the P0 file split), diff the sets both directions, exit nonzero
  on any asymmetry; also assert zero raw hex/rgba in the *semantic* tier files (semantic aliases
  must point at primitives, never restate values — the failure mode that produced 14 hand-copied
  rgba tints, token-census §4).
- **Integration:** runs in section 5 suite, pre-push and CI. **Phase:** P1. **Entry:** shadow
  until the light scope exists, then CI-blocking.

### soup/icon-family

- **Purpose:** one icon family — Lucide only (research-digest law restated in seed-4: "one icon
  family"). Current state clean: `lucide-react` is the sole icon dependency
  (`console/package.json`), no other icon imports found.
- **Mechanism:** selector `ImportDeclaration[source.value=/icon|@heroicons|@tabler|react-icons|
  @phosphor|@radix-ui/react-icons/]` (cheap denylist); allowlist `lucide-react`. Companion:
  the existing strokeWidth rule (`console/eslint.config.js:569-571`) stays.
- **Scope:** all TSX/TS. Exemption: inline SVG for the brand nameplate/favicon only (brand assets
  are not icons).
- **Violation / valid:** `import { XMarkIcon } from '@heroicons/react'` → `import { X } from
  'lucide-react'`.
- **FP strategy:** denylist of known icon packages, not a generic heuristic.
- **Autofix:** no. **Phase:** P1. **Entry:** scoped-error (zero baseline).

### soup/no-utility-smell

- **Purpose:** G2 mandatory resolution item 3: `.w-160`/`.mt-3`-style single-property utility
  one-offs are spec-smell — composition-level primitives required instead (decision-log G2
  conditions; v2.html self-critique item 3). Tripwire for arbitrary-value utility accretion.
- **Mechanism:** selector `Literal[value=/\b(w|h|mt|mb|ml|mr|px|py|p|m)-\[(?!var\()[^\]]+\]/]`
  (arbitrary-value utility whose payload is not a `var()`) — this generalizes the existing px-only
  rule (`console/eslint.config.js:227-229`) to all non-token payloads (rem, %, calc with raw
  values); plus custom-rule count: more than 3 arbitrary-value utilities in one className string
  flags "compose a primitive instead".
- **Scope:** all TSX. Exemptions: `var()` payloads (the sanctioned pattern), grid-template strings
  pending their own tokens.
- **Violation / valid:** `className="w-[160px] mt-[3px]"` → width token + spacing token, or a
  primitive prop.
- **FP strategy:** the not-var() anchor exempts every sanctioned usage by construction.
- **Autofix:** partial (px→token table). **Phase:** P2. **Entry:** shadow.

### soup/no-format-bypass

- **Purpose:** timestamps/counts format through `console/src/lib/format-time.ts` and
  `console/src/lib/text-utils.ts` only (DUP-13: raw epoch/date `toLocale*` bypass sites; DUP-14:
  `formatCompact` vs exact count formatting mixed ad hoc).
- **Mechanism:** selector `CallExpression[callee.property.name=/^toLocale(Date|Time)?String$/]`
  outside `console/src/lib/**`; implemented as a custom rule so computed member access is covered
  too.
- **Scope:** `console/src/**` minus `lib/`. The helper surface owns ISO/SQLite timestamps, epoch
  seconds, short/long date labels, compact numbers, and exact count grouping.
- **Violation / valid:** `new Date(epoch * 1000).toLocaleString()`
  (`console/src/components/line-detail/ScheduledMessageRow.tsx:107`) → `formatFullTime(epoch)`.
- **FP strategy:** lib-directory exemption is the entire policy; no heuristics.
- **Autofix:** partial. **Phase:** P3. **Entry:** global-error.

### soup/no-inline-dismiss-handler

- **Purpose:** Escape/outside-click dismissal exists only inside `useDismissable` (DUP-03/04:
  9 copy-pasted Escape `useEffect` blocks enumerated at duplication-register DUP-04; 2 outside-
  click copies; 2 surfaces with none).
- **Mechanism:** custom rule: flag `event.key`/`e.key` comparisons to `'Escape'` inside `useEffect`
  callbacks in any file except `console/src/hooks/use-dismissable.ts` and the keyboard-shortcuts
  hook (`console/src/hooks/use-keyboard-shortcuts.ts`, which owns global shortcuts). Inline
  component keyboard handlers are not part of this rule; they remain covered by behavior tests.
- **Scope:** `console/src/**` with the two exemptions above.
- **Violation / valid:** local `if (e.key === 'Escape') close()` effect → `useDismissable(ref,
  onClose)`.
- **FP strategy:** the two named exemptions cover every legitimate global handler; per-component
  key handling for non-dismiss purposes (e.g. list navigation) compares other keys and never fires.
- **Autofix:** no. **Phase:** P2 (lands with the hook). **Entry:** global-error.

Catalog count: 22 rules (20 ESLint-side: 18 soup/* AST/selector rules + 2 presence-check custom
rules; 2 script-side: theme-parity, motion-reduced CSS pass).

## 4. Waiver / exception policy

Adopted verbatim from synthesis-seed-2 (5 mandatory fields) and extended:

Every waiver MUST carry:

1. **owner** — a person/agent handle accountable for removal
2. **reason** — why the rule cannot be satisfied here (technical, not "later")
3. **scope** — exact files/lines or a single rule+directory pair; no wildcards wider than one
   directory
4. **expiry** — ISO date; **expired waivers fail CI** (the check-suite script compares dates)
5. **replacement plan** — the concrete change that retires the waiver

Plus two qualifiers: **safer-alternative-considered** (one line naming the alternative and why it
was rejected) and **status: temporary | permanent**. Permanent waivers are exceptional and require
the new-primitive/spec-change route (cutover plan §7) — "no permanent waivers" is the default
posture; a permanent entry must cite the spec section that sanctions it.

Rules of engagement:

- **No silent inline disables.** A lint-suppression directive in source is only valid when its
  trailing comment carries `waiver:<id>` referencing a registry entry. The repo already has the
  embryo of this convention — existing block-scoped suppressions carry reason + expiry inline
  (`console/src/lib/chart-utils.ts:10` "recharts margin accepts raw pixel offsets … expires
  2026-12-31"; `console/src/components/QrDisplay.tsx:17` "margin:2 is QRCode library option …
  expires 2026-12-31"). P6 migrates these to registry entries WVR-001/WVR-002/WVR-003.
- The check-suite script greps for lint-suppression directives missing a `waiver:` tag and fails.
- Documentation location: registry file below; the inline tag is a pointer, never the record.

Registry file: `console/eslint-waivers.yaml` (YAML, one document, schema-checked by the suite):

```yaml
# console/eslint-waivers.yaml
waivers:
  - id: WVR-001
    rule: soup/no-untokenized-values
    owner: console-maintainer
    reason: recharts margin prop takes raw SVG pixel offsets, not CSS lengths
    scope:
      - console/src/lib/chart-utils.ts
    expiry: 2026-12-31
    replacement_plan: wrap recharts margins in a CHART_MARGIN token adapter at P3
    safer_alternative_considered: CSS-var indirection — rejected, recharts reads numbers pre-render
    status: temporary
  - id: WVR-002
    rule: soup/no-untokenized-values
    owner: console-maintainer
    reason: QRCode library margin option counts cells, not px
    scope:
      - console/src/components/QrDisplay.tsx
    expiry: 2026-12-31
    replacement_plan: none needed if rule gains an option-object exemption at P6
    safer_alternative_considered: none exists — third-party numeric API
    status: temporary
```

## 5. Design-regression check suite

Greppable checks runnable locally and in CI, packaged as `console/scripts/design-regression.sh`
(P6). Each check prints matches and exits nonzero on unexpected hits. Exact patterns (rg, run from
repo root):

| # | Check | Command | Expectation |
|---|---|---|---|
| 1 | Raw hex colors in TSX/TS | `rg -n "#[0-9a-fA-F]{3,8}\b" console/src --type-add 'tsx:*.tsx' -t ts -t tsx` | only waivered lines |
| 2 | Raw rgb()/hsl() in TSX + CSS semantic tier | `rg -n "rgba?\(|hsla?\(" console/src/components console/src/pages console/src/lib` | zero after P1 (primitive tier file exempt) |
| 3 | Legacy token refs (post-P2 gate) | `rg -n "var\(--color-[dt][0-9]\)|var\(--b[1-4]\)" console/src` | zero at P2-complete |
| 4 | Legacy utilities (post-P2 gate) | `rg -n "\b(bg-d[0-6]|text-t[1-5])\b" console/src` | zero at P2-complete |
| 5 | WhatSoup in UI copy | `rg -n "WhatSoup" console/src --glob '!**/*.test.*'` then filter to non-comment, non-contract lines via the script's allowlist (contract list from soup/protected-identifiers) | only EXEMPT-PROTECTED sites after P4 |
| 6 | Split-wordmark evasion | `rg -n -U ">What<.{0,80}>Soup<" console/src` | zero after P4 |
| 7 | Soup Kitchen label | `rg -n "Soup Kitchen" console/src docs/console-guide.md` | zero after P4 (vocabulary: Fleet) |
| 7a | Channel-specific generic copy | `rg -n "WhatsApp" console/src console/index.html docs/console-guide.md` then filter to protected runtime/prompt contexts via the `soup/no-channel-specific-copy` allowlist | only EXEMPT-PROTECTED protocol/runtime/setup-prompt contexts after G7 |
| 8 | index.html title | `rg -n "<title>" console/index.html` | equals the P4-specced title |
| 9 | Theme parity | `node console/scripts/check-theme-parity.mjs` | both theme scopes define identical semantic-token name sets |
| 10 | Protected contracts still present | `rg -c "whatsoup:" console/src/lib/preferences.ts && rg -c "/run/whatsoup/" console/src/mock-data.ts && rg -c "whatsoup/instances" console/src/lib/agent-cwd.ts` | each count >= 1 (presence check) |
| 11 | Undocumented variants / utility smell | `rg -n "\b[wh]-\[(?!var\()" console/src --pcre2` and `rg -n "rounded-\[(?!var\()" console/src --pcre2` | only waivered |
| 12 | Focus suppression | `rg -n "outline-none" console/src` minus lines also matching `focus-visible:` | zero after P2 |
| 13 | Infinite animation allowlist | `rg -n "infinite" console/src/index.css` (and successor token/component CSS) | only the sanctioned ok-breathing + waivered shimmer/typing until P5 disposition |
| 14 | Expired waivers | script compares `expiry:` dates in `console/eslint-waivers.yaml` to today | none expired |
| 15 | Lint-suppression waiver registry sync | `node console/scripts/check-waiver-sync.mjs` checks TS/TSX lint-suppression directives for registered `waiver:WVR-*` tags and verifies registry scopes point at the tagged source file | zero untagged suppressions, unknown source WVR ids, or stale TS/TSX registry scopes |

Each rule must also carry either a negative fixture or a documented negative example before it moves
to `scoped-error`. The required trap list is maintained in
`docs/design-system/06-implementation/qa-hardening.md` and includes raw colors, raw controls,
UI-facing WhatSoup copy, user-visible channel-specific copy, protected-identifier over-renames,
missing modal focus restoration, missing focus-visible treatment, color-only status, missing
light-theme token values, deprecated tokens in migrated directories, and utility/spec-smell classes.

Integration points:

- **Pre-commit (existing):** `lint-staged` → `eslint --max-warnings 0` on staged console TSX/TS
  (root `.husky/pre-commit`; `console/.husky/pre-commit`; config `console/package.json:6-10`).
  Unchanged — the soup/* rules ride this automatically once registered.
- **Design lint fixture coverage:** `npm --prefix console run design:lint-fixtures` verifies that
  implemented `soup/*` rules keep true-positive/false-positive fixtures and, when promoted, an
  error-severity probe. It is a promotion gate and must pass in any packet that adds, promotes,
  removes, or rewires a `soup/*` rule, selector, or lint-plan lifecycle row.
- **Pre-push (existing):** root `.husky/pre-push` → `scripts/pre-push-guard.ts`. P6 adds
  `bash console/scripts/design-regression.sh` invocation gated to pushes touching `console/`
  (mirror of the staged-files gating in root pre-commit).
- **Branch verify (existing):** `npm run verify:push:branch` (root `package.json:50`) gains the
  same script call at P6; `verify:release` (`:51`) already runs `npm --prefix console ci` +
  `npm --prefix console run build` and inherits the suite via the pre-push path.

## 6. Enforcement readiness scorecard

Grades: A (enforced + clean) / B (mechanism exists, partial adoption) / C (documented intent, no
mechanism) / D (neither). "Current" graded against the audited tree; "P6 must achieve" is the exit
bar for the enforcement phase.

| Dimension | Current grade | Evidence | P6 must achieve |
|---|---|---|---|
| SSOT clarity | C | tokens split @theme vs :root with no tier semantics (token-census §17: 50 vs 130); 60+ component constants in global :root (P1-6); two extractor-style styling dialects + BEM feed (P2-5) | B+: one token SSOT with tiered files (P0 split), theme-parity script green; A after P2 when composite classes have single owners |
| DRY improvement | C | 17 DUPs, 0 structurally guarded (duplication-register summary: 13/17 fully unguarded) | B: DUP-01..07, 12 closed by primitives with soup/no-raw-* + no-adhoc-modal at scoped-error; no-duplicate-shell advisory live |
| SOC boundaries | C | screens carry raw values + style forks (DUP-08: 125 style objects); helpers duplicated into components (DUP-07: 8 maps) | B: layer ownership map enforced via raw-control bans + no-literal-status-colors; screens import primitives only |
| Token discipline | B | 106-selector wall live and effective for Literal shapes; observed DUP-08/DUP-09 evasion paths are now pinned, with remaining JS style-helper escapes waiver-tracked | A-: broader dataflow custom rule, waiver registry replaces inline disables |
| Primitive coverage | C- | Button 82% adoption but 24 raw + 11 variants (P1-1); Modal/Pill/Select/Spinner primitives absent (P1-2, P1-5, DUP-11) | B+: Button/Modal/Pill/Select/Table/LogStream landed (P2) with per-directory scoped-error flips complete |
| Lint readiness | B- | wall exists, error-severity, husky-wired with --max-warnings 0; but zero custom rules, no soup/* namespace, no baseline tooling, stale plugin reference in program docs | A-: soup plugin registered, lifecycle table live, baselines collected, CI suite wired |
| Migration reversibility | C | no alias layer; legacy names ARE the only names | A at P0/P1: alias layer means every phase is a one-commit revert (cutover plan §5) |
| Exception control | C+ | inline disables exist with informal reason+expiry (chart-utils, QrDisplay) but no registry, no expiry enforcement | A: 5-field registry, expired-waiver CI failure, suppression-without-waiver check |
| Regression prevention | C | no brand guard, no theme-parity check, no shell-duplication tripwire; design tests exist ad hoc (tests/console/design-token-classes.test.ts, design-system-compliance-pages.test.ts) | B+: section 5 suite in pre-push + verify:push:branch; brand + parity checks blocking |
| A11y enforcement | D+ | global focus ring exists (index.css:1173-1183) but 0 focus traps, 3 modals missing Escape, false "Esc to close" copy (KeyboardShortcutsHelp.tsx:53), no reduced-motion coverage outside feed | B: Modal trap/restore tested, focus-suppression + reduced-variant rules at error, 24px floor specced in primitives |
| Theme-parity enforcement | D | no light theme; border ramp white-alpha dark-only (index.css:73-76) | B+: parity script blocking; A when both themes ship (P1) and stay symmetric |
| Documentation usefulness | B | error messages are self-contained fix recipes + cheat sheet (eslint.config.js:12-74, 673-683) — genuinely good prior art | A: same recipe discipline for every soup/* message; rule catalog cross-links to spec sections |
| Post-cutover maintainability | C | drift pressure proven (Ops vs LogsTab twins already diverged, DUP-10) with no structural counterforce | B+: closed-system design (raw-control bans) + advisory shell tripwire + waiver expiry keep entropy bounded; quarterly lifecycle-table review |

---

Changelog: 2026-06-11 — initial plan (T7). Contradictions found during evidence collection are
recorded in the T7 report and in `docs/design-system/05-cutover/branding-touchpoints.md` §5.

Changelog: 2026-06-12 — lifecycle table brought to post-flip truth (the D6 evidence packet
found the table never recorded the flips; this entry closes that finding). States verified
against the live impl tree (`console/eslint.config.js`, `console/eslint.config.shadow.mjs`,
`console/eslint-rules/design-selectors.mjs` — the shared selector SSOT both configs import,
landed `ba4ed643`):
- **Group S** (soup/no-raw-table, no-raw-sortable-header, no-legacy-log-lanes — three rules
  added post-T7 as C2.3 shadow tripwires; rows added to the table above): global-error
  outside `components/primitives/**` (the canonical-renderer exemption), re-carried through
  every later-match config block.
- **Group F** (soup/no-focus-suppression): scoped-error console-wide with no carve-outs. The Inbox
  composer carve-out was retired at B4 close (`9bfde5c3`), and the HistoryTab carve-out was retired
  when its reply composer moved to `TextArea` without `outline-none`.
- **Group M** (soup/no-raw-button, soup/no-adhoc-modal): scoped-error across the current
  10-file M list — AddLineWizard.tsx (joined at B3 wave 4 `061986ee`), pages/LineDetail.tsx,
  pages/SoupKitchen.tsx, TagInput.tsx, CardSelector.tsx, ConfirmDialog.tsx, RelinkModal.tsx,
  SaveContactDialog.tsx, UpdateModal.tsx (joined at B3 wave 3 `d73bef54`), plus
  line-detail/CreateGroupModal.tsx in the full-union block 4b. The ad-hoc-modal shadow set is
  EMPTY console-wide since wave 4. Both rules remain shadow-tracked outside the M list. The
  M selectors were promoted into `structuralSelectors` (Group S) on 2026-06-15, so the legacy
  `migratedSurfaceSelectors` export went empty (`[]`); that dead export and its two no-op
  block-4a/4b spreads were removed (lint output unchanged — the empty spread was a no-op).
- **Group P** (soup/no-legacy-tokens, soup/no-utility-smell): scoped-error inside
  `components/primitives/**` (born-clean tier); both remain shadow outside primitives.
- **Shared design verification chain**: CI-blocking — `npm run verify:console-design` runs in
  `verify:push:branch`, `verify:release`, quality.yml CI, and tag-release CI. It owns theme parity,
  token drift, contrast, shadow baseline, frozen shadow inventory, raw-form inventory, design
  regression/metrics/burndown, color semantics, resilience, font assets, brand assets, and
  design-lint fixture coverage.
- **Design-regression suite promotion state**: the section-5 suite has grown 15→16→20 checks
  (checks 1+8 made meaningful `db165001`; CSS tier-boundary checks 17–20 added `64332ce8`).
  Blocking set live in `design-regression.sh`: `EXIT_ON_FAIL=(1 2 6 8 10 11 12 13 14 15 16 17 19)` —
  twelve checks fail the run; check 12 promoted after the final focus-suppression carve-out was
  removed, check 15 promoted after the dead `useExitPresence` suppression was removed, and check 17
  promoted after `.c-kpi-hover` moved to `--shadow-hover` and `raw-color-css` ratcheted to zero.
  Check 19 promoted after dangling no-fallback CSS `var()` refs reached zero; undefined
  component-tier custom-property references now fail before they can resolve empty at runtime. The
  burndown scanner also carries zeroed `raw-font-size-css` and `transition-all-css` categories for
  CSS type-scale and motion-law re-entry, plus a ratcheted `raw-dimension-css` category for raw
  layout-length re-entry. Checks 18 and 20 remain report-only per the
  §2 lifecycle, and the remaining immature checks each sit behind a named landing gate in the
  script's justification block. Workflow drift for the shared design chain is pinned by
  `guard:safeguard-diagnostics`. `tests/scripts/design-regression-guards.test.ts` pins the promoted
  list and the zero-hit focus-suppression / dangling-var output shapes, including fixture probes for
  Check 19 failure and fallback silence.
All other rule rows are unchanged: states verified still accurate against the live configs
(brand-regression, infinite-animation, literal-status-colors,
inline-dismiss-handler, format-bypass, duplicate-shell remain in the shadow config;
raw-color/untokenized-values/transition-all verified still live in the base config).
Rows NOT re-verified by this pass and left untouched: protected-identifiers and icon-family
(closed by the 2026-06-14 changelog entry below after this audit found no dedicated
denylist/contract selector), plus modal-must-restore-focus, focus-visible-required,
motion-needs-reduced-variant, tabular-nums-required (proposed/shadow, no flip on record).
Evidence: `06-implementation/d6-evidence.md`.

Changelog: 2026-06-13 — D2.1 fixture coverage gate added. `design:lint-fixtures` now derives
implemented rule ids from the selector/plugin/config sources and verifies each implemented rule has
both firing and silent fixtures in `tests/console/design-lints.test.ts`; promoted selector rules also
need default-config error probes. The packet also added the missing `soup/no-infinite-animation`
shadow fixture suite, a primitives-exemption proof for `soup/no-raw-form-control`, and a guard
against leaving an implemented selector rule registered as a zero-fire plugin stub.

Changelog: 2026-06-14 — protected-identifiers and icon-family are now live P1 scoped-error rules
instead of documentation-only claims. `console/eslint-rules/index.mjs` implements
`soup/protected-identifiers` as a near-miss contract guard for `soup:`/`/run/soup/`/`SoupError`
forms while preserving the frozen `whatsoup*` protocol/storage identifiers, and implements
`soup/icon-family` as a precise third-party icon-package denylist with `lucide-react` and local
icon components allowed. `console/eslint.config.js` registers both at error severity; the shadow
config overrides them to warnings for fixture/baseline visibility. `tests/console/design-lints.test.ts`
now carries firing/silent fixtures and default-config error probes for both rules.

Changelog: 2026-06-14 — `soup/no-raw-form-control` is now a scoped-error selector outside
`components/primitives/**` after the generated raw-form inventory reached zero. The selector lives in
`rawFormControlSelectors`, every non-primitives flat-config block re-carries it, the primitives block
omits it intentionally, and `eslint.config.shadow.mjs` no longer carries a duplicate shadow-only copy.
Default-config probes pin raw `input`/`select`/`textarea` failures plus the FormControl and
ToolbarSearch primitive exemptions.

Changelog: 2026-08-01 — `SaveContactDialog.tsx` removed from the block-4a M-list `files` array
in `console/eslint.config.js`: the component was deleted as dead code (orphaned since the
console v3.5 de-wiring; #2327), so the M list drops from 10 files to 9 (8 in block 4a plus
`line-detail/CreateGroupModal.tsx` in the full-union block 4b). No rule or selector changes —
the entry was a per-file scope member for a file that no longer exists.

Changelog: 2026-08-02 — `tests/scripts/design-lint-fixtures.test.ts` migrated from the inline
`const tmpDirs: string[]` + `afterEach` cleanup pattern to the shared `trackTmpDirs()` helper
from `tests/helpers/tmp-dir.ts` (#2205 completion). No rule or selector changes — the test
fixture harness was the last holdout using inline tmpdir setup/teardown boilerplate; the
fixture probes, fixture content, and `check-design-lint-fixtures.mjs` contract are unchanged.
