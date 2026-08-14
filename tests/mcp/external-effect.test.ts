/**
 * D2 — external-effect proof uses its own closed taxonomy (capability-obligation
 * replay). `replay_policy` is recovery semantics and is NOT reused. Each exposed tool
 * carries an explicit `externalEffect` declaration; each turn-scoped invocation record
 * folds to one closed class; only a turn whose every invocation folds to `none` or a
 * conclusive `failed_before_accept` can prove "no incompatible external effect".
 */
import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_EFFECT_CONTRACT_VERSION,
  classifyInvocationEffect,
  foldTurnEffects,
  type ExternalEffectClass,
} from '../../src/mcp/external-effect.ts';

const NONE = { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'none' } as const;
const EXTERNAL = { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' } as const;

const record = (over: Partial<{ status: string; outcomeCode: string | null; failureStage: string | null }> = {}) => ({
  toolName: 't',
  status: 'complete',
  outcomeCode: 'success',
  failureStage: null,
  ...over,
});

describe('classifyInvocationEffect', () => {
  it('unclassified tools fold to unknown regardless of outcome', () => {
    expect(classifyInvocationEffect(undefined, record())).toBe('unknown');
    expect(classifyInvocationEffect(undefined, record({ status: 'error' }))).toBe('unknown');
  });

  it('a declared-none tool folds to none regardless of outcome', () => {
    for (const status of ['complete', 'error', 'executing', 'pending', 'quarantined', 'replayed']) {
      expect(classifyInvocationEffect(NONE, record({ status }))).toBe('none');
    }
  });

  it('external + pre-accept failure stages fold to failed_before_accept', () => {
    for (const failureStage of ['admission', 'validation', 'authorization', 'policy']) {
      expect(
        classifyInvocationEffect(EXTERNAL, record({ status: 'error', outcomeCode: 'failure', failureStage })),
      ).toBe('failed_before_accept');
    }
  });

  it('external + completed folds to accepted', () => {
    expect(classifyInvocationEffect(EXTERNAL, record())).toBe('accepted');
    expect(classifyInvocationEffect(EXTERNAL, record({ status: 'replayed', outcomeCode: 'recovered_replayed' }))).toBe('accepted');
  });

  it('external + handler/dependency error is ambiguous (mutation may have begun)', () => {
    for (const failureStage of ['handler', 'dependency']) {
      expect(
        classifyInvocationEffect(EXTERNAL, record({ status: 'error', outcomeCode: 'failure', failureStage })),
      ).toBe('ambiguous');
    }
  });

  it('external + non-terminal or quarantined is ambiguous', () => {
    for (const status of ['executing', 'pending', 'quarantined']) {
      expect(classifyInvocationEffect(EXTERNAL, record({ status, outcomeCode: 'not_terminal' }))).toBe('ambiguous');
    }
  });

  it('external + unrecognized record shape is unknown (fail-closed)', () => {
    expect(classifyInvocationEffect(EXTERNAL, record({ status: 'weird-new-status' }))).toBe('unknown');
    expect(classifyInvocationEffect(EXTERNAL, record({ status: 'error', failureStage: null }))).toBe('ambiguous');
  });
});

describe('foldTurnEffects', () => {
  const fold = (classes: ExternalEffectClass[], over: Partial<Parameters<typeof foldTurnEffects>[1]> = {}) =>
    foldTurnEffects(classes, { enumerationComplete: true, writeLossInWindow: false, ...over });

  it('zero invocations with complete enumeration is conclusive', () => {
    expect(fold([])).toEqual({ conclusiveNoEffect: true });
  });

  it('all none / failed_before_accept is conclusive', () => {
    expect(fold(['none', 'none', 'failed_before_accept'])).toEqual({ conclusiveNoEffect: true });
  });

  it.each<ExternalEffectClass>(['accepted', 'ambiguous', 'unknown'])(
    'any %s invocation is NOT conclusive',
    (cls) => {
      const r = fold(['none', cls]);
      expect(r.conclusiveNoEffect).toBe(false);
      if (!r.conclusiveNoEffect) expect(r.reason).toBe(`invocation_${cls}`);
    },
  );

  it('incomplete enumeration is never conclusive', () => {
    const r = fold(['none'], { enumerationComplete: false });
    expect(r.conclusiveNoEffect).toBe(false);
    if (!r.conclusiveNoEffect) expect(r.reason).toBe('enumeration_incomplete');
  });

  it('a durability write-loss in the turn window is never conclusive', () => {
    const r = fold([], { writeLossInWindow: true });
    expect(r.conclusiveNoEffect).toBe(false);
    if (!r.conclusiveNoEffect) expect(r.reason).toBe('write_loss_in_window');
  });
});
