/**
 * Static guard: no direct secret-env reads outside the resolver modules.
 *
 * Enforces the env-secret-exposure handoff's Verification criterion:
 *   "Static guard fails on direct reads of protected provider or runtime
 *    credential environment variables outside resolver/test/dev allowlists."
 *
 * (docs/security-handoffs/2026-05-09-env-secret-exposure.md, Verification §)
 *
 * The guard scans `src/` for direct `process.env.<SECRET>` reads and fails
 * when a read appears outside an allowlisted file. The allowlist is the
 * minimal set of modules that legitimately need direct env access:
 *   - The resolver modules themselves (keyring.ts, api-key-resolver.ts,
 *     provider-key-service.ts) — these ARE the resolver.
 *   - The W-4 child-env forwarding site (session.ts) — not yet migrated;
 *     tracked as W-4 in the handoff. Each line is allowlisted explicitly.
 *   - The model-advisor live-scan site — temporary, until #1801 merges.
 *
 * When a provider is migrated through resolveApiKey() (W-2), its direct
 * reads disappear and no allowlist entry is needed. The guard prevents
 * regressions: a new direct read added after migration will fail this test.
 *
 * Convention: mirrors tests/scripts/orphan-export-guard.test.ts
 * (filesystem-scanning vitest fitness test; discovered by the default
 * vitest-run include glob "tests/**\/*.test.ts"; no package.json script).
 *
 * Part of docs/security-handoffs/2026-05-09-env-secret-exposure.md.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { SERVICE_ENV_MAP } from '../../src/lib/provider-key-service.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SCAN_DIR = 'src';

/** The secret env var names protected by this guard. */
const PROTECTED_SECRET_ENV_VARS = [...new Set([
  ...Object.values(SERVICE_ENV_MAP),
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
])];

/**
 * Files that are ALLOWED to read the protected env vars directly because
 * they ARE the resolver layer. All other src/ files must route through
 * resolveApiKey() or lookupCredential().
 */
const RESOLVER_MODULE_ALLOWLIST = new Set<string>([
  'src/lib/keyring.ts',
  'src/lib/api-key-resolver.ts',
  'src/lib/provider-key-service.ts',
]);

/**
 * Explicit per-line allowlist for known-not-yet-migrated sites.
 * Format: `repo-relative-path:lineNumber`.
 *
 * Each entry MUST cite the tracking phase (W-x) or PR that will remove it.
 * When that phase lands, the entry must be deleted — a stale entry is a
 * silent-pass bug (the guard stops catching regressions at that site).
 */
const LINE_ALLOWLIST = new Map<string, string>([
  // Currently empty: every previously-tracked direct-read site has been migrated
  // through resolveApiKey()/lookupCredential() and has landed on main —
  //   • src/lib/model-advisor.ts        (W-2, #1801)
  //   • src/runtimes/agent/session.ts   buildChildEnv (W-4, #1808)
  // Re-add an entry (`path:line` + tracking W-x/PR) ONLY for a NEW not-yet-migrated
  // direct read; a stale entry is a silent-pass bug (see the no-stale-allowlist test).
]);

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/');
}

/** Recursively collect `.ts` files under `dir`, excluding tests and .d.ts. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Check whether a line is a comment (// or * prefix after trimming).
 * Block-comment lines starting with ` *` and inline `//` comments are excluded.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

interface Violation {
  file: string;
  line: number;
  envVar: string;
  source: string;
}

function scanForDirectSecretReads(): Violation[] {
  const violations: Violation[] = [];
  const scanAbs = resolve(REPO_ROOT, SCAN_DIR);
  const files = collectTsFiles(scanAbs);

  // Match process.env.VAR_NAME or process.env['VAR_NAME'] for the protected vars.
  // We use a broad regex and then filter to the protected set.
  const envReadRe = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g;

  for (const file of files) {
    const relPath = repoRelative(file);

    // Skip resolver modules entirely — they are the allowlisted resolver layer.
    if (RESOLVER_MODULE_ALLOWLIST.has(relPath)) continue;

    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip comment lines.
      if (isCommentLine(line)) continue;

      // Find all process.env reads on this line.
      envReadRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = envReadRe.exec(line)) !== null) {
        const envVar = match[1] ?? match[2];
        if (!envVar) continue;

        // Only flag protected secret env vars.
        if (!(PROTECTED_SECRET_ENV_VARS as readonly string[]).includes(envVar)) continue;

        // Check line-level allowlist.
        const allowKey = `${relPath}:${lineNum}`;
        if (LINE_ALLOWLIST.has(allowKey)) continue;

        violations.push({
          file: relPath,
          line: lineNum,
          envVar,
          source: line.trim(),
        });
      }
    }
  }

  return violations;
}

describe('Static guard: no direct secret-env reads outside resolver modules', () => {
  it('no src/ file outside the resolver layer reads a protected secret env var directly', () => {
    const violations = scanForDirectSecretReads();

    const formatted = violations.map(
      (v) => `  • ${v.file}:${v.line} reads process.env.${v.envVar} — ${v.source}`,
    );

    expect(
      violations,
      `Direct secret-env reads detected outside the resolver layer:\n${formatted.join('\n')}\n\n` +
        `Route through resolveApiKey() or lookupCredential() instead. ` +
        `If this is a known-not-yet-migrated site, add it to LINE_ALLOWLIST ` +
        `in tests/scripts/secret-env-read-guard.test.ts with a tracking citation.`,
    ).toEqual([]);
  }, 60_000);

  it('LINE_ALLOWLIST entries still reference real violations (no stale allowlist)', () => {
    // Build the set of current violations INCLUDING allowlisted lines.
    const scanAbs = resolve(REPO_ROOT, SCAN_DIR);
    const files = collectTsFiles(scanAbs);
    const envReadRe = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])/g;
    const currentReads = new Set<string>();

    for (const file of files) {
      const relPath = repoRelative(file);
      if (RESOLVER_MODULE_ALLOWLIST.has(relPath)) continue;
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isCommentLine(line)) continue;
        envReadRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = envReadRe.exec(line)) !== null) {
          const envVar = match[1] ?? match[2];
          if (!envVar) continue;
          if ((PROTECTED_SECRET_ENV_VARS as readonly string[]).includes(envVar)) {
            currentReads.add(`${relPath}:${i + 1}`);
          }
        }
      }
    }

    const stale = [...LINE_ALLOWLIST.keys()].filter((key) => !currentReads.has(key));
    expect(
      stale,
      `Stale LINE_ALLOWLIST entries — the direct read was removed (migration landed?) ` +
        `but the allowlist entry was not. Delete: ${stale.join(', ')}`,
    ).toEqual([]);
  }, 60_000);
});
