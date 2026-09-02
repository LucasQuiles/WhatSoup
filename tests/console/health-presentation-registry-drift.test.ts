/**
 * Producer/console drift guard for the health-presentation registry (#2523).
 *
 * The console registry (console/src/lib/health-presentation.ts) is a validated
 * view of the vocabulary the fleet actually emits. If a producer gains a
 * `statusReason` the console does not register, the new code would silently
 * degrade to the fail-closed "unsupported reason code" state on every operator
 * surface. That is the right runtime behaviour and the wrong shipping state, so
 * this guard fails the build instead.
 *
 * There are TWO producers, and the guard must cover both:
 *   - `src/fleet/health-poller.ts` classifies every non-online line. Its codes
 *     reach the feed card unchanged (`src/fleet/routes/feed.ts:382` relays
 *     `poll.statusReason` verbatim).
 *   - `src/fleet/routes/lines.ts:506` builds `LineInstance.statusReason`, which
 *     the deployments card consumes. It relays the poller's codes but also
 *     synthesises `config_error` and `not_polled` of its own.
 * Scanning only the poller is how those two shipped unregistered, so a
 * never-polled line and a misconfigured line both rendered as "unsupported
 * reason code" on the deployments card.
 *
 * Both files are read as TEXT, never imported: `src/fleet/health-poller.ts` is a
 * 2500-line module with a heavy runtime import graph, and console tests must not
 * pull it in (the same reason `console/src/types.ts` mirrors rather than imports
 * `src/transport/connection.ts`).
 *
 * The poller scan is anchored on the four shapes that actually produce a
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
 * The lines-route scan is anchored far more narrowly — see
 * `emittedRouteStatusReasons` for why sweeping that file is wrong.
 *
 * A coverage assertion guards each scanner: a regex that stops matching would
 * otherwise make this suite pass vacuously.
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
 * The SECOND producer. `LineInstance.statusReason` — the field the deployments
 * card consumes — is not a straight relay of the poller: the lines route
 * synthesises `config_error` and `not_polled` on top of the poller's codes.
 * Scanning only the poller left both unregistered, so every never-polled line
 * and every misconfigured line rendered as "unsupported reason code".
 */
const LINES_ROUTE = resolve(import.meta.dirname, '../..', 'src/fleet/routes/lines.ts')

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

/**
 * The lines route's own `statusReason` vocabulary.
 *
 * DELIBERATELY NARROW: anchored on the `statusReason:` assignment alone, never
 * on the file at large. `src/fleet/routes/lines.ts` also contains a LINKED-status
 * classifier whose returns have the same `confidence:` then `reason:` shape
 * (`auth_artifacts_present` / `whatsapp_health_connected` and five more). Those
 * belong to a different field and a different vocabulary; sweeping them in would
 * register seven codes no health surface can ever receive, and would turn the
 * orphan assertion below into noise.
 */
function emittedRouteStatusReasons(source: string): Set<string> {
  const found = new Set<string>()
  for (const line of source.split('\n')) {
    if (!/^\s*statusReason:/.test(line)) continue
    const cleaned = line.replace(/[=!]==?\s*'[^']*'/g, '')
    for (const m of cleaned.matchAll(/'([a-z][a-z0-9_]{3,})'/g)) {
      if (!NOT_REASON_CODES.has(m[1]!)) found.add(m[1]!)
    }
  }
  return found
}

describe('health-presentation registry drift', () => {
  const pollerEmitted = emittedStatusReasons(readFileSync(POLLER, 'utf8'))
  const routeEmitted = emittedRouteStatusReasons(readFileSync(LINES_ROUTE, 'utf8'))
  const emitted = new Set([...pollerEmitted, ...routeEmitted])

  it('still reaches every producer anchor shape (scanner coverage assertion)', () => {
    expect(pollerEmitted.size).toBeGreaterThanOrEqual(15)
    for (const anchor of SCANNER_ANCHORS) {
      expect([...pollerEmitted]).toContain(anchor)
    }
  })

  it('still reaches the lines route statusReason assignment (scanner coverage assertion)', () => {
    // Both codes come from the one ternary at src/fleet/routes/lines.ts:506.
    // If that assignment is renamed or restructured the set empties and this
    // fails, rather than the guard silently reverting to poller-only cover.
    expect([...routeEmitted].sort()).toEqual(['config_error', 'not_polled'])
  })

  it('does not sweep in the lines route linked-status vocabulary', () => {
    // Negative control for the narrow anchor: these are `reason:` fields on the
    // LINKED-status classifier, not status reasons. If the anchor ever widens,
    // this fails before the orphan assertion turns into noise.
    for (const foreign of ['auth_artifacts_present', 'auth_artifacts_absent', 'whatsapp_health_connected']) {
      expect([...routeEmitted]).not.toContain(foreign)
    }
  })

  it('registers a presentation for every status reason either producer emits', () => {
    const unregistered = [...emitted].filter((code) => !(code in HEALTH_REASON_DETAILS)).sort()
    expect(unregistered).toEqual([])
  })

  it('registers no code neither producer can emit', () => {
    const orphans = HEALTH_REASON_CODES.filter((code) => !emitted.has(code)).sort()
    expect(orphans).toEqual([])
  })
})
