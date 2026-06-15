#!/usr/bin/env node
// Verify that every implemented soup/* design lint has firing and silent fixtures.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_DESIGN_LINTS = resolve(repoRoot, 'tests/console/design-lints.test.ts');
const DEFAULT_SELECTORS = resolve(consoleRoot, 'eslint-rules/design-selectors.mjs');
const DEFAULT_PLUGIN = resolve(consoleRoot, 'eslint-rules/index.mjs');
const DEFAULT_SHADOW_CONFIG = resolve(consoleRoot, 'eslint.config.shadow.mjs');
const DEFAULT_LINT_PLAN = resolve(repoRoot, 'docs/design-system/04-enforcement/lint-plan.md');

function usage() {
  return `Usage: node console/scripts/check-design-lint-fixtures.mjs [options]

Options:
  --design-lints <path>   Fixture test file. Default: tests/console/design-lints.test.ts
  --selectors <path>      Promoted selector SSOT. Default: console/eslint-rules/design-selectors.mjs
  --plugin <path>         soup plugin file. Default: console/eslint-rules/index.mjs
  --shadow-config <path>  Shadow ESLint config. Default: console/eslint.config.shadow.mjs
  --lint-plan <path>      Enforcement docs. Default: docs/design-system/04-enforcement/lint-plan.md
  --help                  Print this message.
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    designLints: DEFAULT_DESIGN_LINTS,
    help: false,
    lintPlan: DEFAULT_LINT_PLAN,
    plugin: DEFAULT_PLUGIN,
    selectors: DEFAULT_SELECTORS,
    shadowConfig: DEFAULT_SHADOW_CONFIG,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--design-lints') opts.designLints = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--selectors') opts.selectors = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--plugin') opts.plugin = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--shadow-config') opts.shadowConfig = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--lint-plan') opts.lintPlan = resolve(requireValue(argv, ++i, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function extractMessageRuleIds(text) {
  return uniqueSorted([...text.matchAll(/\[soup\/([a-z0-9-]+)(?=[\]\s])/g)].map((match) => match[1]));
}

function extractStubRuleIds(text) {
  return uniqueSorted([...text.matchAll(/\[stub\]\s+soup\/([a-z0-9-]+)/g)].map((match) => match[1]));
}

function extractPluginRuleIds(text) {
  return uniqueSorted([...text.matchAll(/^\s*['"`]([a-z0-9-]+)['"`]\s*:/gm)].map((match) => match[1]));
}

