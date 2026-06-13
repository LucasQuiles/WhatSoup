#!/usr/bin/env node
// Recompute SOUP token contrast pairs from the live semantic token file.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_TOKENS = resolve(consoleRoot, 'src/styles/tokens.semantic.css');
const DEFAULT_OUT = resolve(repoRoot, 'artifacts/soup-v3-follow-up/contrast-matrix.json');

const SURFACES = ['surface-base', 'surface-raised', 'surface-overlay', 'surface-inset'];
const CHANNELS = [
  'status-ok',
  'status-warn',
  'status-crit',
  'mode-passive',
  'mode-chat',
  'mode-agent',
];

function usage() {
  return `Usage: node console/scripts/check-contrast-matrix.mjs [options]

Options:
  --tokens <path>   Semantic token CSS file. Default: console/src/styles/tokens.semantic.css
  --out <path>      Output JSON path. Default: artifacts/soup-v3-follow-up/contrast-matrix.json
  --no-write        Print JSON without writing an artifact file.
  --help            Print this message.
`;
}

function parseArgs(argv) {
  const opts = { tokens: DEFAULT_TOKENS, out: DEFAULT_OUT, write: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--no-write') opts.write = false;
    else if (arg === '--tokens') opts.tokens = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--out') opts.out = resolve(requireValue(argv, ++i, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseThemeTokens(css, theme) {
  const tokens = {};
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = blockRe.exec(css)) !== null) {
    const selector = match[1].trim();
    if (!selectorOwnsTheme(selector, theme)) continue;
    for (const decl of match[2].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      tokens[decl[1]] = decl[2].trim();
    }
  }
  return tokens;
}

function selectorOwnsTheme(selector, theme) {
  if (theme === 'dark') return selector.includes('[data-theme="dark"]') || selector.includes(':root');
  return selector.includes('[data-theme="light"]');
}

function resolveTokenColor(tokens, tokenName, stack = []) {
  const raw = tokens[tokenName];
  if (!raw) throw new Error(`missing token --${tokenName}`);
  return resolveColorValue(tokens, raw, [...stack, tokenName]);
}

function resolveColorValue(tokens, rawValue, stack = []) {
  const value = rawValue.trim();
  if (value.startsWith('var(')) {
    const token = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
    if (!token) throw new Error(`unsupported var() form: ${value}`);
    if (stack.includes(token)) throw new Error(`cyclic token reference: ${[...stack, token].join(' -> ')}`);
    return resolveTokenColor(tokens, token, stack);
  }

  if (value.startsWith('#')) return parseHex(value);

  const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgb) return parseRgb(rgb[1]);

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(.+?),\s*transparent\)$/.exec(value);
  if (mix) {
    const color = resolveColorValue(tokens, mix[1].trim(), stack);
    return { ...color, a: color.a * resolvePercent(tokens, mix[2].trim(), stack) };
  }

  throw new Error(`unsupported color value: ${value}`);
}

function resolvePercent(tokens, rawValue, stack = []) {
  const value = rawValue.trim();
  if (value.endsWith('%')) return Number(value.slice(0, -1)) / 100;
  if (value.startsWith('var(')) {
    const token = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
    if (!token) throw new Error(`unsupported percentage var() form: ${value}`);
    if (stack.includes(token)) throw new Error(`cyclic token reference: ${[...stack, token].join(' -> ')}`);
    return resolvePercent(tokens, tokens[token], [...stack, token]);
  }
  throw new Error(`unsupported percentage value: ${value}`);
}

function parseHex(value) {
  const raw = value.slice(1);
  const full = raw.length === 3
    ? raw.split('').map((char) => `${char}${char}`).join('')
    : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`unsupported hex color: ${value}`);
  return {
    a: 1,
    b: Number.parseInt(full.slice(4, 6), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    r: Number.parseInt(full.slice(0, 2), 16),
  };
}

function parseRgb(raw) {
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length !== 3 && parts.length !== 4) throw new Error(`unsupported rgb color: ${raw}`);
  const [r, g, b] = parts.slice(0, 3).map(Number);
  const a = parts[3] === undefined ? 1 : Number(parts[3]);
  if ([r, g, b, a].some((part) => Number.isNaN(part))) throw new Error(`unsupported rgb color: ${raw}`);
  return { a, b, g, r };
}

function composite(fg, bg) {
  if (fg.a >= 1) return fg;
  return {
    a: 1,
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    r: fg.r * fg.a + bg.r * (1 - fg.a),
  };
}

