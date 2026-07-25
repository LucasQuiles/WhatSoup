import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ZERO_SHA = '0000000000000000000000000000000000000000';

export type RefDecision = 'delete' | 'branch' | 'release';
export type PushDecision = 'skip' | 'branch' | 'release';

const REQUIRED_CONSOLE_EXECUTABLES = ['eslint', 'tsc', 'vite'] as const;
const DELETE_ONLY_METADATA_SCRIPTS = ['design:metrics', 'design:burndown'] as const;

interface PrePushGuardDependencies {
  assertConsoleDependencies: (cwd: string) => void;
}

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
}

export function runPrePushGuard(
  input: string,
  cwd = process.cwd(),
  dependencies: PrePushGuardDependencies = { assertConsoleDependencies },
): PushDecision {
  const decision = classifyPrePushInput(input);
  const commands = commandsForDecision(decision);

  if (commands.length === 0) {
    console.error('pre-push guard: delete-only ref update; running metadata verification');
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

  dependencies.assertConsoleDependencies(cwd);

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
