#!/usr/bin/env node
// scripts/ring-boundary-guard.ts
//
// Guard-ring promotion of `arch.ring-boundaries` (owner directive 2026-07-19,
// SSOT-enforcement ratchet amendment). The ESLint fitness ring has carried
// `fitness/ring-boundaries` at WARN since the rule landed — visible, never
// blocking. This guard runs the SAME rule (no fork: it lints `src/**/*.ts`
// through `eslint.config.fitness.mjs`, the registry-derived config) and
// ratchets the TOTAL finding count against
// `.claude/fitness/baseline.json` `rules["arch.ring-boundaries"].violationCount`
// (twin row in docs/architecture/fitness-taxonomy.md):
//
//   - count > baseline → FAIL (a new lower-ring → higher-ring import shipped).
//   - count < baseline → FAIL demanding both baseline twins be LOWERED in the
//     same commit (ratchet-down enforcement).
//   - count = baseline → pass. When the baseline reaches 0 this becomes a pure
//     block (at promotion time the count was 57 — a ratchet, NOT yet a pure block).
//
// SCOPE / LIMITS: identical to the ESLint rule's (eslint-rules/ring-boundaries.mjs)
// — it sees static/dynamic import specifiers resolvable to src/ ring paths;
// require() and runtime path assembly are out of scope. The count is TOTAL
// findings (per-edge identity is visible in the failure listing, but the
// ratchet grain is the count — a same-commit add+remove swap holds the count
// flat and is accepted, matching the file-size count-ratchet precedent).

import { ESLint } from 'eslint';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { evaluateRatchet, readBaselineCount, readTaxonomyDocCount, type RatchetVerdict } from './ssot-pattern-guard.ts';

export const RING_RULE_ID = 'arch.ring-boundaries';
const ESLINT_RULE_NAME = 'fitness/ring-boundaries';

export interface RingFinding {
  file: string;
  line: number;
  message: string;
}

export interface RingCountResult {
  count: number;
  findings: RingFinding[];
}

/**
 * Count `fitness/ring-boundaries` findings over `src/**` using the repo's
 * registry-derived fitness config (never a forked rule copy). `configRoot`
 * defaults to `cwd`; the companion test points `cwd` at a fixture tree while
 * keeping `configRoot` on the repo so the real config/plugin are exercised.
 */
export async function countRingViolations(
  cwd: string,
  configRoot: string = cwd,
): Promise<RingCountResult> {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: path.join(configRoot, 'eslint.config.fitness.mjs'),
    errorOnUnmatchedPattern: false,
  });
  const results = await eslint.lintFiles(['src/**/*.ts']);
  const findings: RingFinding[] = [];
  for (const result of results) {
    const rel = path.relative(cwd, result.filePath).split(path.sep).join('/');
    for (const m of result.messages) {
      if (m.fatal) {
        // Fail-closed: a parse failure must not silently shrink the count.
        throw new Error(`ring-boundary-guard: parse failure in ${rel}:${m.line ?? 0}: ${m.message}`);
      }
      if (m.ruleId === ESLINT_RULE_NAME) {
        findings.push({ file: rel, line: m.line ?? 0, message: m.message });
      }
    }
  }
  return { count: findings.length, findings };
}

export interface RingGuardResult {
  verdict: RatchetVerdict;
  findings: RingFinding[];
  twinDocMismatch: string | null;
  ok: boolean;
}

export async function runRingGuard(
  cwd: string,
  configRoot: string = cwd,
  ratchetRoot: string = configRoot,
): Promise<RingGuardResult> {
  const { count, findings } = await countRingViolations(cwd, configRoot);
  const baseline = readBaselineCount(ratchetRoot, RING_RULE_ID);
  const verdict = evaluateRatchet(
    RING_RULE_ID,
    count,
    baseline,
    'move the shared contract downward or route through an approved service boundary (see eslint-rules/ring-boundaries.mjs)',
  );
  const docCount = readTaxonomyDocCount(ratchetRoot, RING_RULE_ID);
  let twinDocMismatch: string | null = null;
  if (baseline !== undefined && docCount !== baseline) {
    twinDocMismatch =
      `${RING_RULE_ID}: twin-doc mismatch — baseline.json says ${baseline}, ` +
      `fitness-taxonomy.md count row says ${docCount ?? 'MISSING'}; the two must move together`;
  }
  return {
    verdict,
    findings,
    twinDocMismatch,
    ok: verdict.status === 'ok' && twinDocMismatch === null,
  };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  let result: RingGuardResult;
  try {
    result = await runRingGuard(cwd);
  } catch (err) {
    console.error(`ring-boundary-guard FAILED to run: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (result.ok) {
    console.log(`ring-boundary-guard: ${result.verdict.message}`);
    return;
  }
  console.error(`ring-boundary-guard: ${result.verdict.message}`);
  if (result.verdict.status === 'above-baseline') {
    for (const f of result.findings) {
      console.error(`  ${f.file}:${f.line} ${f.message}`);
    }
  }
  if (result.twinDocMismatch) {
    console.error(`ring-boundary-guard: ${result.twinDocMismatch}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
