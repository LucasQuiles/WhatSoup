/**
 * console/eslint-rules/design-selectors.mjs
 *
 * Shared promoted-selector arrays for the SOUP Design System v3 enforcement.
 *
 * Imported by both eslint.config.js (error severity, scoped blocks) and
 * eslint.config.shadow.mjs (so promoted selectors are removed from shadowSyntaxRules
 * without loss — they flow back in via baseSyntaxSelectors from the base config blocks).
 *
 * SSOT for promoted selector groups.
 * Message-tag prefix [soup/<rule>] is load-bearing for ratchet keying —
 * never change the tag, only the text after it.
 *
 * Lifecycle: lint-plan §2 scoped-error state.
 * Rollback: remove selector from its array, restore warn copy to shadowSyntaxRules.
 */

// ── Group S — structural, console-wide ──────────────────────────────────────
// Scope: all console/src TS/TSX except components/primitives/**
// (Table/LogStream/Button/Modal ARE the canonical renderers; raw elements must not reappear outside them)
// Current violations in scope: 0 (no baseline keys; design-regression check 16 PASS)
// 2026-06-15: Expanded to include no-raw-button, no-adhoc-modal (promoted from Group M scoped-error
// to console-wide error; pre-promotion rg audit: 0 violations), and no-infinite-animation
// (promoted from shadow; pre-promotion rg audit: 0 TSX violations).
export const structuralSelectors = [
  {
    selector: 'JSXOpeningElement[name.name="table"]',
    message:
      '[soup/no-raw-table] Raw <table> element. ' +
      'Render data tables through the Table primitive (components/primitives/Table.tsx). ' +
      'FIX: import { DataTable } from components/primitives/Table and use that instead.',
  },
  {
    selector: 'JSXOpeningElement[name.name="th"]:has(JSXAttribute[name.name="onClick"])',
    message:
      '[soup/no-raw-sortable-header] Raw <th onClick> sort handler. ' +
      'Render sortable headers through TableHeaderCell (Table primitive) with aria-sort. ' +
      'FIX: use the TableHeaderCell component from components/primitives/Table.tsx.',
  },
  {
    selector: 'Literal[value=/var\\(--log-col-/]',
    message:
      '[soup/no-legacy-log-lanes] Legacy --log-col-* lane reference. ' +
      'Log surfaces render through the LogStream primitive; use its component tokens ' +
      '--log-time-w / --log-level-w / --log-source-w instead. ' +
      'FIX: replace var(--log-col-*) with the LogStream component token.',
  },
  // ── no-raw-button (promoted 2026-06-15 from Group M scoped → console-wide) ──
  {
    selector: 'JSXOpeningElement[name.name="button"]',
    message:
      '[soup/no-raw-button] Raw <button> element. ' +
      'FIX: render through the Button primitive (components/primitives/Button.tsx). ' +
      'E.g. <button className="c-btn">…</button> → <Button>…</Button>.',
  },
  // ── no-adhoc-modal (promoted 2026-06-15 from Group M scoped → console-wide) ──
  {
    selector: 'Literal[value=/c-dialog-backdrop/]',
    message:
      '[soup/no-adhoc-modal] Ad-hoc dialog backdrop class "c-dialog-backdrop". ' +
      'FIX: render all dialog surfaces through the Modal primitive ' +
      '(components/primitives/Modal.tsx).',
  },
  {
    selector: 'JSXAttribute[name.name="role"][value.value="dialog"]',
    message:
      '[soup/no-adhoc-modal] role="dialog" outside the Modal primitive. ' +
      'FIX: render all dialog surfaces through the Modal primitive ' +
      '(components/primitives/Modal.tsx).',
  },
  // ── no-infinite-animation (promoted 2026-06-15 from shadow → console-wide error) ──
  // TSX-side inline animation: ...infinite tripwire.
  // CSS-side infinite animations are covered by design-regression.sh check 13 + waiver registry.
  {
    selector: 'Property[key.name="animation"][value.value=/infinite/]',
    message:
      '[soup/no-infinite-animation] Inline style animation with "infinite" keyword. ' +
      'Only the sanctioned ok-breathing animation token is permitted for infinite animations. ' +
      'FIX: move animation to a CSS @keyframes rule in index.css with a waiver entry, ' +
      'or replace with a finite animation. See design-regression.sh check 13.',
  },
]

