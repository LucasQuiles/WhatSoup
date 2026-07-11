import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const lockfiles = [
  'package-lock.json',
  'console/package-lock.json',
  'tools/whatsoup_guard/package-lock.json',
] as const;

type LockPackage = { version?: unknown };
type PackageLock = { packages?: Record<string, LockPackage> };

// CVE-2026-13149 is fixed in the v1 backport and v5 mainline releases below.
const reviewedSafeFloors = new Map<number, readonly [number, number, number]>([
  [1, [1, 1, 16]],
  [5, [5, 0, 7]],
]);

function hasReviewedSafeVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;

  const parsed = match.slice(1).map(Number) as [number, number, number];
  if (!parsed.every(Number.isSafeInteger)) return false;
  if (parsed[0] > 5) return true;

  const floor = reviewedSafeFloors.get(parsed[0]);
  if (!floor) return false;

  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index] !== floor[index]) return parsed[index]! > floor[index]!;
  }
  return true;
}

function findUnapprovedBraceExpansionNodes(lockfilePath: string): string[] {
  const lockfile = JSON.parse(
    readFileSync(path.join(repoRoot, lockfilePath), 'utf8'),
  ) as PackageLock;
  if (!lockfile.packages || Array.isArray(lockfile.packages)) {
    throw new Error(`${lockfilePath} does not contain a package-lock packages map`);
  }

  return Object.entries(lockfile.packages)
    .filter(([packagePath]) =>
      packagePath === 'node_modules/brace-expansion'
      || packagePath.endsWith('/node_modules/brace-expansion'))
    .filter(([, metadata]) => !hasReviewedSafeVersion(metadata.version))
    .map(([packagePath, metadata]) =>
      `${lockfilePath}:${packagePath}@${String(metadata.version)}`)
    .sort();
}

describe('dependency security lock policy', () => {
  it('rejects affected and unreviewed brace-expansion versions', () => {
    expect([
      '1.1.15',
      '2.1.2',
      '3.0.2',
      '4.0.1',
      '5.0.5',
      '5.0.6',
      '5.0.7-beta.1',
      '01.2.0',
      '1.1.016',
      '5.00.7',
      '05.000.007',
      '9007199254740992.0.0',
      undefined,
    ].filter(hasReviewedSafeVersion)).toEqual([]);
  });

  it('accepts reviewed patched brace-expansion release lines', () => {
    expect([
      '1.1.16',
      '1.2.0',
      '5.0.7',
      '5.1.0',
      '6.0.0',
    ].every(hasReviewedSafeVersion)).toBe(true);
  });

  it('keeps every tracked lockfile free of affected brace-expansion nodes', () => {
    const findings = lockfiles.flatMap(findUnapprovedBraceExpansionNodes);
    expect(findings).toEqual([]);
  });
});
