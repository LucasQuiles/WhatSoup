import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = path.join(repoRoot, 'scripts', 'ci-disk-reclaim.sh');
const tmp = trackTmpDirs('whatsoup-ci-disk-');
const budgetKib = 30 * 1024 * 1024;
const allowlistedPaths = [
  '/usr/share/dotnet',
  '/opt/ghc',
  '/usr/local/lib/android',
  '/usr/local/share/boost',
  '/opt/hostedtoolcache/CodeQL',
];

interface ActionReceipt {
  kind: 'remove' | 'docker_prune';
  target: string;
  outcome: 'succeeded' | 'failed';
}

interface DiskReceipt {
  schema_version: 1;
  budget_kib: number;
  free_before_kib: number | null;
  free_after_kib: number | null;
  exit_class: 'sufficient_space' | 'reclaimed' | 'insufficient_space' | 'inconclusive';
  skipped: boolean;
  partial_failure: boolean;
  error?: string;
  actions: ActionReceipt[];
}

interface RunOptions {
  dfSequence: string[];
  sudoFailTarget?: string;
  dockerExit?: number;
  budget?: string;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  receipt: DiskReceipt | null;
  commands: string[];
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, 'utf8');
  chmodSync(filePath, 0o755);
}

function parseReceipt(stdout: string): DiskReceipt | null {
  try {
    return JSON.parse(stdout.trim()) as DiskReceipt;
  } catch {
    return null;
  }
}

