import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  verifyAlignmentAfter,
  verifyAlignmentBefore,
  type AlignmentAfterOptions,
  type AlignmentBeforeOptions,
  type AlignmentReceipt,
} from './pre-push-alignment.ts';

export const ZERO_SHA = '0000000000000000000000000000000000000000';
const ZERO_SHA_256 = '0'.repeat(64);
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type RefDecision = 'delete' | 'branch' | 'release';
export type PushDecision = 'skip' | 'branch' | 'release';

const REQUIRED_CONSOLE_EXECUTABLES = ['eslint', 'tsc', 'vite'] as const;
const DELETE_ONLY_METADATA_SCRIPTS = ['design:metrics', 'design:burndown'] as const;

interface PrePushGuardDependencies {
  assertConsoleDependencies: (cwd: string) => void;
  verifyAlignmentBefore?: (options: AlignmentBeforeOptions) => AlignmentReceipt;
  verifyAlignmentAfter?: (
    receipt: AlignmentReceipt,
    options: AlignmentAfterOptions,
  ) => void;
}

interface PushRemote {
  remoteName: string;
  remoteUrl: string;
}

interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

function isZeroObjectId(oid: string): boolean {
  return oid === ZERO_SHA || oid === ZERO_SHA_256;
}

function pushedBranchRef(update: RefUpdate): string | null {
  if (isZeroObjectId(update.localSha)) return null;
  if (update.localRef.startsWith('refs/heads/')) return update.localRef;
  if (update.localRef === 'HEAD' && update.remoteRef.startsWith('refs/heads/')) {
    return update.remoteRef;
  }
  return null;
}

function parsePrePushLine(line: string): RefUpdate {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 4) {
    throw new Error(`Invalid pre-push ref update line: ${line}`);
  }
  const [localRef, localSha, remoteRef, remoteSha] = fields as [
    string,
    string,
    string,
    string,
  ];
  if (
    !localRef
    || !OBJECT_ID_PATTERN.test(localSha)
    || !remoteRef
    || !OBJECT_ID_PATTERN.test(remoteSha)
  ) {
    throw new Error(`Invalid pre-push ref update line: ${line}`);
  }
  return { localRef, localSha, remoteRef, remoteSha };
}

export function classifyPrePushLine(line: string): RefDecision {
  const update = parsePrePushLine(line);
  if (isZeroObjectId(update.localSha)) return 'delete';
  if (update.remoteRef === 'refs/heads/main') return 'release';
  if (/^refs\/tags\/v.+/.test(update.remoteRef)) return 'release';
  return 'branch';
}

function nonBlankLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function classifyPrePushInput(input: string): PushDecision {
  const lines = nonBlankLines(input);

  // Zero parseable ref-update lines is NOT the same thing as a genuine
  // all-delete push: a real delete-only push still has lines (each classifying
  // as 'delete' below), while this branch only fires when stdin itself was
  // empty/whitespace-only (e.g. wrapper/indirection stdin loss). Collapsing
  // both into 'skip' silently bypassed the whole verification battery on
  // stdin starvation, so this case fails CLOSED by routing to branch
  // verification instead.
  if (lines.length === 0) return 'branch';

  const decisions = lines.map(classifyPrePushLine);
  if (decisions.includes('release')) return 'release';
  if (decisions.includes('branch')) return 'branch';
  return 'skip';
}

export function commandsForDecision(decision: PushDecision): string[] {
  if (decision === 'release') return ['verify:release'];
  if (decision === 'branch') return ['verify:push:branch'];
  return [];
}

