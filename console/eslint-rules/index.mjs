/**
 * console/eslint-rules/index.mjs
 *
 * Local ESLint plugin: soup/* custom rules.
 * Registered as { soup: soupPlugin } in eslint.config.js.
 *
 * Rules implemented here (entry per lint-plan section 3):
 *   soup/no-brand-regression  — flags "WhatSoup" in JSXText / JSX string attrs
 *                               + the split-span wordmark detector
 *   soup/protected-identifiers — flags near-miss renames of protected protocol contracts
 *   soup/icon-family           — permits lucide-react icons and denies other icon packages
 *   soup/no-inline-dismiss-handler
 *                             — flags hand-rolled Escape dismissal effects outside
 *                               the single useDismissable hook
 *
 * Rules stubbed (proposed / needs primitives / CSS-side):
 *   soup/no-duplicate-shell          — heuristic, warn-ceiling
 *   soup/no-literal-status-colors    — shadow; P2
 *   soup/focus-visible-required      — shadow; primitives-first (P2)
 *   soup/modal-must-restore-focus    — proposed; Modal primitive must exist first
 *   soup/motion-needs-reduced-variant — shadow; CSS-script-primary (section 5)
 *   soup/no-format-bypass            — shadow; enabled after lib gains epoch overloads (P3)
 */

// ---------------------------------------------------------------------------
// Frozen contract identifier list (soup/protected-identifiers allowlist).
// These strings are protocol contracts that must NOT be renamed by a UI rebrand.
// ---------------------------------------------------------------------------
const PROTECTED_CONTRACT_PATTERNS = [
  'WhatSoupError',
  'mcp__whatsoup__',
  'whatsoup:',
  '/run/whatsoup/',
  '~/.local/share/whatsoup/',
  'whatsoup@',
  'whatsoup/instances',
  '~/.config/whatsoup/',
]

