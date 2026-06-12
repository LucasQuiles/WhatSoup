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
 *   soup/no-raw-form-control   — raw <input>/<select>/<textarea> outside primitives dir
 *   soup/no-infinite-animation — TSX-side inline animation: ... infinite
 *   soup/no-raw-color          — hex/rgb/hsl literals (selector extension; already error
 *                                in default config, kept here for shadow baseline parity)
 *   soup/no-duplicate-shell    — advisory stub (warn-ceiling, never error)
 *   Other stub rules           — zero-fire stubs from eslint-rules/index.mjs
 *
 * PROMOTED (no longer in shadowSyntaxRules — now flow via baseSyntaxSelectors):
 *   Group S: soup/no-raw-table, soup/no-raw-sortable-header, soup/no-legacy-log-lanes
 *            — promoted to global-error in Block 1 of eslint.config.js
 *   Group F: soup/no-focus-suppression
 *            — promoted to scoped-error (console-wide minus composer carve-out)
 *   Group M: soup/no-raw-button, soup/no-adhoc-modal (both prongs)
 *            — promoted to scoped-error for the 8 migrated-surface files
 *   Group P: soup/no-legacy-tokens (3 selectors), soup/no-utility-smell
 *            — promoted to scoped-error for components/primitives/**
 *
 * These promoted selectors are still counted in the shadow run for all not-yet-flipped
 * files because baseSyntaxSelectors flat-maps them out of EVERY base block (ignoring
 * files scoping) into the final warn-severity shadow block. Leaving the old copies in
 * shadowSyntaxRules would double-count violations for unflipped files (the error-message
 * text differs, so dedupeSelectors cannot collapse the pair and the ratchet would inflate).
 *
 * NOT included (already at error severity in default config):
 *   soup/no-transition-all, soup/no-raw-color selectors already in eslint.config.js
 *   soup/icon-family, soup/protected-identifiers (scoped-error already)
 */

import baseConfig from './eslint.config.js'
import soupPlugin from './eslint-rules/index.mjs'

// ---------------------------------------------------------------------------
// Shadow-stage no-restricted-syntax selectors (REMAINING — not yet promoted).
// All 'warn' severity — never block anything.
// ---------------------------------------------------------------------------

const shadowSyntaxRules = [

  // ── soup/no-raw-form-control (shadow) ────────────────────────────────────
  // Flag raw <input>/<select>/<textarea>. Baseline: 27 inputs, 3 selects, 5+ textareas.
  // type="file" sites get a named waiver at P6.
  // NOT promoted: form kit not yet landed; TagInput/SaveContact carry their own input.
  {
    selector: 'JSXOpeningElement[name.name=/^(input|select|textarea)$/]',
    message:
      '[soup/no-raw-form-control SHADOW] Raw form control element. ' +
      'P2 goal: render through promoted form kit or Select primitive. ' +
      'This is a baseline counter — shadow stage, non-blocking.',
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

  // NOTE: The following selectors are intentionally ABSENT from this array.
  // They were promoted to scoped-error in eslint.config.js (D6 flip groups S/F/M/P)
  // and now flow into the shadow run automatically via baseSyntaxSelectors (which
  // flat-maps every base-block no-restricted-syntax entry). Keeping them here would
  // produce duplicate selector entries with different message text, inflating the
  // ratchet counts for unflipped files.
  //
  // Removed (Group S): JSXOpeningElement[name.name="table"],
  //                    JSXOpeningElement[name.name="th"]:has(onClick),
  //                    Literal[value=/var\(--log-col-/]
  // Removed (Group F): Literal[value=/\boutline-none\b/][value!=/focus-visible:/]
  // Removed (Group M): JSXOpeningElement[name.name="button"],
  //                    Literal[value=/c-dialog-backdrop/],
  //                    JSXAttribute[name.name="role"][value.value="dialog"]
  // Removed (Group P): Literal[value=/\b(bg-d[0-6]|text-t[1-5]|border-t[1-5])\b/],
  //                    Literal[value=/var\(--color-[dt]\d\)/],
  //                    Literal[value=/var\(--b[1-4]\)/],
  //                    Literal[value=/\b(w|h|...) -\[(?!var\()[^\]]+\]/]
]

// ---------------------------------------------------------------------------
// Build the shadow config:
// 1. Start from the base config array.
// 2. Add a catch-all block that registers the soup plugin + shadow rules at warn.
// ---------------------------------------------------------------------------

// Extract the base config's no-restricted-syntax selectors so the shadow run remains
// a strict superset of the default lint (see comment at the rule below).
const baseSyntaxSelectors = baseConfig.flatMap((c) => {
  const entry = c.rules?.['no-restricted-syntax'];
  return Array.isArray(entry) ? entry.slice(1).flat() : [];
});

// ESLint rejects duplicate selector items; base and shadow lists overlap on a few entries.
function dedupeSelectors(items) {
  const seen = new Set();
  return items.filter((it) => {
    const k = JSON.stringify(it);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const shadowConfig = [
  // Spread the base config so all existing error-severity rules remain intact.
  ...baseConfig,

  // Shadow-stage additions: soup plugin + warn-severity selectors + custom rules.
  // Permanent exemption: console/src/components/primitives/ — the primitive IS
  // the canonical <button> renderer and must not be counted as a violation.
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/components/primitives/**'],
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

      // no-restricted-syntax shadow selectors PLUS the base config's selectors.
      // Flat-config semantics: for files matched by multiple config objects, the LAST
      // object's entry for a rule key replaces earlier ones. So this block must carry
      // the base selectors too, or the shadow run would silently drop the promoted
      // error-severity design selectors for every non-primitive file. Severity is warn
      // here because the shadow run is report-only by design; the default `npm run lint`
      // (base config alone) remains the error-severity enforcement gate.
      //
      // baseSyntaxSelectors includes ALL promoted selectors (S/F/M/P groups) because
      // it flat-maps from EVERY base block regardless of files scoping. This means
      // the promoted selectors continue firing at warn for not-yet-promoted files,
      // keeping the ratchet counts continuous across the promotion wave.
      'no-restricted-syntax': ['warn', ...dedupeSelectors([...baseSyntaxSelectors, ...shadowSyntaxRules])],
    },
  },
]

export default shadowConfig
