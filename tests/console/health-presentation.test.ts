/**
 * health-presentation registry contract (#2523).
 *
 * Unit-level cover for the canonical projection every console health surface
 * reads. The component-level cover lives in
 * tests/console/feed-card-health-presentation.test.tsx.
 */
import { describe, expect, it } from 'vitest'
import {
  ACTION_CAPABLE_CLASSES,
  CONNECTION_REASON_LABELS,
  HEALTH_REASON_CODES,
  HEALTH_REASON_DETAILS,
  NEXT_ACTION_POLICIES,
  STALE_OBSERVATION_LABEL,
  UNKNOWN_REASON_LABEL,
  UNSUPPORTED_REASON_LABEL,
  connectionReasonLabel,
  healthHeadline,
  healthPresentation,
  healthPresentationShortText,
} from '../../console/src/lib/health-presentation'

describe('health reason registry completeness', () => {
  it('registers a distinct label, an impact and a disposition for every code', () => {
    expect(HEALTH_REASON_CODES.length).toBeGreaterThanOrEqual(15)
    const labels = new Set<string>()
    for (const code of HEALTH_REASON_CODES) {
      const entry = HEALTH_REASON_DETAILS[code]
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.impact.length).toBeGreaterThan(0)
      expect(entry.nextAction.length).toBeGreaterThan(0)
      labels.add(entry.label)
    }
    expect(labels.size).toBe(HEALTH_REASON_CODES.length)
  })

  it('declares no duplicate codes', () => {
    expect(new Set(HEALTH_REASON_CODES).size).toBe(HEALTH_REASON_CODES.length)
  })

  it('keeps observation-availability failures distinct from domain unhealthiness', () => {
    expect(HEALTH_REASON_DETAILS.health_body_unhealthy.availability).toBe('observed')
    expect(HEALTH_REASON_DETAILS.health_probe_timeout_under_proxy_load.availability).toBe('unavailable')
    expect(HEALTH_REASON_DETAILS.health_poll_failed_threshold.availability).toBe('unavailable')
    expect(HEALTH_REASON_DETAILS.health_body_incomplete.availability).toBe('incomplete')
  })

  it('never lets a raw label read as a bare severity word', () => {
    for (const code of HEALTH_REASON_CODES) {
      expect(['degraded', 'online', 'unreachable', 'logged out', 'unknown'])
        .not.toContain(HEALTH_REASON_DETAILS[code].label)
    }
  })
})

describe('action proof requirements', () => {
  it('declares freshness, confidence, authorization and recovery proof for every action-capable class', () => {
    for (const cls of ACTION_CAPABLE_CLASSES) {
      const policy = NEXT_ACTION_POLICIES[cls]
      expect(policy).not.toBeNull()
      expect(policy!.requiresFreshObservation).toBe(true)
      expect(policy!.minimumConfidence).toBe('confirmed')
      expect(policy!.authorization.length).toBeGreaterThan(0)
      expect(policy!.recoveryProof.length).toBeGreaterThan(0)
    }
  })

  it('declares no action proof for classes that cannot drive a mutation', () => {
    for (const cls of ['none', 'monitor', 'investigate'] as const) {
      expect(NEXT_ACTION_POLICIES[cls]).toBeNull()
    }
  })

  it('exposes the proof requirement on every presentation whose disposition is action-capable', () => {
    const presented = healthPresentation({
      status: 'degraded',
      reason: 'health_body_unhealthy',
      confidence: 'confirmed',
    })
    expect(presented.nextAction).toBe('restart_line')
    expect(presented.actionProof).toEqual(NEXT_ACTION_POLICIES.restart_line)
  })
})

