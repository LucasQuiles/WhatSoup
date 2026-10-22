import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  describeResetExitTimeout,
  observeProcessIdentity,
  type LastKillTreeOutcome,
} from '../../../src/runtimes/agent/reset-exit-diagnostic.ts';

const AMBIGUOUS_OUTCOME: LastKillTreeOutcome = {
  rootPid: 41001,
  signal: 'SIGTERM',
  outcome: 'unresolved_ambiguous',
  ambiguousPids: [41001, 41002],
  durationMs: 183,
  escalated: false,
  at: 1_000,
};

function psError(message: string, fields: { status?: number | null; code?: string }): Error {
  return Object.assign(new Error(message), fields);
}

const PS_FAILURES: Array<[string, Error, string]> = [
  ['ps exits 1 because the pid is gone', psError('Command failed: ps', { status: 1 }), 'not present'],
  ['ps exits with another status', psError('Command failed: ps', { status: 2 }), 'observation unavailable'],
  ['ps times out', psError('spawnSync ps ETIMEDOUT', { status: null, code: 'ETIMEDOUT' }), 'observation unavailable'],
  ['ps is not installed', psError('spawnSync ps ENOENT', { code: 'ENOENT' }), 'observation unavailable'],
];

describe('observeProcessIdentity', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('reads pid, start time, state and command name in one bounded ps call, without the argument list', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('41001 Wed Oct 22 10:30:56 2026     Ss   /opt/homebrew/bin/node\n');

    expect(observeProcessIdentity(41001)).toBe('ps: 41001 Wed Oct 22 10:30:56 2026 Ss node');
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      'ps',
      ['-o', 'pid=,lstart=,stat=,comm=', '-p', '41001'],
      { encoding: 'utf8', timeout: 1_000 },
    );
  });

  it('bounds a long ps line', () => {
    vi.mocked(execFileSync).mockReturnValueOnce(`41001 Wed Oct 22 10:30:56 2026 S ${'x'.repeat(400)}\n`);

    expect(observeProcessIdentity(41001)).toBe(`ps: 41001 Wed Oct 22 10:30:56 2026 S ${'x'.repeat(127)}`);
  });

  it('reads an empty ps result as not present', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('');

    expect(observeProcessIdentity(41001)).toBe('not present');
  });

  it.each(PS_FAILURES)('returns a fixed reading instead of throwing when %s', (_label, failure, expected) => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw failure;
    });

    expect(observeProcessIdentity(41001)).toBe(expected);
  });
});

describe('describeResetExitTimeout', () => {
  it('names the outcome, its root and ambiguous pids, duration, escalation and age, then the observation', () => {
    const source = { getLastKillTreeOutcome: () => AMBIGUOUS_OUTCOME };

    expect(describeResetExitTimeout(source, 'ps: 41001 Wed Oct 22 10:30:56 2026 S node', 7_183)).toBe(
      'last kill-tree outcome: unresolved_ambiguous rootPid=41001 signal=SIGTERM ambiguousPids=[41001,41002] '
        + 'durationMs=183 escalated=false ageMs=6183; pid observation: ps: 41001 Wed Oct 22 10:30:56 2026 S node',
    );
  });

  it('says none when no kill-tree outcome was recorded', () => {
    expect(describeResetExitTimeout({ getLastKillTreeOutcome: () => null }, 'not present', 7_183)).toBe(
      'last kill-tree outcome: none; pid observation: not present',
    );
  });

  it('lists at most eight ambiguous pids and counts the rest', () => {
    const source = {
      getLastKillTreeOutcome: () => ({
        ...AMBIGUOUS_OUTCOME,
        rootPid: null,
        ambiguousPids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      }),
    };

    expect(describeResetExitTimeout(source, 'not present', 1_000)).toBe(
      'last kill-tree outcome: unresolved_ambiguous rootPid=none signal=SIGTERM ambiguousPids=[1,2,3,4,5,6,7,8,+2 more] '
        + 'durationMs=183 escalated=false ageMs=0; pid observation: not present',
    );
  });

  it('reports an unreadable outcome instead of throwing', () => {
    const source = {
      getLastKillTreeOutcome: (): LastKillTreeOutcome | null => {
        throw new Error('outcome reader failed');
      },
    };

    expect(describeResetExitTimeout(source, 'observation unavailable', 1_000)).toBe(
      'last kill-tree outcome: unavailable; pid observation: observation unavailable',
    );
  });
});
