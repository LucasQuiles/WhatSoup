/**
 * Ratified-row identity verification (task-21, req-03 verify-only basis).
 *
 * The observed identity is what the claude CLI reports through
 * `claude auth status --json` in the bot's own scrubbed spawn env; the only
 * thing that leaves the parser is an opaque digest. Every non-match branch
 * is a distinct, fail-closed class; nothing here can write a credential
 * (the module has no write seam — asserted by the spawn recorder: the ONLY
 * child ever spawned is the read-only auth-status probe).
 *
 * Negative matrix: mismatch, not logged in, identity fields missing,
 * unparseable output, non-object JSON, binary missing, probe failed, probe
 * threw, expectation absent (disabled), stale receipt, never verified.
 */
import { describe, expect, it } from 'vitest';
import { computeAccountIdentityDigest } from '../../../../src/lib/account-identity-digest.ts';
import {
  accountIdentityDegradedReasons,
  deriveAccountIdentityHealth,
  parseClaudeAuthStatusIdentity,
  verifyClaudeAccountIdentity,
  type AccountIdentityVerification,
  type ClaudeAccountIdentityDeps,
} from '../../../../src/runtimes/agent/providers/claude-account-identity.ts';

const NOW = 1_790_000_000_000;
const EMAIL = 'owner.example@example.test';
const ORG_ID = '0f0e0d0c-0b0a-4998-8776-655443322110';
const OTHER_ORG_ID = '11111111-2222-4333-8444-555555555555';
const EXPECTED = computeAccountIdentityDigest({ email: EMAIL, orgId: ORG_ID });

function authStatusJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    analyticsDisabled: false,
    projectsDirectory: '/srv/fixture/claude-projects',
    email: EMAIL,
    orgId: ORG_ID,
    orgName: "Owner's Organization",
    subscriptionType: 'max',
    ...over,
  });
}

interface SpawnRecord { binary: string; args: string[]; env: NodeJS.ProcessEnv }

function deps(over: Partial<ClaudeAccountIdentityDeps> & { output?: string; status?: 'ok' | 'failed' } = {}): {
  deps: ClaudeAccountIdentityDeps;
  spawns: SpawnRecord[];
} {
  const spawns: SpawnRecord[] = [];
  const { output = authStatusJson(), status = 'ok', ...rest } = over;
  return {
    spawns,
    deps: {
      getProviderBinary: () => '/opt/bin/claude',
      probeBinaryCommand: async (binary, args, env) => {
        spawns.push({ binary, args, env });
        return { status, output };
      },
      env: { HOME: '/fixture/home', PATH: '/opt/bin', USER: 'owner', CLAUDE_CONFIG_DIR: '/fixture/home/.claude-phbot', SECRET_TOKEN: 'never-forwarded' },
      now: () => NOW,
      ...rest,
    },
  };
}

function assertNoRawIdentity(value: unknown): void {
  const serialized = JSON.stringify(value).toLowerCase();
  expect(serialized).not.toContain(EMAIL.toLowerCase());
  expect(serialized).not.toContain(ORG_ID.toLowerCase());
  expect(serialized).not.toContain(OTHER_ORG_ID.toLowerCase());
  expect(serialized).not.toContain('example.test');
  expect(serialized).not.toContain("owner's organization");
}

describe('parseClaudeAuthStatusIdentity — the only thing that leaves the parser is a digest', () => {
  it('digests a logged-in status with both identity fields', () => {
    const observed = parseClaudeAuthStatusIdentity(authStatusJson());
    expect(observed).toEqual({ kind: 'identity', digest: EXPECTED });
    assertNoRawIdentity(observed);
  });

  it('tolerates a leading/trailing non-JSON line around the JSON object', () => {
    const observed = parseClaudeAuthStatusIdentity(`warning: something\n${authStatusJson()}\n`);
    expect(observed).toEqual({ kind: 'identity', digest: EXPECTED });
  });

  it('reports not-logged-in as absent, never as an identity', () => {
    expect(parseClaudeAuthStatusIdentity(JSON.stringify({ loggedIn: false })))
      .toEqual({ kind: 'absent', reason: 'not-logged-in' });
    // loggedIn:false with stale identity fields still present is NOT an identity
    expect(parseClaudeAuthStatusIdentity(authStatusJson({ loggedIn: false })))
      .toEqual({ kind: 'absent', reason: 'not-logged-in' });
  });

  it('reports missing, empty, or non-string identity fields as absent', () => {
    for (const over of [
      { email: undefined },
      { orgId: undefined },
      { email: '' },
      { orgId: '   ' },
      { email: 42 },
      { orgId: null },
      { loggedIn: undefined },
      { loggedIn: 'yes' },
    ]) {
      expect(parseClaudeAuthStatusIdentity(authStatusJson(over)), JSON.stringify(over))
        .toEqual({ kind: 'absent', reason: 'identity-fields-missing' });
    }
  });

  it('reports non-JSON, non-object JSON, and empty output as unparseable', () => {
    for (const output of ['', '   ', 'Not logged in', '[]', '"string"', '42', 'null', '{"loggedIn": tru']) {
      expect(parseClaudeAuthStatusIdentity(output), JSON.stringify(output)).toEqual({ kind: 'unparseable' });
    }
  });
});

