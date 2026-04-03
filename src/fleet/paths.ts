import * as path from 'node:path';
import * as os from 'node:os';

export function xdgDir(envKey: string, fallbackSuffix: string): string {
  return process.env[envKey] ?? path.join(os.homedir(), fallbackSuffix);
}

export function configRoot(): string {
  return path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'whatsoup', 'instances');
}

export function dataRoot(name: string): string {
  return path.join(xdgDir('XDG_DATA_HOME', '.local/share'), 'whatsoup', 'instances', name);
}

export function stateRoot(name: string): string {
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
  };
}
