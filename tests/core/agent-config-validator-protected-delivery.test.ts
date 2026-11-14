/**
 * Validator coverage for agentOptions.protectedDelivery: an enabled feature
 * needs a resolved, bound direct conversation on every config path. Split from
 * tests/core/agent-config-validator.test.ts, which is at its file-size ceiling.
 */
import { describe, expect, it } from 'vitest';
import {
  validateInstanceConfig,
  type ValidatorContext,
} from '../../src/core/agent-config-validator.ts';

const baseAgent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'alpha',
  type: 'agent',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  agentOptions: { sessionScope: 'single' },
  ...overrides,
});

const ctx = (mode: ValidatorContext['mode'], over: Partial<ValidatorContext> = {}): ValidatorContext => ({
  name: 'alpha',
  mode,
  ...over,
});

describe('protected delivery requires a bound conversation', () => {
  for (const mode of ['create', 'patch', 'load', 'discovery'] as const) {
    it(`rejects enabled delivery on unbound sessions during ${mode}`, () => {
      for (const sessionScope of [undefined, 'single', 'shared', 'per_chat']) {
        const result = validateInstanceConfig(baseAgent({ agentOptions: {
          ...(sessionScope ? { sessionScope } : {}),
          protectedDelivery: { enabled: true },
        } }), ctx(mode));
        expect(result?.field).toBe('agentOptions.protectedDelivery');
      }
    });
  }

  it('accepts both destination-carrying per-chat configurations', () => {
    for (const confinement of [{ sandboxPerChat: true }, { perChatConversationBound: true }]) {
      expect(validateInstanceConfig(baseAgent({ agentOptions: {
        sessionScope: 'per_chat', ...confinement,
        protectedDelivery: { enabled: true },
      } }), ctx('load'))).toBeNull();
    }
  });

  it('accepts an unflagged per-chat managed-loop provider route', () => {
    for (const provider of ['openai-api', 'anthropic-api']) {
      expect(validateInstanceConfig(baseAgent({
        model: 'test-model',
        agentOptions: {
          sessionScope: 'per_chat',
          provider,
          protectedDelivery: { enabled: true },
        },
      }), ctx('load'))).toBeNull();
    }
  });

  it('accepts an unflagged per-chat route when every static fallback is managed-loop', () => {
    expect(validateInstanceConfig(baseAgent({
      model: 'test-model',
      agentOptions: {
        sessionScope: 'per_chat',
        provider: 'openai-api',
        fallbacks: [{ provider: 'anthropic-api', model: 'fallback-model' }],
        protectedDelivery: { enabled: true },
      },
    }), ctx('load'))).toBeNull();
  });

  it('rejects an unflagged per-chat route with a stdio fallback', () => {
    const result = validateInstanceConfig(baseAgent({
      model: 'test-model',
      agentOptions: {
        sessionScope: 'per_chat',
        provider: 'openai-api',
        fallbacks: [{ provider: 'claude-cli' }],
        protectedDelivery: { enabled: true },
      },
    }), ctx('load'));
    expect(result?.field).toBe('agentOptions.protectedDelivery');
  });

  it('rejects an unflagged per-chat route with dynamic fallback discovery', () => {
    const result = validateInstanceConfig(baseAgent({
      model: 'test-model',
      agentOptions: {
        sessionScope: 'per_chat',
        provider: 'openai-api',
        fallbackDiscovery: { mode: 'auto' },
        protectedDelivery: { enabled: true },
      },
    }), ctx('load'));
    expect(result?.field).toBe('agentOptions.protectedDelivery');
  });

  it('preserves unbound sessions when protected delivery is disabled', () => {
    expect(validateInstanceConfig(baseAgent({ agentOptions: {
      sessionScope: 'single', protectedDelivery: { enabled: false },
    } }), ctx('load'))).toBeNull();
  });
});
