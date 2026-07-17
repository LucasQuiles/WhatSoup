import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';

import { cleanGitEnv } from '../../../../src/lib/git-env.ts';
import { isRecord } from '../../../../src/lib/type-guards.ts';
import type { BoundaryValidationIssue, BoundaryValidationResult, BoundaryVerdict } from './model.ts';

export { isRecord };

export function issue(code: string, message: string, path?: string): BoundaryValidationIssue {
  return path === undefined ? { code, message } : { code, message, path };
}

export function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

export function requireExactObject(
  parent: Record<string, unknown>,
  key: string,
  expected: readonly string[],
  issues: BoundaryValidationIssue[],
): void {
  const value = parent[key];
  if (!isRecord(value) || !hasExactKeys(value, expected)) {
    issues.push(issue(`invalid-${key}-keys`, `${key} keys must be exactly: ${expected.join(', ')}`, key));
  }
}

export function requireExactRecord(
  value: unknown,
  expected: readonly string[],
  issues: BoundaryValidationIssue[],
  code: string,
  path: string,
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, expected)) {
    issues.push(issue(code, `${path} keys must be exactly: ${expected.join(', ')}`, path));
    return false;
  }
  return true;
}

export function requireRows(
  value: unknown,
  expected: readonly string[],
  issues: BoundaryValidationIssue[],
  code: string,
  path: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    issues.push(issue(code, `${path} must be an array`, path));
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const [index, row] of value.entries()) {
    if (requireExactRecord(row, expected, issues, code, `${path}[${index}]`)) rows.push(row);
  }
  return rows;
}


export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function isSafePath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > 1_024) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function check(condition: boolean, issues: BoundaryValidationIssue[], code: string, path: string): void {
  if (!condition) issues.push(issue(code, `${path} violates the closed wire contract`, path));
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function gitBytes(cwd: string, args: readonly string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function gitText(cwd: string, args: readonly string[]): string {
  return gitBytes(cwd, args).toString('utf8').trim();
}

export function isOperationalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

export function isBoundedText(value: unknown, maxBytes = 4_096): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

export function isVerdict(value: unknown): value is BoundaryVerdict {
  return value === 'Pass' || value === 'Fail' || value === 'Inconclusive' || value === 'Blocked';
}

export function hasDirectStatus(rawExit: unknown, rawSignal: unknown, expectedExit: number | null = null): boolean {
  const exitValid = Number.isInteger(rawExit) && Number(rawExit) >= 0 && Number(rawExit) <= 255;
  const signalValid = typeof rawSignal === 'string' && /^SIG[A-Z0-9]+$/.test(rawSignal);
  if (Number(exitValid) + Number(signalValid) !== 1) return false;
  return expectedExit === null || (rawExit === expectedExit && rawSignal === null);
}

export function snapshotResult(issues: BoundaryValidationIssue[]): BoundaryValidationResult {
  return {
    ok: issues.length === 0,
    exitCode: issues.length === 0 ? 0 : 1,
    verdict: issues.length === 0 ? 'Pass' : 'Inconclusive',
    issues,
  };
}

export function isSortedUniqueStrings(
  value: unknown,
  predicate: (entry: string) => boolean,
): value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !predicate(entry))) return false;
  const sorted = [...value].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  return new Set(value).size === value.length
    && canonicalizeBoundaryRun(value) === canonicalizeBoundaryRun(sorted);
}

export function durableExclusiveWrite(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const descriptor = openSync(filePath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
      .map(([key, nested]) => [key, sortCanonical(nested)]),
  );
}

export function canonicalizeBoundaryRun(value: unknown): string {
  return `${JSON.stringify(sortCanonical(value))}\n`;
}
