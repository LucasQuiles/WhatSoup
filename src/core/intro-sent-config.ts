import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

function privateWriteError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function assertWritablePrivateConfigPath(configPath: string): void {
  const dirStat = lstatSync(dirname(configPath));
  if (dirStat.isSymbolicLink()) {
    throw privateWriteError('refusing to use private config directory through symlink', 'ELOOP');
  }
  if (!dirStat.isDirectory()) {
    throw privateWriteError('refusing to use private config directory over non-directory path', 'EINVAL');
  }

  const fileStat = lstatSync(configPath);
  if (fileStat.isSymbolicLink()) {
    throw privateWriteError('refusing to write config.json through symlink', 'ELOOP');
  }
  if (!fileStat.isFile()) {
    throw privateWriteError('refusing to write config.json over non-regular path', 'EINVAL');
  }
}

function writePrivateConfigFileSync(configPath: string, data: string): void {
  assertWritablePrivateConfigPath(configPath);

  const flags = constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(configPath, flags, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write config.json over non-regular path', 'EINVAL');
    }
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, data, { encoding: 'utf-8' });
    fchmodSync(fd, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function persistIntroSentFlag(configPath: string, introSent: boolean): void {
  assertWritablePrivateConfigPath(configPath);
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  raw.introSent = introSent;
  writePrivateConfigFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
}
