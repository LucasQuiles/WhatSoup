import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { isRecord } from '../../src/lib/type-guards.ts';
import { parseTestCounts } from '../test-affected.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const testPath = z.string().regex(/^tests\/[^\\\0]+\.test\.tsx?$/)
  .refine((file) => file.split('/').every((part) => part !== '.' && part !== '..' && part !== ''));
const identitySchema = z.object({
  executionId: z.string().uuid(), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  inputDigest: digest, dependencyDigest: digest, configDigest: digest,
  root: z.string().refine(isAbsolute), node: z.string().regex(/^v(?:24|25)\.\d+\.\d+$/),
  vitest: z.literal('4.1.11'), platform: z.enum(['darwin', 'linux']),
  arch: z.enum(['arm64', 'x64']), workers: z.number().int().min(1).max(4),
}).strict();
const planSchema = z.object({
  schemaVersion: z.literal(1), identity: identitySchema,
  shards: z.array(z.array(testPath).min(1)).length(2),
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal(1), planDigest: digest, identity: identitySchema,
  index: z.number().int().min(1).max(2), outcome: z.string(), exitCode: z.number().int(),
  blobPath: z.string(), reportPath: z.string(), blobSha256: digest, reportSha256: digest,
}).strict();

export type CoverageRunIdentity = z.infer<typeof identitySchema>;
export type CoverageShardPlan = z.infer<typeof planSchema>;
export type CoverageShardReceipt = z.infer<typeof receiptSchema>;

export function parseCoveragePlan(value: unknown): CoverageShardPlan {
  const plan = planSchema.parse(value);
  balanceCoverageFiles(plan.shards.flat(), {});
  return plan;
}

export function coveragePlanDigest(plan: CoverageShardPlan): string {
  return createHash('sha256').update(JSON.stringify(planSchema.parse(plan))).digest('hex');
}

export function balanceCoverageFiles(files: readonly string[], durations: Readonly<Record<string, number>>): string[][] {
  if (files.length < 2) throw new Error('Coverage selection needs at least two files');
  if (new Set(files).size !== files.length) throw new Error('Coverage selection has duplicate files');
  if (files.some((file) => !testPath.safeParse(file).success)) throw new Error('Coverage selection has an unsafe test path');
  const measured = Object.values(durations);
  if (measured.some((duration) => !Number.isFinite(duration) || duration < 0)) throw new Error('Invalid coverage duration');
  const fallback = measured.length ? Math.max(1, measured.reduce((sum, duration) => sum + duration, 0) / measured.length) : 1;
  const estimate = (file: string): number => Math.max(1, durations[file] ?? fallback);
  const shards: string[][] = [[], []];
  const totals = [0, 0];
  for (const file of [...files].sort((a, b) => estimate(b) - estimate(a) || a.localeCompare(b))) {
    const index = totals[0]! <= totals[1]! ? 0 : 1;
    shards[index]!.push(file);
    totals[index]! += estimate(file);
  }
  return shards;
}

