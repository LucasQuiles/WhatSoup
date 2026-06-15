#!/usr/bin/env node
// Deterministic SOUP visual-proof capture harness.
//
// Captures route x theme x viewport screenshots against the Vite console app
// and writes a machine-readable manifest next to the screenshots. The script
// owns proof capture only; it does not compare baselines or mutate source.

import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_ROUTES = [
  ['fleet', '/'],
  ['inbox', '/inbox'],
  ['ops', '/ops'],
  ['line-detail', '/lines/support'],
];

const DEFAULT_VIEWPORTS = [
  ['mobile', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1440, 900],
  ['short', 1440, 500],
];

const DEFAULT_THEMES = ['dark', 'light'];
const DEFAULT_FIXED_TIME = '2026-06-13T12:00:00.000Z';

function usage() {
  return `Usage: node console/scripts/capture-visual-matrix.mjs [options]

Options:
  --url <url>                 Capture an already-running console URL.
  --port <port>               Port for launched Vite server. Default: 5177.
  --out <dir>                 Output directory. Default: artifacts/soup-v3-follow-up/visual-matrix/<run-id>
  --run-id <id>               Manifest run id. Default: visual-matrix-<UTC compact timestamp>
  --route <name:path>         Route to capture. Repeatable. Default: fleet,inbox,ops,line-detail.
  --viewport <name:WxH>       Viewport to capture. Repeatable. Default: mobile,tablet,desktop,short.
  --theme <dark|light|a,b>    Theme list. Repeatable/comma-separated. Default: dark,light.
  --fixed-time <iso>          Date.now()/new Date() value injected before app load.
  --timeout-ms <ms>           Per-navigation timeout. Default: 30000.
  --dry-run                   Print resolved matrix JSON without launching a browser.
  --help                      Print this message.
`;
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parseArgs(argv) {
  const routes = [];
  const viewports = [];
  const themes = [];
  const opts = {
    url: null,
    port: 5177,
    out: null,
    runId: `visual-matrix-${compactTimestamp()}`,
    fixedTime: DEFAULT_FIXED_TIME,
    timeoutMs: 30_000,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--url') {
      opts.url = requireValue(argv, ++i, arg);
    } else if (arg === '--port') {
      opts.port = Number(requireValue(argv, ++i, arg));
      if (!Number.isInteger(opts.port) || opts.port <= 0) {
        throw new Error('--port must be a positive integer');
      }
    } else if (arg === '--out') {
      opts.out = requireValue(argv, ++i, arg);
    } else if (arg === '--run-id') {
      opts.runId = requireValue(argv, ++i, arg);
    } else if (arg === '--fixed-time') {
      opts.fixedTime = requireValue(argv, ++i, arg);
      if (Number.isNaN(Date.parse(opts.fixedTime))) {
        throw new Error('--fixed-time must be a parseable ISO timestamp');
      }
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = Number(requireValue(argv, ++i, arg));
      if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive integer');
      }
    } else if (arg === '--route') {
      routes.push(parseRoute(requireValue(argv, ++i, arg)));
    } else if (arg === '--viewport') {
      viewports.push(parseViewport(requireValue(argv, ++i, arg)));
    } else if (arg === '--theme') {
      for (const theme of requireValue(argv, ++i, arg).split(',')) {
        const clean = theme.trim();
        if (clean) themes.push(parseTheme(clean));
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  opts.routes = routes.length ? routes : DEFAULT_ROUTES;
  opts.viewports = viewports.length ? viewports : DEFAULT_VIEWPORTS;
  opts.themes = themes.length ? [...new Set(themes)] : DEFAULT_THEMES;
  opts.out = resolve(repoRoot, opts.out ?? `artifacts/soup-v3-follow-up/visual-matrix/${opts.runId}`);
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseRoute(raw) {
  const sep = raw.indexOf(':');
  if (sep === -1) throw new Error(`route must be name:path, got ${raw}`);
  const name = sanitizeSlug(raw.slice(0, sep));
  const routePath = raw.slice(sep + 1);
  if (!name || !routePath.startsWith('/')) {
    throw new Error(`route must be name:/path, got ${raw}`);
  }
  return [name, routePath];
}

function parseViewport(raw) {
  const match = /^([^:]+):(\d+)x(\d+)$/.exec(raw);
  if (!match) throw new Error(`viewport must be name:WxH, got ${raw}`);
  return [sanitizeSlug(match[1]), Number(match[2]), Number(match[3])];
}

function parseTheme(raw) {
  if (raw !== 'dark' && raw !== 'light') {
    throw new Error(`theme must be dark or light, got ${raw}`);
  }
  return raw;
}

function sanitizeSlug(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  }
  throw new Error(`server did not become ready at ${url}: ${lastError?.message ?? 'timeout'}`);
}

function launchVite(port) {
  const child = spawn(
    'npm',
    ['--prefix', consoleRoot, 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        BROWSER: 'none',
        VITE_MOCK_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));
  return child;
}

function installDeterminismInit(context, { fixedTime, theme }) {
  return context.addInitScript(({ fixedTimeValue, themeValue }) => {
    const fixedMs = Date.parse(fixedTimeValue);
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedMs]));
      }
      static now() { return fixedMs; }
      static parse(value) { return RealDate.parse(value); }
      static UTC(...args) { return RealDate.UTC(...args); }
    }
    Object.defineProperty(FixedDate, 'name', { value: 'Date' });
    globalThis.Date = FixedDate;

    let seed = 0x5eed1234;
    Math.random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    const applyTheme = () => {
      localStorage.setItem('whatsoup:theme', themeValue);
      document.documentElement?.setAttribute('data-theme', themeValue);
    };
    if (document.documentElement) applyTheme();
    else document.addEventListener('DOMContentLoaded', applyTheme, { once: true });

    const installStyle = () => {
      if (document.getElementById('soup-visual-capture-freeze')) return;
      if (!document.head) return;
      const style = document.createElement('style');
      style.id = 'soup-visual-capture-freeze';
      style.textContent = `
        *, *::before, *::after {
          animation-duration: 0.001ms !important;
          animation-delay: 0s !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.001ms !important;
          transition-delay: 0s !important;
          caret-color: transparent !important;
        }
        html { scroll-behavior: auto !important; }
      `;
      document.head.appendChild(style);
    };
    if (document.head) installStyle();
    else document.addEventListener('DOMContentLoaded', installStyle, { once: true });
  }, { fixedTimeValue: fixedTime, themeValue: theme });
}

