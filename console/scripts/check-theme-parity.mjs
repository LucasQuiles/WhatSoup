#!/usr/bin/env node
// Theme parity check: every semantic token defined in the dark scope must also be
// defined in the light scope (and vice versa). Exits 1 on any mismatch.
// Consumed by design-regression.sh check 9 and runnable standalone:
//   node scripts/check-theme-parity.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/styles/tokens.semantic.css'), 'utf8');

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