function extractFixtureSuiteIds(text) {
  return uniqueSorted([...text.matchAll(/describe\(\s*['"`]soup\/([a-z0-9-]+)['"`]/g)].map((match) => match[1]));
}

function extractErrorProbeIds(text) {
  return uniqueSorted([
    ...text.matchAll(/expect\(\s*hasError\(\s*messages\s*,\s*['"`]([a-z0-9-]+)['"`]\s*\)\s*\)\.toBe\(\s*true\s*\)/g),
  ].map((match) => match[1]));
}

function findSuiteBody(text, ruleId) {
  const suiteRe = new RegExp(`describe\\(\\s*['"\`]soup/${ruleId}['"\`]`);
  const match = suiteRe.exec(text);
  if (!match) return '';
  const start = match.index;
  const nextMarkers = [
    text.indexOf('\n// ---------------------------------------------------------------------------', start + 1),
    text.indexOf('\n// ===========================================================================', start + 1),
  ].filter((index) => index > start);
  const end = nextMarkers.length > 0 ? Math.min(...nextMarkers) : text.length;
  return text.slice(start, end);
}

function suiteHasFiringCase(body) {
  return /\bit\(\s*['"`][^'"`]*(fires|fire|flags|reports)/i.test(body);
}

function suiteHasSilentCase(body) {
  return /\bit\(\s*['"`][^'"`]*(is silent|stays silent|does not fire|does not flag|allows)/i.test(body);
}

function hasLintPlanRow(lintPlan, ruleId) {
  return new RegExp(`^\\|\\s*soup/${ruleId}\\s*\\|`, 'm').test(lintPlan);
}

function buildReport(paths, files) {
  const promotedSelectorRules = extractMessageRuleIds(files.selectors);
  const shadowSelectorRules = extractMessageRuleIds(files.shadowConfig);
  const pluginImplementedRules = extractMessageRuleIds(files.plugin);
  const pluginRegisteredRules = extractPluginRuleIds(files.plugin);
  const stubRules = extractStubRuleIds(files.plugin);
  const undocumentedStubRules = pluginRegisteredRules.filter(
    (rule) => !pluginImplementedRules.includes(rule) && !stubRules.includes(rule)
  );
  const implementedRules = uniqueSorted([
    ...promotedSelectorRules,
    ...shadowSelectorRules,
    ...pluginImplementedRules,
  ]);
  const suiteRules = extractFixtureSuiteIds(files.designLints);
  const errorProbeRules = extractErrorProbeIds(files.designLints);
  const failures = [];
  const fixture_suites = {};

  for (const rule of implementedRules) {
    const body = findSuiteBody(files.designLints, rule);
    const hasSuite = suiteRules.includes(rule);
    const fires = body ? suiteHasFiringCase(body) : false;
    const silent = body ? suiteHasSilentCase(body) : false;
    const hasErrorProbe = errorProbeRules.includes(rule);
    const lintPlanRow = hasLintPlanRow(files.lintPlan, rule);

    fixture_suites[rule] = {
      error_probe: hasErrorProbe,
      fires,
      lint_plan_row: lintPlanRow,
      silent,
    };

    if (!lintPlanRow) failures.push({ code: 'MISSING_LINT_PLAN_ROW', rule });
    if (!hasSuite) failures.push({ code: 'MISSING_FIXTURE_SUITE', rule });
    else {
      if (!fires) failures.push({ code: 'MISSING_FIRING_FIXTURE', rule });
      if (!silent) failures.push({ code: 'MISSING_SILENT_FIXTURE', rule });
    }
    if (promotedSelectorRules.includes(rule) && !hasErrorProbe) {
      failures.push({ code: 'MISSING_PROMOTED_ERROR_PROBE', rule });
    }
  }

  for (const rule of uniqueSorted([...stubRules, ...undocumentedStubRules])) {
    if (undocumentedStubRules.includes(rule)) failures.push({ code: 'MISSING_STUB_DOC', rule });
    if (implementedRules.includes(rule)) failures.push({ code: 'IMPLEMENTED_RULE_STILL_STUB', rule });
    if (!hasLintPlanRow(files.lintPlan, rule)) failures.push({ code: 'MISSING_STUB_LINT_PLAN_ROW', rule });
  }

  // Fail-closed on an empty scan. If the plugin/selector/shadow sources parsed zero
  // rules of any kind, the SSOT files were emptied/renamed/parse-broken — the per-rule
  // loops above ran zero times and the report would otherwise vacuously PASS with no
  // coverage checked. (A genuinely empty rule set cannot occur in this repo; the live
  // contract asserts >=10 implemented + >=4 stub.)
  if (
    implementedRules.length === 0 &&
    stubRules.length === 0 &&
    pluginRegisteredRules.length === 0
  ) {
    failures.push({ code: 'EMPTY_RULE_SET', rule: '(scan)' });
  }

  return {
    error_probe_rules: errorProbeRules,
    failures,
    fixture_suites,
    implemented_rules: implementedRules,
    paths,
    plugin_registered_rules: pluginRegisteredRules,
    promoted_selector_rules: promotedSelectorRules,
    schema_version: 1,
    shadow_selector_rules: shadowSelectorRules,
    stub_rules: stubRules,
    undocumented_stub_rules: undocumentedStubRules,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
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

  const paths = {
    design_lints: opts.designLints,
    lint_plan: opts.lintPlan,
    plugin: opts.plugin,
    selectors: opts.selectors,
    shadow_config: opts.shadowConfig,
  };
  const report = buildReport(paths, {
    designLints: read(opts.designLints),
    lintPlan: read(opts.lintPlan),
    plugin: read(opts.plugin),
    selectors: read(opts.selectors),
    shadowConfig: read(opts.shadowConfig),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'PASS') process.exit(1);
}

main();
