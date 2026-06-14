#!/usr/bin/env node
// Report source-level layout, text, scroll, and interaction resilience risks.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_SCAN_DIRS = ['console/src'];
const DEFAULT_MAX_FINDINGS = 200;
const SUPPORTED_EXTENSIONS = new Set(['.css', '.ts', '.tsx']);

function usage() {
  return `Usage: node console/scripts/check-design-resilience.mjs [options]

Options:
  --root <path>          Repository root. Default: current repository root.
  --scan-dir <path>      Directory to scan, relative to root. Repeatable. Default: console/src.
  --max-findings <n>     Maximum sample findings to print. Default: 200.
  --fail-on-findings     Exit 1 when findings are present. Default is report-only exit 0.
  --help                 Print this message.
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} requires a non-negative integer`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    failOnFindings: false,
    help: false,
    maxFindings: DEFAULT_MAX_FINDINGS,
    root: repoRoot,
    scanDirs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--root') opts.root = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--scan-dir') opts.scanDirs.push(requireValue(argv, ++i, arg));
    else if (arg === '--max-findings') opts.maxFindings = parsePositiveInteger(requireValue(argv, ++i, arg), arg);
    else if (arg === '--fail-on-findings') opts.failOnFindings = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.scanDirs.length === 0) opts.scanDirs = DEFAULT_SCAN_DIRS;
  return opts;
}

function extensionOf(filePath) {
  const match = /\.[^.]+$/.exec(filePath);
  return match?.[0] ?? '';
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(child, files);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extensionOf(entry.name))) {
      files.push(child);
    }
  }
  return files.sort();
}

function normalizeRepoPath(root, filePath) {
  return relative(root, filePath).replaceAll('\\', '/');
}

function lineContext(lines, index) {
  return [
    lines[index - 1] ?? '',
    lines[index] ?? '',
    lines[index + 1] ?? '',
  ].join('\n');
}

function addFinding(findings, rule, file, line, evidence, message) {
  findings.push({
    evidence: evidence.trim(),
    file,
    line,
    message,
    rule,
  });
}

function hasFullValuePath(context) {
  return /\b(?:aria-label|aria-describedby|title|data-full-value|data-truncation-exception|data-wrap-exception)\s*=/.test(context)
    || /soup-(?:truncate|wrap)-ok/.test(context);
}

function hasAxisMin(context, axis) {
  if (axis === 'x') return /\bmin-w-0\b/.test(context);
  if (axis === 'y') return /\bmin-h-0\b/.test(context);
  return /\bmin-h-0\b/.test(context) && /\bmin-w-0\b/.test(context);
}

