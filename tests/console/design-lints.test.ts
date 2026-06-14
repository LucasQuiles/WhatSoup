/**
 * tests/console/design-lints.test.ts
 *
 * LINT-PLAN PROMOTION GATE — negative-fixture suite for shadow rules.
 *
 * PURPOSE: Every shadow rule that targets promotion past "shadow" state MUST have
 * a fixture entry here that:
 *   (a) proves the rule FIRES on a violating code fragment, and
 *   (b) proves the rule stays SILENT on a compliant alternative.
 *
 * These tests are the BLOCKING gate described in:
 *   docs/design-system/06-implementation/d6-survey.md  (must-dos)
 *   docs/design-system/04-enforcement/lint-plan.md     (lifecycle: shadow->proposed->error)
 *
 * A rule MUST NOT be promoted past shadow until its describe block exists here
 * with at least one firing case and one compliant case.
 *
 * IMPLEMENTATION NOTES
 * --------------------
 * API path: lintText() via ESLint Node API (ESLint 9.x flat-config).
 *   - One shared ESLint instance is created once per file (beforeAll).
 *   - Fixture filePath is set to a virtual .tsx file OUTSIDE the primitives
 *     directory so the components/primitives exemption does not mask fires.
 *   - A second instance targets a primitives path to prove the exemption works.
 *   - All assertions filter by severity === 1 (warnings) to isolate shadow rules
 *     from pre-existing error-severity violations in base config.
 *
 * RUNTIME: ~5-10 s for the full suite (one ESLint init, all lintText calls share it).
 */

import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ESLint as ESLintType } from 'eslint'

// ---------------------------------------------------------------------------
// Setup - shared ESLint instance
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '../..'  )
const SHADOW_CONFIG = resolve(REPO_ROOT, 'console/eslint.config.shadow.mjs')
const CONSOLE_CWD = resolve(REPO_ROOT, 'console')

// Virtual fixture path: outside primitives dir so no exemptions apply.
const FIXTURE_PATH = resolve(REPO_ROOT, 'console/src/pages/__fixture__.tsx')
// Virtual primitives path: inside primitives dir to verify exemptions.
const PRIMITIVES_FIXTURE_PATH = resolve(REPO_ROOT, 'console/src/components/primitives/__fixture__.tsx')
// ConfigStep path: exempt from soup/no-brand-regression by EXEMPT_FILE_SUFFIXES.
const CONFIGSTEP_PATH = resolve(REPO_ROOT, 'console/src/components/wizard/ConfigStep.tsx')
const USE_DISMISSABLE_PATH = resolve(REPO_ROOT, 'console/src/hooks/use-dismissable.ts')
const KEYBOARD_SHORTCUTS_PATH = resolve(REPO_ROOT, 'console/src/hooks/use-keyboard-shortcuts.ts')

let eslint: ESLintType
let eslintPrimitives: ESLintType

// ESLint 9.x is ESM-only; import dynamically inside beforeAll.
beforeAll(async () => {
  const { ESLint } = await import('eslint')
  eslint = new ESLint({
    overrideConfigFile: SHADOW_CONFIG,
    cwd: CONSOLE_CWD,
  })
  eslintPrimitives = new ESLint({
    overrideConfigFile: SHADOW_CONFIG,
    cwd: CONSOLE_CWD,
  })
})

/**
 * Lint a source string and return only severity-1 (warn) messages.
 * Isolates shadow-rule warnings from pre-existing error-severity base violations.
 */
async function lintWarnings(src: string, filePath = FIXTURE_PATH): Promise<string[]> {
  const results = await eslint.lintText(src, { filePath })
  return results[0].messages
    .filter((m) => m.severity === 1)
    .map((m) => m.message)
}

async function lintWarningsPrimitives(src: string): Promise<string[]> {
  const results = await eslintPrimitives.lintText(src, { filePath: PRIMITIVES_FIXTURE_PATH })
  return results[0].messages
    .filter((m) => m.severity === 1)
    .map((m) => m.message)
}

function hasWarning(messages: string[], keyword: string): boolean {
  return messages.some((m) => m.includes(keyword))
}

// ---------------------------------------------------------------------------
// P1 scoped plugin rule - soup/protected-identifiers
// Flags near-miss protocol/storage contract strings while allowing the frozen
// whatsoup-form contracts that brand rules must not rename.
// ---------------------------------------------------------------------------

