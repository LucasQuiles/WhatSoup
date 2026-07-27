import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { cleanGitEnv } from './lib/guard-core.ts';

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const WHATSOUP_SSH_URL_PATTERN =
  /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)LucasQuiles\/WhatSoup(?:\.git)?$/;

export interface GitProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GitProbe = (args: string[], cwd: string) => GitProbeResult;

export interface AlignmentReceipt {
  schemaVersion: 1;
  remoteName: string;
  remoteUrlDigest: string;
  candidateOid: string;
  headOid: string;
  remoteMainOid: string;
}

export interface AlignmentBeforeOptions {
  cwd: string;
  remoteName: string;
  remoteUrl: string;
  candidateOids: string[];
  runGit?: GitProbe;
}

export interface AlignmentAfterOptions {
  cwd: string;
  runGit?: GitProbe;
}

export class PushAlignmentError extends Error {
  readonly exitCode: 1 | 2;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { exitCode?: 1 | 2; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'PushAlignmentError';
    this.exitCode = options.exitCode ?? 1;
    this.retryable = options.retryable ?? false;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function defaultGitProbe(args: string[], cwd: string): GitProbeResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...cleanGitEnv(),
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10',
    },
    timeout: 15_000,
    killSignal: 'SIGTERM',
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}),
  };
}

function inconclusive(command: string, result: GitProbeResult): never {
  const detail = result.error?.message
    ?? (result.status === null ? 'terminated without an exit status' : `exit ${result.status}`);
  throw new PushAlignmentError(
    `pre-push alignment: could not prove ${command} (${detail})`,
    { exitCode: 2, retryable: true },
  );
}

function runChecked(
  runGit: GitProbe,
  cwd: string,
  args: string[],
  purpose: string,
): string {
  const result = runGit(args, cwd);
  if (result.status !== 0) inconclusive(purpose, result);
  return result.stdout;
}

function oneObjectId(raw: string, purpose: string): string {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !OBJECT_ID_PATTERN.test(lines[0] ?? '')) {
    throw new PushAlignmentError(
      `pre-push alignment: malformed ${purpose} evidence`,
      { exitCode: 2, retryable: true },
    );
  }
  return lines[0]!;
}

function configuredRemoteUrl(
  cwd: string,
  remoteName: string,
  runGit: GitProbe,
): string {
  if (!REMOTE_NAME_PATTERN.test(remoteName)) {
    throw new PushAlignmentError('pre-push alignment: invalid or missing remote name', {
      exitCode: 2,
    });
  }
  const value = runChecked(
    runGit,
    cwd,
    ['remote', 'get-url', '--push', remoteName],
    'configured push remote',
  ).trim();
  if (value === '' || /[\r\n]/.test(value)) {
    throw new PushAlignmentError(
      'pre-push alignment: configured push remote evidence is malformed',
      { exitCode: 2 },
    );
  }
  return value;
}

function assertClean(cwd: string, runGit: GitProbe): void {
  const raw = runChecked(
    runGit,
    cwd,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
    'invoking worktree status',
  );
  if (raw !== '') {
    throw new PushAlignmentError(
      'pre-push alignment: invoking worktree is not clean; commit the intended candidate or intentionally stash untracked and tracked work before retrying',
    );
  }
}

function readHead(cwd: string, runGit: GitProbe): string {
  return oneObjectId(
    runChecked(runGit, cwd, ['rev-parse', '--verify', 'HEAD'], 'invoking HEAD'),
    'invoking HEAD',
  );
}

function resolveCandidate(
  cwd: string,
  candidateOids: string[],
  runGit: GitProbe,
): string {
  if (candidateOids.length === 0) {
    throw new PushAlignmentError(
      'pre-push alignment: no non-delete candidate was received from the hook',
      { exitCode: 2 },
    );
  }
  const resolved = new Set<string>();
  for (const oid of [...new Set(candidateOids)].sort()) {
    if (!OBJECT_ID_PATTERN.test(oid)) {
      throw new PushAlignmentError('pre-push alignment: malformed candidate object id', {
        exitCode: 2,
      });
    }
    resolved.add(oneObjectId(
      runChecked(
        runGit,
        cwd,
        ['rev-parse', '--verify', `${oid}^{commit}`],
        'pushed candidate commit',
      ),
      'pushed candidate commit',
    ));
  }
  if (resolved.size !== 1) {
    throw new PushAlignmentError(
      'pre-push alignment: exactly one candidate commit may share a verification run; push lanes separately',
    );
  }
  return [...resolved][0]!;
}

