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
type RootPackageJson = { overrides?: Record<string, unknown> };
type ExactVersion = readonly [number, number, number];

// GHSA-q2hr-2g5m-vwhr fixes for the reviewed v1 and v5 release lines.
const reviewedSafeFloors = new Map<number, readonly [number, number, number]>([
  [1, [1, 1, 21]],
  [5, [5, 0, 12]],
]);

function hasReviewedSafeVersion(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;

  const parsed = match.slice(1).map(Number) as [number, number, number];
  if (!parsed.every(Number.isSafeInteger)) return false;

  const floor = reviewedSafeFloors.get(parsed[0]);
  if (!floor) return false;

  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index] !== floor[index]) return parsed[index]! > floor[index]!;
  }
  return true;
}

function readLockPackages(lockfilePath: string): Record<string, LockPackage> {
  const lockfile = JSON.parse(
    readFileSync(path.join(repoRoot, lockfilePath), 'utf8'),
  ) as PackageLock;
  if (!lockfile.packages || Array.isArray(lockfile.packages)) {
    throw new Error(`${lockfilePath} does not contain a package-lock packages map`);
  }

  return lockfile.packages;
}

function rootMusicMetadataOverride(): unknown {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as RootPackageJson;
  return manifest.overrides?.['music-metadata'];
}

function parseExactVersion(version: unknown): ExactVersion | null {
  if (typeof version !== 'string') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return null;

  const parsed: ExactVersion = [
    Number(match[1]!),
    Number(match[2]!),
    Number(match[3]!),
  ];
  return parsed.every(Number.isSafeInteger) ? parsed : null;
}

function compareExactVersions(left: ExactVersion, right: ExactVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

function findUnapprovedBraceExpansionNodes(lockfilePath: string): string[] {
  return Object.entries(readLockPackages(lockfilePath))
    .filter(([packagePath]) =>
      packagePath === 'node_modules/brace-expansion'
      || packagePath.endsWith('/node_modules/brace-expansion'))
    .filter(([, metadata]) => !hasReviewedSafeVersion(metadata.version))
    .map(([packagePath, metadata]) =>
      `${lockfilePath}:${packagePath}@${String(metadata.version)}`)
    .sort();
}

const musicMetadataAdvisories = [
  { id: 'GHSA-f94x-6692-553q', affects: (version: ExactVersion) => compareExactVersions(version, [11, 16, 0]) < 0 },
  { id: 'GHSA-53v6-4h7p-p4gj', affects: (version: ExactVersion) => compareExactVersions(version, [11, 12, 3]) <= 0 },
  { id: 'GHSA-jjpr-9cvf-cq55', affects: (version: ExactVersion) => compareExactVersions(version, [11, 12, 3]) <= 0 },
  { id: 'GHSA-5gfj-9q3v-qfp3', affects: (version: ExactVersion) => compareExactVersions(version, [11, 16, 0]) < 0 },
  { id: 'GHSA-8j4c-6x6g-rq3j', affects: (version: ExactVersion) => compareExactVersions(version, [11, 14, 0]) <= 0 },
] as const;

function affectedMusicMetadataAdvisories(version: unknown): string[] {
  const parsed = parseExactVersion(version);
  if (!parsed) return ['unparseable-version'];
  return musicMetadataAdvisories.filter((advisory) => advisory.affects(parsed)).map((advisory) => advisory.id);
}

function findAffectedMusicMetadataNodes(lockfilePath: string): string[] {
  return Object.entries(readLockPackages(lockfilePath))
    .filter(([packagePath]) => packagePath === 'node_modules/music-metadata' || packagePath.endsWith('/node_modules/music-metadata'))
    .flatMap(([packagePath, metadata]) => {
      const affected = affectedMusicMetadataAdvisories(metadata.version);
      return affected.length === 0
        ? []
        : [`${lockfilePath}:${packagePath}@${String(metadata.version)} (${affected.join(', ')})`];
    })
    .sort();
}

describe('dependency security lock policy', () => {
  it('retains the exact reviewed root music-metadata override', () => {
    expect(rootMusicMetadataOverride()).toBe('11.16.1');
    expect(readLockPackages('package-lock.json')['node_modules/music-metadata']?.version).toBe('11.16.1');
  });

  it('recognizes every reviewed music-metadata advisory range', () => {
    expect(affectedMusicMetadataAdvisories('11.12.3')).toEqual([
      'GHSA-f94x-6692-553q',
      'GHSA-53v6-4h7p-p4gj',
      'GHSA-jjpr-9cvf-cq55',
      'GHSA-5gfj-9q3v-qfp3',
      'GHSA-8j4c-6x6g-rq3j',
    ]);
    expect(affectedMusicMetadataAdvisories('11.14.0')).toEqual([
      'GHSA-f94x-6692-553q',
      'GHSA-5gfj-9q3v-qfp3',
      'GHSA-8j4c-6x6g-rq3j',
    ]);
    expect(affectedMusicMetadataAdvisories('11.15.0')).toEqual([
      'GHSA-f94x-6692-553q',
      'GHSA-5gfj-9q3v-qfp3',
    ]);
    expect(affectedMusicMetadataAdvisories('11.16.0')).toEqual([]);
  });

  it('keeps every tracked lockfile free of affected music-metadata nodes', () => {
    const findings = lockfiles.flatMap(findAffectedMusicMetadataNodes);
    expect(findings).toEqual([]);
  });

  it('rejects affected and unreviewed brace-expansion versions', () => {
    expect([
      '1.1.15',
      '1.1.16',
      '1.1.18',
      '1.1.19',
      '1.1.20',
      '2.1.2',
      '3.0.2',
      '4.0.1',
      '5.0.5',
      '5.0.6',
      '5.0.7',
      '5.0.9',
      '5.0.10',
      '5.0.11',
      '5.0.12-beta.1',
      '6.0.0',
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
      '1.1.21',
      '1.2.0',
      '5.0.12',
      '5.1.0',
    ].every(hasReviewedSafeVersion)).toBe(true);
  });

  it('keeps every tracked lockfile free of affected brace-expansion nodes', () => {
    const findings = lockfiles.flatMap(findUnapprovedBraceExpansionNodes);
    expect(findings).toEqual([]);
  });

  it('does not retain the unpatched braces parser through installation tooling', () => {
    const findings = lockfiles.flatMap((lockfilePath) => {
      return Object.keys(readLockPackages(lockfilePath))
        .filter((packagePath) => packagePath === 'node_modules/braces' || packagePath.endsWith('/node_modules/braces'))
        .map((packagePath) => `${lockfilePath}:${packagePath}`);
    });
    expect(findings).toEqual([]);
  });
});
