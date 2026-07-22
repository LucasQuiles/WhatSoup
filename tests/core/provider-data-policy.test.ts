import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DATA_POLICY_VERSION,
  ProviderDataPolicyError,
  assertCheckpointRoutePolicyCompatible,
  resolveProviderRoutePolicy,
} from '../../src/core/provider-data-policy.ts';

describe('provider data policy', () => {
  it('returns a frozen classified route tuple for a trusted provider', () => {
    const route = resolveProviderRoutePolicy({
      provider: 'claude-cli',
      model: 'claude-opus-4-8',
      dataPolicy: 'trusted',
      boundaryMode: 'shadow',
    });

    expect(route).toEqual({
      provider: 'claude-cli',
      model: 'claude-opus-4-8',
      dataPolicy: 'trusted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
      policyState: 'classified',
    });
    expect(Object.isFrozen(route)).toBe(true);
  });

  it('keeps a missing shadow policy explicitly unresolved', () => {
    expect(resolveProviderRoutePolicy({
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: null,
      boundaryMode: 'shadow',
    })).toMatchObject({ dataPolicy: null, policyState: 'missing' });
  });

  it('throws a typed error for a missing enforce policy', () => {
    expect(() => resolveProviderRoutePolicy({
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: null,
      boundaryMode: 'enforce',
    })).toThrow(ProviderDataPolicyError);
  });

  it('marks restricted CLI policy unsupported in shadow and rejects it in enforce', () => {
    expect(resolveProviderRoutePolicy({
      provider: 'claude-cli',
      model: undefined,
      dataPolicy: 'restricted',
      boundaryMode: 'shadow',
    })).toMatchObject({ dataPolicy: 'restricted', policyState: 'unsupported' });

    expect(() => resolveProviderRoutePolicy({
      provider: 'claude-cli',
      model: undefined,
      dataPolicy: 'restricted',
      boundaryMode: 'enforce',
    })).toThrow(/mechanical isolation/i);
  });

  it('rejects resumed checkpoints when provider, policy, or version differs', () => {
    const route = resolveProviderRoutePolicy({
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: 'restricted',
      boundaryMode: 'enforce',
    });

    expect(() => assertCheckpointRoutePolicyCompatible(route, {
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: 'restricted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
    })).not.toThrow();
    expect(() => assertCheckpointRoutePolicyCompatible(route, {
      provider: 'anthropic-api',
      model: 'gpt-5',
      dataPolicy: 'restricted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
    })).toThrow(/provider mismatch/i);
    expect(() => assertCheckpointRoutePolicyCompatible(route, {
      provider: 'openai-api',
      model: 'gpt-4.1',
      dataPolicy: 'restricted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
    })).toThrow(/model mismatch/i);
    expect(() => assertCheckpointRoutePolicyCompatible(route, {
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: 'trusted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
    })).toThrow(/data policy mismatch/i);
    expect(() => assertCheckpointRoutePolicyCompatible(route, {
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: 'restricted',
      policyVersion: 'provider-data-policy-v0',
    })).toThrow(/policy version mismatch/i);
    expect(() => assertCheckpointRoutePolicyCompatible(route, null)).toThrow(/missing route policy/i);
  });
});
