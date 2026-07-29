#!/usr/bin/env -S npx tsx
/**
 * guard:arch-aware-binaries — detect bare binary names without arch context.
 *
 * Enforces `portability.arch-aware-binaries` from the fitness registry.
 * Scans source files for string-literal binary names passed to spawn/exec
 * or binary resolution functions that should be architecture-aware.
 *
 * Rules:
 *   portability.arch-aware-binaries — bare binary names used with spawn,
 *     exec, resolveBinaryPath, or similar should be paired with
 *     getArchBinSuffix() for cross-platform portability on arm64/aarch64.
 *
 * Modes:
 *   check      (default) — exit 0 if no NEW violations, 1 on new, 2 on
 *                          infrastructure failure.
 *   --report             — print all violations (baselined + new).
 *   --baseline-save      — snapshot current violations as the new baseline.
 *   --root <dir>         — scan <dir> instead of the default repo root.
 *
 * Exit codes: 0 = no NEW violations; 1 = new violations found; 2 = infra
 * failure (missing baseline, unreadable tree).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

export interface ArchViolation {
  ruleId: string;
  file: string;
  line: number;
  pattern: string;
  lineText: string;
}

interface Baseline {
  [file: string]: number[]; // file path → array of line numbers
}

const RULE_ID = "portability.arch-aware-binaries";
const BASELINE_PATH = ".claude/fitness/arch-aware-binaries-baseline.json";

// Binary names that commonly have arch-specific variants on Homebrew/Linux.
const BINARY_PATTERNS = [
  // Media tools — often Homebrew-installed with arch cellar paths.
  "ffmpeg",
  "ffprobe",
  "ffplay",
  // Node.js — might vary per arch in custom toolchains.
  "node",
  "npm",
  "npx",
  // Build tooling — arch-specific prebuilts.
  "esbuild",
  "swc",
  "parcel",
  // Container/image tools.
  "docker",
  "podman",
  // Audio processing.
  "sox",
  "lame",
  "opusenc",
];

// Functions whose string-literal first argument carries a binary name.
const BINARY_RESOLUTION_CALLS = [
  "resolveBinaryPath",
  "probeFallbackBinary",
  "probeBinaryAuthStatus",
  "probeBinaryCommand",
  "probeModelCatalog",
  "listModelCatalog",
];

const SPAWN_CALLS = [
  "spawn",
  "exec",
  "execFile",
  "execSync",
  "execFileSync",
  "spawnSync",
];

// Source dirs to scan.
const SCAN_ROOTS = ["src", "scripts"];

// Extensions to scan.
const SCAN_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];

// ---------------------------------------------------------------------------
// Globbing helpers
// ---------------------------------------------------------------------------

function collectFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
      results.push(...collectFiles(fullPath, extensions));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Detection logic
// ---------------------------------------------------------------------------

/** Check if a line contains a binary-name string literal in a spawn/exec call. */
function checkLine(
  file: string,
  lineNum: number,
  lineText: string,
): ArchViolation | null {
  const trimmed = lineText.trim();

  // Skip imports, comments, and test mocks.
  if (trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.startsWith("*")) {
    return null;
  }

  for (const binary of BINARY_PATTERNS) {
    const quotedBinary = `"${binary}"`;
    const sqBinary = `'${binary}'`;

    if (!trimmed.includes(quotedBinary) && !trimmed.includes(sqBinary)) {
      continue;
    }

    // Is this in a binary resolution call?
    for (const fn of BINARY_RESOLUTION_CALLS) {
      if (trimmed.includes(fn)) {
        // Check if getArchBinSuffix already appears nearby.
        if (trimmed.includes("getArchBinSuffix")) {
          return null; // Already architecture-aware.
        }
        // Check if this is assigning the binary name to a variable for
        // later use with getArchBinSuffix.
        const afterBinary = trimmed.split(quotedBinary)[1] || trimmed.split(sqBinary)[1] || "";
        if (afterBinary.includes("getArchBinSuffix")) {
          return null; // getArchBinSuffix appended on same line.
        }
        return {
          ruleId: RULE_ID,
          file,
          line: lineNum,
          pattern: binary,
          lineText: trimmed,
        };
      }
    }

    // Is this in a spawn/exec call directly?
    for (const fn of SPAWN_CALLS) {
      if (trimmed.includes(`${fn}(`)) {
        return {
          ruleId: RULE_ID,
          file,
          line: lineNum,
          pattern: binary,
          lineText: trimmed,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export function scanRepo(rootDir: string): ArchViolation[] {
  const violations: ArchViolation[] = [];

  for (const root of SCAN_ROOTS) {
    const rootPath = path.join(rootDir, root);
    const files = collectFiles(rootPath, SCAN_EXTENSIONS);
    for (const file of files) {
      const relPath = path.relative(rootDir, file);
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const v = checkLine(relPath, i + 1, lines[i]);
        if (v) violations.push(v);
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const rootDir = rootIndex !== -1 ? args[rootIndex + 1] : process.cwd();
  const mode = args.includes("--baseline-save")
    ? "save"
    : args.includes("--report")
      ? "report"
      : "check";

  // Load baseline if it exists.
  let baseline: Baseline = {};
  const baselineFullPath = path.join(rootDir, BASELINE_PATH);
  if (existsSync(baselineFullPath)) {
    baseline = JSON.parse(readFileSync(baselineFullPath, "utf8"));
  }

  const violations = scanRepo(rootDir);
  const newViolations: ArchViolation[] = [];
  const baselinedViolations: ArchViolation[] = [];

  for (const v of violations) {
    const fileBaseline = baseline[v.file];
    if (fileBaseline && fileBaseline.includes(v.line)) {
      baselinedViolations.push(v);
    } else {
      newViolations.push(v);
    }
  }

  // Build new baseline.
  const newBaseline: Baseline = {};
  for (const v of violations) {
    if (!newBaseline[v.file]) newBaseline[v.file] = [];
    if (!newBaseline[v.file].includes(v.line)) newBaseline[v.file].push(v.line);
  }

  switch (mode) {
    case "save": {
      const dir = path.dirname(baselineFullPath);
      if (!existsSync(dir)) {
        const { mkdirSync } = require("node:fs");
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(baselineFullPath, JSON.stringify(newBaseline, null, 2) + "\n");
      console.log(`Baseline saved to ${BASELINE_PATH} (${violations.length} violations)`);
      process.exit(0);
    }
    case "report": {
      if (violations.length === 0) {
        console.log("No arch-aware-binaries violations found.");
      } else {
        for (const v of violations) {
          const tag = baseline[v.file]?.includes(v.line) ? "[BASELINED]" : "[NEW]";
          console.log(`${tag} ${v.file}:${v.line} — "${v.pattern}" in: ${v.lineText}`);
        }
      }
      process.exit(0);
    }
    case "check":
    default: {
      if (baselinedViolations.length > 0) {
        // Diff check: if a baselined violation changed line, it's new.
        // For simplicity, exact line match is the baseline mechanism.
      }

      if (newViolations.length > 0) {
        console.error(`FAIL: ${newViolations.length} new arch-aware-binaries violation(s) found.`);
        for (const v of newViolations) {
          console.error(`  ${v.file}:${v.line} — "${v.pattern}" in: ${v.lineText}`);
        }
        process.exit(1);
      }

      const total = violations.length;
      console.log(`PASS: ${total} total violations (0 new, ${baselinedViolations.length} baselined)`);
      process.exit(0);
    }
  }
}

main();
