#!/usr/bin/env node
// console/scripts/check-design-burndown.mjs
//
// SELF-FEEDING DESIGN BURNDOWN — queue generator + fail-closed ratchet.
//
// Every run rebuilds the live burndown queue (design-burndown-queue.json) from:
//   (a) lint-shadow-baseline.json — the ESLint shadow ratchet's rule×file counts,
//       rolled up into one queue item per category. CONSUMED, never re-counted:
//       the shadow ratchet (check-shadow-baseline.mjs) owns TSX-side enforcement.
//   (b) CSS-side scans for what ESLint cannot see (lint-plan §1 rg-script territory,
//       adoption-audit.md §6 census methodology):
//         legacy-var-css  — var(--<legacy-alias>) refs in console/src/styles/*.css.
//                           The legacy-name list is DERIVED from the alias-layer
//                           definitions (tokens.semantic.css "Legacy aliases" block),
//                           same derivation as adoption-audit.md §6 — names hardcoded
//                           nowhere, counts hardcoded nowhere.
//         accent-law      — action-control selectors binding status-channel colors
//                           (adoption-audit.md F1: .c-btn-primary → var(--color-s-ok))
//                           plus accent-color: declarations using status tokens (M9).
//         raw-color-css   — raw hex/rgb()/hsl()/oklch() literals in console/src CSS
//                           outside the token-definition tiers (allowlist:
//                           tokens.primitive.css + tokens.semantic.css, the only files
//                           permitted to own raw color values per tokens-v3 §1/§3).
//         raw-font-size-css — raw font-size/font shorthand declarations in non-token
//                           CSS; component and composite CSS must consume the type
//                           scale instead.
//         transition-all-css — CSS transition shorthands/longhands that target "all";
//                           CSS must name explicit properties, same as the TSX rule.
//         raw-dimension-css — direct raw length units in layout/spacing/radius CSS
//                           declarations outside token files; var() fallbacks are ignored
//                           so resilient token fallbacks do not dominate the signal.
//         half-step       — var(--sp-0h/--sp-1h/--sp-2h) usage outside their
//                           definitions, across CSS *and* TSX/TS (DD-9 feed; the
//                           half-steps have no ESLint rule, so both sides live here).
//
// NOTE on overlap: accent-law occurrences that use legacy alias names (e.g.
// var(--color-s-ok)) also appear in legacy-var-css. Intentional — they are two
// different remediation lenses (B4 law fix vs B1 vocabulary burn); the ratchet
// tracks each category independently.
//
// Ratchet semantics (fall-only discipline, same as check-shadow-baseline.mjs):
//   node scripts/check-design-burndown.mjs            -> --check (default; never writes)
//     * any category count ABOVE design-burndown-baseline.json -> exit 1, naming the
//       category, the delta, and the offending new file:lines (diffed against the
//       committed queue).
//     * any category count BELOW baseline -> exit 1: "ratchet fall — run with
//       --update to lower the baseline".
//     * counts equal but queue content drifted (violations moved) -> exit 1: queue
//       drift — run with --update.
//   node scripts/check-design-burndown.mjs --update   -> rewrites baseline AND queue
//       together, exit 0.
//
// Fail-closed: any missing input file, malformed JSON, unparseable CSS, or failed
// derivation RAISES with a named ERROR(...) and exit 1 — never silently returns
// empty. No timestamps, no randomness: same tree = same bytes.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// DESIGN_BURNDOWN_CONSOLE_ROOT lets tests redirect path resolution to a temp-dir
// fixture (same pattern as DESIGN_METRICS_CONSOLE_ROOT in design-metrics.mjs).
const consoleRoot = process.env.DESIGN_BURNDOWN_CONSOLE_ROOT ?? resolve(here, '..');

const shadowBaselinePath = resolve(consoleRoot, 'lint-shadow-baseline.json');
const burndownBaselinePath = resolve(consoleRoot, 'design-burndown-baseline.json');
const queuePath = resolve(consoleRoot, 'design-burndown-queue.json');
const stylesDir = resolve(consoleRoot, 'src', 'styles');
const srcDir = resolve(consoleRoot, 'src');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const updateMode = args.includes('--update');
for (const a of args) {
  if (a !== '--update' && a !== '--check') {
    process.stderr.write(`ERROR(args): unknown argument "${a}" (allowed: --check, --update)\n`);
    process.exit(1);
  }
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function readText(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    fail(`ERROR(read:${label}): ${e.message}`);
  }
  return raw;
}

