/**
 * AccountIdentityVerifier — the runtime-side coordinator that records the
 * ratified-row verification result and drives the operator alert surface.
 *
 * Pins the alert contract per outcome class (match => quiet + idempotent
 * clear, mismatch => critical `credential_identity_mismatch`, unverifiable =>
 * warning `credential_identity_unverifiable`), the one-time disabled note,
 * post-shutdown drop, in-flight coalescing, and — req-03 core — that no
 * branch ever reaches a credential write seam.
 */
import { describe, expect, it, vi } from 'vitest';

const healSeam = vi.hoisted(() => ({ ensureClaudeFileStoreCredential: vi.fn() }));
vi.mock('../../../src/runtimes/agent/providers/claude-filestore-heal.ts', () => ({
  ensureClaudeFileStoreCredential: healSeam.ensureClaudeFileStoreCredential,
}));

import {
  AccountIdentityVerifier,
  CREDENTIAL_IDENTITY_ALERT_SOURCES,
  type AccountIdentityVerifierHost,
} from '../../../src/runtimes/agent/account-identity-verifier.ts';
import type { AccountIdentityVerification } from '../../../src/runtimes/agent/providers/claude-account-identity.ts';

const NOW = 1_790_000_000_000;
const EXPECTED = `sha256:${'a'.repeat(64)}`;
const EMAIL = 'owner.example@example.test';

function verification(over: Partial<AccountIdentityVerification>): AccountIdentityVerification {
  return {
    status: 'match',
    reason: null,
    expectedDigestPrefix: 'aaaaaaaaaaaa',
    observedDigestPrefix: 'aaaaaaaaaaaa',
    checkedAt: NOW,
    ...over,
  };
}

function makeHost(over: Partial<AccountIdentityVerifierHost> = {}): AccountIdentityVerifierHost {
  const host: AccountIdentityVerifierHost = {
    instanceName: 'phbot',
    agentProvider: 'claude-cli',
    expectedAccountDigest: EXPECTED,
    shutdownRequested: false,
    accountIdentity: null,
    ...over,
  };
  return host;
}