describe('verifyClaudeAccountIdentity — outcome classes', () => {
  it('disabled: no expectation configured -> no spawn at all', async () => {
    const d = deps();
    const result = await verifyClaudeAccountIdentity(null, d.deps);
    expect(result).toMatchObject({ status: 'disabled', reason: null, expectedDigestPrefix: null, observedDigestPrefix: null, checkedAt: NOW });
    expect(d.spawns).toHaveLength(0);
  });

  it('match: observed digest equals the ratified digest', async () => {
    const d = deps();
    const result = await verifyClaudeAccountIdentity(EXPECTED, d.deps);
    expect(result).toMatchObject({ status: 'match', reason: null, checkedAt: NOW });
    expect(result.expectedDigestPrefix).toHaveLength(12);
    expect(result.observedDigestPrefix).toBe(result.expectedDigestPrefix);
    assertNoRawIdentity(result);
  });

  it('spawns exactly one read-only `auth status --json` probe with the scrubbed allow-list env', async () => {
    const d = deps();
    await verifyClaudeAccountIdentity(EXPECTED, d.deps);
    expect(d.spawns).toHaveLength(1);
    expect(d.spawns[0]).toMatchObject({ binary: '/opt/bin/claude', args: ['auth', 'status', '--json'] });
    expect(d.spawns[0]!.env).toEqual({
      HOME: '/fixture/home',
      PATH: '/opt/bin',
      USER: 'owner',
      NO_COLOR: '1',
      CLAUDE_CONFIG_DIR: '/fixture/home/.claude-phbot',
    });
    expect(Object.keys(d.spawns[0]!.env)).not.toContain('SECRET_TOKEN');
  });

  it('mismatch: a different account (or the same account in another org) never matches', async () => {
    const otherOrg = deps({ output: authStatusJson({ orgId: OTHER_ORG_ID }) });
    const r1 = await verifyClaudeAccountIdentity(EXPECTED, otherOrg.deps);
    expect(r1).toMatchObject({ status: 'mismatch', reason: null });
    expect(r1.observedDigestPrefix).not.toBe(r1.expectedDigestPrefix);
    assertNoRawIdentity(r1);

    const otherAccount = deps({ output: authStatusJson({ email: 'intruder@example.test' }) });
    const r2 = await verifyClaudeAccountIdentity(EXPECTED, otherAccount.deps);
    expect(r2).toMatchObject({ status: 'mismatch' });
    expect(JSON.stringify(r2)).not.toContain('intruder');
  });

  it('unverifiable: not logged in (even with exit 0)', async () => {
    const d = deps({ output: JSON.stringify({ loggedIn: false }) });
    expect(await verifyClaudeAccountIdentity(EXPECTED, d.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'not-logged-in', observedDigestPrefix: null });
  });

  it('unverifiable: not logged in reported through a non-zero exit is still classified, not masked as probe-failed', async () => {
    const d = deps({ status: 'failed', output: JSON.stringify({ loggedIn: false }) });
    expect(await verifyClaudeAccountIdentity(EXPECTED, d.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'not-logged-in' });
  });

  it('unverifiable: identity fields missing / unparseable output', async () => {
    const missing = deps({ output: authStatusJson({ orgId: undefined }) });
    expect(await verifyClaudeAccountIdentity(EXPECTED, missing.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'identity-fields-missing' });
    const garbage = deps({ output: 'Not logged in · Please run /login' });
    expect(await verifyClaudeAccountIdentity(EXPECTED, garbage.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'unparseable' });
  });

  it('unverifiable: a non-zero exit with matching-looking output is NOT a match (identity requires a clean exit)', async () => {
    const d = deps({ status: 'failed', output: authStatusJson() });
    expect(await verifyClaudeAccountIdentity(EXPECTED, d.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'probe-failed' });
  });

  it('unverifiable: binary missing / resolver throws -> no spawn', async () => {
    const missing = deps({ getProviderBinary: () => null });
    expect(await verifyClaudeAccountIdentity(EXPECTED, missing.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'binary-missing' });
    expect(missing.spawns).toHaveLength(0);
    const throwing = deps({ getProviderBinary: () => { throw new Error('unknown provider'); } });
    expect(await verifyClaudeAccountIdentity(EXPECTED, throwing.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'binary-missing' });
  });

  it('unverifiable: the probe rejecting is contained (never rejects the caller)', async () => {
    const d = deps({ probeBinaryCommand: async () => { throw new Error('spawn exploded'); } });
    expect(await verifyClaudeAccountIdentity(EXPECTED, d.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'probe-threw' });
  });

  it('a malformed expectation never matches (fail closed on the ratified side too)', async () => {
    const d = deps();
    expect(await verifyClaudeAccountIdentity('owner@example.test', d.deps))
      .toMatchObject({ status: 'unverifiable', reason: 'expectation-malformed' });
    expect(d.spawns).toHaveLength(0);
  });
});