function readJson(path, label) {
  const raw = readText(path, label);
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`ERROR(parse:${label}): ${e.message}`);
  }
}

function rel(path) {
  return relative(consoleRoot, path).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Category metadata — severity + owner derive from adoption-audit.md §8 burndown
// (B-items are blocking-cutover; polish list is non-blocking).
// ---------------------------------------------------------------------------
const RULE_TO_CATEGORY = {
  'soup/no-raw-button': 'raw-button',
  'soup/no-raw-form-control': 'raw-form-control',
  'soup/no-legacy-tokens': 'legacy-token-tsx',
  'soup/no-focus-suppression': 'focus-suppression',
  'soup/no-brand-regression': 'brand-regression',
  'soup/no-utility-smell': 'utility-smell',
  'no-restricted-syntax': 'base-wall',
};

const CATEGORY_META = {
  'raw-button': { severity: 'blocking', owner: 'B2 — raw <button> elimination' },
  'raw-form-control': { severity: 'blocking', owner: 'B3 — form-control kit completion (DUP-12)' },
  'legacy-token-tsx': { severity: 'blocking', owner: 'B1 — legacy token vocabulary burn (TSX side)' },
  'focus-suppression': { severity: 'blocking', owner: 'B7 — HistoryTab composer (C-B4-6)' },
  'brand-regression': { severity: 'blocking', owner: 'B5 — Nav/brand slice (P4/C4 flips)' },
  'utility-smell': { severity: 'polish', owner: 'polish — DUP-08 evasions / utility audit' },
  'base-wall': { severity: 'blocking', owner: 'B5/B6 — base-wall falls (per-file)' },
  'legacy-var-css': { severity: 'blocking', owner: 'B1 — legacy token vocabulary burn (CSS side, incl. M8 scrollbar)' },
  'accent-law': { severity: 'blocking', owner: 'B4 — F1 accent-law fix + M9 accent-color re-point' },
  'raw-color-css': { severity: 'polish', owner: 'CSS tier-boundary — raw component-tier colors must move to semantic tokens' },
  'raw-font-size-css': { severity: 'polish', owner: 'CSS type scale — raw font-size declarations must move to type tokens' },
  'transition-all-css': { severity: 'blocking', owner: 'P5 motion law — CSS transition-all parity with soup/no-transition-all' },
  'raw-dimension-css': { severity: 'blocking', owner: 'CSS layout tokens — raw spacing/sizing/radius lengths must move to tokens' },
  'half-step': { severity: 'polish', owner: 'DD-9 — half-step spacing retirement' },
};

function categoryMeta(category) {
  // Unknown categories (e.g. a future shadow rule) fail toward blocking: a brand-new
  // violation class must block until it is classified in adoption-audit.md.
  return CATEGORY_META[category] ?? { severity: 'blocking', owner: 'unclassified — add to adoption-audit.md and CATEGORY_META' };
}

// ---------------------------------------------------------------------------
// Part 1: Consume lint-shadow-baseline.json (rule×file -> category items)
// ---------------------------------------------------------------------------
const shadowBaseline = readJson(shadowBaselinePath, 'lint-shadow-baseline.json');
if (typeof shadowBaseline !== 'object' || shadowBaseline === null) {
  fail('ERROR(schema:lint-shadow-baseline.json): root must be an object');
}
if (typeof shadowBaseline.total !== 'number') {
  fail('ERROR(schema:lint-shadow-baseline.json): missing numeric "total" field');
}
if (typeof shadowBaseline.rules !== 'object' || shadowBaseline.rules === null) {
  fail('ERROR(schema:lint-shadow-baseline.json): missing "rules" object');
}

// category -> { 'src/...path': count }
const eslintCategories = {};
let shadowSum = 0;
for (const [key, count] of Object.entries(shadowBaseline.rules)) {
  if (typeof count !== 'number') {
    fail(`ERROR(schema:lint-shadow-baseline.json): non-numeric count for key "${key}"`);
  }
  const sepIdx = key.indexOf(' :: ');
  if (sepIdx === -1) {
    fail(`ERROR(schema:lint-shadow-baseline.json): key missing " :: " separator: "${key}"`);
  }
  const rule = key.slice(0, sepIdx);
  const file = key.slice(sepIdx + 4);
  const category = RULE_TO_CATEGORY[rule] ?? `eslint:${rule}`;
  eslintCategories[category] ??= {};
  eslintCategories[category][file] = (eslintCategories[category][file] ?? 0) + count;
  shadowSum += count;
}
if (shadowSum !== shadowBaseline.total) {
  fail(`ERROR(schema:lint-shadow-baseline.json): rules sum ${shadowSum} != declared total ${shadowBaseline.total}`);
}

// ---------------------------------------------------------------------------
// CSS helpers
// ---------------------------------------------------------------------------
function stripCssComments(text, label) {
  let out = '';
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    if (!inComment && text[i] === '/' && text[i + 1] === '*') {
      inComment = true;
      out += '  ';
      i += 1;
      continue;
    }
    if (inComment && text[i] === '*' && text[i + 1] === '/') {
      inComment = false;
      out += '  ';
      i += 1;
      continue;
    }
    if (inComment) {
      out += text[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += text[i];
  }
  if (inComment) fail(`ERROR(parse:${label}): unterminated /* comment`);
  return out;
}

// Walk a (comment-stripped) stylesheet and yield declarations with their innermost
// selector and 1-based line number. Quote-aware so strings cannot unbalance braces.
function cssDeclarations(stripped, label) {
  const decls = [];
  const stack = [];
  let buf = '';
  let bufLine = null;
  let line = 1;
  let quote = null;

  const flushDecl = () => {
    const t = buf.trim();
    buf = '';
    const startLine = bufLine;
    bufLine = null;
    if (!t || stack.length === 0) return;
    const ci = t.indexOf(':');
    if (ci === -1) return;
    decls.push({
      selector: stack[stack.length - 1],
      property: t.slice(0, ci).trim(),
      value: t.slice(ci + 1).trim(),
      line: startLine ?? line,
    });
  };

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '\n') line += 1;
    if (quote) {
      buf += ch;
      if (ch === quote && stripped[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      if (bufLine === null) bufLine = line;
      continue;
    }
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
      bufLine = null;
      continue;
    }
    if (ch === '}') {
      flushDecl();
      if (stack.length === 0) fail(`ERROR(parse:${label}): unbalanced "}" at line ${line}`);
      stack.pop();
      continue;
    }
    if (ch === ';') {
      flushDecl();
      continue;
    }
    if (bufLine === null && !/\s/.test(ch)) bufLine = line;
    buf += ch;
  }
  if (quote) fail(`ERROR(parse:${label}): unterminated string`);
  if (stack.length !== 0) fail(`ERROR(parse:${label}): ${stack.length} unclosed "{" block(s)`);
  return decls;
}

// ---------------------------------------------------------------------------
// Part 2a: Derive the legacy-alias name list from the alias-layer definitions
// (adoption-audit.md §6 methodology: the "Legacy aliases" block in
// tokens.semantic.css is the legal definition set; half-steps are tracked by
// their own category below).
// ---------------------------------------------------------------------------
const semanticPath = join(stylesDir, 'tokens.semantic.css');
const semanticRaw = readText(semanticPath, 'tokens.semantic.css');
const aliasMarkerIdx = semanticRaw.indexOf('Legacy aliases');
if (aliasMarkerIdx === -1) {
  fail('ERROR(derive:legacy-alias-block): marker "Legacy aliases" not found in tokens.semantic.css — cannot derive legacy-name list');
}
// The alias section ends where the v3.5 token addendum begins (b-01 appended
// §A–§E below the legacy block) — without the bound, every -v35 name derives
// as "legacy" and the first v3.5 consumer (b-02 chrome) false-positives.
// Older trees without the addendum fall back to the EOF slice.
const v35MarkerIdx = semanticRaw.indexOf('v3.5 token addendum');
// Bound at the addendum comment's opener, not the marker text itself — the
// banner `/* ----` line precedes the marker, and slicing at the marker would
// leave an unterminated comment in the alias section (fail-closed parse).
const aliasSectionEnd = v35MarkerIdx > aliasMarkerIdx
  ? semanticRaw.lastIndexOf('/*', v35MarkerIdx)
  : semanticRaw.length;
const aliasSection = stripCssComments(semanticRaw.slice(aliasMarkerIdx, aliasSectionEnd), 'tokens.semantic.css(alias-block)');
const legacyNames = new Set();
for (const m of aliasSection.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) {
  legacyNames.add(m[1]);
}
if (legacyNames.size === 0) {
  fail('ERROR(derive:legacy-alias-block): zero alias definitions extracted from the Legacy aliases block');
}

// ---------------------------------------------------------------------------
// Part 2b: CSS-side scans
// ---------------------------------------------------------------------------
let styleEntries;
try {
  styleEntries = readdirSync(stylesDir).filter((f) => f.endsWith('.css')).sort();
} catch (e) {
  fail(`ERROR(read:src/styles): ${e.message}`);
}
if (styleEntries.length === 0) {
  fail('ERROR(read:src/styles): no .css files found — scan scope is empty');
}

// category -> { 'src/...path': { count, lines: Set } }
const scanCategories = {
  'legacy-var-css': {},
  'accent-law': {},
  'raw-color-css': {},
  'raw-font-size-css': {},
  'transition-all-css': {},
  'raw-dimension-css': {},
  'half-step': {},
};

function addHit(category, filePath, line, n = 1) {
  const p = rel(filePath);
  scanCategories[category][p] ??= { count: 0, lines: new Set() };
  scanCategories[category][p].count += n;
  scanCategories[category][p].lines.add(line);
}

const LEGACY_DEF_LINE = /^\s*(--[a-zA-Z0-9-]+)\s*:/;
const VAR_REF = /var\(\s*(--[a-zA-Z0-9-]+)/g;
const STATUS_CHANNEL_VAR = /var\(\s*--(?:color-s-(?:ok|warn|crit)|s-(?:ok|warn|crit)-[a-z-]+|status-(?:ok|warn|crit)-[a-z-]+)\b/g;
// Action controls: button recipes/elements that carry the single action accent.
// Status-semantic variants (danger/success/warning) legitimately ride the status
// channel ("status-first color", creative bar) and are excluded by name.
const ACTION_CONTROL_SELECTOR = /(^|[\s,>+~(])(\.c-btn(?![a-zA-Z0-9-]*(?:danger|success|warning))[a-zA-Z0-9-]*|button)(?![a-zA-Z0-9_-])/;
const COLOR_BINDING_PROPERTY = /^(background|background-color|border|border-color|border-top-color|border-bottom-color|border-left-color|border-right-color|color|box-shadow|outline-color|fill|stroke)$/;
const RAW_COLOR = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|\brgba?\(|\bhsla?\(|\boklch\(/g;
const RAW_FONT_SIZE_VALUE = /(?:^|[\s,(])\d*\.?\d+(?:px|rem|em|vw|vh|vmin|vmax|ch)\b/;
const TRANSITION_ALL_VALUE = /(?:^|,)\s*all(?:\s|,|$)/i;
const RAW_DIMENSION_PROPERTY = /^(?:width|height|min-width|min-height|max-width|max-height|inline-size|block-size|min-inline-size|min-block-size|max-inline-size|max-block-size|margin|margin-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)|padding|padding-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)|gap|row-gap|column-gap|inset|inset-(?:block|block-start|block-end|inline|inline-start|inline-end)|top|right|bottom|left|border-radius|border-(?:top-left|top-right|bottom-left|bottom-right)-radius|border-width|border-(?:top|right|bottom|left)-width|outline-width|scroll-margin|scroll-margin-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)|scroll-padding|scroll-padding-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)|border-spacing)$/;
const RAW_DIMENSION_VALUE = /(?:^|[\s,(+-])-?\d*\.?\d+(?:px|rem|em|vw|vh|vmin|vmax|ch)\b/g;
const HALF_STEP_REF = /--sp-[012]h\b/g;
const HALF_STEP_DEF_LINE = /^\s*--sp-[012]h\s*:/;

// Raw-color allowlist: the two value-owning token tiers (tokens-v3 §1/§3 — primitive
// owns raw scales, semantic owns per-theme assignments; every other CSS file must
// var()-reference only).
const RAW_COLOR_ALLOWLIST = new Set(['tokens.primitive.css', 'tokens.semantic.css']);
const RAW_FONT_SIZE_ALLOWLIST = new Set(['tokens.primitive.css']);
// `primitives.css` still carries DD-26 `font: var(--type-*, fallback)` / primitive
// shorthand fallbacks; component/composite CSS remains zero-ceiling for raw `font:`.
const RAW_FONT_SHORTHAND_ALLOWLIST = new Set([...RAW_FONT_SIZE_ALLOWLIST, 'primitives.css']);
const RAW_DIMENSION_ALLOWLIST = new Set(['tokens.primitive.css', 'tokens.semantic.css', 'tokens.component.css']);

function stripCssVarFunctions(value) {
  let out = '';
  let varDepth = 0;
  for (let i = 0; i < value.length; i++) {
    if (varDepth === 0 && value.startsWith('var(', i)) {
      varDepth = 1;
      out += '    ';
      i += 3;
      continue;
    }
    if (varDepth > 0) {
      if (value[i] === '(') varDepth += 1;
      else if (value[i] === ')') varDepth -= 1;
      out += value[i] === '\n' ? '\n' : ' ';
      continue;
    }
    out += value[i];
  }
  return out;
}

for (const name of styleEntries) {
  const filePath = join(stylesDir, name);
  const raw = readText(filePath, `src/styles/${name}`);
  const stripped = stripCssComments(raw, `src/styles/${name}`);
  const lines = stripped.split('\n');

  lines.forEach((lineText, idx) => {
    const lineNo = idx + 1;

    // legacy-var-css: var(--legacy) refs; skip lines that ARE legacy-alias
    // definitions (those die with the alias layer itself, they are not consumers).
    const defMatch = LEGACY_DEF_LINE.exec(lineText);
    const isLegacyDefLine = defMatch !== null && legacyNames.has(defMatch[1]);
    if (!isLegacyDefLine) {
      for (const m of lineText.matchAll(VAR_REF)) {
        if (legacyNames.has(m[1])) addHit('legacy-var-css', filePath, lineNo);
      }
    }

    // raw-color-css (outside the token-definition tiers)
    if (!RAW_COLOR_ALLOWLIST.has(name)) {
      const hits = [...lineText.matchAll(RAW_COLOR)];
      if (hits.length > 0) addHit('raw-color-css', filePath, lineNo, hits.length);
    }

    // half-step (CSS side; defs excluded)
    if (!HALF_STEP_DEF_LINE.test(lineText)) {
      const hits = [...lineText.matchAll(HALF_STEP_REF)];
      if (hits.length > 0) addHit('half-step', filePath, lineNo, hits.length);
    }
  });

  // accent-law: declaration-level scan with selector context
  for (const decl of cssDeclarations(stripped, `src/styles/${name}`)) {
    const statusHits = [...decl.value.matchAll(STATUS_CHANNEL_VAR)];
    if (statusHits.length > 0) {
      if (decl.property === 'accent-color') {
        addHit('accent-law', filePath, decl.line, statusHits.length);
        continue;
      }
      if (COLOR_BINDING_PROPERTY.test(decl.property) && ACTION_CONTROL_SELECTOR.test(decl.selector)) {
        addHit('accent-law', filePath, decl.line, statusHits.length);
      }
    }

    // raw-font-size-css: type sizes in component/composite CSS must route through
    // the tokenized type scale (`var(--text-*)` / `var(--type-*)`), not literal px/rem.
    const scansRawFontSize = decl.property === 'font-size' && !RAW_FONT_SIZE_ALLOWLIST.has(name);
    const scansRawFontShorthand = decl.property === 'font' && !RAW_FONT_SHORTHAND_ALLOWLIST.has(name);
    if ((scansRawFontSize || scansRawFontShorthand)
      && RAW_FONT_SIZE_VALUE.test(decl.value)) {
      addHit('raw-font-size-css', filePath, decl.line);
    }

    if ((decl.property === 'transition' || decl.property === 'transition-property')
      && TRANSITION_ALL_VALUE.test(decl.value)) {
      addHit('transition-all-css', filePath, decl.line);
    }

    if (RAW_DIMENSION_PROPERTY.test(decl.property)
      && !RAW_DIMENSION_ALLOWLIST.has(name)) {
      const dimensionHits = [...stripCssVarFunctions(decl.value).matchAll(RAW_DIMENSION_VALUE)];
      if (dimensionHits.length > 0) addHit('raw-dimension-css', filePath, decl.line, dimensionHits.length);
    }
  }
}

// half-step TSX/TS side (no ESLint rule covers the half-steps — DD-9 feed needs
// both sides; everything else TSX-side is owned by the shadow ratchet).
function walkSrc(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    fail(`ERROR(read:${rel(dir)}): ${e.message}`);
  }
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (p === stylesDir) continue; // CSS side already scanned above
      walkSrc(p, out);
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}
for (const filePath of walkSrc(srcDir, [])) {
  const raw = readText(filePath, rel(filePath));
  raw.split('\n').forEach((lineText, idx) => {
    if (HALF_STEP_DEF_LINE.test(lineText)) return;
    const hits = [...lineText.matchAll(HALF_STEP_REF)];
    if (hits.length > 0) addHit('half-step', filePath, idx + 1, hits.length);
  });
}

// ---------------------------------------------------------------------------
// Part 3: Assemble the queue
// ---------------------------------------------------------------------------
const items = [];

for (const [category, byFile] of Object.entries(eslintCategories)) {
  const meta = categoryMeta(category);
  const files = Object.entries(byFile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, count]) => ({ path, count, lines: null }));
  items.push({
    id: `burndown:${category}`,
    category,
    severity: meta.severity,
    count: files.reduce((a, f) => a + f.count, 0),
    files,
    owner: meta.owner,
    source: 'lint-shadow-baseline.json (line detail lives in the ESLint shadow run)',
  });
}

for (const [category, byFile] of Object.entries(scanCategories)) {
  const meta = categoryMeta(category);
  const files = Object.entries(byFile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, v]) => ({ path, count: v.count, lines: [...v.lines].sort((a, b) => a - b) }));
  items.push({
    id: `burndown:${category}`,
    category,
    severity: meta.severity,
    count: files.reduce((a, f) => a + f.count, 0),
    files,
    owner: meta.owner,
    source: 'css-scan (check-design-burndown.mjs)',
  });
}

