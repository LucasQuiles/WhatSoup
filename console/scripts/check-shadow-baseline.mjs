#!/usr/bin/env node
// Shadow-lint drift ceiling: per-rule warning counts may go DOWN but never UP.
// Compares the current shadow-lint run against the committed baseline.
//   node scripts/check-shadow-baseline.mjs           -> compare, exit 1 on any increase
//   node scripts/check-shadow-baseline.mjs --update  -> regenerate the baseline file
// The baseline is the C2 burn-down counter; lowering counts should be accompanied by
// a baseline update in the same commit so the ratchet only ever tightens.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const baselinePath = resolve(consoleRoot, 'lint-shadow-baseline.json');

let raw;
try {
  raw = execFileSync('npx', ['eslint', '.', '-c', 'eslint.config.shadow.mjs', '--format', 'json'], {
    cwd: consoleRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // eslint exits non-zero when errors (not warnings) exist; its stdout still carries the JSON
  if (err.stdout) raw = err.stdout;
  else throw err;
}

const results = JSON.parse(raw);
// Ratchet at rule x file granularity: a new violation in one file cannot be masked by
// removing an old violation elsewhere under the same rule bucket.
const counts = {};
for (const file of results) {
  const rel = file.filePath.startsWith(consoleRoot)
    ? file.filePath.slice(consoleRoot.length + 1)
    : file.filePath;
  for (const msg of file.messages) {
    // Shadow rules implemented as no-restricted-syntax selectors tag their messages
    // with a [soup/...] prefix — key the ratchet by that tag so each rule has its own ceiling.
    const tag = /^\[([a-z/-]+)[ \]]/.exec(msg.message ?? '')?.[1];
    const rule = tag ?? msg.ruleId ?? '(no-rule)';
    const key = `${rule} :: ${rel}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const total = Object.values(sorted).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify({ generated: 'shadow lint per-rule warning ceiling', total, rules: sorted }, null, 2) + '\n');
  console.log(`baseline updated: ${total} warnings across ${Object.keys(sorted).length} rules`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch {
  console.error(`FAIL: no baseline at ${baselinePath} — run with --update to create it`);
  process.exit(1);
}

let regressions = 0;
for (const [rule, count] of Object.entries(sorted)) {
  const ceiling = baseline.rules[rule] ?? 0;
  if (count > ceiling) {
    console.error(`FAIL: ${rule} -> ${count} warnings (ceiling ${ceiling}, +${count - ceiling})`);
    regressions += 1;
  }
}
const improved = Object.entries(baseline.rules).filter(([r, c]) => (sorted[r] ?? 0) < c);

if (regressions) {
  console.error(`\n${regressions} rule(s) exceeded the shadow baseline. New violations are not allowed; fix them or (for sanctioned scope) update the baseline in the same commit with a justification.`);
  process.exit(1);
}
console.log(`shadow baseline OK: ${total} warnings (ceiling ${baseline.total})`);
if (improved.length) {
  console.log(`note: ${improved.length} rule(s) are below their ceiling — consider ratcheting with --update:`);
  for (const [r, c] of improved) console.log(`  ${r}: ${sorted[r] ?? 0} < ${c}`);
}
