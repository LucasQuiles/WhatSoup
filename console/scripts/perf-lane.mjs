#!/usr/bin/env node
/**
 * perf-lane — CI perf lane (T5 b-12; 19-performance-budget §2).
 *
 * Measures against the PROVISIONAL §1 budgets (owner sign-off pending — the
 * lane runs REPORT-ONLY by default; PERF_LANE_ENFORCE=1 flips it blocking):
 *
 *   1. Cold paint: first-contentful-paint of the console shell (prod build).
 *   2. Warm paint: second navigation (cached shell).
 *   3. Bundle budget: entry JS chunk ≤ 250KB gzip (app code only).
 *
 * The 200-line mount and event-storm frame-cost legs need a fixture-fed
 * headless harness and are explicitly deferred (recorded in the report).
 *
 * Usage: node console/scripts/perf-lane.mjs [--url <url>] [--json]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

// Provisional budgets (19-§1, owner sign-off pending — report-only default).
const BUDGETS = {
  coldPaintMs: 1500,
  warmPaintMs: 600,
  bundleGzipKb: 250,
};

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const asJson = args.includes('--json');
const enforce = process.env.PERF_LANE_ENFORCE === '1';

function measureBundle() {
  // vite outDir is repo-root dist (see vite.config.ts), not console/dist.
  const distAssets = resolve(repoRoot, 'dist/assets');
  const files = readdirSync(distAssets).filter((f) => f.endsWith('.js'));
  const entries = files
    .map((f) => {
      const p = resolve(distAssets, f);
      return { file: f, raw: statSync(p).size, gzip: gzipSync(readFileSync(p)).length };
    })
    .sort((a, b) => b.gzip - a.gzip);
  const entry = entries.find((e) => e.file.startsWith('index-')) ?? entries[0];
  return { entry, total: entries.reduce((s, e) => s + e.gzip, 0) };
}

async function measurePaints(url) {
  const require = createRequire(resolve(repoRoot, 'package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // getEntriesByType('paint') is unreliable in this harness (empty buffer);
    // PerformanceObserver with buffered:true is the stable source.
    await page.addInitScript(() => {
      window.__fcp = null;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name === 'first-contentful-paint') window.__fcp = e.startTime;
        }
      }).observe({ type: 'paint', buffered: true });
    });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    // fail-closed: poll for the observer's FCP — a missing reading is a
    // FAILED leg, never a silently skipped one (cross-review F2).
    const cold = await page
      .waitForFunction(() => window.__fcp != null, undefined, { timeout: 10000 })
      .then(() => page.evaluate(() => window.__fcp))
      .catch(() => null);
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    const warm = await page
      .waitForFunction(() => window.__fcp != null, undefined, { timeout: 10000 })
      .then(() => page.evaluate(() => window.__fcp))
      .catch(() => null);
    return { cold, warm };
  } finally {
    await browser.close();
  }
}

async function main() {
  const results = [];
  const bundle = measureBundle();
  const bundleKb = Math.round(bundle.entry.gzip / 1024);
  results.push({
    metric: 'bundle-entry-gzip',
    value: bundleKb,
    unit: 'KB',
    budget: BUDGETS.bundleGzipKb,
    pass: bundleKb <= BUDGETS.bundleGzipKb,
    detail: bundle.entry.file,
  });

  let url = urlArg;
  let serverProc = null;
  if (!url) {
    const port = 5199;
    // The local vite binary (console devDependency) — npx resolution in CI
    // cost the full readiness window once (the first perf-lane CI run).
    const viteBin = resolve(consoleRoot, 'node_modules/.bin/vite');
    serverProc = spawn(viteBin, ['preview', '--port', String(port), '--strictPort'], {
      cwd: consoleRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let serverLog = '';
    serverProc.stdout?.on('data', (d) => { serverLog += d.toString(); });
    serverProc.stderr?.on('data', (d) => { serverLog += d.toString(); });
    url = `http://127.0.0.1:${port}/`;
    // bounded readiness wait — fail closed WITH the server's own log
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) { up = true; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) {
      console.error('perf-lane: preview server did not become ready in 60s');
      console.error('--- server log ---\n' + serverLog);
      try { process.kill(-serverProc.pid, 'SIGTERM'); } catch { /* already gone */ }
      process.exit(2);
    }
  }

  try {
    const paints = await measurePaints(url);
    // null reading = FAILED leg (fail-closed) — never skipped.
    results.push(
      paints.cold != null
        ? { metric: 'cold-paint', value: Math.round(paints.cold), unit: 'ms', budget: BUDGETS.coldPaintMs, pass: paints.cold <= BUDGETS.coldPaintMs }
        : { metric: 'cold-paint', value: 'unreadable', unit: '', budget: BUDGETS.coldPaintMs, pass: false, detail: 'FCP observer delivered nothing within 10s' },
      paints.warm != null
        ? { metric: 'warm-paint', value: Math.round(paints.warm), unit: 'ms', budget: BUDGETS.warmPaintMs, pass: paints.warm <= BUDGETS.warmPaintMs }
        : { metric: 'warm-paint', value: 'unreadable', unit: '', budget: BUDGETS.warmPaintMs, pass: false, detail: 'FCP observer delivered nothing within 10s' },
    );
  } finally {
    if (serverProc) {
      try { process.kill(-serverProc.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  const report = {
    mode: enforce ? 'enforce' : 'report-only',
    budgetsProvisional: true,
    deferredLegs: ['200-line mount cost', 'event-storm frame cost (fixture-fed harness)'],
    results,
    overallPass: results.every((r) => r.pass),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.pass ? 'PASS' : 'MISS'} ${r.metric}: ${r.value}${r.unit} (budget ${r.budget}${r.unit})`);
    }
    console.log(`perf-lane ${report.overallPass ? 'OK' : 'OVER BUDGET'} (${report.mode}; budgets provisional per 19-§1)`);
  }

  if (enforce && !report.overallPass) process.exit(1);
}

main().catch((e) => {
  console.error('perf-lane failed:', e);
  process.exit(2);
});