async function captureMatrix(opts) {
  mkdirSync(opts.out, { recursive: true });
  const launched = opts.url ? null : launchVite(opts.port);
  const baseUrl = opts.url ?? `http://127.0.0.1:${opts.port}/`;

  try {
    await waitForServer(baseUrl, opts.timeoutMs);
    const browser = await chromium.launch();
    const artifacts = [];

    for (const [viewportName, width, height] of opts.viewports) {
      for (const theme of opts.themes) {
        const context = await browser.newContext({
          viewport: { width, height },
          reducedMotion: 'reduce',
          colorScheme: theme,
          deviceScaleFactor: 1,
        });
        await installDeterminismInit(context, { fixedTime: opts.fixedTime, theme });

        for (const [routeName, routePath] of opts.routes) {
          const page = await context.newPage();
          const signals = {
            console: [],
            pageErrors: [],
            requestFailures: [],
            httpErrors: [],
          };
          page.on('console', (msg) => {
            const type = msg.type();
            if (type === 'warning' || type === 'error') {
              signals.console.push({
                type,
                text: msg.text(),
              });
            }
          });
          page.on('pageerror', (err) => {
            signals.pageErrors.push(err.message);
          });
          page.on('requestfailed', (request) => {
            signals.requestFailures.push({
              url: request.url(),
              failure: request.failure()?.errorText ?? 'unknown',
            });
          });
          page.on('response', (response) => {
            if (response.status() >= 400) {
              signals.httpErrors.push({
                url: response.url(),
                status: response.status(),
              });
            }
          });
          const target = new URL(routePath, baseUrl).toString();
          await page.goto(target, { waitUntil: 'networkidle', timeout: opts.timeoutMs });
          await page.waitForFunction(() => document.querySelector('#root')?.textContent?.trim().length, null, {
            timeout: opts.timeoutMs,
          });
          await page.evaluate(async () => {
            await document.fonts?.ready;
            document.documentElement.setAttribute(
              'data-soup-capture-ready',
              document.documentElement.getAttribute('data-theme') ?? '',
            );
          });
          await page.waitForTimeout(150);

          const fileName = `${routeName}__${theme}__${viewportName}.png`;
          const path = resolve(opts.out, fileName);
          await page.screenshot({ path, fullPage: true });
          const stats = statSync(path);
          const dom = await page.evaluate(() => {
            const root = document.querySelector('#root');
            const rootRect = root?.getBoundingClientRect();
            return {
              title: document.title,
              bodyTextLength: document.body.innerText.trim().length,
              theme: document.documentElement.getAttribute('data-theme'),
              horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
              verticalScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
              rootRect: rootRect ? {
                width: Math.round(rootRect.width),
                height: Math.round(rootRect.height),
              } : null,
            };
          });
          artifacts.push({
            route: routeName,
            path: routePath,
            url: target,
            theme,
            viewport: { name: viewportName, width, height },
            screenshot: path,
            bytes: stats.size,
            dom,
            signals,
            verdict: stats.size > 1000 && dom.bodyTextLength > 0 && signals.pageErrors.length === 0
              ? 'PASS'
              : 'FAIL',
          });
          await page.close();
        }
        await context.close();
      }
    }

    await browser.close();
    const manifest = {
      run_id: opts.runId,
      generated_at_utc: new Date().toISOString(),
      fixed_time_utc: new Date(opts.fixedTime).toISOString(),
      base_url: baseUrl,
      reduced_motion: 'reduce',
      routes: opts.routes.map(([name, path]) => ({ name, path })),
      themes: opts.themes,
      viewports: opts.viewports.map(([name, width, height]) => ({ name, width, height })),
      artifacts,
      verdict: artifacts.every((artifact) => artifact.verdict === 'PASS') ? 'PASS' : 'FAIL',
    };
    const manifestPath = resolve(opts.out, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { manifestPath, manifest };
  } finally {
    if (launched) {
      launched.kill('SIGTERM');
    }
  }
}

async function main() {
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

  const resolved = {
    run_id: opts.runId,
    out: opts.out,
    url: opts.url,
    port: opts.port,
    fixed_time: opts.fixedTime,
    routes: opts.routes.map(([name, path]) => ({ name, path })),
    themes: opts.themes,
    viewports: opts.viewports.map(([name, width, height]) => ({ name, width, height })),
  };

  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return;
  }

  try {
    const { manifestPath, manifest } = await captureMatrix(opts);
    process.stdout.write(`visual matrix ${manifest.verdict}: ${manifest.artifacts.length} screenshots\n`);
    process.stdout.write(`manifest: ${manifestPath}\n`);
    for (const artifact of manifest.artifacts) {
      process.stdout.write(
        `${artifact.verdict} ${artifact.route}/${artifact.theme}/${artifact.viewport.name} ${artifact.bytes} ${artifact.screenshot}\n`,
      );
    }
    if (manifest.verdict !== 'PASS') process.exit(1);
  } catch (err) {
    process.stderr.write(`ERROR(capture): ${err.stack ?? err.message}\n`);
    process.exit(1);
  }
}

await main();
