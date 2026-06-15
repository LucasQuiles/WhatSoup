#!/usr/bin/env node
// Theme parity check: every semantic token defined in the dark scope must also be
// defined in the light scope (and vice versa). Exits 1 on any mismatch.
// Consumed by design-regression.sh check 9 and runnable standalone:
//   node scripts/check-theme-parity.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Default target is the semantic token file. `--file <path>` points the SAME
// parser at a fixture so the parity logic is testable without touching prod
// tokens; with no flag, cssPath is byte-identical to the original default.
const fileArgIndex = process.argv.indexOf('--file');
const cssPath = fileArgIndex !== -1 && process.argv[fileArgIndex + 1]
  ? resolve(process.argv[fileArgIndex + 1])
  : resolve(here, '../src/styles/tokens.semantic.css');
const css = readFileSync(cssPath, 'utf8');

// Capture the body of each theme scope block. Dark is declared as `:root,\n[data-theme="dark"]`
// (possibly multiple blocks); light as `[data-theme="light"]`.
function scopeTokens(scopeMatcher) {
  const tokens = new Set();
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const selector = m[1].trim();
    if (!scopeMatcher(selector)) continue;
    for (const tok of m[2].matchAll(/--([a-z0-9-]+)\s*:/g)) tokens.add(tok[1]);
  }
  return tokens;
}

const dark = scopeTokens((s) => s.includes('[data-theme="dark"]'));
const light = scopeTokens((s) => s.includes('[data-theme="light"]'));

// Fail-closed on an empty scan. If BOTH scopes parsed zero tokens, the target was
// renamed/emptied/parse-broken (or the [data-theme] selectors changed shape) — the
// parity diff below would vacuously pass ("OK: 0 semantic tokens"). A one-sided empty
// is still caught by the mismatch logic (every token of the non-empty scope is reported
// missing → exit 1). Exit 2 distinguishes this structural fault from a parity mismatch.
if (dark.size === 0 && light.size === 0) {
  console.error(`FAIL: no theme-scoped tokens parsed from ${cssPath} — empty or unparseable scan (expected dark + light [data-theme] blocks). Refusing to report parity on an empty scan.`);
  process.exit(2);
}

const missingInLight = [...dark].filter((t) => !light.has(t)).sort();
const missingInDark = [...light].filter((t) => !dark.has(t)).sort();

if (missingInLight.length || missingInDark.length) {
  if (missingInLight.length) {
    console.error(`FAIL: ${missingInLight.length} token(s) defined in dark but missing in light:`);
    for (const t of missingInLight) console.error(`  --${t}`);
  }
  if (missingInDark.length) {
    console.error(`FAIL: ${missingInDark.length} token(s) defined in light but missing in dark:`);
    for (const t of missingInDark) console.error(`  --${t}`);
  }
  process.exit(1);
}

console.log(`theme parity OK: ${dark.size} semantic tokens defined in both dark and light scopes`);
