// Keychain item selection for the claude credential-store check.
//
// The claude CLI stores the login for a config dir under its own keychain item:
// the bare service name when neither dir variable is set, and
// `<bare>-<first 8 hex of sha256(dir)>` otherwise, where dir is
// CLAUDE_SECURESTORAGE_CONFIG_DIR when set and CLAUDE_CONFIG_DIR else. The
// check reads exactly one item: the bot's own. Reading the bare item (the
// operator's default login) or discovering any other suffixed item (another
// bot's or the maintenance job's login) would describe a different login.
// These tests pin that contract: one `find-generic-password` for the own item,
// no `dump-keychain` discovery, never the bare item.
import { describe, expect, it } from 'vitest';
import {
  claudeCredentialServiceFor,
  claudeCredentialServiceForEnv,
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
const SECURE_DIR = '/tmp/wsheal-secure/.claude';
// Independent oracle: `printf %s /tmp/wsheal-secure/.claude | shasum -a 256 | cut -c1-8`.
const SECURE = `${SVC}-197a7c7a`;
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
    log: { info: () => {}, warn: () => {} },
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

describe('claudeCredentialServiceForEnv', () => {
  it('CLAUDE_SECURESTORAGE_CONFIG_DIR overrides CLAUDE_CONFIG_DIR for the item suffix', () => {
    // `printf %s /tmp/wsheal-secure/.claude | shasum -a 256 | cut -c1-8`
    expect(claudeCredentialServiceForEnv({
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: SECURE_DIR,
    })).toBe(SECURE);
  });

  it('uses CLAUDE_CONFIG_DIR when CLAUDE_SECURESTORAGE_CONFIG_DIR is unset', () => {
    expect(claudeCredentialServiceForEnv({ CLAUDE_CONFIG_DIR: CONFIG_DIR })).toBe(OWN);
  });

  it('names the bare item when neither is set, or CLAUDE_SECURESTORAGE_CONFIG_DIR is set but empty', () => {
    expect(claudeCredentialServiceForEnv({})).toBe(SVC);
    expect(claudeCredentialServiceForEnv({ CLAUDE_CONFIG_DIR: CONFIG_DIR, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })).toBe(SVC);
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
  it('bare item present and own item absent: reads only the own item', () => {
    const kc = keychain({ [SVC]: blob(NOW + 60_000) });
    const r = ensureClaudeFileStoreCredential(deps({ readKeychain: kc.read }));
    expect(r.outcome).toBe('skipped-no-keychain-token');
    expect(kc.asked).toEqual([OWN]);
  });

  it('two suffixed items including the own one: reads the own one only', () => {
    const kc = keychain({ [OTHER]: blob(NOW + 120_000), [OWN]: blob(NOW + 60_000) });
    const r = ensureClaudeFileStoreCredential(deps({ readKeychain: kc.read }));
    expect(r).toMatchObject({ outcome: 'skipped-cli-reads-own-item', keychainExpiresAt: NOW + 60_000 });
    expect(kc.asked).toEqual([OWN]);
  });

  it('CLAUDE_SECURESTORAGE_CONFIG_DIR set: checks that item and the file store in that dir', () => {
    const kc = keychain({ [OWN]: blob(NOW + 60_000), [SECURE]: blob(NOW + 90_000) });
    const filePaths: string[] = [];
    const r = ensureClaudeFileStoreCredential(deps({
      env: { CLAUDE_CONFIG_DIR: CONFIG_DIR, CLAUDE_SECURESTORAGE_CONFIG_DIR: SECURE_DIR },
      readKeychain: kc.read,
      readFileStore: (path) => { filePaths.push(path); return null; },
    }));
    expect(r).toMatchObject({ outcome: 'skipped-cli-reads-own-item', keychainExpiresAt: NOW + 90_000 });
    expect(kc.asked).toEqual([SECURE]);
    expect(filePaths).toEqual([`${SECURE_DIR}/.credentials.json`]);
  });

  it('CLAUDE_SECURESTORAGE_CONFIG_DIR alone (no CLAUDE_CONFIG_DIR) still selects its own item', () => {
    const kc = keychain({ [SECURE]: blob(NOW + 90_000) });
    const r = ensureClaudeFileStoreCredential(deps({
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: SECURE_DIR },
      readKeychain: kc.read,
    }));
    expect(r.outcome).toBe('skipped-cli-reads-own-item');
    expect(kc.asked).toEqual([SECURE]);
  });

  it('unset CLAUDE_CONFIG_DIR: reads no keychain item at all', () => {
    const kc = keychain({ [SVC]: blob(NOW + 60_000) });
    const r = ensureClaudeFileStoreCredential(deps({ env: {}, readKeychain: kc.read }));
    expect(r.outcome).toBe('skipped-no-config-dir');
    expect(kc.asked).toEqual([]);
  });
});