describe('deriveAccountIdentityHealth — freshness and pending', () => {
  const FRESH = 35 * 60_000;
  const verification = (over: Partial<AccountIdentityVerification>): AccountIdentityVerification => ({
    status: 'match',
    reason: null,
    expectedDigestPrefix: 'abcdefabcdef',
    observedDigestPrefix: 'abcdefabcdef',
    checkedAt: NOW,
    ...over,
  });

  it('disabled when no expectation is configured, whatever the last verification says', () => {
    const health = deriveAccountIdentityHealth({
      expectedConfigured: false,
      verification: verification({ status: 'mismatch' }),
      armedAtMs: NOW,
      nowMs: NOW,
      freshnessMs: FRESH,
    });
    expect(health).toMatchObject({ status: 'disabled', reason: null, stale: false });
    expect(accountIdentityDegradedReasons(health)).toEqual([]);
  });

  it('pending before the first verification completes (no reason yet), never-verified once the window elapses', () => {
    const pending = deriveAccountIdentityHealth({
      expectedConfigured: true, verification: null, armedAtMs: NOW, nowMs: NOW + 1_000, freshnessMs: FRESH,
    });
    expect(pending).toMatchObject({ status: 'pending', reason: null, stale: false });
    expect(accountIdentityDegradedReasons(pending)).toEqual([]);

    const overdue = deriveAccountIdentityHealth({
      expectedConfigured: true, verification: null, armedAtMs: NOW, nowMs: NOW + FRESH + 1, freshnessMs: FRESH,
    });
    expect(overdue).toMatchObject({ status: 'unverifiable', reason: 'never-verified', stale: true });
    expect(accountIdentityDegradedReasons(overdue)).toEqual(['credential_identity_unverifiable']);
  });

  it('a fresh match is quiet; a stale match is NOT a match (stale-receipt)', () => {
    const fresh = deriveAccountIdentityHealth({
      expectedConfigured: true, verification: verification({}), armedAtMs: NOW - 1, nowMs: NOW + FRESH, freshnessMs: FRESH,
    });
    expect(fresh).toMatchObject({ status: 'match', reason: null, stale: false, checkedAt: NOW });
    expect(accountIdentityDegradedReasons(fresh)).toEqual([]);

    const stale = deriveAccountIdentityHealth({
      expectedConfigured: true, verification: verification({}), armedAtMs: NOW - 1, nowMs: NOW + FRESH + 1, freshnessMs: FRESH,
    });
    expect(stale).toMatchObject({ status: 'unverifiable', reason: 'stale-receipt', stale: true });
    expect(accountIdentityDegradedReasons(stale)).toEqual(['credential_identity_unverifiable']);
  });

  it('mismatch degrades (and stays a mismatch even when stale — never downgraded to unknown)', () => {
    const mismatch = verification({ status: 'mismatch', observedDigestPrefix: '000000000000' });
    const fresh = deriveAccountIdentityHealth({
      expectedConfigured: true, verification: mismatch, armedAtMs: NOW - 1, nowMs: NOW, freshnessMs: FRESH,
    });
    expect(fresh).toMatchObject({ status: 'mismatch', stale: false });
    expect(accountIdentityDegradedReasons(fresh)).toEqual(['credential_identity_mismatch']);
    const stale = deriveAccountIdentityHealth({
      expectedConfigured: true, verification: mismatch, armedAtMs: NOW - 1, nowMs: NOW + FRESH + 1, freshnessMs: FRESH,
    });
    expect(stale).toMatchObject({ status: 'mismatch', stale: true });
    expect(accountIdentityDegradedReasons(stale)).toEqual(['credential_identity_mismatch']);
  });

  it('unverifiable carries its reason through', () => {
    const health = deriveAccountIdentityHealth({
      expectedConfigured: true,
      verification: verification({ status: 'unverifiable', reason: 'not-logged-in', observedDigestPrefix: null }),
      armedAtMs: NOW - 1, nowMs: NOW, freshnessMs: FRESH,
    });
    expect(health).toMatchObject({ status: 'unverifiable', reason: 'not-logged-in', stale: false });
    expect(accountIdentityDegradedReasons(health)).toEqual(['credential_identity_unverifiable']);
  });

  it('never publishes anything but status classes and digest prefixes', () => {
    const health = deriveAccountIdentityHealth({
      expectedConfigured: true, verification: verification({}), armedAtMs: NOW - 1, nowMs: NOW, freshnessMs: FRESH,
    });
    expect(Object.keys(health).sort()).toEqual(
      ['checkedAt', 'expectedDigestPrefix', 'observedDigestPrefix', 'reason', 'stale', 'status'],
    );
    assertNoRawIdentity(health);
  });
});

