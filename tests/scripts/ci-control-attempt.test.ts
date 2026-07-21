import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FileAttemptEvidenceStore,
  supervisorCloseDigest,
  supervisorProcessLeaseDigest,
  supervisorTerminalDigest,
  terminalAttemptDigest,
  revalidateSupervisorLease,
  validateSupervisorClose,
  validateSupervisorProcessLease,
  validateSupervisorTerminal,
  validateTerminalAttempt,
  writeTerminalAttempt,
  type SupervisorCloseV1,
  type SupervisorLeaseExpectationsV1,
  type SupervisorProcessLeaseV1,
  type SupervisorTerminalV1,
  type TerminalAttemptV1,
} from '../../scripts/lib/ci-control/attempt.ts';

const OID = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = Date.parse('2026-07-20T22:00:00.000Z');
const CREATED_AT = '2026-07-20T21:50:00.000Z';
const ISSUED_AT = '2026-07-20T21:51:00.000Z';
const TERMINAL_AT = '2026-07-20T21:52:00.000Z';
const CLOSED_AT = '2026-07-20T21:52:01.000Z';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function start(startTicks: string) {
  return { source: 'linux-proc-stat' as const, bootId: 'boot-fixture', startTicks };
}

function lease(overrides: Record<string, unknown> = {}): SupervisorProcessLeaseV1 {
  return {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    leaseId: 'lease-1',
    issuedAt: ISSUED_AT,
    validUntil: '2026-07-20T22:01:00.000Z',
    challengeDigest: DIGEST,
    supervisorToolDigest: DIGEST,
    identityProbeDigest: DIGEST,
    closeObserverDigest: DIGEST,
    supervisor: { pid: 200, ppid: 100, pgid: 100, sid: 100, start: start('2000') },
    anchor: { pid: 300, ppid: 200, pgid: 300, sid: 300, start: start('3000') },
    target: { pid: 301, ppid: 300, pgid: 300, sid: 300, start: start('3001') },
    commandDigest: DIGEST,
    cwdDigest: DIGEST,
    environmentDigest: DIGEST,
    ...overrides,
  } as SupervisorProcessLeaseV1;
}

function expectations(overrides: Partial<SupervisorLeaseExpectationsV1> = {}): SupervisorLeaseExpectationsV1 {
  return {
    attemptId: 'attempt-1',
    callerPid: 100,
    supervisorPid: 200,
    challengeDigest: DIGEST,
    supervisorToolDigest: DIGEST,
    identityProbeDigest: DIGEST,
    closeObserverDigest: DIGEST,
    commandDigest: DIGEST,
    cwdDigest: DIGEST,
    environmentDigest: DIGEST,
    ...overrides,
  };
}

function terminal(value = lease(), overrides: Record<string, unknown> = {}): SupervisorTerminalV1 {
  return {
    schemaVersion: 1,
    attemptId: value.attemptId,
    leaseDigest: supervisorProcessLeaseDigest(value),
    terminalAt: TERMINAL_AT,
    targetStatus: { rawExit: 7, rawSignal: null, timedOut: false },
    anchorStatus: { rawExit: 0, rawSignal: null },
    finalGroup: {
      status: 'empty',
      observedAt: TERMINAL_AT,
      leaseDigest: supervisorProcessLeaseDigest(value),
      identityProbeDigest: value.identityProbeDigest,
      lastMatchedSnapshot: { supervisor: value.supervisor, anchor: value.anchor, target: value.target },
      members: [],
    },
    ...overrides,
  } as SupervisorTerminalV1;
}

function close(value = lease(), overrides: Record<string, unknown> = {}): SupervisorCloseV1 {
  return {
    schemaVersion: 1,
    attemptId: value.attemptId,
    leaseDigest: supervisorProcessLeaseDigest(value),
    supervisorPid: value.supervisor.pid,
    rawExit: 0,
    rawSignal: null,
    observerDigest: value.closeObserverDigest,
    closedAt: CLOSED_AT,
    ...overrides,
  } as SupervisorCloseV1;
}

