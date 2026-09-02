/**
 * Producer/console drift guard for the health-presentation registry (#2523).
 *
 * The console registry (console/src/lib/health-presentation.ts) is a validated
 * view of the vocabulary the fleet health poller actually emits. If the poller
 * gains a `statusReason` the console does not register, the new code would
 * silently degrade to the fail-closed "unsupported reason code" state on every
 * operator surface. That is the right runtime behaviour and the wrong shipping
 * state, so this guard fails the build instead.
 *
 * The poller is read as TEXT, never imported: `src/fleet/health-poller.ts` is a
 * 2500-line module with a heavy runtime import graph, and console tests must not
 * pull it in (the same reason `console/src/types.ts` mirrors rather than imports
 * `src/transport/connection.ts`).
 *
 * The scan is anchored on the four shapes that actually produce a
 * `statusReason`:
 *   1. a `HealthSnapshotClassification` return  (`confidence:` line immediately
 *      followed by a `reason:` line);
 *   2. a direct `statusReason:` / `statusReason =` assignment;
 *   3. the `alertSource` default of `updateDegraded`, which is that function's
 *      declared `statusReason` default; and
 *   4. the literal arguments of a `this.updateDegraded(...)` call site, which
 *      supply `alertSource` positionally.
 * ALL-CAPS constants referenced at those sites are resolved to their literal.
 *
 * A coverage assertion guards the scanner itself: a regex that stops matching
 * would otherwise make this suite pass vacuously.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  HEALTH_REASON_CODES,
  HEALTH_REASON_DETAILS,
} from '../../console/src/lib/health-presentation'

const POLLER = resolve(import.meta.dirname, '../..', 'src/fleet/health-poller.ts')

/**
 * Status and confidence values, which share the reason sites but are not reason
 * codes. `provider_fallback_capacity` is an alert source only: the one call
 * site that uses it passes `classification.reason` as the `statusReason`
 * explicitly, so it never reaches a status reason.
 */
const NOT_REASON_CODES = new Set([
  'degraded',
  'online',
  'unreachable',
  'logged_out',
  'confirmed',
  'inferred',
  'ambiguous',
])

/** Codes whose presence proves the scanner still reaches each anchor shape. */
const SCANNER_ANCHORS = [
  'health_body_unhealthy', // classification return
  'self_health_callback', // direct statusReason literal
  'health_poll_failed_threshold', // statusReason ternary
  'health_probe_timeout_under_proxy_load', // ALL-CAPS constant reference
  'instance_degraded', // updateDegraded alertSource default
  'health_probe_auth_failed', // positional alertSource at a call site
] as const

function emittedStatusReasons(source: string): Set<string> {
  const lines = source.split('\n')
  const constants = new Map<string, string>()
  for (const m of source.matchAll(/const ([A-Z][A-Z0-9_]*) = '([a-z][a-z0-9_]*)';/g)) {
    constants.set(m[1]!, m[2]!)
  }

  const found = new Set<string>()
  const add = (code: string | undefined): void => {
    if (code === undefined || NOT_REASON_CODES.has(code)) return
    found.add(code)
  }
  const scan = (line: string): void => {
    // Drop comparison operands: `code === 'future_schema'` tests a value, it
    // does not emit one.
    const cleaned = line.replace(/[=!]==?\s*'[^']*'/g, '')
    for (const m of cleaned.matchAll(/'([a-z][a-z0-9_]{3,})'/g)) add(m[1])
    for (const m of cleaned.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) add(constants.get(m[1]!))
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const previous = i > 0 ? lines[i - 1]! : ''
    const isClassificationReason = /^\s*reason:/.test(line)
      && /^\s*confidence:\s*'(?:confirmed|inferred|ambiguous)',\s*$/.test(previous)
    const isStatusReason = /^\s*statusReason\s*(?::|=(?!=))/.test(line)
    if (/^\s*alertSource\s*=(?!=)/.test(line)) {
      scan(line)
      continue
    }
    if (!isClassificationReason && !isStatusReason) continue
    // A reason may span a ternary; stop at the next field of the same object.
    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
      if (j > i && /^\s*(?:evidence|statusEvidence|status|confidence|error|lastAlertAt|name|health):/.test(lines[j]!)) break
      scan(lines[j]!)
    }
  }

  for (let i = 0; i < lines.length; i++) {
    if (!/this\.updateDegraded\(/.test(lines[i]!)) continue
    for (let j = i; j < Math.min(i + 22, lines.length); j++) {
      scan(lines[j]!)
      if (/^\s*\);\s*$/.test(lines[j]!)) break
    }
  }

  return found
}

describe('health-presentation registry drift', () => {
  const emitted = emittedStatusReasons(readFileSync(POLLER, 'utf8'))

  it('still reaches every producer anchor shape (scanner coverage assertion)', () => {
    expect(emitted.size).toBeGreaterThanOrEqual(15)
    for (const anchor of SCANNER_ANCHORS) {
      expect([...emitted]).toContain(anchor)
    }
  })

  it('registers a presentation for every status reason the poller emits', () => {
    const unregistered = [...emitted].filter((code) => !(code in HEALTH_REASON_DETAILS)).sort()
    expect(unregistered).toEqual([])
  })

  it('registers no code the poller cannot emit', () => {
    const orphans = HEALTH_REASON_CODES.filter((code) => !emitted.has(code)).sort()
    expect(orphans).toEqual([])
  })
})
