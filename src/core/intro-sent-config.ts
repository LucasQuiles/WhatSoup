import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

  const tmpPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(tmpPath, flags, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw privateWriteError('refusing to write config.json over non-regular path', 'EINVAL');
    }
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data, { encoding: 'utf-8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    assertWritablePrivateConfigPath(configPath);
    renameSync(tmpPath, configPath);
    renamed = true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup; preserve the original config over tmp removal errors.
      }
    }
  }
}

function readPrivateConfigFileSync(configPath: string): string {
  assertWritablePrivateConfigPath(configPath);

  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number | undefined;
  try {
    fd = openSync(configPath, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw privateWriteError('refusing to read config.json from non-regular path', 'EINVAL');
    }
    return readFileSync(fd, 'utf-8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function persistIntroSentFlag(configPath: string, introSent: boolean): void {
  const raw = JSON.parse(readPrivateConfigFileSync(configPath)) as Record<string, unknown>;
  raw.introSent = introSent;
  writePrivateConfigFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
}
