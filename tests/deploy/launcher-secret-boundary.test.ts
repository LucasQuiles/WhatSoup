import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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
    const start = source.indexOf('# Do not inherit protected credentials');
    const end = source.indexOf('# Import-only mode', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const result = spawnSync('/bin/bash', ['-c', `${block}\nenv`], {
      encoding: 'utf8',
      env: Object.fromEntries(protectedNames.map((name) => [name, `parent-${name}`])),
    });

    expect(result.status).toBe(0);
    for (const name of protectedNames) expect(result.stdout).not.toMatch(new RegExp(`^${name}=`, 'm'));
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

});
