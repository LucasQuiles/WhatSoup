import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Write a getent stand-in to `dir` that answers `getent passwd <this uid>` with an
 * entry whose home folder is `home`, and fails for anything else or when `home`
 * is null. With `dir` first in PATH, the Linux release-drift wrapper finds the
 * home folder of its label file without the host's user database.
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
