#!/usr/bin/env node
// Deterministic line-shape inventory for small/stable shadow categories.
//
// The shadow ratchet (`check-shadow-baseline.mjs`) owns fall-only rule x file
// counts. This guard complements it for frozen categories where same-file,
// same-count movement should not pass silently.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_BASELINE_PATH = resolve(consoleRoot, 'design-shadow-frozen-inventory.json');
const DEFAULT_ESLINT_ARGS = ['eslint', '.', '-c', 'eslint.config.shadow.mjs', '--format', 'json'];
const TRACKED_RULES = {
  'no-restricted-syntax': 'base-wall',
  'soup/no-brand-regression': 'brand-regression',
};
const TRACKED_CATEGORIES = [...new Set(Object.values(TRACKED_RULES))].sort();

function usage() {
  return `Usage: node console/scripts/check-shadow-frozen-inventory.mjs [options]

Options:
  --root <path>         Repository root. Default: current repository root.
  --eslint-json <path>  Read existing ESLint JSON instead of invoking shadow ESLint.
  --baseline <path>     Inventory baseline to compare/update.
                         Default: console/design-shadow-frozen-inventory.json.
  --no-baseline         Do not compare a generated baseline. Intended for unit fixtures.
  --update              Regenerate the inventory baseline from the mechanical scan.
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
    baselineArgProvided: false,
    baselineEnabled: true,
    baselinePath: DEFAULT_BASELINE_PATH,
    eslintJson: null,
    help: false,
    root: repoRoot,
    update: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--root') opts.root = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--eslint-json') opts.eslintJson = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--baseline') {
      opts.baselineArgProvided = true;
      opts.baselinePath = resolve(requireValue(argv, ++i, arg));
    } else if (arg === '--no-baseline') opts.baselineEnabled = false;
    else if (arg === '--update') opts.update = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

function normalizeRepoPath(root, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const rootPrefix = `${root.replaceAll('\\', '/')}/`;
  if (normalized.startsWith(rootPrefix)) return normalized.slice(rootPrefix.length);
  if (normalized.startsWith('console/')) return normalized;
  if (normalized.startsWith('src/')) return `console/${normalized}`;
  const consoleMarker = '/console/';
  const markerIndex = normalized.lastIndexOf(consoleMarker);
  if (markerIndex >= 0) return `console/${normalized.slice(markerIndex + consoleMarker.length)}`;
  return normalized;
}

function displayBaselinePath(root, baselinePath) {
  return relative(root, baselinePath).split(sep).join('/');
}

function readEslintJson(opts) {
  if (opts.eslintJson) return readFileSync(opts.eslintJson, 'utf8');

  try {
    return execFileSync('npx', DEFAULT_ESLINT_ARGS, {
      cwd: resolve(opts.root, 'console'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
}

function shadowRule(message, ruleId) {
  const tag = /^\[([a-z/-]+)[ \]]/.exec(message ?? '')?.[1];
  return tag ?? ruleId ?? '(no-rule)';
}

function compareHit(left, right) {
  return left.category.localeCompare(right.category)
    || left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.rule.localeCompare(right.rule)
    || left.message.localeCompare(right.message);
}

function sortedObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function buildInventory(results, opts) {
  const hits = [];

  for (const fileResult of results) {
    const file = normalizeRepoPath(opts.root, fileResult.filePath ?? '');
    for (const message of fileResult.messages ?? []) {
      const rule = shadowRule(message.message, message.ruleId);
      const category = TRACKED_RULES[rule];
      if (!category) continue;
      hits.push({
        category,
        column: message.column ?? 1,
        file,
        line: message.line ?? 1,
        message: message.message ?? '',
        rule,
      });
    }
  }

  hits.sort(compareHit);

  const byCategory = Object.fromEntries(TRACKED_CATEGORIES.map((category) => [category, 0]));
  const fileSet = new Set();
  const byFileMap = new Map();

  for (const hit of hits) {
    byCategory[hit.category] = (byCategory[hit.category] ?? 0) + 1;
    fileSet.add(hit.file);
    const entry = byFileMap.get(hit.file) ?? {
      by_category: Object.fromEntries(TRACKED_CATEGORIES.map((category) => [category, 0])),
      file: hit.file,
      lines: [],
      total: 0,
    };
    entry.by_category[hit.category] = (entry.by_category[hit.category] ?? 0) + 1;
    entry.lines.push(hit.line);
    entry.total += 1;
    byFileMap.set(hit.file, entry);
  }

  const byFile = [...byFileMap.values()]
    .map((entry) => ({
      ...entry,
      by_category: sortedObject(entry.by_category),
      lines: [...new Set(entry.lines)].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    schema_version: 1,
    source_of_truth: {
      eslint_config: 'console/eslint.config.shadow.mjs',
      eslint_command: DEFAULT_ESLINT_ARGS,
      shadow_baseline: 'console/lint-shadow-baseline.json',
      tracked_rules: TRACKED_RULES,
    },
    tracked_categories: TRACKED_CATEGORIES,
    totals: {
      by_category: sortedObject(byCategory),
      files: fileSet.size,
      total: hits.length,
    },
    by_file: byFile,
    hits,
    errors: [],
    verdict: 'PASS',
  };
}

function baselineSnapshot(inventory) {
  return {
    schema_version: inventory.schema_version,
    source_of_truth: inventory.source_of_truth,
    tracked_categories: inventory.tracked_categories,
    totals: inventory.totals,
    by_file: inventory.by_file,
    hits: inventory.hits,
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readBaseline(path) {
  if (!existsSync(path)) {
    return {
      errors: [{
        code: 'baseline-missing',
        message: `No generated frozen shadow inventory exists at ${path}. Run with --update to create it.`,
      }],
      snapshot: null,
    };
  }
  try {
    return {
      errors: [],
      snapshot: JSON.parse(readFileSync(path, 'utf8')),
    };
  } catch (error) {
    return {
      errors: [{
        code: 'baseline-invalid-json',
        message: error instanceof Error ? error.message : String(error),
      }],
      snapshot: null,
    };
  }
}

function baselineMismatches(observedSnapshot, expectedSnapshot) {
  if (!expectedSnapshot) return [];
  if (stableJson(observedSnapshot) === stableJson(expectedSnapshot)) return [];
  return [{
    path: 'generated_inventory',
    message:
      'Live frozen shadow inventory differs from console/design-shadow-frozen-inventory.json. ' +
      'Classify the movement, then regenerate with --update in the same packet as the source/rule change.',
  }];
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      return;
    }

    if (opts.update && !opts.baselineEnabled) {
      console.error('FAIL: --update cannot be combined with --no-baseline');
      process.exit(2);
    }
    if (opts.update && opts.eslintJson && !opts.baselineArgProvided) {
      console.error('FAIL: --eslint-json cannot be combined with --update without --baseline');
      process.exit(2);
    }

    const results = JSON.parse(readEslintJson(opts));
    const inventory = buildInventory(results, opts);
    const snapshot = baselineSnapshot(inventory);
    const baseline = {
      enabled: opts.baselineEnabled,
      path: displayBaselinePath(opts.root, opts.baselinePath),
      update: opts.update,
    };

    if (opts.update) {
      mkdirSync(dirname(opts.baselinePath), { recursive: true });
      writeFileSync(opts.baselinePath, stableJson(snapshot));
      inventory.baseline = {
        ...baseline,
        errors: [],
        mismatches: [],
      };
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }

    if (opts.baselineEnabled) {
      const expectedBaseline = readBaseline(opts.baselinePath);
      const mismatches = baselineMismatches(snapshot, expectedBaseline.snapshot);
      inventory.baseline = {
        ...baseline,
        errors: expectedBaseline.errors,
        mismatches,
      };
      if (expectedBaseline.errors.length || mismatches.length) inventory.verdict = 'FAIL';
    } else {
      inventory.baseline = {
        ...baseline,
        errors: [],
        mismatches: [],
      };
    }

    console.log(JSON.stringify(inventory, null, 2));

    if (inventory.errors.length || inventory.baseline.errors.length || inventory.baseline.mismatches.length) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
