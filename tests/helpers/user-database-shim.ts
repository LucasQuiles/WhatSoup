import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Write a getent stand-in to `dir` that answers `getent passwd <this uid>` with an
 * entry whose home folder is `home`, and fails for anything else or when `home`
 * is null. The Linux release-drift wrapper looks nothing up: a test puts `dir`
 * first in PATH to show that such a getent does not change which label file the
 * wrapper reads.
 */
export function writeGetentShim(dir: string, home: string | null): void {
  const shim = path.join(dir, 'getent');
  writeFileSync(shim, home === null
    ? '#!/bin/sh\nexit 2\n'
    : [
      '#!/bin/sh',
      '[ "$1" = passwd ] && [ "$2" = "$(id -u)" ] || exit 2',
      `printf '%s\\n' 'user-a:x:1000:1000::${home}:/bin/sh'`,
      '',
    ].join('\n'));
  chmodSync(shim, 0o755);
}
