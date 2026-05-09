import { lstatSync } from 'node:fs';

export interface SelfSecretCheck {
  path: string;
  mode: number;
}

export interface SelfSecretWidened {
  path: string;
  expectedMode: number;
  actualMode: number;
}

export interface SelfSecretResult {
  ok: boolean;
  widened: SelfSecretWidened[];
}

export function checkSelfSecrets(checks: SelfSecretCheck[]): SelfSecretResult {
  const widened: SelfSecretWidened[] = [];

  for (const check of checks) {
    const actualMode = actualSecretMode(check.path);
    if (!modeIsAcceptable(actualMode, check.mode)) {
      widened.push({ path: check.path, expectedMode: check.mode, actualMode });
    }
  }

  return { ok: widened.length === 0, widened };
}

function actualSecretMode(path: string): number {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return -3;
    if (!stat.isFile()) return -2;
    return stat.mode & 0o777;
  } catch {
    return -1;
  }
}

function modeIsAcceptable(actualMode: number, expectedMode: number): boolean {
  if (actualMode < 0) return false;
  return (actualMode | expectedMode) === expectedMode;
}
