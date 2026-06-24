import { describe, expect, it, vi } from 'vitest';

import {
  makeAccountAuthStatusProbe,
  type AccountAuthStatusDeps,
  type AccountAuthTarget,
} from '../../../src/runtimes/agent/providers/account-auth-status.ts';

const TARGET: AccountAuthTarget = { provider: 'claude-cli', model: 'claude-opus-4-8' };

function deps(overrides: Partial<AccountAuthStatusDeps> = {}): AccountAuthStatusDeps {
  return {
    resolveKeyService: () => null,
    lookupCredential: () => null,
    getProviderBinary: () => 'claude',
    probeBinaryAuthStatus: async () => ({ status: 'ok', output: 'authenticated' }),
    isAuthRequiredMessage: () => false,
    env: { HOME: '/home/x', PATH: '/usr/bin', USER: 'x' },
    ...overrides,
  };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

describe('account-auth-status probe — keyed providers', () => {
  it('present credential → ok / probable (presence is not validity)', async () => {
    const probe = makeAccountAuthStatusProbe(
      { provider: 'openai-api' },
      deps({ resolveKeyService: () => 'openai', lookupCredential: () => 'sk-xxx' }),
    );
    const r = await probe(liveSignal());
    expect(r).toMatchObject({ ok: true, confidence: 'probable' });
    expect(r.summary).toContain('openai');
  });

  it('absent credential → not ok / confirmed', async () => {
    const probe = makeAccountAuthStatusProbe(
      { provider: 'openai-api' },
      deps({ resolveKeyService: () => 'openai', lookupCredential: () => null }),
    );
    const r = await probe(liveSignal());
    expect(r).toMatchObject({ ok: false, confidence: 'confirmed' });
  });

  it('does not spawn a binary when a keyring service resolves', async () => {
    const spawnSpy = vi.fn(async () => ({ status: 'ok' as const, output: 'x' }));
    const probe = makeAccountAuthStatusProbe(
      { provider: 'openai-api' },
      deps({ resolveKeyService: () => 'openai', lookupCredential: () => 'k', probeBinaryAuthStatus: spawnSpy }),
    );
    await probe(liveSignal());
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('account-auth-status probe — CLI providers', () => {
  it('missing binary → not ok / confirmed', async () => {
    const probe = makeAccountAuthStatusProbe(TARGET, deps({ getProviderBinary: () => null }));
    const r = await probe(liveSignal());
    expect(r).toMatchObject({ ok: false, confidence: 'confirmed' });
    expect(r.summary).toContain('no binary');
  });

  it('clean auth-ok → ok / confirmed', async () => {
    const probe = makeAccountAuthStatusProbe(TARGET, deps());
    const r = await probe(liveSignal());
    expect(r).toMatchObject({ ok: true, confidence: 'confirmed' });
  });

  it('auth-required message → not ok / confirmed', async () => {
    const probe = makeAccountAuthStatusProbe(TARGET, deps({ isAuthRequiredMessage: () => true }));
    const r = await probe(liveSignal());
    expect(r).toMatchObject({ ok: false, confidence: 'confirmed' });
    expect(r.summary).toContain('auth required');
  });

  it('failed probe is inconclusive → suspected', async () => {
    const probe = makeAccountAuthStatusProbe(TARGET, deps({ probeBinaryAuthStatus: async () => ({ status: 'failed', output: '' }) }));
    const r = await probe(liveSignal());
    expect(r).toMatchObject({ ok: false, confidence: 'suspected' });
  });

  it('defensive: a throwing probe degrades to suspected (not a throw)', async () => {
    const probe = makeAccountAuthStatusProbe(TARGET, deps({ probeBinaryAuthStatus: async () => { throw new Error('spawn exploded'); } }));
    const r = await probe(liveSignal());
    expect(r).toMatchObject({ ok: false, confidence: 'suspected' });
  });

  it('already-aborted signal short-circuits before spawning', async () => {
    const spawnSpy = vi.fn(async () => ({ status: 'ok' as const, output: 'x' }));
    const probe = makeAccountAuthStatusProbe(TARGET, deps({ probeBinaryAuthStatus: spawnSpy }));
    const r = await probe(AbortSignal.abort());
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, confidence: 'suspected' });
  });

  it('forwards CLAUDE_CONFIG_DIR into the probe env when present, omits it when absent', async () => {
    const withVar = vi.fn(async () => ({ status: 'ok' as const, output: 'authenticated' }));
    await makeAccountAuthStatusProbe(
      TARGET,
      deps({ probeBinaryAuthStatus: withVar, env: { HOME: '/home/x', PATH: '/usr/bin', USER: 'x', CLAUDE_CONFIG_DIR: '/tmp/cfg/.claude' } }),
    )(liveSignal());
    expect(withVar).toHaveBeenCalledWith(
      'claude',
      ['auth', 'status', '--json'],
      expect.objectContaining({ CLAUDE_CONFIG_DIR: '/tmp/cfg/.claude' }),
    );

    const withoutVar = vi.fn(async () => ({ status: 'ok' as const, output: 'authenticated' }));
    await makeAccountAuthStatusProbe(
      TARGET,
      deps({ probeBinaryAuthStatus: withoutVar, env: { HOME: '/home/x', PATH: '/usr/bin', USER: 'x' } }),
    )(liveSignal());
    expect(withoutVar).toHaveBeenCalledWith(
      'claude',
      ['auth', 'status', '--json'],
      expect.not.objectContaining({ CLAUDE_CONFIG_DIR: expect.anything() }),
    );
  });

  it('never leaks raw probe output (which may carry tokens) into the summary', async () => {
    // Non-key-shaped sentinel: exercises the leak guard without tripping the
    // repo-hygiene secret-shape scanner on a literal provider key prefix.
    const sentinel = 'REDACT-ME-SENTINEL-9999';
    const probe = makeAccountAuthStatusProbe(
      TARGET,
      deps({ probeBinaryAuthStatus: async () => ({ status: 'ok', output: `logged in marker=${sentinel}` }) }),
    );
    const r = await probe(liveSignal());
    expect(r.summary).not.toContain(sentinel);
    expect(JSON.stringify(r.data ?? {})).not.toContain(sentinel);
  });
});
