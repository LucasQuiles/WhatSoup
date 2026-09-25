/**
 * Shape rules for `service.expectedAccountDigest` — the owner-ratified,
 * opaque account-identity expectation stored next to the task-20 launchd
 * render options. The digest must be a self-describing sha256 value; a raw
 * account identifier is rejected at admission so it can never be persisted
 * in an instance config.
 */
import { describe, expect, it } from 'vitest';
import {
  extractExpectedAccountDigest,
  validateServiceIdentityConfig,
} from '../../src/lib/service-identity-config.ts';

const DIGEST = `sha256:${'b'.repeat(64)}`;

function agentRaw(service: Record<string, unknown> | undefined, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'phbot',
    type: 'agent',
    accessMode: 'self_only',
    agentOptions: { sessionScope: 'single' },
    ...(service === undefined ? {} : { service }),
    ...over,
  };
}

describe('validateServiceIdentityConfig', () => {
  it('accepts an absent block, an absent field, or a null field', () => {
    expect(validateServiceIdentityConfig(agentRaw(undefined))).toBeNull();
    expect(validateServiceIdentityConfig(agentRaw({ claudeConfigDir: '/opt/root' }))).toBeNull();
    expect(validateServiceIdentityConfig(agentRaw({ expectedAccountDigest: null }))).toBeNull();
  });

  it('accepts a well-formed digest on a claude-cli agent instance', () => {
    expect(validateServiceIdentityConfig(agentRaw({ expectedAccountDigest: DIGEST }))).toBeNull();
    expect(validateServiceIdentityConfig(agentRaw(
      { expectedAccountDigest: DIGEST },
      { agentOptions: { sessionScope: 'single', provider: 'claude-cli' } },
    ))).toBeNull();
  });

  it('rejects a raw account identifier or any non-digest value (never persist a raw identity)', () => {
    for (const value of ['owner@example.test', '0f0e0d0c-0b0a-4998-8776-655443322110', 'b'.repeat(64), `SHA256:${'b'.repeat(64)}`, 42, {}, [DIGEST], '']) {
      const error = validateServiceIdentityConfig(agentRaw({ expectedAccountDigest: value }));
      expect(error, JSON.stringify(value)).toMatchObject({ field: 'service.expectedAccountDigest' });
      expect(error?.message).toMatch(/sha256/);
    }
  });

  it('rejects the field on non-agent instance types (nothing would ever verify it)', () => {
    for (const type of ['chat', 'passive', 'primary']) {
      const error = validateServiceIdentityConfig(agentRaw({ expectedAccountDigest: DIGEST }, { type }));
      expect(error, type).toMatchObject({ field: 'service.expectedAccountDigest' });
      expect(error?.message).toMatch(/agent/);
    }
  });

  it('rejects the field when the primary provider is not claude-cli (the receipt comes from the claude CLI)', () => {
    for (const provider of ['opencode-cli', 'codex-cli', 'openai-api', 'anthropic-api']) {
      const error = validateServiceIdentityConfig(agentRaw(
        { expectedAccountDigest: DIGEST },
        { agentOptions: { sessionScope: 'single', provider } },
      ));
      expect(error, provider).toMatchObject({ field: 'service.expectedAccountDigest' });
      expect(error?.message).toMatch(/claude-cli/);
    }
  });

  it('honours an explicit effective type when the raw config omits type (PATCH merge)', () => {
    const raw = { name: 'phbot', accessMode: 'self_only', service: { expectedAccountDigest: DIGEST } };
    expect(validateServiceIdentityConfig(raw, { effectiveType: 'agent' })).toBeNull();
    expect(validateServiceIdentityConfig(raw, { effectiveType: 'chat' }))
      .toMatchObject({ field: 'service.expectedAccountDigest' });
    expect(validateServiceIdentityConfig(raw)).toMatchObject({ field: 'service.expectedAccountDigest' });
  });

  it('leaves the block-shape error to the launchd service-config validator', () => {
    expect(validateServiceIdentityConfig(agentRaw(undefined, { service: 'not-an-object' }))).toBeNull();
    expect(validateServiceIdentityConfig(agentRaw(undefined, { service: ['x'] }))).toBeNull();
  });
});

describe('extractExpectedAccountDigest', () => {
  it('returns null when nothing is configured (verification disabled)', () => {
    expect(extractExpectedAccountDigest(null)).toBeNull();
    expect(extractExpectedAccountDigest(undefined)).toBeNull();
    expect(extractExpectedAccountDigest(agentRaw(undefined))).toBeNull();
    expect(extractExpectedAccountDigest(agentRaw({ pathPrepend: ['/opt/bin'] }))).toBeNull();
  });

  it('returns the digest when valid', () => {
    expect(extractExpectedAccountDigest(agentRaw({ expectedAccountDigest: DIGEST }))).toBe(DIGEST);
  });

  it('throws (fail-closed) instead of returning a malformed value', () => {
    expect(() => extractExpectedAccountDigest(agentRaw({ expectedAccountDigest: 'owner@example.test' })))
      .toThrow(/sha256/);
  });
});
