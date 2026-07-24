/**
 * journey lib — journey-local vocabulary contracts (T5 b-10).
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_TILES,
  KIND_PRESETS,
  NAME_WORDLIST,
  PROVIDER_MODELS,
  defaultModelFor,
  rerollName,
  slugifyName,
} from '../../console/src/lib/journey'

describe('KIND_PRESETS', () => {
  it('four archetypes per 14-onboarding §1, exactly one hint, valid server types', () => {
    expect(KIND_PRESETS.length).toBe(4)
    expect(KIND_PRESETS.filter((k) => k.hint).length).toBe(1)
    for (const k of KIND_PRESETS) {
      expect(['passive', 'chat', 'agent']).toContain(k.type)
    }
  })
  it('community preset carries the mockup soul seed', () => {
    const community = KIND_PRESETS.find((k) => k.id === 'community')!
    expect(community.soulSeed).toContain('community room')
  })
})

describe('CHANNEL_TILES (honesty: only baileys is API-creatable)', () => {
  it('exactly one enabled tile: WhatsApp', () => {
    const enabled = CHANNEL_TILES.filter((t) => t.enabled)
    expect(enabled.length).toBe(1)
    expect(enabled[0]!.id).toBe('baileys')
  })
  it('every disabled tile carries its reason (never a silent fake)', () => {
    for (const t of CHANNEL_TILES.filter((t) => !t.enabled)) {
      expect(t.note, `tile ${t.id} missing note`).toBeTruthy()
    }
  })
})

describe('rerollName', () => {
  it('never returns the current name; always from the wordlist', () => {
    for (const n of NAME_WORDLIST) {
      const next = rerollName(n)
      expect(next).not.toBe(n)
      expect(NAME_WORDLIST).toContain(next)
    }
  })
})

describe('slugifyName (server rule: /^[a-z][a-z0-9-]*$/, 2–30)', () => {
  it('produces valid line names from display names', () => {
    expect(slugifyName('Quinn')).toBe('quinn')
    expect(slugifyName('Ms. Beacon')).toBe('ms-beacon')
    expect(slugifyName('  Wren  ')).toBe('wren')
    expect(slugifyName('42 Finch')).toBe('finch') // leading non-letters stripped
    for (const n of NAME_WORDLIST) {
      expect(slugifyName(n)).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })
  it('caps at 30 chars', () => {
    expect(slugifyName('A'.repeat(40)).length).toBeLessThanOrEqual(30)
  })
})

describe('PROVIDER_MODELS', () => {
  it('curated lists exist for the model-enumerated providers; default is the first entry', () => {
    expect(PROVIDER_MODELS['claude-cli']!.length).toBeGreaterThan(0)
    expect(PROVIDER_MODELS['openai-api']!.length).toBe(3)
    expect(defaultModelFor('claude-cli')).toBe(PROVIDER_MODELS['claude-cli']![0]!.value)
    expect(defaultModelFor('codex-cli')).toBe('') // honest empty — free text
  })
})
