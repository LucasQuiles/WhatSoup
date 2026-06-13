#!/usr/bin/env node
// Report provider, chart data, traffic, and component-local palette semantic drift.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_SCAN_DIRS = ['console/src'];
const DEFAULT_MAX_FINDINGS = 200;
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx']);

const BORROWED_TOKEN_OR_CLASS_RE = /\b(?:text|bg|border)-[ms]-(?:ok|warn|crit|pas|cht|agt)\b|var\(--(?:color-[ms]-|status-|mode-)[^)]+\)/;
const BORROWED_CHROMA_RE = new RegExp(`${BORROWED_TOKEN_OR_CLASS_RE.source}|#[0-9a-fA-F]{3,8}\\b`);
const PROVIDER_IDENTITY_RE = /\b(?:PROVIDER_COLORS|getProviderColor|providerDisplay|displayName\(slot\.provider|slot\.provider)\b|label:\s*['"]PROVIDER['"]/i;
const PROVIDER_TOKEN_RE = /var\(--provider-[^)]+\)/;
const DATA_TOKEN_RE = /var\(--data-[^)]+\)/;
const CHART_FILE_RE = /(?:Chart|Heatmap)\.tsx$/;
const CHART_COLOR_RE = /\b(?:stroke|fill|stopColor|activeColor|background|color)\s*[=:]|color-mix\(|return\s+['"`]var\(--|return\s+['"`]color-mix/;
const LOCAL_PALETTE_RE = /\b(?:export\s+)?(?:const|let)\s+\w*(?:color|Color|palette|Palette)\w*\s*(?::\s*Record<[^>]+>\s*=|=\s*\{)|Record<string,\s*string>\s*=\s*\{/;
const NEUTRAL_TRAFFIC_LABELS = new Set([
  'Messages Sent',
  'Messages Received',
  'Agent Sessions',
  'Media Processed',
]);
const TRAFFIC_LABEL_LINE_RE = /label:\s*['"](?:Messages Sent|Messages Received|Agent Sessions|Media Processed|SESSIONS)['"]/i;
const TRAFFIC_CONTEXT_RE = /\b(?:Messages Sent|Messages Received|Agent Sessions|Media Processed|sent|recv|received|inbound|outbound|media|activeSessions|totalSessions|sessions)\b/i;
const NEUTRAL_CLASS_RE = /\b(?:neutral|text-t[1-5])\b|var\(--(?:color-t[1-5]|text-[1-3])\)/;

function usage() {
  return `Usage: node console/scripts/check-color-semantics.mjs [options]

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

function lineContext(lines, index, radius = 2) {
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  return lines.slice(start, end).join('\n');
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

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.rule}\0${finding.file}\0${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function isProviderColorBlock(lines, index) {
  for (let i = index; i >= Math.max(0, index - 12); i -= 1) {
    if (/PROVIDER_COLORS/.test(lines[i])) return true;
    if (/^\s*};?\s*$/.test(lines[i])) return false;
  }
  return false;
}

function classLooksNeutral(value) {
  return NEUTRAL_CLASS_RE.test(value) && !BORROWED_CHROMA_RE.test(value);
}

function scanKpiBlocks(findings, file, lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!/<KpiCard\b/.test(lines[i])) continue;
    const block = [];
    let end = i;
    for (; end < lines.length; end += 1) {
      block.push(lines[end]);
      if (/\/>\s*$/.test(lines[end])) break;
    }
    const source = block.join('\n');
    const label = /label=["']([^"']+)["']/.exec(source)?.[1];
    const color = /color=["']([^"']+)["']/.exec(source)?.[1];
    if (!label || !color || !NEUTRAL_TRAFFIC_LABELS.has(label) || classLooksNeutral(color)) continue;
    const colorOffset = block.findIndex((line) => /color=/.test(line));
    addFinding(
      findings,
      'soup/traffic-neutrality',
      file,
      i + colorOffset + 1,
      block[colorOffset] ?? source,
      `Traffic quantity "${label}" must render in neutral ink unless it is reclassified as status.`,
    );
  }
}

function scanLine(findings, file, lines, index) {
  const line = lines[index];
  if (isCommentLine(line)) return;

  const context = lineContext(lines, index);
  const lineNumber = index + 1;
  const borrowed = BORROWED_CHROMA_RE.test(line);

  if (borrowed
    && !PROVIDER_TOKEN_RE.test(line)
    && !TRAFFIC_LABEL_LINE_RE.test(line)
    && (isProviderColorBlock(lines, index) || PROVIDER_IDENTITY_RE.test(line) || PROVIDER_IDENTITY_RE.test(context))) {
    addFinding(
      findings,
      'soup/provider-palette-only',
      file,
      lineNumber,
      line,
      'Provider identity color must consume --provider-* tokens, not status/mode/data tokens or literal colors.',
    );
  }

  if (borrowed
    && !DATA_TOKEN_RE.test(line)
    && CHART_FILE_RE.test(file)
    && CHART_COLOR_RE.test(line)) {
    addFinding(
      findings,
      'soup/data-series-token-only',
      file,
      lineNumber,
      line,
      'Chart data dimensions must consume --data-* tokens unless the series is explicitly provider identity.',
    );
  }

  if (BORROWED_TOKEN_OR_CLASS_RE.test(line)
    && (TRAFFIC_LABEL_LINE_RE.test(line) || TRAFFIC_CONTEXT_RE.test(context))
    && !classLooksNeutral(line)
    && (TRAFFIC_LABEL_LINE_RE.test(line) || !/Need Attention|Unread|Lines Connected|linkedStatus|status|error|warn|crit|ok/i.test(context))) {
    addFinding(
      findings,
      'soup/traffic-neutrality',
      file,
      lineNumber,
      line,
      'Traffic quantities must render in neutral ink unless the metric is a declared status/severity datum.',
    );
  }

  if (/^console\/src\/(?:components|pages)\//.test(file)
    && LOCAL_PALETTE_RE.test(line)
    && /color/i.test(line)
    && !/data-local-palette-exception/.test(context)) {
    addFinding(
      findings,
      'soup/no-component-local-palette',
      file,
      lineNumber,
      line,
      'Component-local color palettes must move to documented provider/data/status token maps or carry an explicit exception.',
    );
  }
}

function scanFile(root, filePath) {
  const file = normalizeRepoPath(root, filePath);
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const findings = [];
  scanKpiBlocks(findings, file, lines);
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
  const findings = sortFindings(uniqueFindings(files.flatMap((file) => scanFile(root, file))));
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
    scanned_file_count: files.filter((file) => statSync(file).isFile()).length,
    schema_version: 1,
    truncated: shownFindings.length < findings.length,
    verdict: opts.failOnFindings && findings.length > 0 ? 'FAIL' : 'PASS',
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
