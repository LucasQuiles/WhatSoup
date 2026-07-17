import { describe, it, expect } from 'vitest'
import { isRecord, asRecordOrEmpty } from '../../console/src/lib/type-guards'

describe('type-guards', () => {
  describe('isRecord', () => {
    it('returns true for plain objects', () => {
      expect(isRecord({})).toBe(true)
      expect(isRecord({ foo: 'bar' })).toBe(true)
      expect(isRecord({ nested: { deep: true } })).toBe(true)
    })

    it('returns false for null', () => {
      expect(isRecord(null)).toBe(false)
    })

    it('returns false for arrays', () => {
      expect(isRecord([])).toBe(false)
      expect(isRecord([1, 2, 3])).toBe(false)
      expect(isRecord([{ foo: 'bar' }])).toBe(false)
    })

    it('returns false for primitives', () => {
      expect(isRecord(42)).toBe(false)
      expect(isRecord('string')).toBe(false)
      expect(isRecord(true)).toBe(false)
      expect(isRecord(false)).toBe(false)
      expect(isRecord(undefined)).toBe(false)
      expect(isRecord(Symbol('test'))).toBe(false)
    })

    it('returns true for built-in objects that are not arrays', () => {
      expect(isRecord(new Date())).toBe(true) // Date is an object
      expect(isRecord(new Map())).toBe(true) // Map is an object
      expect(isRecord(/regex/)).toBe(true) // RegExp is an object
      expect(isRecord(() => {})).toBe(false) // Functions don't satisfy object check
    })

    it('correctly identifies union types from JSON.parse', () => {
      const jsonObject = JSON.parse('{"key": "value"}')
      const jsonArray = JSON.parse('[1, 2, 3]')
      const jsonNull = JSON.parse('null')

      expect(isRecord(jsonObject)).toBe(true)
      expect(isRecord(jsonArray)).toBe(false)
      expect(isRecord(jsonNull)).toBe(false)
    })
  })

  describe('asRecordOrEmpty', () => {
    it('returns the object for record values', () => {
      const obj = { foo: 'bar' }
      expect(asRecordOrEmpty(obj)).toBe(obj)
      expect(asRecordOrEmpty({ nested: { deep: true } })).toEqual({ nested: { deep: true } })
    })

    it('returns empty object for null', () => {
      expect(asRecordOrEmpty(null)).toEqual({})
    })

    it('returns empty object for undefined', () => {
      expect(asRecordOrEmpty(undefined)).toEqual({})
    })

    it('returns empty object for primitives', () => {
      expect(asRecordOrEmpty(42)).toEqual({})
      expect(asRecordOrEmpty('string')).toEqual({})
      expect(asRecordOrEmpty(true)).toEqual({})
      expect(asRecordOrEmpty(false)).toEqual({})
    })

    it('returns empty object for arrays', () => {
      expect(asRecordOrEmpty([])).toEqual({})
      expect(asRecordOrEmpty([1, 2, 3])).toEqual({})
    })

    it('safely handles untrusted JSON payloads', () => {
      const untrustedJsonObject = JSON.parse('{"key": "value", "nested": {"deep": "data"}}')
      const untrustedJsonArray = JSON.parse('[1, 2, 3]')
      const untrustedJsonNull = JSON.parse('null')

      expect(asRecordOrEmpty(untrustedJsonObject)).toEqual(untrustedJsonObject)
      expect(asRecordOrEmpty(untrustedJsonArray)).toEqual({})
      expect(asRecordOrEmpty(untrustedJsonNull)).toEqual({})
    })

    it('preserves object identity for valid records', () => {
      const obj = { a: 1, b: 2 }
      const result = asRecordOrEmpty(obj)
      expect(result).toBe(obj)
    })

    it('returns a new empty object each time for non-records', () => {
      const empty1 = asRecordOrEmpty(null)
      const empty2 = asRecordOrEmpty(null)
      // Both are empty objects, but may not be the same instance
      expect(empty1).toEqual(empty2)
    })
  })
})