/** Reports are owned execution artifacts, never URLs or symlinks into another run. */
export function readCoverageArtifact(path: string, expectedHash?: string, maximumBytes = 256 * 1024 * 1024): Buffer {
  const before = lstatSync(path);
  if (!isAbsolute(path) || !before.isFile() || before.size === 0 || before.size > maximumBytes) {
    throw new Error(`Invalid coverage artifact: ${path}`);
  }
  const unchanged = (after: typeof before) => after.isFile() && before.ino === after.ino && before.dev === after.dev
    && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!unchanged(fstatSync(descriptor))) throw new Error(`Coverage artifact changed before read: ${path}`);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const result = bytes.subarray(0, length);
    if (length !== before.size || !unchanged(fstatSync(descriptor)) || !unchanged(lstatSync(path))
      || (expectedHash !== undefined && createHash('sha256').update(result).digest('hex') !== expectedHash)) {
      throw new Error(`Coverage artifact hash mismatch: ${path}`);
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function repositoryPath(root: string, path: string): string {
  const name = relative(root, path);
  if (!isAbsolute(path) || resolve(path) !== path || name === '' || name.startsWith('..') || isAbsolute(name)) {
    throw new Error(`Coverage report path is outside its execution root: ${path}`);
  }
  return name;
}

function coverageFiles(report: unknown, root: string): string[] {
  if (!isRecord(report) || !isRecord(report.coverageMap) || Object.keys(report.coverageMap).length === 0) {
    throw new Error('Coverage report has missing or empty coverage');
  }
  for (const [path, entry] of Object.entries(report.coverageMap)) {
    if (!repositoryPath(root, path).startsWith('src/') || !isRecord(entry) || entry.path !== path) {
      throw new Error('Coverage report has foreign or invalid coverage');
    }
    for (const [countsKey, mapKey] of [['s', 'statementMap'], ['f', 'fnMap'], ['b', 'branchMap']] as const) {
      const counts = entry[countsKey];
      const map = entry[mapKey];
      if (!isRecord(counts) || !isRecord(map) || JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify(Object.keys(map).sort())) {
        throw new Error('Coverage report has partial coverage counters');
      }
      for (const value of Object.values(counts)) {
        const hits = countsKey === 'b' && Array.isArray(value) ? value : [value];
        if (hits.some((hit) => typeof hit !== 'number' || !Number.isFinite(hit) || hit < 0)) {
          throw new Error('Coverage report has invalid coverage counters');
        }
      }
    }
  }
  return Object.keys(report.coverageMap).sort();
}

export function validateCoverageShards(rawPlan: unknown, rawReceipts: readonly unknown[]) {
  const plan = planSchema.parse(rawPlan);
  const allFiles = plan.shards.flat();
  balanceCoverageFiles(allFiles, {});
  if (rawReceipts.length !== 2) throw new Error('Expected exactly 2 coverage shards');
  const expectedDigest = coveragePlanDigest(plan);
  const seen = new Set<number>();
  const artifacts = new Set<string>();
  const blobs: string[] = [];
  let scope: string[] | undefined;
  const tests = { total: 0, passed: 0, failed: 0, pending: 0, todo: 0 };
  for (const raw of rawReceipts) {
    const parsed = receiptSchema.safeParse(raw);
    if (!parsed.success) throw new Error('Invalid coverage shard identity or receipt', { cause: parsed.error });
    const receipt = parsed.data;
    if (seen.has(receipt.index)) throw new Error(`Duplicate coverage shard ${receipt.index}`);
    seen.add(receipt.index);
    if (receipt.planDigest !== expectedDigest || JSON.stringify(receipt.identity) !== JSON.stringify(plan.identity)) {
      throw new Error(`Coverage shard ${receipt.index} identity mismatch`);
    }
    if (receipt.outcome !== 'passed' || receipt.exitCode !== 0) throw new Error(`Coverage shard ${receipt.index} is not successful`);
    for (const path of [receipt.blobPath, receipt.reportPath]) {
      const canonical = realpathSync(path);
      if (artifacts.has(canonical)) throw new Error('Duplicate coverage artifact');
      artifacts.add(canonical);
    }
    readCoverageArtifact(receipt.blobPath, receipt.blobSha256);
    const report: unknown = JSON.parse(readCoverageArtifact(receipt.reportPath, receipt.reportSha256).toString('utf8'));
    const counts = parseTestCounts(report);
    if (counts.failed > 0) throw new Error(`Coverage shard ${receipt.index} contains failed tests`);
    if (counts.passed === 0) throw new Error(`Coverage shard ${receipt.index} has no executed passing tests`);
    if (!isRecord(report) || !Array.isArray(report.testResults)) throw new Error('Missing coverage test inventory');
    const actual = report.testResults.map((file: unknown) => {
      if (!isRecord(file) || typeof file.name !== 'string') throw new Error('Invalid coverage test inventory');
      return repositoryPath(plan.identity.root, file.name);
    }).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...plan.shards[receipt.index - 1]!].sort())) {
      throw new Error(`Coverage shard ${receipt.index} test inventory mismatch`);
    }
    const currentScope = coverageFiles(report, plan.identity.root);
    if (scope && JSON.stringify(scope) !== JSON.stringify(currentScope)) throw new Error('Coverage shard scope mismatch');
    scope = currentScope;
    for (const key of Object.keys(tests) as (keyof typeof tests)[]) tests[key] += counts[key];
    blobs[receipt.index - 1] = receipt.blobPath;
  }
  return { blobPaths: blobs, coverageFiles: scope!, tests };
}