describe('soup/protected-identifiers', () => {
  it('fires when the localStorage namespace is renamed to soup:', async () => {
    const messages = await lintWarnings(
      `const PREFIX = 'soup:'`
    )
    expect(hasWarning(messages, 'protected-identifiers')).toBe(true)
  })

  it('fires when a socket path is renamed to /run/soup/', async () => {
    const messages = await lintWarnings(
      `const socketPath = '/run/soup/personal.sock'`
    )
    expect(hasWarning(messages, 'protected-identifiers')).toBe(true)
  })

  it('is silent for the protected whatsoup contract forms', async () => {
    const messages = await lintWarnings(
      `const prefix = 'whatsoup:'
const socketPath = '/run/whatsoup/personal.sock'
const cwd = '~/.local/share/whatsoup/instances/sales/workspace'
const serviceTemplate = 'whatsoup@'`
    )
    expect(hasWarning(messages, 'protected-identifiers')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P1 scoped plugin rule - soup/icon-family
// Denies alternate third-party icon packages while allowing lucide-react and
// local components that happen to include "Icon" in their filename.
// ---------------------------------------------------------------------------

describe('soup/icon-family', () => {
  it('fires on a non-Lucide third-party icon package import', async () => {
    const messages = await lintWarnings(
      `import { FaBeer } from 'react-icons/fa'
const x = FaBeer`
    )
    expect(hasWarning(messages, 'icon-family')).toBe(true)
  })

  it('is silent for lucide-react imports', async () => {
    const messages = await lintWarnings(
      `import { X } from 'lucide-react'
const x = <X />`
    )
    expect(hasWarning(messages, 'icon-family')).toBe(false)
  })

  it('is silent for local icon components', async () => {
    const messages = await lintWarnings(
      `import FeedIcon from '../components/FeedIcon'
const x = <FeedIcon kind="message" />`
    )
    expect(hasWarning(messages, 'icon-family')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P2 custom plugin rule - soup/no-inline-dismiss-handler
// Flags hand-rolled Escape dismissal inside useEffect callbacks. Exempts the
// canonical useDismissable hook and the global keyboard-shortcuts hook.
// ---------------------------------------------------------------------------

describe('soup/no-inline-dismiss-handler', () => {
  it('fires on a hand-rolled document Escape listener inside useEffect', async () => {
    const messages = await lintWarnings(
      `import { useEffect } from 'react'
export function Dialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [onClose])
  return null
}`
    )
    expect(hasWarning(messages, 'no-inline-dismiss-handler')).toBe(true)
  })

  it('fires on a reverse Escape comparison inside a useEffect callback', async () => {
    const messages = await lintWarnings(
      `import { useEffect } from 'react'
export function Dialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ('Escape' !== event.key) return
      onClose()
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [onClose])
  return null
}`
    )
    expect(hasWarning(messages, 'no-inline-dismiss-handler')).toBe(true)
  })

  it('is silent when dismissal is delegated to useDismissable', async () => {
    const messages = await lintWarnings(
      `import { useRef } from 'react'
import { useDismissable } from '../hooks/use-dismissable'
export function Dialog({ onClose, open }: { onClose: () => void; open: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismissable(ref, { onClose, open })
  return <div ref={ref} />
}`
    )
    expect(hasWarning(messages, 'no-inline-dismiss-handler')).toBe(false)
  })

  it('is silent for non-dismiss inline keyboard handling', async () => {
    const messages = await lintWarnings(
      `const x = <textarea onKeyDown={e => {
  if (e.key === 'Enter' && !e.shiftKey) e.preventDefault()
}} />`
    )
    expect(hasWarning(messages, 'no-inline-dismiss-handler')).toBe(false)
  })

  it('is silent inside the canonical useDismissable hook', async () => {
    const messages = await lintWarnings(
      `import { useEffect } from 'react'
export function useDismissable() {
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [])
}`,
      USE_DISMISSABLE_PATH
    )
    expect(hasWarning(messages, 'no-inline-dismiss-handler')).toBe(false)
  })

  it('is silent inside the global keyboard-shortcuts hook', async () => {
    const messages = await lintWarnings(
      `import { useEffect } from 'react'
export function useKeyboardShortcuts() {
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') return
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [])
}`,
      KEYBOARD_SHORTCUTS_PATH
    )
    expect(hasWarning(messages, 'no-inline-dismiss-handler')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 1 - soup/no-raw-button
// Selector: JSXOpeningElement[name.name="button"]
// Exemption: components/primitives/** (Button primitive must render real <button>)
// ---------------------------------------------------------------------------

describe('soup/no-raw-button', () => {
  it('fires on raw <button> outside primitives dir', async () => {
    const messages = await lintWarnings('<button type="button">Click me</button>')
    expect(hasWarning(messages, 'no-raw-button')).toBe(true)
  })

  it('is silent when using a named Button component (no raw button tag)', async () => {
    const messages = await lintWarnings(
      `import { Button } from '../components/primitives/Button'
const x = <Button variant="primary">Click me</Button>`
    )
    expect(hasWarning(messages, 'no-raw-button')).toBe(false)
  })

  it('is silent inside components/primitives (permanent exemption)', async () => {
    const messages = await lintWarningsPrimitives(
      '<button type="button" className="btn-base">{children}</button>'
    )
    expect(hasWarning(messages, 'no-raw-button')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 2 - soup/no-adhoc-modal (two prongs)
// Prong a: Literal[value=/c-dialog-backdrop/]
// Prong b: JSXAttribute[name.name="role"][value.value="dialog"]
// ---------------------------------------------------------------------------

describe('soup/no-adhoc-modal', () => {
  describe('prong a - c-dialog-backdrop literal', () => {
    it('fires when c-dialog-backdrop appears in a className string', async () => {
      const messages = await lintWarnings(
        'const x = <div className="c-dialog-backdrop fixed inset-0" />'
      )
      expect(hasWarning(messages, 'no-adhoc-modal')).toBe(true)
    })

    it('is silent when className does not contain c-dialog-backdrop', async () => {
      const messages = await lintWarnings(
        'const x = <div className="fixed inset-0 bg-black/50" />'
      )
      expect(hasWarning(messages, 'no-adhoc-modal')).toBe(false)
    })
  })

  describe('prong b - role="dialog" attribute', () => {
    it('fires when role="dialog" is used outside primitives dir', async () => {
      const messages = await lintWarnings(
        'const x = <div role="dialog" aria-modal="true"><p>Content</p></div>'
      )
      expect(hasWarning(messages, 'no-adhoc-modal')).toBe(true)
    })

    it('is silent when role is not "dialog"', async () => {
      const messages = await lintWarnings(
        'const x = <div role="region" aria-label="main content" />'
      )
      expect(hasWarning(messages, 'no-adhoc-modal')).toBe(false)
    })

    it('is silent when using Modal primitive component (no raw role attr)', async () => {
      const messages = await lintWarnings(
        `import { Modal } from '../components/primitives/Modal'
const x = <Modal open={isOpen} onClose={close}><p>body</p></Modal>`
      )
      expect(hasWarning(messages, 'no-adhoc-modal')).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Rule 3 - soup/no-raw-form-control
// Selector: JSXOpeningElement[name.name=/^(input|select|textarea)$/]
// ---------------------------------------------------------------------------

describe('soup/no-raw-form-control', () => {
  it('fires on raw <input>', async () => {
    const messages = await lintWarnings('<input type="text" placeholder="Search" />')
    expect(hasWarning(messages, 'no-raw-form-control')).toBe(true)
  })

  it('fires on raw <select>', async () => {
    const messages = await lintWarnings(
      '<select><option value="a">A</option></select>'
    )
    expect(hasWarning(messages, 'no-raw-form-control')).toBe(true)
  })

  it('fires on raw <textarea>', async () => {
    const messages = await lintWarnings('<textarea rows={4} />')
    expect(hasWarning(messages, 'no-raw-form-control')).toBe(true)
  })

  it('is silent when using a named form component (no raw form element)', async () => {
    const messages = await lintWarnings(
      `import { InputField } from '../components/primitives/InputField'
const x = <InputField type="text" label="Name" />`
    )
    expect(hasWarning(messages, 'no-raw-form-control')).toBe(false)
  })

  it('is silent inside components/primitives (canonical form renderer exemption)', async () => {
    const messages = await lintWarningsPrimitives(
      '<input type="text" className="field-base" />'
    )
    expect(hasWarning(messages, 'no-raw-form-control')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 4 - soup/no-raw-sortable-header
// Selector: JSXOpeningElement[name.name="th"]:has(JSXAttribute[name.name="onClick"])
// ---------------------------------------------------------------------------

describe('soup/no-raw-sortable-header', () => {
  it('fires on <th onClick={...}> sort handler', async () => {
    const messages = await lintWarnings(
      'const x = <th onClick={() => setSort("name")}>Name</th>'
    )
    expect(hasWarning(messages, 'no-raw-sortable-header')).toBe(true)
  })

  it('is silent on <th> without onClick (static header)', async () => {
    const messages = await lintWarnings(
      'const x = <th scope="col">Status</th>'
    )
    expect(hasWarning(messages, 'no-raw-sortable-header')).toBe(false)
  })

  it('is silent on <th> with aria-sort but no onClick', async () => {
    const messages = await lintWarnings(
      'const x = <th aria-sort="ascending">Name</th>'
    )
    expect(hasWarning(messages, 'no-raw-sortable-header')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 5 - soup/no-raw-table
// Selector: JSXOpeningElement[name.name="table"]
// ---------------------------------------------------------------------------

describe('soup/no-raw-table', () => {
  it('fires on raw <table> element', async () => {
    const messages = await lintWarnings(
      '<table><tbody><tr><td>data</td></tr></tbody></table>'
    )
    expect(hasWarning(messages, 'no-raw-table')).toBe(true)
  })

  it('is silent when using a named Table component', async () => {
    const messages = await lintWarnings(
      `import { DataTable } from '../components/primitives/DataTable'
const x = <DataTable rows={rows} columns={cols} />`
    )
    expect(hasWarning(messages, 'no-raw-table')).toBe(false)
  })

  it('is silent inside components/primitives (permanent exemption)', async () => {
    const messages = await lintWarningsPrimitives(
      '<table className="w-full"><tbody>{children}</tbody></table>'
    )
    expect(hasWarning(messages, 'no-raw-table')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 6 - soup/no-legacy-log-lanes
// Selector: Literal[value=/var\(--log-col-/]
// ---------------------------------------------------------------------------

describe('soup/no-legacy-log-lanes', () => {
  it('fires on var(--log-col-*) token reference in a style string', async () => {
    const messages = await lintWarnings('const style = { width: "var(--log-col-time)" }')
    expect(hasWarning(messages, 'no-legacy-log-lanes')).toBe(true)
  })

  it('fires on multiple var(--log-col-*) references in a template expression', async () => {
    const messages = await lintWarnings(
      'const x = <div style={{ gridTemplateColumns: "var(--log-col-level) var(--log-col-source)" }} />'
    )
    expect(hasWarning(messages, 'no-legacy-log-lanes')).toBe(true)
  })

  it('is silent when using component-scoped log tokens (--log-time-w, --log-level-w)', async () => {
    const messages = await lintWarnings(
      'const x = <div style={{ width: "var(--log-time-w)" }} />'
    )
    expect(hasWarning(messages, 'no-legacy-log-lanes')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 7 - soup/no-focus-suppression
// Selector: Literal[value=/\boutline-none\b/][value!=/focus-visible:/]
// Fires when outline-none appears without a focus-visible: pairing in the same string.
// ---------------------------------------------------------------------------

describe('soup/no-focus-suppression', () => {
  it('fires when outline-none appears without focus-visible: in the same className', async () => {
    const messages = await lintWarnings(
      'const x = <button className="outline-none px-4 py-2">Click</button>'
    )
    expect(hasWarning(messages, 'no-focus-suppression')).toBe(true)
  })

  it('fires when outline-none is the sole className value', async () => {
    const messages = await lintWarnings(
      'const x = <div className="outline-none" />'
    )
    expect(hasWarning(messages, 'no-focus-suppression')).toBe(true)
  })

  it('is silent when outline-none is paired with focus-visible: in the same string', async () => {
    const messages = await lintWarnings(
      'const x = <button className="outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">Click</button>'
    )
    expect(hasWarning(messages, 'no-focus-suppression')).toBe(false)
  })

  it('is silent when outline-none is not present at all', async () => {
    const messages = await lintWarnings(
      'const x = <button className="focus-visible:ring-2 px-4 py-2">Click</button>'
    )
    expect(hasWarning(messages, 'no-focus-suppression')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 7a - soup/no-infinite-animation
// Selector: Property[key.name="animation"][value.value=/infinite/]
// TSX-side inline animation tripwire; CSS-side animations are covered by
// design-regression check 13 and the waiver registry.
// ---------------------------------------------------------------------------

describe('soup/no-infinite-animation', () => {
  it('fires on inline animation values containing infinite', async () => {
    const messages = await lintWarnings(
      'const x = <div style={{ animation: "spin 1s linear infinite" }} />'
    )
    expect(hasWarning(messages, 'no-infinite-animation')).toBe(true)
  })

  it('is silent on finite inline animation values', async () => {
    const messages = await lintWarnings(
      'const x = <div style={{ animation: "fade-in 120ms ease-out" }} />'
    )
    expect(hasWarning(messages, 'no-infinite-animation')).toBe(false)
  })

  it('is silent when animation is not declared inline', async () => {
    const messages = await lintWarnings(
      'const x = <div className="animate-pulse-once" />'
    )
    expect(hasWarning(messages, 'no-infinite-animation')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 8 - soup/no-legacy-tokens
// Selectors (via no-restricted-syntax):
//   Literal[value=/\b(bg-d[0-6]|text-t[1-5]|border-t[1-5])\b/]  - utility classes
//   Literal[value=/var\(--color-[dt]\d\)/]                        - color token refs
//   Literal[value=/var\(--b[1-4]\)/]                               - border token refs
// ---------------------------------------------------------------------------

describe('soup/no-legacy-tokens', () => {
  it('fires on bg-d3 utility class in className string', async () => {
    const messages = await lintWarnings(
      'const x = <div className="bg-d3 p-4 rounded" />'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(true)
  })

  it('fires on text-t4 utility class in className string', async () => {
    const messages = await lintWarnings(
      'const x = <p className="text-t4 text-sm" />'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(true)
  })

  it('fires on border-t2 utility class in className string', async () => {
    const messages = await lintWarnings(
      'const x = <div className="border border-t2" />'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(true)
  })

  it('fires on var(--color-d4) token reference', async () => {
    const messages = await lintWarnings(
      'const style = { background: "var(--color-d4)" }'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(true)
  })

  it('fires on var(--color-t2) token reference', async () => {
    const messages = await lintWarnings(
      'const style = { color: "var(--color-t2)" }'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(true)
  })

  it('fires on var(--b2) legacy border token reference', async () => {
    const messages = await lintWarnings(
      'const style = { border: "1px solid var(--b2)" }'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(true)
  })

  it('is silent when using v2 semantic utility classes', async () => {
    const messages = await lintWarnings(
      'const x = <div className="bg-surface-base text-1 border-hairline p-4" />'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(false)
  })

  it('is silent when using v2 semantic token references', async () => {
    const messages = await lintWarnings(
      'const style = { background: "var(--surface-base)", color: "var(--text-1)" }'
    )
    expect(hasWarning(messages, 'no-legacy-tokens')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 9 - soup/no-utility-smell
// Selector: Literal[value=/\b(w|h|mt|mb|ml|mr|px|py|p|m|gap|...)-\[(?!var\()[^\]]+\]/]
// Fires when an arbitrary-value utility payload is NOT a var() reference.
// ---------------------------------------------------------------------------

describe('soup/no-utility-smell', () => {
  it('fires on w-[40%] — arbitrary percentage value', async () => {
    const messages = await lintWarnings(
      'const x = <div className="w-[40%] flex-shrink-0" />'
    )
    expect(hasWarning(messages, 'no-utility-smell')).toBe(true)
  })

  it('fires on h-[120px] — arbitrary pixel value', async () => {
    const messages = await lintWarnings(
      'const x = <div className="h-[120px] overflow-hidden" />'
    )
    expect(hasWarning(messages, 'no-utility-smell')).toBe(true)
  })

  it('fires on mt-[1.5rem] — arbitrary rem value', async () => {
    const messages = await lintWarnings(
      'const x = <div className="mt-[1.5rem] px-4" />'
    )
    expect(hasWarning(messages, 'no-utility-smell')).toBe(true)
  })

  it('is silent on w-[var(--x)] — var() payload is compliant', async () => {
    const messages = await lintWarnings(
      'const x = <div className="w-[var(--sidebar-w)] flex-shrink-0" />'
    )
    expect(hasWarning(messages, 'no-utility-smell')).toBe(false)
  })

  it('is silent on h-[var(--panel-height)] — var() payload is compliant', async () => {
    const messages = await lintWarnings(
      'const x = <div className="h-[var(--panel-height)] overflow-auto" />'
    )
    expect(hasWarning(messages, 'no-utility-smell')).toBe(false)
  })

  it('is silent on standard Tailwind utilities without arbitrary values', async () => {
    const messages = await lintWarnings(
      'const x = <div className="w-full h-screen mt-4 gap-2" />'
    )
    expect(hasWarning(messages, 'no-utility-smell')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Rule 10 - soup/no-brand-regression (custom rule in console/eslint-rules/index.mjs)
//
// Fires on:
//   (a) JSXText containing "WhatSoup"
//   (b) JSX string attribute containing "WhatSoup"
//   (c) TemplateLiteral quasi containing "WhatSoup" in JSX attribute
//   (d) document.title = "WhatSoup..." assignment
//   (e) Split-wordmark: adjacent <span>What</span><span>Soup</span>
//
// Silent for:
//   - Strings matching PROTECTED_CONTRACT_PATTERNS (WhatSoupError, whatsoup:, etc.)
//   - Files matching EXEMPT_FILE_SUFFIXES (ConfigStep.tsx system-prompt)
// ---------------------------------------------------------------------------

describe('soup/no-brand-regression', () => {
  it('fires when "WhatSoup" appears as JSXText content', async () => {
    const messages = await lintWarnings(
      'const x = <span>WhatSoup</span>'
    )
    expect(hasWarning(messages, 'no-brand-regression')).toBe(true)
  })

  it('fires when "WhatSoup" appears in a JSX string attribute', async () => {
    const messages = await lintWarnings(
      'const x = <img alt="WhatSoup logo" src="/logo.png" />'
    )
    expect(hasWarning(messages, 'no-brand-regression')).toBe(true)
  })

  it('fires on document.title = "WhatSoup - ..." assignment', async () => {
    const messages = await lintWarnings(
      'document.title = "WhatSoup - Dashboard"'
    )
    expect(hasWarning(messages, 'no-brand-regression')).toBe(true)
  })

  it('fires on split-wordmark pattern: adjacent <span>What</span><span>Soup</span>', async () => {
    const messages = await lintWarnings(
      `const x = (
  <div>
    <span>What</span>
    <span>Soup</span>
  </div>
)`
    )
    expect(hasWarning(messages, 'no-brand-regression')).toBe(true)
  })

  it('is silent when JSXText contains no "WhatSoup"', async () => {
    const messages = await lintWarnings(
      'const x = <span>Dashboard</span>'
    )
    expect(hasWarning(messages, 'no-brand-regression')).toBe(false)
  })

  it('is silent for protected contract pattern WhatSoupError', async () => {
    // WhatSoupError is a protocol contract identifier - must not flag
    const messages = await lintWarnings(
      `const handleErr = (e: WhatSoupError) => <span>{e.message}</span>`
    )
    expect(hasWarning(messages, 'no-brand-regression')).toBe(false)
  })

  it('is silent in ConfigStep.tsx (EXEMPT_FILE_SUFFIXES exemption)', async () => {
    const messages = await lintWarnings(
      'const x = <span>WhatSoup</span>',
      CONFIGSTEP_PATH
    )
    expect(hasWarning(messages, 'no-brand-regression')).toBe(false)
  })
})

// ===========================================================================
// PROMOTED-PATH PROBES (D6 flip groups S, F, M, P)
//
// These probes use the DEFAULT config (eslint.config.js) via lintText and
// assert severity 2 (error) to prove each promoted rule actually fires on
// a violating fragment at its target path, and is silent at a non-promoted
// path (not yet error-severity for that rule).
//
// Fixture paths:
//   FIXTURE_PATH (pages/__fixture__.tsx)      — base scope, gets S + F + (not M, not P)
//   LINEDETAIL_PATH (pages/LineDetail.tsx)    — M list: gets S + F + M
//   PRIMITIVES_FIXTURE_PATH (primitives/__fixture__.tsx) — P scope: gets F + P, NOT S/M
//   INBOX_PATH (pages/Inbox.tsx)              — B4 retired carve-out: now gets S + F (full enforcement)
//   LINEPICKER_PATH (components/LinePicker.tsx) — NOT in M list: no M rules at error
//
// All assertions filter severity === 2 (error) to isolate promoted rules.
// ===========================================================================

describe('promoted-path probes (D6 flip groups)', () => {
  // Fixture paths for promoted-config probes
  const LINEDETAIL_PATH = resolve(REPO_ROOT, 'console/src/pages/LineDetail.tsx')
  const INBOX_PATH = resolve(REPO_ROOT, 'console/src/pages/Inbox.tsx')
  const LINEPICKER_PATH = resolve(REPO_ROOT, 'console/src/components/LinePicker.tsx')
  const DEFAULT_CONFIG = resolve(REPO_ROOT, 'console/eslint.config.js')

  let eslintDefault: ESLintType
  let eslintDefaultPrimitives: ESLintType

  beforeAll(async () => {
    const { ESLint } = await import('eslint')
    eslintDefault = new ESLint({
      overrideConfigFile: DEFAULT_CONFIG,
      cwd: CONSOLE_CWD,
    })
    eslintDefaultPrimitives = new ESLint({
      overrideConfigFile: DEFAULT_CONFIG,
      cwd: CONSOLE_CWD,
    })
  })

  /** Lint with DEFAULT config; return severity-2 (error) messages only. */
  async function lintErrors(src: string, filePath = FIXTURE_PATH): Promise<string[]> {
    const results = await eslintDefault.lintText(src, { filePath })
    return results[0].messages
      .filter((m) => m.severity === 2)
      .map((m) => m.message)
  }

  async function lintErrorsPrimitives(src: string): Promise<string[]> {
    const results = await eslintDefaultPrimitives.lintText(src, { filePath: PRIMITIVES_FIXTURE_PATH })
    return results[0].messages
      .filter((m) => m.severity === 2)
      .map((m) => m.message)
  }

  function hasError(messages: string[], keyword: string): boolean {
    return messages.some((m) => m.includes(keyword))
  }

  describe('P1 custom rules — scoped-error in the default config', () => {
    it('protected-identifiers fires as an error at a pages path', async () => {
      const messages = await lintErrors(
        `const PREFIX = 'soup:'`,
        FIXTURE_PATH
      )
      expect(hasError(messages, 'protected-identifiers')).toBe(true)
    })

    it('icon-family fires as an error at a pages path', async () => {
      const messages = await lintErrors(
        `import { FaBeer } from 'react-icons/fa'
const x = FaBeer`,
        FIXTURE_PATH
      )
      expect(hasError(messages, 'icon-family')).toBe(true)
    })

    it('no-inline-dismiss-handler fires as an error at a pages path', async () => {
      const messages = await lintErrors(
        `import { useEffect } from 'react'
export function Dialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [onClose])
  return null
}`,
        FIXTURE_PATH
      )
      expect(hasError(messages, 'no-inline-dismiss-handler')).toBe(true)
    })
  })

  // ─── Group S: structural, console-wide (pages/__fixture__.tsx) ────────────

  describe('Group S — structural rules fire at error in base scope', () => {
    it('no-raw-table fires as error at a pages path', async () => {
      const messages = await lintErrors(
        '<table><tbody><tr><td>data</td></tr></tbody></table>',
        FIXTURE_PATH
      )
      expect(hasError(messages, 'no-raw-table')).toBe(true)
    })

    it('no-raw-table is silent inside components/primitives (canonical renderer exemption)', async () => {
      const messages = await lintErrorsPrimitives(
        '<table className="w-full"><tbody>{children}</tbody></table>'
      )
      expect(hasError(messages, 'no-raw-table')).toBe(false)
    })

    it('no-raw-sortable-header fires as error at a pages path', async () => {
      const messages = await lintErrors(
        'const x = <th onClick={() => setSort("name")}>Name</th>',
        FIXTURE_PATH
      )
      expect(hasError(messages, 'no-raw-sortable-header')).toBe(true)
    })

    it('no-legacy-log-lanes fires as error at a pages path', async () => {
      const messages = await lintErrors(
        'const style = { width: "var(--log-col-time)" }',
        FIXTURE_PATH
      )
      expect(hasError(messages, 'no-legacy-log-lanes')).toBe(true)
    })
  })

  // ─── Group F: focus suppression (console-wide with carve-out) ─────────────

  describe('Group F — focus suppression fires at error in base scope', () => {
    it('no-focus-suppression fires as error at SoupKitchen (base scope)', async () => {
      const messages = await lintErrors(
        'const x = <button className="outline-none px-4 py-2">Click</button>',
        resolve(REPO_ROOT, 'console/src/pages/SoupKitchen.tsx')
      )
      expect(hasError(messages, 'no-focus-suppression')).toBe(true)
    })

    it('no-focus-suppression fires at Inbox.tsx (B4 retired the carve-out)', async () => {
      // B4 removed Inbox.tsx from the Block 2 carve-out list — the composer outline-none
      // was eliminated, so Inbox now joins the fully-enforced set. Verify the rule is live.
      const messages = await lintErrors(
        'const x = <button className="outline-none px-4 py-2">Click</button>',
        INBOX_PATH
      )
      expect(hasError(messages, 'no-focus-suppression')).toBe(true)
    })

    it('no-focus-suppression is still silent at HistoryTab.tsx (carve-out retained, C-B4-6)', async () => {
      // HistoryTab.tsx remains in Block 2 — its composer outline-none is the
      // remaining hit, owned by the form-kit composer-flavor slice (C-B4-6).
      const messages = await lintErrors(
        'const x = <button className="outline-none px-4 py-2">Click</button>',
        resolve(REPO_ROOT, 'console/src/components/line-detail/HistoryTab.tsx')
      )
      expect(hasError(messages, 'no-focus-suppression')).toBe(false)
    })

    it('no-focus-suppression is silent when focus-visible: is paired', async () => {
      const messages = await lintErrors(
        'const x = <button className="outline-none focus-visible:ring-2">Click</button>',
        FIXTURE_PATH
      )
      expect(hasError(messages, 'no-focus-suppression')).toBe(false)
    })
  })

  // ─── Group M: migrated surfaces ────────────────────────────────────────────

  describe('Group M — migrated surface rules fire at error for M-list paths', () => {
    it('no-raw-button fires as error at LineDetail.tsx (M list)', async () => {
      const messages = await lintErrors(
        'const x = <button type="button">Click</button>',
        LINEDETAIL_PATH
      )
      expect(hasError(messages, 'no-raw-button')).toBe(true)
    })

    it('no-raw-button is silent at LinePicker.tsx (NOT in M list — not yet error)', async () => {
      const messages = await lintErrors(
        'const x = <button type="button">Click</button>',
        LINEPICKER_PATH
      )
      expect(hasError(messages, 'no-raw-button')).toBe(false)
    })

    it('no-adhoc-modal (c-dialog-backdrop) fires as error at RelinkModal.tsx (M list)', async () => {
      const messages = await lintErrors(
        'const x = <div className="c-dialog-backdrop fixed inset-0" />',
        resolve(REPO_ROOT, 'console/src/components/RelinkModal.tsx')
      )
      expect(hasError(messages, 'no-adhoc-modal')).toBe(true)
    })

    it('no-adhoc-modal (role=dialog) fires as error at RelinkModal.tsx (M list)', async () => {
      const messages = await lintErrors(
        'const x = <div role="dialog" aria-modal="true"><p>Content</p></div>',
        resolve(REPO_ROOT, 'console/src/components/RelinkModal.tsx')
      )
      expect(hasError(messages, 'no-adhoc-modal')).toBe(true)
    })

    it('no-raw-button is silent inside components/primitives (canonical renderer exemption)', async () => {
      const messages = await lintErrorsPrimitives(
        'const x = <button type="button" className="btn-base">{children}</button>'
      )
      expect(hasError(messages, 'no-raw-button')).toBe(false)
    })
  })

  // ─── Group P: primitives strict tier ───────────────────────────────────────

  describe('Group P — primitives tier rules fire at error inside primitives/', () => {
    it('no-legacy-tokens (bg-d3) fires as error inside primitives/', async () => {
      const messages = await lintErrorsPrimitives(
        'const x = <div className="bg-d3 p-4 rounded" />'
      )
      expect(hasError(messages, 'no-legacy-tokens')).toBe(true)
    })

    it('no-legacy-tokens (var(--color-d4)) fires as error inside primitives/', async () => {
      const messages = await lintErrorsPrimitives(
        'const style = { background: "var(--color-d4)" }'
      )
      expect(hasError(messages, 'no-legacy-tokens')).toBe(true)
    })

    it('no-legacy-tokens (var(--b2)) fires as error inside primitives/', async () => {
      const messages = await lintErrorsPrimitives(
        'const style = { borderColor: "var(--b2)" }'
      )
      expect(hasError(messages, 'no-legacy-tokens')).toBe(true)
    })

    it('no-utility-smell (w-[40%]) fires as error inside primitives/', async () => {
      const messages = await lintErrorsPrimitives(
        'const x = <div className="w-[40%] flex-shrink-0" />'
      )
      expect(hasError(messages, 'no-utility-smell')).toBe(true)
    })

    it('no-legacy-tokens is silent at a pages path (not in P scope)', async () => {
      const messages = await lintErrors(
        'const x = <div className="bg-d3 p-4 rounded" />',
        FIXTURE_PATH
      )
      // bg-d3 does NOT fire at error in pages/ — only in primitives/
      expect(hasError(messages, 'no-legacy-tokens')).toBe(false)
    })

    it('no-utility-smell is silent at a pages path (not in P scope)', async () => {
      const messages = await lintErrors(
        'const x = <div className="w-[40%] flex-shrink-0" />',
        FIXTURE_PATH
      )
      // no-utility-smell does NOT fire at error in pages/ — only in primitives/
      expect(hasError(messages, 'no-utility-smell')).toBe(false)
    })

    it('no-legacy-tokens is silent for v2 semantic tokens inside primitives/', async () => {
      const messages = await lintErrorsPrimitives(
        'const x = <div className="bg-surface-base text-1 border-hairline p-4" />'
      )
      expect(hasError(messages, 'no-legacy-tokens')).toBe(false)
    })

    it('no-utility-smell is silent for var() payloads inside primitives/', async () => {
      const messages = await lintErrorsPrimitives(
        'const x = <div className="w-[var(--avatar-sm)] flex-shrink-0" />'
      )
      expect(hasError(messages, 'no-utility-smell')).toBe(false)
    })
  })

  // ─── CreateGroupModal union block (block 4b sanity check) ──────────────────

  describe('CreateGroupModal full-union block', () => {
    const CREATEGROUP_PATH = resolve(
      REPO_ROOT,
      'console/src/components/line-detail/CreateGroupModal.tsx'
    )

    it('no-raw-button fires as error at CreateGroupModal (M list + scheduled union)', async () => {
      const messages = await lintErrors(
        'const x = <button type="button">Add</button>',
        CREATEGROUP_PATH
      )
      expect(hasError(messages, 'no-raw-button')).toBe(true)
    })

    it('no-focus-suppression fires as error at CreateGroupModal (union block includes F)', async () => {
      const messages = await lintErrors(
        'const x = <div className="outline-none" />',
        CREATEGROUP_PATH
      )
      expect(hasError(messages, 'no-focus-suppression')).toBe(true)
    })
  })
})
