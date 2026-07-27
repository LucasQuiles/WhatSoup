import { describe, expect, it, vi } from 'vitest';

import {
  PushAlignmentError,
  verifyAlignmentAfter,
  verifyAlignmentBefore,
  type GitProbe,
} from '../../scripts/pre-push-alignment.ts';

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const ADVANCED_MAIN = 'c'.repeat(40);
const REMOTE_URL = 'git@github.com:LucasQuiles/WhatSoup.git';

function probe(overrides: Partial<Record<string, { status: number; stdout?: string }>> = {}): GitProbe {
  return vi.fn((args: string[]) => {
    const key = args.join(' ');
    const override = overrides[key];
    if (override) return { status: override.status, stdout: override.stdout ?? '', stderr: '' };
    if (key === 'remote get-url --push origin') {
      return { status: 0, stdout: `${REMOTE_URL}\n`, stderr: '' };
    }
    if (key === 'rev-parse --verify HEAD') {
      return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
    }
    if (key === `rev-parse --verify ${HEAD}^{commit}`) {
      return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
    }
    if (key === 'status --porcelain=v2 -z --untracked-files=all') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (key === `ls-remote --exit-code ${REMOTE_URL} refs/heads/main`) {
      return { status: 0, stdout: `${MAIN}\trefs/heads/main\n`, stderr: '' };
    }
    if (key === `merge-base --is-ancestor ${MAIN} ${HEAD}`) {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 2, stdout: '', stderr: `unexpected git call: ${key}` };
  });
}

describe('pre-push candidate alignment', () => {
  it('binds a clean exact-HEAD candidate to the live remote main', () => {
    const runGit = probe();
    const receipt = verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
      candidateOids: [HEAD, HEAD],
      runGit,
    });

    expect(receipt).toMatchObject({
      remoteName: 'origin',
      candidateOid: HEAD,
      headOid: HEAD,
      remoteMainOid: MAIN,
    });
    expect(receipt.remoteUrlDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(runGit).toHaveBeenCalledWith(
      ['merge-base', '--is-ancestor', MAIN, HEAD],
      '/repo',
    );
  });

  it('refuses dirty or untracked invoking-lane state before expensive verification', () => {
    const runGit = probe({
      'status --porcelain=v2 -z --untracked-files=all': {
        status: 0,
        stdout: `? generated.txt\0`,
      },
    });

    expect(() => verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
      candidateOids: [HEAD],
      runGit,
    })).toThrowError(/invoking worktree is not clean/);
  });

  it('refuses verification when multiple pushed commits would share one evidence run', () => {
    const runGit = probe({
      [`rev-parse --verify ${ADVANCED_MAIN}^{commit}`]: {
        status: 0,
        stdout: `${ADVANCED_MAIN}\n`,
      },
    });

    expect(() => verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
      candidateOids: [HEAD, ADVANCED_MAIN],
      runGit,
    })).toThrowError(/exactly one candidate commit/);
  });

  it('refuses a candidate other than the invoking worktree HEAD', () => {
    const runGit = probe({
      'rev-parse --verify HEAD': { status: 0, stdout: `${ADVANCED_MAIN}\n` },
    });

    expect(() => verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
      candidateOids: [HEAD],
      runGit,
    })).toThrowError(/does not match invoking HEAD/);
  });

  it('refuses a candidate that does not contain the live remote main', () => {
    const runGit = probe({
      [`merge-base --is-ancestor ${MAIN} ${HEAD}`]: { status: 1 },
    });

    expect(() => verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
      candidateOids: [HEAD],
      runGit,
    })).toThrowError(/behind live origin\/main/);
  });

  it('refuses a hook remote URL that differs from the configured push URL without leaking either URL', () => {
    const unexpectedUrl = 'ssh://unexpected.example/repo.git';
    let thrown: unknown;
    try {
      verifyAlignmentBefore({
        cwd: '/repo',
        remoteName: 'origin',
        remoteUrl: unexpectedUrl,
        candidateOids: [HEAD],
        runGit: probe(),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PushAlignmentError);
    expect(String((thrown as Error).message)).toMatch(/remote URL does not match/);
    expect(String((thrown as Error).message)).not.toContain(unexpectedUrl);
    expect(String((thrown as Error).message)).not.toContain(REMOTE_URL);
  });

  it('refuses a non-SSH push URL for this repository even when hook and config agree', () => {
    const httpsUrl = 'https://github.com/LucasQuiles/WhatSoup.git';
    const runGit = probe({
      'remote get-url --push origin': { status: 0, stdout: `${httpsUrl}\n` },
    });

    expect(() => verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: httpsUrl,
      candidateOids: [HEAD],
      runGit,
    })).toThrowError(/SSH push URL/);
  });

  it('returns a retryable inconclusive outcome when main advances during verification', () => {
    const beforeProbe = probe();
    const receipt = verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
      candidateOids: [HEAD],
      runGit: beforeProbe,
    });
    const afterProbe = probe({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: {
        status: 0,
        stdout: `${ADVANCED_MAIN}\trefs/heads/main\n`,
      },
    });

    let thrown: unknown;
    try {
      verifyAlignmentAfter(receipt, { cwd: '/repo', runGit: afterProbe });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PushAlignmentError);
    expect(thrown).toMatchObject({ exitCode: 2, retryable: true });
    expect(String((thrown as Error).message)).toMatch(/advanced during verification/);
  });

  it('fails inconclusive on malformed or unavailable remote evidence', () => {
    const malformed = probe({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: {
        status: 0,
        stdout: 'not-a-ref-record\n',
      },
    });
    expect(() => verifyAlignmentBefore({
      cwd: '/repo',
      remoteName: 'origin',
      remoteUrl: REMOTE_URL,
      candidateOids: [HEAD],
      runGit: malformed,
    })).toThrowError(/malformed live main evidence/);

    const unavailable = probe({
      [`ls-remote --exit-code ${REMOTE_URL} refs/heads/main`]: { status: 2 },
    });
    let thrown: unknown;
    try {
      verifyAlignmentBefore({
        cwd: '/repo',
        remoteName: 'origin',
        remoteUrl: REMOTE_URL,
        candidateOids: [HEAD],
        runGit: unavailable,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ exitCode: 2 });
  });
});
