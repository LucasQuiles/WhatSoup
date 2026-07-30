import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the WhatSoup repository root.
 *
 * Resolved from this module's own location so it is stable regardless of
 * `process.cwd()`. Child processes spawned by the fleet server (auth bootstrap,
 * docker supervisor) must use this anchor — under systemd the unit has no
 * `WorkingDirectory=` and `process.cwd()` falls back to `$HOME`, which makes
 * relative `src/bootstrap*.ts` paths ENOENT (#419).
 */
export const repoRoot: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const isDarwin = os.platform() === 'darwin';

export function xdgDir(envKey: string, fallbackSuffix: string): string {
  const value = process.env[envKey];
  return value ? value : path.join(os.homedir(), fallbackSuffix);
}

/**
 * macOS app support root — avoids dotfile clutter in $HOME.
 * Uses ~/Library/Application Support/ (Apple HIG) instead of XDG ~/.config.
 * When XDG_* env vars are explicitly set they still take priority (compat).
 */
function macOsAppSupportDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'whatsoup');
}
function macOsCachesDir(): string {
  return path.join(os.homedir(), 'Library', 'Caches', 'whatsoup');
}

export function configRoot(): string {
  if (isDarwin && !process.env.XDG_CONFIG_HOME) {
    return path.join(macOsAppSupportDir(), 'instances');
  }
  return path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'whatsoup', 'instances');
}

export function dataRoot(name: string): string {
  if (isDarwin && !process.env.XDG_DATA_HOME) {
    return path.join(macOsAppSupportDir(), 'instances', name);
  }
  return path.join(xdgDir('XDG_DATA_HOME', '.local/share'), 'whatsoup', 'instances', name);
}

export function tmpRoot(name: string): string {
  if (isDarwin && !process.env.XDG_DATA_HOME) {
    return path.join(macOsCachesDir(), 'tmp', name);
  }
  return path.join(xdgDir('XDG_DATA_HOME', '.local/share'), 'whatsoup', 'tmp', name);
}

export function stateRoot(name: string): string {
  if (isDarwin && !process.env.XDG_STATE_HOME) {
    return path.join(macOsAppSupportDir(), 'instances', name);
  }
  return path.join(xdgDir('XDG_STATE_HOME', '.local/state'), 'whatsoup', 'instances', name);
}

export interface InstancePaths {
  configRoot: string;
  dataRoot: string;
  stateRoot: string;
  authDir: string;
  dbPath: string;
  logDir: string;
  lockPath: string;
  mediaDir: string;
  tmpDir: string;
}

export function instancePaths(name: string): InstancePaths {
  const cfg = path.join(configRoot(), name);
  const data = dataRoot(name);
  const state = stateRoot(name);

  return {
    configRoot: cfg,
    dataRoot: data,
    stateRoot: state,
    authDir: path.join(cfg, 'auth'),
    dbPath: path.join(data, 'bot.db'),
    logDir: path.join(data, 'logs'),
    lockPath: path.join(state, 'whatsoup.lock'),
    mediaDir: path.join(data, 'media', 'tmp'),
    tmpDir: tmpRoot(name),
  };
}
