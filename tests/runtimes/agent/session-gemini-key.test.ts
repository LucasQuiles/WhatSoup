/**
 * buildChildEnv — gemini-cli credential resolution (#2192 slice 1).
 *
 * The gemini-cli case previously forwarded GEMINI_API_KEY / GOOGLE_API_KEY via
 * raw process.env reads — the only secret env reads outside the keyring-aware
 * resolver path. Like its claude-cli/codex-cli siblings it must resolve
 * through resolveApiKey: keyring first (service 'google'), env var as the
 * observable fallback, nothing forwarded when neither is configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { keyringValue } = vi.hoisted(() => ({ keyringValue: { current: null as string | null } }));

vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => keyringValue.current),
}));

import { buildChildEnv } from '../../../src/runtimes/agent/session.ts';

describe('buildChildEnv — gemini-cli key resolution (#2192)', () => {
  beforeEach(() => {
    keyringValue.current = null;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  it('resolves both vars from the keyring google service when present', () => {
    keyringValue.current = 'keyring-google-key';
    const env = buildChildEnv('gemini-cli');
    expect(env).toMatchObject({
      GEMINI_API_KEY: 'keyring-google-key',
      GOOGLE_API_KEY: 'keyring-google-key',
    });
  });

  it('falls back to the respective env vars on keyring miss', () => {
    process.env.GEMINI_API_KEY = 'env-gemini-key';
    process.env.GOOGLE_API_KEY = 'env-google-key';
    const env = buildChildEnv('gemini-cli');
    expect(env).toMatchObject({
      GEMINI_API_KEY: 'env-gemini-key',
      GOOGLE_API_KEY: 'env-google-key',
    });
  });

  it('forwards nothing when neither keyring nor env is configured', () => {
    const env = buildChildEnv('gemini-cli');
    expect(Object.keys(env).filter((k) => k.includes('API_KEY'))).toEqual([]);
  });
});
