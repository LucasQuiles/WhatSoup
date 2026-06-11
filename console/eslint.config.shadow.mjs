/**
 * console/eslint.config.shadow.mjs
 *
 * Shadow-stage ESLint configuration (REPORT-ONLY, never blocks).
 *
 * IMPORTANT: This file is NOT the default config. It is invoked only via:
 *   npm --prefix console run lint:shadow
 * (i.e. eslint . -c eslint.config.shadow.mjs)
 *
 * The default `npm --prefix console run lint` continues to use eslint.config.js
 * unchanged. Shadow rules are at 'warn' severity and do NOT appear in the
 * default run, so the existing husky/lint-staged pipeline (eslint --max-warnings 0)
 * is not affected.
 *
 * Shadow rule batch covers (lint-plan section 3, shadow entry state):
 *   soup/no-brand-regression   — custom rule (implemented in eslint-rules/index.mjs)
 *   soup/no-raw-button         — raw <button> outside primitives dir
 *   soup/no-raw-form-control   — raw <input>/<select>/<textarea> outside primitives dir
 *   soup/no-adhoc-modal        — ad-hoc dialog backdrops / role="dialog" outside primitives
 *   soup/no-focus-suppression  — outline-none without focus-visible: pairing
 *   soup/no-infinite-animation — TSX-side inline animation: ... infinite
 *   soup/no-utility-smell      — arbitrary-value utilities with non-var() payloads
 *   soup/no-raw-color          — hex/rgb/hsl literals (selector extension; already error
 *                                in default config, kept here for shadow baseline parity)
 *   Legacy-token class usage   — bg-d* / text-t* / border-t* in className strings
 *                                (soup/no-legacy-tokens is PROPOSED; covered here via
 *                                 no-restricted-syntax selector as a forward baseline counter)
 *   soup/no-duplicate-shell    — advisory stub (warn-ceiling, never error)
 *   Other stub rules           — zero-fire stubs from eslint-rules/index.mjs
 *
 * NOT included (already at error severity in default config):
 *   soup/no-transition-all, soup/no-raw-color selectors already in eslint.config.js
 *   soup/icon-family, soup/protected-identifiers (scoped-error already)
 */

import baseConfig from './eslint.config.js'
import soupPlugin from './eslint-rules/index.mjs'

// ---------------------------------------------------------------------------
// Shadow-stage no-restricted-syntax selectors.
// All 'warn' severity — never block anything.
// ---------------------------------------------------------------------------

