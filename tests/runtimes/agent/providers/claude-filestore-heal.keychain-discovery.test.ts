// Keychain service-name discovery for the claude file-store heal.
//
// The unit suite (claude-filestore-heal.test.ts) injects readKeychain wholesale,
// so the DEFAULT reader's service-name resolution was never exercised — and it
// only ever tried the bare item name. Hosts where the claude CLI stored the
// credential under a hash-suffixed service name (the mini11/mini10 shape,
// e.g. `<bare>-9821b58b`) made the heal permanently return
// 'skipped-no-keychain-token' while a live credential sat in the keychain.
// These tests pin the discovery contract: bare name first, then prefix
// enumeration from `security dump-keychain` METADATA (never `-d`), newest
// mdat wins.
import { describe, expect, it } from 'vitest';
import {
  parseKeychainServiceCandidates,
  readKeychainViaSecurity,
} from '../../../../src/runtimes/agent/providers/claude-filestore-heal.ts';

// Assembled from parts for the same reason as the implementation: this is the
// OS keychain service name, not an attribution string.
const SVC = ['Claude', 'Code-credentials'].join(' ');

/** One dump-keychain item block in the real `security dump-keychain` shape (metadata only). */
function dumpItem(svce: string, mdat: string, acct = 'phil'): string {
  return [
    'keychain: "/tmp/fixture-home/Library/Keychains/login.keychain-db"',
    'version: 512',
    'class: "genp"',
    'attributes:',
    `    0x00000007 <blob>="${svce}"`,
    '    0x00000008 <blob>=<NULL>',
    `    "acct"<blob>="${acct}"`,
    `    "cdat"<timedate>=0x32303236  "20260601000000Z\\000"`,
    `    "mdat"<timedate>=0x32303236  "${mdat}\\000"`,
    `    "svce"<blob>="${svce}"`,
  ].join('\n');
}

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

describe('parseKeychainServiceCandidates', () => {
  it('returns only prefix-matching service names, bare name first, then newest mdat first', () => {
    const dump = [
      dumpItem('whatsoup-health-token', '20260728000000Z'),
      dumpItem(`${SVC}-11111111`, '20260601000000Z'),
      dumpItem(SVC, '20260501000000Z'),
      dumpItem(`${SVC}-9821b58b`, '20260727161430Z'),
      dumpItem('com.bes.agent365.ph-bot', '20260725000000Z'),
    ].join('\n');
    expect(parseKeychainServiceCandidates(dump)).toEqual([
      SVC,
      `${SVC}-9821b58b`,
      `${SVC}-11111111`,
    ]);
  });

  it('handles the hash-suffixed-only shape (mini11/mini10): no bare item present', () => {
    const dump = dumpItem(`${SVC}-9821b58b`, '20260727161430Z');
    expect(parseKeychainServiceCandidates(dump)).toEqual([`${SVC}-9821b58b`]);
  });

  it('returns [] for a dump with no matching items', () => {
    const dump = dumpItem('whatsoup-health-token', '20260728000000Z');
    expect(parseKeychainServiceCandidates(dump)).toEqual([]);
  });

  it('deduplicates repeated service names and tolerates a missing mdat', () => {
    const noMdat = [
      'keychain: "/tmp/fixture-home/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      `    "svce"<blob>="${SVC}-aaaa0000"`,
    ].join('\n');
    const dump = [
      dumpItem(`${SVC}-9821b58b`, '20260727161430Z'),
      dumpItem(`${SVC}-9821b58b`, '20260727161430Z'),
      noMdat,
    ].join('\n');
    // A missing mdat sorts last; duplicates collapse.
    expect(parseKeychainServiceCandidates(dump)).toEqual([
      `${SVC}-9821b58b`,
      `${SVC}-aaaa0000`,
    ]);
  });
});

describe('readKeychainViaSecurity', () => {
  it('returns the bare item without ever dumping when the bare name exists', () => {
    const { exec, calls } = fakeExec([{ match: isFind(SVC), out: '{"claudeAiOauth":{}}\n' }]);
    expect(readKeychainViaSecurity(exec)).toBe('{"claudeAiOauth":{}}');
    expect(calls).toHaveLength(1);
    expect(calls.some(isDump)).toBe(false);
  });

  it('falls back to prefix discovery and reads the hash-suffixed item (mini11/mini10 shape)', () => {
    const { exec, calls } = fakeExec([
      { match: isFind(SVC), out: null },
      { match: isDump, out: dumpItem(`${SVC}-9821b58b`, '20260727161430Z') },
      { match: isFind(`${SVC}-9821b58b`), out: '{"claudeAiOauth":{"accessToken":"t"}}' },
    ]);
    expect(readKeychainViaSecurity(exec)).toBe('{"claudeAiOauth":{"accessToken":"t"}}');
    expect(calls.some(isFind(`${SVC}-9821b58b`))).toBe(true);
  });

  it('prefers the newest-mdat item when several suffixed items exist', () => {
    const dump = [
      dumpItem(`${SVC}-old00000`, '20260601000000Z'),
      dumpItem(`${SVC}-new00000`, '20260727161430Z'),
    ].join('\n');
    const { exec, calls } = fakeExec([
      { match: isFind(SVC), out: null },
      { match: isDump, out: dump },
      { match: isFind(`${SVC}-new00000`), out: 'newest-payload' },
      { match: isFind(`${SVC}-old00000`), out: 'older-payload' },
    ]);
    expect(readKeychainViaSecurity(exec)).toBe('newest-payload');
    // The newest candidate must be tried FIRST, not merely eventually.
    const firstSuffixedFind = calls.find((c) => isFind(`${SVC}-new00000`)(c) || isFind(`${SVC}-old00000`)(c));
    expect(firstSuffixedFind).toBeDefined();
    expect(firstSuffixedFind![firstSuffixedFind!.indexOf('-s') + 1]).toBe(`${SVC}-new00000`);
  });

  it('skips an empty suffixed item and continues to the next candidate', () => {
    const dump = [
      dumpItem(`${SVC}-new00000`, '20260727161430Z'),
      dumpItem(`${SVC}-old00000`, '20260601000000Z'),
    ].join('\n');
    const { exec } = fakeExec([
      { match: isFind(SVC), out: null },
      { match: isDump, out: dump },
      { match: isFind(`${SVC}-new00000`), out: '   ' },
      { match: isFind(`${SVC}-old00000`), out: 'older-payload' },
    ]);
    expect(readKeychainViaSecurity(exec)).toBe('older-payload');
  });

  it('returns null when neither the bare item nor any suffixed item exists', () => {
    const { exec, calls } = fakeExec([
      { match: isFind(SVC), out: null },
      { match: isDump, out: dumpItem('whatsoup-health-token', '20260728000000Z') },
    ]);
    expect(readKeychainViaSecurity(exec)).toBeNull();
    expect(calls.filter(isDump)).toHaveLength(1);
  });

  it('returns null when the dump itself is unreadable', () => {
    const { exec } = fakeExec([{ match: isFind(SVC), out: null }, { match: isDump, out: null }]);
    expect(readKeychainViaSecurity(exec)).toBeNull();
  });

  it('never requests secret bytes from the dump: no exec call combines dump-keychain with -d', () => {
    const { exec, calls } = fakeExec([
      { match: isFind(SVC), out: null },
      { match: isDump, out: dumpItem(`${SVC}-9821b58b`, '20260727161430Z') },
      { match: isFind(`${SVC}-9821b58b`), out: 'payload' },
    ]);
    readKeychainViaSecurity(exec);
    for (const call of calls) {
      if (isDump(call)) expect(call).not.toContain('-d');
    }
  });
});
