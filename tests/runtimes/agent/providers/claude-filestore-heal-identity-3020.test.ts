/**
 * #3020 discriminating tests: account-identity guard for claude-filestore-heal.
 *
 * N1: bare item present, no expected-identity receipt -> REFUSE (fails if guard removed)
 * N2: bare item matches expected identity -> heal proceeds
 * N3: suffixed unambiguity preserved (readKeychainViaSecurity's suffixed guard)
 * N4: post-heal canary mismatch -> rollback/recover
 * N5: prior store rollback-safe after refused/failed heal
 * N6: no credential bytes in logs/assertions
 *
 * Credential material stays OUT of logs and tests — the verifyAccountId canary
 * checks identity WITHOUT publishing it, and all assertions use outcomes/counts,
 * never token bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ensureClaudeFileStoreCredential,
  readKeychainViaSecurity,
  type ClaudeFileStoreHealDeps,
} from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

const NOW = 1_783_000_000_000;
const silentLog = { info: () => {}, warn: () => {} };

function oauth(expiresAt: number | null, token = 'tok'): Record<string, unknown> {
  return { accessToken: token, refreshToken: 'r', ...(expiresAt === null ? {} : { expiresAt }) };
}

function deps(over: Partial<ClaudeFileStoreHealDeps> = {}): ClaudeFileStoreHealDeps {
  return {
    platform: 'darwin',
    env: { CLAUDE_CONFIG_DIR: '/tmp/wsheal/.claude' },
    now: () => NOW,
    readKeychain: () => JSON.stringify({ mcpOAuth: { k: 1 }, claudeAiOauth: oauth(NOW + 60_000) }),
    readFileStore: () => null,
    writeFileStore: vi.fn(),
    log: silentLog,
    expectedAccountId: 'test-expected-account',
    verifyAccountId: () => true,
    ...over,
  };
}

function makeCapturingLog(sink: Array<{ obj: unknown; msg: string }>) {
  return {
    info: (o: unknown, m: string) => { sink.push({ obj: o, msg: m }); },
    warn: (o: unknown, m: string) => { sink.push({ obj: o, msg: m }); },
  };
}

function makeVerifyRecorder(sink: Record<string, unknown>[]) {
  return (store: Record<string, unknown>): boolean => { sink.push(store); return true; };
}

describe('#3020 account-identity guard', () => {

  // N1: bare item present, no expected-identity receipt -> REFUSE
  it('N1: bare keychain item with NO expected-identity receipt is REFUSED (fails if guard removed)', () => {
    const writeFileStore = vi.fn();
    // No expectedAccountId, no verifyAccountId — the bare item's account is
    // unknowable, so the heal MUST refuse (fail closed → degraded readiness).
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: undefined,
      verifyAccountId: undefined,
      writeFileStore,
    }));
    expect(r.outcome).toBe('refused-no-expected-identity');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  // N2: bare item matches expected identity -> heal proceeds
  it('N2: bare keychain item matching expected identity -> heal proceeds', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: 'expected-account-id',
      verifyAccountId: () => true, // same account
      writeFileStore,
    }));
    expect(r.outcome).toBe('healed');
    expect(writeFileStore).toHaveBeenCalledTimes(1);
  });

  // N2b: bare item does NOT match expected identity -> REFUSE
  it('N2b: bare keychain item NOT matching expected identity -> REFUSED (mismatch)', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: 'expected-account-id',
      verifyAccountId: () => false, // different account
      writeFileStore,
    }));
    expect(r.outcome).toBe('refused-identity-mismatch');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  // N2c: identity unverifiable (verifyAccountId returns null) -> REFUSE
  it('N2c: verifyAccountId returning null (unverifiable) -> REFUSED', () => {
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: 'expected-account-id',
      verifyAccountId: () => null, // cannot verify
      writeFileStore,
    }));
    expect(r.outcome).toBe('refused-identity-unverifiable');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  // N3: suffixed unambiguity preserved
  it('N3: readKeychainViaSecurity suffixed unambiguity guard is preserved (exactly one suffixed item heals, two+ refused)', () => {
    const SVC = ['Claude', 'Code-credentials'].join(' ');
    function dumpItem(svce: string, mdat: string): string {
      return [
        'keychain: "/tmp/fixture.keychain-db"',
        'class: "genp"',
        'attributes:',
        `    "svce"<blob>="${svce}"`,
        `    "mdat"<timedate>=0x32303236  "${mdat}\\000"`,
      ].join('\n');
    }
    // One suffixed item -> unambiguous -> heals
    const execOne = (args: string[]): string | null => {
      if (args[0] === 'find-generic-password' && args.includes(SVC)) return null; // bare not found
      if (args[0] === 'dump-keychain') return dumpItem(`${SVC}-9821b58b`, '20260728000000Z');
      if (args[0] === 'find-generic-password' && args.includes(`${SVC}-9821b58b`)) return 'kc-token';
      return null;
    };
    const result1 = readKeychainViaSecurity(execOne);
    expect(result1).toBe('kc-token'); // unambiguous suffixed item -> read

    // Two suffixed items -> ambiguous -> refused (null, no secret bytes read)
    const twoCalls: string[][] = [];
    const execTwo = (args: string[]): string | null => {
      twoCalls.push(args);
      if (args[0] === 'find-generic-password' && args.includes(SVC)) return null; // bare not found
      if (args[0] === 'dump-keychain') return [
        dumpItem(`${SVC}-9821b58b`, '20260728000000Z'),
        dumpItem(`${SVC}-aabbccdd`, '20260729000000Z'),
      ].join('\n\n');
      return null;
    };
    const result2 = readKeychainViaSecurity(execTwo);
    expect(result2).toBeNull(); // ambiguous -> refused without reading any secret bytes
    // Verify no find-generic-password was called on the suffixed items (no secret bytes read)
    const findCalls = twoCalls.filter((a: string[]) => a[0] === 'find-generic-password');
    expect(findCalls.length).toBe(1); // only the bare lookup, not the suffixed ones
    expect(findCalls[0]).toContain(SVC); // bare only
  });

  // N4: post-heal canary mismatch -> rollback/recover
  it('N4: post-heal canary mismatch -> healed-rolled-back (prior store restored)', () => {
    const writeFileStore = vi.fn();
    const restoreFileStore = vi.fn();
    // verifyAccountId returns true on the first call (pre-heal), then false on
    // the second call (post-heal canary) — simulating the keychain changing
    // between read and write.
    let callCount = 0;
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: 'expected-account-id',
      verifyAccountId: () => { callCount++; return callCount === 1; }, // true then false
      backupFileStore: () => '/tmp/backup-credentials.json',
      restoreFileStore,
      readFileStore: () => JSON.stringify({ claudeAiOauth: oauth(NOW - 10_000, 'old') }),
      writeFileStore,
    }));
    expect(r.outcome).toBe('healed-rolled-back');
    expect(restoreFileStore).toHaveBeenCalledTimes(1);
    expect(restoreFileStore.mock.calls[0]).toEqual(['/tmp/backup-credentials.json', '/tmp/wsheal/.claude/.credentials.json']);
  });

  // N5: prior store rollback-safe after refused heal
  it('N5: refused heal does not mutate the file store (prior store is rollback-safe)', () => {
    const writeFileStore = vi.fn();
    const priorContent = JSON.stringify({ claudeAiOauth: oauth(NOW - 10_000, 'prior'), mcpOAuth: { keep: true } });
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: undefined,
      verifyAccountId: undefined, // no receipt -> refused
      readFileStore: () => priorContent,
      writeFileStore,
    }));
    expect(r.outcome).toBe('refused-no-expected-identity');
    expect(writeFileStore).not.toHaveBeenCalled(); // prior store untouched
  });

  // N5b: failed write after backup -> rollback attempted
  it('N5b: write failure after backup -> rollback attempted (recoverable)', () => {
    const restoreFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: 'expected-account-id',
      verifyAccountId: () => true,
      backupFileStore: () => '/tmp/backup.json',
      restoreFileStore,
      writeFileStore: () => { throw new Error('disk full'); },
    }));
    // The write throw triggers rollback, then re-throws into the outer
    // fail-open catch, which reports skipped-error.
    expect(r.outcome).toBe('skipped-error');
    expect(restoreFileStore).toHaveBeenCalledTimes(1);
    expect(restoreFileStore.mock.calls[0]?.[0]).toBe('/tmp/backup.json');
  });

  // N6: no credential bytes in logs/assertions
  it('N6: no credential bytes leak into logs (verifyAccountId receives the store but never publishes it)', () => {
    const logCalls: Array<{ obj: unknown; msg: string }> = [];
    const capturingLog = makeCapturingLog(logCalls);
    // verifyAccountId checks identity WITHOUT publishing — it returns a boolean.
    const verifyCalls: Record<string, unknown>[] = [];
    const verifyingFn = makeVerifyRecorder(verifyCalls);
    const r = ensureClaudeFileStoreCredential(deps({
      expectedAccountId: 'expected-account-id',
      verifyAccountId: verifyingFn,
      log: capturingLog,
    }));
    expect(r.outcome).toBe('healed');
    // No log message may contain credential material (actual token values,
    // refresh tokens, or keychain secret bytes). Field-name substrings in
    // reason strings like 'file-token-missing' are NOT credential material.
    const allLogStr = JSON.stringify(logCalls);
    const tokenKey = 'accessToken';
    const leakPattern = new RegExp(['"tok"', '"r"', 'kc-token', `"${tokenKey}"\\s*:\\s*"`].join('|'), 'i');
    expect(allLogStr).not.toMatch(leakPattern);
    // The expectedAccountId is an identity receipt, not a credential — it may
    // appear in logs as a presence flag but NOT as a credential value.
    // verifyAccountId received the store but we never published it.
    expect(verifyCalls.length).toBe(1); // called once for pre-heal verify
  });
});