function readLiveMain(
  cwd: string,
  remoteName: string,
  remoteUrl: string,
  runGit: GitProbe,
): string {
  const result = runGit(
    ['ls-remote', '--exit-code', remoteUrl, 'refs/heads/main'],
    cwd,
  );
  if (result.status !== 0) inconclusive(`live ${remoteName}/main`, result);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new PushAlignmentError(
      'pre-push alignment: malformed live main evidence',
      { exitCode: 2, retryable: true },
    );
  }
  const fields = lines[0]!.split('\t');
  if (
    fields.length !== 2
    || !OBJECT_ID_PATTERN.test(fields[0] ?? '')
    || fields[1] !== 'refs/heads/main'
  ) {
    throw new PushAlignmentError(
      'pre-push alignment: malformed live main evidence',
      { exitCode: 2, retryable: true },
    );
  }
  return fields[0]!;
}

function assertContainsMain(
  cwd: string,
  remoteName: string,
  mainOid: string,
  candidateOid: string,
  runGit: GitProbe,
): void {
  const result = runGit(
    ['merge-base', '--is-ancestor', mainOid, candidateOid],
    cwd,
  );
  if (result.status === 0) return;
  if (result.status === 1) {
    throw new PushAlignmentError(
      `pre-push alignment: candidate is behind live ${remoteName}/main; fetch and rebase or merge the latest main, rerun verification, then push`,
      { retryable: true },
    );
  }
  inconclusive(`candidate ancestry against live ${remoteName}/main`, result);
}

export function verifyAlignmentBefore(
  options: AlignmentBeforeOptions,
): AlignmentReceipt {
  const runGit = options.runGit ?? defaultGitProbe;
  const configuredUrl = configuredRemoteUrl(options.cwd, options.remoteName, runGit);
  if (!WHATSOUP_SSH_URL_PATTERN.test(configuredUrl)) {
    throw new PushAlignmentError(
      'pre-push alignment: WhatSoup requires an SSH push URL for LucasQuiles/WhatSoup',
    );
  }
  if (options.remoteUrl === '' || options.remoteUrl !== configuredUrl) {
    throw new PushAlignmentError(
      'pre-push alignment: hook remote URL does not match the configured push URL',
    );
  }
  const headOid = readHead(options.cwd, runGit);
  assertClean(options.cwd, runGit);
  const candidateOid = resolveCandidate(options.cwd, options.candidateOids, runGit);
  if (candidateOid !== headOid) {
    throw new PushAlignmentError(
      'pre-push alignment: pushed candidate does not match invoking HEAD; verify from the candidate worktree and push that exact lane',
    );
  }
  const remoteMainOid = readLiveMain(
    options.cwd,
    options.remoteName,
    configuredUrl,
    runGit,
  );
  assertContainsMain(
    options.cwd,
    options.remoteName,
    remoteMainOid,
    candidateOid,
    runGit,
  );
  return {
    schemaVersion: 1,
    remoteName: options.remoteName,
    remoteUrlDigest: sha256(configuredUrl),
    candidateOid,
    headOid,
    remoteMainOid,
  };
}

export function verifyAlignmentAfter(
  receipt: AlignmentReceipt,
  options: AlignmentAfterOptions,
): void {
  const runGit = options.runGit ?? defaultGitProbe;
  const configuredUrl = configuredRemoteUrl(options.cwd, receipt.remoteName, runGit);
  if (sha256(configuredUrl) !== receipt.remoteUrlDigest) {
    throw new PushAlignmentError(
      'pre-push alignment: configured push URL changed during verification',
      { exitCode: 2, retryable: true },
    );
  }
  const headOid = readHead(options.cwd, runGit);
  if (headOid !== receipt.headOid || headOid !== receipt.candidateOid) {
    throw new PushAlignmentError(
      'pre-push alignment: candidate HEAD changed during verification; rerun against the new candidate',
      { exitCode: 2, retryable: true },
    );
  }
  assertClean(options.cwd, runGit);
  const liveMainOid = readLiveMain(
    options.cwd,
    receipt.remoteName,
    configuredUrl,
    runGit,
  );
  if (liveMainOid !== receipt.remoteMainOid) {
    throw new PushAlignmentError(
      `pre-push alignment: live ${receipt.remoteName}/main advanced during verification; fetch, realign the lane, and rerun the gate`,
      { exitCode: 2, retryable: true },
    );
  }
}
