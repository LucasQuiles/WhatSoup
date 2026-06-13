#!/usr/bin/env node
// Deterministic inventory for soup/no-raw-form-control shadow findings.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const RULE_TAG = 'soup/no-raw-form-control';
const PRIMITIVE_SELF_MODULE = 'console/src/components/primitives/FormControl.tsx';
const DEFAULT_BASELINE_PATH = resolve(consoleRoot, 'design-raw-form-control-inventory.json');
const DEFAULT_ESLINT_ARGS = ['eslint', '.', '-c', 'eslint.config.shadow.mjs', '--format', 'json'];
const ELEMENTS = ['input', 'select', 'textarea'];

function usage() {
  return `Usage: node console/scripts/check-raw-form-control-inventory.mjs [options]

Options:
  --root <path>                  Repository root. Default: current repository root.
  --eslint-json <path>           Read existing ESLint JSON instead of invoking shadow ESLint.
  --baseline <path>              Inventory baseline to compare/update.
                                  Default: console/design-raw-form-control-inventory.json.
  --no-baseline                  Do not compare a generated baseline. Intended for unit fixtures.
  --update                       Regenerate the inventory baseline from the mechanical scan.
  --expected-total <n>           Expected total raw form-control findings.
  --expected-consumer <n>        Expected consumer-migration findings.
  --expected-exemption <n>       Expected primitive self-hit findings.
  --expected-input <n>           Expected raw input findings.
  --expected-select <n>          Expected raw select findings.
  --expected-textarea <n>        Expected raw textarea findings.
  --fail-on-mismatch             Exit 1 when expected counts differ from observed counts.
  --help                         Print this message.
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseNonNegativeInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} requires a non-negative integer`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    baselineEnabled: true,
    baselinePath: DEFAULT_BASELINE_PATH,
    eslintJson: null,
    expected: {
      by_classification: {},
      by_element: {},
      total: null,
    },
    failOnMismatch: false,
    help: false,
    root: repoRoot,
    update: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--root') opts.root = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--eslint-json') opts.eslintJson = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--baseline') opts.baselinePath = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--no-baseline') opts.baselineEnabled = false;
    else if (arg === '--update') opts.update = true;
    else if (arg === '--expected-total') opts.expected.total = parseNonNegativeInteger(requireValue(argv, ++i, arg), arg);
    else if (arg === '--expected-consumer') opts.expected.by_classification.consumer_migration = parseNonNegativeInteger(requireValue(argv, ++i, arg), arg);
    else if (arg === '--expected-exemption') opts.expected.by_classification.exemption_movement = parseNonNegativeInteger(requireValue(argv, ++i, arg), arg);
    else if (arg === '--expected-input') opts.expected.by_element.input = parseNonNegativeInteger(requireValue(argv, ++i, arg), arg);
    else if (arg === '--expected-select') opts.expected.by_element.select = parseNonNegativeInteger(requireValue(argv, ++i, arg), arg);
    else if (arg === '--expected-textarea') opts.expected.by_element.textarea = parseNonNegativeInteger(requireValue(argv, ++i, arg), arg);
    else if (arg === '--fail-on-mismatch') opts.failOnMismatch = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