function channel(value) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(fg, bg) {
  const foreground = composite(fg, bg);
  const [lighter, darker] = [luminance(foreground), luminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function addPair(rows, tokens, theme, pair) {
  try {
    const bg = resolveTokenColor(tokens, pair.bg);
    const fg = resolveTokenColor(tokens, pair.fg);
    const ratio = Number(contrastRatio(fg, bg).toFixed(2));
    rows.push({
      bg: `--${pair.bg}`,
      fg: `--${pair.fg}`,
      pair: pair.name,
      ratio,
      status: ratio >= pair.threshold ? 'PASS' : 'FAIL',
      theme,
      threshold: pair.threshold,
      type: pair.type,
    });
  } catch (err) {
    rows.push({
      bg: `--${pair.bg}`,
      error: err.message,
      fg: `--${pair.fg}`,
      pair: pair.name,
      ratio: null,
      status: 'FAIL',
      theme,
      threshold: pair.threshold,
      type: pair.type,
    });
  }
}

function addCompositePair(rows, tokens, theme, pair) {
  try {
    const bed = resolveTokenColor(tokens, pair.bed);
    const bg = composite(resolveTokenColor(tokens, pair.bg), bed);
    const fg = resolveTokenColor(tokens, pair.fg);
    const ratio = Number(contrastRatio(fg, bg).toFixed(2));
    rows.push({
      bed: `--${pair.bed}`,
      bg: `--${pair.bg}`,
      fg: `--${pair.fg}`,
      pair: pair.name,
      ratio,
      status: ratio >= pair.threshold ? 'PASS' : 'FAIL',
      theme,
      threshold: pair.threshold,
      type: pair.type,
    });
  } catch (err) {
    rows.push({
      bed: `--${pair.bed}`,
      bg: `--${pair.bg}`,
      error: err.message,
      fg: `--${pair.fg}`,
      pair: pair.name,
      ratio: null,
      status: 'FAIL',
      theme,
      threshold: pair.threshold,
      type: pair.type,
    });
  }
}

function staticPairs() {
  const pairs = [];
  for (const surface of SURFACES) {
    pairs.push({ bg: surface, fg: 'text-1', name: `text-1 on ${surface}`, threshold: 4.5, type: 'normal-text' });
    pairs.push({ bg: surface, fg: 'text-2', name: `text-2 on ${surface}`, threshold: 4.5, type: 'normal-text' });
    pairs.push({ bg: surface, fg: 'text-3', name: `text-3 on ${surface}`, threshold: 3, type: 'incidental-text' });
    pairs.push({ bg: surface, fg: 'focus-ring', name: `focus ring on ${surface}`, threshold: 3, type: 'non-text-indicator' });
  }
  for (const surface of ['surface-base', 'surface-raised', 'surface-overlay']) {
    pairs.push({ bg: surface, fg: 'accent', name: `accent text on ${surface}`, threshold: 4.5, type: 'normal-text' });
  }
  pairs.push({ bg: 'accent', fg: 'accent-fg', name: 'accent-fg on accent', threshold: 4.5, type: 'normal-text' });
  for (const channelName of CHANNELS) {
    pairs.push({ bg: 'surface-base', fg: `${channelName}-fg`, name: `${channelName}-fg on surface-base`, threshold: 4.5, type: 'normal-text' });
  }
  return pairs;
}

function channelWashPairs(tokens) {
  const pairs = [];
  for (const channelName of CHANNELS) {
    if (!tokens[`${channelName}-wash`] || !tokens[`${channelName}-fg`]) continue;
    for (const bed of ['surface-base', 'surface-raised']) {
      pairs.push({
        bed,
        bg: `${channelName}-wash`,
        fg: `${channelName}-fg`,
        name: `${channelName}-fg on ${channelName}-wash over ${bed}`,
        threshold: 4.5,
        type: 'normal-text-on-wash',
      });
    }
  }
  return pairs;
}

function discoveredProviderPairs(tokens) {
  const pairs = [];
  for (const token of Object.keys(tokens).sort()) {
    const match = /^provider-(.+)-fg$/.exec(token);
    if (!match) continue;
    const id = match[1];
    for (const surface of ['surface-base', 'surface-raised', 'surface-overlay']) {
      pairs.push({ bg: surface, fg: token, name: `provider ${id} fg on ${surface}`, threshold: 4.5, type: 'provider-text' });
    }
    if (tokens[`provider-${id}-wash`]) {
      for (const bed of ['surface-base', 'surface-raised']) {
        pairs.push({
          bed,
          bg: `provider-${id}-wash`,
          fg: token,
          name: `provider ${id} fg on wash over ${bed}`,
          threshold: 4.5,
          type: 'provider-text-on-wash',
        });
      }
    }
  }
  return pairs;
}

function discoveredDataPairs(tokens) {
  const pairs = [];
  for (const token of Object.keys(tokens).sort()) {
    let match = /^data-(.+)-fg$/.exec(token);
    if (match) {
      for (const surface of ['surface-base', 'surface-raised', 'surface-overlay']) {
        pairs.push({ bg: surface, fg: token, name: `data ${match[1]} fg on ${surface}`, threshold: 4.5, type: 'data-text' });
      }
      continue;
    }
    match = /^data-(.+)-solid$/.exec(token);
    if (!match) continue;
    for (const surface of ['surface-base', 'surface-raised', 'surface-overlay']) {
      pairs.push({ bg: surface, fg: token, name: `data ${match[1]} solid on ${surface}`, threshold: 3, type: 'data-non-text' });
    }
  }
  return pairs;
}

function buildMatrix(css) {
  const rows = [];
  const skipped = [];
  for (const theme of ['dark', 'light']) {
    const tokens = parseThemeTokens(css, theme);
    for (const pair of staticPairs()) addPair(rows, tokens, theme, pair);
    for (const pair of channelWashPairs(tokens)) addCompositePair(rows, tokens, theme, pair);

    const providerPairs = discoveredProviderPairs(tokens);
    const dataPairs = discoveredDataPairs(tokens);
    if (!providerPairs.length) skipped.push({ reason: 'no --provider-*-fg tokens present', theme, type: 'provider' });
    if (!dataPairs.length) skipped.push({ reason: 'no --data-*-fg or --data-*-solid tokens present', theme, type: 'data' });

    for (const pair of providerPairs) {
      if (pair.bed) addCompositePair(rows, tokens, theme, pair);
      else addPair(rows, tokens, theme, pair);
    }
    for (const pair of dataPairs) addPair(rows, tokens, theme, pair);
  }

  const failed = rows.filter((row) => row.status !== 'PASS');
  return {
    failed_count: failed.length,
    generated_at_utc: new Date().toISOString(),
    pair_count: rows.length,
    rows,
    schema_version: 1,
    skipped,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ERROR(args): ${err.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  const css = readFileSync(opts.tokens, 'utf8');
  const matrix = buildMatrix(css);
  if (opts.write) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(matrix, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
  if (matrix.verdict !== 'PASS') process.exit(1);
}

main();
