/**
 * Console-usage allowlist ratchet — pins the exact set of sanctioned raw
 * console.* sites in src/ instead of a bare count ceiling (#2209).
 *
 * WhatSoup routes operator-visible diagnostics through Pino (`src/logger.ts`)
 * and human-facing CLI text through the redacting seam `src/lib/cli-print.ts`.
 * A raw console call in production code bypasses both surfaces: it is invisible
 * to the structured log pipeline, unredacted (it can leak secrets the logger
 * would scrub), and unattributed (no level / instance / module metadata).
 *
 * The only sanctioned survivors are the logger's own transport-failure
 * fallbacks — the one place that cannot report through itself. Each survivor
 * line must carry a `console-allowed:` justification marker on the same line
 * or the line above, and the per-file counts are pinned exactly, so a new
 * site, a moved site, or an unjustified site all fail closed.
 *
 * History: baseline 31 on main b8e1cbc0d; auth.ts's 21 sites migrated to
 * process.stderr.write with structured log twins (#2930), 31 -> 10; the #2209
 * sweep migrated the remaining CLI/bootstrap sites through cli-print and
 * dropped the standalone duplicates, 10 -> 2.
 *
 * Companion: #2209.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = resolve(repoRoot, 'src');

// Method-reference-aware: matches bare `console.error` handed off as a
// callback as well as direct calls, so the whole class stays closed.
const CONSOLE_METHOD_PATTERN = /\bconsole\.(log|warn|error|info|debug|trace)\b/;

// The exact sanctioned raw-console surface, pinned per file. Changing this
// list is a conscious act reviewed with the diff that motivates it.
const ALLOWLIST: Record<string, number> = {
  // Logger-internal transport-failure fallbacks: pino cannot self-report
  // when its own sink fails to construct or errors asynchronously.
  'src/logger.ts': 2,
};

const JUSTIFICATION_MARKER = 'console-allowed:';

function collectSrcFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => resolve(d.parentPath || srcRoot, d.name));
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

interface ConsoleSite {
  file: string;
  line: number;
  text: string;
  justified: boolean;
}

function collectConsoleSites(): ConsoleSite[] {
  const sites: ConsoleSite[] = [];
  for (const file of collectSrcFiles()) {
    const relative = file.replace(repoRoot + '/', '');
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Prose comments may legitimately mention the pattern; only code counts.
      if (isCommentLine(line)) continue;
      if (!CONSOLE_METHOD_PATTERN.test(line)) continue;
      const justified =
        line.includes(JUSTIFICATION_MARKER)
        || (i > 0 && lines[i - 1].includes(JUSTIFICATION_MARKER));
      sites.push({ file: relative, line: i + 1, text: line.trim(), justified });
    }
  }
  return sites;
}

describe('console-usage allowlist ratchet', () => {
  it('every raw console.* site in src/ is on the pinned allowlist', () => {
    const sites = collectConsoleSites();
    const byFile = new Map<string, ConsoleSite[]>();
    for (const site of sites) {
      const bucket = byFile.get(site.file) ?? [];
      bucket.push(site);
      byFile.set(site.file, bucket);
    }

    const actual: Record<string, number> = {};
    for (const [file, fileSites] of [...byFile.entries()].sort()) {
      actual[file] = fileSites.length;
    }

    const detail = sites
      .map((s) => `  ${s.file}:${s.line}  ${s.text.slice(0, 90)}`)
      .join('\n');
    expect(
      actual,
      'Raw console usage outside the pinned allowlist. Route operator '
        + 'diagnostics through src/logger.ts (Pino) and human-facing CLI text '
        + `through src/lib/cli-print.ts.\n\nCurrent sites:\n${detail}`,
    ).toEqual(ALLOWLIST);
  });

  it('every allowed site carries a justification marker', () => {
    const unjustified = collectConsoleSites().filter((s) => !s.justified);
    expect(
      unjustified.map((s) => `${s.file}:${s.line}`),
      `Each sanctioned raw console site needs a "${JUSTIFICATION_MARKER}" `
        + 'comment on the same line or the line above.',
    ).toEqual([]);
  });

  it('counting methodology scans .ts files under src/ (smoke)', () => {
    // If discovery ever returns zero sites the scanner itself is broken —
    // the logger fallbacks are permanent residents.
    expect(collectConsoleSites().length).toBeGreaterThan(0);
  });
});
