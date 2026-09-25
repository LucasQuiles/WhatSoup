/**
 * Validator coverage for `service.expectedAccountDigest` — the ratified,
 * opaque account-identity expectation. Mirrors the style of
 * agent-config-validator-service.test.ts (task-20 `service` block).
 *
 * Admission is the ONLY place a raw identifier could enter an instance
 * config; these tests pin that every admission path (create / patch / load /
 * discovery) rejects anything but a sha256 digest on a claude-cli agent.
 */
import { describe, expect, it } from 'vitest';
import { validateInstanceConfig, type ValidatorContext } from '../../src/core/agent-config-validator.ts';

const DIGEST = `sha256:${'c'.repeat(64)}`;

function agentRaw(service: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'phbot',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9096,
    systemPrompt: 'hi',
    agentOptions: { sessionScope: 'single' },
    service,
    ...over,
  };
}

const modes: ValidatorContext[] = [
  { name: 'phbot', mode: 'create' },
  { name: 'phbot', mode: 'load' },
  { name: 'phbot', mode: 'discovery' },
];

describe('validateInstanceConfig — service.expectedAccountDigest', () => {
  it('accepts a well-formed digest alongside the task-20 render options on every admission path', () => {
    for (const ctx of modes) {
      expect(validateInstanceConfig(agentRaw({
        claudeConfigDir: '/opt/claude-roots/phbot',
        expectedAccountDigest: DIGEST,
      }), ctx), ctx.mode).toBeNull();
    }
  });

  it('rejects a raw account identifier on every admission path', () => {
    for (const ctx of modes) {
      const error = validateInstanceConfig(agentRaw({ expectedAccountDigest: 'owner@example.test' }), ctx);
      expect(error, ctx.mode).toMatchObject({ field: 'service.expectedAccountDigest', status: 400 });
    }
  });

  it('rejects the field on a chat instance and on a non-claude-cli primary provider', () => {
    const chat = validateInstanceConfig({
      name: 'chat-line',
      type: 'chat',
      accessMode: 'self_only',
      service: { expectedAccountDigest: DIGEST },
    }, { name: 'chat-line', mode: 'create' });
    expect(chat).toMatchObject({ field: 'service.expectedAccountDigest' });

    const opencode = validateInstanceConfig(agentRaw(
      { expectedAccountDigest: DIGEST },
      { agentOptions: { sessionScope: 'single', provider: 'opencode-cli', model: 'minimax/MiniMax-M2' } },
    ), { name: 'phbot', mode: 'create' });
    expect(opencode).toMatchObject({ field: 'service.expectedAccountDigest' });
  });

  it('PATCH: uses the immutable original type when the merged payload carries it', () => {
    const merged = agentRaw({ expectedAccountDigest: DIGEST });
    expect(validateInstanceConfig(merged, { name: 'phbot', mode: 'patch', originalType: 'agent' })).toBeNull();
  });

  it('still rejects the task-20 shape errors first (block must be an object)', () => {
    const error = validateInstanceConfig(agentRaw({}, { service: 'nope' }), { name: 'phbot', mode: 'create' });
    expect(error).toMatchObject({ field: 'service' });
  });

  it('authOnly loads still enforce the digest shape (no raw identity via the bootstrap-auth path)', () => {
    const error = validateInstanceConfig(
      agentRaw({ expectedAccountDigest: 'b'.repeat(64) }),
      { name: 'phbot', mode: 'load', authOnly: true },
    );
    expect(error).toMatchObject({ field: 'service.expectedAccountDigest' });
  });
});
