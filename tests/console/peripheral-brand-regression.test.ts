import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// The TSX brand-regression guard scans `console/src` only, so brand/channel copy
// in peripheral artifacts (the document shell, PWA manifest) escapes it entirely.
// This pins those surfaces against the same legacy strings the src guard forbids.
// Scope note: the user-visible `<title>WhatSoup Console>` → `SOUP Console` flip is a
// tracked rebrand item (peripheral-audit P1) and is NOT asserted here, so this guard
// passes today and only catches *new* drift. The theme-color meta is pinned by
// use-theme.test.tsx against the semantic surface-base tokens.

const consoleRoot = resolve(import.meta.dirname, '..', '..', 'console')

function peripheralTextArtifacts(): string[] {
  const files = [resolve(consoleRoot, 'index.html')]
  const publicDir = resolve(consoleRoot, 'public')
  if (existsSync(publicDir)) {
    for (const entry of readdirSync(publicDir)) {
      if (/\.(?:json|webmanifest|html)$/.test(entry)) files.push(resolve(publicDir, entry))
    }
  }
  return files.filter(existsSync)
}

// Legacy product name retired in favour of "Fleet" / "SOUP"; channel-bound copy
// retired in favour of channel-agnostic positioning. These must never reappear in
// the shell/manifest. (`whatsoup:` protected identifiers are a distinct lowercase
// token and are intentionally not matched here.)
const FORBIDDEN_PERIPHERAL_COPY: Array<{ label: string; pattern: RegExp }> = [
  { label: 'legacy product name "Soup Kitchen"', pattern: /Soup Kitchen/i },
  { label: 'channel-bound copy "from/on/via WhatsApp"', pattern: /\b(?:from|on|via)\s+WhatsApp\b/i },
]

describe('peripheral brand regression (artifacts outside console/src)', () => {
  it('finds at least the document shell to scan (guard is not silently empty)', () => {
    expect(peripheralTextArtifacts().length).toBeGreaterThan(0)
  })

  for (const { label, pattern } of FORBIDDEN_PERIPHERAL_COPY) {
    it(`keeps ${label} out of peripheral artifacts (index.html, PWA manifest)`, () => {
      const offenders = peripheralTextArtifacts()
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => file.replace(`${consoleRoot}/`, 'console/'))
      expect(offenders).toEqual([])
    })
  }

  it('keeps the document shell structurally intact (title + favicon link present)', () => {
    const html = readFileSync(resolve(consoleRoot, 'index.html'), 'utf8')
    expect(html).toMatch(/<title>[^<]+<\/title>/)
    expect(html).toMatch(/<link[^>]+rel="icon"/)
  })
})