function attempt(value: SupervisorProcessLeaseV1, precursor: SupervisorTerminalV1, directClose: SupervisorCloseV1, historyEntryDigest: string): TerminalAttemptV1 {
  return {
    schemaVersion: 1,
    id: value.attemptId,
    lifecycle: 'terminal',
    createdAt: CREATED_AT,
    terminalAt: directClose.closedAt,
    rawExit: precursor.targetStatus.rawExit,
    rawSignal: precursor.targetStatus.rawSignal,
    timedOut: precursor.targetStatus.timedOut,
    terminationProof: {
      schemaVersion: 1,
      leaseDigest: supervisorProcessLeaseDigest(value),
      supervisorTerminalDigest: supervisorTerminalDigest(precursor, value),
      supervisorCloseDigest: supervisorCloseDigest(directClose, value, precursor),
      supervisorDigest: value.supervisorToolDigest,
      observedAt: directClose.closedAt,
      status: 'reaped',
    },
    evidenceBinding: {
      controlId: 'semantic-quality',
      candidateOid: OID,
      manifestDigest: DIGEST,
      policyDigest: DIGEST,
      toolDigest: DIGEST,
      platformDigest: DIGEST,
      preconditionDigest: DIGEST,
      producerDigest: DIGEST,
      scannerPolicyReceiptDigest: DIGEST,
      resultEvidenceDigest: DIGEST,
    },
    historySequence: 4,
    historyEntryDigest,
  };
}

