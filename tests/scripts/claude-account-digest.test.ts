/**
 * `npm run claude-account-digest` — the operator capture step for the
 * ratified account identity. It runs the SAME read-only CLI probe and the
 * SAME canonicalization as the runtime verifier, and prints exactly one
 * line: the opaque digest. A raw identifier never reaches stdout or stderr,
 * so the command is safe to run into a shared terminal log.
 */
import { describe, expect, it, vi } from 'vitest';
import { computeAccountIdentityDigest } from '../../src/lib/account-identity-digest.ts';
import { ACCOUNT_IDENTITY_PROBE_TIMEOUT_MS } from '../../src/runtimes/agent/providers/claude-account-identity.ts';
import {
  parseClaudeAccountDigestArgs,
  runClaudeAccountDigest,
  type ClaudeAccountDigestDependencies,
} from '../../scripts/claude-account-digest.ts';

const EMAIL = 'owner.example@example.test';
const ORG_ID = '0f0e0d0c-0b0a-4998-8776-655443322110';
const DIGEST = computeAccountIdentityDigest({ email: EMAIL, orgId: ORG_ID });

function authStatusJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ loggedIn: true, email: EMAIL, orgId: ORG_ID, orgName: 'Owner Org', subscriptionType: 'max', ...over });
}

function deps(over: Partial<ClaudeAccountDigestDependencies> & { output?: string; status?: 'ok' | 'failed' } = {}) {
  const { output = authStatusJson(), status = 'ok', ...rest } = over;
  const stdout = vi.fn<(line: string) => void>();
  const stderr = vi.fn<(line: string) => void>();
  const probes: Array<{ binary: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const d: ClaudeAccountDigestDependencies = {
    getProviderBinary: () => '/opt/bin/claude',
    probe: async (binary, args, env) => { probes.push({ binary, args, env }); return { status, output }; },
    env: { HOME: '/srv/fixture', PATH: '/opt/bin', USER: 'owner', CLAUDE_CONFIG_DIR: '/srv/fixture/claude-phbot', SECRET: 'never' },
    stdout,
    stderr,
    ...rest,
  };
  return { d, stdout, stderr, probes };
}

function published(stdout: ReturnType<typeof vi.fn>, stderr: ReturnType<typeof vi.fn>): string {
  return JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls]);
}

describe('parseClaudeAccountDigestArgs', () => {
  it('defaults to the resolved claude binary and accepts --binary once', () => {
    expect(parseClaudeAccountDigestArgs([])).toEqual({ binary: null, help: false });
    expect(parseClaudeAccountDigestArgs(['--binary', '/opt/bin/claude'])).toEqual({ binary: '/opt/bin/claude', help: false });
    expect(parseClaudeAccountDigestArgs(['--help'])).toMatchObject({ help: true });
    expect(() => parseClaudeAccountDigestArgs(['--binary', '/a', '--binary', '/b'])).toThrow('only once');
    expect(() => parseClaudeAccountDigestArgs(['--print-email'])).toThrow(/unknown/i);
  });
});

describe('runClaudeAccountDigest', () => {
  it('prints exactly the digest the runtime verifier would compute, and nothing else', async () => {
    const { d, stdout, stderr } = deps();
    await expect(runClaudeAccountDigest([], d)).resolves.toBe(0);
    expect(stdout.mock.calls).toEqual([[DIGEST]]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('probes with the runtime\'s read-only auth-status args and scrubbed env (config root from the operator shell)', async () => {
    const { d, probes } = deps();
    await runClaudeAccountDigest([], d);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ binary: '/opt/bin/claude', args: ['auth', 'status', '--json'] });
    expect(probes[0]!.env).toEqual({
      HOME: '/srv/fixture',
      PATH: '/opt/bin',
      USER: 'owner',
      NO_COLOR: '1',
      CLAUDE_CONFIG_DIR: '/srv/fixture/claude-phbot',
    });
  });

  it('--binary overrides binary resolution', async () => {
    const { d, probes } = deps({ getProviderBinary: () => null });
    await expect(runClaudeAccountDigest(['--binary', '/custom/claude'], d)).resolves.toBe(0);
    expect(probes[0]!.binary).toBe('/custom/claude');
  });

  it('not logged in -> exit 2 with a bounded message', async () => {
    const { d, stdout, stderr } = deps({ output: JSON.stringify({ loggedIn: false }) });
    await expect(runClaudeAccountDigest([], d)).resolves.toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('\n')).toMatch(/not logged in/i);
  });

  it('identity fields missing or unparseable output -> exit 3, never echoing the output', async () => {
    const missing = deps({ output: authStatusJson({ orgId: undefined }) });
    await expect(runClaudeAccountDigest([], missing.d)).resolves.toBe(3);
    expect(missing.stderr.mock.calls.flat().join('\n')).toMatch(/identity fields missing/i);

    const garbage = deps({ output: `garbage ${EMAIL} ${ORG_ID}` });
    await expect(runClaudeAccountDigest([], garbage.d)).resolves.toBe(3);
    expect(garbage.stderr.mock.calls.flat().join('\n')).toMatch(/unparseable/i);
    expect(published(garbage.stdout, garbage.stderr)).not.toContain(EMAIL);
    expect(published(garbage.stdout, garbage.stderr)).not.toContain(ORG_ID);
  });

  it('binary missing or probe failure -> exit 4', async () => {
    const missing = deps({ getProviderBinary: () => null });
    await expect(runClaudeAccountDigest([], missing.d)).resolves.toBe(4);
    expect(missing.probes).toHaveLength(0);

    const failed = deps({ status: 'failed', output: authStatusJson() });
    await expect(runClaudeAccountDigest([], failed.d)).resolves.toBe(4);
    expect(failed.stdout).not.toHaveBeenCalled();
  });

  it('--help prints usage and exits 0 without probing', async () => {
    const { d, stdout, probes } = deps();
    await expect(runClaudeAccountDigest(['--help'], d)).resolves.toBe(0);
    expect(stdout.mock.calls.flat().join('\n')).toMatch(/Usage:/);
    expect(probes).toHaveLength(0);
  });

  it('a usage error exits 64', async () => {
    const { d, stderr } = deps();
    await expect(runClaudeAccountDigest(['--nope'], d)).resolves.toBe(64);
    expect(stderr).toHaveBeenCalled();
  });

  it('never prints a raw identifier on any path', async () => {
    for (const output of [authStatusJson(), authStatusJson({ loggedIn: false }), authStatusJson({ email: undefined }), `x ${EMAIL} ${ORG_ID}`]) {
      const { d, stdout, stderr } = deps({ output });
      await runClaudeAccountDigest([], d);
      const text = published(stdout, stderr);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain(ORG_ID);
      expect(text).not.toContain('Owner Org');
    }
  });
  it('bounds the probe with the SAME timeout constant the runtime verifier uses', async () => {
    // The 15s bound used to be two unlinked private constants (PROBE_TIMEOUT_MS
    // here, IDENTITY_PROBE_TIMEOUT_MS in the provider) and nothing asserted
    // either of them. This pins that the capture script and the runtime
    // verifier bound the same probe the same way.
    const seen: unknown[] = [];
    await runClaudeAccountDigest([], {
      getProviderBinary: () => '/opt/bin/claude',
      probe: async (_binary, _args, _env, options) => { seen.push(options); return { status: 'ok', output: authStatusJson() }; },
      env: { HOME: '/srv/fixture', PATH: '/opt/bin' },
      stdout: () => {},
      stderr: () => {},
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ timeoutMs: ACCOUNT_IDENTITY_PROBE_TIMEOUT_MS });
  });
});
