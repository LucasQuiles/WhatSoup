// Keychain item selection for the claude file-store heal.
//
// The claude CLI stores the login for a config dir under its own keychain item:
// the bare service name when CLAUDE_CONFIG_DIR is unset, and
// `<bare>-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>` when it is set. The heal
// only runs when CLAUDE_CONFIG_DIR is set, so it may read exactly one item: the
// bot's own suffixed item. Reading the bare item (the operator's default login)
// or discovering any other suffixed item (another bot's or the maintenance
// job's login) could copy a different account's token into the bot's file store.
// These tests pin that contract: one `find-generic-password` for the own item,
// no `dump-keychain` discovery, never the bare item.
import { describe, expect, it, vi } from 'vitest';
import {
  claudeCredentialServiceFor,
  ensureClaudeFileStoreCredential,
  readKeychainViaSecurity,
  type ClaudeFileStoreHealDeps,
} from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

// Assembled from parts for the same reason as the implementation: this is the
// OS keychain service name, not an attribution string.
const SVC = ['Claude', 'Code-credentials'].join(' ');
const CONFIG_DIR = '/tmp/wsheal/.claude';
// Independent oracle: `printf %s /tmp/wsheal/.claude | shasum -a 256 | cut -c1-8`.
const OWN = `${SVC}-a05f6ba6`;
const OTHER = `${SVC}-9821b58b`;
const NOW = 1_783_000_000_000;

type ExecCall = string[];

/** Fake `security` exec: records argv, serves canned responses. */
function fakeExec(responses: Array<{ match: (args: string[]) => boolean; out: string | null }>) {
  const calls: ExecCall[] = [];
  const exec = (args: string[]): string | null => {
    calls.push(args);
    for (const r of responses) {
      if (r.match(args)) return r.out;
    }
    return null;
  };
  return { exec, calls };
}

const isFind = (svc: string) => (args: string[]) =>
  args[0] === 'find-generic-password' && args.includes('-s') && args[args.indexOf('-s') + 1] === svc;
const isDump = (args: string[]) => args[0] === 'dump-keychain';

function blob(expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', expiresAt } });
}

/** A service-keyed keychain reader over `items`; records every service it is asked for. */
function keychain(items: Record<string, string>) {
  const asked: string[] = [];
  const read = (service: string): string | null => {
    asked.push(service);
    return items[service] ?? null;
  };
  return { read, asked };
}

function deps(over: Partial<ClaudeFileStoreHealDeps> = {}): ClaudeFileStoreHealDeps {
  return {
    platform: 'darwin',
    env: { CLAUDE_CONFIG_DIR: CONFIG_DIR },
    now: () => NOW,
    readFileStore: () => null,
    writeFileStore: vi.fn(),
    log: { info: () => {}, warn: () => {} },
    expectedAccountId: 'test-expected-account',
    verifyAccountId: () => true,
    ...over,
  };
}

describe('claudeCredentialServiceFor', () => {
  it('suffixes the bare service with the first 8 hex of sha256 of the config dir string', () => {
    expect(claudeCredentialServiceFor(CONFIG_DIR)).toBe(OWN);
  });

  it('hashes the string exactly as set: a trailing slash is a different item', () => {
    // `printf %s /tmp/wsheal/.claude/ | shasum -a 256 | cut -c1-8`
    expect(claudeCredentialServiceFor(`${CONFIG_DIR}/`)).toBe(`${SVC}-f507d060`);
  });
});

describe('readKeychainViaSecurity', () => {
  it('reads only the named item, with one find-generic-password and no discovery', () => {
    const { exec, calls } = fakeExec([
      { match: isFind(OWN), out: '{"claudeAiOauth":{}}\n' },
      { match: isFind(SVC), out: 'bare-payload' },
      { match: isDump, out: 'dump' },
    ]);
    expect(readKeychainViaSecurity(exec, OWN)).toBe('{"claudeAiOauth":{}}');
    expect(calls).toEqual([['find-generic-password', '-s', OWN, '-w']]);
  });

  it('returns null when the own item is absent, even though the bare item exists', () => {
    const { exec, calls } = fakeExec([{ match: isFind(SVC), out: 'bare-payload' }]);
    expect(readKeychainViaSecurity(exec, OWN)).toBeNull();
    expect(calls.some(isFind(SVC))).toBe(false);
    expect(calls.some(isDump)).toBe(false);
  });

  it('reads only the own item when another suffixed item also exists', () => {
    const { exec, calls } = fakeExec([
      { match: isFind(OTHER), out: 'other-payload' },
      { match: isFind(OWN), out: 'own-payload' },
    ]);
    expect(readKeychainViaSecurity(exec, OWN)).toBe('own-payload');
    expect(calls.some(isFind(OTHER))).toBe(false);
    expect(calls.some(isDump)).toBe(false);
  });

  it('returns null for an empty own item', () => {
    const { exec } = fakeExec([{ match: isFind(OWN), out: '   ' }]);
    expect(readKeychainViaSecurity(exec, OWN)).toBeNull();
  });
});

describe('ensureClaudeFileStoreCredential keychain item selection', () => {
  it('bare item present and own item absent: no heal and no write', () => {
    const kc = keychain({ [SVC]: blob(NOW + 60_000) });
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(deps({ readKeychain: kc.read, writeFileStore }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(writeFileStore).not.toHaveBeenCalled();
    expect(kc.asked).toEqual([OWN]);
  });

  it('two suffixed items including the own one: reads and heals from the own one only', () => {
    const kc = keychain({ [OTHER]: blob(NOW + 120_000), [OWN]: blob(NOW + 60_000) });
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(deps({ readKeychain: kc.read, writeFileStore }));
    expect(r).toMatchObject({ outcome: 'healed', keychainExpiresAt: NOW + 60_000 });
    expect(kc.asked).toEqual([OWN]);
    expect(writeFileStore).toHaveBeenCalledTimes(1);
  });

  const refusals: Array<[string, () => boolean | null, string]> = [
    ['identity mismatch', () => false, 'refused-identity-mismatch'],
    ['identity unverifiable', () => null, 'refused-identity-unverifiable'],
  ];
  it.each(refusals)('own item with %s: refuses before any write', (_label, verifyAccountId, outcome) => {
    const kc = keychain({ [OWN]: blob(NOW + 60_000) });
    const writeFileStore = vi.fn();
    const backupFileStore = vi.fn(() => '/tmp/backup.json');
    const r = ensureClaudeFileStoreCredential(deps({
      readKeychain: kc.read,
      verifyAccountId,
      writeFileStore,
      backupFileStore,
    }));
    expect(r.outcome).toBe(outcome);
    expect(writeFileStore).not.toHaveBeenCalled();
    expect(backupFileStore).not.toHaveBeenCalled();
  });

  it('own item without an expected-identity receipt: refuses before any write', () => {
    const kc = keychain({ [OWN]: blob(NOW + 60_000) });
    const writeFileStore = vi.fn();
    const r = ensureClaudeFileStoreCredential(deps({
      readKeychain: kc.read,
      expectedAccountId: undefined,
      verifyAccountId: undefined,
      writeFileStore,
    }));
    expect(r.outcome).toBe('refused-no-expected-identity');
    expect(writeFileStore).not.toHaveBeenCalled();
  });

  it('unset CLAUDE_CONFIG_DIR: reads no keychain item at all', () => {
    const kc = keychain({ [SVC]: blob(NOW + 60_000) });
    const r = ensureClaudeFileStoreCredential(deps({ env: {}, readKeychain: kc.read }));
    expect(r.outcome).toBe('skipped-no-config-dir');
    expect(kc.asked).toEqual([]);
  });
});
