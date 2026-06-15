/**
 * Direct unit coverage for motion.ts, a pure-data framer-motion token mirror.
 */
import { describe, expect, it } from 'vitest';
import {
  motionDurations,
  motionEasings,
  staggerChildVariants,
  toastMotion,
} from '../../console/src/lib/motion';

describe('motion staggerChildVariants', () => {
  it('declares a hidden state at opacity 0 with positive y-offset', () => {
    expect(staggerChildVariants.hidden).toEqual({ opacity: 0, y: 12 });
  });

  it('declares a visible state at opacity 1 with y reset to 0', () => {
    expect(staggerChildVariants.visible.opacity).toBe(1);
    expect(staggerChildVariants.visible.y).toBe(0);
  });

  it('visible transition uses the project standard 500ms duration + cubic-bezier ease', () => {
    expect(staggerChildVariants.visible.transition.duration).toBe(0.5);
    expect(staggerChildVariants.visible.transition.ease).toEqual([0.22, 1, 0.36, 1]);
  });
});

describe('motion tokens', () => {
  it('mirrors the closed CSS duration token set as seconds for framer-motion', () => {
    expect(motionDurations).toEqual({
      fast: 0.12,
      base: 0.18,
      slow: 0.28,
    });
  });

  it('mirrors the semantic easing tokens for framer-motion', () => {
    expect(motionEasings).toEqual({
      enter: [0.2, 0, 0, 1],
      exit: [0.4, 0, 1, 1],
    });
  });
});

describe('toastMotion', () => {
  it('enters with the toast base-duration/ease-enter token band', () => {
    expect(toastMotion.initial).toEqual({ opacity: 0, y: 8 });
    expect(toastMotion.animate).toEqual({
      opacity: 1,
      y: 0,
      transition: {
        duration: motionDurations.base,
        ease: motionEasings.enter,
      },
    });
  });

  it('exits with the faster toast exit token band', () => {
    expect(toastMotion.exit).toEqual({
      opacity: 0,
      transition: {
        duration: motionDurations.fast,
        ease: motionEasings.exit,
      },
    });
  });
});
