import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import soupPlugin from './eslint-rules/index.mjs'
import {
  structuralSelectors,
  rawFormControlSelectors,
  focusSuppressionSelectors,
  legacyTokenSelectors,
  utilitySmellSelectors,
} from './eslint-rules/design-selectors.mjs'

// Keep copyable Tailwind class examples in ESLint output without exposing
// those examples as raw content for Tailwind/Vite class extraction.
const tw = (...parts) => parts.join('')

// ╔══════════════════════════════════════════════════════════════════╗
// ║  TOKEN CHEAT SHEET — reference for fixing lint errors           ║
// ║  All tokens are defined in src/index.css                        ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  SPACING (4px grid):                                            ║
// ║    0→0  1px→var(--bw)  2px→var(--bw-accent)  3px→var(--sp-0h)  ║
// ║    4px→var(--sp-1)     6px→var(--sp-1h)       8px→var(--sp-2)   ║
// ║    10px→var(--sp-2h)   12px→var(--sp-3)       14px→var(--msg-pad-h) ║
// ║    16px→var(--sp-4)    20px→var(--sp-5)       24px→var(--sp-6)  ║
// ║    28px→var(--sp-7)    32px→var(--sp-8)       40px→var(--sp-10) ║
// ║    48px→var(--sp-12)                                            ║
// ║                                                                 ║
// ║  FONT SIZE (Tailwind @theme: --text-* → text-* utility):         ║
// ║    9.6px→text-xs      10.4px→text-label                        ║
// ║    11.2px→text-sm     12.5px→text-data                         ║
// ║    13.1px→text-heading 13.6px→text-body                        ║
// ║    16px→text-lg       22.4px→text-xl                           ║
// ║    27.2px→text-2xl                                             ║
// ║                                                                 ║
// ║  BORDER RADIUS:                                                 ║
// ║    2px→var(--radius-xs)  4px→var(--radius-sm)                   ║
// ║    6px→var(--radius-md)  10px→var(--radius-lg)                  ║
// ║    50%→var(--radius-circle)                                     ║
// ║                                                                 ║
// ║  BORDER WIDTH:                                                  ║
// ║    1px→var(--bw)  2px→var(--bw-accent)                          ║
// ║                                                                 ║
// ║  ELEMENT SIZES:                                                 ║
// ║    5px→var(--dot-badge)   6px→var(--dot-feed)                   ║
// ║    8px→var(--dot-table) or var(--stepper-dot)                   ║
// ║    10px→var(--dot-header) 14px→var(--sep-h)                     ║
// ║    16px→var(--feed-col-icon)                                    ║
// ║    20px→var(--badge-unread) 28px→var(--input-btn)               ║
// ║    32px→var(--avatar-sm) or var(--sparkline-h)                  ║
// ║    36px→var(--avatar-md)  40px→var(--icon-empty)                ║
// ║    64px→var(--avatar-lg)  256px→var(--qr-size)                  ║
// ║                                                                 ║
// ║  PANELS/WIDTHS:                                                 ║
// ║    200px→var(--dropdown-min-w)  256px→var(--panel-contact)      ║
// ║    260px→var(--panel-actions)   288px→var(--panel-chat-list)    ║
// ║    320px→var(--empty-max-w)     340px→var(--panel-shortcuts)    ║
// ║    420px→var(--panel-confirm)   560px→var(--modal-w-md)         ║
// ║    720px→var(--panel-wizard)                                    ║
// ║                                                                 ║
// ║  MODAL HEIGHTS:                                                 ║
// ║    85vh→var(--modal-max-h)                                     ║
// ║    90%→var(--panel-max-inline)                                 ║
// ║                                                                 ║
// ║  OPACITY:                                                       ║
// ║    0.3→var(--opacity-soft)      0.4→var(--opacity-faint)       ║
// ║    0.45→var(--opacity-disabled) 0.6→var(--opacity-muted)       ║
// ║                                                                 ║
// ║  Z-INDEX (use Tailwind z-* class, NOT style):                   ║
// ║    10→z-10 (--z-float)  50→z-50 (--z-dropdown)                 ║
// ║    100→z-100 (--z-overlay)                                      ║
// ║                                                                 ║
// ║  SHADOWS:                                                       ║
// ║    var(--card-shadow)  var(--shadow-inset)                      ║
// ║    var(--shadow-md)    var(--shadow-lg)                         ║
// ║                                                                 ║
// ║  TRANSITIONS (use CSS class, NOT inline style):                 ║
// ║    c-hover  c-row-hover  c-kpi-hover  c-nav-link  c-chat-item  ║
// ╚══════════════════════════════════════════════════════════════════╝

