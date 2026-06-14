#!/usr/bin/env node
// Report SOUP brand asset readiness: favicon source, document links, and PWA/maskable coverage.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');

const DEFAULT_FAVICON = resolve(consoleRoot, 'public/favicon.svg');
const DEFAULT_INDEX = resolve(consoleRoot, 'index.html');
const DEFAULT_MANIFEST = resolve(consoleRoot, 'public/manifest.webmanifest');
const LEGACY_BOLT_COLORS = ['#863bff', '#7e14ff', '#47bfff', '#aa3bff'];
const PERIPHERAL_TEXT_EXT = /\.(?:json|webmanifest|html)$/i;
const REFERENCE_TEXT_EXT = /\.(?:css|html|json|ts|tsx|webmanifest)$/i;
const FORBIDDEN_PERIPHERAL_COPY = [
  { label: 'legacy product name "Soup Kitchen"', pattern: /Soup Kitchen/i },
  { label: 'channel-bound copy "from/on/via WhatsApp"', pattern: /\b(?:from|on|via)\s+WhatsApp\b/i },
];

function usage() {
  return `Usage: node console/scripts/check-brand-assets.mjs [options]

Options:
  --favicon <path>      Favicon SVG. Default: console/public/favicon.svg
  --index <path>        HTML entrypoint. Default: console/index.html
  --manifest <path>     PWA manifest path. Default: console/public/manifest.webmanifest
  --fail-on-rule <rule> Exit 1 when findings for this rule are present. Repeatable.
  --fail-on-findings    Exit 1 when report-only findings are present.
  --help                Print this message.
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    failOnFindings: false,
    failOnRules: new Set(),
    favicon: DEFAULT_FAVICON,
    help: false,
    index: DEFAULT_INDEX,
    manifest: DEFAULT_MANIFEST,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--favicon') opts.favicon = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--index') opts.index = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--manifest') opts.manifest = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--fail-on-rule') opts.failOnRules.add(requireValue(argv, ++i, arg));
    else if (arg === '--fail-on-findings') opts.failOnFindings = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function addFinding(findings, rule, target, evidence, message) {
  findings.push({ evidence, message, rule, target });
}

function addFailure(failures, code, target, message) {
  failures.push({ code, message, target });
}

function pushExisting(files, path) {
  if (existsSync(path) && !files.includes(path)) files.push(path);
}

function pathConsoleRoot(paths) {
  return dirname(paths.index);
}

function displayPath(path, paths) {
  const root = pathConsoleRoot(paths);
  return path.startsWith(`${root}/`) ? `console/${path.slice(root.length + 1)}` : path;
}

function filesUnder(dir, matchesFile) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(path, matchesFile));
    } else if (entry.isFile() && matchesFile(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function peripheralTextArtifacts(paths) {
  const files = [];
  const publicDir = dirname(paths.manifest);

  pushExisting(files, paths.index);
  for (const file of filesUnder(publicDir, (name) => PERIPHERAL_TEXT_EXT.test(name))) {
    pushExisting(files, file);
  }
  pushExisting(files, paths.manifest);

  return files;
}

function textFilesUnder(dir) {
  return filesUnder(dir, (name) => REFERENCE_TEXT_EXT.test(name));
}

function publicSvgAssets(paths) {
  const publicDir = dirname(paths.manifest);
  return filesUnder(publicDir, (name) => name.endsWith('.svg'));
}

function normalizeSvgReference(value) {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/[?#].*$/, '');
  const publicIndex = trimmed.lastIndexOf('/public/');
  let path = publicIndex >= 0 ? trimmed.slice(publicIndex + '/public/'.length) : trimmed;
  path = path.replace(/^public\//, '').replace(/^\/+/, '');
  while (path.startsWith('./')) path = path.slice(2);
  if (!path || path.startsWith('../') || !path.toLowerCase().endsWith('.svg')) return null;
  return path;
}

function collectSvgReferences(text) {
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\S\r\n])\/\/.*$/gm, '$1');
  const references = new Set();
  const patterns = [
    /\b(?:href|src|xlink:href)\s*=\s*["']([^"']+\.svg(?:[?#][^"']*)?)["']/gi,
    /["']src["']\s*:\s*["']([^"']+\.svg(?:[?#][^"']*)?)["']/gi,
    /url\(\s*["']?([^"')\s]+\.svg(?:[?#][^"')\s]*)?)["']?\s*\)/gi,
    /(?:import\s+[^'"]+\s+from\s+|from\s+|import\(\s*)["']([^"']+\.svg(?:[?#][^"']*)?)["']/gi,
    /["']((?:\/|\.{1,2}\/|public\/|[^"']+\/)[^"']+\.svg(?:[?#][^"']*)?)["']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const reference = normalizeSvgReference(match[1]);
      if (reference) references.add(reference);
    }
  }
  return references;
}

function numericAttr(svg, attr) {
  const match = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i').exec(svg);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

function viewBoxNumbers(svg) {
  const match = /viewBox\s*=\s*["']([^"']+)["']/i.exec(svg);
  if (!match) return null;
  const values = match[1].trim().split(/\s+/).map((value) => Number.parseFloat(value));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  return values;
}

function analyzeFavicon(svg, target) {
  const findings = [];
  const width = numericAttr(svg, 'width');
  const height = numericAttr(svg, 'height');
  const viewBox = viewBoxNumbers(svg);

  if (width !== null && height !== null && Math.abs(width - height) > 0.001) {
    addFinding(
      findings,
      'soup/brand-favicon-square-canvas',
      target,
      `width=${width} height=${height}`,
      'Favicon canvas must be square for small-size and maskable rendering.',
    );
  }
  if (viewBox && Math.abs(viewBox[2] - viewBox[3]) > 0.001) {
    addFinding(
      findings,
      'soup/brand-favicon-square-canvas',
      target,
      `viewBox=${viewBox.join(' ')}`,
      'Favicon viewBox must be square for small-size and maskable rendering.',
    );
  }

  const lower = svg.toLowerCase();
  const legacyColors = LEGACY_BOLT_COLORS.filter((color) => lower.includes(color));
  if (legacyColors.length > 0 || lower.includes('color(display-p3')) {
    addFinding(
      findings,
      'soup/brand-favicon-legacy-palette',
      target,
      legacyColors.length > 0 ? legacyColors.join(', ') : 'color(display-p3)',
      'Favicon still carries the legacy purple/blue bolt palette instead of the SOUP identity palette.',
    );
  }

  if (/<(?:linearGradient|radialGradient)\b/i.test(svg) || /<filter\b/i.test(svg) || /filter\s*=/i.test(svg) || /<feGaussianBlur\b/i.test(svg)) {
    addFinding(
      findings,
      'soup/brand-asset-no-gradient-glow',
      target,
      'gradient/filter/blur',
      'Brand assets must not use gradients, glow, blur, or filter effects.',
    );
  }

  if (/<mask\b/i.test(svg)) {
    addFinding(
      findings,
      'soup/brand-asset-simple-glyph',
      target,
      '<mask>',
      'The production favicon should resolve to a simple monogram glyph, not a masked illustration.',
    );
  }

  return findings;
}

function analyzeIndex(html, paths) {
  const findings = [];
  if (!/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']\/favicon\.svg["']/i.test(html)
    && !/<link\b[^>]*href=["']\/favicon\.svg["'][^>]*rel=["'][^"']*icon[^"']*["']/i.test(html)) {
    addFinding(
      findings,
      'soup/brand-favicon-link-required',
      paths.index,
      'missing /favicon.svg icon link',
      'The HTML entrypoint must link the canonical SOUP favicon.',
    );
  }
  if (!/<link\b[^>]*rel=["']manifest["'][^>]*href=["']\/manifest\.webmanifest["']/i.test(html)
    && !/<link\b[^>]*href=["']\/manifest\.webmanifest["'][^>]*rel=["']manifest["']/i.test(html)) {
    addFinding(
      findings,
      'soup/brand-pwa-maskable-assets-missing',
      paths.index,
      'missing manifest link',
      'SOUP identity asset set needs a PWA manifest with maskable icon coverage.',
    );
  }
  return findings;
}

function analyzeManifest(path) {
  const findings = [];
  if (!existsSync(path)) {
    addFinding(
      findings,
      'soup/brand-pwa-maskable-assets-missing',
      path,
      'manifest file missing',
      'SOUP identity asset set needs a checked-in PWA manifest.',
    );
    return findings;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    addFinding(
      findings,
      'soup/brand-pwa-maskable-assets-missing',
      path,
      `invalid manifest JSON: ${err.message}`,
      'SOUP PWA manifest must be valid JSON before it can prove maskable coverage.',
    );
    return findings;
  }

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const hasMaskable = icons.some((icon) => typeof icon?.purpose === 'string' && icon.purpose.includes('maskable'));
  if (!hasMaskable) {
    addFinding(
      findings,
      'soup/brand-pwa-maskable-assets-missing',
      path,
      'no maskable icon purpose',
      'SOUP PWA manifest must include at least one maskable icon.',
    );
  }
  return findings;
}

function scanPeripheralBrandFailures(paths) {
  const failures = [];
  const textArtifacts = peripheralTextArtifacts(paths);

  for (const file of textArtifacts) {
    const text = readFileSync(file, 'utf8');
    for (const { label, pattern } of FORBIDDEN_PERIPHERAL_COPY) {
      if (pattern.test(text)) {
        addFailure(
          failures,
          'PERIPHERAL_BRAND_COPY',
          file,
          `Forbidden peripheral copy (${label}) in ${displayPath(file, paths)}.`,
        );
      }
    }
  }

  const referencedSvgAssets = new Set();
  for (const file of [
    ...textArtifacts,
    ...textFilesUnder(resolve(pathConsoleRoot(paths), 'src')),
  ]) {
    for (const reference of collectSvgReferences(readFileSync(file, 'utf8'))) {
      referencedSvgAssets.add(reference);
    }
  }

  for (const file of publicSvgAssets(paths)) {
    const publicPath = relative(dirname(paths.manifest), file).replace(/\\/g, '/');
    if (!referencedSvgAssets.has(publicPath)) {
      addFailure(
        failures,
        'ORPHAN_PUBLIC_SVG',
        file,
        `Public SVG ${basename(file)} is not referenced by index.html, public text artifacts, or console/src.`,
      );
    }
  }

  return failures;
}

function buildReport(opts) {
  const paths = { favicon: opts.favicon, index: opts.index, manifest: opts.manifest };
  const failures = [];
  let findings = [];

  if (!existsSync(opts.favicon)) addFailure(failures, 'MISSING_INPUT', opts.favicon, 'favicon SVG is missing');
  if (!existsSync(opts.index)) addFailure(failures, 'MISSING_INPUT', opts.index, 'HTML entrypoint is missing');

  if (failures.length === 0) {
    findings = [
      ...analyzeFavicon(readFileSync(opts.favicon, 'utf8'), opts.favicon),
      ...analyzeIndex(readFileSync(opts.index, 'utf8'), paths),
      ...analyzeManifest(opts.manifest),
    ].sort((a, b) => a.rule.localeCompare(b.rule) || a.target.localeCompare(b.target));
    failures.push(...scanPeripheralBrandFailures(paths));
  }

  const byRule = {};
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  failures.sort((a, b) => a.code.localeCompare(b.code) || a.target.localeCompare(b.target));
  const failedFindings = findings
    .filter((finding) => opts.failOnFindings || opts.failOnRules.has(finding.rule))
    .map((finding) => finding.rule);
  const failedRules = [...new Set(failedFindings)].sort();
  const enforcedRules = [...opts.failOnRules].sort();
  const reportOnly = !opts.failOnFindings && enforcedRules.length === 0;

  return {
    by_rule: Object.fromEntries(Object.entries(byRule).sort(([a], [b]) => a.localeCompare(b))),
    enforced_rules: enforcedRules,
    failure_count: failures.length,
    failures,
    failed_rules: failedRules,
    finding_count: findings.length,
    findings,
    generated_at_utc: new Date().toISOString(),
    mode: reportOnly ? 'report-only' : opts.failOnFindings ? 'fail-on-findings' : 'fail-on-rule',
    paths,
    schema_version: 1,
    verdict: failures.length > 0 || failedRules.length > 0 ? 'FAIL' : 'PASS',
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

  const report = buildReport(opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'PASS') process.exit(1);
}

main();
