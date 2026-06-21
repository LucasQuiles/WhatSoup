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
import {
  acquireProcessLock,
  releaseProcessLock,
  type ProcessLockHandle,
} from '../lib/process-lock.ts';
import { privateWriteError } from '../lib/private-fs.ts';

export type PrivateConfigRecord = Record<string, unknown>;

export function privateConfigLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

export function assertWritablePrivateConfigPath(configPath: string): void {
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

function removeLegacyConfigTmpPath(configPath: string): void {
  const legacyTmpPath = `${configPath}.tmp`;
  try {
    const stat = lstatSync(legacyTmpPath);
    if (stat.isSymbolicLink()) {
      throw privateWriteError('refusing to write config.json through symlinked tmp path', 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError('refusing to replace config tmp over non-regular path', 'EINVAL');
    }
    unlinkSync(legacyTmpPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function writePrivateConfigFileSync(configPath: string, data: string): void {
  assertWritablePrivateConfigPath(configPath);
  removeLegacyConfigTmpPath(configPath);

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

export function readPrivateConfigFileSync(configPath: string): string {
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

export function withPrivateConfigLockSync<T>(
  configPath: string,
  fn: () => T,
): T {
  assertWritablePrivateConfigPath(configPath);

  let lock: ProcessLockHandle | undefined;
  try {
    lock = acquireProcessLock(privateConfigLockPath(configPath));
    return fn();
  } finally {
    if (lock) releaseProcessLock(lock);
  }
}

export function mutatePrivateConfigFileSync(
  configPath: string,
  mutate: (config: PrivateConfigRecord) => PrivateConfigRecord | void,
): PrivateConfigRecord {
  return withPrivateConfigLockSync(configPath, () => {
    const raw = JSON.parse(readPrivateConfigFileSync(configPath)) as PrivateConfigRecord;
    const next = mutate(raw) ?? raw;
    writePrivateConfigFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
    return next;
  });
}
