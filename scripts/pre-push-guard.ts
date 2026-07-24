import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export type RefDecision = 'delete' | 'branch' | 'release';
export type PushDecision = 'skip' | 'branch' | 'release';

interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

function parsePrePushLine(line: string): RefUpdate {
  const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
  if (!localRef || !localSha || !remoteRef || !remoteSha) {
    throw new Error(`Invalid pre-push ref update line: ${line}`);
  }
  return { localRef, localSha, remoteRef, remoteSha };
}

export function classifyPrePushLine(line: string): RefDecision {
  const update = parsePrePushLine(line);
  if (update.localSha === ZERO_SHA) return 'delete';
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
  const decision = classifyPrePushInput(input);
  const commands = commandsForDecision(decision);

  if (commands.length === 0) {
    console.error('pre-push guard: delete-only ref update; skipping content verification');
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
    process.exitCode = 1;
  }
}
