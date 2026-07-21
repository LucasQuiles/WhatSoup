import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const lookupCredentialMock = vi.hoisted(() => vi.fn(() => 'must-not-enter-child-env'));

vi.mock('../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: lookupCredentialMock };
});

import { buildChildEnv } from '../../src/runtimes/agent/session.ts';

const protectedNames = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'PINECONE_API_KEY',
  'WHATSOUP_HEALTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'MINIMAX_API_KEY',
] as const;

describe('runtime secret boundary', () => {
  it('launcher clears protected names and performs no secret lookup or export', () => {
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');

    expect(source).toContain('unset ANTHROPIC_API_KEY OPENAI_API_KEY PINECONE_API_KEY');
    expect(source).toContain('WHATSOUP_HEALTH_TOKEN');
    expect(source).not.toContain('keyring_lookup()');
    expect(source).not.toContain('macos_keychain_lookup()');
    expect(source).not.toContain('read-private-health-token.sh');
    expect(source).not.toMatch(/export\s+[^\n]*(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|PINECONE_API_KEY|WHATSOUP_HEALTH_TOKEN)/);
  });

  it.each([
    ['claude-cli', undefined, undefined],
    ['codex-cli', undefined, undefined],
    ['gemini-cli', undefined, undefined],
    ['opencode-cli', 'openai/test-model', undefined],
    ['opencode-cli', 'custom/model', { baseUrl: 'https://endpoint.example/v1', apiKeyService: 'deepseek' }],
  ] as const)('%s child environment excludes every protected secret name', (provider, model, providerConfig) => {
    for (const name of protectedNames) process.env[name] = `parent-${name}`;
    try {
      const env = buildChildEnv(provider, undefined, model, providerConfig);
      for (const name of protectedNames) expect(env).not.toHaveProperty(name);
    } finally {
      for (const name of protectedNames) delete process.env[name];
    }
  });

  it('health authorization uses the canonical instance-scoped keyring lookup only', () => {
    const source = fs.readFileSync('src/core/health.ts', 'utf8');

    expect(source).toContain("lookupCredential('whatsoup-health-token', {");
    expect(source).toContain('user: instanceName');
    expect(source).toContain('skipEnv: true');
    expect(source).toContain('skipMigrationFallbacks: true');
    expect(source).not.toContain("lookupCredential('whatsoup-health-token')");
  });
});