function assertConsoleDependencies(cwd: string): void {
  const missing = REQUIRED_CONSOLE_EXECUTABLES.filter((executable) => {
    try {
      accessSync(resolve(cwd, 'console/node_modules/.bin', executable), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });

  if (missing.length > 0) {
    throw new Error(
      `pre-push guard: missing required console executables: ${missing.join(', ')}; run npm ci --prefix console before pushing`,
    );
  }

  try {
    execFileSync(
      'bash',
      [
        'scripts/run-with-pinned-npm.sh',
        '--prefix',
        'console',
        'ls',
        '--all',
        '--offline',
        '--ignore-scripts',
        '--audit=false',
        '--fund=false',
        '--update-notifier=false',
        '--json',
      ],
      {
        cwd,
        stdio: 'ignore',
      },
    );
  } catch {
    throw new Error(
      'pre-push guard: console dependency tree is incomplete or invalid; run npm ci --prefix console before pushing',
    );
  }
}

export function runPrePushGuard(
  input: string,
  cwd = process.cwd(),
  dependencies: PrePushGuardDependencies = { assertConsoleDependencies },
  remote?: PushRemote,
): PushDecision {
  let parsedUpdates: RefUpdate[] = [];
  let parseError: unknown = null;
  try {
    parsedUpdates = nonBlankLines(input).map(parsePrePushLine);
  } catch (error) {
    parseError = error;
  }
  const pushedLocalBranchRefs = parsedUpdates
    .map(pushedBranchRef)
    .filter((localRef): localRef is string => localRef !== null)
    .sort();
  const estateArgs = ['run', 'guard:git-estate', '--', 'guard', '--phase', 'pre-push'];
  for (const localRef of pushedLocalBranchRefs) {
    estateArgs.push('--push-local-ref', localRef);
  }
  console.error('pre-push guard: running deterministic Git estate gate');
  execFileSync(
    'npm',
    estateArgs,
    { cwd, stdio: 'inherit' },
  );
  if (parseError) throw parseError;

  const decision = classifyPrePushInput(input);
  const commands = commandsForDecision(decision);

  if (commands.length === 0) {
    console.error(
      'pre-push guard: delete-only ref update; estate verified; running metadata verification',
    );
    for (const script of DELETE_ONLY_METADATA_SCRIPTS) {
      execFileSync(
        'bash',
        ['scripts/run-with-pinned-npm.sh', '--prefix', 'console', 'run', script],
        { cwd, stdio: 'inherit' },
      );
    }
    return decision;
  }

  if (nonBlankLines(input).length === 0) {
    console.error(
      'pre-push guard: no ref updates received on stdin — refusing to skip verification (fail-closed); genuine branch deletions still skip',
    );
  }

  const alignmentBefore = dependencies.verifyAlignmentBefore ?? verifyAlignmentBefore;
  const alignmentAfter = dependencies.verifyAlignmentAfter ?? verifyAlignmentAfter;
  const alignmentReceipt = remote
    ? alignmentBefore({
        cwd,
        remoteName: remote.remoteName,
        remoteUrl: remote.remoteUrl,
        candidateOids: parsedUpdates
          .filter((update) => !isZeroObjectId(update.localSha))
          .map((update) => update.localSha),
      })
    : null;

  dependencies.assertConsoleDependencies(cwd);

  for (const script of commands) {
    console.error(`pre-push guard: running npm run ${script}`);
    execFileSync('npm', ['run', script], { cwd, stdio: 'inherit' });
  }

  if (alignmentReceipt) {
    alignmentAfter(alignmentReceipt, { cwd });
  }

  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPrePushGuard(
      readFileSync(0, 'utf8'),
      process.cwd(),
      { assertConsoleDependencies },
      {
        remoteName: process.argv[2] ?? '',
        remoteUrl: process.argv[3] ?? '',
      },
    );
  } catch (err) {
    console.error((err as Error).message);
    const errorStatus = (err as Error & { status?: number; exitCode?: number }).status
      ?? (err as Error & { exitCode?: number }).exitCode;
    process.exitCode = typeof errorStatus === 'number' && Number.isInteger(errorStatus) && errorStatus > 0
      ? errorStatus
      : 1;
  }
}
