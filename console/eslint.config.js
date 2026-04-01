import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // ═══════════════════════════════════════════════════════════════
      // DESIGN SYSTEM ENFORCEMENT
      //
      // These rules prevent hardcoded styles that bypass the token system
      // defined in index.css. Every visual property should reference a
      // CSS custom property (var(--*)) or a design system utility class.
      //
      // Severity: "warn" for ratcheting. Change to "error" to hard-block.
      // ═══════════════════════════════════════════════════════════════

      'no-restricted-syntax': ['warn',

        // ═══ TYPOGRAPHY ═══

        // Hardcoded font-size — use var(--font-size-xs/label/sm/data/heading/body/lg/xl/2xl)
        {
          selector: 'Property[key.value="fontSize"][value.value=/^[0-9]+\\.?[0-9]*(rem|em)$/]',
          message: '⛔ Hardcoded fontSize — use var(--font-size-*) token.',
        },
        // Hardcoded letter-spacing — use var(--tracking-tight/label/caps)
        {
          selector: 'Property[key.value="letterSpacing"][value.value=/^-?[0-9]+\\.?[0-9]*(rem|em)$/]',
          message: '⛔ Hardcoded letterSpacing — use var(--tracking-*) token.',
        },

        // ═══ BORDER RADIUS ═══

        // Hardcoded borderRadius — use var(--radius-sm/md/lg)
        {
          selector: 'Property[key.value="borderRadius"][value.value=/^[0-9]+px$/]',
          message: '⛔ Hardcoded borderRadius — use var(--radius-sm/md/lg).',
        },
        // Tailwind rounded-[Npx] arbitrary — use design token
        {
          selector: 'Literal[value=/\\brounded-\\[\\d+px\\]/]',
          message: '⛔ Arbitrary rounded-[Npx] — use var(--radius-sm/md/lg) in style instead.',
        },

        // ═══ COLORS ═══

        // Raw rgba() — use CSS custom property (--s-ok-wash, --m-cht-soft, etc.)
        {
          selector: 'Literal[value=/rgba\\(/]',
          message: '⛔ Raw rgba() — use a CSS custom property from index.css.',
        },
        // Hardcoded hex color — use CSS custom property
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: '⛔ Hardcoded hex color — use a CSS custom property.',
        },

        // ═══ TRANSITIONS & ANIMATIONS ═══

        // Inline transition-colors — use c-hover, c-row-hover, c-nav-link, c-chat-item
        {
          selector: 'Literal[value=/\\btransition-colors\\b/]',
          message: '⛔ Inline transition-colors — use c-hover, c-row-hover, c-nav-link, or c-chat-item.',
        },
        // Inline transition-all — use c-hover or c-kpi-hover
        {
          selector: 'Literal[value=/\\btransition-all\\b/]',
          message: '⛔ Inline transition-all — use c-hover or c-kpi-hover.',
        },
        // Inline transition-opacity — use c-hover
        {
          selector: 'Literal[value=/\\btransition-opacity\\b/]',
          message: '⛔ Inline transition-opacity — use c-hover.',
        },
        // Inline duration-* — transitions handled by design system classes
        {
          selector: 'Literal[value=/\\bduration-\\d/]',
          message: '⛔ Inline duration — transitions are handled by design system classes.',
        },

        // ═══ TAILWIND UTILITIES THAT BYPASS @THEME ═══
        // In Tailwind v4, these utilities don't honor our @theme overrides.
        // Use var(--font-size-*) or var(--tracking-*) in inline styles instead.
        // Negative lookbehind (?<!-) avoids false positives on var(--font-size-xs).

        {
          selector: 'Literal[value=/(?<!-)\\btext-xs\\b/]',
          message: '⛔ text-xs bypasses tokens in TW4 — use var(--font-size-xs) in style.',
        },
        {
          selector: 'Literal[value=/(?<!-)\\btext-sm\\b/]',
          message: '⛔ text-sm bypasses tokens in TW4 — use var(--font-size-sm) in style.',
        },
        {
          selector: 'Literal[value=/(?<!-)\\btext-xl\\b/]',
          message: '⛔ text-xl bypasses tokens in TW4 — use var(--font-size-xl) in style.',
        },
        {
          selector: 'Literal[value=/(?<!-)\\btracking-tight\\b/]',
          message: '⛔ tracking-tight bypasses tokens in TW4 — use var(--tracking-tight) in style.',
        },

        // ═══ SPACING ANTI-PATTERNS ═══

        // Hardcoded large padding/margin px — should use var(--sp-*) tokens
        // Only flags values ≥ 10px to avoid false positives on structural 1px/2px
        {
          selector: 'Property[key.value="padding"][value.value=/^\\d{2,}px$/]',
          message: '⛔ Hardcoded padding px — use var(--sp-*) spacing token.',
        },
        {
          selector: 'Property[key.value="margin"][value.value=/^\\d{2,}px$/]',
          message: '⛔ Hardcoded margin px — use var(--sp-*) spacing token.',
        },
        {
          selector: 'Property[key.value="gap"][value.value=/^\\d{2,}px$/]',
          message: '⛔ Hardcoded gap px — use var(--sp-*) spacing token.',
        },

        // ═══ SIZING ANTI-PATTERNS ═══

        // Hardcoded width/height in style — flag large values that should use tokens
        // (avatars, panels, columns should use --avatar-*, --panel-*, --log-col-*)
        {
          selector: 'Property[key.value="width"][value.value=/^\\d{3,}px$/]',
          message: '⛔ Hardcoded width ≥100px — use a panel/column token (--panel-*, --log-col-*).',
        },
        {
          selector: 'Property[key.value="minWidth"][value.value=/^\\d{3,}px$/]',
          message: '⛔ Hardcoded minWidth ≥100px — use a sizing token.',
        },

        // ═══ DOM MANIPULATION ═══

        // Direct style mutation — use CSS :hover or React state
        {
          selector: 'MemberExpression[property.name="backgroundColor"][object.property.name="style"]',
          message: '⛔ Direct style.backgroundColor mutation — use CSS :hover or React state.',
        },
        {
          selector: 'MemberExpression[property.name="color"][object.property.name="style"]',
          message: '⛔ Direct style.color mutation — use CSS :hover or React state.',
        },

        // ═══ FONT WEIGHT ═══
        // Use Tailwind font-* classes (font-normal/medium/semibold/bold/extrabold/black)
        {
          selector: 'Property[key.value="fontWeight"]',
          message: '⛔ Inline fontWeight — use Tailwind font-normal/medium/semibold/bold/extrabold/black class.',
        },

        // ═══ REACT ANTI-PATTERNS ═══

        // Inline objects in style that recreate on every render
        // (This is advisory — some inline styles are unavoidable)

        // Hardcoded box-shadow — use var(--card-shadow/--shadow-inset/--shadow-md/--shadow-lg)
        {
          selector: 'Property[key.value="boxShadow"][value.value=/^[0-9]/]',
          message: '⛔ Hardcoded boxShadow — use var(--card-shadow), var(--shadow-inset/md/lg).',
        },
      ],
    },
  },
])