function makeDeps(results: Array<AccountIdentityVerification | Error>) {
  const queue = [...results];
  const verify = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('test queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  });
  const emitAlertChecked = vi.fn(() => true);
  const clearAlertSourceChecked = vi.fn(() => true);
  const logs: Array<{ level: string; obj: unknown; msg: string }> = [];
  const log = {
    info: (obj: unknown, msg: string) => { logs.push({ level: 'info', obj, msg }); },
    warn: (obj: unknown, msg: string) => { logs.push({ level: 'warn', obj, msg }); },
  };
  return { verify, emitAlertChecked, clearAlertSourceChecked, log, logs };
}

function alertCalls(fn: ReturnType<typeof vi.fn>): Array<{ source: string; severity: string | undefined; evidence: string }> {
  return fn.mock.calls.map((call) => {
    const [, source, , evidence, severity] = call as [string, string, string, string, string | undefined];
    return { source, severity, evidence };
  });
}

describe('AccountIdentityVerifier — outcome classes drive the alert surface', () => {
  it('disabled: no expectation -> no verify call, no state, one info note per process', async () => {
    const host = makeHost({ expectedAccountDigest: null });
    const d = makeDeps([]);
    const verifier = new AccountIdentityVerifier(host, d);
    expect(await verifier.run('startup')).toBeNull();
    expect(await verifier.run('periodic')).toBeNull();
    expect(d.verify).not.toHaveBeenCalled();
    expect(host.accountIdentity).toBeNull();
    expect(d.emitAlertChecked).not.toHaveBeenCalled();
    expect(d.clearAlertSourceChecked).not.toHaveBeenCalled();
    const notes = d.logs.filter((entry) => entry.msg.includes('identity verification disabled'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.level).toBe('info');
  });

  it('non-claude-cli primary provider: never verifies (defence in depth behind config admission)', async () => {
    const host = makeHost({ agentProvider: 'opencode-cli' });
    const d = makeDeps([verification({})]);
    expect(await new AccountIdentityVerifier(host, d).run('startup')).toBeNull();
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('match: records the receipt, emits no alert, and clears both sources once (prior-process carry-over)', async () => {
    const host = makeHost();
    const d = makeDeps([verification({}), verification({ checkedAt: NOW + 1 })]);
    const verifier = new AccountIdentityVerifier(host, d);
    const first = await verifier.run('startup');
    expect(first).toMatchObject({ status: 'match' });
    expect(host.accountIdentity).toEqual(first);
    expect(d.verify).toHaveBeenCalledWith(EXPECTED);
    expect(d.emitAlertChecked).not.toHaveBeenCalled();
    expect(d.clearAlertSourceChecked.mock.calls.map((call) => call[1])).toEqual([...CREDENTIAL_IDENTITY_ALERT_SOURCES]);

    await verifier.run('periodic');
    expect(host.accountIdentity).toMatchObject({ checkedAt: NOW + 1 });
    // no active alert -> nothing more to clear
    expect(d.clearAlertSourceChecked).toHaveBeenCalledTimes(2);
  });

  it('mismatch: critical alert with content-free evidence; a later match clears it', async () => {
    const host = makeHost();
    const d = makeDeps([
      verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }),
      verification({}),
    ]);
    const verifier = new AccountIdentityVerifier(host, d);
    await verifier.run('startup');
    expect(host.accountIdentity).toMatchObject({ status: 'mismatch' });
    const alerts = alertCalls(d.emitAlertChecked);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'credential_identity_mismatch', severity: 'critical' });
    expect(alerts[0]!.evidence).toContain('trigger=startup');
    expect(alerts[0]!.evidence).toContain('status=mismatch');
    expect(alerts[0]!.evidence).toContain('expected=aaaaaaaaaaaa');
    expect(alerts[0]!.evidence).toContain('observed=bbbbbbbbbbbb');
    expect(alerts[0]!.evidence).toContain('provider=claude-cli');
    expect(d.emitAlertChecked.mock.calls[0]![0]).toBe('phbot');

    await verifier.run('periodic');
    expect(host.accountIdentity).toMatchObject({ status: 'match' });
    const clears = d.clearAlertSourceChecked.mock.calls.map((call) => call[1]);
    expect(clears).toContain('credential_identity_mismatch');
  });

  it('unverifiable: warning alert carrying the bounded reason', async () => {
    const host = makeHost();
    const d = makeDeps([verification({ status: 'unverifiable', reason: 'not-logged-in', observedDigestPrefix: null })]);
    await new AccountIdentityVerifier(host, d).run('periodic');
    const alerts = alertCalls(d.emitAlertChecked);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: 'credential_identity_unverifiable', severity: 'warning' });
    expect(alerts[0]!.evidence).toContain('reason=not-logged-in');
    expect(alerts[0]!.evidence).toContain('observed=absent');
    expect(alerts[0]!.evidence).toContain('trigger=periodic');
  });

  it('mismatch followed by unverifiable keeps the mismatch open (unknown is not resolution); match clears both', async () => {
    const host = makeHost();
    const d = makeDeps([
      verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }),
      verification({ status: 'unverifiable', reason: 'probe-failed', observedDigestPrefix: null }),
      verification({}),
    ]);
    const verifier = new AccountIdentityVerifier(host, d);
    await verifier.run('startup');
    await verifier.run('periodic');
    expect(d.clearAlertSourceChecked).not.toHaveBeenCalled();
    expect(alertCalls(d.emitAlertChecked).map((a) => a.source))
      .toEqual(['credential_identity_mismatch', 'credential_identity_unverifiable']);

    await verifier.run('periodic');
    const clears = d.clearAlertSourceChecked.mock.calls.map((call) => call[1]).sort();
    expect(clears).toEqual([...CREDENTIAL_IDENTITY_ALERT_SOURCES].sort());
  });

  it('a rejecting verify is contained as unverifiable/probe-threw (run never rejects)', async () => {
    const host = makeHost();
    const d = makeDeps([new Error('spawn exploded')]);
    const result = await new AccountIdentityVerifier(host, d).run('startup');
    expect(result).toMatchObject({ status: 'unverifiable', reason: 'probe-threw' });
    expect(host.accountIdentity).toMatchObject({ status: 'unverifiable', reason: 'probe-threw' });
    expect(alertCalls(d.emitAlertChecked)[0]).toMatchObject({ source: 'credential_identity_unverifiable' });
    const serialized = JSON.stringify(d.logs);
    expect(serialized).not.toContain('spawn exploded'.repeat(2));
  });

  it('a result that lands after shutdown is dropped whole: no state, no alert, no clear', async () => {
    let resolve!: (v: AccountIdentityVerification) => void;
    const host = makeHost();
    const d = makeDeps([]);
    d.verify.mockImplementationOnce(() => new Promise<AccountIdentityVerification>((r) => { resolve = r; }));
    const verifier = new AccountIdentityVerifier(host, d);
    const pending = verifier.run('startup');
    (host as { shutdownRequested: boolean }).shutdownRequested = true;
    resolve(verification({ status: 'mismatch' }));
    expect(await pending).toBeNull();
    expect(host.accountIdentity).toBeNull();
    expect(d.emitAlertChecked).not.toHaveBeenCalled();
    expect(d.clearAlertSourceChecked).not.toHaveBeenCalled();
  });

  it('coalesces concurrent runs onto one in-flight verification', async () => {
    let resolve!: (v: AccountIdentityVerification) => void;
    const host = makeHost();
    const d = makeDeps([]);
    d.verify.mockImplementationOnce(() => new Promise<AccountIdentityVerification>((r) => { resolve = r; }));
    const verifier = new AccountIdentityVerifier(host, d);
    const a = verifier.run('startup');
    const b = verifier.run('periodic');
    resolve(verification({}));
    expect(await a).toEqual(await b);
    expect(d.verify).toHaveBeenCalledTimes(1);
  });

  it('req-03: no branch reaches a credential write seam (heal never invoked, only verify + alert calls)', async () => {
    const host = makeHost();
    const d = makeDeps([
      verification({}),
      verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }),
      verification({ status: 'unverifiable', reason: 'not-logged-in', observedDigestPrefix: null }),
      verification({ status: 'unverifiable', reason: 'unparseable', observedDigestPrefix: null }),
      verification({ status: 'unverifiable', reason: 'binary-missing', observedDigestPrefix: null }),
      new Error('probe threw'),
    ]);
    const verifier = new AccountIdentityVerifier(host, d);
    for (let i = 0; i < 6; i++) await verifier.run('periodic');
    expect(healSeam.ensureClaudeFileStoreCredential).not.toHaveBeenCalled();
    expect(d.verify).toHaveBeenCalledTimes(6);
  });

  it('never publishes a raw identity: logs and alert evidence carry digest prefixes and status classes only', async () => {
    const host = makeHost();
    const d = makeDeps([
      verification({ status: 'mismatch', observedDigestPrefix: 'bbbbbbbbbbbb' }),
      verification({ status: 'unverifiable', reason: 'identity-fields-missing', observedDigestPrefix: null }),
      verification({}),
    ]);
    const verifier = new AccountIdentityVerifier(host, d);
    for (let i = 0; i < 3; i++) await verifier.run('periodic');
    const published = JSON.stringify({ logs: d.logs, alerts: d.emitAlertChecked.mock.calls, clears: d.clearAlertSourceChecked.mock.calls });
    expect(published).not.toContain(EMAIL);
    expect(published).not.toContain('@');
    expect(published).not.toContain(EXPECTED);
    expect(published).not.toMatch(/[0-9a-f]{64}/);
  });
});
