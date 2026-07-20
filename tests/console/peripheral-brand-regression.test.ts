import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'

// The TSX brand-regression guard scans `console/src` only, so brand/channel copy
// in peripheral artifacts (the document shell, PWA manifest) escapes it entirely.
// This pins those surfaces against the same legacy strings the src guard forbids.
// Scope note: the user-visible `<title>` flip to `SOUP Console` (peripheral-audit
// P1, C4) is LANDED and pinned exactly below — this guard now prevents regression
// on the title itself as well as new drift. The theme-color meta is pinned by
// use-theme.test.tsx against the semantic surface-base tokens.

const consoleRoot = resolve(import.meta.dirname, '..', '..', 'console')

function filesUnder(dir: string, matchesFile: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...filesUnder(path, matchesFile))
    } else if (matchesFile(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function peripheralTextArtifacts(): string[] {
  const files = [resolve(consoleRoot, 'index.html')]
  const publicDir = resolve(consoleRoot, 'public')
  files.push(...filesUnder(publicDir, (name) => /\.(?:json|webmanifest|html)$/.test(name)))
  return files.filter(existsSync)
}

function textFilesUnder(dir: string): string[] {
  return filesUnder(dir, (name) => /\.(?:css|html|json|ts|tsx|webmanifest)$/.test(name))
}

function publicSvgAssets(): string[] {
  return filesUnder(resolve(consoleRoot, 'public'), (name) => name.endsWith('.svg'))
}

function normalizeSvgReference(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/[?#].*$/, '')
  const publicIndex = trimmed.lastIndexOf('/public/')
  let path = publicIndex >= 0 ? trimmed.slice(publicIndex + '/public/'.length) : trimmed
  path = path.replace(/^public\//, '').replace(/^\/+/, '')
  while (path.startsWith('./')) path = path.slice(2)
  if (!path || path.startsWith('../') || !path.toLowerCase().endsWith('.svg')) return null
  return path
}

function commentSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const block = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g
  for (const match of text.matchAll(block)) {
    spans.push([match.index, match.index + match[0].length])
  }
  const line = /(^|[^\S\r\n])(\/\/.*)$/gm
  for (const match of text.matchAll(line)) {
    const start = match.index + match[1].length
    spans.push([start, start + match[2].length])
  }
  return spans
}

function isIndexInSpans(index: number, spans: Array<[number, number]>): boolean {
  return spans.some(([start, end]) => index >= start && index < end)
}

function collectSvgReferences(text: string): Set<string> {
  // Exclude references inside comments by position rather than rewriting the
  // source via replace() (regex comment-stripping is provably incomplete).
  const spans = commentSpans(text)
  const references = new Set<string>()
  const patterns = [
    /\b(?:href|src|xlink:href)\s*=\s*["']([^"']+\.svg(?:[?#][^"']*)?)["']/gi,
    /["']src["']\s*:\s*["']([^"']+\.svg(?:[?#][^"']*)?)["']/gi,
    /url\(\s*["']?([^"')\s]+\.svg(?:[?#][^"')\s]*)?)["']?\s*\)/gi,
    /(?:import\s+[^'"]+\s+from\s+|from\s+|import\(\s*)["']([^"']+\.svg(?:[?#][^"']*)?)["']/gi,
    /["']((?:\/|\.{1,2}\/|public\/|[^"']+\/)[^"']+\.svg(?:[?#][^"']*)?)["']/gi,
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined && isIndexInSpans(match.index, spans)) continue
      const reference = normalizeSvgReference(match[1])
      if (reference) references.add(reference)
    }
  }
  return references
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

  it('keeps the document shell structurally intact (SOUP Console title + favicon link present)', () => {
    const html = readFileSync(resolve(consoleRoot, 'index.html'), 'utf8')
    // Exact pin: the C4 brand flip's user-visible title (peripheral-audit P1).
    expect(html).toMatch(/<title>SOUP Console<\/title>/)
    expect(html).toMatch(/<link[^>]+rel="icon"/)
  })

  it('does not ship unreferenced public SVG assets', () => {
    const referenced = new Set<string>()
    for (const file of [
      ...peripheralTextArtifacts(),
      ...textFilesUnder(resolve(consoleRoot, 'src')),
    ]) {
      for (const reference of collectSvgReferences(readFileSync(file, 'utf8'))) {
        referenced.add(reference)
      }
    }

    const publicDir = resolve(consoleRoot, 'public')
    const orphaned = publicSvgAssets()
      .filter((file) => !referenced.has(relative(publicDir, file).replace(/\\/g, '/')))
      .map((file) => file.replace(`${consoleRoot}/`, 'console/'))

    expect(orphaned).toEqual([])
  })
})
