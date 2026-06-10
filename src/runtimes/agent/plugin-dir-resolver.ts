// src/runtimes/agent/plugin-dir-resolver.ts
// Version-resilient plugin-dir resolution.
//
// Per-instance `agentOptions.pluginDirs` may pin a version directory, e.g.
//   ~/.claude/plugins/superpowers/5.0.7
// Running `claude plugin update` bumps that to 5.1.0 and removes 5.0.7, so the
// pinned path disappears and the `--plugin-dir` flag silently points at a
// non-existent directory. To stay resilient we substitute the highest-version
// sibling when the configured directory is gone but its parent still holds
// version-like siblings.
//
// This module is a pure helper (filesystem-read only). It never throws: on any
// error it returns the original path unchanged so resolution degrades safely.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** A semver-like triple parsed from a directory name (e.g. "5.0.7"). */
interface ParsedVersion {
  raw: string;
  parts: number[];
}

// Matches a leading dotted numeric version: "5", "5.0", "5.0.7", "5.0.7-rc1".
// We only compare the numeric prefix; pre-release suffixes sort lower than the
// equivalent release per the conservative rule below.
const VERSION_DIR_RE = /^(\d+)(?:\.(\d+))*(?:[-+].*)?$/;

/** Parse a directory name into a comparable version, or null if not version-like. */
function parseVersionDir(name: string): ParsedVersion | null {
  if (!VERSION_DIR_RE.test(name)) return null;
  const numeric = name.split(/[-+]/, 1)[0]!;
  const parts = numeric.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const hasPrerelease = /[-+]/.test(name);
  // Encode a pre-release flag as a trailing element: release (1) sorts above
  // pre-release (0) when the numeric prefix is identical.
  return { raw: name, parts: [...parts, hasPrerelease ? 0 : 1] };
}

/** Compare two parsed versions. Returns >0 when `a` is newer than `b`. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const len = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i++) {
    const av = a.parts[i] ?? 0;
    const bv = b.parts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Resolve a plugin directory to its latest existing version sibling.
 *
 * - If `dir` exists, it is returned unchanged.
 * - Otherwise, if `dir`'s parent exists and contains version-like
 *   subdirectories, the highest-version sibling is returned.
 * - Otherwise the original `dir` is returned unchanged.
 *
 * Never throws; any filesystem error yields the original `dir`.
 */
export function resolveLatestPluginDir(dir: string): string {
  try {
    if (existsSync(dir)) return dir;

    const parent = dirname(dir);
    if (!existsSync(parent)) return dir;

    // Only substitute when the configured leaf itself looks like a version dir;
    // a non-version path that is simply missing should not be silently rerouted.
    if (parseVersionDir(basename(dir)) === null) return dir;

    let best: ParsedVersion | null = null;
    for (const entry of readdirSync(parent)) {
      const parsed = parseVersionDir(entry);
      if (parsed === null) continue;
      const full = join(parent, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (best === null || compareVersions(parsed, best) > 0) {
        best = parsed;
      }
    }

    if (best === null) return dir;
    return join(parent, best.raw);
  } catch {
    return dir;
  }
}