const designSystemRestrictions = [

        // ═══ TYPOGRAPHY ═══

        {
          selector: 'Property[key.name="fontSize"][value.value=/^[0-9]+\\.?[0-9]*(rem|em|px)$/]',
          message: '⛔ Hardcoded fontSize. FIX: use text-* utility class. Scale: text-xs(9.6px) text-label(10.4px) text-sm(11.2px) text-data(12.5px) text-heading(13.1px) text-body(13.6px) text-lg(16px) text-xl(22.4px) text-2xl(27.2px).',
        },
        {
          selector: 'Property[key.name="fontSize"][value.type="Literal"][value.raw=/^[1-9]\\d*$/]',
          message: '⛔ Raw numeric fontSize (becomes px). FIX: use text-* utility class. Scale: text-xs(9.6px) text-label(10.4px) text-sm(11.2px) text-data(12.5px) text-body(13.6px) text-lg(16px).',
        },
        {
          selector: 'Property[key.name="letterSpacing"][value.value=/^-?[0-9]+\\.?[0-9]*(rem|em)$/]',
          message: '⛔ Hardcoded letterSpacing. FIX: replace with var(--tracking-*) token. Options: tighter(-0.06em) tight(-0.04em) pill(0.02em) label(0.06em) caps(0.12em).',
        },

        // ═══ BORDER RADIUS ═══

        {
          selector: 'Property[key.name="borderRadius"][value.value=/^[0-9]+px$/]',
          message: '⛔ Hardcoded borderRadius px. FIX: replace with token. 2px→var(--radius-xs) 4px→var(--radius-sm) 6px→var(--radius-md) 10px→var(--radius-lg).',
        },
        {
          selector: 'Property[key.name="borderRadius"][value.value=/^\\d+%$/]',
          message: '⛔ Hardcoded borderRadius %. FIX: replace 50% with var(--radius-circle).',
        },
        {
          selector: 'Literal[value=/\\brounded-\\[\\d+px\\]/]',
          message: '⛔ Arbitrary rounded-[Npx] in className. FIX: remove from className, add borderRadius: var(--radius-sm/md/lg) in style instead.',
        },

        // ═══ COLORS ═══

        {
          selector: 'Literal[value=/rgba\\(/]',
          message: '⛔ Raw rgba() value. FIX: replace with a CSS custom property from index.css. Common: var(--b1..b4) for borders, var(--s-ok-wash) etc. for status, var(--overlay) for backdrops.',
        },
        {
          selector: 'Literal[value=/^#[0-9a-fA-F]{3,8}$/]',
          message: '⛔ Hardcoded hex color. FIX: replace with CSS custom property. Backgrounds: var(--color-d0..d6). Text: var(--color-t1..t5). Status: var(--color-s-ok/warn/crit). Modes: var(--color-m-pas/cht/agt).',
        },

        // ═══ TRANSITIONS & ANIMATIONS ═══

        {
          selector: 'Literal[value=/\\btransition-colors\\b/]',
          message: '⛔ Inline transition-colors class. FIX: replace with c-hover, c-row-hover, c-nav-link, or c-chat-item class.',
        },
        {
          selector: 'Literal[value=/\\btransition-all\\b/]',
          message: '⛔ Inline transition-all class. FIX: replace with c-hover or c-kpi-hover class.',
        },
        {
          selector: 'Literal[value=/\\btransition-opacity\\b/]',
          message: '⛔ Inline transition-opacity class. FIX: replace with c-hover class.',
        },
        {
          selector: 'Literal[value=/\\bduration-\\d/]',
          message: '⛔ Inline duration class. FIX: remove — transitions are handled by DS classes (c-hover, c-row-hover, etc.).',
        },

        // ═══ TAILWIND FONT-SIZE PATTERNS ═══
        // text-xs, text-sm, text-xl etc. map to @theme --text-* tokens — use directly.
        // Arbitrary font-size/text var() forms are ambiguous or redundant in TW4.
        {
          selector: 'Literal[value=/text-\\[var\\(--font-size-/]',
          message: `⛔ ${tw('text-', '[var(--font-size-*)]')} generates NO CSS in Tailwind v4. FIX: use text-* utility directly. ${tw('text-', '[var(--font-size-sm)]')}→"text-sm". Scale: xs, label, sm, data, heading, body, lg, xl, 2xl.`,
        },
        {
          selector: 'Literal[value=/text-\\[var\\(--text-/]',
          message: `⛔ ${tw('text-', '[var(--text-*)]')} is redundant. FIX: use text-* utility directly. ${tw('text-', '[var(--text-sm)]')}→"text-sm". Scale: xs, label, sm, data, heading, body, lg, xl, 2xl.`,
        },

        {
          selector: 'Literal[value=/(?<!-)\\btracking-tight\\b/]',
          message: '⛔ tracking-tight bypasses @theme tokens. FIX: remove from className, add style={{ letterSpacing: "var(--tracking-tight)" }}.',
        },

        // ═══ SPACING — ALL HARDCODED PX ═══

        {
          selector: 'Property[key.name=/^padding/][value.value=/^\\d+px$/]',
          message: '⛔ Hardcoded padding px. FIX: replace with var(--sp-*). Scale: 0→0 3px→var(--sp-0h) 4px→var(--sp-1) 6px→var(--sp-1h) 8px→var(--sp-2) 10px→var(--sp-2h) 12px→var(--sp-3) 16px→var(--sp-4) 20px→var(--sp-5) 24px→var(--sp-6).',
        },
        {
          selector: 'Property[key.name=/^padding/][value.value=/\\d+px /]',
          message: '⛔ Compound padding with hardcoded px. FIX: replace each px value with var(--sp-*). Scale: 4px→var(--sp-1) 8px→var(--sp-2) 12px→var(--sp-3) 16px→var(--sp-4) 20px→var(--sp-5) 24px→var(--sp-6).',
        },
        {
          selector: 'Property[key.name=/^padding/][value.value=/ \\d+px/]',
          message: '⛔ Compound padding with hardcoded px. FIX: replace each px value with var(--sp-*). Scale: 4px→var(--sp-1) 8px→var(--sp-2) 12px→var(--sp-3) 16px→var(--sp-4) 20px→var(--sp-5) 24px→var(--sp-6).',
        },
        {
          selector: 'Property[key.name=/^(padding|margin|gap|width|height|minWidth|minHeight|maxWidth|maxHeight|top|bottom|left|right)$/][value.type="ConditionalExpression"] Literal[value=/[1-9]\\d*px/]',
          message: '⛔ Conditional style branch with hardcoded px. FIX: replace each static branch with tokenized values such as var(--sp-*) or component tokens; measured runtime px values are allowed.',
        },
        {
          selector: 'Property[key.name=/^margin/][value.value=/^\\d+px$/]',
          message: '⛔ Hardcoded margin px. FIX: replace with var(--sp-*). Scale: 3px→var(--sp-0h) 4px→var(--sp-1) 6px→var(--sp-1h) 8px→var(--sp-2) 12px→var(--sp-3) 16px→var(--sp-4) 20px→var(--sp-5).',
        },
        {
          selector: 'Property[key.name="gap"][value.value=/^\\d+px$/]',
          message: '⛔ Hardcoded gap px. FIX: replace with var(--sp-*). Scale: 1px→var(--bw) 2px→var(--bw-accent) 4px→var(--sp-1) 8px→var(--sp-2) 12px→var(--sp-3) 16px→var(--sp-4).',
        },

        // ═══ SIZING — ALL HARDCODED PX ═══

        {
          selector: 'Property[key.name=/^(width|height|minWidth|minHeight|maxWidth|maxHeight)$/][value.value=/^\\d+px$/]',
          message: '⛔ Hardcoded size px. FIX: replace with token from index.css. Check --avatar-*, --panel-*, --dot-*, --sp-*, --icon-empty, --input-h, --input-btn, etc. See cheat sheet at top of eslint.config.js.',
        },
        {
          selector: 'TemplateLiteral[parent.key.name=/^(width|height|minWidth|minHeight|maxWidth|maxHeight|padding|margin|gap|top|bottom|left|right)$/]:has(TemplateElement[value.raw=/px/]):has(Literal[raw=/^[1-9]\\d*$/])',
          message: '⛔ Template literal hardcoded px formula in style. FIX: use tokenized string values such as var(--sp-*) or calc(var(--token) + var(--sp-*)); measured runtime layout values are allowed.',
        },
        {
          selector: 'VariableDeclarator[id.name=/^(width|height|minWidth|minHeight|maxWidth|maxHeight|top|bottom|left|right)$/][init.type="ConditionalExpression"] Literal[raw=/^[1-9]\\d*$/]',
          message: '⛔ Dimensional const with raw numeric branch. FIX: store tokenized string values such as var(--chart-panel-h), then pass that identifier into style.',
        },
        // Raw numeric literals (React converts to px) — excludes 0
        {
          selector: 'Property[key.name=/^(width|height|minWidth|minHeight|maxWidth|maxHeight|padding|margin|gap|top|bottom|left|right)$/][value.type="Literal"][value.raw=/^[1-9]\\d*$/]',
          message: '⛔ Raw numeric value (becomes px). FIX: replace N with string token. E.g. 2→"var(--bw-accent)" 4→"var(--sp-1)" 8→"var(--sp-2)" 16→"var(--sp-4)". For sizing: 10→"var(--dot-header)" 16→"var(--feed-col-icon)" 32→"var(--avatar-sm)". See cheat sheet at top of eslint.config.js.',
        },
        {
          selector: 'Property[key.name=/^(padding|margin)(Top|Bottom|Left|Right)$/][value.type="Literal"][value.raw=/^[1-9]\\d*$/]',
          message: '⛔ Raw numeric spacing value (becomes px). FIX: replace N with string var(--sp-*). E.g. 2→"var(--bw-accent)" 4→"var(--sp-1)" 8→"var(--sp-2)" 12→"var(--sp-3)" 16→"var(--sp-4)".',
        },

        // ═══ SIMPLE TEXT COLOR IN STYLE ═══
        // color: 'var(--color-tN)' should be a Tailwind text-tN class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="color"][value.value=/^var\\(--color-t\\d\\)$/]',
          message: '⛔ Simple text color in style. FIX: remove from style, add to className. var(--color-t1)→"text-t1" var(--color-t2)→"text-t2" var(--color-t3)→"text-t3" var(--color-t4)→"text-t4" var(--color-t5)→"text-t5".',
        },
        // color: 'var(--color-s-*)' should be a Tailwind text-s-* class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="color"][value.value=/^var\\(--color-s-/]',
          message: '⛔ Simple status color in style. FIX: remove from style, add to className. var(--color-s-ok)→"text-s-ok" var(--color-s-warn)→"text-s-warn" var(--color-s-crit)→"text-s-crit".',
        },
        // color: 'var(--color-m-*)' should be a Tailwind text-m-* class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="color"][value.value=/^var\\(--color-m-/]',
          message: '⛔ Simple mode color in style. FIX: remove from style, add to className. var(--color-m-pas)→"text-m-pas" var(--color-m-cht)→"text-m-cht" var(--color-m-agt)→"text-m-agt".',
        },

        // ═══ BACKGROUND TOKEN IN STYLE ═══
        // background: 'var(--color-dN)' should be a Tailwind bg-dN class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="background"][value.value=/^var\\(--color-d\\d\\)$/]',
          message: '⛔ Simple background color in style. FIX: remove from style, add to className. var(--color-d0)→"bg-d0" var(--color-d1)→"bg-d1" var(--color-d2)→"bg-d2" var(--color-d3)→"bg-d3" var(--color-d4)→"bg-d4" var(--color-d5)→"bg-d5" var(--color-d6)→"bg-d6".',
        },
        // background: 'var(--*)' (non-dN tokens) → Tailwind arbitrary background class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="background"][value.value=/^var\\(--(?!color-d\\d)/]',
          message: `⛔ background token in style. FIX: remove from style, add to className. background: "var(--s-warn-wash)"→"${tw('bg-', '[var(--s-warn-wash)]')}" background: "var(--overlay)"→"${tw('bg-', '[var(--overlay)]')}". Pattern: ${tw('bg-', '[var(--TOKEN)]')}.`,
        },

        // ═══ TAILWIND ARBITRARY PX VALUES ═══
        // Tailwind arbitrary pixel values bypass the token system.
        // Use a Tailwind arbitrary value with a CSS variable instead.
        {
          selector: 'Literal[value=/\\b(w|h|min-w|min-h|max-w|max-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|top|bottom|left|right)-\\[\\d+px\\]/]',
          message: `⛔ Tailwind arbitrary px value bypasses tokens. FIX: replace [Npx] with [var(--sp-*)] or [var(--size-token)]. E.g. ${tw('w-', '[60px]')}→${tw('w-', '[var(--token)]')} ${tw('gap-', '[8px]')}→${tw('gap-', '[var(--sp-2)]')}. Define new tokens in index.css if needed.`,
        },

        // ═══ BORDER EDGE SHORTHAND IN STYLE ═══
        // borderBottom/Top/Left/Right: 'var(--bw) solid var(--b1)' — use c-border-b class or longhands
        {
          selector: 'Property[key.name=/^border(Top|Bottom|Left|Right)$/][value.value=/var\\(--bw/]',
          message: '⛔ Border edge shorthand in style — React drops it on spread. FIX: best option: use className "c-border-b" (for --b1) or "c-border-b-b2" (for --b2). If not bottom or needs --b3/b4: split into border*Width: "var(--bw)", border*Style: "solid", border*Color: "var(--bN)".',
        },
        {
          selector: 'TemplateLiteral[parent.key.name=/^border(Top|Bottom|Left|Right)$/]',
          message: '⛔ Border edge template literal — React drops it on spread. FIX: split into border*Width, border*Style, border*Color longhands.',
        },

        // ═══ FONT SIZE TOKEN IN STYLE ═══
        {
          selector: 'JSXAttribute[name.name=/^(style|wrapperStyle|contentStyle)$/] Property[key.name="fontSize"][value.value=/^var\\(--text-/]',
          message: '⛔ fontSize token in style prop. FIX: remove from style/wrapperStyle/contentStyle and use a class or shared chart style helper. fontSize: "var(--text-data)"→className="text-data". Scale: xs, label, sm, data, heading, body, lg, xl, 2xl.',
        },

        // ═══ LETTER SPACING TOKEN IN STYLE ═══
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="letterSpacing"][value.value=/^var\\(--tracking-/]',
          message: '⛔ letterSpacing token in style. FIX: remove from style, add to className. letterSpacing: "var(--tracking-tight)"→"tracking-[var(--tracking-tight)]". Pattern: tracking-[var(--tracking-NAME)].',
        },

        // ═══ SIZING TOKEN IN STYLE ═══
        // width/height/min/max with var(--*) tokens → Tailwind arbitrary value classes
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="width"][value.value=/^var\\(--/]',
          message: `⛔ width token in style. FIX: remove from style, add to className. width: "var(--avatar-sm)"→"${tw('w-', '[var(--avatar-sm)]')}" width: "var(--sp-3)"→"${tw('w-', '[var(--sp-3)]')}". Pattern: ${tw('w-', '[var(--TOKEN)]')}.`,
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="height"][value.value=/^var\\(--/]',
          message: `⛔ height token in style. FIX: remove from style, add to className. height: "var(--avatar-sm)"→"${tw('h-', '[var(--avatar-sm)]')}" height: "var(--sp-3)"→"${tw('h-', '[var(--sp-3)]')}". Pattern: ${tw('h-', '[var(--TOKEN)]')}.`,
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="minHeight"][value.value=/^var\\(--/]',
          message: `⛔ minHeight token in style. FIX: remove from style, add to className. minHeight: "var(--toolbar-h)"→"${tw('min-h-', '[var(--toolbar-h)]')}". Pattern: ${tw('min-h-', '[var(--TOKEN)]')}.`,
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="maxWidth"][value.value=/^var\\(--/]',
          message: `⛔ maxWidth token in style. FIX: remove from style, add to className. maxWidth: "var(--empty-max-w)"→"${tw('max-w-', '[var(--empty-max-w)]')}". Pattern: ${tw('max-w-', '[var(--TOKEN)]')}.`,
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="minWidth"][value.value=/^var\\(--(?!bw)/]',
          message: `⛔ minWidth token in style. FIX: remove from style, add to className. minWidth: "var(--feed-min-w)"→"${tw('min-w-', '[var(--feed-min-w)]')}". Pattern: ${tw('min-w-', '[var(--TOKEN)]')}. Note: minWidth: 0 is handled by the min-w-0 rule.`,
        },

        // ═══ MARGIN TOKEN IN STYLE ═══
        // marginTop/Bottom/Left/Right with var(--sp-*) → mt-[]/mb-[]/ml-[]/mr-[] class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="marginTop"][value.value=/^var\\(--sp-/]',
          message: '⛔ marginTop token in style. FIX: remove from style, add to className. marginTop: "var(--sp-2)"→"mt-[var(--sp-2)]".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="marginBottom"][value.value=/^var\\(--sp-/]',
          message: '⛔ marginBottom token in style. FIX: remove from style, add to className. marginBottom: "var(--sp-2)"→"mb-[var(--sp-2)]".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="marginLeft"][value.value=/^var\\(--sp-/]',
          message: '⛔ marginLeft token in style. FIX: remove from style, add to className. marginLeft: "var(--sp-2)"→"ml-[var(--sp-2)]".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="marginRight"][value.value=/^var\\(--sp-/]',
          message: '⛔ marginRight token in style. FIX: remove from style, add to className. marginRight: "var(--sp-2)"→"mr-[var(--sp-2)]".',
        },

        // ═══ PADDING TOKEN IN STYLE ═══
        // padding: 'var(--sp-N)' → p-[var(--sp-N)] class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="padding"][value.value=/^var\\(--sp-\\w+\\)$/]',
          message: '⛔ padding token in style. FIX: remove padding from style, add to className. padding: "var(--sp-4)"→"p-[var(--sp-4)]". Pattern: p-[var(--sp-N)].',
        },
        // padding: 'var(--sp-Y) var(--sp-X)' → py-[var(--sp-Y)] px-[var(--sp-X)]
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="padding"][value.value=/^var\\(--sp-\\w+\\) var\\(--sp-\\w+\\)$/]',
          message: '⛔ Compound padding token in style. FIX: remove padding from style, add BOTH to className. padding: "var(--sp-2) var(--sp-4)"→"py-[var(--sp-2)] px-[var(--sp-4)]". First value is Y (top/bottom), second is X (left/right).',
        },
        // padding: '0 var(--sp-X)' → py-0 px-[var(--sp-X)]
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="padding"][value.value=/^0 var\\(--sp-/]',
          message: '⛔ Compound padding with zero in style. FIX: remove from style, add to className. padding: "0 var(--sp-4)"→"py-0 px-[var(--sp-4)]". First value=0→py-0, second is X→px-[var(--sp-X)].',
        },
        // padding: 'var(--sp-Y) 0' → py-[var(--sp-Y)] px-0
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="padding"][value.value=/^var\\(--sp-\\w+\\) 0$/]',
          message: '⛔ Compound padding with zero in style. FIX: remove from style, add to className. padding: "var(--sp-3) 0"→"py-[var(--sp-3)] px-0". First is Y→py-[var(--sp-Y)], second=0→px-0.',
        },
        // paddingTop/Bottom/Left/Right with token
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="paddingTop"][value.value=/^var\\(--sp-/]',
          message: '⛔ paddingTop token in style. FIX: remove from style, add to className. paddingTop: "var(--sp-2)"→"pt-[var(--sp-2)]".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="paddingBottom"][value.value=/^var\\(--sp-/]',
          message: '⛔ paddingBottom token in style. FIX: remove from style, add to className. paddingBottom: "var(--sp-2)"→"pb-[var(--sp-2)]".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="paddingLeft"][value.value=/^var\\(--sp-/]',
          message: '⛔ paddingLeft token in style. FIX: remove from style, add to className. paddingLeft: "var(--sp-2)"→"pl-[var(--sp-2)]".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="paddingRight"][value.value=/^var\\(--sp-/]',
          message: '⛔ paddingRight token in style. FIX: remove from style, add to className. paddingRight: "var(--sp-2)"→"pr-[var(--sp-2)]".',
        },

        // ═══ GAP TOKEN IN STYLE ═══
        // gap: 'var(--sp-*)' in JSX style should become a Tailwind arbitrary gap class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="gap"][value.value=/^var\\(--sp-/]',
          message: `⛔ gap token in style. FIX: remove gap from style, add to className. gap: "var(--sp-1)"→"${tw('gap-', '[var(--sp-1)]')}" gap: "var(--sp-2)"→"${tw('gap-', '[var(--sp-2)]')}" etc. Pattern: ${tw('gap-', '[var(--sp-N)]')}.`,
        },

        // ═══ BORDER RADIUS TOKEN IN STYLE ═══
        // borderRadius: 'var(--radius-*)' should be a Tailwind rounded-* class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="borderRadius"][value.value=/^var\\(--radius-/]',
          message: '⛔ borderRadius token in style. FIX: remove from style, add to className. var(--radius-xs)→"rounded-xs" var(--radius-sm)→"rounded-sm" var(--radius-md)→"rounded-md" var(--radius-lg)→"rounded-lg" var(--radius-circle)→"rounded-full".',
        },

        // ═══ SIMPLE BORDER COLOR IN STYLE ═══
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name=/^borderColor$|^border(Top|Bottom|Left|Right)Color$/][value.value=/^var\\(--b\\d\\)$/]',
          message: '⛔ Simple borderColor in style. FIX: if this is the ONLY border prop in style, move to className with border-[var(--bN)]. If part of a Width/Style/Color triplet, keep — triplets must stay together.',
        },

        // ═══ OVERFLOW AXIS IN STYLE ═══
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="overflowY"]',
          message: '⛔ Inline overflowY in style. FIX: remove from style, add to className. auto→"overflow-y-auto" scroll→"overflow-y-scroll" hidden→"overflow-y-hidden".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="overflowX"]',
          message: '⛔ Inline overflowX in style. FIX: remove from style, add to className. auto→"overflow-x-auto" scroll→"overflow-x-scroll" hidden→"overflow-x-hidden".',
        },

        // ═══ POINTER EVENTS IN STYLE ═══
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="pointerEvents"]',
          message: '⛔ Inline pointerEvents in style. FIX: remove from style, add to className. none→"pointer-events-none" auto→"pointer-events-auto".',
        },

        // ═══ CURSOR IN STYLE ═══
        // Cursor values have direct Tailwind equivalents
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="cursor"]',
          message: '⛔ Inline cursor in style. FIX: remove from style, add to className. pointer→"cursor-pointer" not-allowed→"cursor-not-allowed" default→"cursor-default" grab→"cursor-grab" text→"cursor-text".',
        },

        // ═══ MIN-WIDTH ZERO ═══
        // minWidth: 0 has a Tailwind equivalent
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="minWidth"][value.type="Literal"][value.raw="0"]',
          message: '⛔ Inline minWidth: 0 in style. FIX: remove from style, add "min-w-0" to className.',
        },

        // ═══ FLEX SHORTHAND IN STYLE ═══
        // Raw numeric flex values have Tailwind equivalents
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="flex"][value.type="Literal"][value.raw=/^[0-9]/]',
          message: '⛔ Inline flex numeric in style. FIX: remove from style, add to className. 1→"flex-1" 0→"flex-none". For flex: 1.6 or other ratios, use style={{ flex: "1.6" }} only if no Tailwind equivalent exists.',
        },

        // ═══ INLINE ANIMATION ═══
        // Animations with hardcoded durations should use CSS @keyframes + class
        {
          selector: 'Property[key.name="animation"][value.value=/\\d+\\.?\\d*(s|ms)/]',
          message: '⛔ Inline animation with hardcoded duration. FIX: move to a CSS @keyframes rule in index.css and apply via className.',
        },

        // ═══ WHITESPACE / TEXT STYLING IN STYLE ═══
        // These have direct Tailwind equivalents
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="whiteSpace"]',
          message: '⛔ Inline whiteSpace in style. FIX: remove from style, add to className. nowrap→"whitespace-nowrap" normal→"whitespace-normal" pre→"whitespace-pre" pre-wrap→"whitespace-pre-wrap".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="textTransform"]',
          message: '⛔ Inline textTransform in style. FIX: remove from style, add to className. uppercase→"uppercase" lowercase→"lowercase" capitalize→"capitalize" none→"normal-case".',
        },

        // ═══ GRID TEMPLATE HARDCODED PX ═══
        // gridTemplateColumns/Rows with hardcoded px should use tokens
        {
          selector: 'Property[key.name=/^gridTemplate/][value.value=/\\d{2,}px/]',
          message: '⛔ Hardcoded px in grid template. FIX: replace px values with CSS variables. E.g. 32px→var(--avatar-sm) 120px→token 140px→token 280px→token. Define new tokens in index.css if needed.',
        },

        // ═══ VIEWPORT UNITS ═══

        {
          selector: 'Property[key.name=/^(maxHeight|maxWidth|minHeight|minWidth|height|width)$/][value.value=/^\\d+(vh|vw)$/]',
          message: '⛔ Bare vh/vw unit. FIX: replace with CSS variable. 85vh→var(--modal-max-h) 90%→var(--panel-max-inline). Or use dvh for mobile safety.',
        },

        // ═══ INLINE TRANSITION ═══

        {
          selector: 'Property[key.name="transition"][value.value=/\\d+\\.?\\d*(s|ms)/]',
          message: '⛔ Inline transition with hardcoded duration. FIX: remove style, add c-hover or c-row-hover class. If custom: use var(--dur-fast/norm/slow) var(--ease).',
        },

        // ═══ DOM MANIPULATION ═══

        {
          selector: 'MemberExpression[property.name="backgroundColor"][object.property.name="style"]',
          message: '⛔ Direct style.backgroundColor mutation. FIX: use CSS :hover rule or React state + className toggle.',
        },
        {
          selector: 'MemberExpression[property.name="color"][object.property.name="style"]',
          message: '⛔ Direct style.color mutation. FIX: use CSS :hover rule or React state + className toggle.',
        },

        // ═══ LINE HEIGHT ═══

        {
          selector: 'Property[key.name="lineHeight"]',
          message: '⛔ Inline lineHeight. FIX: remove from style, add Tailwind class to className. Options: leading-none(1) leading-tight(1.25) leading-snug(1.375) leading-normal(1.5) leading-relaxed(1.625) leading-loose(2).',
        },

        // ═══ FONT WEIGHT ═══

        {
          selector: 'Property[key.name="fontWeight"]',
          message: '⛔ Inline fontWeight. FIX: remove from style, add Tailwind class to className. Options: font-normal(400) font-medium(500) font-semibold(600) font-bold(700) font-extrabold(800).',
        },

        // ═══ BOX SHADOW ═══

        {
          selector: 'Property[key.name="boxShadow"][value.value=/^[0-9]/]',
          message: '⛔ Hardcoded boxShadow. FIX: replace with token. Options: var(--card-shadow) var(--shadow-inset) var(--shadow-md) var(--shadow-lg). For glow: var(--s-ok-glow) var(--s-warn-glow) var(--s-crit-glow).',
        },
        // boxShadow with token → Tailwind arbitrary shadow class
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="boxShadow"][value.value=/^var\\(--/]',
          message: `⛔ boxShadow token in style. FIX: remove from style, add to className. boxShadow: "var(--card-shadow)"→"${tw('shadow-', '[var(--card-shadow)]')}". Pattern: ${tw('shadow-', '[var(--TOKEN)]')}.`,
        },

        // ═══ FOCUS RINGS ═══

        {
          selector: 'Property[key.name="outline"][value.value=/[0-9]+px/]',
          message: '⛔ Inline outline. FIX: remove — focus rings are set globally via :focus-visible in index.css. No per-element outline needed.',
        },
        {
          selector: 'Property[key.name="outlineWidth"]',
          message: '⛔ Inline outlineWidth. FIX: remove — focus ring width is set globally in index.css (1px inner / 1.5px outer).',
        },

        // ═══ Z-INDEX ═══

        {
          selector: 'Property[key.name="zIndex"][value.value=/^[0-9]+$/]',
          message: '⛔ Hardcoded zIndex string. FIX: remove from style, add Tailwind class to className. 10→z-10 (floating) 20→z-20 (secondary) 50→z-50 (dropdown) 100→z-100 (overlay/modal).',
        },
        {
          selector: 'Property[key.name="zIndex"][value.type="Literal"][value.raw=/^\\d+$/]',
          message: '⛔ Hardcoded numeric zIndex. FIX: remove from style, add Tailwind class to className. 10→z-10 (floating) 20→z-20 (secondary) 50→z-50 (dropdown) 100→z-100 (overlay/modal).',
        },

        // ═══ FONT FAMILY ═══

        {
          selector: 'Property[key.name="fontFamily"]',
          message: '⛔ Inline fontFamily. FIX: remove from style, add font-sans or font-mono to className.',
        },

        // ═══ BORDER WIDTH ═══

        {
          selector: 'Property[key.name="border"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded border width. FIX: use longhands instead. borderWidth: "var(--bw)", borderStyle: "solid", borderColor: "var(--b1)" (or --b2/--b3/--b4).',
        },
        {
          selector: 'Property[key.name="borderTop"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderTop width. FIX: use longhands. borderTopWidth: "var(--bw)", borderTopStyle: "solid", borderTopColor: "var(--b1)".',
        },
        {
          selector: 'Property[key.name="borderBottom"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderBottom width. FIX: use longhands. borderBottomWidth: "var(--bw)", borderBottomStyle: "solid", borderBottomColor: "var(--b1)".',
        },
        {
          selector: 'Property[key.name="borderLeft"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderLeft width. FIX: use longhands. borderLeftWidth: "var(--bw-accent)", borderLeftStyle: "solid", borderLeftColor: "var(--color-*)".',
        },
        {
          selector: 'Property[key.name="borderRight"][value.value=/^[0-9]+px solid/]',
          message: '⛔ Hardcoded borderRight width. FIX: use longhands. borderRightWidth: "var(--bw)", borderRightStyle: "solid", borderRightColor: "var(--b1)".',
        },

        // ═══ BORDER SHORTHAND ═══

        {
          selector: 'Property[key.name="border"][value.value=/var\\(--bw\\)/]',
          message: '⛔ Border shorthand in inline style — React drops it on spread. FIX: replace border: "var(--bw) solid var(--b1)" with borderWidth: "var(--bw)", borderStyle: "solid", borderColor: "var(--b1)".',
        },
        {
          selector: 'TemplateLiteral[parent.key.name="border"]',
          message: '⛔ Border template literal in inline style — React drops it on spread. FIX: split into borderWidth, borderStyle, borderColor longhands.',
        },

        // ═══ REGRESSIONS ═══

        {
          selector: 'Property[key.name="borderColor"][value.type="ConditionalExpression"][value.alternate.type="Identifier"][value.alternate.name="undefined"]',
          message: '⛔ borderColor ternary with undefined fallback silently drops the border. FIX: replace undefined with "var(--b2)" or "transparent".',
        },
        {
          selector: 'JSXAttribute[name.name="style"] Property[key.name="accentColor"]',
          message: '⛔ Inline accentColor. FIX: remove — checkbox/radio accent is set globally in index.css to var(--color-s-ok).',
        },

        // ═══ OPACITY ═══

        {
          selector: 'Property[key.name="opacity"][value.value=/^0\\.[0-9]/]',
          message: '⛔ Hardcoded string opacity. FIX: replace with token. 0.3→var(--opacity-soft) 0.4→var(--opacity-faint) 0.45→var(--opacity-disabled) 0.6→var(--opacity-muted). For hover dimming, use filter: brightness(0.85) instead.',
        },
        {
          selector: 'Property[key.name="opacity"][value.type="Literal"][value.raw=/^0\\.\\d/]',
          message: '⛔ Hardcoded numeric opacity. FIX: replace with string token. 0.3→"var(--opacity-soft)" 0.4→"var(--opacity-faint)" 0.45→"var(--opacity-disabled)" 0.6→"var(--opacity-muted)". For hover dimming, use filter: "brightness(0.85)" instead.',
        },

        // ═══ BUTTON TYPE ═══

        {
          selector: 'JSXOpeningElement[name.name="button"]:not(:has(JSXAttribute[name.name="type"]))',
          message: '⛔ <button> missing type attribute — defaults to "submit" which causes accidental form submissions. FIX: add type="button" to the <button> tag. Only use type="submit" if the button is inside a <form> and should submit it.',
        },

        // ═══ NAMED CSS COLOR KEYWORDS ═══

        {
          selector: 'Property[key.name="color"][value.value=/^(white|black|red|green|blue|gray|grey|transparent|inherit)$/i]',
          message: '⛔ Named CSS color keyword in style. FIX: replace with token. white→var(--color-t1), black→var(--color-d0). See cheat sheet.',
        },

        // ═══ LUCIDE STROKEWIDTH ═══

        {
          selector: 'JSXAttribute[name.name="strokeWidth"][value.expression.value=2]',
          message: '⛔ strokeWidth={2} is off-spec. FIX: use strokeWidth={1.75} (standard) or strokeWidth={1.25} (empty-state icons).',
        },

        // ═══ HARDCODED HSL() COLORS ═══

        {
          selector: 'Literal[value=/^hsl/]',
          message: '⛔ Hardcoded hsl() color. FIX: use a CSS custom property from the token system.',
        },
        {
          selector: 'TemplateLiteral:has(TemplateElement[value.raw=/^hsl/])',
          message: '⛔ Dynamic hsl() color generation bypasses token system. FIX: define fixed avatar color tokens.',
        },
]

