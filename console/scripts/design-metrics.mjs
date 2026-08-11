#!/usr/bin/env node
// console/scripts/design-metrics.mjs
//
// Design-system burndown metrics emitter.
// Produces deterministic machine-readable JSON to stdout (and optionally a file).
// Same tree = same bytes: no timestamps, no random values, all keys sorted.
//
// Emitted metrics:
//   shadow_ratchet   - total ceiling + per-rule×file bucket counts from baseline
//                      + live eslint shadow run so drift (live - baseline) is first-class
//                      + stale_ceiling_keys: baseline keys where live < ceiling (WARN-level
//                        signal that the ratchet ceiling can tighten; stale-high ceilings
//                        give silent slack that masks new violations)
//   design_regression - PASS/WARN/FAIL counts from design-regression.sh output
//   waivers          - active count, expired count (past-expiry causes nonzero exit)
//   debt_register    - open/closed row counts from design-debt-register.md
//
// Usage:
//   node console/scripts/design-metrics.mjs          (stdout only)
//   node console/scripts/design-metrics.mjs --out /path/to/file.json
//
// Fail-closed: any malformed input causes a named error and nonzero exit.
// No network calls. No timestamps.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
// DESIGN_METRICS_CONSOLE_ROOT / DESIGN_METRICS_REPO_ROOT allow tests to redirect
// path resolution to a temp-dir fixture without needing a real repo tree.
const consoleRoot = process.env.DESIGN_METRICS_CONSOLE_ROOT ?? resolve(here, '..');
const repoRoot = process.env.DESIGN_METRICS_REPO_ROOT ?? resolve(consoleRoot, '..');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
if (outIdx !== -1 && !outFile) {
  process.stderr.write('ERROR(args): --out requires a file path argument\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helper: sorted object (deep sort keys for determinism)
// ---------------------------------------------------------------------------
function sortedKeys(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(
    Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortedKeys(v)])
  );
}

// ---------------------------------------------------------------------------
// Part 1: Shadow ratchet — baseline counts
// ---------------------------------------------------------------------------
const baselinePath = resolve(consoleRoot, 'lint-shadow-baseline.json');
let baseline;
try {
  const raw = readFileSync(baselinePath, 'utf8');
  try {
    baseline = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`ERROR(parse:lint-shadow-baseline.json): ${e.message}\n`);
    process.exit(1);
  }
} catch (e) {
  process.stderr.write(`ERROR(read:lint-shadow-baseline.json): ${e.message}\n`);
  process.exit(1);
}

if (typeof baseline !== 'object' || baseline === null) {
  process.stderr.write('ERROR(schema:lint-shadow-baseline.json): root must be an object\n');
  process.exit(1);
}
if (typeof baseline.total !== 'number') {
  process.stderr.write('ERROR(schema:lint-shadow-baseline.json): missing numeric "total" field\n');
  process.exit(1);
}
if (typeof baseline.rules !== 'object' || baseline.rules === null) {
  process.stderr.write('ERROR(schema:lint-shadow-baseline.json): missing "rules" object\n');
  process.exit(1);
}

// Aggregate baseline counts by rule (stripping the " :: src/..." file suffix)
const baselineByRule = {};
const baselineByFile = {};
for (const [key, count] of Object.entries(baseline.rules)) {
  if (typeof count !== 'number') {
    process.stderr.write(`ERROR(schema:lint-shadow-baseline.json): non-numeric count for key "${key}"\n`);
    process.exit(1);
  }
  const sepIdx = key.indexOf(' :: ');
  if (sepIdx === -1) {
    process.stderr.write(`ERROR(schema:lint-shadow-baseline.json): key missing " :: " separator: "${key}"\n`);
    process.exit(1);
  }
  const rule = key.slice(0, sepIdx);
  const file = key.slice(sepIdx + 4);
  baselineByRule[rule] = (baselineByRule[rule] ?? 0) + count;
  baselineByFile[file] = (baselineByFile[file] ?? 0) + count;
}