// -- Raw form controls, non-primitives -------------------------------------
// Scope: all console/src TS/TSX except components/primitives/**
// (FormControl, ToolbarSearch, and other primitive-owned renderers may render raw controls)
// Current violations in scope: 0 (generated raw-form-control inventory is empty)
export const rawFormControlSelectors = [
  {
    selector: 'JSXOpeningElement[name.name=/^(input|select|textarea)$/]',
    message:
      '[soup/no-raw-form-control] Raw form control element outside primitives. ' +
      'FIX: render through FormControl primitives: TextInput, NumberInput, SelectInput, ' +
      'TextArea, CheckboxField, RadioField, or FileInput from components/primitives/FormControl.tsx.',
  },
]

// ── Group F — focus suppression, console-wide ───────────────────────────────
// Scope: all console/src TS/TSX. The Inbox and HistoryTab composer carve-outs
// were removed by their migration waves.
// Current violations: 0.
export const focusSuppressionSelectors = [
  {
    selector: 'Literal[value=/\\boutline-none\\b/][value!=/focus-visible:/]',
    message:
      '[soup/no-focus-suppression] outline-none without focus-visible: replacement. ' +
      'FIX: add focus-visible:ring-[var(--focus-ring)] to the same className string, ' +
      'or rely on the global ring by not suppressing outline. ' +
      'See lint-plan §3 soup/no-focus-suppression for exemption details.',
  },
]

// ── Group P — primitives strict tier ────────────────────────────────────────
// Scope: components/primitives/** ONLY (born-clean enforcement)
// Current violations in primitives/: 0 (grep-verified in d6-investigation.md §3)
export const legacyTokenSelectors = [
  {
    selector: 'Literal[value=/\\b(bg-d[0-6]|text-t[1-5]|border-t[1-5])\\b/]',
    message:
      '[soup/no-legacy-tokens] Legacy dark-mode-only utility class in the primitives tier. ' +
      'FIX: replace with v2 semantic vocabulary: bg-d*→surface-* utilities, ' +
      'text-t*→text-1/text-2/text-3, border-t*→border-hairline/subtle/strong. ' +
      'See tokens spec: docs/design-system/03-spec/tokens-v3.md.',
  },
  {
    selector: 'Literal[value=/var\\(--color-[dt]\\d\\)/]',
    message:
      '[soup/no-legacy-tokens] Legacy --color-d*/--color-t* token ref in the primitives tier. ' +
      'FIX: replace with v2 semantic token: --surface-base/raised/inset/overlay, ' +
      '--text-1/--text-2/--text-3. See docs/design-system/03-spec/tokens-v3.md.',
  },
  {
    selector: 'Literal[value=/var\\(--b[1-4]\\)/]',
    message:
      '[soup/no-legacy-tokens] Legacy --b1..b4 border token ref in the primitives tier. ' +
      'FIX: replace with --border-hairline / --border-subtle / --border-strong.',
  },
]

export const utilitySmellSelectors = [
  {
    selector:
      'Literal[value=/\\b(w|h|mt|mb|ml|mr|px|py|p|m|gap|min-w|max-w|min-h|max-h|top|bottom|left|right)-\\[(?!var\\()[^\\]]+\\]/]',
    message:
      '[soup/no-utility-smell] Arbitrary-value utility with non-var() payload in the primitives tier. ' +
      'FIX: replace [Npx/rem/%] with [var(--token)]. Define new tokens in index.css if needed. ' +
      'Exemption: var() payloads are compliant — e.g. w-[var(--avatar-sm)].',
  },
  {
    selector:
      'TemplateLiteral:has(TemplateElement[value.raw=/\\b(w|h|mt|mb|ml|mr|px|py|p|m|gap|min-w|max-w|min-h|max-h|top|bottom|left|right)-\\[(?!var\\()[^\\]]+\\]/])',
    message:
      '[soup/no-utility-smell] Arbitrary-value utility with non-var() payload in a template literal. ' +
      'FIX: replace [Npx/rem/%] with [var(--token)]. Define new tokens in index.css if needed. ' +
      'Exemption: var() payloads are compliant — e.g. w-[var(--avatar-sm)].',
  },
]