describe('healthPresentation projection', () => {
  it('renders the human label, the code and the confidence for a registered reason', () => {
    const presented = healthPresentation({
      status: 'degraded',
      reason: 'health_body_unhealthy',
      confidence: 'confirmed',
    })
    expect(presented.code).toBe('health_body_unhealthy')
    expect(presented.supported).toBe(true)
    expect(presented.summary).toBe(
      'health response reports unhealthy (health_body_unhealthy) · confidence confirmed',
    )
    expect(presented.clipboardText).toBe(`degraded — ${presented.summary}`)
  })

  it('fails closed on an unregistered code and does not echo it', () => {
    const presented = healthPresentation({
      status: 'degraded',
      reason: 'reconnect loop',
      confidence: 'confirmed',
    })
    expect(presented.code).toBeNull()
    expect(presented.supported).toBe(false)
    expect(presented.label).toBe(UNSUPPORTED_REASON_LABEL)
    expect(presented.availability).toBe('unavailable')
    expect(presented.summary).not.toContain('reconnect loop')
    expect(presented.clipboardText).not.toContain('reconnect loop')
  })

  it('says unknown only when the producer supplied no reason at all', () => {
    const presented = healthPresentation({ status: 'degraded' })
    expect(presented.code).toBeNull()
    expect(presented.supported).toBe(true)
    expect(presented.label).toBe(UNKNOWN_REASON_LABEL)
    expect(presented.clipboardText).toBe('degraded — unknown')
  })

  it('leaves the reason slot empty when the headline is already a specific classification', () => {
    expect(healthPresentation({ status: 'config_error' }).summary).toBeUndefined()
    expect(healthPresentation({ status: 'config_error' }).clipboardText).toBe('configuration error')
    expect(healthPresentation({ status: 'online' }).clipboardText).toBe('came online')
  })

  it('labels a stale observation even when the last-good reason is retained', () => {
    const presented = healthPresentation({
      status: 'degraded',
      reason: 'health_body_unhealthy',
      confidence: 'confirmed',
      stale: true,
    })
    expect(presented.stale).toBe(true)
    expect(presented.summary).toContain(STALE_OBSERVATION_LABEL)
    expect(presented.clipboardText).toContain(STALE_OBSERVATION_LABEL)
    expect(presented.code).toBe('health_body_unhealthy')
  })

  it('labels an unavailable observation distinctly from a confirmed unhealthy line', () => {
    const unavailable = healthPresentation({
      status: 'degraded',
      reason: 'health_probe_timeout_under_proxy_load',
      confidence: 'ambiguous',
    })
    const confirmed = healthPresentation({
      status: 'degraded',
      reason: 'health_body_unhealthy',
      confidence: 'confirmed',
    })
    expect(unavailable.summary).toContain('observation unavailable')
    expect(confirmed.summary).not.toContain('observation unavailable')
    expect(unavailable.summary).not.toBe(confirmed.summary)
  })

  it('distinguishes ambiguous from confirmed in text, not in severity alone', () => {
    const ambiguous = healthPresentation({
      status: 'degraded',
      reason: 'health_body_degraded',
      confidence: 'ambiguous',
    })
    const confirmed = healthPresentation({
      status: 'degraded',
      reason: 'health_body_degraded',
      confidence: 'confirmed',
    })
    expect(ambiguous.summary).toContain('confidence ambiguous')
    expect(confirmed.summary).toContain('confidence confirmed')
  })

  it('treats a blank reason as absent rather than unregistered', () => {
    const presented = healthPresentation({ status: 'degraded', reason: '   ' })
    expect(presented.supported).toBe(true)
    expect(presented.label).toBe(UNKNOWN_REASON_LABEL)
  })

  it('keeps the headline identical for the card and the clipboard', () => {
    for (const status of ['online', 'degraded', 'unreachable', 'logged_out', 'config_error', 'unknown']) {
      expect(healthPresentation({ status }).headline).toBe(healthHeadline(status))
    }
  })
})

describe('healthPresentationShortText', () => {
  it('shortens a registered reason to its label and keeps the availability verdict', () => {
    const presented = healthPresentation({
      status: 'degraded',
      reason: 'health_probe_auth_failed',
      confidence: 'ambiguous',
    })
    expect(healthPresentationShortText(presented)).toBe(
      'health probe rejected the credentials · observation unavailable',
    )
  })

  it('falls back to the severity headline, never the raw state code, when no reason exists', () => {
    expect(healthPresentationShortText(healthPresentation({ status: 'unreachable' })))
      .toBe('connection lost')
  })

  it('keeps the unsupported state explicit', () => {
    expect(healthPresentationShortText(healthPresentation({ status: 'degraded', reason: 'nope' })))
      .toContain(UNSUPPORTED_REASON_LABEL)
  })

  it('keeps the auth-expired nuance when the surface carries the last session status', () => {
    expect(healthPresentationShortText(
      healthPresentation({ status: 'unreachable', lastSessionStatus: 'auth_expired' }),
    )).toBe('auth expired')
    expect(healthPresentationShortText(healthPresentation({ status: 'unreachable' })))
      .toBe('connection lost')
  })
})

// The lines route synthesises these two on top of the poller's vocabulary
// (src/fleet/routes/lines.ts:506). Both are routine states, so neither may reach
// the fail-closed unsupported presentation.
describe('lines-route synthesised reasons', () => {
  it('labels a never-polled line as awaiting its first observation', () => {
    const presented = healthPresentation({ status: 'unknown', reason: 'not_polled' })
    expect(presented.code).toBe('not_polled')
    expect(presented.supported).toBe(true)
    expect(presented.label).toBe('awaiting first health poll')
    expect(presented.availability).toBe('unavailable')
    expect(presented.nextAction).toBe('monitor')
    expect(presented.actionProof).toBeNull()
  })

  it('treats a config error as a confirmed local observation, not an unavailable one', () => {
    const presented = healthPresentation({
      status: 'config_error',
      reason: 'config_error',
      confidence: 'confirmed',
    })
    expect(presented.code).toBe('config_error')
    expect(presented.availability).toBe('observed')
    // The route stamps `confidence: confirmed` alongside this code; marking the
    // observation unavailable would contradict it in the same sentence.
    expect(presented.summary).toContain('confidence confirmed')
    expect(presented.summary).not.toContain('observation unavailable')
  })
})

describe('connection reason labels share the registry module', () => {
  it('labels every registered transport reason', () => {
    expect(connectionReasonLabel('connectionLost')).toBe('connection lost')
    expect(Object.keys(CONNECTION_REASON_LABELS).length).toBeGreaterThan(0)
  })

  it('keeps an unregistered transport reason readable because that vocabulary is open', () => {
    expect(connectionReasonLabel('vendorSpecificCode')).toBe('vendorSpecificCode')
  })
})