// Deterministic order: blocking before polish, then category name.
items.sort((a, b) => {
  if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1;
  return a.category.localeCompare(b.category);
});

const byCategory = Object.fromEntries(
  items.map((it) => [it.category, it.count]).sort(([a], [b]) => a.localeCompare(b))
);
const summary = {
  total: items.reduce((a, it) => a + it.count, 0),
  blocking: items.filter((it) => it.severity === 'blocking').reduce((a, it) => a + it.count, 0),
  byCategory,
};

const queueDoc = {
  generated: 'design burndown queue — canonical machine-readable burndown; regenerate via: npm --prefix console run design:burndown -- --update',
  schema_version: 1,
  summary,
  items,
};
const queueJson = JSON.stringify(queueDoc, null, 2) + '\n';

const baselineDoc = {
  generated: 'design burndown per-category ceiling (fall-only ratchet)',
  categories: byCategory,
};
const baselineJson = JSON.stringify(baselineDoc, null, 2) + '\n';

// ---------------------------------------------------------------------------
// Part 4: --update writes baseline AND queue together
// ---------------------------------------------------------------------------
if (updateMode) {
  try {
    writeFileSync(burndownBaselinePath, baselineJson, 'utf8');
    writeFileSync(queuePath, queueJson, 'utf8');
  } catch (e) {
    fail(`ERROR(write): ${e.message}`);
  }
  console.log(
    `burndown baseline + queue updated: total=${summary.total} blocking=${summary.blocking} across ${items.length} categories`
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Part 5: --check (default) — ratchet, never writes
// ---------------------------------------------------------------------------
if (!existsSync(burndownBaselinePath)) {
  fail(`FAIL: no baseline at ${burndownBaselinePath} — run with --update to create it`);
}
const burndownBaseline = readJson(burndownBaselinePath, 'design-burndown-baseline.json');
if (typeof burndownBaseline !== 'object' || burndownBaseline === null
  || typeof burndownBaseline.categories !== 'object' || burndownBaseline.categories === null) {
  fail('ERROR(schema:design-burndown-baseline.json): missing "categories" object');
}
for (const [cat, n] of Object.entries(burndownBaseline.categories)) {
  if (typeof n !== 'number') {
    fail(`ERROR(schema:design-burndown-baseline.json): non-numeric count for category "${cat}"`);
  }
}
if (!existsSync(queuePath)) {
  fail(`FAIL: no committed queue at ${queuePath} — run with --update to create it`);
}
const committedQueue = readJson(queuePath, 'design-burndown-queue.json');
const committedByCategory = new Map(
  Array.isArray(committedQueue?.items)
    ? committedQueue.items.map((it) => [it.category, it])
    : []
);

const allCategories = [...new Set([
  ...Object.keys(byCategory),
  ...Object.keys(burndownBaseline.categories),
])].sort((a, b) => a.localeCompare(b));

const rises = [];
const falls = [];
for (const cat of allCategories) {
  const cur = byCategory[cat] ?? 0;
  const base = burndownBaseline.categories[cat] ?? 0;
  if (cur > base) rises.push({ cat, cur, base });
  else if (cur < base) falls.push({ cat, cur, base });
}

if (rises.length > 0) {
  for (const { cat, cur, base } of rises) {
    process.stderr.write(`FAIL: ${cat} -> ${cur} violations (ceiling ${base}, +${cur - base})\n`);
    const currentItem = items.find((it) => it.category === cat);
    const committedItem = committedByCategory.get(cat);
    const committedFiles = new Map((committedItem?.files ?? []).map((f) => [f.path, f]));
    for (const f of currentItem?.files ?? []) {
      const prev = committedFiles.get(f.path);
      if (Array.isArray(f.lines)) {
        const prevLines = new Set(Array.isArray(prev?.lines) ? prev.lines : []);
        const newLines = f.lines.filter((l) => !prevLines.has(l));
        if (!prev) {
          process.stderr.write(`  new file: ${f.path}:${f.lines.join(',')}\n`);
        } else if (newLines.length > 0 || f.count > prev.count) {
          process.stderr.write(`  ${f.path}:${(newLines.length > 0 ? newLines : f.lines).join(',')} (+${f.count - (prev.count ?? 0)})\n`);
        }
      } else if (!prev || f.count > (prev.count ?? 0)) {
        process.stderr.write(`  ${f.path}: ${f.count} (was ${prev?.count ?? 0}) — line detail: ESLint shadow run\n`);
      }
    }
  }
  process.stderr.write(
    `\n${rises.length} categor${rises.length === 1 ? 'y' : 'ies'} exceeded the burndown baseline. ` +
    'New design-system violations are not allowed; fix them (the queue self-shrinks) or, for sanctioned scope, ' +
    'update the baseline in the same commit with a justification.\n'
  );
  process.exit(1);
}

if (falls.length > 0) {
  for (const { cat, cur, base } of falls) {
    process.stderr.write(`FALL: ${cat} -> ${cur} violations (ceiling ${base}, -${base - cur})\n`);
  }
  process.stderr.write('ratchet fall — run with --update to lower the baseline (baseline + queue rewrite together)\n');
  process.exit(1);
}

// Counts all equal: the committed queue must still byte-match the regenerated one,
// so a violation that MOVES (same count, different file:line) cannot leave a stale queue.
const committedQueueRaw = readText(queuePath, 'design-burndown-queue.json');
if (committedQueueRaw !== queueJson) {
  fail('FAIL: queue drift — category counts match the baseline but design-burndown-queue.json no longer matches the live scan (violations moved). Run with --update to regenerate the queue.');
}

console.log(
  `design burndown OK: total=${summary.total} blocking=${summary.blocking} across ${items.length} categories (queue in sync)`
);
process.exit(0);
