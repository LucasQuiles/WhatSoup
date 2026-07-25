import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ZERO_SHA = '0000000000000000000000000000000000000000';
const ZERO_SHA_256 = '0'.repeat(64);
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type RefDecision = 'delete' | 'branch' | 'release';
export type PushDecision = 'skip' | 'branch' | 'release';

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

export function runPrePushGuard(input: string, cwd = process.cwd()): PushDecision {
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
      'pre-push guard: delete-only ref update; estate verified; skipping content verification',
    );
    return decision;
  }

  if (nonBlankLines(input).length === 0) {
    console.error(
      'pre-push guard: no ref updates received on stdin — refusing to skip verification (fail-closed); genuine branch deletions still skip',
    );
  }

  for (const script of commands) {
    console.error(`pre-push guard: running npm run ${script}`);
    execFileSync('npm', ['run', script], { cwd, stdio: 'inherit' });
  }

  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPrePushGuard(readFileSync(0, 'utf8'));
  } catch (err) {
    console.error((err as Error).message);
    const childStatus = (err as Error & { status?: number }).status;
    process.exitCode = typeof childStatus === 'number' && Number.isInteger(childStatus) && childStatus > 0
      ? childStatus
      : 1;
  }
}