const scheduledGroupsDesignSystemRestrictions = [
  // ═══ SCHEDULED/GROUP SURFACES — STRICT RATCHET ═══
  // Stricter rules for newer UI surfaces. These augment the global rules above.

  {
    // Match raw hex COLORS embedded in strings while excluding decimal
    // order/build numbers like "#4921" / "#512" that share the "#NNNN" shape.
    // A valid CSS hex color is exactly 3, 6, or 8 hex digits at a word boundary:
    //   - 6 or 8 hex digits  → always a color (incl. all-decimal like #11223344)
    //   - exactly 3 hex digits → only a color when it contains an a-f letter,
    //     so #fff/#abc match but pure-decimal #512 (an order number) does not.
    // 4- and 5-digit "#NNNN" sequences are not valid color lengths and never match.
    // (Standalone literals whose ENTIRE value is a hex color are still caught by
    //  the anchored /^#[0-9a-fA-F]{3,8}$/ global selector above.)
    selector: 'Literal[value=/#(?:[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\\b|(?=[0-9a-fA-F]{3}\\b)[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]*\\b)/]',
    message: '⛔ Hardcoded hex color in string. FIX: replace with CSS variable. Backgrounds: var(--color-d0..d6). Text: var(--color-t1..t5). Status: var(--color-s-ok/warn/crit).',
  },

  // Border edge shorthand rules are now in the global set — no duplicate needed here.

  // ═══ HEIGHT AUTO IN STYLE ═══
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="height"][value.value="auto"]',
    message: '⛔ Inline height: auto. FIX: remove from style, add "h-auto" to className.',
  },

  // ═══ MAX-HEIGHT TOKEN IN STYLE ═══
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="maxHeight"][value.value=/^var\\(--modal/]',
    message: '⛔ Inline maxHeight modal token. FIX: remove from style, add max-h-[var(--modal-max-h)] to className.',
  },

  // ═══ TOP/LEFT/RIGHT POSITIONING ═══
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="top"][value.value="100%"]',
    message: '⛔ Inline top: 100%. FIX: remove from style, add "top-full" to className.',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name=/^(left|right)$/][value.value=/^var\\(--sp/]',
    message: `⛔ Inline left/right with token. FIX: remove from style, add ${tw('left-', '[var(--TOKEN)]')} or ${tw('right-', '[var(--TOKEN)]')} to className.`,
  },

  // ═══ LAYOUT-IN-STYLE — move to className ═══
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="display"]',
    message: '⛔ Inline display in style. FIX: remove from style, add to className. flex→"flex" inline-flex→"inline-flex" block→"block" inline-block→"inline-block" grid→"grid" none→"hidden".',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="alignItems"]',
    message: '⛔ Inline alignItems in style. FIX: remove from style, add to className. center→"items-center" start/flex-start→"items-start" end/flex-end→"items-end" baseline→"items-baseline" stretch→"items-stretch".',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="justifyContent"]',
    message: '⛔ Inline justifyContent in style. FIX: remove from style, add to className. center→"justify-center" space-between→"justify-between" flex-start→"justify-start" flex-end→"justify-end".',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="flexWrap"]',
    message: '⛔ Inline flexWrap in style. FIX: remove from style, add to className. wrap→"flex-wrap" nowrap→"flex-nowrap".',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="flexShrink"]',
    message: '⛔ Inline flexShrink in style. FIX: remove from style, add to className. 0→"shrink-0" (or "flex-shrink-0").',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="flexGrow"]',
    message: '⛔ Inline flexGrow in style. FIX: remove from style, add to className. 1→"grow" (or "flex-grow") 0→"grow-0".',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="textAlign"]',
    message: '⛔ Inline textAlign in style. FIX: remove from style, add to className. left→"text-left" center→"text-center" right→"text-right".',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="overflow"][value.value=/^(hidden|auto|scroll)$/]',
    message: '⛔ Inline overflow in style. FIX: remove from style, add to className. hidden→"overflow-hidden" auto→"overflow-auto" scroll→"overflow-scroll". For single axis: "overflow-y-auto" etc.',
  },
  {
    selector: 'JSXAttribute[name.name="style"] Property[key.name="position"][value.value=/^(relative|absolute|fixed|sticky)$/]',
    message: '⛔ Inline position in style. FIX: remove from style, add to className. relative→"relative" absolute→"absolute" fixed→"fixed" sticky→"sticky".',
  },
]

