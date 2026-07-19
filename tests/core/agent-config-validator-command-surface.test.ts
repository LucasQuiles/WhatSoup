/**
 * Validator coverage for W1-T9b — agentOptions.commandSurface (config.json
 * per-instance command-surface policy overlay). Mirrors the style of
 * agent-config-validator-provider.test.ts / -transport.test.ts.
 *
 * The shape under test is InstanceCommandSurfaceConfig
 * (src/runtimes/agent/command-surface-config.ts): { disabled?, defaultVerbosity?,
 * optionDefaults? }. By design this shape has NO gate/venue/visibility
 * fields — those flow only from the T1 command-registry catalog — so this
 * validator only needs to police the three fields that DO exist.
 */
import { describe, it, expect } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import type { ValidatorContext } from '../../src/core/agent-config-validator.ts';

function agentRaw(commandSurface: unknown): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9096,
    systemPrompt: 'hi',
    agentOptions: {
      sessionScope: 'single',
      commandSurface,
    },
  };
}

const ctx: ValidatorContext = { name: 'test-line', mode: 'create' };

describe('validateInstanceConfig — agentOptions.commandSurface', () => {
  it('accepts an absent commandSurface block', () => {
    const raw = {
      name: 'test-line',
      type: 'agent',
      accessMode: 'self_only',
      healthPort: 9096,
      systemPrompt: 'hi',
      agentOptions: { sessionScope: 'single' },
    };
    expect(validateInstanceConfig(raw, ctx)).toBeNull();
  });

  it('accepts an empty commandSurface object', () => {
    expect(validateInstanceConfig(agentRaw({}), ctx)).toBeNull();
  });

  it('rejects a non-object commandSurface', () => {
    const err = validateInstanceConfig(agentRaw('nope'), ctx);
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.commandSurface');
  });

  it('rejects an array commandSurface', () => {
    const err = validateInstanceConfig(agentRaw(['status']), ctx);
    expect(err).not.toBeNull();
    expect(err?.field).toBe('agentOptions.commandSurface');
  });

  describe('disabled', () => {
    it('accepts a valid array of command-name strings', () => {
      expect(validateInstanceConfig(agentRaw({ disabled: ['kill-session', 'sessions'] }), ctx)).toBeNull();
    });

    it('accepts an empty disabled array', () => {
      expect(validateInstanceConfig(agentRaw({ disabled: [] }), ctx)).toBeNull();
    });

    it('rejects a non-array disabled', () => {
      const err = validateInstanceConfig(agentRaw({ disabled: 'kill-session' }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.disabled');
    });

    it('rejects a disabled array containing a non-string', () => {
      const err = validateInstanceConfig(agentRaw({ disabled: ['kill-session', 42] }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.disabled');
    });

    it('rejects a disabled array containing an empty/blank string', () => {
      const err = validateInstanceConfig(agentRaw({ disabled: ['  '] }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.disabled');
    });
  });

  describe('defaultVerbosity', () => {
    it('accepts "terse"', () => {
      expect(validateInstanceConfig(agentRaw({ defaultVerbosity: 'terse' }), ctx)).toBeNull();
    });

    it('accepts "normal"', () => {
      expect(validateInstanceConfig(agentRaw({ defaultVerbosity: 'normal' }), ctx)).toBeNull();
    });

    it('rejects an unrecognized verbosity value', () => {
      const err = validateInstanceConfig(agentRaw({ defaultVerbosity: 'loud' }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.defaultVerbosity');
    });

    it('rejects a non-string defaultVerbosity', () => {
      const err = validateInstanceConfig(agentRaw({ defaultVerbosity: 1 }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.defaultVerbosity');
    });
  });

  describe('optionDefaults', () => {
    it('accepts a valid command -> {option: default string} map', () => {
      const raw = agentRaw({ optionDefaults: { model: { provider: 'claude-cli' }, status: { format: 'short' } } });
      expect(validateInstanceConfig(raw, ctx)).toBeNull();
    });

    it('accepts an empty optionDefaults object', () => {
      expect(validateInstanceConfig(agentRaw({ optionDefaults: {} }), ctx)).toBeNull();
    });

    it('rejects a non-object optionDefaults', () => {
      const err = validateInstanceConfig(agentRaw({ optionDefaults: 'nope' }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.optionDefaults');
    });

    it('rejects a per-command entry that is not an object', () => {
      const err = validateInstanceConfig(agentRaw({ optionDefaults: { model: 'claude-cli' } }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.optionDefaults');
    });

    it('rejects a per-option value that is not a string', () => {
      const err = validateInstanceConfig(agentRaw({ optionDefaults: { model: { provider: 42 } } }), ctx);
      expect(err).not.toBeNull();
      expect(err?.field).toBe('agentOptions.commandSurface.optionDefaults');
    });
  });

  describe('security axes are not accepted fields (structural — not a validator carve-out)', () => {
    it('a commandSurface block carrying gate/venue/visibility keys is still accepted (unknown keys ignored) but those keys have no effect downstream', () => {
      // The validator does not special-case or reject unknown top-level
      // commandSurface keys (matching the rest of this file's permissive
      // convention for extraneous keys, e.g. nlRoutingTiers). The real
      // guarantee that gate/venue/visibility can never flow through the
      // instance layer lives in the InstanceCommandSurfaceConfig TYPE
      // (command-surface-config.ts) which has no such fields, proven by
      // command-surface-config.test.ts's immutability proof — this test
      // only documents that the validator does not itself become a second,
      // divergent source of truth for that guarantee.
      const raw = agentRaw({ disabled: [], gate: 'admin', venue: 'dm', visibility: 'operator' });
      expect(validateInstanceConfig(raw, ctx)).toBeNull();
    });
  });
});
