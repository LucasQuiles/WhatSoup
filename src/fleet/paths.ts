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
