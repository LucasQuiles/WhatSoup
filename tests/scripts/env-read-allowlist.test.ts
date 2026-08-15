/**
 * process.env read allowlist ratchet (#2192 slice 0).
 *
 * WhatSoup's typed RuntimeConfig SSOT is src/config.ts: instance-config first,
 * env second, default last. A direct process.env access anywhere else bypasses
 * validation, typing, and the instance-config layer. This ratchet pins the
 * exact per-file baseline so new direct reads fail closed while the migration
 * slices retire the existing ones file by file (each migration edits the
 * allowlist down in the same diff).
 *
 * Counting convention mirrors tests/scripts/console-usage-budget.test.ts:
 * one site = one non-comment source line containing a process.env access
 * (reads, writes, and whole-object param-default references all count).
 * Per-file pins and reasons live in eslint-rules/env-read-allowlist.json
 * (the SSOT shared with the fitness/require-env-justification eslint
 * mirror); per-site env-allowed justifications arrive with slice 5b.
 *
 * Companion: #2192 (baseline audited at the #3235 landing tree). The
 * "#2192 slice 3c" / "#2192 s4 verdict" citations in the per-file reasons
 * resolve to docs/reviews/2192-env-read-migration-20260815/ (s3/s4 design
 * records with per-var grounds).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

const ENV_ACCESS_PATTERN = /process\.env/;

interface AllowlistRow {
  readonly file: string;
  readonly allowedUnmarkedSites: number;
  readonly reason: string;
}

// SSOT shared with the eslint warn mirror (#2192 slice 5a):
// eslint-rules/env-read-allowlist.json. This test stays the AUTHORITY — the
// lexical line-grain scan below is suppression-immune by construction; the
// eslint rule only mirrors these pins at editor latency. Fail closed on a
// malformed SSOT: a corrupt file must never read as "nothing allowed" (empty
// scan passes) nor as allow-everything.
const allowlistPath = resolve(repoRoot, 'eslint-rules/env-read-allowlist.json');
const allowlistRaw = JSON.parse(readFileSync(allowlistPath, 'utf8')) as { rows: AllowlistRow[] };
if (!Array.isArray(allowlistRaw.rows) || allowlistRaw.rows.length === 0) {
  throw new Error(`env-read-allowlist.json malformed: expected non-empty rows[] at ${allowlistPath}`);
}
for (const row of allowlistRaw.rows) {
  if (
    typeof row.file !== 'string' || row.file.length === 0
    || !Number.isInteger(row.allowedUnmarkedSites) || row.allowedUnmarkedSites <= 0
    || typeof row.reason !== 'string' || row.reason.length === 0
  ) {
    throw new Error(`env-read-allowlist.json malformed row: ${JSON.stringify(row)}`);
  }
}
const ALLOWLIST: Record<string, number> = Object.fromEntries(
  allowlistRaw.rows.map((row) => [row.file, row.allowedUnmarkedSites]),
);

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name));
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function collectEnvSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of collectSrcFiles()) {
    const relative = file.replace(repoRoot + '/', '');
    const lines = readFileSync(file, 'utf8').split('\n');
    let count = 0;
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      if (ENV_ACCESS_PATTERN.test(line)) count += 1;
    }
    if (count > 0) counts.set(relative, count);
  }
  return counts;
}

describe('process.env read allowlist ratchet', () => {
  it('every direct process.env access in src/ matches the pinned baseline exactly', () => {
    const actual = Object.fromEntries([...collectEnvSites().entries()].sort());
    const expected = Object.fromEntries(Object.entries(ALLOWLIST).sort());
    expect(
      actual,
      'Direct process.env access outside the pinned baseline. Route new '
        + 'values through the typed config (src/config.ts) or, for genuinely '
        + 'env-late seams, extend the allowlist consciously in the same diff.',
    ).toEqual(expected);
  });

  it('scanner sanity: the SSOT seam itself is present (smoke)', () => {
    // config.ts is the conversion layer and must always appear — if it ever
    // vanishes from the scan, the file discovery is broken, not the code.
    expect(collectEnvSites().get('src/config.ts')).toBeGreaterThan(0);
  });
});
