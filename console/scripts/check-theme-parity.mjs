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
// Strip CSS comments before scanning. The block regex below captures `selector { body }`
// pairs; without stripping, a comment containing `[data-theme="dark"]{--x:1}` is read as a
// real block and injects phantom tokens into a scope. That would let a 95%-broken file (where
// only a comment survives) compare phantom-vs-phantom and vacuously pass. [adversarial Hole 1]
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const DARK_SEL = '[data-theme="dark"]';
const LIGHT_SEL = '[data-theme="light"]';

// Single pass over every `selector { body }` block: collect token NAMES per scope, and
// separately record whether a *theme-specific* block (matches one theme but not the other)
// carried any tokens. The specific-block flags are the structural anchor — the live token
// file also ships a shared `:root,[data-theme="dark"],[data-theme="light"]` alias block, and
// that shared block ALONE would satisfy a naive parity check (identical dark/light sets) even
// if both real per-theme blocks were emptied/renamed. Requiring a dark-specific AND a
// light-specific block refuses to certify that degenerate scan. [adversarial Hole 2/3]
const dark = new Set();
const light = new Set();
let sawDarkSpecific = false;
let sawLightSpecific = false;
const blockRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = blockRe.exec(css)) !== null) {
  const selector = m[1].trim();
  const isDark = selector.includes(DARK_SEL);
  const isLight = selector.includes(LIGHT_SEL);
  if (!isDark && !isLight) continue;
  const names = [...m[2].matchAll(/--([a-z0-9-]+)\s*:/g)].map((t) => t[1]);
  if (isDark) for (const n of names) dark.add(n);
  if (isLight) for (const n of names) light.add(n);
  if (names.length) {
    if (isDark && !isLight) sawDarkSpecific = true;
    if (isLight && !isDark) sawLightSpecific = true;
  }
}

// Fail-closed on an empty/degenerate scan (exit 2, distinct from the exit-1 parity mismatch
// below). A missing theme-specific block means the file was emptied/renamed/parse-broken or
// its per-theme blocks were lost — the parity diff would otherwise vacuously pass.
if (!sawDarkSpecific || !sawLightSpecific) {
  const which = !sawDarkSpecific ? 'dark' : 'light';
  console.error(`FAIL: theme-parity scan of ${cssPath} found no ${which}-specific [data-theme] token block — the file is empty, renamed, parse-broken, or its per-theme blocks were lost (a shared :root/dark/light alias block alone is not sufficient). Refusing to report parity on a degenerate scan.`);
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