function runHelper(options: RunOptions): RunResult {
  const fixture = tmp.make('reclaim');
  const binDir = path.join(fixture, 'bin');
  mkdirSync(binDir);

  const commandLog = path.join(fixture, 'commands.log');
  const dfSequence = path.join(fixture, 'df-sequence.txt');
  const dfIndex = path.join(fixture, 'df-index.txt');
  writeFileSync(commandLog, '', 'utf8');
  writeFileSync(dfSequence, `${options.dfSequence.join('\n')}\n`, 'utf8');

  writeExecutable(
    path.join(binDir, 'df'),
    `#!/usr/bin/env bash
set -u
printf 'df %s\\n' "$*" >> "$COMMAND_LOG"
index=0
if [[ -f "$DF_INDEX_FILE" ]]; then
  IFS= read -r index < "$DF_INDEX_FILE"
fi
next=$((index + 1))
printf '%s\\n' "$next" > "$DF_INDEX_FILE"
entry=$(awk -v wanted="$next" 'NR == wanted { print; exit }' "$DF_SEQUENCE_FILE")
case "$entry" in
  EXIT:*) exit "\${entry#EXIT:}" ;;
  EMPTY) exit 0 ;;
  MALFORMED) printf 'not df output\\n' ;;
  NONNUMERIC)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
    printf '/dev/root 99999999 1 nope 1%% /\\n'
    ;;
  *)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
    printf '/dev/root 99999999 1 %s 1%% /\\n' "$entry"
    ;;
esac
`,
  );

  writeExecutable(
    path.join(binDir, 'sudo'),
    `#!/usr/bin/env bash
set -u
printf 'sudo' >> "$COMMAND_LOG"
printf ' %s' "$@" >> "$COMMAND_LOG"
printf '\\n' >> "$COMMAND_LOG"
target="\${!#}"
if [[ -n "\${SUDO_FAIL_TARGET:-}" && "$target" == "$SUDO_FAIL_TARGET" ]]; then
  exit 9
fi
exit 0
`,
  );

  writeExecutable(
    path.join(binDir, 'docker'),
    `#!/usr/bin/env bash
set -u
printf 'docker' >> "$COMMAND_LOG"
printf ' %s' "$@" >> "$COMMAND_LOG"
printf '\\n' >> "$COMMAND_LOG"
exit "\${DOCKER_EXIT:-0}"
`,
  );

  const result = spawnSync('/bin/bash', [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:/usr/bin:/bin`,
      COMMAND_LOG: commandLog,
      DF_SEQUENCE_FILE: dfSequence,
      DF_INDEX_FILE: dfIndex,
      CI_DISK_RECLAIM_BUDGET_KIB: options.budget ?? '',
      SUDO_FAIL_TARGET: options.sudoFailTarget ?? '',
      DOCKER_EXIT: String(options.dockerExit ?? 0),
    },
  });

  return {
    status: result.status ?? 2,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt: parseReceipt(result.stdout),
    commands: readFileSync(commandLog, 'utf8').split('\n').filter(Boolean),
  };
}

describe('CI disk reclaim helper', () => {
  it('uses the default 30 GiB budget and skips every mutation when space is sufficient', () => {
    const result = runHelper({ dfSequence: [String(budgetKib)] });

    expect(result.status, result.stderr).toBe(0);
    expect(result.receipt).toEqual({
      schema_version: 1,
      budget_kib: budgetKib,
      free_before_kib: budgetKib,
      free_after_kib: budgetKib,
      exit_class: 'sufficient_space',
      skipped: true,
      partial_failure: false,
      actions: [],
    });
    expect(result.commands).toEqual(['df -Pk /']);
  });

  it.each(['EMPTY', 'MALFORMED', 'NONNUMERIC'])(
    'fails closed without mutation when the initial df output is %s',
    (dfOutput) => {
      const result = runHelper({ dfSequence: [dfOutput] });

      expect(result.status, result.stderr).toBe(2);
      expect(result.receipt).toMatchObject({
        exit_class: 'inconclusive',
        skipped: true,
        partial_failure: false,
        error: 'df_initial_malformed',
        actions: [],
      });
      expect(result.commands).toEqual(['df -Pk /']);
    },
  );

  it('fails closed without mutation when the initial df command fails', () => {
    const result = runHelper({ dfSequence: ['EXIT:7'] });

    expect(result.status, result.stderr).toBe(2);
    expect(result.receipt).toMatchObject({
      exit_class: 'inconclusive',
      skipped: true,
      error: 'df_initial_failed',
      actions: [],
    });
    expect(result.commands).toEqual(['df -Pk /']);
  });

  it('invokes only the exact allowlisted paths, prunes Docker, and records every action', () => {
    const result = runHelper({
      dfSequence: ['1024', String(budgetKib + 1)],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.receipt).toMatchObject({
      budget_kib: budgetKib,
      free_before_kib: 1024,
      free_after_kib: budgetKib + 1,
      exit_class: 'reclaimed',
      skipped: false,
      partial_failure: false,
    });
    expect(result.receipt?.actions).toEqual([
      { kind: 'remove', target: '/usr/share/dotnet', outcome: 'succeeded' },
      { kind: 'remove', target: '/opt/ghc', outcome: 'succeeded' },
      { kind: 'remove', target: '/usr/local/lib/android', outcome: 'succeeded' },
      { kind: 'remove', target: '/usr/local/share/boost', outcome: 'succeeded' },
      { kind: 'remove', target: '/opt/hostedtoolcache/CodeQL', outcome: 'succeeded' },
      { kind: 'docker_prune', target: 'docker-images', outcome: 'succeeded' },
    ]);
    expect(result.commands.filter((line) => line.startsWith('sudo '))).toEqual([
      'sudo rm -rf -- /usr/share/dotnet',
      'sudo rm -rf -- /opt/ghc',
      'sudo rm -rf -- /usr/local/lib/android',
      'sudo rm -rf -- /usr/local/share/boost',
      'sudo rm -rf -- /opt/hostedtoolcache/CodeQL',
    ]);
    expect(result.commands.filter((line) => line.startsWith('docker '))).toEqual([
      'docker image prune --all --force',
    ]);
  });

  it('succeeds with a visible partial failure when the final budget is met', () => {
    const result = runHelper({
      dfSequence: ['1024', String(budgetKib)],
      sudoFailTarget: '/opt/ghc',
      dockerExit: 5,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.receipt).toMatchObject({
      exit_class: 'reclaimed',
      skipped: false,
      partial_failure: true,
      free_after_kib: budgetKib,
    });
    expect(result.receipt?.actions).toEqual(expect.arrayContaining([
      { kind: 'remove', target: '/opt/ghc', outcome: 'failed' },
      { kind: 'docker_prune', target: 'docker-images', outcome: 'failed' },
    ]));
  });

  it('returns insufficient_space when cleanup completes below budget', () => {
    const result = runHelper({
      dfSequence: ['1024', String(budgetKib - 1)],
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.receipt).toMatchObject({
      exit_class: 'insufficient_space',
      skipped: false,
      partial_failure: false,
      free_before_kib: 1024,
      free_after_kib: budgetKib - 1,
    });
  });

  it('returns inconclusive with action evidence when the final df command fails', () => {
    const result = runHelper({
      dfSequence: ['1024', 'EXIT:8'],
    });

    expect(result.status, result.stderr).toBe(2);
    expect(result.receipt).toMatchObject({
      exit_class: 'inconclusive',
      skipped: false,
      error: 'df_final_failed',
      free_before_kib: 1024,
      free_after_kib: null,
    });
    expect(result.receipt?.actions).toEqual(expect.arrayContaining([
      { kind: 'remove', target: '/usr/local/share/boost', outcome: 'succeeded' },
      { kind: 'docker_prune', target: 'docker-images', outcome: 'succeeded' },
    ]));
  });

  it('rejects an invalid budget before probing or mutation', () => {
    const result = runHelper({
      dfSequence: [String(budgetKib)],
      budget: 'thirty',
    });

    expect(result.status, result.stderr).toBe(2);
    expect(result.receipt).toMatchObject({
      exit_class: 'inconclusive',
      skipped: true,
      error: 'budget_invalid',
      actions: [],
    });
    expect(result.commands).toEqual([]);
  });

  it('contains the exact allowlist and no masked failure operator', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const source = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';

    for (const allowedPath of allowlistedPaths) {
      expect(source).toContain(allowedPath);
    }
    expect(source).not.toContain('CI_DISK_RECLAIM_PATH_EXISTS_CMD');
    expect(source).not.toContain('|| true');
  });
});