function scanLine(findings, file, lines, index) {
  const line = lines[index];
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

  const context = lineContext(lines, index);
  const lineNumber = index + 1;

  if (/\b(?:truncate|whitespace-nowrap|overflow-hidden\s+text-ellipsis|text-ellipsis\s+overflow-hidden)\b/.test(line) && !hasFullValuePath(context)) {
    addFinding(
      findings,
      'soup/no-unsafe-truncation',
      file,
      lineNumber,
      line,
      'Truncation or nowrap needs a full-value disclosure path or explicit exception.',
    );
  }

  const hasXScroll = /\boverflow-x-(?:auto|scroll)\b/.test(line);
  const hasYScroll = /\boverflow-y-(?:auto|scroll)\b/.test(line);
  const hasBothScroll = /\boverflow-(?:auto|scroll)\b/.test(line);
  if ((hasXScroll || hasYScroll || hasBothScroll) && !/soup-scroll-owner-ok|data-scroll-owner\s*=/.test(context)) {
    const axis = hasBothScroll ? 'both' : hasXScroll ? 'x' : 'y';
    if (!hasAxisMin(context, axis)) {
      addFinding(
        findings,
        'soup/scroll-owner-required',
        file,
        lineNumber,
        line,
        'Scrollable regions need axis min-size proof or an explicit scroll-owner exception.',
      );
    }
  }

  if (/\b(?:hover|focus|focus-visible|focus-within):(?:w|h|min-w|max-w|min-h|max-h|p|px|py|pt|pr|pb|pl|gap|basis)-/.test(line)
    || /:(?:hover|focus-visible|focus-within)[^{]*\{[^}]*\b(?:width|height|min-width|max-width|min-height|max-height|padding|gap)\s*:/.test(line)) {
    addFinding(
      findings,
      'soup/no-layout-shift-interaction',
      file,
      lineNumber,
      line,
      'Hover/focus states must not change neighboring layout geometry.',
    );
  }

  if (/\b(?:group-hover|hover):(?:opacity|visible|block|inline-flex|flex|scale|translate)-?/.test(line)
    && !/\b(?:group-focus-within|focus-within|focus-visible|focus):/.test(context)
    && !/data-hover-only-exception\s*=/.test(context)) {
    addFinding(
      findings,
      'soup/no-hover-only-content',
      file,
      lineNumber,
      line,
      'Hover-revealed content needs keyboard/touch parity or a documented exception.',
    );
  }

  if (/\b(?:text-\[[^\]]*vw[^\]]*\]|fontSize\s*[:=][^,\n}]*vw|font-size\s*:[^;\n}]*vw|clamp\([^)\n]*vw[^)\n]*\))/.test(line)) {
    addFinding(
      findings,
      'soup/no-vw-font-size',
      file,
      lineNumber,
      line,
      'Typography must use the type scale, not viewport-width math.',
    );
  }

  if (/\bz-(?:\[[^\]]+\]|\d+)\b/.test(line)
    && !/\bz-\[var\(--z-[^)]+\)\]/.test(line)
    && !/soup-layer-ok|data-layer-owner\s*=/.test(context)) {
    addFinding(
      findings,
      'soup/layer-owner-required',
      file,
      lineNumber,
      line,
      'Layering must use named z-index tokens or a documented layer owner.',
    );
  }
}

function scanFile(root, filePath) {
  const file = normalizeRepoPath(root, filePath);
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) scanLine(findings, file, lines, i);
  return findings;
}

function sortFindings(findings) {
  return findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);
}

function summarize(findings) {
  const byRule = {};
  for (const finding of findings) byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  return Object.fromEntries(Object.entries(byRule).sort(([a], [b]) => a.localeCompare(b)));
}

function buildReport(opts) {
  const root = resolve(opts.root);
  const scanDirs = opts.scanDirs.map((dir) => dir.replaceAll('\\', '/'));
  const files = scanDirs.flatMap((dir) => walk(resolve(root, dir)));
  const scannedFileCount = files.filter((file) => statSync(file).isFile()).length;
  // Fail-closed: a zero-file scan cannot distinguish "no violations" from
  // "nothing scanned" (broken glob / renamed path); refuse to PASS on empty.
  const emptyScan = scannedFileCount === 0;
  const findings = sortFindings(files.flatMap((file) => scanFile(root, file)));
  const shownFindings = findings.slice(0, opts.maxFindings);
  const reportOnly = !opts.failOnFindings;

  return {
    by_rule: summarize(findings),
    finding_count: findings.length,
    findings: shownFindings,
    generated_at_utc: new Date().toISOString(),
    mode: reportOnly ? 'report-only' : 'fail-on-findings',
    paths: {
      root,
      scan_dirs: scanDirs,
    },
    sample_count: shownFindings.length,
    scanned_file_count: scannedFileCount,
    schema_version: 1,
    truncated: shownFindings.length < findings.length,
    verdict: emptyScan || (opts.failOnFindings && findings.length > 0) ? 'FAIL' : 'PASS',
    ...(emptyScan
      ? { empty_scan_error: `No scannable files under ${scanDirs.join(', ')} — refusing to PASS (fail-closed); check scan paths/globs.` }
      : {}),
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