const PROTECTED_CONTRACT_NEAR_MISSES = [
  { pattern: /(?<!What)SoupError\b/, valid: 'WhatSoupError' },
  { pattern: /\bmcp__soup__/, valid: 'mcp__whatsoup__' },
  { pattern: /(?<!what)soup:/, valid: 'whatsoup:' },
  { pattern: /\/run\/soup\//, valid: '/run/whatsoup/' },
  { pattern: /~\/\.local\/share\/soup\//, valid: '~/.local/share/whatsoup/' },
  { pattern: /(?<!what)soup@/, valid: 'whatsoup@' },
  { pattern: /(?<!what)soup\/instances/, valid: 'whatsoup/instances' },
  { pattern: /~\/\.config\/soup\//, valid: '~/.config/whatsoup/' },
]

const DENIED_ICON_IMPORTS = [
  /^@heroicons\//,
  /^@tabler\/icons/,
  /^@phosphor-icons\//,
  /^@radix-ui\/react-icons$/,
  /^react-icons(\/|$)/,
  /^phosphor-react$/,
  /^@fortawesome\//,
  /^fontawesome/,
  /^bootstrap-icons(\/|$)/,
]

const INLINE_DISMISS_EXEMPT_FILE_SUFFIXES = [
  'hooks/use-dismissable.ts',
  'hooks/use-keyboard-shortcuts.ts',
]

/**
 * Returns true if the string contains a protected contract identifier.
 * Used to build the allowlist so those occurrences are not flagged by
 * soup/no-brand-regression.
 */
function isProtectedContract(str) {
  if (typeof str !== 'string') return false
  return PROTECTED_CONTRACT_PATTERNS.some((p) => str.includes(p))
}

// ---------------------------------------------------------------------------
// Files that hold the EXEMPT-PROTECTED template literal (ConfigStep system-prompt).
// Matched against the resolved filename using a path-suffix test.
// ---------------------------------------------------------------------------
const EXEMPT_FILE_SUFFIXES = [
  'components/wizard/ConfigStep.tsx',
]

function isExemptFile(filename) {
  if (!filename) return false
  return EXEMPT_FILE_SUFFIXES.some((s) => filename.endsWith(s))
}

function isInlineDismissExemptFile(filename) {
  if (!filename) return false
  return INLINE_DISMISS_EXEMPT_FILE_SUFFIXES.some((s) => filename.endsWith(s))
}

function checkTextLiterals(context, checkStringValue) {
  return {
    Literal(node) {
      checkStringValue(node, node.value)
    },
    TemplateElement(node) {
      checkStringValue(node, node.value.raw)
    },
    JSXText(node) {
      checkStringValue(node, node.value)
    },
  }
}

// ---------------------------------------------------------------------------
// soup/no-brand-regression
// Lint-plan section 3: shadow entry state, P4 target.
// ---------------------------------------------------------------------------
const noBrandRegression = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prevent the string "WhatSoup" from appearing in user-facing JSX after the P4 branding flip. ' +
        'Also detects the split-wordmark pattern (adjacent spans rendering "What" + "Soup"). ' +
        'See lint-plan section 3 soup/no-brand-regression for dispositions and exemptions.',
    },
    messages: {
      jsxText:
        '[soup/no-brand-regression] "WhatSoup" in JSX text — replace with the locked brand name. ' +
        'See lint-plan section 3 for P4 copy dispositions.',
      jsxAttr:
        '[soup/no-brand-regression] "WhatSoup" in JSX string attribute — replace with the locked brand name.',
      splitWordmark:
        '[soup/no-brand-regression] Split wordmark detected: adjacent JSX spans render "What"+"Soup". ' +
        'These two spans must flip together at P4 (Nav.tsx:39-40).',
      documentTitle:
        '[soup/no-brand-regression] "WhatSoup" in document.title assignment — flip at P4.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename ? context.getFilename() : (context.filename ?? '')

    // The ConfigStep system-prompt template literal is EXEMPT-PROTECTED.
    if (isExemptFile(filename)) return {}

    function checkStringValue(node, str, messageId) {
      if (typeof str !== 'string') return
      // Skip protected contract identifiers (whatsoup:, WhatSoupError, etc.)
      if (isProtectedContract(str)) return
      if (str.includes('WhatSoup')) {
        context.report({ node, messageId })
      }
    }

    return {
      // (a) JSXText containing "WhatSoup"
      JSXText(node) {
        const raw = node.value
        if (raw && raw.includes('WhatSoup')) {
          context.report({ node, messageId: 'jsxText' })
        }
      },

      // (b) Literal in JSX attribute position
      'JSXAttribute > Literal'(node) {
        checkStringValue(node, node.value, 'jsxAttr')
      },

      // (b2) Literal in JSX expression container (inline text, e.g. ternaries)
      // Catches: {cond ? 'Update WhatSoup' : 'Done'}
      'JSXExpressionContainer Literal'(node) {
        // Skip if this is inside a JSXAttribute (already covered by (b))
        let parent = node.parent
        while (parent) {
          if (parent.type === 'JSXAttribute') return
          if (parent.type === 'JSXExpressionContainer') break
          parent = parent.parent
        }
        checkStringValue(node, node.value, 'jsxText')
      },

      // (c) TemplateLiteral in JSX attribute position
      'JSXAttribute > JSXExpressionContainer > TemplateLiteral'(node) {
        for (const quasi of node.quasis) {
          if (quasi.value.raw && quasi.value.raw.includes('WhatSoup')) {
            if (!isProtectedContract(quasi.value.raw)) {
              context.report({ node, messageId: 'jsxAttr' })
            }
          }
        }
      },

      // (d) document.title = "..." assignments
      'AssignmentExpression'(node) {
        if (
          node.left.type === 'MemberExpression' &&
          node.left.object.name === 'document' &&
          node.left.property.name === 'title'
        ) {
          if (node.right.type === 'Literal') {
            checkStringValue(node.right, node.right.value, 'documentTitle')
          }
        }
      },

      // (e) Split-wordmark detector:
      // A JSXElement containing an adjacent "What" span followed by a "Soup" span.
      // Matches the Nav pattern: <span>What</span><span>Soup</span>
      'JSXElement'(node) {
        const children = node.children.filter(
          (c) =>
            (c.type === 'JSXText' && c.value.trim() !== '') ||
            c.type === 'JSXElement'
        )
        for (let i = 0; i < children.length - 1; i++) {
          const a = children[i]
          const b = children[i + 1]

          const textOf = (n) => {
            if (n.type === 'JSXText') return n.value.trim()
            // JSXElement with a single JSXText child
            if (n.type === 'JSXElement') {
              const textChildren = n.children.filter(
                (c) => c.type === 'JSXText'
              )
              if (textChildren.length === 1) return textChildren[0].value.trim()
            }
            return ''
          }

          if (textOf(a) === 'What' && textOf(b) === 'Soup') {
            context.report({ node: a, messageId: 'splitWordmark' })
          }
        }
      },
    }
  },
}

// ---------------------------------------------------------------------------
// soup/protected-identifiers
// Lint-plan section 3: scoped-error entry state, P1 target.
// ---------------------------------------------------------------------------
const protectedIdentifiers = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Prevent protocol/storage contract identifiers from being partially renamed during UI rebrands. ' +
        'Flags near-miss SOUP forms such as soup:, /run/soup/, and SoupError. ' +
        'See lint-plan section 3 soup/protected-identifiers.',
    },
    messages: {
      nearMiss:
        '[soup/protected-identifiers] Protected contract near-miss "{{match}}" detected. ' +
        'Keep the protocol/storage identifier as "{{valid}}" unless a migration is explicitly approved.',
    },
    schema: [],
  },

  create(context) {
    function checkStringValue(node, str) {
      if (typeof str !== 'string') return
      for (const { pattern, valid } of PROTECTED_CONTRACT_NEAR_MISSES) {
        const match = pattern.exec(str)
        if (!match) continue
        context.report({
          node,
          messageId: 'nearMiss',
          data: {
            match: match[0],
            valid,
          },
        })
        return
      }
    }

    return checkTextLiterals(context, checkStringValue)
  },
}

