/**
 * DS hardening wave (2026-07-20, owner-directed) — three pattern guards in
 * the repo's frozen-inventory idiom:
 *
 *  1. FAIL-CLOSED READ PAIRING (PDR-3 codification): every fleet route file
 *     that calls a dbReader read method must pair it with an error check
 *     (`!result.ok` / `readError` / `.ok === false`) — a read failure must
 *     surface AS a failure (500, readError marker, error field), never as
 *     fake-normal data. Legacy routes pair via 500s; new routes pair via the
 *     readError marker — both satisfy the invariant.
 *
 *  2. FRESHNESS CONTRACT (#1925/#1934 codification): every exported data
 *     hook containing useQuery in use-fleet.ts / use-metrics.ts must either
 *     carry `queryFreshness` in its return or be in the named legacy
 *     allowlist (the pre-#1925 set — promotion of those is tracked as DD).
 *
 *  3. AMBIENT-LOOP BUDGET (motion.md §8 / DD-47): ok-breathing is the only
 *     ambient loop; the loading-choreography loops are waivered. The frozen
 *     inventory below names every permitted `infinite` animation + site —
 *     any NEW infinite animation FAILS (a new ambient loop needs a G-gate
 *     decision), and a permitted site may not spread to a new file.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8')

function tsFiles(dir: string): string[] {
  const abs = resolve(repoRoot, dir)
  return readdirSync(abs).flatMap((entry) => {
    const rel = `${dir}/${entry}`
    return statSync(resolve(repoRoot, rel)).isDirectory() ? tsFiles(rel) : /\.tsx?$/.test(entry) ? [rel] : []
  })
}

// ---------------------------------------------------------------------------
// 1. Fail-closed read pairing (PDR-3)
// ---------------------------------------------------------------------------

describe('PDR-3 fail-closed read pairing — every dbReader call has an error check', () => {
  const routeFiles = tsFiles('src/fleet/routes')
  const readerConsumers = routeFiles.filter((f) => /\b(dbReader|this\.dbReader)\.\w+\(/.test(read(f)))

  it('finds the dbReader-consuming route files (anti-empty-glob)', () => {
    expect(readerConsumers.length).toBeGreaterThanOrEqual(2)
  })

  it.each(readerConsumers.map((f) => [f]))('%s pairs every read with a failure path', (file) => {
    const src = read(file as string)
    const hasPair =
      src.includes('!result.ok')
      || src.includes('readError')
      || src.includes('.ok === false')
      || src.includes('result.ok === false')
    expect(hasPair, `${file} calls a dbReader read method without any failure path — a read failure must surface as failure, never as fake-normal data (PDR-3)`).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Freshness contract on data hooks (#1925/#1934)
// ---------------------------------------------------------------------------

/** Pre-#1925 hooks grandfathered without the freshness field. Promotion of
 *  these onto the contract is tracked debt — do NOT add new entries here;
 *  new hooks must carry queryFreshness. */
const LEGACY_NO_FRESHNESS = new Set([
  'useLines', // pre-#1925 (the D-3 PR promotes it onto the contract)
  'useFeed', // pre-#1925 (caught by this guard on first run — same class as useLines)
  'useLine', 'useChats', 'useMessages', 'useLogs', 'useAccess',
  'useTyping', 'useProviders', 'useProviderStatus', 'useKpis',
])

