import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const srcRoot = resolve(import.meta.dirname, '..', '..', 'console', 'src')
const assetsDir = resolve(srcRoot, 'assets')
const assetPattern = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i

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

function stripComments(text: string): string {
  // Fixpoint loop: a single `<!--...-->` pass is incomplete sanitization (CodeQL
  // js/incomplete-multi-character-sanitization) — nested markers leave a residual `<!--`.
  let cleaned = text
  let previous: string
  do {
    previous = cleaned
    cleaned = cleaned
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1')
  } while (cleaned !== previous)
  // Remove any residual comment markers that fragment concatenation or unclosed
  // comments can leave behind, so no `<!--`/`-->` survives the sanitizer.
  return cleaned.replace(/<!--|-->/g, '')
}

function normalizeAssetReference(sourceFile: string, value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/[?#].*$/, '')
  let path: string
  if (trimmed.startsWith('/src/')) {
    path = trimmed.slice('/src/'.length)
  } else if (trimmed.startsWith('src/')) {
    path = trimmed.slice('src/'.length)
  } else if (trimmed.startsWith('/assets/')) {
    path = trimmed.slice(1)
  } else if (trimmed.startsWith('assets/')) {
    path = trimmed
  } else if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
    path = relative(srcRoot, resolve(dirname(sourceFile), trimmed)).replace(/\\/g, '/')
  } else {
    return null
  }
  if (!path.startsWith('assets/') || !assetPattern.test(path)) return null
  return path
}

function collectAssetReferences(sourceFile: string, text: string): Set<string> {
  const references = new Set<string>()
  const cleaned = stripComments(text)
  const patterns = [
    /(?:import\s+[^'"]+\s+from\s+|from\s+|import\(\s*)["']([^"']+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^"']*)?)["']/gi,
    /url\(\s*["']?([^"')\s]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^"')\s]*)?)["']?\s*\)/gi,
    /["']((?:\/src\/|src\/|\/assets\/|assets\/|\.{1,2}\/)[^"']+\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#][^"']*)?)["']/gi,
  ]

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const reference = normalizeAssetReference(sourceFile, match[1])
      if (reference) references.add(reference)
    }
  }
  return references
}

function sourceTextFiles(): string[] {
  return filesUnder(srcRoot, (name) => /\.(?:css|html|js|json|mjs|ts|tsx)$/.test(name))
    .filter((file) => !file.startsWith(`${assetsDir}/`))
}

function sourceAssetFiles(): string[] {
  return filesUnder(assetsDir, (name) => assetPattern.test(name))
}

describe('console source asset reachability', () => {
  it('strips nested/overlapping comment markers to a fixpoint (no residual <!--)', () => {
    // A single `<!--...-->` pass leaves a residual marker on overlapping input;
    // the fixpoint loop must remove all of them (CodeQL js/incomplete-multi-character-sanitization).
    expect(stripComments('<!--<!-- a -->-->')).not.toContain('<!--')
    expect(stripComments('<!--<!-- a -->-->')).not.toContain('-->')
    expect(stripComments('keep <!--<!--x-->--> me').replace(/\s+/g, ' ').trim()).toBe('keep me')
  })

  it('resolves path-like source asset references and ignores prose mentions', () => {
    const sourceFile = resolve(srcRoot, 'components', 'Example.tsx')
    const references = collectAssetReferences(sourceFile, `
      import hero from '../assets/hero.png'
      const icon = "/src/assets/icons/mark.svg#hash"
      // assets/prose-only.svg
      /* url("../assets/commented.webp") */
    `)

    expect([...references].sort()).toEqual([
      'assets/hero.png',
      'assets/icons/mark.svg',
    ])
  })

  it('does not keep unreferenced bundled source assets', () => {
    const referenced = new Set<string>()
    for (const file of sourceTextFiles()) {
      for (const reference of collectAssetReferences(file, readFileSync(file, 'utf8'))) {
        referenced.add(reference)
      }
    }

    const orphaned = sourceAssetFiles()
      .filter((file) => !referenced.has(relative(srcRoot, file).replace(/\\/g, '/')))
      .map((file) => relative(resolve(srcRoot, '..'), file).replace(/\\/g, '/'))

    expect(orphaned).toEqual([])
  })
})
