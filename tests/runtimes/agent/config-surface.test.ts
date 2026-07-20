/**
 * Tests for the pure /config command parser (CONFIG-SURFACE-MAP.md #1 + Q's
 * unset path #7). Q's design: ONE /config namespace where ARG-COUNT decides
 * read-vs-write — bare = overview, <axis> = read, <axis> default = unset,
 * <axis> <value> = write. This is the deterministic grammar layer (owner
 * directive 2026-07-20: the checks live in the action, not the LLM); per-axis
 * validation of the axis name + value belongs to the executor, not this parser.
 */
import { describe, it, expect } from 'vitest';
import {
  parseConfigCommand,
  decideModelPinResolution,
  type ConfigAction,
  type ModelPinState,
} from '../../../src/runtimes/agent/config-surface.ts';

describe('parseConfigCommand', () => {
  const cases: Array<[string, ConfigAction]> = [
    ['', { kind: 'overview' }],
    ['   ', { kind: 'overview' }],
    ['model', { kind: 'read', axis: 'model' }],
    ['  model  ', { kind: 'read', axis: 'model' }],
    ['model claude-opus-4-8', { kind: 'write', axis: 'model', value: 'claude-opus-4-8' }],
    ['model default', { kind: 'unset', axis: 'model' }],
    ['mode fast on', { kind: 'write', axis: 'mode', value: 'fast on' }],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} → ${expected.kind}`, () => {
      expect(parseConfigCommand(input)).toStrictEqual(expected);
    });
  }

  it('lowercases the AXIS (canonical id) but preserves VALUE case (ids may be mixed-case)', () => {
    expect(parseConfigCommand('MODEL')).toStrictEqual({ kind: 'read', axis: 'model' });
    expect(parseConfigCommand('Model minimax/MiniMax-M2')).toStrictEqual({
      kind: 'write',
      axis: 'model',
      value: 'minimax/MiniMax-M2',
    });
  });

  it('treats the reserved keyword "default" (any case) as unset, not a model named default', () => {
    expect(parseConfigCommand('model DEFAULT')).toStrictEqual({ kind: 'unset', axis: 'model' });
  });

  it('keeps a multi-token value verbatim (executor interprets per axis; parser is shape-only)', () => {
    expect(parseConfigCommand('reasoning   high  effort')).toStrictEqual({
      kind: 'write',
      axis: 'reasoning',
      value: 'high  effort',
    });
  });
});

// Model-pin RESOLUTION decision (Q 2026-07-20, Slice C.2). Provider-qualified:
// a verified pin on the same provider resolves with NO catalogue fetch; every
// transition (provider-change / unverified / unvalidated) re-validates, and the
// unverified-then-catalogue-OK re-validation closes the permanent-fail-open hole.
describe('decideModelPinResolution', () => {
  const noPin: ModelPinState = { requestedModel: null, validatedProvider: null, modelPinVerified: null };
  const verifiedClaude: ModelPinState = { requestedModel: 'claude-opus-4-8', validatedProvider: 'claude-cli', modelPinVerified: true };
  const unverifiedClaude: ModelPinState = { requestedModel: 'claude-opus-4-8', validatedProvider: 'claude-cli', modelPinVerified: false };
  const unvalidated: ModelPinState = { requestedModel: 'claude-opus-4-8', validatedProvider: null, modelPinVerified: false };

  it('no model pin → none', () => {
    expect(decideModelPinResolution(noPin, 'claude-cli')).toStrictEqual({ action: 'none' });
  });

  it('verified pin on the SAME provider → use, with NO catalogue needed', () => {
    expect(decideModelPinResolution(verifiedClaude, 'claude-cli')).toStrictEqual({ action: 'use', modelId: 'claude-opus-4-8' });
  });

  it('unverified pin → needs-catalogue (re-validation deferred until the catalogue is known)', () => {
    expect(decideModelPinResolution(unverifiedClaude, 'claude-cli')).toStrictEqual({ action: 'needs-catalogue', modelId: 'claude-opus-4-8' });
  });

  it('verified pin but provider CHANGED → needs-catalogue (re-validate against the new provider)', () => {
    expect(decideModelPinResolution(verifiedClaude, 'opencode-cli')).toStrictEqual({ action: 'needs-catalogue', modelId: 'claude-opus-4-8' });
  });

  it('unvalidated pin (NULL validated provider) → needs-catalogue, never blessed as current', () => {
    expect(decideModelPinResolution(unvalidated, 'claude-cli')).toStrictEqual({ action: 'needs-catalogue', modelId: 'claude-opus-4-8' });
  });

  it('re-validate + catalogue available + model present → use + revalidated (persist verified/provider)', () => {
    expect(
      decideModelPinResolution(unverifiedClaude, 'claude-cli', { available: true, ids: ['claude-opus-4-8', 'claude-sonnet-5'] }),
    ).toStrictEqual({ action: 'use', modelId: 'claude-opus-4-8', revalidated: { validatedProvider: 'claude-cli', verified: true } });
  });

  it('re-validate + catalogue available + model ABSENT → drop with disclosure (closes the orphan/fail-open hole)', () => {
    expect(
      decideModelPinResolution(unverifiedClaude, 'claude-cli', { available: true, ids: ['claude-sonnet-5'] }),
    ).toStrictEqual({ action: 'drop', droppedModelId: 'claude-opus-4-8', reason: 'not in claude-cli catalogue' });
  });

  it('re-validate + catalogue UNAVAILABLE → defer (fail-open: use unverified, re-validate later)', () => {
    expect(
      decideModelPinResolution(unverifiedClaude, 'claude-cli', { available: false }),
    ).toStrictEqual({ action: 'defer', modelId: 'claude-opus-4-8' });
  });
});