describe('verifyClaudeAccountIdentity — no raw identity ever reaches a log or a result', () => {
  it('the result object carries digest prefixes only, across every branch', async () => {
    const outputs = [
      authStatusJson(),
      authStatusJson({ orgId: OTHER_ORG_ID }),
      authStatusJson({ loggedIn: false }),
      authStatusJson({ orgId: undefined }),
      `garbage ${EMAIL} ${ORG_ID}`,
    ];
    for (const output of outputs) {
      const d = deps({ output });
      const result = await verifyClaudeAccountIdentity(EXPECTED, d.deps);
      assertNoRawIdentity(result);
      expect(result.observedDigestPrefix === null || result.observedDigestPrefix.length === 12).toBe(true);
    }
  });
});

describe('verifyClaudeAccountIdentity — req-03: zero credential writes on every branch', () => {
  it('leaves a real CLAUDE_CONFIG_DIR fixture byte-identical and spawns nothing but the read-only auth-status probe', async () => {
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-identity-nowrite-'));
    const storePath = join(root, '.credentials.json');
    const fixture = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', expiresAt: NOW + 60_000 } });
    writeFileSync(storePath, fixture, { mode: 0o600 });
    const snapshot = () => ({
      entries: readdirSync(root).sort(),
      bytes: readFileSync(storePath, 'utf8'),
      mtimeMs: statSync(storePath).mtimeMs,
    });
    const before = snapshot();

    const branches: Array<{ output: string; status: 'ok' | 'failed' }> = [
      { output: authStatusJson(), status: 'ok' },
      { output: authStatusJson({ orgId: OTHER_ORG_ID }), status: 'ok' },
      { output: JSON.stringify({ loggedIn: false }), status: 'ok' },
      { output: JSON.stringify({ loggedIn: false }), status: 'failed' },
      { output: authStatusJson({ email: undefined }), status: 'ok' },
      { output: 'Not logged in', status: 'failed' },
      { output: '', status: 'failed' },
    ];
    const statuses: string[] = [];
    for (const branch of branches) {
      const d = deps({ ...branch, env: { HOME: root, PATH: '/opt/bin', USER: 'owner', CLAUDE_CONFIG_DIR: root } });
      statuses.push((await verifyClaudeAccountIdentity(EXPECTED, d.deps)).status);
      expect(d.spawns.map((s) => s.args.join(' '))).toEqual(['auth status --json']);
    }
    expect(statuses).toEqual(['match', 'mismatch', 'unverifiable', 'unverifiable', 'unverifiable', 'unverifiable', 'unverifiable']);
    expect(snapshot()).toEqual(before);
  });
});