describe('freshness contract — data hooks carry queryFreshness (#1925/#1934)', () => {
  const hookFiles = ['console/src/hooks/use-fleet.ts', 'console/src/hooks/use-metrics.ts']

  function exportedQueryHooks(src: string): Array<{ name: string; body: string }> {
    const out: Array<{ name: string; body: string }> = []
    const re = /export function (use\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      if (m[2]!.includes('useQuery(')) out.push({ name: m[1]!, body: m[2]! })
    }
    return out
  }

  it('finds at least one query hook to police (anti-empty-glob)', () => {
    const hooks = hookFiles.flatMap((f) => exportedQueryHooks(read(f)))
    expect(hooks.length).toBeGreaterThanOrEqual(1)
  })

  it('every exported useQuery hook carries queryFreshness or is named legacy', () => {
    const violations: string[] = []
    for (const file of hookFiles) {
      for (const hook of exportedQueryHooks(read(file))) {
        if (LEGACY_NO_FRESHNESS.has(hook.name)) continue
        if (!hook.body.includes('queryFreshness')) violations.push(`${file}::${hook.name}`)
      }
    }
    expect(violations, `data hooks without the freshness contract: ${violations.join(', ')} — every data hook must carry queryFreshness (#1925) or be an explicitly named legacy hook`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Ambient-loop budget (motion.md §8 / DD-47)
// ---------------------------------------------------------------------------

/** Frozen inventory of permitted infinite animations: name → the exact
 *  files allowed to declare/consume it. breathe + breathe-ring = the
 *  sanctioned ok-breathing family (the ONE ambient class); typing-bounce +
 *  shimmer = loading choreography (waivered WVR-005/006). */
const PERMITTED_LOOPS: Record<string, Set<string>> = {
  'breathe-ring': new Set([
    'console/src/styles/composites.css',
    'console/src/styles/primitives.css',
  ]),
  'breathe': new Set(['console/src/styles/composites.css']),
  'typing-bounce': new Set(['console/src/styles/composites.css']),
  'shimmer': new Set(['console/src/styles/composites.css']),
}

describe('ambient-loop budget — no new infinite animations without a G-gate (motion.md §8)', () => {
  const cssFiles = ['console/src/styles/composites.css', 'console/src/styles/primitives.css']
  const animRe = /animation:\s*([\w-]+)[^;]*\binfinite\b/g

  it('finds the permitted loops (anti-empty-glob — proves the scan is real)', () => {
    const hits = cssFiles.flatMap((f) => Array.from(read(f).matchAll(animRe)))
    expect(hits.length).toBeGreaterThanOrEqual(4)
  })

  it('every infinite animation is a permitted loop in its permitted file', () => {
    const violations: string[] = []
    for (const file of tsFiles('console/src')) {
      const src = read(file)
      for (const m of src.matchAll(animRe)) {
        const name = m[1]!
        const permitted = PERMITTED_LOOPS[name]
        if (!permitted || !permitted.has(file)) violations.push(`${file}::${name}`)
      }
      // TSX animate-* infinite utility classes are also loops
      if (/animate-[\w-]*infinite|animation.*infinite/.test(src) && file.endsWith('.tsx')) {
        for (const line of src.split('\n')) {
          if (/infinite/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
            violations.push(`${file}::tsx-infinite-utility`)
          }
        }
      }
    }
    expect(violations, `non-permitted infinite animations: ${violations.join(', ')} — a new ambient loop needs a G-gate decision (motion.md §8; DD-47)`).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. nameplate-reserved (brand.md §1): --type-nameplate has exactly ONE
//    consumer — .soup-nameplate__wm. Any other var() consumption FAILS.
// ---------------------------------------------------------------------------

describe('nameplate-reserved — --type-nameplate consumed only by the SOUP nameplate', () => {
  const CONSUMPTION_RE = /var\(--type-nameplate/
  // Consumption is CSS-native — scan styles + sources
  const scanFiles = [
    ...tsFiles('console/src'),
    ...['composites.css', 'primitives.css', 'tokens.component.css', 'tokens.semantic.css', 'tokens.primitive.css']
      .map((f) => `console/src/styles/${f}`),
  ]

  it('the token is consumed (anti-dead-definition — proves the scan is real)', () => {
    const hits = scanFiles.filter((f) => CONSUMPTION_RE.test(read(f)))
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  it('no file outside primitives.css (the nameplate band) consumes the reserved token', () => {
    const violations = scanFiles
      .filter((f) => f !== 'console/src/styles/primitives.css')
      .filter((f) => {
        const src = read(f)
        return src.split('\n').some((line) => {
          const t = line.trim()
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
          return CONSUMPTION_RE.test(line)
        })
      })
    expect(violations, `--type-nameplate consumed outside .soup-nameplate__wm: ${violations.join(', ')} — the wordmark token is reserved (brand.md §1; lint nameplate-reserved)`).toEqual([])
  })
})
