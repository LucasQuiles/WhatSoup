/**
 * Direct unit coverage for the last two untested pure-data modules under
 * console/src/lib:
 *
 * - log-theme.ts: 3 level→class/style records. `levelColor` and `levelBg`
 *   are already pinned in tests/console/ops-actions.test.ts; `levelLineBg`
 *   was the remaining gap.
 * - motion.ts: a single framer-motion stagger-child variant block.
 *
 * Both are pure data, so the assertions lock the public contract (shape +
 * exact values) to catch accidental edits.
 */
import { describe, expect, it } from 'vitest';
import { levelColor, levelBg, levelLineBg } from '../../console/src/lib/log-theme';
import {
  motionDurations,
  motionEasings,
  staggerChildVariants,
  toastMotion,
} from '../../console/src/lib/motion';

describe('log-theme', () => {
  it('levelColor maps each known log level to a CSS class', () => {
    expect(levelColor).toEqual({
      info: 'text-t3',
      warn: 'text-s-warn',
      error: 'text-s-crit',
      debug: 'text-t5',
    });
  });

  it('levelBg maps each known log level to a CSS variable for the row background', () => {
    expect(levelBg).toEqual({
      info: 'var(--color-d5)',
      warn: 'var(--s-warn-wash)',
      error: 'var(--s-crit-soft)',
      debug: 'var(--color-d4)',
    });
  });

  it('levelLineBg only maps the two attention levels (error and warn) — info/debug intentionally absent', () => {
    expect(levelLineBg).toEqual({
      error: 'var(--s-crit-wash)',
      warn: 'var(--s-warn-wash)',
    });
    // Exhaustive key-set assertion: lock the omission of info/debug.
    expect(Object.keys(levelLineBg).sort()).toEqual(['error', 'warn']);
  });

  it('all three maps agree on the attention levels with exact CSS-token values', () => {
    expect(levelColor.error).toBe('text-s-crit');
    expect(levelColor.warn).toBe('text-s-warn');
    expect(levelBg.error).toBe('var(--s-crit-soft)');
    expect(levelBg.warn).toBe('var(--s-warn-wash)');
    expect(levelLineBg.error).toBe('var(--s-crit-wash)');
    expect(levelLineBg.warn).toBe('var(--s-warn-wash)');
  });
});

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
