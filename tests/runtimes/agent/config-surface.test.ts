/**
 * Tests for the pure /config command parser (CONFIG-SURFACE-MAP.md #1 + Q's
 * unset path #7). Q's design: ONE /config namespace where ARG-COUNT decides
 * read-vs-write — bare = overview, <axis> = read, <axis> default = unset,
 * <axis> <value> = write. This is the deterministic grammar layer (owner
 * directive 2026-07-20: the checks live in the action, not the LLM); per-axis
 * validation of the axis name + value belongs to the executor, not this parser.
 */
import { describe, it, expect } from 'vitest';
import { parseConfigCommand, type ConfigAction } from '../../../src/runtimes/agent/config-surface.ts';

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
