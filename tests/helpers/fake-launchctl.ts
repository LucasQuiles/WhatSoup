import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// A recorder that stands in for `launchctl` in tests that spawn a deploy script. The script looks the command up on
// PATH, so a test that passes `path` below decides what the service manager answers: a sandboxed test host refuses an
// exec of the real one, and a developer Mac answers it from its own login session.
export interface FakeLaunchctl {
  /** PATH for the child process: the recorder's folder first, then the given PATH. */
  readonly path: string;
  /** The argument list of every call, space-joined, in call order. */
  calls(): string[];
}

export function installFakeLaunchctl(root: string, basePath = process.env.PATH ?? '/usr/bin:/bin'): FakeLaunchctl {
  const binDir = join(root, 'fake-launchctl-bin');
  const log = join(root, 'fake-launchctl-calls.log');
  mkdirSync(binDir, { recursive: true });
  const command = join(binDir, 'launchctl');
  writeFileSync(command, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$1" in',
    // A host with no job loaded: `list` prints its header only, `print` of a label exits 113 as launchctl does.
    "  list) printf 'PID\\tStatus\\tLabel\\n'; exit 0 ;;",
    "  *) printf 'Could not find service\\n' >&2; exit 113 ;;",
    'esac',
    '',
  ].join('\n'));
  chmodSync(command, 0o700);
  return {
    path: `${binDir}${delimiter}${basePath}`,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : []),
  };
}
