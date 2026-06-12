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
