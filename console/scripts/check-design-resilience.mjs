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
  --fail-on-rule <rule>  Exit 1 when findings for this rule are present. Repeatable.
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
    failOnRules: new Set(),
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
    else if (arg === '--fail-on-rule') opts.failOnRules.add(requireValue(argv, ++i, arg));
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
  // Generic aria-describedby often points at helper/error text; require an explicit
  // full-value marker instead of treating every description as disclosure.
  return /\b(?:aria-label|title|data-full-value|data-truncation-exception|data-wrap-exception)\s*=/.test(context)
    || /soup-(?:truncate|wrap)-ok/.test(context);
}

function hasAxisMin(context, axis) {
  if (axis === 'x') return /\bmin-w-0\b/.test(context);
  if (axis === 'y') return /\bmin-h-0\b/.test(context);
  return /\bmin-h-0\b/.test(context) && /\bmin-w-0\b/.test(context);
}

const interactionLayoutUtilityPattern = /\b(?:hover|focus|focus-visible|focus-within|active):(?:(?:w|h|min-w|max-w|min-h|max-h|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|basis|grid-cols|grid-rows)-|border(?:-[xytrblse])?(?:-\d|-\[|(?=\s|["'`}])))/;
const interactionLayoutCssPattern = /:(?:hover|focus|focus-visible|focus-within|active)[^{]*\{[^}]*\b(?:width|height|min-width|max-width|min-height|max-height|padding|padding-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)|margin|margin-(?:top|right|bottom|left|block|block-start|block-end|inline|inline-start|inline-end)|gap|row-gap|column-gap|flex-basis|grid-template-columns|grid-template-rows|border-width|border-(?:top|right|bottom|left)-width)\s*:/;
const rawViewportJsPattern = /\bwindow\s*\.\s*(?:innerWidth|innerHeight|matchMedia|visualViewport)\b|\bmatchMedia\s*\(/;
const staticViewportHeightPattern = /\b(?:min-|max-)?h-screen\b|(?<![a-z])\d*\.?\d+vh\b/i;
const rawCssFocusSuppressionPattern = /\boutline\s*:\s*(?:none|0(?:px)?)(?=\s*(?:!important\s*)?(?:;|$))/ig;
const focusRingOutlinePattern = /\boutline\s*:\s*(?!(?:none|0(?:px)?)(?=\s*(?:!important\s*)?(?:;|$)))[^;{}]*var\(--focus-ring\)[^;{}]*(?:;|$)/i;
const outlineOffsetPattern = /\boutline-offset\s*:\s*[^;{}]+(?:;|$)/i;

function isViewportOwnerFile(file) {
  return file === 'console/src/hooks/useBreakpoint.ts'
    || file === 'console/src/hooks/useBreakpoint.tsx'
    || file === 'console/src/hooks/useViewportPlacement.ts'
    || file === 'console/src/hooks/useViewportPlacement.tsx';
}

function maskCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function findMatchingBrace(text, openIndex) {
  let depth = 1;
  for (let i = openIndex + 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function collectCssRules(text, baseOffset = 0) {
  const rules = [];
  let segmentStart = 0;
  let openIndex = text.indexOf('{');

  while (openIndex !== -1) {
    const closeIndex = findMatchingBrace(text, openIndex);
    if (closeIndex === -1) break;

    const selector = text.slice(segmentStart, openIndex).trim();
    const body = text.slice(openIndex + 1, closeIndex);
    const bodyStart = baseOffset + openIndex + 1;

    if (selector.startsWith('@') || body.includes('{')) {
      rules.push(...collectCssRules(body, bodyStart));
    } else if (selector) {
      rules.push({ body, bodyStart, selector });
    }

    segmentStart = closeIndex + 1;
    openIndex = text.indexOf('{', segmentStart);
  }

  return rules;
}

function lineNumberAtOffset(text, offset) {
  return text.slice(0, Math.max(0, offset)).split('\n').length;
}

function lineAtOffset(text, offset) {
  const start = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end === -1 ? text.length : end);
}

function splitSelectors(selectorText) {
  return selectorText
    .split(',')
    .map((selector) => selector.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function baseFocusSelector(selector) {
  return selector
    .replace(/:focus-visible\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasTokenizedFocusOutline(body) {
  return focusRingOutlinePattern.test(body) && outlineOffsetPattern.test(body);
}

function hasFocusVisibleReplacement(selector, rules) {
  return splitSelectors(selector).every((rawSelector) => {
    const baseSelector = baseFocusSelector(rawSelector);
    return rules.some((rule) => hasTokenizedFocusOutline(rule.body)
      && splitSelectors(rule.selector).some((candidate) => (
        /:focus-visible\b/.test(candidate) && baseFocusSelector(candidate) === baseSelector
      )));
  });
}

function scanCssFocusSuppression(findings, file, text) {
  const masked = maskCssComments(text);
  const rules = collectCssRules(masked);

  for (const rule of rules) {
    for (const match of rule.body.matchAll(rawCssFocusSuppressionPattern)) {
      if (hasFocusVisibleReplacement(rule.selector, rules)) continue;

      const offset = rule.bodyStart + match.index;
      addFinding(
        findings,
        'soup/no-raw-css-focus-suppression',
        file,
        lineNumberAtOffset(text, offset),
        lineAtOffset(text, offset),
        'Raw CSS outline suppression needs a tokenized :focus-visible outline replacement.',
      );
    }
  }
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

  if (interactionLayoutUtilityPattern.test(line) || interactionLayoutCssPattern.test(line)) {
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

  if (staticViewportHeightPattern.test(line)) {
    addFinding(
      findings,
      'soup/no-static-viewport-height',
      file,
      lineNumber,
      line,
      'Viewport-height sizing must use dynamic viewport units (dvh), not static vh or h-screen.',
    );
  }

  if (rawViewportJsPattern.test(line)
    && !isViewportOwnerFile(file)
    && !/soup-viewport-js-ok|data-viewport-owner\s*=/.test(context)) {
    addFinding(
      findings,
      'soup/no-raw-viewport-js',
      file,
      lineNumber,
      line,
      'Viewport branching must route through a sanctioned breakpoint or placement owner.',
    );
  }

  // Trailing boundary is a negative lookahead, NOT \b: `]` is a non-word char, so a
  // trailing \b never matches the `z-[N]` arbitrary form (z-[110] etc.) — only the
  // bare `z-50` form. (?![\w-]) closes that hole so both forms are caught.
  if (/\bz-(?:\[[^\]]+\]|\d+)(?![\w-])/.test(line)
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
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) scanLine(findings, file, lines, i);
  if (extensionOf(filePath) === '.css') scanCssFocusSuppression(findings, file, text);
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
  const failedRules = [...new Set(findings
    .filter((finding) => opts.failOnFindings || opts.failOnRules.has(finding.rule))
    .map((finding) => finding.rule))]
    .sort();
  const enforcedRules = [...opts.failOnRules].sort();
  const reportOnly = !opts.failOnFindings && enforcedRules.length === 0;

  return {
    by_rule: summarize(findings),
    enforced_rules: opts.failOnFindings ? ['*'] : enforcedRules,
    failed_rules: failedRules,
    finding_count: findings.length,
    findings: shownFindings,
    generated_at_utc: new Date().toISOString(),
    mode: reportOnly ? 'report-only' : opts.failOnFindings ? 'fail-on-findings' : 'fail-on-rule',
    paths: {
      root,
      scan_dirs: scanDirs,
    },
    sample_count: shownFindings.length,
    scanned_file_count: scannedFileCount,
    schema_version: 1,
    truncated: shownFindings.length < findings.length,
    verdict: emptyScan || failedRules.length > 0 ? 'FAIL' : 'PASS',
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
