import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

// A recorder that stands in for `launchctl` in tests that spawn a deploy script. The script looks the command up on
// PATH, so a test that passes `path` below decides what the service manager answers: a sandboxed test host refuses an
// exec of the real one, and a developer Mac answers it from its own login session.
export interface FakeLaunchctl {
  /** PATH for the child process: the recorder's folder first, then the given PATH. */
  readonly path: string;
  /**
   * The argument list of every call, space-joined, in the order the lines were appended to the log (not the order the
   * calls started, when several run at once). Empty means the recorder never ran: installation proved it can log.
   */
  calls(): string[];
}

const SELF_CHECK = '__fake-launchctl-self-check__';

function readLog(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : [];
}

export function installFakeLaunchctl(root: string, basePath = process.env.PATH ?? '/usr/bin:/bin'): FakeLaunchctl {
  // A delimiter inside the folder name would split it into two PATH entries, and the lookup could reach the real one.
  if (root.includes(delimiter)) {
    throw new Error(`fake launchctl: the root folder contains the PATH delimiter "${delimiter}": ${JSON.stringify(root)}`);
  }
  const binDir = resolve(root, 'fake-launchctl-bin');
  const command = resolve(binDir, 'launchctl');
  const log = resolve(binDir, 'calls.log');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(command, [
    '#!/bin/sh',
    // The log sits beside this command. Its path comes from "$0" at run time, never from shell source, so no folder
    // name can break the quoting; `${0%/*}` needs no external command on the child's PATH.
    "printf '%s\\n' \"$*\" >> \"${0%/*}/calls.log\"",
    'case "$1" in',
    `  ${SELF_CHECK}) exit 0 ;;`,
    // A host with no job loaded: `list` prints its header only, `print` of a label exits 113 as launchctl does.
    "  list) printf 'PID\\tStatus\\tLabel\\n'; exit 0 ;;",
    "  *) printf 'Could not find service\\n' >&2; exit 113 ;;",
    'esac',
    '',
  ].join('\n'));
  chmodSync(command, 0o700);
  // A recorder that cannot log would make every "no call" assertion pass for the wrong reason: prove it logs, then
  // start the log empty.
  const check = spawnSync(command, [SELF_CHECK], { encoding: 'utf8' });
  if (check.status !== 0 || readLog(log).join('\n') !== SELF_CHECK) {
    throw new Error(`fake launchctl: the recorder did not log its self-check (status ${String(check.status)})`);
  }
  writeFileSync(log, '');
  return {
    path: `${binDir}${delimiter}${basePath}`,
    calls: () => readLog(log),
  };
}
