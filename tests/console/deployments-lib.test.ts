/**
 * deployments lib — pure-derivation contracts for the v3.5 surface.
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import type { LineInstance } from '../../console/src/types'
import {
  DEPLOYMENT_STATE_LABEL,
  agentLinesOf,
  channelCountsOf,
  countOnline,
  deploymentStateOf,
  formatUptime,
  issueLinesOf,
  miniTagOverflow,
} from '../../console/src/lib/deployments'

function line(name: string, overrides: Record<string, unknown> = {}): LineInstance {
  return { name, status: 'online', mode: 'chat', health: { transport: { kind: 'baileys' } }, ...overrides } as unknown as LineInstance
}

describe('deploymentStateOf', () => {
  it('empty fleet is healthy (honest zero — nothing wrong yet)', () => {
    expect(deploymentStateOf([])).toBe('healthy')
  })
  it('all online → healthy; any degraded → degraded; unreachable/config_error → crit', () => {
    expect(deploymentStateOf([line('a'), line('b')])).toBe('healthy')
    expect(deploymentStateOf([line('a'), line('b', { status: 'degraded' })])).toBe('degraded')
    expect(deploymentStateOf([line('a', { status: 'logged_out' })])).toBe('degraded')
    expect(deploymentStateOf([line('a'), line('b', { status: 'unreachable' })])).toBe('crit')
    expect(deploymentStateOf([line('a', { status: 'config_error' })])).toBe('crit')
  })
})

describe('DEPLOYMENT_STATE_LABEL (vocabulary pin)', () => {
  it('every state has a human label — raw codes never reach copy', () => {
    expect(DEPLOYMENT_STATE_LABEL).toEqual({ healthy: 'healthy', degraded: 'degraded', crit: 'critical' })
  })
})

describe('countOnline / issueLinesOf', () => {
  it('counts only online and lists the rest as issues', () => {
    const lines = [line('a'), line('b', { status: 'degraded' }), line('c', { status: 'unknown' })]
    expect(countOnline(lines)).toBe(1)
    expect(issueLinesOf(lines).map((l) => l.name)).toEqual(['b', 'c'])
  })
})

describe('channelCountsOf', () => {
  it('histograms real transport kinds', () => {
    const lines = [
      line('a'),
      line('b'),
      line('c', { health: { transport: { kind: 'signal' } } }),
      line('d', { health: null }),
    ]
    const counts = channelCountsOf(lines)
    expect(counts.get('wa')).toBe(2)
    expect(counts.get('signal')).toBe(1)
    expect(counts.get('unknown')).toBe(1)
  })
})

describe('agentLinesOf', () => {
  it('agent-mode lines only', () => {
    const lines = [line('a', { mode: 'agent' }), line('b'), line('c', { mode: 'passive' })]
    expect(agentLinesOf(lines).map((l) => l.name)).toEqual(['a'])
  })
})

describe('formatUptime', () => {
  it('coarse register: d/h/m/s, never fabricated precision', () => {
    expect(formatUptime(21 * 86400)).toBe('21d')
    expect(formatUptime(6 * 3600)).toBe('6h')
    expect(formatUptime(12 * 60)).toBe('12m')
    expect(formatUptime(42)).toBe('42s')
  })
  it('absent data renders the honest dash', () => {
    expect(formatUptime(null)).toBe('—')
    expect(formatUptime(undefined)).toBe('—')
    expect(formatUptime(-5)).toBe('—')
  })
})

describe('miniTagOverflow', () => {
  it('first two names + overflow count', () => {
    expect(miniTagOverflow(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b'], overflow: 2 })
    expect(miniTagOverflow(['a'])).toEqual({ shown: ['a'], overflow: 0 })
    expect(miniTagOverflow([])).toEqual({ shown: [], overflow: 0 })
  })
})
