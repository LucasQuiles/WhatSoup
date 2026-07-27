/**
 * reasoning-control.ts unit — the pure native-reasoning-control descriptor
 * for the `/model` drill Level-3. Phase-1: claude-cli only (4 `--effort`
 * levels); every other provider is a leaf (null, no Level-3). `model` is in
 * the signature for the deferred Phase-2 per-model gating (E31) but does not
 * change Phase-1 output.
 */
import { describe, it, expect } from 'vitest';
import { nativeReasoningControl } from '../../../src/runtimes/agent/reasoning-control.ts';

describe('nativeReasoningControl', () => {
  it('claude-cli offers the 4 --effort levels strongest -> weakest', () => {
    const rc = nativeReasoningControl('claude-cli', 'claude-sonnet-5');
    expect(rc).not.toBeNull();
    expect(rc!.kind).toBe('flag-levels');
    expect(rc!.options).toEqual(['xhigh', 'high', 'medium', 'low']);
  });

  it('is model-agnostic in Phase-1 — any claude-cli model gets the same levels', () => {
    const a = nativeReasoningControl('claude-cli', 'claude-opus-4-8');
    const b = nativeReasoningControl('claude-cli', 'some-unmapped-future-model');
    expect(a!.options).toEqual(b!.options);
  });

  it('returns null (leaf, no Level-3) for every non-claude-cli provider', () => {
    for (const p of ['codex-cli', 'gemini-cli', 'opencode-cli', 'openai-api', 'anthropic-api']) {
      expect(nativeReasoningControl(p, 'any-model')).toBeNull();
    }
  });

  it('the levels array is frozen (accidental mutation throws in strict mode)', () => {
    const rc = nativeReasoningControl('claude-cli', 'claude-sonnet-5');
    expect(Object.isFrozen(rc!.options)).toBe(true);
  });
});