export default defineConfig([
  globalIgnores(['dist']),

  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      soup: soupPlugin,
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Block 1 — Base rule set for all TS/TSX.
  // Includes: designSystemRestrictions (existing wall) + Group S (structural,
  // zero-violation console-wide, now also includes no-raw-button / no-adhoc-modal /
  // no-infinite-animation promoted 2026-06-15) + Group F (focus suppression, console-wide).
  // Last-match-wins: files matched by a later block get that block's full array.
  // ─────────────────────────────────────────────────────────────────────────
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
      'soup/protected-identifiers': 'error',
      'soup/icon-family': 'error',
      'soup/no-format-bypass': 'error',
      'soup/no-literal-status-colors': 'error',
      'soup/no-inline-dismiss-handler': 'error',

      // ═══════════════════════════════════════════════════════════════
      // DESIGN SYSTEM ENFORCEMENT
      //
      // These rules prevent hardcoded styles that bypass the token system
      // defined in index.css. Every visual property should reference a
      // CSS custom property (var(--*)) or a design system utility class.
      //
      // Each error message is a self-contained fix recipe. A model can
      // run `npx eslint src/` and fix errors one at a time using only
      // the information in the error message + the cheat sheet above.
      // ═══════════════════════════════════════════════════════════════

      'no-restricted-syntax': [
        'error',
        ...designSystemRestrictions,
        // Group S: structural (console-wide, excludes primitives/**):
        ...structuralSelectors,
        // Raw form controls are also console-wide except primitives/**:
        ...rawFormControlSelectors,
        // Group F: focus suppression (console-wide):
        ...focusSuppressionSelectors,
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Block 3 — Scheduled/groups ratchet (existing strict set, re-carried).
  // Must re-carry the full base array PLUS Group S + Group F because flat-config
  // last-match-wins replaces, not merges, the no-restricted-syntax rule.
  // Group S now includes no-raw-button / no-adhoc-modal / no-infinite-animation
  // (promoted 2026-06-15) so this re-carry automatically enforces those console-wide.
  // CreateGroupModal is also in the M list — it gets the full union in Block 4b.
  // ─────────────────────────────────────────────────────────────────────────
  {
    files: [
      'src/components/shared/SearchInput.tsx',
      'src/components/shared/ContactSearchPicker.tsx',
      'src/components/shared/ChatPicker.tsx',
      'src/components/line-detail/ScheduleComposerModal.tsx',
      'src/components/line-detail/GroupDetailModal.tsx',
      'src/components/line-detail/GroupCard.tsx',
      'src/components/line-detail/GroupsTab.tsx',
      'src/components/line-detail/ScheduledTab.tsx',
      'src/components/line-detail/ScheduledMessageRow.tsx',
      'src/components/line-detail/scheduled-utils.ts',
      'src/components/line-detail/groups-utils.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...designSystemRestrictions,
        ...scheduledGroupsDesignSystemRestrictions,
        // Re-carry Group S, raw form controls, and Group F so they aren't silently dropped for these files:
        ...structuralSelectors,
        ...rawFormControlSelectors,
        ...focusSuppressionSelectors,
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Block 4a — Migrated surfaces (M list, excluding CreateGroupModal).
  // NOTE: no-raw-button, no-adhoc-modal, and no-infinite-animation are now
  // console-wide (promoted 2026-06-15 into structuralSelectors/Group S).
  // Full array: base + structural (incl. promoted M rules) + focus.
  // ─────────────────────────────────────────────────────────────────────────
  {
    files: [
      'src/components/AddLineWizard.tsx',
      'src/pages/LineDetail.tsx',
      'src/pages/SoupKitchen.tsx',
      'src/components/TagInput.tsx',
      'src/components/CardSelector.tsx',
      'src/components/ConfirmDialog.tsx',
      'src/components/RelinkModal.tsx',
      'src/components/UpdateModal.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...designSystemRestrictions,
        // Group S, raw form controls, F, and M:
        ...structuralSelectors,
        ...rawFormControlSelectors,
        ...focusSuppressionSelectors,
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Block 4b — CreateGroupModal full union.
  // CreateGroupModal is in BOTH the scheduled/groups list AND the M list.
  // It must carry the union of all: base + scheduled + structural + focus + migrated.
  // Placing it in 4a alone would silently strip the scheduled ratchet (flat-config
  // replace semantics — last match wins). Constraint §3 in d6-investigation.md.
  // ─────────────────────────────────────────────────────────────────────────
  {
    files: [
      'src/components/line-detail/CreateGroupModal.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...designSystemRestrictions,
        ...scheduledGroupsDesignSystemRestrictions,
        // Full union — Group S, raw form controls, F:
        ...structuralSelectors,
        ...rawFormControlSelectors,
        ...focusSuppressionSelectors,
      ],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Block 5 — Primitives strict tier (Group P).
  // components/primitives/** is born-clean: grep-verified zero legacy tokens and
  // utility smells (d6-investigation.md §3). Error here prevents any re-entry.
  // Deliberately NO structural or migrated selectors (Table/LogStream/Button/Modal
  // ARE the canonical renderers; they must render the raw elements).
  // Carries base + focus + legacyToken + utilitySmell only.
  // ─────────────────────────────────────────────────────────────────────────
  {
    files: [
      'src/components/primitives/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...designSystemRestrictions,
        // Group F (focus suppression applies in primitives):
        ...focusSuppressionSelectors,
        // Group P: legacy tokens and utility smell (primitives-only):
        ...legacyTokenSelectors,
        ...utilitySmellSelectors,
      ],
    },
  },
])
