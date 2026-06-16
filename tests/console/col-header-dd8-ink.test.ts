/**
 * c-col-header — DD-8 Option B ink-tier evidence.
 *
 * Decision-package classification:
 *   Bare c-col-header labels are essential section/header text, and the
 *   utility default was the outlier still pointing at ghost ink.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')
const sourceRoots = ['console/src/components', 'console/src/pages']

function tsxFiles(dir: string): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap(entry => {
    const relativePath = `${dir}/${entry}`
    const fullPath = resolve(repoRoot, relativePath)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) return tsxFiles(relativePath)
    return /\.(?:ts|tsx)$/.test(entry) ? [relativePath] : []
  })
}

function cColHeaderBlock(): string {
  const css = read('console/src/styles/composites.css')
  const match = css.match(/@utility c-col-header\s*\{(?<body>[\s\S]*?)\n\}/)
  expect(match?.groups?.body).toBeDefined()
  return match?.groups?.body ?? ''
}

function cColHeaderGhostOverrides(): string[] {
  return sourceRoots
    .flatMap(tsxFiles)
    .flatMap(path => read(path)
      .split('\n')
      .flatMap((line, index) => (
        line.includes('c-col-header') && line.includes('text-t5')
          ? [`${relative(repoRoot, resolve(repoRoot, path))}:${index + 1}: ${line.trim()}`]
          : []
      )))
}

describe('c-col-header DD-8 — essential headers carry secondary ink, not ghost ink', () => {
  it('maps the c-col-header utility default to text-2 via color-t4', () => {
    const primitiveTokens = read('console/src/styles/tokens.primitive.css')
    const body = cColHeaderBlock()

    expect(primitiveTokens).toContain('--color-t4: var(--text-2);')
    expect(body).toContain('color: var(--text-2);')
  })

  it('does not default c-col-header to ghost ink', () => {
    const body = cColHeaderBlock()

    expect(body).not.toContain('color: var(--text-3);')
  })

  it('keeps c-col-header consumers from overriding back to text-t5', () => {
    expect(cColHeaderGhostOverrides()).toEqual([])
  })
})