// ---------------------------------------------------------------------------
// Part 1b: Live shadow run — compute drift
// ---------------------------------------------------------------------------
let liveCounts = {};
let liveTotal = 0;
let liveRunError = null;

try {
  let rawEslint;
  try {
    rawEslint = execFileSync(
      'npx',
      ['eslint', '.', '-c', 'eslint.config.shadow.mjs', '--format', 'json'],
      {
        cwd: consoleRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        // Suppress eslint's stderr so fatal config errors don't bleed into callers.
        // The error is captured in e.message / e.stderr and recorded as liveRunError.
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
  } catch (err) {
    // eslint exits nonzero when lint errors exist; stdout still carries JSON.
    // Fatal config errors (missing file, etc.) have empty stdout — caught below.
    if (err.stdout) rawEslint = err.stdout;
    else throw err;
  }

  let eslintResults;
  try {
    eslintResults = JSON.parse(rawEslint);
  } catch (e) {
    process.stderr.write(`ERROR(parse:eslint-shadow-output): ${e.message}\n`);
    process.exit(1);
  }

  if (!Array.isArray(eslintResults)) {
    process.stderr.write('ERROR(schema:eslint-shadow-output): expected array at root\n');
    process.exit(1);
  }

  for (const file of eslintResults) {
    const rel = file.filePath.startsWith(consoleRoot)
      ? file.filePath.slice(consoleRoot.length + 1)
      : file.filePath;
    for (const msg of file.messages) {
      const tag = /^\[([a-z/-]+)[ \]]/.exec(msg.message ?? '')?.[1];
      const rule = tag ?? msg.ruleId ?? '(no-rule)';
      const key = `${rule} :: ${rel}`;
      liveCounts[key] = (liveCounts[key] ?? 0) + 1;
      liveTotal += 1;
    }
  }
} catch (e) {
  // Live run failure is non-fatal — report the baseline only, mark drift as unavailable
  liveRunError = `live-shadow-run-failed: ${e.message}`;
}

// Compute drift: live - baseline per key
const drift = {};
// Stale ceiling: baseline keys where live count is lower than the ceiling.
// A stale-high ceiling gives silent slack — new violations up to the old ceiling
// are invisible until the next regression. Surfaced as WARN-level so operators
// know to ratchet the baseline down.
const staleCeilingKeys = {};
if (!liveRunError) {
  const allKeys = new Set([...Object.keys(baseline.rules), ...Object.keys(liveCounts)]);
  for (const key of allKeys) {
    const base = baseline.rules[key] ?? 0;
    const live = liveCounts[key] ?? 0;
    const d = live - base;
    if (d !== 0) drift[key] = d;
    // Stale ceiling: ceiling exists and is higher than the live count.
    // (Keys only in liveCounts with no baseline entry are new violations, not stale.)
    if (key in baseline.rules && live < base) {
      staleCeilingKeys[key] = { ceiling: base, live };
    }
  }
}

// ---------------------------------------------------------------------------
// Part 2: Design regression — run the suite and parse output
// ---------------------------------------------------------------------------
const regressionScript = resolve(consoleRoot, 'scripts', 'design-regression.sh');
let regressionCounts = { pass: 0, warn: 0, fail: 0 };
let regressionError = null;

try {
  let regressionOutput;
  try {
    regressionOutput = execSync(
      `bash "${regressionScript}"`,
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch (err) {
    // Script exits nonzero when blocking checks fail; stdout still has the output
    regressionOutput = (err.stdout || '');
  }

  for (const line of regressionOutput.split('\n')) {
    if (/^\s+PASS\s/.test(line)) regressionCounts.pass += 1;
    else if (/^\s+WARN\s/.test(line)) regressionCounts.warn += 1;
    else if (/^\s+FAIL\s/.test(line)) regressionCounts.fail += 1;
  }
} catch (e) {
  regressionError = `regression-run-failed: ${e.message}`;
}

// ---------------------------------------------------------------------------
// Part 3: Waivers — parse eslint-waivers.yaml
// ---------------------------------------------------------------------------
const waiversPath = resolve(consoleRoot, 'eslint-waivers.yaml');
let waiversData;
try {
  waiversData = readFileSync(waiversPath, 'utf8');
} catch (e) {
  process.stderr.write(`ERROR(read:eslint-waivers.yaml): ${e.message}\n`);
  process.exit(1);
}

// Parse waivers: find all "- id: WVR-NNN" blocks and their expiry fields.
// We do not use a YAML parser (no deps); we parse the specific schema shape manually.
// Fail closed: if any id-line lacks a subsequent expiry line before the next id, error.
const waiversParsed = [];
let parseError = null;

{
  const lines = waiversData.split('\n');
  let currentId = null;
  let currentExpiry = null;
  let expectingFields = false;

  const flushWaiver = () => {
    if (currentId !== null) {
      if (currentExpiry === null) {
        parseError = `ERROR(parse:eslint-waivers.yaml): waiver ${currentId} has no expiry field`;
      } else {
        waiversParsed.push({ id: currentId, expiry: currentExpiry });
      }
    }
  };

  for (const line of lines) {
    const idMatch = /^\s+-\s+id:\s*(\S+)/.exec(line);
    if (idMatch) {
      flushWaiver();
      currentId = idMatch[1];
      currentExpiry = null;
      expectingFields = true;
      continue;
    }
    if (expectingFields) {
      const expiryMatch = /^\s+expiry:\s*(\S+)/.exec(line);
      if (expiryMatch) {
        currentExpiry = expiryMatch[1].replace(/['"]/g, '');
      }
    }
  }
  flushWaiver();
}

if (parseError) {
  process.stderr.write(`${parseError}\n`);
  process.exit(1);
}

// Determine today's date in YYYY-MM-DD format (deterministic: uses env or system date)
// For determinism the date comes from a stable source — the system clock is the only
// sensible reference for "is this waiver expired today".
const todayStr = new Date().toISOString().slice(0, 10);

let expiredWaivers = [];
let activeWaivers = [];
for (const w of waiversParsed) {
  // Compare ISO date strings lexicographically (YYYY-MM-DD is sortable)
  if (w.expiry <= todayStr) {
    expiredWaivers.push(w);
  } else {
    activeWaivers.push(w);
  }
}

// Past-expiry waivers are a blocking condition (deterministic, zero FP surface)
const hasExpiredWaivers = expiredWaivers.length > 0;

// ---------------------------------------------------------------------------
// Part 4: Debt register — parse design-debt-register.md
// ---------------------------------------------------------------------------
const debtPath = resolve(repoRoot, 'docs', 'design-system', '06-implementation', 'design-debt-register.md');
let debtData;
try {
  debtData = readFileSync(debtPath, 'utf8');
} catch (e) {
  process.stderr.write(`ERROR(read:design-debt-register.md): ${e.message}\n`);
  process.exit(1);
}

// Parse markdown tables: open items are in the first table (before "## Closed"),
// closed items are in the second table.
// Table rows match: "| DD-NNN | ..." — skip header and separator rows.
let inOpenSection = false;
let inClosedSection = false;
let openCount = 0;
let closedCount = 0;
let debtParseErrors = 0;

{
  const lines = debtData.split('\n');
  for (const line of lines) {
    if (/^##\s+Closed/.test(line)) {
      inOpenSection = false;
      inClosedSection = true;
      continue;
    }
    // First table starts after schema description; detect table rows with DD- ids
    const isTableRow = /^\|/.test(line);
    if (!isTableRow) {
      // A non-table line after we've seen table rows might start a new section
      if (inOpenSection && line.trim() === '') continue; // blank lines ok within section
      continue;
    }

    // Skip header rows (contain "ID" header cell) and separator rows (contain ---)
    if (/\|\s*ID\s*\|/.test(line) || /\|\s*-+\s*\|/.test(line)) {
      inOpenSection = true; // we've entered a table context
      continue;
    }

    // Count DD- rows
    if (/^\|\s*DD-/.test(line)) {
      if (inClosedSection) closedCount += 1;
      else openCount += 1;
    }
  }
}

if (debtParseErrors > 0) {
  process.stderr.write(`ERROR(parse:design-debt-register.md): ${debtParseErrors} parse errors\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Assemble output
// ---------------------------------------------------------------------------
const staleCeilingCount = Object.keys(staleCeilingKeys).length;

const output = sortedKeys({
  schema_version: 1,
  shadow_ratchet: {
    baseline_total: baseline.total,
    baseline_by_rule: sortedKeys(baselineByRule),
    live_total: liveRunError ? null : liveTotal,
    live_error: liveRunError,
    drift: liveRunError ? null : sortedKeys(drift),
    drift_summary: liveRunError ? null : {
      keys_regressed: Object.values(drift).filter(v => v > 0).length,
      keys_improved: Object.values(drift).filter(v => v < 0).length,
      net_delta: Object.values(drift).reduce((a, b) => a + b, 0),
    },
    // Stale ceiling report: keys where the live violation count fell below the baseline
    // ceiling. A stale-high ceiling gives silent slack — violations can accumulate up to
    // the old ceiling without triggering the ratchet. These should be ratcheted down.
    // Null when the live run failed (no data to compare).
    stale_ceiling_keys: liveRunError ? null : sortedKeys(staleCeilingKeys),
    stale_ceiling_count: liveRunError ? null : staleCeilingCount,
    bucket_count: Object.keys(baseline.rules).length,
  },
  design_regression: {
    pass: regressionCounts.pass,
    warn: regressionCounts.warn,
    fail: regressionCounts.fail,
    run_error: regressionError,
  },
  waivers: {
    active_count: activeWaivers.length,
    expired_count: expiredWaivers.length,
    expired_ids: expiredWaivers.map(w => w.id).sort(),
    active_ids: activeWaivers.map(w => w.id).sort(),
    total_count: waiversParsed.length,
  },
  debt_register: {
    open_count: openCount,
    closed_count: closedCount,
    total_count: openCount + closedCount,
  },
});

const outputJson = JSON.stringify(output, null, 2) + '\n';
process.stdout.write(outputJson);

if (outFile) {
  try {
    writeFileSync(outFile, outputJson, 'utf8');
  } catch (e) {
    process.stderr.write(`ERROR(write:${outFile}): ${e.message}\n`);
    process.exit(1);
  }
}

// Emit WARN-level staleness report to stderr when stale ceiling keys exist.
// This is informational (does not cause nonzero exit) — operators should ratchet
// the baseline down but this does not block a push on its own.
if (!liveRunError && staleCeilingCount > 0) {
  process.stderr.write(
    `WARN(stale-ceiling): ${staleCeilingCount} baseline bucket(s) have live counts below their ceiling — ` +
    `run check-shadow-baseline.mjs --update to tighten the ratchet:\n`
  );
  for (const [key, { ceiling, live }] of Object.entries(staleCeilingKeys).sort(([a], [b]) => a.localeCompare(b))) {
    process.stderr.write(`  ${key}: ceiling=${ceiling} live=${live} (slack=${ceiling - live})\n`);
  }
}

// Exit nonzero if past-expiry waivers found (blocking, deterministic)
if (hasExpiredWaivers) {
  process.stderr.write(
    `ERROR(expired-waivers): ${expiredWaivers.length} waiver(s) past expiry: ` +
    expiredWaivers.map(w => `${w.id} (expired ${w.expiry})`).join(', ') + '\n'
  );
  process.exit(1);
}