function readEslintJson(opts) {
  if (opts.eslintJson) return readFileSync(opts.eslintJson, 'utf8');

  const cwd = resolve(opts.root, 'console');
  try {
    return execFileSync('npx', DEFAULT_ESLINT_ARGS, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // ESLint exits non-zero when default-config errors exist; stdout still carries JSON.
    if (err.stdout) return err.stdout;
    throw err;
  }
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

function sourcePath(root, repoPath) {
  return resolve(root, repoPath);
}

function sourceLines(root, repoPath, errors) {
  const path = sourcePath(root, repoPath);
  if (!existsSync(path)) {
    errors.push({
      code: 'source-missing',
      file: repoPath,
      message: 'ESLint reported a raw form-control finding, but the source file could not be read.',
    });
    return [];
  }
  return readFileSync(path, 'utf8').split(/\r?\n/);
}

function findElementAtLine(lines, line) {
  const index = Math.max(0, (line ?? 1) - 1);
  for (let offset = 0; offset <= 6; offset += 1) {
    const candidate = lines[index + offset] ?? '';
    const match = /<\s*(input|select|textarea)\b/.exec(candidate);
    if (match) return match[1];
  }
  for (let offset = 1; offset <= 2; offset += 1) {
    const candidate = lines[index - offset] ?? '';
    const match = /<\s*(input|select|textarea)\b/.exec(candidate);
    if (match) return match[1];
  }
  return 'unknown';
}

function lineSnippet(lines, line) {
  const index = Math.max(0, (line ?? 1) - 1);
  return (lines[index] ?? '').trim();
}

function classificationFor(file) {
  if (file === PRIMITIVE_SELF_MODULE) return 'exemption_movement';
  return 'consumer_migration';
}

function consumerGroupFor(file, classification) {
  if (classification === 'exemption_movement') return 'form_kit_self_hits';
  if (file.startsWith('console/src/components/line-detail/')) return 'line_detail_and_modals';
  if (file.startsWith('console/src/components/wizard/')) return 'wizard_consumers';
  if (file.startsWith('console/src/components/shared/')) return 'shared_components';
  if (file.startsWith('console/src/components/')) return 'standalone_components';
  if (file.startsWith('console/src/pages/')) return 'pages';
  return 'other';
}

function isRawFormControlMessage(message) {
  return typeof message === 'string' && message.startsWith(`[${RULE_TAG}`);
}

function compareHit(a, b) {
  return a.file.localeCompare(b.file)
    || a.line - b.line
    || a.column - b.column
    || a.element.localeCompare(b.element);
}

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function sortedObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function buildInventory(results, opts) {
  const errors = [];
  const sourceCache = new Map();
  const hits = [];

  for (const fileResult of results) {
    const file = normalizeRepoPath(opts.root, fileResult.filePath ?? '');
    for (const message of fileResult.messages ?? []) {
      if (!isRawFormControlMessage(message.message)) continue;
      if (!sourceCache.has(file)) sourceCache.set(file, sourceLines(opts.root, file, errors));
      const lines = sourceCache.get(file);
      const element = findElementAtLine(lines, message.line);
      const classification = classificationFor(file);
      const consumerGroup = consumerGroupFor(file, classification);
      hits.push({
        classification,
        column: message.column ?? 1,
        consumer_group: consumerGroup,
        element,
        file,
        line: message.line ?? 1,
        rule: RULE_TAG,
        snippet: lineSnippet(lines, message.line),
      });
    }
  }

  hits.sort(compareHit);

  const byElement = {};
  const byClassification = {};
  const byConsumerGroup = {};
  const fileMap = new Map();

  for (const hit of hits) {
    increment(byElement, hit.element);
    increment(byClassification, hit.classification);
    increment(byConsumerGroup, hit.consumer_group);

    if (!fileMap.has(hit.file)) {
      fileMap.set(hit.file, {
        by_element: {},
        classification: hit.classification,
        consumer_group: hit.consumer_group,
        file: hit.file,
        lines: [],
        total: 0,
      });
    }
    const fileEntry = fileMap.get(hit.file);
    fileEntry.total += 1;
    fileEntry.lines.push(hit.line);
    increment(fileEntry.by_element, hit.element);
    if (fileEntry.classification !== hit.classification) fileEntry.classification = 'mixed';
    if (fileEntry.consumer_group !== hit.consumer_group) fileEntry.consumer_group = 'mixed';
  }

  for (const element of ELEMENTS) {
    byElement[element] ??= 0;
  }

  const byFile = [...fileMap.values()]
    .map((entry) => ({
      ...entry,
      by_element: sortedObject(entry.by_element),
      lines: entry.lines.sort((a, b) => a - b),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const totals = {
    by_classification: sortedObject(byClassification),
    by_consumer_group: sortedObject(byConsumerGroup),
    by_element: sortedObject(byElement),
    files: byFile.length,
    total: hits.length,
  };

  const mismatches = expectedMismatches(totals, opts.expected);
  const verdict = errors.length || mismatches.length ? 'FAIL' : 'PASS';

  return {
    schema_version: 2,
    source_of_truth: {
      eslint_config: 'console/eslint.config.shadow.mjs',
      eslint_command: DEFAULT_ESLINT_ARGS,
      primitive_exemption_glob: '**/components/primitives/**',
      primitive_self_module: PRIMITIVE_SELF_MODULE,
      rule_tag: RULE_TAG,
      shadow_baseline: 'console/lint-shadow-baseline.json',
    },
    classification_model: {
      consumer_migration: 'Raw form-control finding outside the transitional form-kit self module.',
      exemption_movement: 'Raw form-control finding in the transitional form-kit self module; only clears by moving the canonical primitive under components/primitives/**.',
    },
    expected: opts.expected,
    totals,
    by_file: byFile,
    hits,
    errors,
    mismatches,
    verdict,
  };
}

function expectedMismatches(totals, expected) {
  const mismatches = [];
  const comparisons = [
    ['total', totals.total, expected.total],
    ['by_classification.consumer_migration', totals.by_classification.consumer_migration ?? 0, expected.by_classification.consumer_migration],
    ['by_classification.exemption_movement', totals.by_classification.exemption_movement ?? 0, expected.by_classification.exemption_movement],
    ['by_element.input', totals.by_element.input ?? 0, expected.by_element.input],
    ['by_element.select', totals.by_element.select ?? 0, expected.by_element.select],
    ['by_element.textarea', totals.by_element.textarea ?? 0, expected.by_element.textarea],
  ];

  for (const [path, observed, expectedValue] of comparisons) {
    if (expectedValue === undefined || expectedValue === null) continue;
    if (observed === expectedValue) continue;
    mismatches.push({ expected: expectedValue, observed, path });
  }
  return mismatches;
}

function baselineSnapshot(inventory) {
  return {
    schema_version: 2,
    source_of_truth: inventory.source_of_truth,
    classification_model: inventory.classification_model,
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
        file: path,
        message: `No generated inventory baseline exists at ${path}. Run with --update to create it.`,
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
        file: path,
        message: error instanceof Error ? error.message : String(error),
      }],
      snapshot: null,
    };
  }
}

function baselineMismatches(observedSnapshot, expectedSnapshot) {
  if (!expectedSnapshot) return [];
  const observed = stableJson(observedSnapshot);
  const expected = stableJson(expectedSnapshot);
  if (observed === expected) return [];
  return [{
    path: 'generated_inventory',
    message:
      'Live raw form-control inventory differs from console/design-raw-form-control-inventory.json. ' +
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

    const raw = readEslintJson(opts);
    const results = JSON.parse(raw);
    const inventory = buildInventory(results, opts);
    const snapshot = baselineSnapshot(inventory);

    const baseline = {
      enabled: opts.baselineEnabled,
      path: opts.baselinePath,
      update: opts.update,
    };

    if (opts.update) {
      if (inventory.errors.length || inventory.mismatches.length) {
        inventory.baseline = {
          ...baseline,
          errors: [],
          mismatches: [],
        };
        inventory.verdict = 'FAIL';
        console.log(JSON.stringify(inventory, null, 2));
        process.exit(1);
      }
      writeFileSync(opts.baselinePath, stableJson(snapshot));
      inventory.baseline = {
        ...baseline,
        errors: [],
        mismatches: [],
      };
      inventory.verdict = 'PASS';
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

    if (
      inventory.errors.length
      || (opts.failOnMismatch && inventory.mismatches.length)
      || inventory.baseline.errors.length
      || inventory.baseline.mismatches.length
    ) {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