describe('CP-F2 supervisor-issued process evidence', () => {
  it('accepts only the protected caller topology and immutable process start identities', () => {
    expect(validateSupervisorProcessLease(lease(), expectations(), { now: NOW })).toEqual(lease());

    for (const unsafe of [
      lease({ supervisor: { ...lease().supervisor, ppid: 999 } }),
      lease({ anchor: { ...lease().anchor, pgid: 301 } }),
      lease({ anchor: { ...lease().anchor, sid: 100 } }),
      lease({ target: { ...lease().target, ppid: 200 } }),
      lease({ target: { ...lease().target, pgid: 301 } }),
      lease({ target: { ...lease().target, start: { ...start('3001'), bootId: 'other-boot' } } }),
      lease({ target: { ...lease().target, start: { source: 'darwin-proc-bsdinfo', bootId: 'boot-fixture', startSec: 1, startUsec: 1 } } }),
    ]) {
      expect(() => validateSupervisorProcessLease(unsafe, expectations(), { now: NOW })).toThrow(/topology|identity|session|start|boot|parent/i);
    }
    expect(() => validateSupervisorProcessLease(lease(), expectations({ challengeDigest: OTHER_DIGEST }), { now: NOW })).toThrow(/challenge|expected|binding/i);
    expect(() => validateSupervisorProcessLease(lease(), expectations({ supervisorToolDigest: OTHER_DIGEST }), { now: NOW })).toThrow(/tool|expected|binding/i);
    expect(() => validateSupervisorProcessLease(lease(), { ...expectations(), surprise: true } as never, { now: NOW })).toThrow(/expectation|keys/i);
  });

  it('compares a fresh supervisor identity snapshot without process access', () => {
    const issued = lease();
    const matching = { supervisor: issued.supervisor, anchor: issued.anchor, target: issued.target };
    expect(revalidateSupervisorLease(issued, matching)).toBe('match');
    expect(revalidateSupervisorLease(issued, null)).toBe('missing');
    expect(revalidateSupervisorLease(issued, { ...matching, anchor: { ...issued.anchor, start: start('9999') } })).toBe('drift');
    expect(revalidateSupervisorLease(issued, { ...matching, target: { ...issued.target, sid: 999 } })).toBe('drift');
  });

  it('requires an exact terminal precursor and successful direct supervisor close', () => {
    const issued = lease();
    const precursor = terminal(issued);
    const directClose = close(issued);
    expect(validateSupervisorTerminal(precursor, issued, { now: NOW })).toEqual(precursor);
    expect(validateSupervisorClose(directClose, issued, precursor, { now: NOW })).toEqual(directClose);
    expect(() => validateSupervisorTerminal({ ...precursor, leaseDigest: OTHER_DIGEST }, issued, { now: NOW })).toThrow(/lease|binding/i);
    expect(() => validateSupervisorTerminal({ ...precursor, finalGroup: { ...precursor.finalGroup, status: 'running' } }, issued, { now: NOW })).toThrow(/group|empty|terminal/i);
    expect(() => validateSupervisorTerminal({ ...precursor, finalGroup: { ...precursor.finalGroup, identityProbeDigest: OTHER_DIGEST } }, issued, { now: NOW })).toThrow(/revalidation|probe|identity/i);
    expect(() => validateSupervisorTerminal({ ...precursor, finalGroup: { ...precursor.finalGroup, lastMatchedSnapshot: { ...precursor.finalGroup.lastMatchedSnapshot, anchor: { ...issued.anchor, start: start('9999') } } } }, issued, { now: NOW })).toThrow(/revalidation|group|identity/i);
    expect(() => validateSupervisorTerminal({ ...precursor, finalGroup: { ...precursor.finalGroup, members: [issued.target.pid] } }, issued, { now: NOW })).toThrow(/group|empty|member/i);
    expect(() => validateSupervisorClose({ ...directClose, rawExit: 2 }, issued, precursor, { now: NOW })).toThrow(/close|exit|supervisor/i);
    expect(() => validateSupervisorClose({ ...directClose, observerDigest: OTHER_DIGEST }, issued, precursor, { now: NOW })).toThrow(/observer|close|binding/i);
    expect(() => validateSupervisorClose({ ...directClose, closedAt: '2026-07-20T21:51:59.000Z' }, issued, precursor, { now: NOW })).toThrow(/chronology|close|terminal/i);
  });

  it('stores one canonical append-only lease, terminal precursor, close, history, and admitted receipt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-control-attempt-v2-'));
    roots.push(root);
    const store = new FileAttemptEvidenceStore(root);
    const issued = lease();
    const precursor = terminal(issued);
    const directClose = close(issued);

    store.beginAttempt(issued.attemptId, CREATED_AT);
    const leaseDigest = store.writeSupervisorLease(issued, expectations(), { now: NOW });
    const precursorDigest = store.writeSupervisorTerminal(precursor, leaseDigest, { now: NOW, expectedLease: expectations() });
    const finalized = store.writeSupervisorClose(directClose, leaseDigest, precursorDigest, 'terminal', { now: NOW, expectedLease: expectations() });
    const admitted = attempt(issued, precursor, directClose, finalized.historyEntryDigest);
    const admittedDigest = writeTerminalAttempt(store.terminalPath(admitted.id), admitted, {
      store,
      leaseDigest,
      supervisorTerminalDigest: precursorDigest,
      supervisorCloseDigest: finalized.supervisorCloseDigest,
      expectedLease: expectations(),
      now: NOW,
    });

    expect(leaseDigest).toBe(supervisorProcessLeaseDigest(issued));
    expect(precursorDigest).toBe(supervisorTerminalDigest(precursor, issued));
    expect(finalized.supervisorCloseDigest).toBe(supervisorCloseDigest(directClose, issued, precursor));
    expect(admittedDigest).toBe(terminalAttemptDigest(admitted as unknown as Record<string, unknown>));
    expect(readFileSync(store.terminalPath(admitted.id), 'utf8').endsWith('\n')).toBe(true);
    expect(store.readTerminalAttempt(admitted.id, admittedDigest, admitted, { now: NOW, expectedLease: expectations() })).toEqual(admitted);
    expect(store.claim(admitted.id, admittedDigest)).toBe(true);
    expect(store.claim(admitted.id, admittedDigest)).toBe(false);
    expect(() => store.writeSupervisorLease(issued, expectations(), { now: NOW })).toThrow(/exists|reuse|immutable/i);

    writeFileSync(store.terminalPath(admitted.id), `${readFileSync(store.terminalPath(admitted.id), 'utf8')} `, 'utf8');
    expect(() => store.readTerminalAttempt(admitted.id, admittedDigest, admitted, { now: NOW, expectedLease: expectations() })).toThrow(/bytes|binding|receipt/i);
  });

  it('rejects root replacement and paths outside the trusted root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-control-attempt-root-'));
    const replacement = await mkdtemp(path.join(tmpdir(), 'ci-control-attempt-replacement-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'ci-control-attempt-outside-'));
    roots.push(root, replacement, outside);
    const store = new FileAttemptEvidenceStore(root);
    const issued = lease();
    store.beginAttempt(issued.attemptId, CREATED_AT);
    const leaseDigest = store.writeSupervisorLease(issued, expectations(), { now: NOW });
    const precursor = terminal(issued);
    const precursorDigest = store.writeSupervisorTerminal(precursor, leaseDigest, { now: NOW, expectedLease: expectations() });
    const directClose = close(issued);
    const finalized = store.writeSupervisorClose(directClose, leaseDigest, precursorDigest, 'terminal', { now: NOW, expectedLease: expectations() });
    const admitted = attempt(issued, precursor, directClose, finalized.historyEntryDigest);
    expect(() => writeTerminalAttempt(path.join(outside, 'attempt-1.terminal.json'), admitted, {
      store, leaseDigest, supervisorTerminalDigest: precursorDigest, supervisorCloseDigest: finalized.supervisorCloseDigest, expectedLease: expectations(), now: NOW,
    })).toThrow(/path|root|store/i);

    const moved = `${root}-preserved`;
    await rename(root, moved);
    roots.push(moved);
    await symlink(replacement, root);
    expect(() => store.terminalPath(issued.attemptId)).toThrow(/root identity/i);
  });
});