// ---------------------------------------------------------------------------
// soup/icon-family
// Lint-plan section 3: scoped-error entry state, P1 target.
// ---------------------------------------------------------------------------
const iconFamily = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep console UI icons on the approved Lucide family. ' +
        'Flags known alternate icon packages while allowing local components such as FeedIcon.',
    },
    messages: {
      deniedImport:
        '[soup/icon-family] Icon package "{{source}}" is not allowed. Use lucide-react for UI icons.',
    },
    schema: [],
  },

  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source?.value
        if (typeof source !== 'string' || source === 'lucide-react') return
        if (!DENIED_ICON_IMPORTS.some((pattern) => pattern.test(source))) return
        context.report({
          node: node.source,
          messageId: 'deniedImport',
          data: { source },
        })
      },
    }
  },
}

// ---------------------------------------------------------------------------
// soup/no-inline-dismiss-handler
// Lint-plan section 3: global-error entry state, P2 target.
// ---------------------------------------------------------------------------
function isUseEffectCall(node) {
  if (!node || node.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee?.type === 'Identifier') return callee.name === 'useEffect'
  return callee?.type === 'MemberExpression' && callee.property?.name === 'useEffect'
}

function hasUseEffectCallbackAncestor(node) {
  let current = node
  while (current?.parent) {
    const parent = current.parent
    if (
      (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') &&
      isUseEffectCall(parent) &&
      parent.arguments?.[0] === current
    ) {
      return true
    }
    current = parent
  }
  return false
}

function isEscapeLiteral(node) {
  return node?.type === 'Literal' && node.value === 'Escape'
}

function isEventKeyMember(node) {
  if (node?.type !== 'MemberExpression') return false
  if (node.computed) return node.property?.type === 'Literal' && node.property.value === 'key'
  return node.property?.type === 'Identifier' && node.property.name === 'key'
}

const noInlineDismissHandler = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Prevent hand-rolled Escape dismissal useEffect handlers outside useDismissable. ' +
        'The single dismissal hook owns overlay Escape/outside-click behavior.',
    },
    messages: {
      inlineEscape:
        '[soup/no-inline-dismiss-handler] Hand-rolled Escape dismissal inside useEffect must use useDismissable. ' +
        'Move overlay dismissal to console/src/hooks/use-dismissable.ts instead of comparing event.key to "Escape" locally.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename ? context.getFilename() : (context.filename ?? '')
    if (isInlineDismissExemptFile(filename)) return {}

    return {
      BinaryExpression(node) {
        if (!['===', '==', '!==', '!='].includes(node.operator)) return
        const comparesEscape =
          (isEventKeyMember(node.left) && isEscapeLiteral(node.right)) ||
          (isEscapeLiteral(node.left) && isEventKeyMember(node.right))
        if (!comparesEscape) return
        if (!hasUseEffectCallbackAncestor(node)) return
        context.report({ node, messageId: 'inlineEscape' })
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Stubs for rules that are proposed or need primitives / CSS-side work first.
// Each stub is a valid rule that fires zero violations (returns {}).
// Documented so the lifecycle table remains consistent.
// ---------------------------------------------------------------------------

function makeStub(description) {
  return {
    meta: {
      type: 'suggestion',
      docs: { description },
      schema: [],
      messages: {},
    },
    create() {
      return {}
    },
  }
}

const noDuplicateShell = makeStub(
  '[stub] soup/no-duplicate-shell — SHADOW advisory. Full implementation is a warn-ceiling ' +
    'heuristic flagging surface+border+radius class combinations outside primitives. ' +
    'Currently a stub pending P2 primitive landing.'
)

const noLiteralStatusColors = makeStub(
  '[stub] soup/no-literal-status-colors — SHADOW. Will flag var(--color-s-*) and ' +
    'bg/text-s-* utilities outside lib/status.ts + status primitives. ' +
    'Enabled with P2 helper consolidation.'
)

const focusVisibleRequired = makeStub(
  '[stub] soup/focus-visible-required — SHADOW primitives-first. Will fire in ' +
    'components/primitives/** once that directory exists (P2).'
)

const modalMustRestoreFocus = makeStub(
  '[stub] soup/modal-must-restore-focus — PROPOSED. Presence-check rule; requires Modal ' +
    'primitive with restoreFocusOnClose marker (P2).'
)

const motionNeedsReducedVariant = makeStub(
  '[stub] soup/motion-needs-reduced-variant — SHADOW. Primary check is CSS-script-side ' +
    '(section 5). TSX side: motion.* usage without useReducedMotion import. ' +
    'Full implementation at P5.'
)

const noFormatBypass = makeStub(
  '[stub] soup/no-format-bypass — SHADOW. Enabled after format-time.ts gains epoch overloads ' +
    '(P3). Will flag toLocaleString/toLocaleDateString outside lib/.'
)

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------
export default {
  meta: {
    name: 'soup',
    version: '0.1.0',
  },
  rules: {
    'no-brand-regression': noBrandRegression,
    'protected-identifiers': protectedIdentifiers,
    'icon-family': iconFamily,
    'no-duplicate-shell': noDuplicateShell,
    'no-literal-status-colors': noLiteralStatusColors,
    'focus-visible-required': focusVisibleRequired,
    'modal-must-restore-focus': modalMustRestoreFocus,
    'motion-needs-reduced-variant': motionNeedsReducedVariant,
    'no-format-bypass': noFormatBypass,
    'no-inline-dismiss-handler': noInlineDismissHandler,
  },
}
