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

      'no-restricted-syntax': ['error',

        // ═══ TYPOGRAPHY ═══

        // Hardcoded font-size — use var(--font-size-xs/label/sm/data/heading/body/lg/xl/2xl)
        {
          selector: 'Property[key.name="fontSize"][value.value=/^[0-9]+\\.?[0-9]*(rem|em)$/]',
          message: '⛔ Hardcoded fontSize — use var(--font-size-*) token.',
        },
        // Hardcoded letter-spacing — use var(--tracking-tight/label/caps)
        {
          selector: 'Property[key.name="letterSpacing"][value.value=/^-?[0-9]+\\.?[0-9]*(rem|em)$/]',
          message: '⛔ Hardcoded letterSpacing — use var(--tracking-*) token.',
        },

        // ═══ BORDER RADIUS ═══

        // Hardcoded borderRadius — use var(--radius-sm/md/lg)
        {
          selector: 'Property[key.name="borderRadius"][value.value=/^[0-9]+px$/]',
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
          selector: 'Property[key.name="padding"][value.value=/^\\d{2,}px$/]',
          message: '⛔ Hardcoded padding px — use var(--sp-*) spacing token.',
        },
        // Compound padding with hardcoded px (e.g. '6px var(--sp-3)' or '8px 14px')
        {
          selector: 'Property[key.name="padding"][value.value=/\\d{2,}px /]',
          message: '⛔ Compound padding with hardcoded px — use var(--sp-*) tokens for all values.',
        },
        {
          selector: 'Property[key.name="padding"][value.value=/ \\d{2,}px/]',
          message: '⛔ Compound padding with hardcoded px — use var(--sp-*) tokens for all values.',
        },
        {
          selector: 'Property[key.name="margin"][value.value=/^\\d{2,}px$/]',
          message: '⛔ Hardcoded margin px — use var(--sp-*) spacing token.',
        },
        {
          selector: 'Property[key.name="gap"][value.value=/^\\d{2,}px$/]',
          message: '⛔ Hardcoded gap px — use var(--sp-*) spacing token.',
        },

        // ═══ INLINE TRANSITION ═══
        // Inline transition style — use CSS classes or design system utilities
        {
          selector: 'Property[key.name="transition"][value.value=/\\d+\\.?\\d*(s|ms)/]',
          message: '⛔ Inline transition with hardcoded duration — use a CSS class or design system utility.',
        },

        // ═══ SIZING ANTI-PATTERNS ═══

        // Hardcoded width/height in style — flag large values that should use tokens
        // (avatars, panels, columns should use --avatar-*, --panel-*, --log-col-*)
        {
          selector: 'Property[key.name="width"][value.value=/^\\d{3,}px$/]',
          message: '⛔ Hardcoded width ≥100px — use a panel/column token (--panel-*, --log-col-*).',
        },
        {
          selector: 'Property[key.name="minWidth"][value.value=/^\\d{3,}px$/]',
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

        // ═══ LINE HEIGHT ═══
        // Use Tailwind leading-* classes (leading-none/tight/snug/normal/relaxed/loose)
        {
          selector: 'Property[key.name="lineHeight"]',
          message: '⛔ Inline lineHeight — use Tailwind leading-none/tight/snug/normal/relaxed/loose class.',
        },

        // ═══ FONT WEIGHT ═══
        // Use Tailwind font-* classes (font-normal/medium/semibold/bold/extrabold/black)
        {
          selector: 'Property[key.name="fontWeight"]',
          message: '⛔ Inline fontWeight — use Tailwind font-normal/medium/semibold/bold/extrabold/black class.',
        },

        // ═══ REACT ANTI-PATTERNS ═══

        // Inline objects in style that recreate on every render
        // (This is advisory — some inline styles are unavoidable)

        // Hardcoded box-shadow — use var(--card-shadow/--shadow-inset/--shadow-md/--shadow-lg)
        {
          selector: 'Property[key.name="boxShadow"][value.value=/^[0-9]/]',
          message: '⛔ Hardcoded boxShadow — use var(--card-shadow), var(--shadow-inset/md/lg).',
        },

        // ═══ FOCUS RINGS ═══

        // Inline outline styles — focus rings must use the global :focus-visible rule in index.css
        {
          selector: 'Property[key.name="outline"][value.value=/[0-9]+px/]',
          message: '⛔ Inline outline — focus rings are set globally via :focus-visible in index.css.',
        },
        // Inline outlineWidth — same reason
        {
          selector: 'Property[key.name="outlineWidth"]',
          message: '⛔ Inline outlineWidth — focus ring width is set globally in index.css (1px/1.5px).',
        },

        // ═══ BORDER WIDTH ═══

        // ═══ Z-INDEX ═══
        // Use Tailwind z-* utilities (z-10, z-20, z-50) or design token
        {
          selector: 'Property[key.name="zIndex"][value.value=/^[0-9]+$/]',
          message: '⛔ Hardcoded zIndex — use Tailwind z-10/z-20/z-50 class or var(--z-*).',
        },

        // ═══ FONT FAMILY ═══
        // Must use var(--font-sans) or var(--font-mono), never raw font stacks
        {
          selector: 'Property[key.name="fontFamily"]',
          message: '⛔ Inline fontFamily — use var(--font-sans) or var(--font-mono), or font-sans/font-mono class.',
        },

        // ═══ MAX-WIDTH SIZING ═══
        // Large maxWidth should use tokens
        {
          selector: 'Property[key.name="maxWidth"][value.value=/^\\d{3,}px$/]',
          message: '⛔ Hardcoded maxWidth ≥100px — use a sizing token (--empty-max-w, --chat-name-max, etc.).',
        },

        // ═══ BORDER WIDTH ═══

        // Hardcoded border with px width — use var(--bw) or var(--bw-accent)
        {
          selector: 'Property[key.name="border"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded border width — use var(--bw) solid var(--b*) or var(--bw-accent).',
        },
        {
          selector: 'Property[key.name="borderTop"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderTop width — use var(--bw) solid var(--b*).',
        },
        {
          selector: 'Property[key.name="borderBottom"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderBottom width — use var(--bw) solid var(--b*).',
        },
        {
          selector: 'Property[key.name="borderLeft"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderLeft width — use var(--bw-accent) solid var(--color-*).',
        },
        {
          selector: 'Property[key.name="borderRight"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderRight width — use var(--bw) solid var(--b*).',
        },

        // ═══ BORDER SHORTHAND ═══
        // React inline styles drop border shorthand properties on spread.
        // Use longhand (borderWidth, borderStyle, borderColor) instead.
        {
          selector: 'Property[key.name="border"][value.value=/var\\(--bw\\)/]',
          message: '⛔ Border shorthand in inline style — React drops it on spread. Use borderWidth/borderStyle/borderColor longhands.',
        },
        // Same bug in template literals: border: `var(--bw) solid ${...}`
        {
          selector: 'TemplateLiteral[parent.key.name="border"]',
          message: '⛔ Border shorthand in template literal — React drops it on spread. Use borderWidth/borderStyle/borderColor longhands.',
        },

        // ═══ REGRESSION: borderColor: undefined ═══
        // Ternary that falls back to undefined silently drops the border.
        {
          selector: 'Property[key.name="borderColor"][value.type="ConditionalExpression"][value.alternate.type="Identifier"][value.alternate.name="undefined"]',
          message: '⛔ borderColor: ... : undefined drops the border. Use getBorderColor() or var(--b2) as fallback.',
        },

        // ═══ REGRESSION: inline accentColor ═══
        // Checkbox/radio accent is set globally in index.css. Inline overrides drift.
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="accentColor"]',
          message: '⛔ Inline accentColor in style — checkbox/radio accent is set globally in index.css.',
        },

        // ═══ REGRESSION: fractional opacity ═══
        // opacity < 1 on interactive elements looks disabled. Use filter: brightness().
        {
          selector: 'Property[key.name="opacity"][value.value=/^0\\.[0-9]/]',
          message: '⛔ Fractional opacity on interactive elements looks disabled. Use filter: brightness() for hover effects.',
        },
      ],
    },
  },
])
