/**
 * scripts/generate-catch-ratchet.mjs
 *
 * Regenerates eslint-rules/catch-ratchet-baseline.json — the ratchet allowlist of
 * every bare `catch {}` block (no bound variable, empty body, no justification
 * comment) currently in src/. The `require-catch-justification` ESLint rule reads
 * this baseline so it emits ZERO findings today; new bare catches are flagged.
 *
 * Usage: node scripts/generate-catch-ratchet.mjs
 *
 * Run this after fixing/removing bare catches to shrink the ratchet (the intended
 * per-sprint reduction). Commit the regenerated baseline.
 */
import { ESLint } from 'eslint';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import fitnessPlugin from '../eslint-rules/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = resolve(ROOT, 'eslint-rules/catch-ratchet-baseline.json');

// Run the rule with NO baseline (every bare catch is new → reported), then collect
// the reported location keys as the new baseline. This guarantees the keys match
// the exact AST locations the rule will check against at lint time.
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true, // ignore any eslint.config.* on disk; use overrideConfig only
  overrideConfig: {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: (await import('typescript-eslint')).parser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    plugins: { fitness: fitnessPlugin },
    rules: {
      'fitness/require-catch-justification': [
        'warn',
        // Force empty baseline path so EVERY bare catch is reported.
        { baselinePath: '/dev/null/nonexistent-baseline.json' },
      ],
    },
  },
});

const results = await eslint.lintFiles(['src/']);

const baseline = {};
let count = 0;
for (const result of results) {
  const rel = result.filePath.startsWith(ROOT)
    ? result.filePath.slice(ROOT.length + 1)
    : result.filePath;
  for (const msg of result.messages) {
    if (msg.ruleId !== 'fitness/require-catch-justification') continue;
    baseline[`${rel}:${msg.line}`] = true;
    count += 1;
  }
}

const sorted = {};
for (const key of Object.keys(baseline).sort()) sorted[key] = true;

writeFileSync(
  BASELINE_PATH,
  JSON.stringify(sorted, null, 0) + '\n',
);

console.error(
  `Wrote ${count} bare-catch location${count === 1 ? '' : 's'} to eslint-rules/catch-ratchet-baseline.json`,
);
