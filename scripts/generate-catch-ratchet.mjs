/**
 * Audit or shrink eslint-rules/catch-ratchet-baseline.json.
 *
 * Exit codes:
 *   0  baseline matches, or --write completed a shrink
 *   1  actionable ratchet drift (new debt, or stale debt in --check mode)
 *   2  inconclusive (bad arguments, malformed baseline, or lint failure)
 *
 * The generator never blesses growth. `--write` only removes semantic
 * identities that no longer exist; any new identity blocks before the file is
 * touched.
 */

import { ESLint } from 'eslint';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fitnessPlugin from '../eslint-rules/index.mjs';
import { readCatchBaseline } from '../eslint-rules/require-catch-justification.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = resolve(ROOT, 'eslint-rules/catch-ratchet-baseline.json');
const IDENTITY_SUFFIX_RE = /\[catch-ratchet:(.+)]$/;

function usage() {
  console.error(
    'Usage: node scripts/generate-catch-ratchet.mjs [--check|--write]\n'
      + '  --check  report growth or stale entries without changing the baseline (default)\n'
      + '  --write  shrink stale entries; refuse all growth',
  );
}

function parseMode(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--check')) {
    return 'check';
  }
  if (argv.length === 1 && argv[0] === '--write') return 'write';
  usage();
  throw new Error(`unknown arguments: ${argv.join(' ')}`);
}

function counts(values) {
  const result = new Map();
  for (const value of values) {
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return result;
}

function expandDifference(left, right) {
  const rightCounts = counts(right);
  const difference = [];
  for (const identity of left) {
    const remaining = rightCounts.get(identity) ?? 0;
    if (remaining > 0) {
      rightCounts.set(identity, remaining - 1);
    } else {
      difference.push(identity);
    }
  }
  return difference;
}

export function compareCatchBaselines(baseline, current) {
  return {
    added: expandDifference(current, baseline),
    stale: expandDifference(baseline, current),
  };
}

async function scanCurrentIdentities() {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['src/**/*.ts'],
      languageOptions: {
        parser: (await import('typescript-eslint')).parser,
        parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
      },
      plugins: { fitness: fitnessPlugin },
      rules: {
        'fitness/require-catch-justification': [
          'error',
          { mode: 'report-all' },
        ],
      },
    },
  });
  const results = await eslint.lintFiles(['src/']);
  if (results.length === 0) {
    throw new Error('lint scanned zero source files; ratchet state is inconclusive');
  }

  const identities = [];
  for (const result of results) {
    for (const message of result.messages) {
      if (message.fatal) {
        throw new Error(
          `lint failed for ${result.filePath}:${message.line ?? 0}: ${message.message}`,
        );
      }
      if (message.ruleId !== 'fitness/require-catch-justification') continue;
      const match = IDENTITY_SUFFIX_RE.exec(message.message);
      if (!match) {
        throw new Error(
          `catch-ratchet report at ${result.filePath}:${message.line} lacked a semantic identity`,
        );
      }
      identities.push(match[1]);
    }
  }
  return identities.sort();
}

function atomicWriteBaseline(identities) {
  const tempPath = `${BASELINE_PATH}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(identities, null, 2)}\n`, {
      flag: 'wx',
    });
    renameSync(tempPath, BASELINE_PATH);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temporary file may not have been created; preserve the original error.
    }
    throw error;
  }
}

async function main() {
  let mode;
  try {
    mode = parseMode(process.argv.slice(2));
  } catch (error) {
    console.error(`catch-ratchet INCONCLUSIVE: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let baseline;
  let current;
  try {
    baseline = readCatchBaseline(BASELINE_PATH);
    current = await scanCurrentIdentities();
  } catch (error) {
    console.error(`catch-ratchet INCONCLUSIVE: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const { added, stale } = compareCatchBaselines(baseline, current);
  if (added.length > 0) {
    console.error(
      `catch-ratchet growth blocked: ${added.length} new catch swallow(s) are not in the baseline:`,
    );
    for (const identity of added) console.error(`  + ${identity}`);
    process.exitCode = 1;
    return;
  }

  if (stale.length === 0) {
    console.log(
      `catch-ratchet baseline matches ${current.length} inherited swallow(s); no growth or stale entries`,
    );
    return;
  }

  if (mode === 'check') {
    console.error(
      `catch-ratchet baseline shrank: ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} must be removed with --write`,
    );
    for (const identity of stale) console.error(`  - ${identity}`);
    process.exitCode = 1;
    return;
  }

  try {
    atomicWriteBaseline(current);
  } catch (error) {
    console.error(`catch-ratchet INCONCLUSIVE: baseline write failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.log(
    `catch-ratchet baseline shrank ${baseline.length} -> ${current.length} inherited swallow(s)`,
  );
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
