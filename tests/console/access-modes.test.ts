import { describe, it, expect } from 'vitest'
import {
  ACCESS_MODE_VALUES,
  ACCESS_MODE_DETAILS,
  ACCESS_MODE_LABELS,
  type AccessModeValue,
} from '../../console/src/lib/access-modes'

describe('access-modes', () => {
  it('exports all access mode values', () => {
    expect(ACCESS_MODE_VALUES).toEqual([
      'self_only',
      'allowlist',
      'open_dm',
      'groups_only',
    ])
  })

  it('provides labels for all access modes', () => {
    ACCESS_MODE_VALUES.forEach((mode) => {
      expect(ACCESS_MODE_LABELS[mode]).toBeDefined()
      expect(typeof ACCESS_MODE_LABELS[mode]).toBe('string')
      expect(ACCESS_MODE_LABELS[mode].length).toBeGreaterThan(0)
    })
  })

  it('provides descriptions for all access modes', () => {
    ACCESS_MODE_VALUES.forEach((mode) => {
      const details = ACCESS_MODE_DETAILS[mode]
      expect(details).toBeDefined()
      expect(details.label).toBeDefined()
      expect(details.description).toBeDefined()
      expect(typeof details.label).toBe('string')
      expect(typeof details.description).toBe('string')
    })
  })

  it('has correct labels for each mode', () => {
    expect(ACCESS_MODE_LABELS.self_only).toBe('Admin Only')
    expect(ACCESS_MODE_LABELS.allowlist).toBe('Allowlist')
    expect(ACCESS_MODE_LABELS.open_dm).toBe('Open DMs')
    expect(ACCESS_MODE_LABELS.groups_only).toBe('Groups Only')
  })

  it('has correct descriptions for each mode', () => {
    expect(ACCESS_MODE_DETAILS.self_only.description).toBe('Only admin phone numbers can interact')
    expect(ACCESS_MODE_DETAILS.allowlist.description).toBe('Approved contacts only')
    expect(ACCESS_MODE_DETAILS.open_dm.description).toBe('Anyone can send direct messages')
    expect(ACCESS_MODE_DETAILS.groups_only.description).toBe('Only responds in group chats')
  })

  it('preserves consistency between details and labels', () => {
    ACCESS_MODE_VALUES.forEach((mode) => {
      expect(ACCESS_MODE_DETAILS[mode].label).toBe(ACCESS_MODE_LABELS[mode])
    })
  })

  it('access mode values are immutable tuple', () => {
    expect(Array.isArray(ACCESS_MODE_VALUES)).toBe(true)
    expect(ACCESS_MODE_VALUES.length).toBe(4)
  })

  it('access mode details are defined for all modes', () => {
    ACCESS_MODE_VALUES.forEach((mode) => {
      const descriptor = Object.getOwnPropertyDescriptor(ACCESS_MODE_DETAILS, mode)
      expect(descriptor).toBeDefined()
    })
  })
})