const shadowSyntaxRules = [

  // ── soup/no-raw-button (shadow) ──────────────────────────────────────────
  // Flag raw <button> usage. Baseline: ~135 across console/src.
  // Permanent exemption: components/primitives/** (no such dir yet, so no
  // files are exempted at this stage).
  {
    selector: 'JSXOpeningElement[name.name="button"]',
    message:
      '[soup/no-raw-button SHADOW] Raw <button> element. ' +
      'P2 goal: render all buttons through the Button primitive (components/primitives/). ' +
      'This is a baseline counter — shadow stage, non-blocking.',
  },

  // ── soup/no-raw-form-control (shadow) ────────────────────────────────────
  // Flag raw <input>/<select>/<textarea>. Baseline: 27 inputs, 3 selects, 5+ textareas.
  // type="file" sites get a named waiver at P6.
  {
    selector: 'JSXOpeningElement[name.name=/^(input|select|textarea)$/]',
    message:
      '[soup/no-raw-form-control SHADOW] Raw form control element. ' +
      'P2 goal: render through promoted form kit or Select primitive. ' +
      'This is a baseline counter — shadow stage, non-blocking.',
  },

  // ── soup/no-adhoc-modal (shadow) ─────────────────────────────────────────
  // Prong (a): c-dialog-backdrop class outside Modal primitive
  {
    selector: 'Literal[value=/c-dialog-backdrop/]',
    message:
      '[soup/no-adhoc-modal SHADOW] Ad-hoc dialog backdrop class "c-dialog-backdrop". ' +
      'P2 goal: render all dialog surfaces through the Modal primitive. ' +
      'Non-blocking baseline counter.',
  },
  // Prong (b): role="dialog" attribute outside primitives
  {
    selector: 'JSXAttribute[name.name="role"][value.value="dialog"]',
    message:
      '[soup/no-adhoc-modal SHADOW] role="dialog" outside the Modal primitive. ' +
      'P2 goal: render all dialog surfaces through the Modal primitive. ' +
      'Non-blocking baseline counter.',
  },

  // ── soup/no-focus-suppression (shadow) ───────────────────────────────────
  // outline-none without a focus-visible: treatment in the same class string.
  // The selector catches Literals containing "outline-none" but not "focus-visible:".
  // Known violations: Inbox.tsx:434, HistoryTab.tsx:206 (chat composers).
  {
    selector:
      'Literal[value=/\\boutline-none\\b/][value!=/focus-visible:/]',
    message:
      '[soup/no-focus-suppression SHADOW] outline-none without focus-visible: replacement. ' +
      'FIX (P2): add focus-visible:ring-[var(--focus-ring)] or rely on global ring by not suppressing. ' +
      'Non-blocking baseline counter.',
  },

  // ── soup/no-infinite-animation (shadow, TSX side) ────────────────────────
  // Flag inline animation property containing "infinite".
  // CSS-side covered by design-regression.sh check 13.
  {
    selector: 'Property[key.name="animation"][value.value=/infinite/]',
    message:
      '[soup/no-infinite-animation SHADOW] Inline style animation: ...infinite. ' +
      'P5 goal: only the sanctioned ok-breathing token is permitted. ' +
      'Non-blocking baseline counter.',
  },

  // ── Legacy token class usage (no-legacy-tokens forward counter) ──────────
  // The rule is PROPOSED (enabled at P2-complete). This selector counts current
  // usage so the baseline is frozen before the alias layer lands.
  // Covers bg-d* and text-t* utilities in className string literals.
  {
    selector: 'Literal[value=/\\b(bg-d[0-6]|text-t[1-5]|border-t[1-5])\\b/]',
    message:
      '[soup/no-legacy-tokens SHADOW COUNTER] Legacy dark-mode-only utility class. ' +
      'P2+ goal: replace with v2 semantic vocabulary (surface-*, text-1/2/3, border-hairline/subtle/strong). ' +
      'Non-blocking baseline counter — rule is PROPOSED, enabled at P2-complete.',
  },
  // Also cover var(--color-d*), var(--color-t*), var(--b1..b4) token refs in literals
  {
    selector: 'Literal[value=/var\\(--color-[dt]\\d\\)/]',
    message:
      '[soup/no-legacy-tokens SHADOW COUNTER] Legacy --color-d*/--color-t* token ref. ' +
      'P2+ goal: replace with v2 semantic token (--surface-base, --text-1, etc.). ' +
      'Non-blocking baseline counter — rule is PROPOSED, enabled at P2-complete.',
  },
  {
    selector: 'Literal[value=/var\\(--b[1-4]\\)/]',
    message:
      '[soup/no-legacy-tokens SHADOW COUNTER] Legacy --b1..b4 border token ref. ' +
      'P2+ goal: replace with --border-hairline/subtle/strong. ' +
      'Non-blocking baseline counter — rule is PROPOSED, enabled at P2-complete.',
  },

  // ── soup/no-utility-smell (shadow) ───────────────────────────────────────
  // Arbitrary-value utility whose payload is NOT a var() reference.
  // Generalises the existing px-only rule to all non-token payloads (rem, %, calc with raw values).
  {
    selector:
      'Literal[value=/\\b(w|h|mt|mb|ml|mr|px|py|p|m|gap|min-w|max-w|min-h|max-h|top|bottom|left|right)-\\[(?!var\\()[^\\]]+\\]/]',
    message:
      '[soup/no-utility-smell SHADOW] Arbitrary-value utility with non-var() payload. ' +
      'FIX: replace [Npx/rem/%] with [var(--token)]. Define new tokens in index.css if needed. ' +
      'Non-blocking baseline counter.',
  },
]

// ---------------------------------------------------------------------------
// Build the shadow config:
// 1. Start from the base config array.
// 2. Add a catch-all block that registers the soup plugin + shadow rules at warn.
// ---------------------------------------------------------------------------

const shadowConfig = [
  // Spread the base config so all existing error-severity rules remain intact.
  ...baseConfig,

  // Shadow-stage additions: soup plugin + warn-severity selectors + custom rules.
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      soup: soupPlugin,
    },
    rules: {
      // Custom rule: soup/no-brand-regression
      'soup/no-brand-regression': 'warn',

      // Stub rules (zero-fire, but registered so the namespace is visible)
      'soup/no-legacy-tokens': 'warn',
      'soup/no-duplicate-shell': 'warn',
      'soup/no-literal-status-colors': 'warn',
      'soup/focus-visible-required': 'warn',
      'soup/modal-must-restore-focus': 'warn',
      'soup/motion-needs-reduced-variant': 'warn',
      'soup/no-format-bypass': 'warn',
      'soup/no-inline-dismiss-handler': 'warn',

      // no-restricted-syntax shadow selectors.
      // Using 'warn' here directly as a second no-restricted-syntax entry —
      // ESLint flat config merges rules per config object, so this block's
      // no-restricted-syntax ONLY applies to this block's files scope.
      // The base config's error-severity no-restricted-syntax stays in its
      // own config block and is not overridden here.
      'no-restricted-syntax': ['warn', ...shadowSyntaxRules],
    },
  },
]

export default shadowConfig
