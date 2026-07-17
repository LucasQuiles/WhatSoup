import { describe, it, expect } from 'vitest'
import {
  motionDurations,
  motionEasings,
  staggerChildVariants,
  toastMotion,
} from '../../console/src/lib/motion'

describe('motion', () => {
  describe('motionDurations', () => {
    it('defines fast, base, and slow durations', () => {
      expect(motionDurations.fast).toBe(0.12)
      expect(motionDurations.base).toBe(0.18)
      expect(motionDurations.slow).toBe(0.28)
    })

    it('has durations in ascending order', () => {
      expect(motionDurations.fast).toBeLessThan(motionDurations.base)
      expect(motionDurations.base).toBeLessThan(motionDurations.slow)
    })

    it('durations object properties are accessible', () => {
      expect(motionDurations).toHaveProperty('fast')
      expect(motionDurations).toHaveProperty('base')
      expect(motionDurations).toHaveProperty('slow')
    })
  })

  describe('motionEasings', () => {
    it('defines enter and exit easing curves', () => {
      expect(motionEasings.enter).toEqual([0.2, 0, 0, 1])
      expect(motionEasings.exit).toEqual([0.4, 0, 1, 1])
    })

    it('uses valid cubic bezier values (0-1 range)', () => {
      motionEasings.enter.forEach((val) => {
        expect(val).toBeGreaterThanOrEqual(0)
        expect(val).toBeLessThanOrEqual(1)
      })
      motionEasings.exit.forEach((val) => {
        expect(val).toBeGreaterThanOrEqual(0)
        expect(val).toBeLessThanOrEqual(1)
      })
    })
  })

  describe('staggerChildVariants', () => {
    it('defines hidden state with opacity and y offset', () => {
      expect(staggerChildVariants.hidden.opacity).toBe(0)
      expect(staggerChildVariants.hidden.y).toBe(12)
    })

    it('defines visible state with animation transition', () => {
      expect(staggerChildVariants.visible.opacity).toBe(1)
      expect(staggerChildVariants.visible.y).toBe(0)
      expect(staggerChildVariants.visible.transition).toBeDefined()
      expect(staggerChildVariants.visible.transition.duration).toBe(0.5)
    })

    it('visible state uses custom easing curve', () => {
      const ease = staggerChildVariants.visible.transition.ease
      expect(ease).toEqual([0.22, 1, 0.36, 1])
    })
  })

  describe('toastMotion', () => {
    it('defines initial state with opacity and y offset', () => {
      expect(toastMotion.initial.opacity).toBe(0)
      expect(toastMotion.initial.y).toBe(8)
    })

    it('defines animate state with full opacity', () => {
      expect(toastMotion.animate.opacity).toBe(1)
      expect(toastMotion.animate.y).toBe(0)
    })

    it('animate transition uses base duration and enter easing', () => {
      expect(toastMotion.animate.transition.duration).toBe(motionDurations.base)
      expect(toastMotion.animate.transition.ease).toEqual(motionEasings.enter)
    })

    it('exit transition uses fast duration and exit easing', () => {
      expect(toastMotion.exit.opacity).toBe(0)
      expect(toastMotion.exit.transition.duration).toBe(motionDurations.fast)
      expect(toastMotion.exit.transition.ease).toEqual(motionEasings.exit)
    })

    it('has defined phases', () => {
      expect(toastMotion.initial).toBeDefined()
      expect(toastMotion.animate).toBeDefined()
      expect(toastMotion.exit).toBeDefined()
    })
  })

  describe('motion consistency', () => {
    it('all durations are numbers', () => {
      expect(typeof motionDurations.fast).toBe('number')
      expect(typeof motionDurations.base).toBe('number')
      expect(typeof motionDurations.slow).toBe('number')
    })

    it('all easing curves are arrays of 4 numbers', () => {
      expect(motionEasings.enter.length).toBe(4)
      expect(motionEasings.exit.length).toBe(4)
      motionEasings.enter.forEach(val => expect(typeof val).toBe('number'))
      motionEasings.exit.forEach(val => expect(typeof val).toBe('number'))
    })

    it('variant states define proper animation properties', () => {
      const variant = staggerChildVariants
      expect(variant.hidden).toBeDefined()
      expect(variant.visible).toBeDefined()
      expect(variant.visible.transition).toBeDefined()
    })

    it('toast motion covers all animation phases', () => {
      expect(toastMotion.initial).toBeDefined()
      expect(toastMotion.animate).toBeDefined()
      expect(toastMotion.exit).toBeDefined()
    })
  })
})
